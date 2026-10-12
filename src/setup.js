/**
 * First-run setup and the checks `copix doctor` reprints.
 * Questions take the default on Enter. A model download happens only when
 * someone answers yes to "Pull it now?" (`--yes` never downloads).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	loadOpenRouterKey,
	saveOpenRouterKey,
	settingsForDisk,
} from './keychain.js';
import { eightGbDefaults, recommendationLines, recommendModel } from './ollamaProfile.js';
import { cliInstallCommand, color, dataDirLabel, formatChecks, formatTips, isPlain, setAppearance } from './ui.js';

export const PROBE_MS = 1500;
export const PULL_STALL_MS = 20000;
export const OPENROUTER_DEFAULT_MODEL = '~anthropic/claude-sonnet-latest';

export const COLOR_CHOICES = [
	{ id: 'auto', label: 'auto' },
	{ id: 'light', label: 'light terminal' },
	{ id: 'dark', label: 'dark terminal' },
	{ id: 'plain', label: 'plain' },
];

export const PROVIDER_CHOICES = [
	{ id: 'ollama', label: 'Ollama' },
	{ id: 'openrouter', label: 'OpenRouter' },
];

export function shouldPrompt({ tty = false, yes = false, ci = false } = {}) {
	if (yes || !tty || ci) return false;
	return true;
}

function savedDisplay(settings) {
	const mode = settings?.display;
	if (mode === 'light' || mode === 'dark' || mode === 'plain' || mode === 'auto') return mode;
	return 'auto';
}

export function needsSetup(settings, { force = false } = {}) {
	if (force) return true;
	return settings?.firstRun !== false;
}

export function resolveNumberedChoice(answer, choices) {
	const raw = String(answer ?? '').trim().toLowerCase();
	if (!raw) return choices[0].id;
	const asNumber = Number(raw);
	if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= choices.length) {
		return choices[asNumber - 1].id;
	}
	const match = choices.find((choice) => choice.id === raw || choice.label.toLowerCase() === raw);
	return match ? match.id : choices[0].id;
}

/** Enter accepts the [Y/n] default. Anything other than yes does not download. */
export function pullAccepted(answer) {
	const raw = String(answer ?? '').trim();
	if (raw === '') return true;
	return /^y(es)?$/i.test(raw);
}

export function shouldPullModel({
	interactive,
	yes = false,
	answer,
	ollamaOnline,
	modelInstalled,
	provider,
}) {
	if (provider !== 'ollama' || !ollamaOnline || modelInstalled) return false;
	if (!interactive) return false;
	return pullAccepted(answer);
}

export function workspaceFix(platform = process.platform) {
	if (platform === 'win32') return 'mkdir %USERPROFILE%\\Copix';
	return 'mkdir -p ~/Copix';
}

export async function probeOllama(fetchImpl = globalThis.fetch, timeoutMs = PROBE_MS) {
	try {
		const res = await fetchImpl('http://127.0.0.1:11434/api/tags', {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res?.ok) return { online: false, models: [] };
		const data = await res.json();
		const models = Array.isArray(data?.models)
			? data.models.map((model) => String(model?.name || model?.model || '')).filter(Boolean)
			: [];
		return { online: true, models };
	} catch {
		return { online: false, models: [] };
	}
}

export async function collectChecks({
	fetchImpl,
	timeoutMs = PROBE_MS,
	workspaceExists,
	cliOnPath,
	totalMem = os.totalmem(),
	platform = process.platform,
	homeLabel = dataDirLabel(),
} = {}) {
	const ollama = fetchImpl
		? await probeOllama(fetchImpl, timeoutMs)
		: await probeOllama(globalThis.fetch, timeoutMs);
	const tag = recommendModel(totalMem).tag;
	const modelOk = ollama.online && ollama.models.length > 0;
	return [
		{
			id: 'ollama',
			ok: ollama.online,
			label: 'Ollama running',
			fix: ollama.online ? '' : 'ollama serve',
		},
		{
			id: 'model',
			ok: modelOk,
			label: 'a model installed',
			fix: modelOk ? '' : `ollama pull ${tag}`,
		},
		{
			id: 'workspace',
			ok: Boolean(workspaceExists),
			label: `workspace folder ${homeLabel}`,
			fix: workspaceExists ? '' : workspaceFix(platform),
		},
		{
			id: 'path',
			ok: Boolean(cliOnPath),
			label: 'CLI on PATH',
			fix: cliOnPath ? '' : cliInstallCommand(),
		},
	];
}

export function choiceBlock(number, title, choices) {
	const rows = choices.map((choice, index) => `   ${index + 1}  ${choice.label}`);
	return [`${number}) ${title}`, ...rows].join('\n');
}

function defaultPull(tag, onLine, stallMs = PULL_STALL_MS) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(stall);
			resolve(result);
		};
		let proc;
		try {
			proc = spawn('ollama', ['pull', tag], { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (err) {
			resolve({ ok: false, message: 'pull failed' });
			return;
		}
		let out = '';
		let stall;
		const bump = () => {
			clearTimeout(stall);
			stall = setTimeout(() => {
				proc.kill();
				done({ ok: false, message: 'pull timed out' });
			}, stallMs);
		};
		const take = (chunk) => {
			const text = String(chunk);
			out += text;
			bump();
			for (const line of text.split(/\r?\n/)) {
				if (line.trim()) onLine?.(line);
			}
		};
		bump();
		proc.stdout?.on('data', take);
		proc.stderr?.on('data', take);
		proc.on('error', () => done({ ok: false, message: 'ollama is not available' }));
		proc.on('close', (code) => {
			const failed = code !== 0 || /error|failed/i.test(out);
			done({ ok: !failed, message: failed ? 'pull failed' : 'pulled' });
		});
	});
}

