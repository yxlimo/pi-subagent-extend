/**
 * bash 白名单的匹配与读写归类。
 *
 * 条目两种写法：
 * - 字面量：按空白切词的前缀匹配。`"pnpm test"` 放行 `pnpm test -t foo`，不放行 `pnpm publish`。
 * - `re:` 前缀：正则，整串锚定（不写 ^$ 也整串）。用来表达一个命令族的多种参数。
 *
 * 不自动探测正则：命令参数本身就常含 `*`、`.`、`(`（glob 输入、shell 分支），
 * 猜错方向是误授权，比误拒绝危险得多。
 *
 * 读写归类供探针使用：命令只在 read 列 = 读；任一 write 列命中 = 写（两侧都命中以
 * write 为准，保守方向）。
 */

export type BashAccess = "read" | "write";

export interface BashRule {
	read: string[];
	write: string[];
	/** 允许网络（默认关闭，沙箱内使用私有网络命名空间）。 */
	network: boolean;
	/** scope 命中的目录在沙箱里可写（默认只读根）。 */
	writable: boolean;
	/**
	 * 额外给予写权限的路径（绝对路径、`~` 开头或相对 cwd）。
	 * pnpm store、mise 的 state 目录这类全局可写区，不在 scope 里，但工具链要写。
	 */
	writablePaths: string[];
	/** 注入到沙箱里的环境变量（写进 spec 的 env 字段）。 */
	env: Record<string, string>;
	/**
	 * 项目内构建/测试产物目录。默认按工具链 marker 判断后放行（并创建），
	 * `false` 关闭整份内置清单，数组在内置清单之上追加。
	 */
	scratchPaths: string[] | false;
	/**
	 * 结构性禁掉的命令，**不可被 bindings 放宽**。来自项目 profile 的 bash.deny，
	 * 与调用方写的 read/write 取并集：即便调用方把同一条命令列进白名单也进不来。
	 */
	deny: string[];
	/**
	 * 启动前的依赖完整性闸门（默认开）：有 lockfile 却没有 node_modules/.bin 的目录，
	 * 让 bash 直接失败并点名，而不是让第一条构建命令在沙箱里去装依赖、然后挂住。
	 *
	 * 数组是「这些目录不必装」的前缀清单：树里常年躺着没人安装的 lockfile
	 * （fixtures/、vendored 的样例工程）时，只关掉整道闸门等于把真包也一起交出去。
	 * `false` 才是整道闸门的开关。
	 */
	dependencyGate: string[] | false;
	/**
	 * 命令树停止消耗 CPU 超过这么多秒就杀掉（默认关）。
	 *
	 * 墙钟超时分不开「死锁」和「长编译」，累计 CPU 分得开：干活的树每次采样都在涨，卡住的
	 * 树一动不动。判据由 helper 实现 —— 它是子进程 PID 命名空间的 PID 1，看得见整棵子树。
	 */
	cpuStallSeconds: number | false;
	/**
	 * 是否给沙箱里的 git 注入全局排除规则（node_modules/、.pnpm-store/）。
	 * 默认开：防止子代理 `git add -A` 把依赖目录吸进索引。
	 */
	gitExcludes: boolean;
}

export interface BashMatch {
	access: BashAccess;
	/** 命中的条目原文，用于拒绝文案与诊断。 */
	entry: string;
}

const RE_PREFIX = "re:";

function tokens(text: string): string[] {
	return text.trim().split(/\s+/);
}

/** 前置赋值的名字，以及剥掉前缀之后剩下的命令。 */
export interface LeadingAssignments {
	names: string[];
	rest: string;
}

