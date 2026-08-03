/** Structured assistant responses: { message, actions[] }. */

export interface AgentAction {
	type: string;
	options?: Record<string, unknown>;
}

export interface StructuredAgentResponse {
	message: string;
	actions: AgentAction[];
}

const ACTION_ALIASES: Record<string, string> = {
	write_script: 'write_file',
	edit_script: 'edit_file',
	read_script: 'read_file',
	run_command: 'terminal',
	run_terminal: 'terminal',
	shell: 'terminal',
	terminal_command: 'terminal',
	append: 'append_file',
	spawn_agent: 'spawn_subagent',
	delegate: 'spawn_subagent',
	search_web: 'web_search',
	bing: 'web_search',
	google: 'web_search',
	browse: 'web_fetch',
	browse_page: 'web_fetch',
	fetch_url: 'web_fetch',
	open_url: 'web_fetch',
	read_url: 'web_fetch',
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidAction(v: unknown): v is AgentAction {
	if (!isRecord(v) || typeof v.type !== 'string' || !v.type.trim()) return false;
	if (v.options !== undefined && !isRecord(v.options)) return false;
	return true;
}

/** Extract JSON object from raw assistant text (plain JSON or ```json fence). */
export function parseStructuredResponse(text: string): StructuredAgentResponse | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidate = (fence ? fence[1] : trimmed).trim();
	if (!candidate.startsWith('{')) return null;

	try {
		const obj = JSON.parse(candidate) as unknown;
		if (!isRecord(obj)) return null;
		const message = typeof obj.message === 'string' ? obj.message.trim() : '';
		const actions = Array.isArray(obj.actions)
			? obj.actions.filter(isValidAction).map(a => ({
				type: a.type.trim(),
				options: a.options,
			}))
			: [];
		if (!message && !actions.length) return null;
		return { message, actions };
	} catch {
		return null;
	}
}

/** Map a structured action to an internal tool name + args. */
export function actionToTool(action: AgentAction): { tool: string; args: Record<string, unknown> } | null {
	const rawType = action.type.trim();
	const tool = ACTION_ALIASES[rawType] ?? rawType;
	const opt = action.options ?? {};

	switch (tool) {
		case 'write_file':
			return {
				tool,
				args: {
					path: opt.path ?? opt.file ?? opt.filename,
					content: opt.content ?? opt.detail ?? opt.script ?? '',
				},
			};
		case 'edit_file':
			return {
				tool,
				args: {
					path: opt.path ?? opt.file,
					old_string: opt.old_string ?? opt.old ?? '',
					new_string: opt.new_string ?? opt.new ?? opt.detail ?? '',
					replace_all: Boolean(opt.replace_all),
				},
			};
		case 'read_file':
			return { tool, args: { path: opt.path ?? opt.file } };
		case 'delete_file':
			return { tool, args: { path: opt.path ?? opt.file } };
		case 'grep':
			return { tool, args: { pattern: opt.pattern ?? opt.query, path: opt.path } };
		case 'list_dir':
			return { tool, args: { path: opt.path } };
		case 'append_file':
			return {
				tool,
				args: {
					path: opt.path ?? opt.file ?? opt.filename,
					content: opt.content ?? opt.detail ?? opt.text ?? '',
				},
			};
		case 'run_terminal':
		case 'terminal':
			return {
				tool: 'terminal',
				args: {
					command: opt.command ?? opt.cmd ?? opt.detail,
					cwd: opt.cwd,
					elevate: Boolean(opt.elevate),
				},
			};
		case 'create_project':
			return {
				tool,
				args: {
					name: opt.name,
					description: opt.description,
					outputPath: opt.outputPath,
				},
			};
		case 'web_search':
			return {
				tool,
				args: {
					query: opt.query ?? opt.q ?? opt.search ?? opt.detail,
					max_results: opt.max_results ?? opt.limit,
				},
			};
		case 'web_fetch':
			return {
				tool,
				args: {
					url: opt.url ?? opt.href ?? opt.link ?? opt.detail,
					max_chars: opt.max_chars ?? opt.maxChars,
				},
			};
		case 'multitask':
			return { tool, args: { summary: opt.summary, tasks: opt.tasks } };
		case 'spawn_subagent':
			return {
				tool,
				args: {
					prompt: opt.prompt ?? opt.detail ?? opt.task ?? '',
					label: opt.label ?? opt.name,
				},
			};
		default:
			return { tool, args: opt };
	}
}
