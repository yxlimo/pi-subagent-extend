/**
 * Agent profile loader — per-role default bindings that do not depend on the parent
 * remembering to pass `extensionBindings` on every dispatch.
 *
 * Why a separate entry file instead of a project-wide auto-detect: a foreground
 * subagent runs in the parent's process and has no marker in its environment when no
 * bindings were passed (`encodeExtensionBindings(undefined) === undefined`, and
 * PI_SUBAGENT_CHILD / PI_SUBAGENT_PARENT_SESSION are runner-only). So at runtime a
 * child that omitted bindings is indistinguishable from the main session. Audience is
 * only reliable through the load path — hence a file that the agent declares in
 * `subagentOnlyExtensions` and the main session never loads.
 *
 * Usage:
 *
 *   1. Describe the roles in `.pi/subagent-bindings.json` (relative to the project root):
 *
 *      {
 *        "default":       { "bash": { "read": ["mise run typecheck"], "write": ["mise run fix"] } },
 *        "be-core":       { "bash": { "read": ["mise run test"], "write": ["mise run fix"] } },
 *        "be-review":     { "readOnly": true, "bash": { "read": ["git diff", "rg"], "deny": ["git stash"] } }
 *      }
 *
 *   2. Create a two-line loader per role:
 *
 *      // .pi/agent-profiles/be-core.ts
 *      // The path must be absolute: Node does not expand `~` in an import specifier.
 *      import { profile } from "/path/to/pi-subagent-extend/packages/pi-plugin/src/profile.ts";
 *      export default profile("be-core");
 *
 *   3. Declare that loader in the agent definition:
 *
 *      subagentOnlyExtensions: /path/to/pi-subagent-extend/packages/pi-plugin/src/index.ts, <project>/.pi/agent-profiles/be-core.ts
 *
 * Merge rules: the call's `extensionBindings` keys override the profile's keys
 * (`bash` is replaced as a whole object), except `bash.deny` which is unioned — a deny
 * entry can never be re-allowed by the caller. A profile that supplies no `scope`
 * leaves all file access denied (loud failure) while its bash allowlist still works.
 *
 * A declared profile whose file, JSON, or role key is missing fails closed: every
 * tool call is denied with a message naming the profile, rather than silently running
 * unrestricted.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activate } from "./index.ts";

export interface ProfileOptions {
	/**
	 * Profile file, relative to the session cwd. Default `.pi/subagent-bindings.json`.
	 * Absolute paths are used as-is.
	 */
	file?: string;
}

/**
 * Build the extension factory for one agent role.
 *
 * @param name Role key in the profile file. `default` is applied underneath it.
 */
export function profile(name: string, options: ProfileOptions = {}): (pi: ExtensionAPI) => void {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new Error("pi-subagent-extend/profile: profile name must not be empty");
	}
	return (pi: ExtensionAPI) => activate(pi, { profileName: trimmed, profileFile: options.file });
}

export default profile;
