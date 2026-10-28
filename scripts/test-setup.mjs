import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { helpText, cliInstallCommand, displayWidth, formatCheckLine, formatChecks, formatTips, setAppearance, setPlain, stripAnsi, wrapColumns } from '../src/ui.js';
import { eightGbDefaults, fitInstalledModel, ramClass, recommendModel, recommendationLines, unloadOtherModels } from '../src/ollamaProfile.js';
import {
	KEYRING_MISSING,
	KEYRING_WRITE_FAILED,
	saveOpenRouterKey,
	settingsForDisk,
} from '../src/keychain.js';
import { mergeSettingsForDisk, migratePlaintextKey } from '../src/nodeApi.js';
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
	assert.ok(lines.some((line) => line === 'qwen2.5:14b needs 32 GB'));
	const fitted = eightGbDefaults(8 * GB);
	assert.equal(fitted.tag, 'qwen2.5:3b');
	assert.equal(fitted.quant, 'Q4_K_M');
	assert.equal(fitted.numCtx, 4096);
	assert.equal(fitted.keepAlive, '5m');
	assert.equal(fitted.singleModel, true);
	assert.equal(eightGbDefaults(16 * GB), null);
	assert.equal(ramClass(8 * GB), 8);
	assert.equal(ramClass(16 * GB), 16);
	const mid = eightGbDefaults(15 * GB);
	assert.equal(mid.tag, 'qwen2.5:3b');
	assert.equal(mid.numCtx, 4096);
	assert.equal(mid.keepAlive, '5m');
	assert.equal(mid.singleModel, true);
	assert.equal(ramClass(15 * GB), 8);
	assert.equal(recommendationLines(16 * GB)[0], 'Recommended for 16 GB: qwen2.5:7b (about 4.7 GB)');
});

test('a 15 GB machine is not offered a model that needs 16 GB', () => {
	const total = 15 * GB;
	const model = recommendModel(total);
	assert.equal(model.tag, 'qwen2.5:3b');
	assert.ok(model.ram <= 15);
	const lines = recommendationLines(total);
	assert.equal(lines[0], 'Recommended for 15 GB: qwen2.5:3b (about 2 GB)');
	assert.ok(lines.some((line) => line === 'qwen2.5:7b needs 16 GB'));
	assert.equal(lines.some((line) => line.startsWith('qwen2.5:7b (')), false);
	assert.equal(recommendModel(16 * GB).tag, 'qwen2.5:7b');
	assert.equal(recommendModel(16780574720).tag, 'qwen2.5:3b');
	assert.equal(ramClass(16780574720), 8);
	assert.equal(fitInstalledModel('qwen2.5:3b', ['qwen2.5-coder:7b'], 8 * GB), 'qwen2.5:3b');
	assert.equal(fitInstalledModel('qwen2.5-coder:7b', ['qwen2.5-coder:7b'], 15 * GB), 'qwen2.5:3b');
	assert.equal(fitInstalledModel('qwen2.5-coder:7b', ['qwen2.5:3b', 'qwen2.5-coder:7b'], 16 * GB), 'qwen2.5-coder:7b');
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
	}), false);
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
	assert.equal(shouldPrompt({ tty: true, plain: true }), true);
	assert.equal(shouldPullModel({
		interactive: true,
		answer: 'y',
		ollamaOnline: true,
		modelInstalled: false,
		provider: 'ollama',
	}), true);
	assert.equal(shouldPullModel({
		interactive: true,
		answer: '',
		ollamaOnline: true,
		modelInstalled: false,
		provider: 'ollama',
	}), true);
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
	assert.equal(result.disk.display, 'auto');
	assert.equal(result.disk.model.apiKey, '');
	const text = result.lines.join('\n');
	assert.match(text, /Ollama running: missing/);
	assert.match(text, /ollama serve/);
	assert.match(text, /ollama pull qwen2\.5:3b/);
	assert.match(text, /Recommended for 8 GB: qwen2\.5:3b \(about 2 GB\)/);
	assert.match(text, /type a request/);
	assert.match(text, /^4\) Tips$/m);
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

test('--yes never pulls, even when Ollama is up and the model is missing', async () => {
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
	assert.deepEqual(tags, []);
	assert.equal(result.pulled, false);
	assert.equal(result.disk.model.modelId, 'qwen2.5:3b');
	assert.equal(result.disk.model.lowVram, true);
	assert.equal(result.disk.model.apiKey, '');
});

