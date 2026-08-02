/**
 * Copix CLI — Cursor Agent–style REPL, same runAgent as Desktop.
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
const FALLBACK_MODEL = 'qwen2.5:3b';

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

function makeCallbacks(state) {
	let thinking = false;
	return {
		onText: (chunk) => {
			thinking = false;
			ui.writeAssistantDelta(chunk);
		},
		onThinkingStart: () => {
			thinking = true;
		},
		onThinkingChunk: (chunk) => {
			const text = String(chunk || '').trim();
			if (text) ui.writeStatus(text.replace(/^\(+|\)+$/g, ''));
		},
		onThinkingEnd: () => {
			thinking = false;
		},
		onToolStart: (_id, tool, args) => {
			if (/write_file|edit_file|append_file|create_project|delete_file/.test(tool)) {
				state.filesEdited += 1;
			}
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
	const id = settings?.model?.modelId || FALLBACK_MODEL;
	const provider = settings?.model?.provider || 'ollama';
	return `${provider}/${id}`;
}

function normalizeSettings(settings) {
	const raw = settings?.model && typeof settings.model === 'object' ? settings.model : {};
	let modelId = String(raw.modelId || FALLBACK_MODEL).replace(/^ollama\//, '') || FALLBACK_MODEL;
	if (/llama-3|gpt-|claude|gemini|mixtral|groq/i.test(modelId) || modelId.includes('/')) {
		modelId = FALLBACK_MODEL;
	}
	const model = {
		apiKey: '',
		selection: raw.selection === 'manual' ? 'manual' : 'auto',
		lowVram: Boolean(raw.lowVram),
		...raw,
		provider: 'ollama',
		modelId,
	};
	return {
		...settings,
		agentMode: settings?.agentMode || 'code',
		model,
	};
}

async function installedTags(api) {
	try {
		const status = await api.getServerStatus();
		return Array.isArray(status?.models) ? status.models.map(String) : [];
	} catch {
		return [];
	}
}

function pickInstalledFallback(installed) {
	if (!installed.length) return FALLBACK_MODEL;
	const exact = installed.find((m) => m === FALLBACK_MODEL || m.startsWith(`${FALLBACK_MODEL}`));
	if (exact) return FALLBACK_MODEL;
	const qwen = installed.find((m) => m.startsWith('qwen2.5:') || m.startsWith('qwen2.5-'));
	return qwen?.split(':').length ? qwen : installed[0];
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
	const state = { filesEdited: 0 };
	let config = resolveModelConfig(
		settings.model,
		settings.agentMode || 'code',
		installedModels,
		prompt,
	);

	// Hard safety: never call a model that is clearly not installed.
	if (
		installedModels.length > 0
		&& !installedModels.some((m) => m === config.model || m.startsWith(`${config.model}`) || m.startsWith(`${config.model.split(':')[0]}:`))
	) {
		config = { ...config, model: pickInstalledFallback(installedModels) };
	}

	ui.writeStep('Analyzed request');
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
					ui.writeToolCall('subagent', { name: label || 'child' });
					const childId = `cli-sub-${Date.now()}`;
					await runAgent(
						childPrompt,
						config,
						{ sessionId: childId, workspaceRoot: root, isSubagent: true },
						[],
						ac.signal,
						makeCallbacks(state),
						{ mode: settings.agentMode || 'code' },
					);
					return { sessionId: childId };
				},
			},
			history,
			ac.signal,
			makeCallbacks(state),
			{ mode: settings.agentMode || 'code' },
		);
		history.push({ role: 'user', content: prompt });
		return { workspaceRoot: root, filesEdited: state.filesEdited, model: config.model };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const missing = /404|not found|model_not_found/i.test(message);
		if (missing && config.model !== FALLBACK_MODEL) {
			ui.writeStep('Retrying', FALLBACK_MODEL);
			const retryConfig = { ...config, model: FALLBACK_MODEL };
			await runAgent(
				prompt,
				retryConfig,
				{
					sessionId: `cli-retry-${Date.now()}`,
					workspaceRoot: root,
					onWorkspaceChange: (next) => { root = next; },
				},
				history,
				ac.signal,
				makeCallbacks(state),
				{ mode: settings.agentMode || 'code' },
			);
			history.push({ role: 'user', content: prompt });
			return { workspaceRoot: root, filesEdited: state.filesEdited, model: retryConfig.model };
		}
		throw err;
	} finally {
		ui.endAssistantStream();
		process.off('SIGINT', onSig);
	}
}

async function repl(deps) {
	const { api, runAgent, resolveModelConfig } = deps;
	let workspaceRoot = deps.workspaceRoot;
	const settings = normalizeSettings(await api.getSettings());
	const status = await api.getServerStatus();
	const history = [];
	const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	let lastModel = settings.model.modelId;
	let filesEdited = 0;

	ui.printBanner({
		version: pkg.version,
		model: modelLabel(settings),
		workspace: workspaceRoot,
		ollamaOk: Boolean(status?.online),
		installedCount: Array.isArray(status?.models) ? status.models.length : 0,
	});

	const rl = readline.createInterface({ input, output, terminal: true });
	try {
		while (true) {
			ui.printFooter({
				model: `ollama/${lastModel}`,
				mode: 'Agent',
				filesEdited,
			});
			ui.printPromptHints();

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
				console.log(boxLine(`workspace ${DOT} ${workspaceRoot}`));
				continue;
			}
			if (line === '/clear') {
				history.length = 0;
				filesEdited = 0;
				ui.writeStep('Conversation cleared');
				console.log('');
				continue;
			}
			if (line === '/model' || line === '/models') {
				console.log(ui.modelListText(modelLabel(settings), await installedTags(api)));
				continue;
			}
			if (line.startsWith('/')) {
				ui.writeError(`Unknown command: ${line}\nTry /help`);
				continue;
			}

			ui.beginUser(line);
			try {
				const turn = await runOne({
					prompt: line,
					workspaceRoot,
					history,
					runAgent,
					resolveModelConfig,
					api,
					settings,
					installedModels: await installedTags(api),
				});
				workspaceRoot = turn.workspaceRoot;
				lastModel = turn.model;
				filesEdited += turn.filesEdited;
			} catch (err) {
				ui.writeError(err instanceof Error ? err.message : String(err));
			}
			console.log('');
		}
	} finally {
		rl.close();
	}
}

function boxLine(text) {
	return `\n${ui.color.muted}${text}${ui.color.reset}\n`;
}

const DOT = '·';

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
	const settings = normalizeSettings(await deps.api.getSettings());
	const status = await deps.api.getServerStatus();
	const installedModels = Array.isArray(status?.models) ? status.models.map(String) : [];
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
		const turn = await runOne({
			prompt: opts.prompt,
			workspaceRoot,
			history: [],
			runAgent: deps.runAgent,
			resolveModelConfig: deps.resolveModelConfig,
			api: deps.api,
			settings,
			installedModels,
		});
		ui.printFooter({
			model: `ollama/${turn.model}`,
			mode: 'Agent',
			filesEdited: turn.filesEdited,
		});
		return;
	}

	await repl({ ...deps, workspaceRoot });
}
