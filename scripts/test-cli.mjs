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
import {
	boxDoctor,
	closestAnsi256,
	formatFileDiff,
	formatStatusLine,
	formatToolLine,
	helpText,
	isPlain,
	keysText,
	modelListText,
	displayWidth,
	printBanner,
	renderReply,
	setPlain,
	repaintFrame,
	startCardLines,
	statusText,
	termCols,
	wrappedRowCount,
} from '../src/ui.js';

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
			} 			else if (cmd === 'H') {
				row = Math.max(0, (args[0] || 1) - 1);
				col = Math.max(0, (args[1] || 1) - 1);
				ensure(row);
			} else if (cmd === 'J') {
				const mode = args[0] ?? 0;
				if (mode === 2) {
					lines.splice(0, lines.length, '');
					row = 0;
					col = 0;
				} else if (mode === 0) {
					ensure(row);
					lines[row] = [...lines[row]].slice(0, col).join('');
					lines.splice(row + 1);
				}
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
	assert.match(fancy, /▀/);
	assert.match(stripAnsi(fancy), /ollama/);
	assert.doesNotMatch(stripAnsi(fancy), /⬢|◉/);

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
		assert.equal(/[╭╮╰╯│⬢◉▀▄█▌▐▪▸]/.test(plain), false);
		assert.match(plain, /Copix 1\.7\.2/);
		assert.match(plain, /Ollama: ready/);
		assert.match(plain, /auto - ollama\/qwen2\.5:3b/);
		const help = helpText();
		assert.equal(help.includes('\x1b'), false);
		assert.match(help, /\/keys/);
		assert.match(help, /\/plain/);
	} finally {
		setPlain(false);
	}
});

const DECORATIVE = /[·→⬢✓✗▪▸▀▄█▌▐]/;

