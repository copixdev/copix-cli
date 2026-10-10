import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyText } from '../src/clipboard.js';
import { applyUndo, snapshotFileEdit } from '../src/edits.js';
import {
	SLASH_COMMANDS,
	continuedLine,
	filteredCommands,
	lineBoundary,
	moveCursorVertically,
	parseSubmission,
	promptFrame,
	suggestCommands,
} from '../src/input.js';
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
	contextReport,
	contextText,
	explainError,
	THINKING_FRAME_MS,
	THINKING_LOOP_MS,
	formatThinkingLine,
	formatQuietModelStatus,
	formatTypoHint,
	helpText,
	isPlain,
	keysText,
	modelListText,
	displayWidth,
	printBanner,
	renderReply,
	notifyThinkingResize,
	resetThinking,
	setPlain,
	startThinking,
	stopThinking,
	thinkingLetterRgb,
	thinkingWeight,
	repaintFrame,
	startCardLines,
	statusText,
	termCols,
	writeAssistantDelta,
	writeError,
	writeStatus,
	writeToolCall,
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
			formatThinkingLine({ seconds: 4, visible: true }),
			formatThinkingLine({ seconds: 4, visible: false }),
			formatTypoHint('/modle', ['/model']),
			formatTypoHint('/nope', []),
			contextText(contextReport([{ role: 'user', content: 'hello' }])),
			explainError('connect ECONNREFUSED 127.0.0.1:11434'),
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
		import { isPlain, helpText, keysText, startCardLines, formatStatusLine, formatToolLine, formatFileDiff, renderReply, modelListText, statusText, formatThinkingLine, formatTypoHint, contextText, contextReport, explainError, startThinking, writeStatus } from './src/ui.js';
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
			formatThinkingLine({ seconds: 4, visible: true }),
			formatThinkingLine({ seconds: 4, visible: false }),
			formatTypoHint('/modle', ['/model']),
			formatTypoHint('/nope', []),
			contextText(contextReport([{ role: 'user', content: 'hello · world' }])),
			explainError('connect ECONNREFUSED 127.0.0.1:11434'),
		].join('\\n');
		if (formatThinkingLine({ phase: 0.5, seconds: 4 }) !== 'Thinking\\u2026') process.exit(5);
		const hint = formatTypoHint('/modle', ['/model']);
		if (!hint.includes('/model') || !hint.includes('/modle') || hint.includes('\\x1b')) process.exit(6);
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => logs.push(args.join(' '));
		startThinking();
		startThinking();
		console.log = origLog;
		if (logs.length !== 1 || logs[0] !== 'Thinking\\u2026' || logs[0].includes('\\x1b')) process.exit(7);
		const statusLogs = [];
		console.log = (...args) => statusLogs.push(args.join(' '));
		writeStatus('qwen2.5:3b\\u2026', { tty: true });
		writeStatus('qwen2.5:3b\\u2026', { tty: false });
		console.log = origLog;
		const status = statusLogs.join('\\n');
		if (status !== 'Loading qwen2.5:3b...\\nLoading qwen2.5:3b...' || status.includes('\\x1b') || /[·→⬢✓✗▪▸…]/.test(status)) process.exit(8);
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

function hookStdout() {
	const chunks = [];
	const orig = process.stdout.write;
	process.stdout.write = (chunk, enc, cb) => {
		chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
		if (typeof enc === 'function') enc();
		else if (typeof cb === 'function') cb();
		return true;
	};
	return {
		chunks,
		text: () => chunks.join(''),
		restore() { process.stdout.write = orig; },
	};
}