const ASSIGNMENT_HEAD = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * 前缀赋值里那些能改变「跑哪个程序」或者「往进程里塞代码」的名字。
 *
 * 这一层不是严格沙箱，是让子代理走在既定轨道上的辅助（定位如此：放行多了可以事后补，卡太死
 * 反而妨碍干活），所以这里是**黑名单**而不是白名单：挡住已知的注入入口，其余名字照常放行。
 * 漏一个就是一次放宽 —— 这是刻意接受的代价，每一条都对应一个可验证的注入方式：
 *
 *   LD_* / DYLD_*              往任意进程加载共享库
 *   NODE_* / npm_config_*      node 预加载模块；实测 `NODE_OPTIONS=--require=/tmp/x.js node -e ""`
 *                              直接执行了 /tmp/x.js
 *   PYTHON* / PERL* / RUBY*    解释器预加载
 *   GIT_* / PAGER / LESSOPEN   被允许的 git 子命令、分页器里跑任意程序
 *   BASH_ENV / ENV / BASH_FUNC_*  shell 启动时执行
 *   PATH / IFS                 换掉要跑的程序 / 改变词法
 *
 * 刻意**不含** HOME：它是最常见的痛点写法（`HOME=/tmp/pi-home node x.mjs`），而借它注入要
 * 额外满足若干条件（例如宿主的 pager 只在 tty 下才起）。这条边界是取舍，不是疏漏。
 */
const DENIED_ENV_NAMES = new Set(["PATH", "IFS", "ENV", "PAGER", "LESSOPEN", "LESSCLOSE", "MANPAGER", "BASH_ENV", "SHELLOPTS"]);
const DENIED_ENV_PREFIXES = [
	"LD_",
	"DYLD_",
	"NODE_",
	"npm_config_",
	"NPM_CONFIG_",
	"PYTHON",
	"PERL",
	"RUBY",
	"GIT_",
	"BASH_FUNC_",
	"JAVA_TOOL_",
	"_JAVA_",
	"MALLOC_",
];

function isDeniedEnvName(name: string): boolean {
	if (DENIED_ENV_NAMES.has(name)) return true;
	return DENIED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * 扫出最前面连续的 `NAME=value` 赋值，返回名字与剩下的命令。
 *
 * 逐字符扫而不是按空白切词：值可以被引号包住（`HOME="/tmp/my home"`），按空白切会把它切成两半，
 * 剩下半截 `home"` 当程序名，于是另一条合法命令被误拒 —— 那正是这个补丁要修的那类失败。
 * 名字允许在 `=` 前带一个 `+`（`A+=1` 是追加赋值，bash 同样当赋值看）。
 * 引号没闭合时值一直吃到末尾，剩下的命令为空，空命令永不匹配（fail closed）。
 */
export function leadingAssignments(command: string): LeadingAssignments {
	const text = command.trim();
	const names: string[] = [];
	let i = 0;
	for (;;) {
		while (i < text.length && /\s/.test(text[i] as string)) i += 1;
		const head = ASSIGNMENT_HEAD.exec(text.slice(i));
		if (!head) break;
		names.push(head[0].replace(/\+?=$/, ""));
		let j = i + head[0].length;
		let quote: string | undefined;
		while (j < text.length) {
			const ch = text[j] as string;
			if (quote) {
				if (ch === "\\" && quote === '"') {
					j += 2;
					continue;
				}
				if (ch === quote) quote = undefined;
				j += 1;
				continue;
			}
			if (ch === "'" || ch === '"') {
				quote = ch;
				j += 1;
				continue;
			}
			if (/\s/.test(ch)) break;
			j += 1;
		}
		i = j;
	}
	return { names, rest: i === 0 ? text : text.slice(i).trim() };
}

/**
 * 前置赋值里命中黑名单的名字，供拒绝文案点名。命中即拒：带上它，「被允许的命令」就变成了
 * 「跑我自己的代码」，白名单等于没写。
 */
export function deniedEnvAssignment(command: string): string | undefined {
	return leadingAssignments(command).names.find((name) => isDeniedEnvName(name));
}

/**
 * 单条模式是否匹配整条命令。`re:` 条目按正则整串匹配；否则按 token 前缀匹配。
 * 空命令永不匹配。
 */
export function commandMatches(pattern: string, command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	const entry = pattern.trim();
	if (entry.startsWith(RE_PREFIX)) {
		const source = entry.slice(RE_PREFIX.length).trim();
		if (!source) return false;
		try {
			return new RegExp(`^(?:${source})$`).test(cmd);
		} catch {
			// 写坏的正则不匹配任何命令（fail closed），而不是让整条规则消失。
			return false;
		}
	}
	const want = tokens(entry);
	if (want.length === 0) return false;
	// 赋值前缀先剥掉再比：条目的第一个 token 指的是程序名，不是它前面的环境变量。
	const have = tokens(leadingAssignments(cmd).rest);
	return want.every((token, i) => have[i] === token);
}

/** 归类一条命令：write 列优先。不在任何列时返回 undefined。 */
export function classifyCommand(rule: BashRule, command: string): BashMatch | undefined {
	const write = rule.write.find((entry) => commandMatches(entry, command));
	if (write !== undefined) return { access: "write", entry: write };
	const read = rule.read.find((entry) => commandMatches(entry, command));
	if (read !== undefined) return { access: "read", entry: read };
	return undefined;
}

/** 全部条目（供拒绝文案与诊断）。 */
export function allEntries(rule: BashRule): string[] {
	return [...rule.read, ...rule.write];
}

/** 命中禁止列表时返回该条目原文，否则 undefined。 */
export function deniedEntry(rule: BashRule, command: string): string | undefined {
	return rule.deny.find((entry) => commandMatches(entry, command));
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return (value as unknown[])
		.filter((v): v is string => typeof v === "string" && v.trim() !== "")
		.map((v) => v.trim());
}

function stringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!key.trim()) continue;
		if (typeof raw !== "string" && typeof raw !== "number") continue;
		out[key.trim()] = String(raw);
	}
	return out;
}

