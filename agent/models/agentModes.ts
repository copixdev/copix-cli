/** High-level agent modes — how Copix approaches a task. */
export type AgentMode = 'plan' | 'code' | 'debug' | 'terminal';

/** Workspace runtime environment (where code runs). */
export type WorkspaceEnvironment = 'desktop' | 'github' | 'cloud';

/** Tool surface categories shown in the agent tools panel. */
export type AgentToolSurface = 'terminal' | 'search' | 'editor' | 'changes';

export interface AgentModeDef {
	id: AgentMode;
	label: string;
	description: string;
	surfaces: AgentToolSurface[];
}

export const AGENT_MODES: AgentModeDef[] = [
	{
		id: 'plan',
		label: 'Plan',
		description: 'Break down tasks, explore options, and propose an approach before coding.',
		surfaces: ['search', 'editor'],
	},
	{
		id: 'code',
		label: 'Code',
		description: 'Implement features, edit files, and run builds.',
		surfaces: ['editor', 'terminal', 'changes'],
	},
	{
		id: 'debug',
		label: 'Debug',
		description: 'Diagnose errors, inspect logs, and fix issues.',
		surfaces: ['terminal', 'search', 'editor', 'changes'],
	},
	{
		id: 'terminal',
		label: 'Terminal',
		description: 'Run shell commands and automate environment setup.',
		surfaces: ['terminal'],
	},
];

export const WORKSPACE_ENV_LABELS: Record<WorkspaceEnvironment, string> = {
	desktop: 'Desktop',
	github: 'GitHub',
	cloud: 'Cloud',
};

export function getAgentMode(id: AgentMode): AgentModeDef {
	return AGENT_MODES.find(m => m.id === id) ?? AGENT_MODES[1];
}

export function inferWorkspaceEnv(repoUrl?: string, isLocalPath?: boolean): WorkspaceEnvironment {
	if (repoUrl && /github\.com/i.test(repoUrl)) return 'github';
	if (isLocalPath !== false) return 'desktop';
	return 'cloud';
}
