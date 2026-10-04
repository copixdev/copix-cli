import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SLASH_COMMANDS } from '../src/input.js';
import {
	initialModelIndex,
	matchChoice,
	modelChoices,
	pickerWindow,
	renderPickerLines,
	resolveModelChoice,
	selectOption,
	SUGGESTED_MODELS,
} from '../src/select.js';
import { helpText, isPlain, keysText, printBanner, setPlain } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ESC = '\x1b[';

function stripAnsi(s) {
	return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** Apply cursor movement and line clears so a test can see what is left on screen. */
function visibleScreen(input) {
	const lines = [''];
	let row = 0;
	let col = 0;
	const ensure = (r) => {
		while (lines.length <= r) lines.push('');
	};
	for (let i = 0; i < input.length; i++) {
		if (input[i] === '\x1b' && input[i + 1] === '[') {
			const match = input.slice(i).match(/^\x1b\[(\?)?([0-9;]*)([A-Za-z])/);
			if (!match) {
				i += 1;
				continue;
			}
			i += match[0].length - 1;
			const args = match[2] ? match[2].split(';').map((n) => Number(n) || 0) : [];
			const cmd = match[3];
			if (match[1]) continue;
			if (cmd === 'A') row = Math.max(0, row - (args[0] || 1));
			else if (cmd === 'B') {
				row += args[0] || 1;
				ensure(row);
			} else if (cmd === 'C') col += args[0] || 1;
			else if (cmd === 'D') col = Math.max(0, col - (args[0] || 1));
			else if (cmd === 'K') {
				ensure(row);
				const mode = args[0] ?? 0;
				if (mode === 2) lines[row] = '';
				else lines[row] = [...lines[row]].slice(0, col).join('');
			} else if (cmd === 'H') {
				row = Math.max(0, (args[0] || 1) - 1);
				col = Math.max(0, (args[1] || 1) - 1);
				ensure(row);
			}
			continue;
		}
		const ch = input[i];
		if (ch === '\r') {
			col = 0;
			continue;
		}
		if (ch === '\n') {
			row += 1;
			col = 0;
			ensure(row);
			continue;
		}
		if (ch < ' ') continue;
		ensure(row);
		const chars = [...lines[row]];
		while (chars.length < col) chars.push(' ');
		chars[col] = ch;
		lines[row] = chars.join('');
		col += 1;
	}
	return lines.map((line) => line.replace(/\s+$/g, '')).join('\n');
}

function captureLog(fn) {
	const lines = [];
	const orig = console.log;
	console.log = (...args) => lines.push(args.join(' '));
	try {
		fn();
	} finally {
		console.log = orig;
	}
	return lines;
}

test('help lists every slash command, including the accessibility commands', () => {
	setPlain(false);
	const help = stripAnsi(helpText());
	for (const command of SLASH_COMMANDS) {
		const escaped = command.cmd.replace('/', '\\/');
		assert.match(help, new RegExp(`${escaped}(?![A-Za-z0-9])`), command.cmd);
	}
	assert.match(help, /\/keys\s+keyboard shortcuts/);
	assert.match(help, /\/plain \[on\|off\]\s+screen-reader text/);
	assert.match(help, /pick a model/);
	const keys = stripAnsi(keysText());
	assert.match(keys, /Model picker/);
	assert.match(keys, /Tab/);
	assert.match(keys, /\/plain/);
	assert.match(keys, /NO_COLOR/);
});

test('plain mode drops color and boxes without changing the default banner', () => {
	setPlain(false);
	assert.equal(isPlain(), false);
	const fancy = captureLog(() => {
		printBanner({
			version: '1.7.2',
			model: 'auto · ollama/qwen2.5:3b',
			workspace: '/tmp',
			ollamaOk: true,
			installedCount: 2,
		});
	}).join('\n');
	assert.match(fancy, /\x1b\[1mCopix/);
	assert.match(stripAnsi(fancy), /⬢ ollama ready/);
	assert.match(fancy, /◉/);

	setPlain(true);
	try {
		const plain = captureLog(() => {
			printBanner({
				version: '1.7.2',
				model: 'auto · ollama/qwen2.5:3b',
				workspace: '/tmp',
				ollamaOk: true,
				installedCount: 2,
			});
		}).join('\n');
		assert.equal(plain.includes('\x1b'), false);
		assert.equal(/[╭╮╰╯│⬢◉]/.test(plain), false);
		assert.match(plain, /Copix agent cli 1\.7\.2/);
		assert.match(plain, /Ollama: ready \(2 models\)/);
		const help = helpText();
		assert.equal(help.includes('\x1b'), false);
		assert.match(help, /\/keys/);
		assert.match(help, /\/plain/);
	} finally {
		setPlain(false);
	}
});

test('model choices put auto first and keep the current tag selectable', () => {
	const installed = ['qwen2.5:3b', 'llama3:8b'];
	const items = modelChoices({ installed, selection: 'manual', modelId: 'ollama/llama3:8b' });
	assert.equal(items[0].value, 'auto');
	assert.equal(items[1].value, 'qwen2.5:3b');
	assert.equal(items[2].value, 'llama3:8b');
	assert.match(items[2].hint, /current/);
	assert.equal(items.some((item) => item.value === 'qwen2.5:3b' && item.hint === 'installed'), true);
	for (const tag of SUGGESTED_MODELS) {
		if (tag === 'qwen2.5:3b') continue;
		assert.equal(items.some((item) => item.value === tag && /not installed/.test(item.hint)), true);
	}
	assert.equal(initialModelIndex(items, { selection: 'manual', modelId: 'llama3:8b' }), 2);
	assert.equal(initialModelIndex(items, { selection: 'auto', modelId: 'llama3:8b' }), 0);

	const custom = modelChoices({ installed, selection: 'manual', modelId: 'custom:9b' });
	assert.equal(custom.at(-1).value, 'custom:9b');
	assert.match(custom.at(-1).hint, /current/);
});

test('resolveModelChoice keeps auto and the existing installed-tag check', () => {
	assert.deepEqual(resolveModelChoice('auto', ['qwen2.5:3b']), {
		selection: 'auto',
		modelId: null,
		missing: false,
	});
	assert.equal(resolveModelChoice('qwen2.5:3b', []).missing, false);
	assert.equal(resolveModelChoice('missing:1', ['qwen2.5:3b']).missing, true);
	assert.equal(resolveModelChoice('qwen2.5:3b', ['qwen2.5:7b']).missing, false);
	assert.equal(resolveModelChoice('ollama/mistral:7b', ['mistral:7b']).modelId, 'mistral:7b');
});

test('plain answers match a number or a model name', () => {
	const items = modelChoices({ installed: ['qwen2.5:3b'], selection: 'auto', modelId: 'qwen2.5:3b' });
	assert.equal(matchChoice(items, '1').value, 'auto');
	assert.equal(matchChoice(items, '2').value, 'qwen2.5:3b');
	assert.equal(matchChoice(items, 'Qwen2.5:3b').value, 'qwen2.5:3b');
	assert.equal(matchChoice(items, ''), null);
	assert.equal(matchChoice(items, '9'), null);
	assert.equal(matchChoice(items, 'nope'), null);
});

test('picker window follows the highlighted row', () => {
	assert.deepEqual(pickerWindow(4, 2, 9), { start: 0, end: 4 });
	assert.deepEqual(pickerWindow(20, 0, 9), { start: 0, end: 9 });
	assert.deepEqual(pickerWindow(20, 19, 9), { start: 11, end: 20 });
	const lines = renderPickerLines({
		label: 'Model',
		items: modelChoices({ installed: ['qwen2.5:3b'], selection: 'auto', modelId: 'qwen2.5:3b' }),
		index: 1,
	}).join('\n');
	const plain = stripAnsi(lines);
	assert.match(plain, /→\s+2\s+qwen2\.5:3b/);
	assert.match(plain, /1\s+auto/);
	assert.doesNotMatch(plain, /→\s+1\s+auto/);
	assert.match(plain, /enter select/);
});

test('selectOption does not open a picker when there is no terminal', async () => {
	setPlain(false);
	const result = await selectOption({
		label: 'Model',
		items: [{ value: 'auto', label: 'auto', hint: 'route by task' }],
	});
	assert.deepEqual(result, { item: null, reason: 'unavailable' });
});

test('interactive picker selects, jumps, and cancels', () => {
	const cases = [
		['down-enter', /PICKED:qwen2\.5:3b/],
		['j-enter', /PICKED:qwen2\.5:3b/],
		['three', /PICKED:mistral:7b/],
		['esc', /PICKED:cancel/],
		['ctrl-c', /PICKED:cancel/],
		['plain-two', /PICKED:qwen2\.5:3b/],
		['plain-name', /PICKED:mistral:7b/],
		['plain-empty', /PICKED:cancel/],
	];
	for (const [mode, expected] of cases) {
		const res = spawnSync('python3', [path.join(here, 'drive_picker.py'), mode], {
			encoding: 'utf8',
			timeout: 8000,
		});
		assert.equal(res.status, 0, `${mode}\n${res.stdout}\n${res.stderr}`);
		assert.match(res.stdout, expected, mode);
		if (mode === 'down-enter' || mode === 'esc' || mode === 'plain-two' || mode === 'plain-empty') {
			const screen = visibleScreen(res.stdout);
			assert.match(screen, expected, `${mode} screen`);
			assert.doesNotMatch(screen, /enter select|╭|Choose a number or name|1\. auto/, `${mode} left picker chrome:\n${screen}`);
		}
	}
});

test('REPL help, model picker, and plain text commands', () => {
	const tsx = path.join(here, '../node_modules/tsx/package.json');
	if (!fs.existsSync(tsx)) {
		return;
	}
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copix-repl-'));
	const res = spawnSync('python3', [path.join(here, 'drive_repl.py'), home], {
		encoding: 'utf8',
		timeout: 25000,
	});
	assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
	const settings = JSON.parse(fs.readFileSync(path.join(home, 'Copix', 'settings.json'), 'utf8'));
	assert.equal(settings.model.selection, 'manual');
	assert.equal(settings.model.modelId, 'qwen2.5:3b');
});
