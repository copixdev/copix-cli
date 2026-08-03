import type { AgentMode, WorkspaceEnvironment } from './models/agentModes';
import type { ChatActivity } from './chatActivity';
import type { AgentAction } from './models/structuredResponse';

export type { AgentAction, StructuredAgentResponse } from './models/structuredResponse';

export type { AgentMode, WorkspaceEnvironment };
export type { ChatActivity, ActivityKind, ActivityPhase } from './chatActivity';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
	id: string;
	role: ChatRole;
	content: string;
	timestamp: number;
	/** Pasted image data URLs attached to the user message. */
	images?: string[];
	/** Tool/thinking rows shown above the assistant reply (panel). */
	activities?: ChatActivity[];
	/** Parsed actions from a structured JSON response (for replay / UI). */
	structuredActions?: AgentAction[];
}

export interface EditorTab {
	path: string;
	content: string;
	dirty: boolean;
}

export interface LayoutSettings {
	sidebarWidth: number;
	editorWidth: number;
}

export interface WorkspaceSettings {
	/** Default folder for agent output (projects, generated files). */
	homeDirectory: string;
}

export type ThemePreference = 'dark';

export type ModelSelectionMode = 'auto' | 'manual';

export type ModelProvider = 'ollama' | 'groq' | 'openrouter' | 'openai';

export interface ModelSettings {
	/**
	 * ollama = local. groq = free cloud (Llama).
	 * openrouter = paid cloud with frontier models (Claude Opus, GPT, Gemini) — openrouter.ai/keys.
	 * openai = direct OpenAI API — platform.openai.com/api-keys.
	 */
	provider?: ModelProvider;
	/** Required for groq / openrouter / openai. */
	apiKey?: string;
	/** Auto picks a model by agent mode; manual uses modelId. */
	selection?: ModelSelectionMode;
	modelId: string;
	/** Safer local inference: smaller context, prefers lighter models in auto mode. */
	lowVram?: boolean;
}

/** Local app settings — persisted to ~/Copix/settings.json */
export interface AppSettings {
	model: ModelSettings;
	layout: LayoutSettings;
	workspace: WorkspaceSettings;
	theme: ThemePreference;
	agentMode: AgentMode;
}

export const DEFAULT_LAYOUT: LayoutSettings = {
	sidebarWidth: 220,
	editorWidth: 420,
};

export const DEFAULT_WORKSPACE: WorkspaceSettings = {
	homeDirectory: '',
};

export const DEFAULT_MODEL: ModelSettings = {
	provider: 'ollama',
	apiKey: '',
	selection: 'auto',
	modelId: 'qwen2.5:3b',
	lowVram: false,
};

export const DEFAULT_SETTINGS: AppSettings = {
	model: DEFAULT_MODEL,
	layout: DEFAULT_LAYOUT,
	workspace: DEFAULT_WORKSPACE,
	theme: 'dark',
	agentMode: 'code',
};
