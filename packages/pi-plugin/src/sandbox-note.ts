/**
 * 沙箱失败提示：让子代理分清「主代理没授权」和「这台机器坏了」。
 *
 * 背景：范围外的 tool_call 会被拒并附上一句理由，但**沙箱内的失败不一样** ——
 * 命令照常执行，只是在内核里装不出来网络。子代理拿到的只是 `ENETUNREACH`
 * 这类原始 errno，从它自己的视角看和「网络坏了」没有区别，于是换 registry、
 * 换 flag、加 timeout、再试一遍 —— 几轮全废，而真正该做的是向主代理要授权。
 *
 * 这里只做一件事：当（a）这条 bash 确实是离线跑的，（b）输出里出现网络失败的
 * 特征串时，在结果后面补一句「这是授权问题，不是环境问题，去找 contact_supervisor」。
 *
 * 文本面向模型、英文、要短：它会在每一次失败后面出现。
 */

/** 已补过提示的标记，兼作幂等判据（同一份结果可能经过多条路径）。 */
const MARK = "[sandbox]"

/**
 * 网络失败的特征串。只收「解析/路由根本不通」这一类：
 * `ECONNREFUSED` / `socket hang up` 刻意不收 —— 本地 loopback 是通的，
 * 那两个在沙箱内是正常的测试结果，补提示会造成误报。
 */
const NETWORK_FAILURES: RegExp[] = [
	/\bENETUNREACH\b/,
	/\bENETDOWN\b/,
	/\bEHOSTUNREACH\b/,
	/\bEAI_AGAIN\b/,
	/\bENOTFOUND\b/,
	/network is unreachable/i,
	/could not resolve host/i,
	/temporary failure in name resolution/i,
	/getaddrinfo[^\n]*failed/i,
]

/**
 * 补在网络失败结果后面的提示；不该补时返回 undefined。
 *
 * @param text bash 工具结果的纯文本
 * @param offline 这条命令是否在无网沙箱里跑的（`bash.network !== true`）
 */
export function networkFailureNote(text: string, offline: boolean): string | undefined {
	if (!offline || !text || text.includes(MARK)) return undefined
	if (!NETWORK_FAILURES.some((pattern) => pattern.test(text))) return undefined
	return `${MARK} network is disabled here by the parent's bindings — this is a permission, not a broken machine. Another registry, flag or timeout will fail the same way. If the task needs the network, use contact_supervisor to ask for it ("network": true).`
}
