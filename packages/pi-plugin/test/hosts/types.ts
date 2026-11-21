// Host-agnostic contract for driving a scenario. Every host returns the same
// observations so the scenario tests never import a host SDK themselves.
export interface HostRun {
	toolResults: { tool?: string; text: string }[];
	assistantText: string;
	transcript: unknown[];
	stderr: string;
	stop(): Promise<void>;
}

export interface HostDriver {
	readonly name: string;
	run(input: {
		project: string;
		mockUrl: string;
		agentDir: string;
		prompt: string;
		timeoutMs: number;
	}): Promise<HostRun>;
}