test('plain mode and NO_COLOR omit middle dots, arrows, hexagons, and check marks', () => {
	setPlain(true);
	try {
		assert.doesNotMatch(helpText(), DECORATIVE);
		assert.doesNotMatch(keysText(), DECORATIVE);
		assert.match(keysText(), /clear the line; quit when it is already empty/);
		assert.doesNotMatch(keysText(), /quits the plain prompt/);
		const banner = captureLog(() => {
			printBanner({
				version: '1.7.2',
				model: 'auto · ollama/qwen2.5:3b',
				workspace: '/tmp',
				ollamaOk: false,
				installedCount: 0,
			});
		}).join('\n');
		assert.doesNotMatch(banner, DECORATIVE);
		assert.match(banner, /auto - ollama\/qwen2\.5:3b/);
		const doctor = boxDoctor([
			'copix 1 · linux',
			'✓ Node',
			'✗ Ollama',
			'· Settings',
			'⬢ title → next',
		]);
		assert.doesNotMatch(doctor, DECORATIVE);
		assert.match(doctor, /ok Node/);
		assert.match(doctor, /no Ollama/);
		assert.match(doctor, /-> next/);
		const surfaces = [
			startCardLines({ version: '1.7.2', model: 'auto · qwen', workspace: '/tmp', ollamaOk: true }).join('\n'),
			formatStatusLine({ model: 'auto · qwen', workspace: '/tmp', ollamaOk: false }),
			formatToolLine({ name: 'edit_file', detail: 'a.js', state: 'run' }),
			formatToolLine({ name: 'edit_file', detail: 'a.js', state: 'ok' }),
			formatToolLine({ name: 'edit_file', detail: 'a.js', state: 'fail' }),
			formatFileDiff('a.js', { preview: '- old\n+ new' }),
			renderReply('See **name** and `id`.\n```\nconst a = 1;\n```\n'),
			modelListText('ollama/qwen', ['qwen']),
			renderPickerLines({
				label: 'Model',
				items: modelChoices({ installed: ['qwen'], selection: 'manual', modelId: 'qwen' }),
				index: 1,
			}).join('\n'),
		].join('\n');
		assert.equal(surfaces.includes('\x1b'), false);
		assert.doesNotMatch(surfaces, DECORATIVE);
		assert.match(surfaces, /const a = 1/);
		assert.match(surfaces, /Result: ok/);
		assert.match(surfaces, /\(active\)/);
	} finally {
		setPlain(false);
	}

	const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
		import { isPlain, helpText, keysText, startCardLines, formatStatusLine, formatToolLine, formatFileDiff, renderReply, modelListText, statusText } from './src/ui.js';
		import { renderPickerLines, modelChoices } from './src/select.js';
		if (!isPlain()) process.exit(2);
		const text = [
			helpText(),
			keysText(),
			startCardLines({ version: '1.7.2', model: 'auto · ollama/qwen2.5:3b', workspace: '/tmp', ollamaOk: true }).join('\\n'),
			formatStatusLine({ model: 'auto · ollama/qwen2.5:3b', workspace: '/tmp', ollamaOk: false }),
			formatToolLine({ name: 'write_file', detail: 'src/app.js', state: 'run' }),
			formatToolLine({ name: 'write_file', detail: 'src/app.js', state: 'ok' }),
			formatToolLine({ name: 'write_file', detail: 'src/app.js', state: 'fail' }),
			formatFileDiff('src/app.js', { preview: '- old\\n+ new' }),
			renderReply('See **name** and \`id\`\\n\\n\`\`\`\\nconst a = 1;\\n\`\`\`\\n'),
			modelListText('ollama/qwen2.5:3b', ['qwen2.5:3b']),
			statusText([['model', 'auto · ollama/qwen2.5:3b'], ['ollama', '✓ online']]),
			renderPickerLines({
				label: 'Model',
				items: modelChoices({ installed: ['qwen2.5:3b'], selection: 'manual', modelId: 'qwen2.5:3b' }),
				index: 1,
			}).join('\\n'),
		].join('\\n');
		if (text.includes('\\x1b')) process.exit(4);
		if (/[·→⬢✓✗▪▸▀▄█▌▐]/.test(text)) process.exit(3);
		process.stdout.write('plain-ok');
	`], {
		cwd: path.join(here, '..'),
		env: { ...process.env, NO_COLOR: '1' },
		encoding: 'utf8',
	});
	assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
	assert.match(child.stdout, /plain-ok/);
});

test('palette uses truecolor and the closest 256-color fallback', () => {
	const prev = {
		COLORTERM: process.env.COLORTERM,
		WT_SESSION: process.env.WT_SESSION,
		TERM_PROGRAM: process.env.TERM_PROGRAM,
	};
	delete process.env.WT_SESSION;
	delete process.env.TERM_PROGRAM;
	setPlain(false);
	try {
		assert.equal(closestAnsi256(196, 101, 74), 167);
		assert.equal(closestAnsi256(110, 127, 98), 65);
		process.env.COLORTERM = 'truecolor';
		const reply = renderReply('Use **bold** and `clay`.\n```\nconst n = 1;\n```\n');
		assert.match(reply, /\x1b\[1mbold\x1b\[0m/);
		assert.match(reply, /\x1b\[38;2;196;101;74mclay\x1b\[0m/);
		assert.match(stripAnsi(reply), /│ const n = 1;/);
		assert.doesNotMatch(reply, /╭/);
		const diff = formatFileDiff('src/a.js', { preview: '- old\n+ new' });
		assert.match(diff, /\x1b\[1msrc\/a\.js/);
		assert.match(diff, /\x1b\[38;2;110;127;98m\+ new/);
		assert.match(diff, /\x1b\[38;2;196;101;74m- old/);
		const run = formatToolLine({ name: 'edit_file', detail: 'src/a.js', state: 'run' });
		assert.match(run, /▪/);
		assert.match(run, /\x1b\[1medit_file/);
		assert.match(formatToolLine({ name: 'edit_file', detail: 'src/a.js', state: 'ok' }), /✓/);
		assert.match(formatToolLine({ name: 'edit_file', detail: 'src/a.js', state: 'fail' }), /✗/);
		const card = startCardLines({
			version: '1.7.2',
			model: 'ollama/qwen2.5:3b',
			workspace: '/tmp',
			ollamaOk: true,
		}).join('\n');
		assert.match(card, /\x1b\[1mCopix/);
		assert.match(card, /48;2;196;101;74/);
		assert.match(card, /38;2;110;127;98/);

		process.env.COLORTERM = '';
		const faded = formatStatusLine({ model: 'qwen2.5:3b', workspace: '/tmp/workspace', ollamaOk: true });
		assert.match(faded, /\x1b\[38;5;167m/);
		assert.match(faded, /\x1b\[38;5;65m/);
		assert.match(faded, /\x1b\[1m/);
		assert.doesNotMatch(faded, /38;2;/);
		assert.ok(displayWidth(faded) <= termCols());
		const wide = formatStatusLine({
			model: 'auto · ollama/qwen2.5-coder:32b-instruct',
			workspace: '/home/someone/very/long/path/to/a/project/workspace/folder',
			ollamaOk: false,
		});
		assert.ok(displayWidth(wide) < termCols(), `status wider than the terminal: ${displayWidth(wide)}`);
	} finally {
		for (const [key, value] of Object.entries(prev)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
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

function reflowLines(lines, columns) {
	const cols = Math.max(1, columns);
	const rows = [];
	for (const line of lines) {
		const text = stripAnsi(line);
		if (displayWidth(text) === 0) {
			rows.push('');
			continue;
		}
		let row = '';
		let width = 0;
		for (const ch of text) {
			const dw = displayWidth(ch);
			if (row && width + dw > cols) {
				rows.push(row);
				row = ch;
				width = dw;
			} else {
				row += ch;
				width += dw;
			}
		}
		if (row) rows.push(row);
	}
	return rows;
}

test('narrowing resize erases the rewrapped prompt before redrawing', () => {
	const oldWidth = 100;
	const nextWidth = 60;
	const oldLines = [
		`╭${'─'.repeat(oldWidth - 2)}╮`,
		`│ ${'OLDFRAME'.padEnd(oldWidth - 4, ' ')} │`,
		`╰${'─'.repeat(oldWidth - 2)}╯`,
		`${'x'.repeat(oldWidth)}`,
	];
	const nextLines = [
		`╭${'─'.repeat(nextWidth - 2)}╮`,
		`│ ${'NEWFRAME'.padEnd(nextWidth - 4, ' ')} │`,
		`╰${'─'.repeat(nextWidth - 2)}╯`,
	];
	assert.equal(displayWidth(oldLines[0]), oldWidth);
	assert.equal(wrappedRowCount(oldLines, nextWidth), oldLines.length * 2);
	assert.equal(wrappedRowCount([`\x1b[1m${'あ'.repeat(3)}\x1b[0m`], 4), 2);
	assert.equal(wrappedRowCount([''], 60), 1);

	let emitted = '';
	repaintFrame((chunk) => { emitted += chunk; }, oldLines, nextLines, nextWidth);
	assert.match(emitted, new RegExp(`^\\x1b\\[${wrappedRowCount(oldLines, nextWidth)}A\\x1b\\[J`));

	const reflowed = reflowLines(oldLines, nextWidth);
	const screen = visibleScreen(`${reflowed.join('\n')}\n${emitted}`);
	assert.equal(screen.split('╭').length - 1, 1, screen);
	assert.match(screen, /NEWFRAME/);
	assert.doesNotMatch(screen, /OLDFRAME/);
});

test('picker window follows the highlighted row', () => {
	setPlain(false);
	assert.deepEqual(pickerWindow(4, 2, 9), { start: 0, end: 4 });
	assert.deepEqual(pickerWindow(20, 0, 9), { start: 0, end: 9 });
	assert.deepEqual(pickerWindow(20, 19, 9), { start: 11, end: 20 });
	const lines = renderPickerLines({
		label: 'Model',
		items: modelChoices({ installed: ['qwen2.5:3b'], selection: 'auto', modelId: 'qwen2.5:3b' }),
		index: 1,
	}).join('\n');
	const plain = stripAnsi(lines);
	assert.match(plain, /▸\s+2\s+qwen2\.5:3b/);
	assert.match(plain, /1\s+auto/);
	assert.match(plain, /✓/);
	assert.doesNotMatch(plain, /▸\s+1\s+auto/);
	assert.match(plain, /enter select/);
	const autoRow = lines.split('\n').find((line) => /\s1\s+auto/.test(stripAnsi(line)));
	const qwenRow = lines.split('\n').find((line) => /qwen2\.5:3b/.test(stripAnsi(line)) && !/coder/.test(stripAnsi(line)));
	assert.doesNotMatch(autoRow, /\x1b\[1m/);
	assert.match(stripAnsi(autoRow), /✓/);
	assert.match(qwenRow, /\x1b\[1m/);
	assert.doesNotMatch(stripAnsi(qwenRow), /✓/);
});

test('picker cursor is the only bold clay row', () => {
	const prev = process.env.COLORTERM;
	process.env.COLORTERM = 'truecolor';
	setPlain(false);
	try {
		const items = modelChoices({ installed: ['qwen2.5:3b'], selection: 'manual', modelId: 'qwen2.5:3b' });
		const parked = renderPickerLines({ label: 'Model', items, index: 0 });
		const auto = parked.find((line) => /\s1\s+auto/.test(stripAnsi(line)));
		const qwen = parked.find((line) => /qwen2\.5:3b/.test(stripAnsi(line)) && !/coder/.test(stripAnsi(line)));
		assert.match(auto, /▸/);
		assert.match(auto, /\x1b\[1m/);
		assert.match(auto, /38;2;196;101;74m/);
		assert.doesNotMatch(stripAnsi(auto), /✓/);
		assert.doesNotMatch(qwen, /▸/);
		assert.doesNotMatch(qwen, /\x1b\[1m/);
		assert.doesNotMatch(qwen, /38;2;196;101;74m/);
		assert.match(qwen, /38;2;110;127;98m✓/);

		const onActive = renderPickerLines({ label: 'Model', items, index: 1 });
		const current = onActive.find((line) => /▸/.test(stripAnsi(line)));
		assert.match(stripAnsi(current), /qwen2\.5:3b/);
		assert.match(current, /\x1b\[1m/);
		assert.match(current, /38;2;196;101;74m/);
		assert.match(current, /38;2;110;127;98m✓/);
	} finally {
		if (prev === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = prev;
		setPlain(false);
	}
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

test('Ctrl+C clears a typed line and quits only when the line is empty', () => {
	for (const mode of ['raw-text', 'raw-empty', 'plain-text', 'plain-empty']) {
		const res = spawnSync('python3', [path.join(here, 'drive_ctrlc.py'), mode], {
			encoding: 'utf8',
			timeout: 8000,
		});
		assert.equal(res.status, 0, `${mode}\n${res.stdout}\n${res.stderr}`);
		assert.match(res.stdout, /LINE:null/, mode);
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
