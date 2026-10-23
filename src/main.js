/**
 * Copix CLI — standalone terminal agent (macOS + Windows).
 * Same tools as Copix Desktop; history syncs via ~/Copix/sessions.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keyStatusLabel, loadOpenRouterKey } from './keychain.js';
import { fitInstalledModel } from './ollamaProfile.js';
import { installNodeCopixApi } from './nodeApi.js';
import * as ui from './ui.js';
import { copyText } from './clipboard.js';
import { applyUndo, snapshotFileEdit } from './edits.js';
import { parseSubmission, readPrompt, suggestCommands } from './input.js';
import { initialModelIndex, modelChoices, resolveModelChoice, selectOption } from './select.js';
import {
	collectChecks,
	commandOnPath,
	doctorKeyLine,
	needsSetup,
	readHidden,
	readLine,
	runSetup,
	shouldPrompt,
} from './setup.js';

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
		setup: false,
		yes: false,
	};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') opts.help = true;
		else if (a === '-v' || a === '--version') opts.version = true;
		else if (a === '--doctor' || a === 'doctor') opts.doctor = true;
		else if (a === 'setup') opts.setup = true;
		else if (a === '--yes' || a === '-y') opts.yes = true;
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

function makeCallbacks(state, extras = {}) {
	const undoStack = extras.undoStack || null;
	const workspace = extras.workspace || (() => '');
	let pending = null;
	return {
		onText: (chunk) => {
			state.assistantText += chunk;
			ui.writeAssistantDelta(chunk);
		},
		onThinkingStart: () => {
			ui.startThinking();
		},
		onThinkingChunk: (chunk) => {
			const text = String(chunk || '').trim();
			if (text) ui.writeStatus(text.replace(/^\(+|\)+$/g, ''));
		},
		onThinkingEnd: () => undefined,
		onToolStart: (_id, tool, args) => {
			pending = undoStack ? snapshotFileEdit(tool, args, workspace()) : null;
			if (/write_file|edit_file|append_file|create_project|delete_file/.test(tool)) {
				state.filesEdited += 1;
			}
			ui.writeToolCall(tool, args || {});
		},
		onToolEnd: (_id, tool, args, meta) => {
			if (pending && undoStack && !toolFailed(meta)) {
				undoStack.push(pending);
				if (undoStack.length > 20) undoStack.shift();
			}
			pending = null;
			const failed = toolFailed(meta);
			const preview = String(meta?.result ?? meta?.error ?? '');
			const clip = /web_search|web_fetch/.test(tool)
				? preview.split('\n').slice(0, 6).join('\n')
				: preview;
			ui.writeToolResult(tool, !failed, failed ? clip : '', {
				args: args || {},
				diff: failed ? null : meta?.diff,
			});
			ui.startThinking();
		},
		onStatus: (msg) => {
			ui.writeStatus(msg);
		},
		onClearText: () => {
			state.assistantText = '';
			ui.resetReplyStyle();
		},
		onStructuredResponse: () => undefined,
	};
}

function modelLabel(settings) {
	const id = settings?.model?.modelId || FALLBACK_MODEL;
	const provider = settings?.model?.provider === 'openrouter' ? 'openrouter' : 'ollama';
	return `${provider}/${id}`;
}

function labeledModel(settings, modelId) {
	const id = modelLabel({ model: { ...(settings?.model || {}), modelId: modelId || settings?.model?.modelId } });
	return settings?.model?.selection === 'manual' ? id : `auto · ${id}`;
}

function normalizeSettings(settings) {
	const raw = settings?.model && typeof settings.model === 'object' ? settings.model : {};
	const provider = raw.provider === 'openrouter' ? 'openrouter' : 'ollama';
	let modelId = String(raw.modelId || FALLBACK_MODEL).replace(/^ollama\//, '') || FALLBACK_MODEL;
	if (provider !== 'openrouter' && (/llama-3|gpt-|claude|gemini|mixtral|groq/i.test(modelId) || modelId.includes('/'))) {
		modelId = FALLBACK_MODEL;
	}
	const model = {
		apiKey: '',
		selection: raw.selection === 'manual' ? 'manual' : 'auto',
		lowVram: Boolean(raw.lowVram),
		...raw,
		provider,
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
	undoStack = null,
}) {
	const state = { filesEdited: 0, assistantText: '' };
	let config = resolveModelConfig(
		settings.model,
		settings.agentMode || 'code',
		installedModels,
		prompt,
	);

	// Auto stays on a tag that fits this machine. A missing recommendation is
	// left in place so the chat can ask for a pull instead of a larger model.
	if (
		config.provider === 'ollama'
		&& settings?.model?.selection !== 'manual'
		&& installedModels.length > 0
	) {
		const next = fitInstalledModel(config.model, installedModels);
		if (next !== config.model) config = { ...config, model: next };
	}

	ui.writeModelLine(config.model, config.provider === 'ollama' ? 'local' : config.provider);

	const sessionId = `cli-${Date.now()}`;
	let root = workspaceRoot;
	const ac = new AbortController();
	const onSig = () => ac.abort();
	process.on('SIGINT', onSig);
	const callbacksFor = () => makeCallbacks(state, { undoStack, workspace: () => root });

	ui.beginAssistant();
	ui.resetThinking();
	ui.startThinking();
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
						callbacksFor(),
						{ mode: settings.agentMode || 'code' },
					);
					return { sessionId: childId };
				},
			},
			history,
			ac.signal,
			callbacksFor(),
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
			ui.stopThinking();
			ui.writeStep('Retrying', FALLBACK_MODEL);
			ui.startThinking();
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
				callbacksFor(),
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
		ui.stopThinking();
		ui.endAssistantStream();
		process.off('SIGINT', onSig);
	}
}

function toolFailed(meta) {
	if (!meta || meta.ok === false || meta.error) return true;
	const result = String(meta.result ?? '').trim();
	return /^(?:error|failed|refused|could not|unknown tool)\b/i.test(result);
}

// Status line under the prompt. It is redrawn with the prompt (including on
// resize) instead of pinned with a scroll region, which fights streamed text
// and Windows Terminal. One-shot mode prints the same line once the reply ends.
function footerLines({ model, workspace, ollamaOk }) {
	return [ui.formatStatusLine({ model, workspace, ollamaOk })];
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
		console.log(`\n${ui.scrubPlain(msg)}\n`);
		return;
	}
	console.log(`\n${ui.color.sage}✓${ui.color.reset} ${msg}\n`);
}

function info(msg) {
	if (ui.isPlain()) {
		console.log(`\n${ui.scrubPlain(msg)}\n`);
		return;
	}
	console.log(`\n${ui.color.muted}${msg}${ui.color.reset}\n`);
}

function warn(msg) {
	if (ui.isPlain()) {
		const text = ui.wrapColumns(`Warning: ${msg}`, 80).join('\n');
		console.log(`\n${ui.scrubPlain(text)}\n`);
		return;
	}
	const wrapped = ui.wrapColumns(msg, 78);
	const painted = wrapped.map((line, index) => (
		index === 0
			? `${ui.color.clay}✗${ui.color.reset} ${line}`
			: `  ${line}`
	)).join('\n');
	console.log(`\n${painted}\n`);
}

async function repl(deps) {
	const { api, runAgent, resolveModelConfig } = deps;
	let workspaceRoot = deps.workspaceRoot;
	let rawSettings = deps.rawSettings || await api.getSettings();
	let settings = normalizeSettings(rawSettings);
	const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	let history = [];
	let lastModel = settings.model.modelId;
	let ollamaOk = deps.ollamaOk != null ? Boolean(deps.ollamaOk) : false;
	let session = newCliSession(workspaceRoot);
	const promptHistory = [];
	const undoStack = [];
	let lastReply = '';

	async function persistSettings() {
		rawSettings = { ...rawSettings, model: { ...rawSettings.model, ...settings.model } };
		await api.setSettings(rawSettings);
	}

	function activeModelLabel() {
		return labeledModel(settings, lastModel);
	}

	async function printBannerNow() {
		const status = await api.getServerStatus().catch(() => ({ online: false, models: [] }));
		ollamaOk = Boolean(status?.online);
		ui.printBanner({
			version: pkg.version,
			model: activeModelLabel(),
			workspace: workspaceRoot,
			ollamaOk,
		});
	}

	function resetConversation() {
		history = [];
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

	async function ask(promptText) {
		console.log('');
		try {
			const turn = await runOne({
				prompt: promptText,
				workspaceRoot,
				history,
				runAgent,
				resolveModelConfig,
				api,
				settings,
				installedModels: await installedTags(api),
				undoStack,
			});
			workspaceRoot = turn.workspaceRoot;
			lastModel = turn.model;
			if (String(turn.assistantText || '').trim()) lastReply = turn.assistantText;
			recordTurn(session, promptText, turn.assistantText);
			session.workspaceRoot = workspaceRoot;
			await persistSession(api, session);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ui.writeError(message);
			recordTurn(session, promptText, `Error: ${message}`);
			await persistSession(api, session);
		}
		console.log('');
	}

	if (!deps.skipBanner) await printBannerNow();

	while (true) {
		const line = await readPrompt({
			footer: footerLines({ model: activeModelLabel(), workspace: workspaceRoot, ollamaOk }),
			history: promptHistory,
		});
		if (line === null) break;
		const parsed = parseSubmission(line);
		if (parsed.kind === 'empty') continue;
		if (promptHistory[promptHistory.length - 1] !== parsed.text) promptHistory.push(parsed.text);
		if (promptHistory.length > 100) promptHistory.shift();
		if (parsed.kind === 'prompt') {
			await ask(parsed.text);
			continue;
		}

		const { cmd, arg } = parsed;

		if (cmd === '/exit' || cmd === '/quit') break;

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
			else warn(`Pull failed: ${res.message}. Run /doctor if Ollama is not running.`);
			continue;
		}

		if (cmd === '/status') {
			const status = await api.getServerStatus().catch(() => ({ online: false, models: [] }));
			const models = Array.isArray(status?.models) ? status.models : [];
			ollamaOk = Boolean(status?.online);
			const modelName = activeModelLabel();
			const turns = history.length / 2 | 0;
			console.log(ui.statusText([
				['version', pkg.version],
				['platform', `${process.platform}/${process.arch}`],
				['ollama', `${ui.toneMark(ollamaOk)} ${ollamaOk ? 'online' : 'offline'}`],
				['model', ui.isPlain() ? modelName : `${ui.color.bold}${ui.color.clay}${modelName}${ui.color.reset}`],
				['installed', models.length ? models.join(', ') : '(none)'],
				['workspace', ui.isPlain() ? workspaceRoot : `${ui.color.hint}${workspaceRoot}${ui.color.reset}`],
				['history', `${turns} turn${turns === 1 ? '' : 's'} this session`],
				['settings', copixPaths().settings],
				['sessions', copixPaths().sessions],
			]));
			continue;
		}

		if (cmd === '/doctor') {
			const result = await runDoctor(api, pkg.version, workspaceRoot);
			ollamaOk = Boolean(result?.online);
			continue;
		}

		if (cmd === '/context') {
			console.log(ui.contextText(ui.contextReport(history)));
			continue;
		}

		if (cmd === '/copy') {
			const copied = copyText(lastReply);
			if (copied.via === 'clipboard') ok('Copied the last reply.');
			else if (copied.via === 'file') info(`No clipboard tool found. Saved the last reply to ${copied.path}`);
			else info('No reply to copy yet.');
			continue;
		}

		if (cmd === '/undo') {
			const entry = undoStack.pop();
			if (!entry) {
				info('Nothing to undo yet. File edits from this session show up here.');
				continue;
			}
			if (entry.tooBig) {
				warn(`${entry.path} was too large to undo.`);
				continue;
			}
			try {
				const result = applyUndo(entry);
				const left = undoStack.length;
				const tail = left ? ` ${left} more edit${left === 1 ? '' : 's'} can be undone.` : '';
				if (result.missing) info(`Already gone: ${result.path}`);
				else if (result.action === 'removed') ok(`Removed ${result.path}.${tail}`);
				else ok(`Restored ${result.path}.${tail}`);
			} catch (err) {
				undoStack.push(entry);
				warn(`Could not undo ${entry.path}. ${err instanceof Error ? err.message : String(err)}`);
			}
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
					const when = timeAgo(s.updatedAt ?? s.createdAt ?? Date.now());
					return ui.historyLine(
						s.title || '(untitled)',
						`${origin} · ${turns} turn${turns === 1 ? '' : 's'} · ${when}`,
					);
				});
			const synced = `Synced with Copix Desktop via ${copixPaths().sessions}`;
			console.log(ui.isPlain()
				? `\n${rows.join('\n')}\n${ui.scrubPlain(synced)}\n`
				: `\n${rows.join('\n')}\n${ui.color.hint}${synced}${ui.color.reset}\n`);
			continue;
		}

		if (cmd === '/new') {
			resetConversation();
			ok('Started a fresh conversation.');
			continue;
		}

		if (cmd === '/clear') {
			resetConversation();
			if (!ui.isPlain()) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
			await printBannerNow();
			continue;
		}

		console.log(`\n${ui.formatTypoHint(cmd, suggestCommands(cmd))}\n`);
	}
}

function askLine(prompt) {
	return readLine(prompt);
}

async function hydrateKey(settings, api) {
	const fileKey = String(settings?.model?.apiKey || '');
	const notice = String(settings?.keyNotice || '');
	if (notice) console.log(notice);
	const loaded = await loadOpenRouterKey();
	const keychainHasIt = loaded?.source === 'keychain' && Boolean(String(loaded.key || '').trim());
	if (fileKey && keychainHasIt) {
		const { keyNotice, ...rest } = settings;
		await api.setSettings({ ...rest, keyStored: true, model: { ...settings.model, apiKey: '' } });
	}
	if (loaded.message && settings?.model?.provider === 'openrouter' && !fileKey) {
		console.log(loaded.message);
	}
	const key = loaded.key || fileKey;
	const { keyNotice, ...clean } = settings || {};
	return {
		...clean,
		model: { ...(settings.model || {}), apiKey: key },
	};
}

async function runDoctor(api, version, workspaceRoot) {
	const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
	const agentOk = fs.existsSync(path.join(AGENT_SRC, 'models/router.ts'));
	const { settings: settingsPath, sessions: sessionsPath } = copixPaths();
	const checks = await collectChecks({
		workspaceExists: fs.existsSync(path.join(os.homedir(), 'Copix')),
		cliOnPath: commandOnPath('copix'),
	});
	const ollamaOnline = checks.some((check) => check.id === 'ollama' && check.ok);
	const modelOk = checks.some((check) => check.id === 'model' && check.ok);
	const loaded = await loadOpenRouterKey();
	const yes = ui.toneMark(true);
	const no = ui.toneMark(false);
	const pending = ui.toneMark(null);
	const rows = [
		`copix ${version} · ${process.platform}/${process.arch}`,
		`${nodeOk ? yes : no} Node.js ${process.version} (need 18+)`,
		`${agentOk ? yes : no} Standalone agent runtime`,
		`${fs.existsSync(settingsPath) ? yes : pending} Settings ${settingsPath}`,
		`${fs.existsSync(sessionsPath) ? yes : pending} Sessions ${sessionsPath}`,
		`${yes} Workspace ${workspaceRoot}`,
		'',
		'No account required — Desktop and CLI are local-only.',
		'Reinstall: the command below',
	];
	console.log(`\n${ui.formatChecks(checks)}\n${doctorKeyLine(keyStatusLabel(loaded.key), loaded.keyring ? '' : loaded.message)}\n`);
	console.log(`${ui.boxDoctor(rows)}\n${ui.wrapColumns(ui.cliInstallCommand(), 80).join('\n')}\n`);
	if (!nodeOk || !agentOk || !ollamaOnline || !modelOk) {
		process.exitCode = 1;
	}
	return { online: ollamaOnline };
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

	let rawSettings = await hydrateKey(await deps.api.getSettings(), deps.api);
	const workspaceExists = fs.existsSync(path.join(os.homedir(), 'Copix'));
	if (rawSettings.display) ui.setAppearance(rawSettings.display);
	let settings = normalizeSettings(rawSettings);
	const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const interactive = shouldPrompt({
		tty,
		yes: opts.yes,
		plain: ui.isPlain(),
		ci: Boolean(process.env.CI),
	});
	const runWizard = needsSetup(rawSettings, { force: opts.setup });
	let setupOllamaOk;

	if (runWizard) {
		const preview = await deps.api.getServerStatus().catch(() => ({ online: false, models: [] }));
		ui.printBanner({
			version: pkg.version,
			model: modelLabel(settings),
			workspace: workspaceRoot,
			ollamaOk: Boolean(preview?.online),
		});
		const result = await runSetup({
			settings: rawSettings,
			tty,
			yes: opts.yes,
			plain: ui.isPlain(),
			ci: Boolean(process.env.CI),
			workspaceExists,
			cliOnPath: commandOnPath('copix'),
			ask: askLine,
			askSecret: (prompt) => readHidden(prompt),
			applyDisplay: (mode) => ui.setAppearance(mode),
		});
		rawSettings = result.session;
		settings = normalizeSettings(rawSettings);
		setupOllamaOk = result.checks.some((check) => check.id === 'ollama' && check.ok);
		await deps.api.setSettings(result.disk);
	}

	const status = await deps.api.getServerStatus().catch(() => ({ online: false, models: [] }));
	const installedModels = Array.isArray(status?.models) ? status.models.map(String) : [];

	if (!runWizard) {
		if (!status?.online) {
			warn('Ollama is offline. Install it from https://ollama.com, run ollama pull qwen2.5:3b, then /doctor.');
		} else if (!installedModels.length) {
			warn(`No Ollama models yet. Run /pull ${FALLBACK_MODEL}.`);
		}
	}

	if (opts.prompt) {
		if (!runWizard) {
			ui.printBanner({
				version: pkg.version,
				model: modelLabel(settings),
				workspace: workspaceRoot,
				ollamaOk: Boolean(status?.online),
			});
		}
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
				model: labeledModel(settings, turn.model),
				workspace: turn.workspaceRoot,
				ollamaOk: setupOllamaOk != null ? setupOllamaOk : Boolean(status?.online),
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

	if (runWizard && !interactive) return;

	await repl({
		...deps,
		workspaceRoot,
		rawSettings,
		skipBanner: runWizard,
		ollamaOk: setupOllamaOk,
	});
}
