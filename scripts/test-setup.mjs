import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { helpText, formatChecks, formatTips, setAppearance, setPlain, stripAnsi } from '../src/ui.js';
import { eightGbDefaults, recommendationLines, unloadOtherModels } from '../src/ollamaProfile.js';
import {
	KEYRING_MISSING,
	saveOpenRouterKey,
	settingsForDisk,
} from '../src/keychain.js';
import {
	collectChecks,
	needsSetup,
	probeOllama,
	pullAccepted,
	readHidden,
	runSetup,
	shouldPrompt,
	shouldPullModel,
} from '../src/setup.js';

const GB = 1024 ** 3;
const SECRET = 'sk-or-v1-supersecretvalue';
const DECORATIVE = /[·→⬢✓✗▪▸▀▄█▌▐]/;

function hang(signal) {
	return new Promise((_resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('hung')), 10000);
		const onAbort = () => {
			clearTimeout(timer);
			const err = new Error('aborted');
			err.name = 'AbortError';
			reject(err);
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener('abort', onAbort, { once: true });
	});
}

test('8 GB recommendation names the quantized tag and marks larger models', () => {
	const lines = recommendationLines(8 * GB);
	assert.equal(lines[0], 'Recommended for 8 GB: qwen2.5:3b (about 2 GB)');
	assert.ok(lines.some((line) => line === 'qwen2.5:7b needs 16 GB'));
	assert.ok(lines.some((line) => line === 'qwen2.5:14b needs 16 GB'));
	const fitted = eightGbDefaults(8 * GB);
	assert.equal(fitted.tag, 'qwen2.5:3b');
	assert.equal(fitted.quant, 'Q4_K_M');
	assert.equal(fitted.numCtx, 4096);
	assert.equal(fitted.keepAlive, '5m');
	assert.equal(fitted.singleModel, true);
	assert.equal(eightGbDefaults(16 * GB), null);
	assert.match(recommendationLines(16 * GB)[0], /qwen2\.5:7b \(about 4\.7 GB\) — needs 16 GB/);
});

test('Enter takes the numbered default, and a pull needs yes', () => {
	assert.equal(pullAccepted(''), true);
	assert.equal(pullAccepted('Y'), true);
	assert.equal(pullAccepted('n'), false);
	assert.equal(pullAccepted('later'), false);
	assert.equal(shouldPullModel({
		interactive: false,
		yes: false,
		ollamaOnline: true,
		modelInstalled: false,
		provider: 'ollama',
	}), false);
	assert.equal(shouldPullModel({
		interactive: false,
		yes: true,
		ollamaOnline: true,
		modelInstalled: false,
		provider: 'ollama',
	}), true);
	assert.equal(shouldPullModel({
		interactive: false,
		yes: true,
		ollamaOnline: false,
		modelInstalled: false,
		provider: 'ollama',
	}), false);
	assert.equal(shouldPrompt({ tty: true }), true);
	assert.equal(shouldPrompt({ tty: false }), false);
	assert.equal(shouldPrompt({ tty: true, yes: true }), false);
	assert.equal(shouldPrompt({ tty: true, plain: true }), false);
	assert.equal(shouldPrompt({ tty: true, ci: true }), false);
	assert.equal(needsSetup({}), true);
	assert.equal(needsSetup({ firstRun: false }), false);
	assert.equal(needsSetup({ firstRun: false }, { force: true }), true);
});

test('offline probe and model unload finish without hanging', async () => {
	const started = Date.now();
	const status = await probeOllama((_url, opts) => hang(opts.signal), 200);
	assert.equal(status.online, false);
	await unloadOtherModels('qwen2.5:3b', (_url, opts) => hang(opts.signal), 200);
	assert.ok(Date.now() - started < 3000);
});

