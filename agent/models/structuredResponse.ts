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

/** Tool names small models often dump as plain text instead of native tool_calls. */
const PSEUDO_TOOL_NAMES = [
	'create_project',
	'write_file',
	'append_file',
	'edit_file',
	'delete_file',
	'read_file',
	'list_dir',
	'grep',
	'terminal',
	'run_terminal',
	'web_search',
	'web_fetch',
	'multitask',
	'spawn_subagent',
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidAction(v: unknown): v is AgentAction {
	if (!isRecord(v) || typeof v.type !== 'string' || !v.type.trim()) return false;
	if (v.options !== undefined && !isRecord(v.options)) return false;
	return true;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('{')) return null;
	try {
		const obj = JSON.parse(trimmed) as unknown;
		return isRecord(obj) ? obj : null;
	} catch {
		return null;
	}
}

/** Extract the next brace-balanced `{ ... }` starting at index (string-aware). */
function extractBalancedObject(text: string, from = 0): { json: string; start: number; end: number } | null {
	const start = text.indexOf('{', from);
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === '\\') {
				escape = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return { json: text.slice(start, i + 1), start, end: i + 1 };
			}
		}
	}
	return null;
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

/**
 * Recover when small models print tool calls as chat, e.g.:
 *
 *   Step 3: Create settings.json
 *   write_file
 *   {"path":"./settings/settings.json","content":"{...}"}
 *
 * or fenced:
 *
 *   write_file
 *   ```json
 *   { "path": "...", "content": "..." }
 *   ```
 */
export function parsePseudoToolCalls(text: string): StructuredAgentResponse | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const nameAlt = PSEUDO_TOOL_NAMES.join('|');
	const actions: AgentAction[] = [];
	const consumed: Array<{ start: number; end: number }> = [];
	const nameRe = new RegExp(
		`(?:^|\\n)\\s*(?:#{1,6}\\s*|[-*]\\s*|\\d+\\.\\s*)?(?:tool\\s*[:=]\\s*)?(\`?)(${nameAlt})\\1\\b`,
		'gi',
	);

	let nameMatch: RegExpExecArray | null;
	while ((nameMatch = nameRe.exec(trimmed)) !== null) {
		const tool = nameMatch[2].toLowerCase();
		const afterName = nameMatch.index + nameMatch[0].length;
		const slice = trimmed.slice(afterName, afterName + 8000);
		// Skip optional ```json fence
		const fence = slice.match(/^\s*```(?:json)?\s*/i);
		const objStartAt = afterName + (fence ? fence[0].length : 0);
		const bal = extractBalancedObject(trimmed, objStartAt);
		if (!bal || bal.start - objStartAt > 80) continue;
		const obj = tryParseJsonObject(bal.json);
		if (!obj) continue;
		if (Array.isArray(obj.actions) && typeof obj.message === 'string') continue;
		actions.push({ type: tool, options: obj });
		let end = bal.end;
		const after = trimmed.slice(end, end + 10);
		const closeFence = after.match(/^\s*```/);
		if (closeFence) end += closeFence[0].length;
		consumed.push({ start: nameMatch.index, end });
		nameRe.lastIndex = end;
	}

	// Bare fenced JSON with path+content (no tool name)
	const fenceRe = /```(?:json)?\s*/gi;
	let fenceMatch: RegExpExecArray | null;
	while ((fenceMatch = fenceRe.exec(trimmed)) !== null) {
		const bal = extractBalancedObject(trimmed, fenceMatch.index + fenceMatch[0].length);
		if (!bal) continue;
		const overlaps = consumed.some(c => bal.start < c.end && bal.end > c.start);
		if (overlaps) continue;
		const obj = tryParseJsonObject(bal.json);
		if (!obj) continue;
		let end = bal.end;
		const close = trimmed.slice(end, end + 10).match(/^\s*```/);
		if (close) end += close[0].length;
		if (typeof obj.path === 'string' && (typeof obj.content === 'string' || typeof obj.detail === 'string')) {
			actions.push({ type: 'write_file', options: obj });
			consumed.push({ start: fenceMatch.index, end });
		} else if (typeof obj.command === 'string' || typeof obj.cmd === 'string') {
			actions.push({ type: 'terminal', options: obj });
			consumed.push({ start: fenceMatch.index, end });
		}
		fenceRe.lastIndex = end;
	}

	if (!actions.length) return null;

	let message = trimmed;
	for (const c of [...consumed].sort((a, b) => b.start - a.start)) {
		message = message.slice(0, c.start) + message.slice(c.end);
	}
	message = message
		.replace(/(?:^|\n)\s*Step\s*\d+\s*:[^\n]*/gi, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return {
		message: message || `Executing ${actions.length} file/tool action${actions.length === 1 ? '' : 's'}…`,
		actions,
	};
}

/** True when the model is narrating tool use / steps instead of calling tools. */
export function looksLikeToolDump(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (parsePseudoToolCalls(t)) return true;
	const nameAlt = PSEUDO_TOOL_NAMES.join('|');
	return new RegExp(`\\b(${nameAlt})\\b[\\s\\S]{0,40}\\{`, 'i').test(t)
		|| /\bStep\s*\d+\s*:\s*(create|write|edit|add|make)\b/i.test(t);
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
