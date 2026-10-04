/**
 * Copix CLI — standalone terminal agent (macOS + Windows).
 * Same tools as Copix Desktop; history syncs via ~/Copix/sessions.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installNodeCopixApi } from './nodeApi.js';
import * as ui from './ui.js';
import { readPrompt } from './input.js';
import { initialModelIndex, modelChoices, resolveModelChoice, selectOption } from './select.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = path.resolve(__dirname, '../agent');
const FALLBACK_MODEL = 'qwen2.5:3b';

function copixPaths() {
	const dir = path.join(os.homedir(), 'Copix');
	return {
		dir,
		settings: path.join(dir, 'settings.json'),
		sessions: path.join(dir, 'sessions.json'),
	};
}

function parseArgs(argv) {
	const opts = {
		workspace: process.cwd(),
		prompt: '',
		help: false,
		version: false,
		doctor: false,
	};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') opts.help = true;
		else if (a === '-v' || a === '--version') opts.version = true;
		else if (a === '--doctor' || a === 'doctor') opts.doctor = true;
		else if (a === '-p' || a === '--workspace') opts.workspace = path.resolve(argv[++i] || process.cwd());
		else rest.push(a);
	}
	opts.prompt = rest.join(' ').trim();
	return opts;
}

async function loadAgentModules() {
	const api = installNodeCopixApi();
	const [{ runAgent }, { resolveModelConfig }] = await Promise.all([
		import(pathToFileURL(path.join(AGENT_SRC, 'models/router.ts')).href),
		import(pathToFileURL(path.join(AGENT_SRC, 'models/config.ts')).href),
	]);
	return { api, runAgent, resolveModelConfig };
}

function makeCallbacks(state) {
	return {
		onText: (chunk) => {
			state.assistantText += chunk;
			ui.writeAssistantDelta(chunk);
		},
		onThinkingStart: () => undefined,
		onThinkingChunk: (chunk) => {
			const text = String(chunk || '').trim();
			if (text) ui.writeStatus(text.replace(/^\(+|\)+$/g, ''));
		},
		onThinkingEnd: () => undefined,
		onToolStart: (_id, tool, args) => {
			if (/write_file|edit_file|append_file|create_project|delete_file/.test(tool)) {
				state.filesEdited += 1;
			}
			ui.writeToolCall(tool, args || {});
		},
		onToolEnd: (_id, tool, _args, meta) => {
			const ok = meta?.ok !== false && !meta?.error;
			const preview = String(meta?.result ?? meta?.error ?? '');
			// Keep web tool previews short in the timeline
			const clip = /web_search|web_fetch/.test(tool)
				? preview.split('\n').slice(0, 6).join('\n')
				: preview;
			ui.writeToolResult(tool, ok, clip);
		},
		onStatus: (msg) => {
			ui.writeStatus(msg);
		},
		onClearText: () => {
			state.assistantText = '';
		},
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

// ---------------------------------------------------------------------------
// Shared session store (~/Copix/sessions.json) — same shape as Desktop.

function titleFromMessage(text) {
	const t = text.trim().replace(/\s+/g, ' ');
	return t.length > 36 ? `${t.slice(0, 36)}…` : t || 'New chat';
}

function newCliSession(workspaceRoot) {
	return {
		id: `agent-cli-${Date.now()}`,
		title: 'CLI session',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		origin: 'cli',
		pinned: false,
		archived: false,
		messages: [],
		tabs: [],
		workspaceRoot,
	};
}

async function persistSession(api, session) {
	try {
		const raw = await api.loadChatSessions();
		let all = [];
		try {
			all = raw ? JSON.parse(raw) : [];
		} catch {
			all = [];
		}
		const idx = all.findIndex((s) => s && s.id === session.id);
		if (idx >= 0) all[idx] = session;
		else all.unshift(session);
		await api.saveChatSessions(JSON.stringify(all, null, 1));
	} catch {
		// history sync is best-effort — never break the REPL over it
	}
}

function recordTurn(session, prompt, assistantText) {
	const now = Date.now();
	if (!session.messages.length) session.title = titleFromMessage(prompt);
	session.messages.push(
		{ id: `m-${now}-u`, role: 'user', content: prompt, timestamp: now },
		{ id: `m-${now}-a`, role: 'assistant', content: assistantText || '(no reply)', timestamp: now + 1 },
	);
	session.updatedAt = now;
}

// ---------------------------------------------------------------------------

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
	const state = { filesEdited: 0, assistantText: '' };
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
		history.push({ role: 'assistant', content: state.assistantText || '(no reply)' });
		return {
			workspaceRoot: root,
			filesEdited: state.filesEdited,
			model: config.model,
			assistantText: state.assistantText,
		};
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
			history.push({ role: 'assistant', content: state.assistantText || '(no reply)' });
			return {
				workspaceRoot: root,
				filesEdited: state.filesEdited,
				model: retryConfig.model,
				assistantText: state.assistantText,
			};
		}
		throw err;
	} finally {
		ui.endAssistantStream();
		process.off('SIGINT', onSig);
	}
}

function footerLines({ model, workspace, filesEdited }) {
	if (ui.isPlain()) {
		const files = filesEdited > 0
			? `, ${filesEdited} file${filesEdited === 1 ? '' : 's'} edited`
			: '';
		return [
			`Agent, ollama/${model}${files}`,
			`Commands: /help, /keys, /plain, /model. Workspace: ${workspace}`,
		];
	}
	const dot = ` ${ui.color.muted}·${ui.color.reset} `;
	const files = filesEdited > 0
		? `${dot}${ui.color.muted}${filesEdited} file${filesEdited === 1 ? '' : 's'} edited${ui.color.reset}`
		: '';
	return [
		`${ui.color.accent}◉${ui.color.reset} Agent${dot}${ui.color.muted}ollama/${model}${ui.color.reset}${files}`,
		`${ui.color.muted}/ commands  ·  ↑↓ history  ·  tab complete  ·  ${workspace}${ui.color.reset}`,
	];
}

function expandUserPath(raw) {
	let p = String(raw || '').trim();
	if (!p) return '';
	if (p === '~') return os.homedir();
	if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
	return path.resolve(p);
}

function timeAgo(ts) {
	const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function ok(msg) {
	if (ui.isPlain()) {
		console.log(`\n${msg}\n`);
		return;
	}
	console.log(`\n${ui.color.green}⬢${ui.color.reset} ${msg}\n`);
}

function info(msg) {
	if (ui.isPlain()) {
		console.log(`\n${msg}\n`);
		return;
	}
	console.log(`\n${ui.color.muted}${msg}${ui.color.reset}\n`);
}

function warn(msg) {
	if (ui.isPlain()) {
		console.log(`\nWarning: ${msg}\n`);
		return;
	}
	console.log(`\n${ui.color.yellow}⬢ ${msg}${ui.color.reset}\n`);
}

async function repl(deps) {
	const { api, runAgent, resolveModelConfig } = deps;
	let workspaceRoot = deps.workspaceRoot;
	let rawSettings = await api.getSettings();
	let settings = normalizeSettings(rawSettings);
	const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	let history = [];
	let lastModel = settings.model.modelId;
	let filesEdited = 0;
	let session = newCliSession(workspaceRoot);
	const promptHistory = [];

	async function persistSettings() {
		rawSettings = { ...rawSettings, model: { ...rawSettings.model, ...settings.model } };
		await api.setSettings(rawSettings);
	}

	async function printBannerNow() {
		const status = await api.getServerStatus().catch(() => ({ online: false, models: [] }));
		ui.printBanner({
			version: pkg.version,
			model: `${settings.model.selection === 'auto' ? 'auto · ' : ''}${modelLabel(settings)}`,
			workspace: workspaceRoot,
			ollamaOk: Boolean(status?.online),
			installedCount: Array.isArray(status?.models) ? status.models.length : 0,
		});
	}

	function resetConversation() {
		history = [];
		filesEdited = 0;
		session = newCliSession(workspaceRoot);
	}

	async function applyModelChoice(choice) {
		const installed = await installedTags(api);
		const resolved = resolveModelChoice(choice, installed);
		if (resolved.selection === 'auto') {
			settings.model.selection = 'auto';
			await persistSettings();
			ok(`Model selection → auto ${ui.color.muted}(routes by task, prefers installed tags)${ui.color.reset}`);
			return;
		}
		settings.model.selection = 'manual';
		settings.model.modelId = resolved.modelId;
		await persistSettings();
		lastModel = resolved.modelId;
		if (resolved.missing) {
			warn(`Model set to ${resolved.modelId}, but it is not installed — run /pull ${resolved.modelId}`);
		} else {
			ok(`Model → ${resolved.modelId} ${ui.color.muted}(manual, saved to settings.json)${ui.color.reset}`);
		}
	}

	await printBannerNow();

	while (true) {
		const line = await readPrompt({
			footer: footerLines({ model: lastModel, workspace: workspaceRoot, filesEdited }),
			history: promptHistory,
		});
		if (line === null) break;
		if (!line) continue;
		if (promptHistory[promptHistory.length - 1] !== line) promptHistory.push(line);
		if (promptHistory.length > 100) promptHistory.shift();

		const [cmd, ...rest] = line.split(/\s+/);
		const arg = rest.join(' ').trim();

		if (cmd === '/exit' || cmd === '/quit' || line === 'exit') break;

		if (cmd === '/help' || cmd === '/?') {
			console.log(ui.helpText());
			continue;
		}

		if (cmd === '/keys') {
			console.log(ui.keysText());
			continue;
		}

		if (cmd === '/plain') {
			const mode = arg.toLowerCase();
			let next;
			if (!arg) next = !ui.isPlain();
			else if (mode === 'on') next = true;
			else if (mode === 'off') next = false;
			else {
				warn('Usage: /plain [on|off]');
				continue;
			}
			ui.setPlain(next);
			if (next) {
				console.log('\nPlain text is on. Colors, boxes, and decorative symbols stay off until you run /plain off.\n');
			} else {
				ok('Plain text is off.');
			}
			continue;
		}

		if (cmd === '/cwd' || cmd === '/workspace') {
			if (!arg) {
				info(`workspace · ${workspaceRoot}\nChange it with /cwd <path> (e.g. /cwd ~/sites)`);
				continue;
			}
			const next = expandUserPath(arg);
			if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) {
				warn(`Not a directory: ${next}`);
				continue;
			}
			workspaceRoot = next;
			session.workspaceRoot = next;
			rawSettings = { ...rawSettings, workspace: { ...(rawSettings.workspace || {}), homeDirectory: next } };
			await api.setSettings(rawSettings);
			ok(`Workspace → ${next} ${ui.color.muted}(saved as default in settings.json)${ui.color.reset}`);
			continue;
		}

		if (cmd === '/model') {
			if (!arg) {
				const installed = await installedTags(api);
				const items = modelChoices({
					installed,
					selection: settings.model.selection,
					modelId: settings.model.modelId,
				});
				const picked = await selectOption({
					label: 'Model',
					items,
					initialIndex: initialModelIndex(items, settings.model),
				});
				if (picked.item) await applyModelChoice(picked.item.value);
				else if (picked.reason === 'unavailable') {
					console.log(ui.modelListText(modelLabel(settings), installed));
					info('Switch with /model <tag> · back to routing with /model auto');
				} else if (picked.reason === 'invalid') {
					warn('No matching model. The current model was kept.');
				} else {
					info('Model unchanged.');
				}
				continue;
			}
			await applyModelChoice(arg);
			continue;
		}

		if (cmd === '/models') {
			console.log(ui.modelListText(modelLabel(settings), await installedTags(api)));
			continue;
		}

		if (cmd === '/pull') {
			if (!arg) {
				warn('Usage: /pull <tag> (e.g. /pull qwen2.5:3b)');
				continue;
			}
			info(`Pulling ${arg} — this can take a while…`);
			const res = await api.pullOllamaModel(arg).catch((e) => ({ ok: false, message: String(e?.message || e) }));
			if (res.ok) ok(`Pulled ${arg}`);
			else warn(`Pull failed: ${res.message}`);
			continue;
		}

		if (cmd === '/status') {
			const status = await api.getServerStatus().catch(() => ({ online: false, models: [] }));
			const models = Array.isArray(status?.models) ? status.models : [];
			info([
				`copix      ${pkg.version}`,
				`platform   ${process.platform}/${process.arch}`,
				`ollama     ${status?.online ? 'online' : 'offline'}`,
				`model      ${settings.model.selection === 'auto' ? 'auto · ' : ''}${modelLabel(settings)}`,
				`installed  ${models.length ? models.join(', ') : '(none)'}`,
				`workspace  ${workspaceRoot}`,
				`history    ${history.length / 2 | 0} turn${history.length === 2 ? '' : 's'} this session`,
				`settings   ${copixPaths().settings}`,
				`sessions   ${copixPaths().sessions}`,
			].join('\n'));
			continue;
		}

		if (cmd === '/doctor') {
			await runDoctor(api, pkg.version, workspaceRoot);
			continue;
		}

		if (cmd === '/history') {
			const raw = await api.loadChatSessions().catch(() => null);
			let all = [];
			try { all = raw ? JSON.parse(raw) : []; } catch { all = []; }
			if (!all.length) {
				info('No saved sessions yet.');
				continue;
			}
			const rows = all
				.filter((s) => s && Array.isArray(s.messages))
				.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
				.slice(0, 8)
				.map((s) => {
					const origin = s.origin === 'cli' ? 'cli' : 'desktop';
					const turns = Math.floor(s.messages.length / 2);
					return `${ui.color.accent}⬢${ui.color.reset} ${s.title || '(untitled)'}  ${ui.color.muted}· ${origin} · ${turns} turn${turns === 1 ? '' : 's'} · ${timeAgo(s.updatedAt ?? s.createdAt ?? Date.now())}${ui.color.reset}`;
				});
			console.log(`\n${rows.join('\n')}\n${ui.color.muted}Synced with Copix Desktop via ${copixPaths().sessions}${ui.color.reset}\n`);
			continue;
		}

		if (cmd === '/new') {
			resetConversation();
			ok('Started a fresh conversation.');
			continue;
		}

		if (cmd === '/clear') {
			resetConversation();
			process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // wipe screen + scrollback
			await printBannerNow();
			continue;
		}

		if (line.startsWith('/')) {
			warn(`Unknown command: ${cmd} — try /help`);
			continue;
		}

		console.log('');
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
			recordTurn(session, line, turn.assistantText);
			session.workspaceRoot = workspaceRoot;
			await persistSession(api, session);
		} catch (err) {
			ui.writeError(err instanceof Error ? err.message : String(err));
			recordTurn(session, line, `Error: ${err instanceof Error ? err.message : String(err)}`);
			await persistSession(api, session);
		}
		console.log('');
	}
}

async function runDoctor(api, version, workspaceRoot) {
	const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
	const agentOk = fs.existsSync(path.join(AGENT_SRC, 'models/router.ts'));
	const { settings: settingsPath, sessions: sessionsPath } = copixPaths();
	const status = await api.getServerStatus().catch(() => ({ online: false, models: [] }));
	const models = Array.isArray(status?.models) ? status.models : [];
	const rows = [
		`copix ${version} · ${process.platform}/${process.arch}`,
		`${nodeOk ? '✓' : '✗'} Node.js ${process.version} (need 18+)`,
		`${agentOk ? '✓' : '✗'} Standalone agent runtime`,
		`${status?.online ? '✓' : '✗'} Ollama ${status?.online ? 'online' : 'offline — install from https://ollama.com'}`,
		`${models.length ? '✓' : '✗'} Models ${models.length ? models.slice(0, 6).join(', ') : `(none — ollama pull ${FALLBACK_MODEL})`}`,
		`${fs.existsSync(settingsPath) ? '✓' : '·'} Settings ${settingsPath}`,
		`${fs.existsSync(sessionsPath) ? '✓' : '·'} Sessions ${sessionsPath}`,
		`✓ Workspace ${workspaceRoot}`,
		'',
		'No account required — Desktop and CLI are local-only.',
		'Reinstall: the command below',
	];
	console.log(`\n${ui.boxDoctor(rows)}\n${ui.cliInstallCommand()}\n`);
	if (!nodeOk || !agentOk || !status?.online || !models.length) {
		process.exitCode = 1;
	}
}

export async function main(argv) {
	const opts = parseArgs(argv);
	if (opts.help) {
		console.log(ui.helpText());
		return;
	}
	const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	if (opts.version) {
		console.log(`copix ${pkg.version}`);
		return;
	}

	if (!fs.existsSync(path.join(AGENT_SRC, 'models/router.ts'))) {
		throw new Error(`Standalone agent missing at ${AGENT_SRC}. Re-run: ${ui.cliInstallCommand()}`);
	}

	const deps = await loadAgentModules();
	const workspaceRoot = fs.existsSync(opts.workspace) ? path.resolve(opts.workspace) : process.cwd();

	if (opts.doctor) {
		await runDoctor(deps.api, pkg.version, workspaceRoot);
		return;
	}

	const settings = normalizeSettings(await deps.api.getSettings());
	const status = await deps.api.getServerStatus();
	const installedModels = Array.isArray(status?.models) ? status.models.map(String) : [];

	if (!status?.online) {
		warn('Ollama is offline. Install from https://ollama.com, then: ollama pull qwen2.5:3b');
	} else if (!installedModels.length) {
		warn(`No Ollama models yet. Run: ollama pull ${FALLBACK_MODEL}   or   /pull ${FALLBACK_MODEL}`);
	}

	if (opts.prompt) {
		ui.printBanner({
			version: pkg.version,
			model: modelLabel(settings),
			workspace: workspaceRoot,
			ollamaOk: Boolean(status?.online),
			installedCount: installedModels.length,
		});
		ui.beginUser(opts.prompt);
		const session = newCliSession(workspaceRoot);
		try {
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
			recordTurn(session, opts.prompt, turn.assistantText);
			session.workspaceRoot = turn.workspaceRoot;
			await persistSession(deps.api, session);
			ui.printFooter({
				model: `ollama/${turn.model}`,
				mode: 'Agent',
				filesEdited: turn.filesEdited,
				workspace: turn.workspaceRoot,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ui.writeError(message);
			recordTurn(session, opts.prompt, `Error: ${message}`);
			await persistSession(deps.api, session);
			process.exitCode = 1;
		}
		return;
	}

	await repl({ ...deps, workspaceRoot });
}
