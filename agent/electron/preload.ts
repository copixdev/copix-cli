/** Type-only Copix API surface shared by Desktop and the standalone CLI. */

export interface ServerStatus {
	online: boolean;
	hasModel?: boolean;
	models?: string[];
	missing?: string[];
	provider?: 'ollama' | 'groq' | 'openrouter' | 'openai' | string;
}

export interface CopixApi {
	platform: NodeJS.Platform;
	getPlatform: () => NodeJS.Platform;
	getProjectsRoot: () => Promise<string>;
	browseHomeDirectory: () => Promise<string | undefined>;
	createSessionWorkspace: (sessionId: string) => Promise<unknown>;
	createProject: (
		sessionId: string,
		name: string,
		description?: string,
		outputPath?: string,
	) => Promise<unknown>;
	openFolder: (sessionId?: string) => Promise<unknown>;
	cloneRepo: (url: string, sessionId?: string) => Promise<unknown>;
	getWorkspace: (workspaceRoot: string) => Promise<unknown>;
	getRepoRemote: (workspaceRoot: string) => Promise<unknown>;
	readFile: (p: string, workspaceRoot?: string) => Promise<unknown>;
	writeFile: (p: string, c: string, workspaceRoot?: string) => Promise<unknown>;
	deleteFile: (p: string, workspaceRoot?: string) => Promise<unknown>;
	listDir: (p: string | undefined, workspaceRoot?: string) => Promise<unknown>;
	grep: (pattern: string, searchPath?: string, workspaceRoot?: string) => Promise<unknown>;
	runTerminal: (
		cmd: string,
		workspaceRoot?: string,
		cwd?: string,
		elevate?: boolean,
		streamId?: string,
	) => Promise<unknown>;
	onTerminalOutput: (streamId: string, cb: (chunk: string) => void) => () => void;
	getSettings: () => Promise<unknown>;
	setSettings: (s: unknown) => Promise<unknown>;
	loadChatSessions: () => Promise<string | null>;
	saveChatSessions: (json: string) => Promise<void>;
	openExternal: (url: string) => Promise<unknown>;
	openIdeWindow: () => Promise<unknown>;
	getServerStatus: () => Promise<ServerStatus>;
	startServer: () => Promise<{ ok: boolean; message: string }>;
	pullOllamaModel: (model?: string) => Promise<{ ok: boolean; message: string }>;
	ensureCopixModels: () => Promise<{ ok: boolean; message: string; pulled: string[] }>;
	onPullProgress: (cb: (line: string) => void) => () => void;
	onMenuAction: (cb: (action: string) => void) => () => void;
}
