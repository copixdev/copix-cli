import type { ModelConfig } from './config.js';
import { buildModelHeaders, resolveChatUrl } from './config.js';
import { copix } from '../api.js';
import type { AgentMode } from './agentModes.js';
import { buildSystemPrompt } from './systemPrompt.js';
import type { TaskKind } from './modelCatalog.js';
import {
	FALLBACK_MODEL_ID,
	GROQ_FALLBACK_MODEL, GROQ_MAX_TOKENS, GROQ_MAX_TOKENS_RETRY, GROQ_MODEL_FALLBACKS, GROQ_VISION_MODEL,
	OPENROUTER_MAX_TOKENS, OPENROUTER_MAX_TOKENS_FLOOR, parseOpenRouterAffordableTokens, sanitizeGroqModelId,
} from './modelCatalog.js';
import { inferTaskKind, isContinuationMessage, isReadOnlyTask, isSimpleChatMessage } from './modelSelector.js';
import { actionToTool, parseStructuredResponse, type StructuredAgentResponse } from './structuredResponse.js';
import { webFetch, webSearch } from './webBrowse.js';
import { computeLineDiff, truncateText } from '../utils/lineDiff.js';
import { assertSafeFilePath } from '../utils/secrets.js';
import { emitAgentTerminal } from '../utils/terminalBridge.js';
import { isMac, isWindows, projectPathExample, shellLabel } from '../utils/platform.js';

export interface AgentContext {
	sessionId: string;
	workspaceRoot: string;
	onWorkspaceChange?: (root: string) => void;
	onSpawnSubagent?: (prompt: string, label?: string) => Promise<{ sessionId: string }>;
	/** Original user message for this agent turn (used to gate subagents). */
	userMessage?: string;
	taskKind?: TaskKind;
	/** True when this run is already a child subagent — never nest further. */
	isSubagent?: boolean;
	/** Fingerprints of tool calls this turn — used to block identical repeats. */
	recentToolFingerprints?: string[];
}

interface MultitaskItem {
	tool: string;
	args?: Record<string, unknown>;
}

const TERMINAL_TOOL_ALIASES = new Set(['terminal', 'run_terminal', 'shell', 'bash', 'exec', 'run_command']);
const WEB_SEARCH_ALIASES = new Set(['web_search', 'search_web', 'bing', 'google']);
const WEB_FETCH_ALIASES = new Set(['web_fetch', 'browse', 'browse_page', 'fetch_url', 'open_url', 'read_url']);

function normalizeToolName(name: string): string {
	if (TERMINAL_TOOL_ALIASES.has(name)) return 'terminal';
	if (WEB_SEARCH_ALIASES.has(name)) return 'web_search';
	if (WEB_FETCH_ALIASES.has(name)) return 'web_fetch';
	return name;
}

function fileStats(content: string): string {
	const lines = content.split('\n').length;
	const bytes = new TextEncoder().encode(content).length;
	return `${lines} lines, ${bytes} bytes`;
}

const READ_ONLY_TOOL_NAMES = new Set(['read_file', 'list_dir', 'grep', 'multitask', 'web_search', 'web_fetch']);
const WRITE_TOOL_NAMES = new Set([
	'create_project', 'write_file', 'append_file', 'edit_file', 'delete_file', 'terminal', 'run_terminal',
]);