function applyMemoryProfile(model, totalMem, provider) {
	const next = { ...model };
	if (provider !== 'ollama') return next;
	const fitted = eightGbDefaults(totalMem);
	if (!fitted) return next;
	next.modelId = fitted.tag;
	next.lowVram = true;
	return next;
}

/**
 * Run the wizard. `ask` / `askSecret` / `pull` are injected in tests.
 * Returned `disk` is safe to write. `session.model.apiKey` may hold the key in memory only.
 * `lines` is everything printed; it never contains the key.
 */
export async function runSetup({
	settings = {},
	tty = false,
	yes = false,
	plain = false,
	ci = false,
	totalMem = os.totalmem(),
	platform = process.platform,
	workspaceExists = false,
	cliOnPath = false,
	fetchImpl,
	ask,
	askSecret,
	pull = defaultPull,
	applyDisplay = setAppearance,
	keychain = {},
	write = console.log,
} = {}) {
	const interactive = shouldPrompt({ tty, yes, plain, ci });
	const lines = [];
	const log = (text) => {
		const value = String(text ?? '');
		lines.push(value);
		write(value);
	};

	let display = savedDisplay(settings);
	if (interactive) {
		log(choiceBlock(1, 'Colors', COLOR_CHOICES));
		const answer = await ask('Choice [1]: ');
		display = resolveNumberedChoice(answer, COLOR_CHOICES);
	}
	applyDisplay(display);

	let provider = 'ollama';
	let typedKey = '';
	let keyMessage = '';
	if (interactive) {
		log(choiceBlock(2, 'Provider', PROVIDER_CHOICES));
		const answer = await ask('Choice [1]: ');
		provider = resolveNumberedChoice(answer, PROVIDER_CHOICES);
		if (provider === 'openrouter') {
			typedKey = String(await askSecret('OpenRouter API key (hidden): ') || '');
		}
	} else {
		provider = settings?.model?.provider === 'openrouter' ? 'openrouter' : 'ollama';
	}

	const checks = await collectChecks({
		fetchImpl,
		workspaceExists,
		cliOnPath,
		totalMem,
		platform,
	});
	const checkPlain = Boolean(plain) || display === 'plain' || isPlain();
	log(['3) Setting up Copix', formatChecks(checks, { plain: checkPlain })].join('\n'));
	const recommended = recommendationLines(totalMem);
	log(recommended[0]);
	for (const extra of recommended.slice(1)) {
		log(checkPlain ? extra : `${color.hint}${extra}${color.reset}`);
	}

	const ollamaOnline = checks.some((check) => check.id === 'ollama' && check.ok);
	const modelInstalled = checks.some((check) => check.id === 'model' && check.ok);
	let answer;
	const willAskPull = interactive && provider === 'ollama' && ollamaOnline && !modelInstalled;
	if (willAskPull) {
		answer = await ask('Pull it now? [Y/n] ');
	}
	const doPull = shouldPullModel({
		interactive,
		yes,
		answer,
		ollamaOnline,
		modelInstalled,
		provider,
	});
	let pulled = false;
	if (doPull) {
		const tag = recommendModel(totalMem).tag;
		try {
			const result = await pull(tag, (line) => log(line));
			pulled = Boolean(result?.ok);
			if (!pulled) log('Pull did not finish. Run the command above when Ollama is up.');
		} catch {
			log('Pull did not finish. Run the command above when Ollama is up.');
		}
	}

	let sessionKey = '';
	if (provider === 'openrouter' && typedKey) {
		const saved = await saveOpenRouterKey(typedKey, keychain);
		if (saved.ok) sessionKey = typedKey;
		else if (saved.message) {
			keyMessage = saved.message;
			log(saved.message);
			const loaded = await loadOpenRouterKey(keychain);
			sessionKey = loaded.key || '';
		}
	} else if (provider === 'openrouter') {
		const loaded = await loadOpenRouterKey(keychain);
		sessionKey = loaded.key || String(settings?.model?.apiKey || '');
		if (loaded.message && !sessionKey) {
			keyMessage = loaded.message;
			log(loaded.message);
		}
	}

	log(['4) Tips', formatTips({ plain: checkPlain || isPlain() })].join('\n'));

	const previous = settings?.model && typeof settings.model === 'object' ? settings.model : {};
	// The pull hint in collectChecks uses this same tag.
	const fittedTag = recommendModel(totalMem).tag;
	let modelId = fittedTag;
	if (provider === 'openrouter') {
		const previousId = String(previous.modelId || '');
		modelId = (previousId.includes('/') || previousId.startsWith('~'))
			? previousId
			: OPENROUTER_DEFAULT_MODEL;
	}
	const sessionModel = applyMemoryProfile({
		...previous,
		provider,
		modelId,
		apiKey: sessionKey,
	}, totalMem, provider);
	const session = {
		...settings,
		firstRun: false,
		display,
		model: sessionModel,
	};
	const disk = settingsForDisk(session);
	return {
		disk,
		session,
		lines,
		pulled,
		display,
		provider,
		keyMessage,
		checks,
	};
}