test('interactive Enter selects the defaults and an explicit n skips the pull', async () => {
	const answers = ['', '', 'n'];
	let pulled = 0;
	const prevNo = process.env.NO_COLOR;
	const prevColor = process.env.COLORTERM;
	delete process.env.NO_COLOR;
	process.env.COLORTERM = 'truecolor';
	setPlain(false);
	setAppearance('auto');
	try {
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
		const text = result.lines.join('\n');
		assert.match(text, /^4\) Tips$/m);
		assert.match(text, /38;2;125;125;125mtype a request/);
	} finally {
		if (prevNo === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = prevNo;
		if (prevColor === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = prevColor;
		setAppearance('auto');
	}
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

test('a failed keychain save keeps an existing settings key', async () => {
	const result = await runSetup({
		settings: { model: { provider: 'openrouter', modelId: 'qwen2.5:3b', apiKey: SECRET } },
		tty: true,
		totalMem: 8 * GB,
		workspaceExists: true,
		cliOnPath: true,
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:3b' }] }) }),
		ask: async () => '2',
		askSecret: async () => SECRET,
		applyDisplay() {},
		write() {},
		keychain: {
			available: true,
			platform: 'linux',
			env: {},
			run: async () => ({ code: 1, out: '', err: '' }),
		},
	});
	const printed = result.lines.join('\n');
	assert.equal(printed.includes(SECRET), false);
	assert.match(printed, /system keychain/);
	assert.equal(result.disk.model.apiKey, SECRET);
	assert.equal(result.disk.keyStored, undefined);
	assert.equal(result.session.model.apiKey, SECRET);
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
	const refused = await saveOpenRouterKey(SECRET, {
		available: true,
		platform: 'linux',
		env: {},
		run: async () => ({ code: 1, out: '', err: '' }),
	});
	assert.equal(refused.ok, false);
	assert.equal(refused.stored, false);
	assert.equal(refused.message, KEYRING_WRITE_FAILED);
	assert.equal(refused.message.includes(SECRET), false);
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

test('the pull hint names the same tag setup saves', async () => {
	const totalMem = 15 * GB;
	const checks = await collectChecks({
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
		workspaceExists: true,
		cliOnPath: true,
		totalMem,
		platform: 'linux',
		homeLabel: '~/Copix',
	});
	const result = await runSetup({
		settings: { model: { provider: 'ollama', modelId: 'qwen2.5:7b', apiKey: '' } },
		tty: false,
		yes: false,
		totalMem,
		workspaceExists: true,
		cliOnPath: true,
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
		ask: async () => { throw new Error('prompted'); },
		applyDisplay() {},
		write() {},
	});
	assert.equal(checks[1].fix, 'ollama pull qwen2.5:3b');
	assert.equal(result.disk.model.modelId, 'qwen2.5:3b');
	assert.equal(result.disk.model.lowVram, true);
	assert.equal(checks[1].fix, `ollama pull ${result.disk.model.modelId}`);

	const sixteen = 16 * GB;
	const wideChecks = await collectChecks({
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
		workspaceExists: true,
		cliOnPath: true,
		totalMem: sixteen,
		platform: 'linux',
		homeLabel: '~/Copix',
	});
	const wide = await runSetup({
		settings: { model: { provider: 'ollama', modelId: 'qwen2.5:3b', apiKey: '' } },
		tty: false,
		yes: false,
		totalMem: sixteen,
		workspaceExists: true,
		cliOnPath: true,
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
		ask: async () => { throw new Error('prompted'); },
		applyDisplay() {},
		write() {},
	});
	assert.equal(wide.disk.model.modelId, 'qwen2.5:7b');
	assert.equal(wideChecks[1].fix, `ollama pull ${wide.disk.model.modelId}`);
});

test('keychain writes keep the secret out of the command arguments', async () => {
	for (const platform of ['darwin', 'linux', 'win32']) {
		const calls = [];
		const saved = await saveOpenRouterKey(SECRET, {
			available: true,
			platform,
			env: {},
			run: async (bin, args, opts = {}) => {
				calls.push({ bin, args: [...args], input: opts.input });
				return { code: 0, out: '', err: '' };
			},
		});
		assert.equal(saved.ok, true, platform);
		assert.equal(calls.length, 1, platform);
		const { args, input } = calls[0];
		assert.equal(args.some((arg) => String(arg).includes(SECRET)), false, platform);
		assert.equal(String(input || '').includes(SECRET), true, platform);
		if (platform === 'darwin') {
			assert.equal(args.at(-1), '-w');
			assert.equal(input, `${SECRET}\n${SECRET}\n`);
		}
	}
});

test('NO_COLOR on a TTY still asks and does not save plain mode', async () => {
	const prevNo = process.env.NO_COLOR;
	process.env.NO_COLOR = '1';
	setPlain(true);
	const prompts = [];
	try {
		const result = await runSetup({
			settings: {},
			tty: true,
			yes: false,
			plain: true,
			totalMem: 8 * GB,
			workspaceExists: true,
			cliOnPath: true,
			fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:3b' }] }) }),
			ask: async (prompt) => { prompts.push(prompt); return ''; },
			askSecret: async () => '',
			applyDisplay() {},
			write() {},
		});
		assert.equal(prompts.length, 2);
		assert.match(prompts[0], /Choice \[1\]:/);
		assert.equal(result.disk.display, 'auto');
		assert.equal(result.lines.join('\n').includes('\x1b'), false);
	} finally {
		if (prevNo === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = prevNo;
		setPlain(false);
	}
});

test('needs-more lines are dim and the recommended row has no needs note', async () => {
	const prevNo = process.env.NO_COLOR;
	const prevColor = process.env.COLORTERM;
	delete process.env.NO_COLOR;
	process.env.COLORTERM = 'truecolor';
	setPlain(false);
	try {
		const result = await runSetup({
			settings: {},
			tty: false,
			plain: false,
			totalMem: 8 * GB,
			workspaceExists: true,
			cliOnPath: true,
			fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
			applyDisplay() {},
			write() {},
		});
		const text = result.lines.join('\n');
		assert.match(text, /Recommended for 8 GB: qwen2\.5:3b \(about 2 GB\)/);
		assert.doesNotMatch(text, /Recommended for 8 GB:.*needs/);
		assert.match(text, /38;2;125;125;125mqwen2\.5:7b needs 16 GB/);
	} finally {
		if (prevNo === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = prevNo;
		if (prevColor === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = prevColor;
		setAppearance('auto');
	}
});

test('install command and offline warning stay within 80 columns', () => {
	const checks = [{ id: 'path', ok: false, label: 'CLI on PATH', fix: cliInstallCommand() }];
	for (const line of formatCheckLine(checks[0], { plain: true }).split('\n')) {
		assert.ok(displayWidth(line) <= 80, line);
	}
	const warning = wrapColumns(
		'Ollama is offline. Install it from https://ollama.com, run ollama pull qwen2.5:3b, then /doctor.',
		78,
	);
	for (const line of warning) assert.ok(displayWidth(line) <= 78, line);
	assert.ok(warning.length > 1);
});

test('an existing workspace folder is a passing check', async () => {
	const checks = await collectChecks({
		fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
		workspaceExists: true,
		cliOnPath: true,
		totalMem: 8 * GB,
		platform: 'linux',
		homeLabel: '~/Copix',
	});
	const workspace = checks.find((check) => check.id === 'workspace');
	assert.equal(workspace.ok, true);
	assert.equal(workspace.fix, '');
});

test('a plaintext settings key is moved to the keychain and deleted from the file', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copix-key-'));
	const settingsPath = path.join(dir, 'settings.json');
	fs.writeFileSync(settingsPath, `${JSON.stringify({
		model: { provider: 'openrouter', apiKey: SECRET, modelId: 'qwen2.5:3b' },
	}, null, 2)}\n`);
	let received = '';
	const migrated = await migratePlaintextKey(settingsPath, async (secret) => {
		received = secret;
		return { ok: true, stored: true, message: '' };
	});
	const disk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
	assert.equal(received, SECRET);
	assert.equal(disk.model.apiKey, '');
	assert.equal(migrated.key, SECRET);
	assert.equal(migrated.notice, '');
	assert.equal(migrated.stored, true);
	assert.equal(JSON.stringify(disk).includes(SECRET), false);
	fs.writeFileSync(settingsPath, `${JSON.stringify({
		model: { provider: 'openrouter', apiKey: SECRET, modelId: 'qwen2.5:3b' },
	}, null, 2)}\n`);
	const failed = await migratePlaintextKey(settingsPath, async () => ({ ok: false, message: KEYRING_MISSING }));
	const failedDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
	assert.equal(failed.key, SECRET);
	assert.equal(failed.stored, false);
	assert.equal(failed.notice, KEYRING_MISSING);
	assert.equal(failedDisk.model.apiKey, SECRET);
	assert.equal(JSON.stringify(failedDisk).includes(SECRET), true);
	const rewritten = mergeSettingsForDisk(failedDisk, {
		model: { provider: 'openrouter', apiKey: '', modelId: 'qwen2.5:3b' },
	});
	assert.equal(rewritten.model.apiKey, SECRET);
	assert.equal(rewritten.keyStored, undefined);
	const cleared = mergeSettingsForDisk(failedDisk, {
		keyStored: true,
		model: { provider: 'openrouter', apiKey: SECRET, modelId: 'qwen2.5:3b' },
	});
	assert.equal(cleared.model.apiKey, '');
	assert.equal(cleared.keyStored, undefined);
	assert.equal(JSON.stringify(cleared).includes(SECRET), false);
	const memoryOnly = mergeSettingsForDisk(
		{ model: { apiKey: '' } },
		{ model: { apiKey: SECRET } },
	);
	assert.equal(memoryOnly.model.apiKey, '');
});

test('hidden key entry stays raw if the terminal is restored late', async () => {
	const input = new EventEmitter();
	input.isTTY = true;
	input.isRaw = false;
	input.setRawMode = (on) => { input.isRaw = on; };
	input.resume = () => {};
	input.pause = () => {};
	const output = { text: '', write(chunk) { this.text += chunk; } };
	const pending = readHidden('OpenRouter API key (hidden): ', input, output);
	input.setRawMode(false);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(input.isRaw, true);
	input.emit('data', 'sekret\r');
	assert.equal(await pending, 'sekret');
	assert.equal(output.text.includes('sekret'), false);
});