test('plain checks have no color or marks, colored checks use sage and clay', () => {
	const checks = [
		{ id: 'ollama', ok: true, label: 'Ollama running', fix: '' },
		{ id: 'model', ok: false, label: 'a model installed', fix: 'ollama pull qwen2.5:3b' },
	];
	setPlain(true);
	try {
		const plain = formatChecks(checks, { plain: true });
		assert.equal(plain.includes('\x1b'), false);
		assert.doesNotMatch(plain, DECORATIVE);
		assert.match(plain, /Ollama running: ok/);
		assert.match(plain, /a model installed: missing/);
		assert.match(plain, /ollama pull qwen2\.5:3b/);
		const tips = formatTips({ plain: true });
		assert.equal(tips.includes('\x1b'), false);
		assert.match(tips, /type a request/);
		assert.match(tips, /\/model to switch/);
		assert.match(tips, /\/help for everything/);
	} finally {
		setPlain(false);
	}

	const prev = process.env.COLORTERM;
	const prevNo = process.env.NO_COLOR;
	process.env.COLORTERM = 'truecolor';
	delete process.env.NO_COLOR;
	setPlain(false);
	setAppearance('auto');
	try {
		const colored = formatChecks(checks, { plain: false });
		assert.match(colored, /38;2;110;127;98m✓/);
		assert.match(colored, /38;2;196;101;74m✗/);
		assert.match(colored, /38;2;196;101;74mollama pull qwen2\.5:3b/);
		const tips = stripAnsi(formatTips({ plain: false }));
		assert.match(tips, /type a request/);
	} finally {
		if (prev === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = prev;
		if (prevNo === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = prevNo;
		setAppearance('auto');
		setPlain(false);
	}
});

test('non-TTY setup prints checks and does not pull or prompt', async () => {
	let asked = 0;
	let pulled = 0;
	const result = await runSetup({
		settings: { model: { provider: 'ollama', modelId: 'qwen2.5:3b', apiKey: '' } },
		tty: false,
		yes: false,
		plain: true,
		totalMem: 8 * GB,
		workspaceExists: false,
		cliOnPath: false,
		fetchImpl: () => hang(AbortSignal.timeout(200)),
		ask: async () => { asked += 1; return ''; },
		askSecret: async () => SECRET,
		pull: async () => { pulled += 1; return { ok: true }; },
		applyDisplay() {},
		write() {},
	});
	assert.equal(asked, 0);
	assert.equal(pulled, 0);
	assert.equal(result.disk.firstRun, false);
	assert.equal(result.disk.display, 'plain');
	assert.equal(result.disk.model.apiKey, '');
	const text = result.lines.join('\n');
	assert.match(text, /Ollama running: missing/);
	assert.match(text, /ollama serve/);
	assert.match(text, /ollama pull qwen2\.5:3b/);
	assert.match(text, /Recommended for 8 GB: qwen2\.5:3b \(about 2 GB\)/);
	assert.match(text, /type a request/);
	assert.equal(text.includes('\x1b'), false);
	assert.doesNotMatch(text, DECORATIVE);
	assert.equal(text.includes(SECRET), false);
});

test('offline --yes does not pull and still saves firstRun', async () => {
	let pulled = 0;
	const started = Date.now();
	const result = await runSetup({
		settings: {},
		tty: false,
		yes: true,
		totalMem: 8 * GB,
		workspaceExists: true,
		cliOnPath: true,
		fetchImpl: (_url, opts) => hang(opts.signal),
		ask: async () => { throw new Error('prompted'); },
		pull: async () => { pulled += 1; return { ok: true }; },
		applyDisplay() {},
		write() {},
	});
	assert.equal(pulled, 0);
	assert.equal(result.disk.firstRun, false);
	assert.match(result.lines.join('\n'), /ollama serve/);
	assert.ok(Date.now() - started < 4000);
});

test('--yes pulls only when Ollama is up and the model is missing', async () => {
	const tags = [];
	const result = await runSetup({
		settings: {},
		tty: false,
		yes: true,
		totalMem: 8 * GB,
		workspaceExists: true,
		cliOnPath: true,
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
		ask: async () => { throw new Error('prompted'); },
		pull: async (tag) => { tags.push(tag); return { ok: true }; },
		applyDisplay() {},
		write() {},
	});
	assert.deepEqual(tags, ['qwen2.5:3b']);
	assert.equal(result.pulled, true);
	assert.equal(result.disk.model.modelId, 'qwen2.5:3b');
	assert.equal(result.disk.model.lowVram, true);
	assert.equal(result.disk.model.apiKey, '');
});

test('interactive Enter selects the defaults and an explicit n skips the pull', async () => {
	const answers = ['', '', 'n'];
	let pulled = 0;
	const result = await runSetup({
		settings: {},
		tty: true,
		totalMem: 8 * GB,
		workspaceExists: true,
		cliOnPath: true,
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
		ask: async (prompt) => {
			assert.match(prompt, /Choice \[1\]:|Pull it now\? \[Y\/n\]/);
			return answers.shift();
		},
		askSecret: async () => SECRET,
		pull: async () => { pulled += 1; return { ok: true }; },
		applyDisplay() {},
		write() {},
	});
	assert.equal(pulled, 0);
	assert.equal(result.display, 'auto');
	assert.equal(result.provider, 'ollama');
	assert.equal(result.disk.model.apiKey, '');
});

test('OpenRouter key is hidden, stored via the keyring, and kept out of settings and logs', async () => {
	const result = await runSetup({
		settings: { model: { provider: 'ollama', modelId: 'qwen2.5:3b', apiKey: SECRET } },
		tty: true,
		totalMem: 16 * GB,
		workspaceExists: true,
		cliOnPath: true,
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:7b' }] }) }),
		ask: async () => '2',
		askSecret: async (prompt) => {
			assert.match(prompt, /hidden/);
			return SECRET;
		},
		pull: async () => { throw new Error(`pull saw ${SECRET}`); },
		applyDisplay() {},
		write() {},
		keychain: {
			available: true,
			platform: 'linux',
			env: {},
			run: async () => ({ code: 0, out: '', err: '' }),
		},
	});
	const printed = result.lines.join('\n');
	const stored = JSON.stringify(result.disk);
	assert.equal(printed.includes(SECRET), false);
	assert.equal(stored.includes(SECRET), false);
	assert.equal(result.disk.model.apiKey, '');
	assert.equal(result.session.model.apiKey, SECRET);
	assert.equal(result.provider, 'openrouter');
	assert.equal(settingsForDisk({ model: { apiKey: SECRET, modelId: 'x' } }).model.apiKey, '');
});

test('a missing keyring falls back to OPENROUTER_API_KEY without echoing the typed key', async () => {
	const result = await runSetup({
		settings: {},
		tty: true,
		totalMem: 8 * GB,
		workspaceExists: true,
		cliOnPath: true,
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:3b' }] }) }),
		ask: async () => '2',
		askSecret: async () => SECRET,
		applyDisplay() {},
		write() {},
		keychain: { available: false, platform: 'linux', env: {}, run: async () => ({ code: 127, out: '', err: '' }) },
	});
	const printed = result.lines.join('\n');
	assert.match(printed, /OPENROUTER_API_KEY/);
	assert.equal(printed.includes(SECRET), false);
	assert.equal(result.disk.model.apiKey, '');
	assert.equal(result.session.model.apiKey, '');
	const saved = await saveOpenRouterKey(SECRET, { available: false, env: {} });
	assert.equal(saved.ok, false);
	assert.equal(saved.message, KEYRING_MISSING);
	assert.equal(saved.message.includes(SECRET), false);
});

test('hidden key entry does not echo characters', async () => {
	const input = new EventEmitter();
	input.isTTY = true;
	input.isRaw = false;
	input.setRawMode = () => {};
	input.resume = () => {};
	input.pause = () => {};
	const output = { text: '', write(chunk) { this.text += chunk; } };
	const pending = readHidden('OpenRouter API key (hidden): ', input, output);
	input.emit('data', 'sek');
	input.emit('data', 'ret\n');
	assert.equal(await pending, 'sekret');
	assert.equal(output.text, 'OpenRouter API key (hidden): \n');
	assert.equal(output.text.includes('sekret'), false);
});

test('help lists copix doctor and copix setup', () => {
	setPlain(false);
	const help = stripAnsi(helpText());
	assert.match(help, /copix doctor\s+rerun the setup checks/);
	assert.match(help, /copix setup\s+run first-run setup again/);
	assert.match(help, /\/doctor\s+rerun the setup checks/);
});

test('collectChecks reports the four setup rows', async () => {
	const checks = await collectChecks({
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
		workspaceExists: false,
		cliOnPath: false,
		totalMem: 8 * GB,
		platform: 'linux',
		homeLabel: '~/Copix',
	});
	assert.deepEqual(checks.map((check) => check.id), ['ollama', 'model', 'workspace', 'path']);
	assert.equal(checks[0].ok, true);
	assert.equal(checks[1].ok, false);
	assert.equal(checks[1].fix, 'ollama pull qwen2.5:3b');
	assert.equal(checks[2].fix, 'mkdir -p ~/Copix');
	assert.match(checks[3].fix, /install\.sh/);
});
