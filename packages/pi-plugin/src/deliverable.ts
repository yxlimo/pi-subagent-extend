/**
 * 子工作树里的交付物：真实文件落在主仓库，子工作树侧只放一个指过去的符号链接。
 * 主仓库锚点按四级依次尝试；都没有证据时退回会话 cwd，cwd 本身不可用才报 null。
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type MainRepoAnchor =
	| { root: string; via: "common-dir" | "gitfile" | "worktree-list" | "cwd" }
	| { root: null; tried: string[] };

/** 四级锚点，按这个顺序试；四级都失败时不猜。 */
export function mainRepoRoot(cwd: string): MainRepoAnchor {
	const start = resolve(cwd);
	const tried: string[] = [];
	if (!isDirectory(start)) return { root: null, tried: [`${start}: not a directory`] };

	const gitDir = gitDirFromFile(start, tried);
	if (gitDir) {
		// 链接工作树：<main>/.git/worktrees/<name>/commondir 指回 <main>/.git。
		const commonFile = join(gitDir, "commondir");
		if (existsSync(commonFile)) {
			try {
				const common = readFileSync(commonFile, "utf8").trim();
				if (!common) tried.push(`${commonFile}: empty commondir`);
				else {
					const root = dirname(resolve(gitDir, common));
					if (isDirectory(root)) return { root, via: "common-dir" };
					tried.push(`${root}: commondir target is not a directory`);
				}
			} catch (error) {
				tried.push(`${commonFile}: ${errorText(error)}`);
			}
		} else {
			tried.push(`${commonFile}: missing`);
		}

		// 普通 gitfile（submodule / --separate-git-dir）：gitdir 本身就是仓库的 .git。
		if (existsSync(join(gitDir, "HEAD"))) return { root: dirname(gitDir), via: "gitfile" };
		tried.push(`${gitDir}: no HEAD, not a standalone gitdir`);
	}

	// 在链接工作树的子目录里，cwd 没有 .git，但 git 自己知道主工作树在哪。
	try {
		const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
			cwd: start,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		const entries = output.split(/\r?\n/).filter((entry) => entry.startsWith("worktree "));
		if (entries.length === 0) {
			tried.push("git worktree list --porcelain: no worktree entry");
		} else {
			for (const entry of entries) {
				const candidate = entry.slice("worktree ".length).trim();
				if (!candidate) continue;
				const root = resolve(candidate);
				// 只有主检出才有 .git 目录；链接工作树的 .git 是文件，不能当锚点。
				if (!isDirectory(join(root, ".git"))) {
					tried.push(`${root}: git worktree list entry is not the main checkout (no .git directory)`);
					continue;
				}
				if (isDirectory(root)) return { root, via: "worktree-list" };
				tried.push(`${root}: git worktree list target is not a directory`);
			}
		}
	} catch (error) {
		tried.push(`git worktree list --porcelain: ${errorText(error)}`);
	}

	// 没有 git 证据就是没有工作树：主仓库与当前目录同一处。
	return { root: start, via: "cwd" };
}

const isDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 读 cwd 的 .git 文件里的 gitdir；.git 是目录或读不出来时返回 undefined。 */
const gitDirFromFile = (cwd: string, tried: string[]): string | undefined => {
	const dotGit = join(cwd, ".git");
	if (isDirectory(dotGit)) {
		tried.push(`${dotGit}: a directory, not a gitfile`);
		return undefined;
	}
	let text: string;
	try {
		text = readFileSync(dotGit, "utf8");
	} catch (error) {
		tried.push(`${dotGit}: ${errorText(error)}`);
		return undefined;
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
	if (!match?.[1]) {
		tried.push(`${dotGit}: no gitdir entry`);
		return undefined;
	}
	return resolve(cwd, match[1]);
};

const isSafeDeliverable = (deliverable: string): boolean =>
	deliverable.length > 0 &&
	!isAbsolute(deliverable) &&
	!/^[a-zA-Z]:[\\/]/.test(deliverable) &&
	!deliverable.split(/[\\/]/).includes("..") &&
	!deliverable.includes("\0");

/** 配置里的交付物必须是工作树之内的相对路径。 */
const assertSafeDeliverable = (deliverable: string): void => {
	if (!isSafeDeliverable(deliverable)) {
		throw new Error(`invalid deliverable "${deliverable}": expected a relative path inside the worktree`);
	}
};

export type LinkResult =
	| { action: "none"; reason: "same-directory"; linkPath: string; targetPath: string }
	| { action: "created" | "reused"; linkPath: string; targetPath: string }
	| { action: "retargeted"; linkPath: string; targetPath: string; warning: string }
	| { action: "skipped"; linkPath: string; targetPath: string; reason: "real-file" | "link-failed"; warning: string };

/** Point <childCwd>/<deliverable> at <mainRoot>/<deliverable>, creating the parent dir on the main side. */
export function ensureDeliverableLink(childCwd: string, mainRoot: string, deliverable: string): LinkResult {
	assertSafeDeliverable(deliverable);
	const child = resolve(childCwd);
	const main = resolve(mainRoot);
	const targetPath = deliverableTarget(main, deliverable);
	const linkPath = resolve(child, deliverable);
	const skipped = (reason: "real-file" | "link-failed", warning: string, at = linkPath): LinkResult =>
		({ action: "skipped", linkPath: at, targetPath, reason, warning });

	if (child === main) return { action: "none", reason: "same-directory", linkPath, targetPath };

	try {
		mkdirSync(dirname(targetPath), { recursive: true });
	} catch (error) {
		return skipped("link-failed", `unable to create ${dirname(targetPath)}: ${errorText(error)}`);
	}

	let existing: ReturnType<typeof lstatSync> | undefined;
	try {
		existing = lstatSync(linkPath);
	} catch (error) {
		if (!existsSync(linkPath)) {
			// ENOENT 是正常的新建路径；其它错误落到下面的 link-failed。
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return skipped("link-failed", `unable to inspect ${linkPath}: ${errorText(error)}`);
			}
		} else {
			return skipped("link-failed", `unable to inspect ${linkPath}: ${errorText(error)}`);
		}
	}

	if (existing?.isSymbolicLink()) {
		let current: string;
		try {
			current = resolve(dirname(linkPath), readlinkSync(linkPath));
		} catch (error) {
			return skipped("link-failed", `unable to read link ${linkPath}: ${errorText(error)}`);
		}
		if (current === targetPath) return { action: "reused", linkPath, targetPath };

		const newPath = `${linkPath}.new`;
		if (existsSync(newPath) || isSymlink(newPath)) {
			return {
				action: "retargeted",
				linkPath: newPath,
				targetPath,
				warning: `${linkPath} points to ${current}; ${newPath} already exists and was left untouched`,
			};
		}
		try {
			symlinkSync(targetPath, newPath, "file");
		} catch (error) {
			return skipped("link-failed", `unable to link ${newPath}: ${errorText(error)}`, newPath);
		}
		return {
			action: "retargeted",
			linkPath: newPath,
			targetPath,
			warning: `${linkPath} points to ${current}; left it untouched and wrote ${newPath} instead`,
		};
	}

	if (existing) return skipped("real-file", `${linkPath} is a real file; left it untouched`);

	try {
		mkdirSync(dirname(linkPath), { recursive: true });
		symlinkSync(targetPath, linkPath, "file");
	} catch (error) {
		return skipped("link-failed", `unable to link ${linkPath}: ${errorText(error)}`);
	}
	return { action: "created", linkPath, targetPath };
}

const isSymlink = (path: string): boolean => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

/** Absolute path of the real file, for the parent's write grant and for printing. */
export function deliverableTarget(mainRoot: string, deliverable: string): string {
	assertSafeDeliverable(deliverable);
	return resolve(mainRoot, deliverable);
}