const TOOLS = [
	{
		type: 'function' as const,
		function: {
			name: 'create_project',
			description: `## create_project
Create a new git-initialized project folder with a **nice kebab-case name**.

**When to use:** User asks for a brand-new app/site/repo/template.

**Naming:** Generate a short descriptive slug — e.g. \`ollama-dev-agent\`, \`marketing-site\`, \`invoice-dashboard\`. Never use \`agent-123…\` or \`project\`.

**Default location:** \`${projectPathExample('<kebab-name>')}\` (user home).
If the user names a folder (e.g. ~/sites or /Users/…/sites), pass it as \`outputPath\` and the project is created inside it.

**Do NOT use when:** Inspecting/editing an existing project — use read/edit/write instead.

**Parameters:**
- \`name\` (required) — kebab-case project name you invent from the request
- \`description\` — one-line summary written to README
- \`outputPath\` — optional parent directory or full project path`,
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Kebab-case name, e.g. ollama-dev-agent' },
					description: { type: 'string', description: 'One-line summary of the project' },
					outputPath: { type: 'string', description: 'Optional parent folder or full path (e.g. /Users/you/sites)' },
				},
				required: ['name'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'multitask',
			description: `## multitask
Run **independent** tool calls in parallel (reads, greps, list_dir, terminal, web_search, web_fetch).

**When to use:** Several lookups that do not depend on each other's results.

**Parameters:**
- \`summary\` — short label shown in the workflow UI
- \`tasks[]\` — each item: \`{ tool, args }\``,
			parameters: {
				type: 'object',
				properties: {
					summary: { type: 'string', description: 'Short label for the parallel work' },
					tasks: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								tool: {
									type: 'string',
									enum: ['read_file', 'grep', 'list_dir', 'terminal', 'web_search', 'web_fetch'],
								},
								args: { type: 'object' },
							},
							required: ['tool'],
						},
					},
				},
				required: ['tasks'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'read_file',
			description: `## read_file
Read file contents from disk.

**When to use:** Before editing, to understand context, imports, or error locations.

**Parameters:** \`path\` — relative to workspace or absolute.`,
			parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'edit_file',
			description: `## edit_file
Surgical search-and-replace in an existing file.

**Prefer over** \`write_file\` for small, targeted changes.

**Tips:**
- Copy \`old_string\` exactly from \`read_file\` output (whitespace matters)
- Include 2–3 surrounding lines so the match is unique

**Parameters:**
- \`path\` — file to edit
- \`old_string\` — exact text to find
- \`new_string\` — replacement text
- \`replace_all\` — replace every occurrence (default: first only)`,
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					old_string: { type: 'string' },
					new_string: { type: 'string' },
					replace_all: { type: 'boolean', description: 'Replace every occurrence (default: first only)' },
				},
				required: ['path', 'old_string', 'new_string'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'write_file',
			description: `## write_file
Create or **fully overwrite** a file on the user's local machine.

**When to use:** New files or complete rewrites the user asked for. Parent directories are created automatically.
**Always use this (or edit_file) instead of telling the user to create/paste the file themselves.**

**Tips:**
- Provide the **complete** file body in \`content\`
- Write one file per call; verify with \`read_file\` if needed
- Prefer \`edit_file\` for small changes to existing files

**Parameters:**
- \`path\` — workspace-relative or absolute path
- \`content\` — full file contents (UTF-8 text)`,
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path relative to workspace or absolute' },
					content: { type: 'string', description: 'Complete file body to write' },
				},
				required: ['path', 'content'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'append_file',
			description: `## append_file
Append text to the end of an existing file (or create it if missing).

**When to use:** Add lines to logs, configs, or incrementally build a file.

**Parameters:**
- \`path\` — file to append to
- \`content\` — text to append (a newline is added automatically if the file does not end with one)`,
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					content: { type: 'string' },
				},
				required: ['path', 'content'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'delete_file',
			description: `## delete_file
Permanently delete a file from the workspace.

**Parameters:** \`path\``,
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' } },
				required: ['path'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'grep',
			description: `## grep
Search file contents with ripgrep.

**When to use:** Find symbols, errors, usages, config keys.

**Parameters:**
- \`pattern\` (required) — regex or plain text
- \`path\` — optional file or directory scope`,
			parameters: {
				type: 'object',
				properties: { pattern: { type: 'string' }, path: { type: 'string' } },
				required: ['pattern'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'list_dir',
			description: `## list_dir
List files and folders in a directory.

**When to use:** Explore project structure before reading or editing.

**Parameters:** \`path\` (optional, defaults to workspace root).`,
			parameters: { type: 'object', properties: { path: { type: 'string' } } },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'web_search',
			description: `## web_search
Search the public web for current information (docs, APIs, errors, news, how-tos).

**When to use:** You need up-to-date facts, library docs, release notes, or something not in the local workspace.

**Parameters:**
- \`query\` (required) — search string
- \`max_results\` — number of results (default 5, max 8)`,
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Web search query' },
					max_results: { type: 'number', description: 'How many results to return (1–8)' },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'web_fetch',
			description: `## web_fetch
Fetch a public URL and return readable text (HTML stripped).

**When to use:** After \`web_search\`, or when the user gives a docs/blog/GitHub URL to read.

**Never use for:** \`localhost\`, private IPs, or file:// — those are blocked.

**Parameters:**
- \`url\` (required) — http(s) URL
- \`max_chars\` — truncate body length (default ~12000)`,
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'Public https URL to fetch' },
					max_chars: { type: 'number', description: 'Max characters of extracted text' },
				},
				required: ['url'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'terminal',
			description: `## terminal
Run a **local shell command** on the user's machine (${shellLabel()}). Output streams live in Copix's integrated terminal.

**When to use:** Install packages, run builds/tests, git, npm, pip, scaffolding CLIs, inspect environment. Do NOT use for directory creation — use write_file instead (dirs are auto-created).

**Never use terminal to speak to the user.** Do not run \`echo\` / \`printf\` for greetings or chat replies — answer in markdown instead.

**Local access:** Commands run in the workspace directory by default. You have full local shell access unless the user declines elevation.

**Parameters:**
- \`command\` (required) — shell command to execute
- \`cwd\` — working directory (defaults to workspace root)
- \`elevate\` — \`true\` for ${isWindows() ? 'Administrator / UAC' : 'administrator / sudo'} (system installs, protected paths)`,
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Shell command to run locally' },
					cwd: { type: 'string', description: 'Working directory (defaults to workspace)' },
					elevate: {
						type: 'boolean',
						description: isWindows()
							? 'Run elevated as Administrator (Windows UAC prompt)'
							: 'Run elevated with administrator privileges (macOS auth prompt / sudo)',
					},
				},
				required: ['command'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'spawn_subagent',
			description: `## spawn_subagent
Spawn a child agent in a compact side panel. **Use rarely.**

**ONLY when ALL of these are true:**
- The user asked for a **large / difficult** multi-part coding task
- Work splits into **2+ independent** heavy sub-tasks (e.g. parallel feature modules)
- Doing it all in this chat would be clearly worse

**NEVER use for:**
- Greetings, small talk, or clarifying questions
- Inspect / explain / review / summarize
- Single-file edits, one bugfix, one search, one test
- Anything you can finish yourself in a few tool rounds

Default: do the work yourself with normal tools.

**Parameters:**
- \`prompt\` (required) — self-contained instructions for the hard sub-task
- \`label\` — short panel title`,
			parameters: {
				type: 'object',
				properties: {
					prompt: { type: 'string', description: 'Detailed task prompt the subagent should follow' },
					label: { type: 'string', description: 'Short title shown in the panel' },
				},
				required: ['prompt'],
			},
		},
	},
];

const GROQ_TOOL_BLURBS: Record<string, string> = {
	create_project: 'Scaffold a new empty project (only when user asks and workspace is empty).',
	multitask: 'Run independent read/search/list/terminal tasks in parallel.',
	read_file: 'Read a file from the workspace.',
	edit_file: 'Search-and-replace in an existing file.',
	write_file: 'Create or overwrite a file (parent dirs auto-created).',
	append_file: 'Append text to a file.',
	delete_file: 'Delete a file.',
	grep: 'Search file contents with ripgrep.',
	list_dir: 'List files in a directory.',
	terminal: 'Run a shell command for the CURRENT user request only — never echo/printf to chat, never re-run unrelated scripts.',
	web_search: 'Search the public web (docs, errors, current info).',
	web_fetch: 'Fetch a public URL and return readable text.',
	spawn_subagent: 'RARE: spawn child agent only for hard multi-part parallel work — never for greetings or simple tasks.',
};

/** Shorter tool schemas for Groq free-tier TPM limits. */
function compactTools(tools: typeof TOOLS): typeof TOOLS {
	return tools.map(t => ({
		...t,
		function: {
			...t.function,
			description: GROQ_TOOL_BLURBS[t.function.name] ?? t.function.name,
		},
	}));
}

const HARD_TASK_RE = /\b(refactor|migrate|multi[- ]?file|entire (app|project|codebase)|across (the )?(app|project|repo)|parallel|many files|full stack|end[- ]to[- ]end|large (feature|change)|architecture)\b/i;

/** Subagents only for clearly hard multi-part implement work — not chat/inspect/simple edits. */
export function shouldOfferSubagent(userMessage: string, taskKind: TaskKind): boolean {
	const msg = userMessage.trim();
	if (!msg || isSimpleChatMessage(msg) || msg.length < 24) return false;
	if (isReadOnlyTask(taskKind) || taskKind === 'terminal' || taskKind === 'general') return false;
	if (taskKind === 'implement' || taskKind === 'debug') {
		return HARD_TASK_RE.test(msg) || msg.length >= 160;
	}
	return false;
}

/** Pure chat — no tools (stops small models from `terminal echo` greetings). */
function isChatOnlyTask(taskKind: TaskKind, userMessage?: string): boolean {
	if (taskKind === 'general') return true;
	return Boolean(userMessage && isSimpleChatMessage(userMessage));
}

function toolsForTask(taskKind: TaskKind, provider?: string, userMessage?: string): typeof TOOLS {
	if (isChatOnlyTask(taskKind, userMessage)) return [];
	let base = isReadOnlyTask(taskKind)
		? TOOLS.filter(t => READ_ONLY_TOOL_NAMES.has(t.function.name))
		: TOOLS;
	if (!userMessage || !shouldOfferSubagent(userMessage, taskKind)) {
		base = base.filter(t => t.function.name !== 'spawn_subagent');
	}
	return provider === 'groq' ? compactTools(base) : base;
}

/** Detect using the shell as a chat channel (`echo Hello`). */
function isTerminalEchoCommand(command: string): boolean {
	const c = command.trim();
	if (!c) return false;
	if (/^(echo|printf)\b/i.test(c)) return true;
	if (/^(python3?|node|ruby|perl)\s+-c\s+['"]?(print|console\.log)/i.test(c)) return true;
	return false;
}

type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

type ChatMsg = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | ContentPart[];
	tool_call_id?: string;
	name?: string;
	tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

function userContentWithImages(text: string, images?: string[]): string | ContentPart[] {
	const urls = (images ?? []).filter(Boolean).slice(0, 5);
	if (!urls.length) return text;
	const parts: ContentPart[] = [
		{ type: 'text', text: text || 'Please look at the attached image(s) and help with my request.' },
		...urls.map(url => ({ type: 'image_url' as const, image_url: { url } })),
	];
	return parts;
}

function contentPartsToText(content: string | ContentPart[] | null | undefined): string {
	if (content == null) return '';
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return String(content);
	return content
		.map(part => {
			if (part.type === 'text') return part.text;
			if (part.type === 'image_url') return '[image attached]';
			return '';
		})
		.filter(Boolean)
		.join('\n');
}

function modelSupportsVision(modelId: string): boolean {
	return modelId === GROQ_VISION_MODEL
		|| /scout|vision|llava|pixtral|claude|gpt-4o|gpt-4\.1|gpt-5|gemini|\bo3\b|omni/i.test(modelId);
}

/** Groq rejects non-string content on non-vision models (and null content on tool turns). */
function normalizeMessagesForModel(messages: ChatMsg[], modelId: string): ChatMsg[] {
	const allowParts = modelSupportsVision(modelId);
	return messages.map(m => {
		let content: string | ContentPart[] = m.content;
		if (allowParts && Array.isArray(content)) {
			/* keep multimodal parts */
		} else {
			content = contentPartsToText(content);
		}
		if (typeof content !== 'string' && !Array.isArray(content)) {
			content = '';
		}
		const next: ChatMsg = { ...m, content };
		if (m.tool_calls?.length) {
			next.content = typeof next.content === 'string' ? next.content : contentPartsToText(next.content);
			next.tool_calls = m.tool_calls.map(tc => ({
				...tc,
				function: {
					name: tc.function.name,
					arguments: typeof tc.function.arguments === 'string'
						? tc.function.arguments
						: JSON.stringify(tc.function.arguments ?? {}),
				},
			}));
		}
		if (m.role === 'tool') {
			next.content = contentPartsToText(next.content);
		}
		return next;
	});
}

export type ToolResultMeta = {
	result: string;
	diff?: ReturnType<typeof computeLineDiff>;
};

export type AgentCallbacks = {
	onText: (chunk: string) => void;
	onThinkingStart: () => void;
	onThinkingChunk: (chunk: string) => void;
	onThinkingEnd: () => void;
	onToolStart: (callId: string, tool: string, args: Record<string, unknown>) => void;
	onToolEnd: (callId: string, tool: string, args: Record<string, unknown>, meta: ToolResultMeta) => void;
	onStatus: (msg: string) => void;
	/** Clear streamed assistant text when a tool round starts (intermediate planning hidden from chat). */
	onClearText?: () => void;
	/** Fired when assistant text is parsed as structured JSON (message + actions). */
	onStructuredResponse?: (parsed: StructuredAgentResponse) => void;
};

async function runTerminalCommand(
	args: Record<string, unknown>,
	ws: string,
): Promise<ToolResultMeta> {
	const command = String(args.command ?? args.cmd ?? '').trim();
	if (!command) return { result: 'terminal requires a command' };
	if (isTerminalEchoCommand(command)) {
		return {
			result:
				'Refused: do not use `terminal` with echo/printf to talk to the user. '
				+ 'Reply in chat markdown instead (no tool call).',
		};
	}
	const elevate = Boolean(args.elevate) || needsElevateHint(command);
	const cwd = args.cwd ? String(args.cwd) : ws;
	const streamId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	emitAgentTerminal({ type: 'start', streamId, command, cwd });
	const stop = copix.onTerminalOutput(streamId, chunk => {
		emitAgentTerminal({ type: 'output', streamId, chunk });
	});
	try {
		const out = await copix.runTerminal(command, ws, cwd, elevate, streamId);
		emitAgentTerminal({ type: 'end', streamId, result: out });
		return { result: truncateText(out.trim() || '(no output)', 8000) };
	} finally {
		stop();
	}
}

async function executeTool(
	name: string,
	args: Record<string, unknown>,
	ctx: AgentContext,
): Promise<ToolResultMeta> {
	const ws = ctx.workspaceRoot;
	const tool = normalizeToolName(name);
	const fingerprint = `${tool}:${JSON.stringify(args)}`;
	const recent = ctx.recentToolFingerprints ?? (ctx.recentToolFingerprints = []);
	const sameCount = recent.filter(f => f === fingerprint).length;
	if (sameCount >= 1 && (tool === 'terminal' || sameCount >= 2)) {
		return {
			result: `Refused repeated ${tool} with the same arguments (${sameCount + 1}x). `
				+ 'Stop looping. Focus on the user\'s latest request — write/edit the files they asked for, then reply.',
		};
	}
	recent.push(fingerprint);
	if (recent.length > 40) recent.splice(0, recent.length - 40);

	switch (tool) {
		case 'create_project': {
			const projectName = String(args.name ?? 'project').trim() || 'project';
			assertSafeFilePath(projectName);
			const desc = args.description ? String(args.description) : undefined;
			const outputPath = args.outputPath ? String(args.outputPath) : undefined;
			if (outputPath) assertSafeFilePath(outputPath);
			const result = await copix.createProject(ctx.sessionId, projectName, desc, outputPath);
			ctx.onWorkspaceChange?.(result.root);
			const folder = result.root.replace(/\\/g, '/').split('/').filter(Boolean).pop() || projectName;
			return {
				result: `Created project "${folder}" at ${result.root}\nFiles: ${result.tree.slice(0, 20).join(', ')}`,
			};
		}
		case 'multitask': {
			const tasks = (args.tasks as MultitaskItem[] | undefined) ?? [];
			const summary = args.summary ? String(args.summary) : 'parallel tasks';
			const results = await Promise.all(tasks.map(async (t, i) => {
				try {
					const meta = await executeTool(normalizeToolName(t.tool), t.args ?? {}, ctx);
					return `[${i + 1}] ${t.tool}: OK\n${truncateText(meta.result, 800)}`;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return `[${i + 1}] ${t.tool}: ERROR\n${msg}`;
				}
			}));
			return { result: `${summary}\n\n${results.join('\n\n')}` };
		}
		case 'read_file': {
			const filePath = String(args.path ?? '');
			assertSafeFilePath(filePath);
			const content = await copix.readFile(filePath, ws);
			return { result: truncateText(content, 8000) };
		}
		case 'edit_file': {
			const filePath = String(args.path ?? '');
			assertSafeFilePath(filePath);
			const oldStr = String(args.old_string ?? '');
			const newStr = String(args.new_string ?? '');
			const replaceAll = Boolean(args.replace_all);
			const before = await copix.readFile(filePath, ws);
			if (!before.includes(oldStr)) {
				const preview = before.slice(0, 500);
				return {
					result: `Could not find old_string in ${filePath}.`
						+ ` Copy text exactly from read_file (whitespace matters).\n\nFile starts with:\n${preview}${before.length > 500 ? '\n…' : ''}`,
				};
			}
			const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
			const saved = await copix.writeFile(filePath, after, ws);
			return { result: `Patched ${saved}`, diff: computeLineDiff(before, after) };
		}
		case 'write_file': {
			const filePath = String(args.path ?? '');
			assertSafeFilePath(filePath);
			const newContent = String(args.content ?? '');
			let before = '';
			try {
				before = await copix.readFile(filePath, ws);
			} catch { /* new file */ }
			const saved = await copix.writeFile(filePath, newContent, ws);
			const diff = computeLineDiff(before, newContent);
			const verb = before ? 'Overwrote' : 'Created';
			return { result: `${verb} ${saved} (${fileStats(newContent)})`, diff };
		}
		case 'append_file': {
			const filePath = String(args.path ?? '');
			assertSafeFilePath(filePath);
			const chunk = String(args.content ?? '');
			let before = '';
			try {
				before = await copix.readFile(filePath, ws);
			} catch { /* new file */ }
			const needsNl = before.length > 0 && !before.endsWith('\n');
			const after = `${before}${needsNl ? '\n' : ''}${chunk}`;
			const saved = await copix.writeFile(filePath, after, ws);
			const diff = computeLineDiff(before, after);
			return { result: `Appended to ${saved} (${fileStats(chunk)} added)`, diff };
		}
		case 'delete_file': {
			const filePath = String(args.path ?? '');
			assertSafeFilePath(filePath);
			const removed = await copix.deleteFile(filePath, ws);
			return { result: `Deleted ${removed}` };
		}
		case 'grep': {
			const out = await copix.grep(
				String(args.pattern ?? ''),
				args.path ? String(args.path) : undefined,
				ws,
			);
			return { result: truncateText(out, 8000) };
		}
		case 'list_dir': {
			const entries = await copix.listDir(args.path ? String(args.path) : undefined, ws);
			return { result: entries.join('\n') || '(empty)' };
		}
		case 'terminal':
			return runTerminalCommand(args, ws);
		case 'web_search': {
			const query = String(args.query ?? args.q ?? args.search ?? '').trim();
			const max = Number(args.max_results ?? args.limit ?? 5);
			try {
				return { result: await webSearch(query, max) };
			} catch (err) {
				return { result: `web_search failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		}
		case 'web_fetch': {
			const url = String(args.url ?? args.href ?? args.link ?? '').trim();
			const maxChars = Number(args.max_chars ?? args.maxChars ?? 12_000);
			try {
				return { result: await webFetch(url, maxChars) };
			} catch (err) {
				return { result: `web_fetch failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		}
		case 'spawn_subagent': {
			const prompt = String(args.prompt ?? '').trim();
			if (!prompt) return { result: 'spawn_subagent requires a prompt' };
			if (ctx.isSubagent) {
				return { result: 'Refused: nested subagents are not allowed — finish this task yourself with tools.' };
			}
			const taskKind = ctx.taskKind ?? inferTaskKind(ctx.userMessage ?? prompt, 'code');
			if (!shouldOfferSubagent(ctx.userMessage ?? '', taskKind)) {
				return {
					result: 'Refused: spawn_subagent is only for hard multi-part tasks. Do the work yourself with normal tools (read_file, write_file, edit_file, terminal, etc.).',
				};
			}
			const label = args.label ? String(args.label) : undefined;
			if (!ctx.onSpawnSubagent) {
				return { result: 'Subagent spawning is not available in this context' };
			}
			const { sessionId } = await ctx.onSpawnSubagent(prompt, label);
			return { result: `Subagent "${label || sessionId}" started in compact panel (${sessionId}). Continue coordinating only if more hard parallel work remains; otherwise finish here.` };
		}
		default:
			return { result: `Unknown tool: ${name}${name !== tool ? ` (normalized: ${tool})` : ''}` };
	}
}

function needsElevateHint(command: string): boolean {
	const c = command.toLowerCase();
	return /\b(sudo|runas|pkexec|bcdedit|dism\s|reg\s+add|takeown|icacls|winget\s+install|choco\s+install|install-windowsfeature|brew\s+install|installer\s+-pkg)\b/.test(c);
}

async function executeStructuredActions(
	parsed: StructuredAgentResponse,
	ctx: AgentContext,
	callbacks: AgentCallbacks,
): Promise<void> {
	callbacks.onStructuredResponse?.(parsed);
	for (let i = 0; i < parsed.actions.length; i++) {
		const mapped = actionToTool(parsed.actions[i]);
		if (!mapped) continue;
		const { tool, args } = mapped;
		const callId = `struct-${Date.now()}-${i}`;
		callbacks.onToolStart(callId, tool, args);
		let meta: ToolResultMeta;
		try {
			meta = await executeTool(tool, args, ctx);
		} catch (err) {
			meta = { result: err instanceof Error ? err.message : String(err) };
		}
		callbacks.onToolEnd(callId, tool, args, meta);
	}
}

const SUMMARY_USER_PROMPT = `Provide a detailed markdown summary for the user:
- What you investigated and accomplished
- Files changed and why
- Errors found and fixes applied
- How to verify / next steps

Do not call tools. Write clearly for the user.`;

const CONTINUE_USER_PROMPT = `Continue the task from where you left off — based on the user's LATEST message only.
- Do not run unrelated existing scripts.
- Read existing files first if needed — do not recreate work already done for THIS task.
- Create or edit any remaining files with tools for the requested work.
- Do not repeat the same terminal command.
- Do not stop until the work is complete or you are genuinely blocked and need user input.
- When finished, reply with a clear markdown summary for the user.`;

const MAX_AGENT_ROUNDS = 40;
const MAX_HISTORY_TURNS = 24;
const MAX_MESSAGE_CHARS = 12000;
const MAX_EMPTY_REPLY_RETRIES = 4;
const MAX_INCOMPLETE_RETRIES = 4;

function looksLikePlanningOnly(text: string): boolean {
	const t = text.trim();
	if (!t) return true;
	return /\b(I will|I'll|let me|first,? I'll|step 1|plan to|going to|next I)\b/i.test(t)
		&& !/\b(created|updated|wrote|edited|done|complete|finished|saved|wrote to)\b/i.test(t);
}

function looksLikePartialCompletion(text: string): boolean {
	return /\b(next|remaining|still need|will also|not yet|partially|one more|another file|TODO)\b/i.test(text);
}

function augmentUserMessage(userMessage: string, priorMessages: Array<{ role: string; content: string }>): string {
	if (!isContinuationMessage(userMessage) || !priorMessages.length) return userMessage;
	return `${userMessage}

[Continue the work from our previous conversation. Read what was already done in the chat history and workspace, then finish any remaining steps. Do not restart from scratch or repeat mkdir/setup already completed.]`;
}

async function streamCompletion(
	messages: ChatMsg[],
	config: ModelConfig,
	signal: AbortSignal,
	callbacks: AgentCallbacks,
	opts: { tools?: typeof TOOLS; emitText?: boolean },
): Promise<{ assistantText: string; toolCalls: Map<number, { id: string; name: string; args: string }> }> {
	const url = resolveChatUrl(config);
	let thinking = true;
	callbacks.onThinkingStart();
	const endThinking = () => {
		if (!thinking) return;
		thinking = false;
		callbacks.onThinkingEnd();
	};

	const PROVIDER_LABELS: Record<string, string> = {
		groq: 'Groq', openrouter: 'OpenRouter', openai: 'OpenAI', ollama: 'Ollama',
	};
	const providerLabel = PROVIDER_LABELS[config.provider] ?? 'Ollama';
	const isCloud = config.provider !== 'ollama';
	if (config.provider === 'groq') {
		config.model = sanitizeGroqModelId(config.model);
	}
	const modelCandidates = config.provider === 'groq'
		? [...new Set([
			sanitizeGroqModelId(config.model),
			...(modelSupportsVision(config.model) ? [GROQ_VISION_MODEL] : []),
			...GROQ_MODEL_FALLBACKS.map(sanitizeGroqModelId),
			GROQ_FALLBACK_MODEL,
		])]
		: config.provider === 'ollama'
			? [...new Set([config.model, FALLBACK_MODEL_ID])]
			: [config.model];

	let maxTokens = config.provider === 'groq'
		? Math.min(config.numPredict ?? GROQ_MAX_TOKENS, GROQ_MAX_TOKENS)
		: config.provider === 'openrouter'
			? Math.min(config.numPredict ?? OPENROUTER_MAX_TOKENS, OPENROUTER_MAX_TOKENS)
			: (config.numPredict ?? 16384);
	let lastError = '';
	let rateLimitRetries = 0;
	let creditRetries = 0;

	for (let attempt = 0; attempt < modelCandidates.length; attempt++) {
		const modelId = modelCandidates[attempt]!;
		const normalizedMessages = normalizeMessagesForModel(messages, modelId);
		const tools = opts.tools?.length ? opts.tools : undefined;
		const requestBody = isCloud
			? {
				model: modelId,
				messages: normalizedMessages,
				...(tools
					? {
						tools,
						tool_choice: 'auto',
						...(config.provider === 'groq' ? { parallel_tool_calls: false } : {}),
					}
					: {}),
				stream: true,
				temperature: 0.05,
				max_tokens: maxTokens,
			}
			: {
				model: modelId,
				messages: normalizedMessages,
				...(tools ? { tools } : {}),
				stream: true,
				temperature: 0.05,
				options: {
					...(config.numCtx != null ? { num_ctx: config.numCtx } : { num_ctx: 16384 }),
					num_predict: config.numPredict ?? 16384,
					num_batch: 512,
					keep_alive: '30m',
				},
			};

		let res: Response;
		try {
			res = await fetch(url, {
				method: 'POST',
				headers: buildModelHeaders(config),
				body: JSON.stringify(requestBody),
				signal,
			});
		} catch (err) {
			if (signal.aborted) return { assistantText: '', toolCalls: new Map() };
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Cannot reach ${providerLabel} at ${config.baseUrl} — ${msg}`);
		}

		if (!res.ok) {
			const errText = await res.text().catch(() => '');
			let message = errText.slice(0, 800) || res.statusText;
			try {
				const parsed = JSON.parse(errText) as { error?: { message?: string } };
				if (parsed.error?.message) message = parsed.error.message;
			} catch { /* raw text */ }
			lastError = `${providerLabel} ${res.status}: ${message}`;
			const modelMissing = res.status === 404
				|| /does not exist|not found|do not have access|model_not_found/i.test(message);
			const rateLimited = res.status === 429
				|| /rate limit|tokens per minute|tpm|try again in/i.test(message);
			const tooLarge = res.status === 413
				|| /request too large/i.test(message);
			const badContent = res.status === 400
				&& /content must be a string|invalid.*message|only one tool call/i.test(message);

			if (isCloud && rateLimited && rateLimitRetries < 2) {
				rateLimitRetries += 1;
				if (config.provider === 'groq') maxTokens = GROQ_MAX_TOKENS_RETRY;
				const waitMatch = message.match(/try again in\s*([\d.]+)\s*s/i);
				const waitMs = Math.min(
					45_000,
					Math.max(3_000, Math.ceil((waitMatch ? Number(waitMatch[1]) : 8) * 1000) + 500),
				);
				callbacks.onThinkingChunk?.(`\n(rate limited — waiting ${Math.ceil(waitMs / 1000)}s, then retrying…)\n`);
				await new Promise<void>((resolve, reject) => {
					const t = setTimeout(resolve, waitMs);
					signal.addEventListener('abort', () => {
						clearTimeout(t);
						reject(new DOMException('Aborted', 'AbortError'));
					}, { once: true });
				}).catch(() => undefined);
				if (signal.aborted) return { assistantText: '', toolCalls: new Map() };
				attempt -= 1; // retry same model
				continue;
			}

			// OpenRouter reserves credits for the full max_tokens budget. On 402, shrink and retry.
			const creditLimited = res.status === 402
				|| /requires more credits|can only afford|fewer max_tokens/i.test(message);
			if (config.provider === 'openrouter' && creditLimited && creditRetries < 4) {
				const afford = parseOpenRouterAffordableTokens(message);
				const next = afford != null
					? Math.max(OPENROUTER_MAX_TOKENS_FLOOR, Math.min(maxTokens - 1, Math.floor(afford * 0.85)))
					: Math.max(OPENROUTER_MAX_TOKENS_FLOOR, Math.floor(maxTokens / 2));
				if (next < maxTokens) {
					creditRetries += 1;
					maxTokens = next;
					callbacks.onThinkingChunk?.(
						`\n(OpenRouter credit reserve — retrying with max_tokens=${maxTokens}…)\n`,
					);
					attempt -= 1;
					continue;
				}
				throw new Error(
					`${lastError}\n\nCopix already lowered max_tokens. Add credits at https://openrouter.ai/settings/credits `
					+ `or pick a cheaper model (e.g. Claude Sonnet / Llama).`,
				);
			}

			if (config.provider === 'groq' && (modelMissing || tooLarge || rateLimited || badContent) && attempt < modelCandidates.length - 1) {
				if (tooLarge || rateLimited) maxTokens = GROQ_MAX_TOKENS_RETRY;
				continue;
			}
			if (config.provider === 'ollama' && modelMissing && attempt < modelCandidates.length - 1) {
				callbacks.onThinkingChunk?.(
					`\n(model ${modelId} missing — retrying with ${modelCandidates[attempt + 1]}…)\n`,
				);
				continue;
			}
			throw new Error(lastError);
		}

		if (modelId !== config.model) {
			config.model = modelId;
		}
		config.numPredict = maxTokens;

		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let assistantText = '';
		const toolCalls = new Map<number, { id: string; name: string; args: string }>();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const payload = line.slice(6).trim();
				if (payload === '[DONE]') continue;
				try {
					const json = JSON.parse(payload);
					const delta = json.choices?.[0]?.delta;
					const reasoning = delta?.reasoning_content ?? delta?.reasoning;
					if (reasoning) {
						callbacks.onThinkingChunk(String(reasoning));
					}
					if (delta?.content) {
						endThinking();
						assistantText += delta.content;
						if (opts.emitText !== false) callbacks.onText(delta.content);
					}
					for (const tc of delta?.tool_calls ?? []) {
						if (tc.function?.name) endThinking();
						const idx = tc.index ?? 0;
						if (!toolCalls.has(idx)) toolCalls.set(idx, { id: tc.id ?? `c${idx}`, name: '', args: '' });
						const e = toolCalls.get(idx)!;
						if (tc.function?.name) e.name = tc.function.name;
						if (tc.function?.arguments) e.args += tc.function.arguments;
					}
				} catch { /* skip */ }
			}
		}

		endThinking();
		return { assistantText, toolCalls };
	}

	throw new Error(lastError || `${providerLabel}: no available model`);
}

function historyToMessages(
	messages: Array<{ role: string; content: string }>,
	maxTurns = MAX_HISTORY_TURNS,
	maxChars = MAX_MESSAGE_CHARS,
): ChatMsg[] {
	const filtered = messages
		.filter(m => m.role === 'user' || m.role === 'assistant')
		.map(m => {
			const raw = typeof m.content === 'string' ? m.content : String(m.content ?? '');
			const cleaned = raw.replace(/^__AGENT_ERROR__/, '').trim();
			return {
				role: m.role as 'user' | 'assistant',
				content: cleaned.length > maxChars
					? `${cleaned.slice(0, maxChars)}\n…[truncated]`
					: cleaned,
			};
		})
		.filter(m => m.content.length > 0);
	return filtered.length > maxTurns ? filtered.slice(-maxTurns) : filtered;
}

export interface AgentRunOptions {
	mode?: AgentMode;
	taskKind?: TaskKind;
	/** Data-URL images pasted/attached to this user turn (vision). */
	images?: string[];
}

export async function runAgent(
	userMessage: string,
	config: ModelConfig,
	ctx: AgentContext,
	priorMessages: Array<{ role: string; content: string }>,
	signal: AbortSignal,
	callbacks: AgentCallbacks,
	options: AgentRunOptions = {},
): Promise<void> {
	const mode = options.mode ?? 'code';
	const taskKind = options.taskKind ?? inferTaskKind(userMessage, mode);
	const effectiveUserMessage = augmentUserMessage(userMessage, priorMessages);
	const images = (options.images ?? []).slice(0, 5);
	const activeTools = toolsForTask(taskKind, config.provider, effectiveUserMessage);
	const runCtx: AgentContext = {
		...ctx,
		userMessage: effectiveUserMessage,
		taskKind,
		recentToolFingerprints: [],
	};
	const historyTurns = config.provider === 'groq' ? 8 : MAX_HISTORY_TURNS;
	const historyChars = config.provider === 'groq' ? 4000 : MAX_MESSAGE_CHARS;

	const messages: ChatMsg[] = [
		{
			role: 'system',
			content: buildSystemPrompt({
				mode,
				workspaceRoot: ctx.workspaceRoot,
				taskKind,
				userMessage: effectiveUserMessage,
			}),
		},
		...historyToMessages(priorMessages, historyTurns, historyChars),
		{ role: 'user', content: userContentWithImages(effectiveUserMessage, images) },
	];

	const maxRounds = MAX_AGENT_ROUNDS;
	let hadToolUse = false;
	let emptyReplyRetries = 0;
	let incompleteRetries = 0;

	for (let i = 0; i < maxRounds; i++) {
		if (signal.aborted) return;
		callbacks.onStatus(`${config.model}…`);

		try {
			const round = await streamCompletion(messages, config, signal, callbacks, { tools: activeTools });
			const { assistantText, toolCalls } = round;

				if (!toolCalls.size) {
				const parsed = parseStructuredResponse(assistantText);
				if (parsed) {
					const displayMessage = parsed.message || '(executed actions)';
					const actions = isChatOnlyTask(taskKind, effectiveUserMessage)
						? []
						: isReadOnlyTask(taskKind)
							? parsed.actions.filter(a => {
								const mapped = actionToTool(a);
								return mapped && !WRITE_TOOL_NAMES.has(normalizeToolName(mapped.tool));
							})
							: parsed.actions;
					if (actions.length) {
						hadToolUse = true;
						await executeStructuredActions({ ...parsed, actions }, runCtx, callbacks);
						callbacks.onClearText?.();
						if (displayMessage) callbacks.onText(displayMessage);
						messages.push({ role: 'assistant', content: displayMessage });
						messages.push({ role: 'user', content: CONTINUE_USER_PROMPT });
						emptyReplyRetries = 0;
						continue;
					}
					callbacks.onStructuredResponse?.(parsed);
					if (displayMessage) callbacks.onText(displayMessage);
					messages.push({ role: 'assistant', content: displayMessage });
					callbacks.onStatus('');
					return;
				}
				if (!assistantText.trim() && hadToolUse) {
					if (emptyReplyRetries < MAX_EMPTY_REPLY_RETRIES) {
						emptyReplyRetries++;
						messages.push({ role: 'user', content: CONTINUE_USER_PROMPT });
						continue;
					}
					callbacks.onText('Finished tool work, but the model returned no final message. Ask me to continue if needed.');
					callbacks.onStatus('');
					return;
				}
				if (!assistantText.trim() && !hadToolUse) {
					if (emptyReplyRetries < MAX_EMPTY_REPLY_RETRIES) {
						emptyReplyRetries++;
						messages.push({
							role: 'user',
							content: 'Please respond with either a tool call or a short chat message. Do not return an empty reply.',
						});
						continue;
					}
					throw new Error(`${config.provider === 'ollama' ? 'Ollama' : config.provider} returned an empty reply. Try again or pick another model.`);
				}
				if (
					!isReadOnlyTask(taskKind)
					&& assistantText.trim()
					&& (
						(!hadToolUse && looksLikePlanningOnly(assistantText))
						|| (hadToolUse && looksLikePartialCompletion(assistantText))
					)
					&& incompleteRetries < MAX_INCOMPLETE_RETRIES
				) {
					incompleteRetries++;
					messages.push({ role: 'assistant', content: assistantText });
					messages.push({ role: 'user', content: CONTINUE_USER_PROMPT });
					continue;
				}
				messages.push({ role: 'assistant', content: assistantText });
				callbacks.onStatus('');
				return;
			}

			hadToolUse = true;
			callbacks.onClearText?.();

			// Groq free models often allow only one tool call per round
			const calls = [...toolCalls.values()].slice(0, config.provider === 'groq' ? 1 : undefined);
			messages.push({
				role: 'assistant',
				content: assistantText || '',
				tool_calls: calls.map(c => ({
					id: c.id,
					type: 'function' as const,
					function: { name: c.name, arguments: c.args || '{}' },
				})),
			});

			for (const call of calls) {
				let args: Record<string, unknown> = {};
				try { args = JSON.parse(call.args || '{}'); } catch { /* empty */ }
				if (!call.name) {
					messages.push({
						role: 'tool',
						content: 'Tool call was incomplete — retry with valid tool arguments.',
						tool_call_id: call.id,
						name: call.name || 'unknown',
					});
					continue;
				}
				const toolName = normalizeToolName(call.name);
				if (isReadOnlyTask(taskKind) && WRITE_TOOL_NAMES.has(toolName)) {
					messages.push({
						role: 'tool',
						content: `Refused ${toolName}: read-only task — use list_dir/read_file/grep and explain in chat.`,
						tool_call_id: call.id,
						name: call.name,
					});
					continue;
				}
				if (isChatOnlyTask(taskKind, effectiveUserMessage) && toolName !== 'list_dir' && toolName !== 'read_file') {
					messages.push({
						role: 'tool',
						content: `Refused ${toolName}: this is a chat reply — answer the user in markdown with no tools.`,
						tool_call_id: call.id,
						name: call.name,
					});
					continue;
				}
				if (toolName === 'terminal' && isTerminalEchoCommand(String(args.command ?? args.cmd ?? ''))) {
					messages.push({
						role: 'tool',
						content: 'Refused: do not use terminal echo/printf to talk to the user. Reply in chat markdown.',
						tool_call_id: call.id,
						name: call.name,
					});
					continue;
				}
				callbacks.onToolStart(call.id, normalizeToolName(call.name), args);
				let meta: ToolResultMeta;
				try {
					meta = await executeTool(call.name, args, runCtx);
				} catch (err) {
					meta = { result: err instanceof Error ? err.message : String(err) };
				}
				callbacks.onToolEnd(call.id, normalizeToolName(call.name), args, meta);
				messages.push({
					role: 'tool',
					content: String(meta.result ?? ''),
					tool_call_id: call.id,
					name: call.name,
				});
			}
		} catch (err) {
			if (signal.aborted) return;
			throw err;
		}
	}

	if (hadToolUse && !signal.aborted) {
		messages.push({ role: 'user', content: SUMMARY_USER_PROMPT });
		try {
			callbacks.onClearText?.();
			const { assistantText } = await streamCompletion(messages, config, signal, callbacks, { emitText: true });
			if (assistantText.trim()) {
				messages.push({ role: 'assistant', content: assistantText });
			}
		} catch {
			/* best-effort summary */
		}
	}
	callbacks.onStatus('');
}
