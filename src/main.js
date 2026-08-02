/**
 * Copix CLI — same agent loop and tools as Copix Desktop (macOS/studio runAgent).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installNodeCopixApi } from './nodeApi.js';
import * as ui from './ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_SRC = path.resolve(__dirname, '../../macOS/studio/src');

function parseArgs(argv) {
	const opts = { workspace: process.cwd(), prompt: '', help: false, version: false };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') opts.help = true;
		else if (a === '-v' || a === '--version') opts.version = true;
		else if (a === '-p' || a === '--workspace') opts.workspace = path.resolve(argv[++i] || process.cwd());
		else rest.push(a);
	}
	opts.prompt = rest.join(' ').trim();
	return opts;
}

async function loadDesktopModules() {
	const api = installNodeCopixApi();
	const [{ runAgent }, { resolveModelConfig }] = await Promise.all([
		import(pathToFileURL(path.join(STUDIO_SRC, 'models/router.ts')).href),
		import(pathToFileURL(path.join(STUDIO_SRC, 'models/config.ts')).href),
	]);
	return { api, runAgent, resolveModelConfig };
}

function makeCallbacks() {
	let thinking = false;
	return {
		onText: (chunk) => {
			if (thinking) {
				thinking = false;
			}
			ui.writeAssistantDelta(chunk);
		},
		onThinkingStart: () => {
			thinking = true;
		},
		onThinkingChunk: (chunk) => {
			ui.writeStatus(chunk);
		},
		onThinkingEnd: () => {
			thinking = false;
		},
		onToolStart: (_id, tool, args) => {
			ui.writeToolCall(tool, args || {});
		},
		onToolEnd: (_id, tool, _args, meta) => {
			const ok = meta?.ok !== false && !meta?.error;
			ui.writeToolResult(tool, ok, meta?.result ?? meta?.error ?? '');
		},
		onStatus: (msg) => {
			ui.writeStatus(msg);
		},
		onClearText: () => undefined,
		onStructuredResponse: () => undefined,
	};
}

function modelLabel(settings) {
	const id = settings?.model?.modelId || 'qwen2.5:3b';
	const provider = settings?.model?.provider || 'ollama';
	return `${provider}/${id}`;
}

async function runOne({
	prompt,
	workspaceRoot,
	history,
	runAgent,
	resolveModelConfig,
	api,
	settings,
	installedModels,
}) {
	const config = resolveModelConfig(
		settings.model,
		settings.agentMode || 'code',
		installedModels,
		prompt,
	);
	ui.writeModelLine(config.model, config.provider === 'ollama' ? 'local' : config.provider);

	const sessionId = `cli-${Date.now()}`;
	let root = workspaceRoot;
	const ac = new AbortController();
	const onSig = () => ac.abort();
	process.on('SIGINT', onSig);

	ui.beginAssistant();
	try {
		await runAgent(
			prompt,
			config,
			{
				sessionId,
				workspaceRoot: root,
				onWorkspaceChange: (next) => { root = next; },
				onSpawnSubagent: async (childPrompt, label) => {
					ui.writeStatus(`subagent ${label || ''}…`);
					const childId = `cli-sub-${Date.now()}`;
					await runAgent(
						childPrompt,
						config,
						{ sessionId: childId, workspaceRoot: root, isSubagent: true },
						[],
						ac.signal,
						makeCallbacks(),
						{ mode: settings.agentMode || 'code' },
					);
					return { sessionId: childId };
				},
			},
			history,
			ac.signal,
			makeCallbacks(),
			{ mode: settings.agentMode || 'code' },
		);
		history.push({ role: 'user', content: prompt });
		return root;
	} finally {
		ui.endAssistantStream();
		process.off('SIGINT', onSig);
	}
}

async function installedTags(api) {
	try {
		const status = await api.getServerStatus();
		return Array.isArray(status?.models) ? status.models : [];
	} catch {
		return [];
	}
}

async function repl(deps) {
	const { api, runAgent, resolveModelConfig } = deps;
	let workspaceRoot = deps.workspaceRoot;
	const settings = await api.getSettings();
	const status = await api.getServerStatus();
	const history = [];
	const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

	ui.printBanner({
		version: pkg.version,
		model: modelLabel(settings),
		workspace: workspaceRoot,
		ollamaOk: Boolean(status?.online),
		installedCount: Array.isArray(status?.models) ? status.models.length : 0,
	});
	console.log(`${ui.color.dim}Type a message, or /help for commands.${ui.color.reset}\n`);

	const rl = readline.createInterface({ input, output, terminal: true });
	try {
		while (true) {
			let line;
			try {
				line = (await rl.question(ui.promptLabel())).trim();
			} catch {
				break;
			}
			if (!line) continue;
			if (line === '/exit' || line === '/quit' || line === 'exit') break;
			if (line === '/help' || line === '/?') {
				console.log(ui.helpText());
				continue;
			}
			if (line === '/cwd') {
				console.log(`${ui.color.cyan}workspace${ui.color.reset}  ${workspaceRoot}\n`);
				continue;
			}
			if (line === '/clear') {
				history.length = 0;
				console.log(`${ui.color.dim}Conversation cleared.${ui.color.reset}\n`);
				continue;
			}
			if (line === '/model' || line === '/models') {
				console.log(ui.modelListText(modelLabel(settings), await installedTags(api)));
				continue;
			}
			if (line.startsWith('/')) {
				console.log(`${ui.color.yellow}Unknown command: ${line}${ui.color.reset}`);
				console.log(`${ui.color.dim}Try /help${ui.color.reset}\n`);
				continue;
			}

			ui.beginUser(line);
			try {
				workspaceRoot = await runOne({
					prompt: line,
					workspaceRoot,
					history,
					runAgent,
					resolveModelConfig,
					api,
					settings,
					installedModels: await installedTags(api),
				});
			} catch (err) {
				ui.writeError(err instanceof Error ? err.message : String(err));
			}
			console.log('');
		}
	} finally {
		rl.close();
	}
}

export async function main(argv) {
	const opts = parseArgs(argv);
	if (opts.help) {
		console.log(ui.helpText());
		return;
	}
	if (opts.version) {
		const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		console.log(`copix ${pkg.version}`);
		return;
	}

	if (!fs.existsSync(path.join(STUDIO_SRC, 'models/router.ts'))) {
		throw new Error(
			`Desktop agent sources missing at ${STUDIO_SRC}. Re-run: curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash`,
		);
	}

	const deps = await loadDesktopModules();
	const workspaceRoot = fs.existsSync(opts.workspace) ? path.resolve(opts.workspace) : process.cwd();
	const settings = await deps.api.getSettings();
	const status = await deps.api.getServerStatus();
	const installedModels = Array.isArray(status?.models) ? status.models : [];
	const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

	if (opts.prompt) {
		ui.printBanner({
			version: pkg.version,
			model: modelLabel(settings),
			workspace: workspaceRoot,
			ollamaOk: Boolean(status?.online),
			installedCount: installedModels.length,
		});
		ui.beginUser(opts.prompt);
		await runOne({
			prompt: opts.prompt,
			workspaceRoot,
			history: [],
			runAgent: deps.runAgent,
			resolveModelConfig: deps.resolveModelConfig,
			api: deps.api,
			settings,
			installedModels,
		});
		return;
	}

	await repl({ ...deps, workspaceRoot });
}