export function readLine(prompt, { hidden = false, input = process.stdin, output = process.stdout } = {}) {
	output.write(prompt);
	if (!input?.isTTY || typeof input.setRawMode !== 'function') {
		return new Promise((resolve) => {
			let buf = '';
			const onData = (chunk) => {
				const text = String(chunk);
				const end = text.indexOf('\n');
				if (end === -1) {
					buf += text;
					return;
				}
				buf += text.slice(0, end);
				cleanup();
				resolve(buf.replace(/\r$/, ''));
			};
			const cleanup = () => {
				input.off?.('data', onData);
				input.pause?.();
			};
			input.resume?.();
			input.on?.('data', onData);
		});
	}
	return new Promise((resolve) => {
		const wasRaw = input.isRaw;
		const arm = () => input.setRawMode(true);
		arm();
		// Readline restores cooked mode when it closes. Re-apply raw mode
		// after that so a key typed on the next question cannot echo.
		const rearms = [0, 30].map((ms) => setTimeout(arm, ms));
		input.resume();
		let buf = '';
		const onData = (chunk) => {
			const text = String(chunk);
			for (const ch of text) {
				if (ch === '\r' || ch === '\n') {
					cleanup();
					output.write('\n');
					resolve(buf);
					return;
				}
				if (ch === '\u0003') {
					cleanup();
					output.write('\n');
					resolve('');
					return;
				}
				if (ch === '\u007f' || ch === '\b') {
					if (!hidden && buf) output.write('\b \b');
					buf = buf.slice(0, -1);
					continue;
				}
				if (ch >= ' ') {
					buf += ch;
					if (!hidden) output.write(ch);
				}
			}
		};
		const cleanup = () => {
			for (const timer of rearms) clearTimeout(timer);
			input.off?.('data', onData);
			if (input.isTTY) input.setRawMode(Boolean(wasRaw));
			input.pause?.();
		};
		input.on('data', onData);
	});
}

export function readHidden(prompt, input = process.stdin, output = process.stdout) {
	return readLine(prompt, { hidden: true, input, output });
}

export function doctorKeyLine(status, note) {
	const state = status === 'set' ? 'set' : 'not set';
	if (note) return `OpenRouter key: ${state}\n${note}`;
	return `OpenRouter key: ${state}`;
}

export { commandOnPath, keyStatusLabel, settingsForDisk } from './keychain.js';