test('thinking highlight sweeps across the word in truecolor and 256-color', () => {
	const prev = {
		COLORTERM: process.env.COLORTERM,
		WT_SESSION: process.env.WT_SESSION,
		TERM_PROGRAM: process.env.TERM_PROGRAM,
	};
	delete process.env.WT_SESSION;
	delete process.env.TERM_PROGRAM;
	setPlain(false);
	try {
		assert.equal(thinkingWeight(4, 0.5), 1);
		assert.ok(thinkingWeight(3, 0.5) > 0 && thinkingWeight(3, 0.5) < 1);
		assert.ok(thinkingWeight(5, 0.5) > 0 && thinkingWeight(5, 0.5) < 1);
		assert.equal(thinkingWeight(2, 0.5), 0);
		assert.equal(thinkingWeight(6, 0.5), 0);
		assert.equal(thinkingWeight(0, 0), 0);
		assert.deepEqual(thinkingLetterRgb(4, 0.5), [196, 101, 74]);
		assert.deepEqual(thinkingLetterRgb(0, 0.5), [125, 125, 125]);

		process.env.COLORTERM = 'truecolor';
		const mid = formatThinkingLine({ phase: 0.5, seconds: 2 });
		assert.equal(formatThinkingLine({ phase: 0, seconds: 0 }), formatThinkingLine({ phase: 1, seconds: 0 }));
		assert.match(mid, /\x1b\[38;2;196;101;74m▪/);
		assert.match(mid, /\x1b\[38;2;196;101;74mk/);
		assert.match(mid, /\x1b\[38;2;125;125;125mt/);
		assert.match(mid, /2s/);
		assert.doesNotMatch(mid, /\x1b\[1m/);
		assert.doesNotMatch(mid, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

		delete process.env.COLORTERM;
		const faded = formatThinkingLine({ phase: 0.5, seconds: 0 });
		assert.match(faded, new RegExp(`38;5;${closestAnsi256(196, 101, 74)}m▪`));
		assert.match(faded, new RegExp(`38;5;${closestAnsi256(196, 101, 74)}mk`));
		assert.match(faded, new RegExp(`38;5;${closestAnsi256(125, 125, 125)}mt`));
		assert.doesNotMatch(faded, /38;2;/);
		assert.equal(THINKING_LOOP_MS, 1000);
		assert.ok(THINKING_FRAME_MS >= 80);
	} finally {
		for (const [key, value] of Object.entries(prev)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		setPlain(false);
		stopThinking();
	}
});

test('thinking line clears before output and restores the cursor', () => {
	const prev = process.env.COLORTERM;
	process.env.COLORTERM = 'truecolor';
	setPlain(false);
	const out = hookStdout();
	let now = 0;
	let draw = null;
	let frameMs = 0;
	try {
		startThinking({
			tty: true,
			now: () => now,
			schedule(fn, ms) {
				frameMs = ms;
				draw = fn;
				return () => { draw = null; };
			},
		});
		assert.equal(frameMs, THINKING_FRAME_MS);
		assert.match(out.text(), /\x1b\[\?25l/);
		assert.match(stripAnsi(out.text()), /thinking/);
		const afterFirst = out.chunks.length;
		now = 40;
		draw();
		assert.equal(out.chunks.length, afterFirst);
		now = THINKING_FRAME_MS;
		draw();
		assert.ok(out.chunks.length > afterFirst);

		out.chunks.length = 0;
		writeAssistantDelta('Hello');
		const streamed = out.text();
		const streamClear = streamed.search(/\x1b\[2K|\x1b\[J/);
		const helloAt = streamed.indexOf('Hello');
		assert.ok(streamClear !== -1 && helloAt !== -1 && streamClear < helloAt, streamed);
		assert.doesNotMatch(streamed.slice(0, helloAt), /thinking/);
		assert.doesNotMatch(visibleScreen(streamed), /thinking/);
		assert.match(visibleScreen(streamed), /Hello/);
		assert.match(streamed, /\x1b\[\?25h/);
		stopThinking();

		out.chunks.length = 0;
		startThinking({
			tty: true,
			now: () => now,
			schedule(fn, ms) {
				frameMs = ms;
				draw = fn;
				return () => { draw = null; };
			},
		});
		out.chunks.length = 0;
		writeToolCall('edit_file', { path: 'a.js' });
		const raw = out.text();
		const clearAt = raw.search(/\x1b\[2K|\x1b\[J/);
		const toolAt = raw.indexOf('edit_file');
		assert.ok(clearAt !== -1 && toolAt !== -1 && clearAt < toolAt, raw);
		assert.doesNotMatch(raw.slice(0, toolAt), /thinking/);
		assert.doesNotMatch(visibleScreen(raw), /thinking/);
		assert.match(visibleScreen(raw), /edit_file/);
		assert.match(raw, /\x1b\[\?25h/);

		now = 0;
		out.chunks.length = 0;
		startThinking({
			tty: true,
			now: () => now,
			schedule() { return () => {}; },
		});
		out.chunks.length = 0;
		writeError('connect ECONNREFUSED 127.0.0.1:11434');
		const errorRaw = out.text();
		const errorClear = errorRaw.search(/\x1b\[2K|\x1b\[J/);
		const errorAt = errorRaw.indexOf('Error');
		assert.ok(errorClear !== -1 && errorAt !== -1 && errorClear < errorAt, errorRaw);
		assert.match(errorRaw, /\x1b\[\?25h/);
		assert.doesNotMatch(errorRaw.slice(0, errorAt), /thinking/);
		assert.doesNotMatch(visibleScreen(errorRaw), /thinking/);
		assert.match(visibleScreen(errorRaw), /Ollama is not reachable/);

		out.chunks.length = 0;
		startThinking({
			tty: true,
			now: () => now,
			schedule() { return () => {}; },
		});
		out.chunks.length = 0;
		stopThinking();
		const cancel = out.text();
		assert.match(cancel, /\x1b\[2K|\x1b\[J/);
		assert.match(cancel, /\x1b\[\?25h/);
		assert.doesNotMatch(cancel, /thinking/);
		assert.doesNotMatch(visibleScreen(cancel), /thinking/);
	} finally {
		stopThinking();
		out.restore();
		if (prev === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = prev;
		setPlain(false);
	}
});

test('thinking resize refits the line and plain or non-TTY stays static', () => {
	setPlain(false);
	const out = hookStdout();
	let cols = 80;
	try {
		startThinking({
			tty: true,
			columns: () => cols,
			now: () => 0,
			schedule() { return () => {}; },
		});
		assert.match(stripAnsi(out.text()), /thinking/);
		cols = 8;
		out.chunks.length = 0;
		notifyThinkingResize();
		const narrow = out.text();
		assert.match(narrow, /\x1b\[[2-9]A\x1b\[J/);
		const screen = visibleScreen(narrow);
		const last = screen.split('\n').filter((line) => line.trim()).pop() || '';
		assert.ok(displayWidth(last) <= 8, JSON.stringify(last));
		stopThinking();
		assert.match(out.text(), /\x1b\[\?25h/);
	} finally {
		stopThinking();
		out.restore();
		setPlain(false);
	}

	setPlain(true);
	try {
		let scheduled = false;
		const lines = captureLog(() => {
			startThinking({
				tty: true,
				schedule() { scheduled = true; return () => {}; },
			});
			startThinking({ tty: true });
		});
		assert.equal(scheduled, false);
		assert.deepEqual(lines, ['Thinking\u2026']);
		assert.equal(lines.join('').includes('\x1b'), false);
		stopThinking();
	} finally {
		resetThinking();
		setPlain(false);
	}

	setPlain(false);
	let scheduled = false;
	const lines = captureLog(() => {
		startThinking({
			tty: false,
			schedule() { scheduled = true; return () => {}; },
		});
		startThinking({ tty: false });
	});
	assert.equal(scheduled, false);
	assert.deepEqual(lines, ['Thinking\u2026']);
	assert.equal(lines.join('').includes('\x1b'), false);
	assert.doesNotMatch(lines.join(''), /[·→⬢✓✗▪▸▀▄█▌▐⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	resetThinking();
});

test('plain and non-TTY model status names the model it is loading', () => {
	const tag = 'qwen2.5:3b\u2026';
	const expectLine = 'Loading qwen2.5:3b...';
	assert.equal(formatQuietModelStatus(tag, { plain: true, tty: true }), expectLine);
	assert.equal(formatQuietModelStatus(tag, { plain: false, tty: false }), expectLine);
	assert.equal(formatQuietModelStatus('qwen2.5:3b...', { plain: true, tty: false }), expectLine);
	assert.equal(formatQuietModelStatus(tag, { plain: false, tty: true }), '');
	assert.equal(formatQuietModelStatus('rate limited, then retrying\u2026', { plain: true, tty: false }), '');
	assert.equal(expectLine.includes('\x1b'), false);
	assert.doesNotMatch(expectLine, /[·→⬢✓✗▪▸…▀▄█▌▐]/);

	setPlain(true);
	try {
		const plainLines = captureLog(() => {
			writeStatus(tag, { tty: true });
			writeStatus('compacting context', { tty: true });
		});
		assert.deepEqual(plainLines, [expectLine, 'compacting context']);
	} finally {
		setPlain(false);
	}

	const quietLines = captureLog(() => writeStatus(tag, { tty: false }));
	assert.deepEqual(quietLines, [expectLine]);

	const out = hookStdout();
	try {
		const colorLines = captureLog(() => writeStatus(tag, { tty: true }));
		assert.deepEqual(colorLines, []);
		assert.match(out.text(), /\r/);
		assert.match(out.text(), /qwen2\.5:3b\u2026/);
		assert.equal(out.text().includes('Loading'), false);
	} finally {
		out.restore();
	}
});

test('commands, typo hints, context, copy, and undo', () => {
	assert.equal(suggestCommands('/modle')[0], '/model');
	assert.ok(suggestCommands('/modle').includes('/model'));
	assert.deepEqual(suggestCommands('/model'), []);
	assert.deepEqual(suggestCommands('/zzzz'), []);
	assert.equal(filteredCommands('/mod').some((command) => command.cmd === '/model'), true);
	assert.equal(filteredCommands('/odml').some((command) => command.cmd === '/model'), true);
	assert.equal(continuedLine('keep going \\'), 'keep going \n');
	assert.equal(continuedLine('keep going \\\\'), null);
	assert.equal(moveCursorVertically('one\ntwo', 0, 1), 4);
	assert.equal(lineBoundary('one\ntwo', 5, 'start'), 4);
	assert.deepEqual(parseSubmission('hello\nworld'), { kind: 'prompt', text: 'hello\nworld', cmd: '', arg: '' });
	assert.equal(parseSubmission('/cwd \\\n~/proj').cmd, '/cwd');
	assert.equal(parseSubmission('exit').cmd, '/exit');

	const frame = promptFrame({ buffer: 'one\ntwo', cursor: 4, width: 80, footer: ['ready'] });
	for (const line of frame) assert.ok(displayWidth(line) <= 80, line);
	assert.match(stripAnsi(frame.join('\n')), /one/);
	assert.match(stripAnsi(frame.join('\n')), /two/);

	setPlain(false);
	const prev = process.env.COLORTERM;
	process.env.COLORTERM = 'truecolor';
	try {
		const hint = formatTypoHint('/modle', ['/model']);
		assert.match(hint, /38;2;125;125;125m/);
		assert.match(hint, /38;2;196;101;74m\/model/);
		assert.doesNotMatch(hint, /\x1b\[1m/);
		const help = helpText();
		assert.match(stripAnsi(help), /Model/);
		assert.match(stripAnsi(help), /Session/);
		assert.match(help, /\/context/);
		assert.match(help, /\/copy/);
		assert.match(help, /\/undo/);
		for (const line of help.split('\n')) {
			if (/^curl |^irm /.test(line)) continue;
			assert.ok(displayWidth(line) <= termCols(), stripAnsi(line));
		}
	} finally {
		if (prev === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = prev;
	}

	setPlain(true);
	try {
		const hint = formatTypoHint('/modle', ['/model']);
		assert.equal(hint.includes('\x1b'), false);
		assert.doesNotMatch(hint, DECORATIVE);
		assert.match(hint, /\/modle/);
		assert.match(hint, /\/model/);
		const none = formatTypoHint('/zzzz', []);
		assert.match(none, /\/help/);
		assert.equal(none.includes('\x1b'), false);
		const report = contextReport([
			{ role: 'user', content: 'abcd' },
			{ role: 'assistant', content: 'ef' },
		]);
		assert.equal(report.turns, 1);
		assert.equal(report.characters, 6);
		assert.equal(report.tokens, 2);
		const context = contextText(report);
		assert.equal(context.includes('\x1b'), false);
		assert.doesNotMatch(context, DECORATIVE);
		assert.match(context, /~2 tokens/);
		assert.match(explainError('connect ECONNREFUSED 127.0.0.1:11434'), /\/doctor/);
		const error = captureLog(() => writeError('connect ECONNREFUSED 127.0.0.1:11434'));
		const errorText = error.join('\n');
		assert.equal(errorText.includes('\x1b'), false);
		assert.match(errorText, /Error:/);
		assert.doesNotMatch(errorText, DECORATIVE);
	} finally {
		setPlain(false);
	}

	const copied = copyText('last reply', {
		platform: 'linux',
		run() { return { ok: false }; },
		dest: path.join(os.tmpdir(), `copix-reply-${Date.now()}.txt`),
		writeFile(file, data) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, data);
		},
	});
	assert.equal(copied.via, 'file');
	assert.match(fs.readFileSync(copied.path, 'utf8'), /last reply/);
	const clip = copyText('hello', {
		platform: 'win32',
		run(cmd) { return { ok: cmd === 'clip' }; },
	});
	assert.equal(clip.command, 'clip');
	assert.equal(copyText('   ').via, 'empty');

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copix-undo-'));
	const file = path.join(dir, 'note.txt');
	fs.writeFileSync(file, 'before');
	const snap = snapshotFileEdit('edit_file', { path: file }, dir);
	fs.writeFileSync(file, 'after');
	assert.equal(applyUndo(snap).action, 'restored');
	assert.equal(fs.readFileSync(file, 'utf8'), 'before');
	const created = snapshotFileEdit('write_file', { path: path.join(dir, 'new.txt') }, dir);
	fs.writeFileSync(created.path, 'new');
	assert.equal(applyUndo(created).action, 'removed');
	assert.equal(fs.existsSync(created.path), false);
});