/**
 * 解析 bindings 里的 bash 字段。没写、写坏、两列都空都返回 undefined（= 拒绝 bash）。
 * `allow` 是旧字段（单列表，全部按可写对待），保留兼容。
 */
export function parseBashRule(raw: unknown): BashRule | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const cfg = raw as Record<string, unknown>;
	const read = stringList(cfg.read);
	const write = stringList(cfg.write).concat(stringList(cfg.allow));
	if (read.length === 0 && write.length === 0) return undefined;
	return {
		read,
		write,
		network: cfg.network === true,
		writable: cfg.writable === true,
		writablePaths: stringList(cfg.writablePaths),
		env: stringMap(cfg.env),
		scratchPaths: cfg.scratchPaths === false ? false : stringList(cfg.scratchPaths),
		gitExcludes: cfg.gitExcludes !== false,
		deny: stringList(cfg.deny),
		dependencyGate: cfg.dependencyGate === false ? false : stringList(cfg.dependencyGate),
		// 未写 = 关。这条看门狗杀掉整棵进程树，默认打开会误杀刻意等待的命令（sleep、退避轮询），
		// 而 helper 看不到输出（stdio 是继承的，不走管道），没法用「无输出」佐证。
		cpuStallSeconds: stallSeconds(cfg.cpuStallSeconds),
	};
}

/** `cpuStallSeconds`：未写、写坏、`false`、小于等于 0 一律当关闭。 */
function stallSeconds(value: unknown): number | false {
	// 先 floor 再判断：否则 0.5 会得到 0，而 0 !== false 会把 `stallSeconds: 0` 写进 spec ——
	// 旧版 helper 的 deny_unknown_fields 会因此整份拒绝（退出码 77），正好是「关掉时不写键」
	// 想避免的那种失败。也不接受非数字：`true` 经 Number() 会变成 1，即「静默 1 秒就杀」。
	if (typeof value !== "number" || !Number.isFinite(value)) return false;
	const n = Math.floor(value);
	if (n <= 0) return false;
	return n;
}
