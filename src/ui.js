/**
 * Copix CLI text UI.
 * Clay prompt and active model, sage for success, dim gray for hints.
 * Truecolor when the terminal supports it, otherwise the closest 256-color code.
 */

const ESC = '\x1b[';

const ANSI = {
	reset: `${ESC}0m`,
	bold: `${ESC}1m`,
};

/** Site palette. Ink is the terminal's own foreground so it reads on light and dark. */
const RGB = {
	clay: [196, 101, 74],
	sage: [110, 127, 98],
	hint: [125, 125, 125],
};

const CUBE = [0, 95, 135, 175, 215, 255];

/** Closest xterm cube or gray-ramp index. System colors 0–15 are terminal-defined, so they are skipped. */
export function closestAnsi256(r, g, b) {
	let best = 16;
	let bestD = Infinity;
	const consider = (code, cr, cg, cb) => {
		const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
		if (d < bestD) {
			bestD = d;
			best = code;
		}
	};
	for (let i = 0; i < 216; i++) {
		consider(16 + i, CUBE[(i / 36) | 0], CUBE[((i / 6) | 0) % 6], CUBE[i % 6]);
	}
	for (let i = 0; i < 24; i++) {
		const v = 8 + i * 10;
		consider(232 + i, v, v, v);
	}
	return best;
}

export function supportsTrueColor() {
	if (/truecolor|24bit/i.test(String(process.env.COLORTERM || ''))) return true;
	if (process.env.WT_SESSION) return true;
	const program = String(process.env.TERM_PROGRAM || '');
	return program === 'vscode' || program === 'iTerm.app' || program === 'ghostty' || program === 'WezTerm';
}

function paint(ground, rgb) {
	const [r, g, b] = rgb;
	if (supportsTrueColor()) return `${ESC}${ground};2;${r};${g};${b}m`;
	return `${ESC}${ground};5;${closestAnsi256(r, g, b)}m`;
}

/** Screen-reader plain text. NO_COLOR starts it; /plain toggles this session. */
let plainMode = process.env.NO_COLOR !== undefined;

export function isPlain() {
	return plainMode;
}

export function setPlain(on) {
	plainMode = Boolean(on);
}

/** Decorative marks that plain text, including NO_COLOR, must not print. */
const PLAIN_MARKS = [
	['⬢ ', ''],
	['⬢', ''],
	['▪', ''],
	['▸', ''],
	['·', '-'],
	['→', '->'],
	['✓', 'ok'],
	['✗', 'no'],
];
const HALF_BLOCK = /[▀▄█▌▐]/g;

export function scrubPlain(text) {
	const raw = String(text ?? '');
	if (!plainMode) return raw;
	let out = raw;
	for (const [from, to] of PLAIN_MARKS) out = out.replaceAll(from, to);
	return out.replace(HALF_BLOCK, '');
}

export const color = new Proxy(ANSI, {
	get(target, prop) {
		if (plainMode) return '';
		if (prop === 'reset' || prop === 'bold') return target[prop] || '';
		if (prop === 'clay' || prop === 'accent' || prop === 'red' || prop === 'yellow') return paint(38, RGB.clay);
		if (prop === 'sage' || prop === 'green') return paint(38, RGB.sage);
		if (prop === 'hint' || prop === 'muted' || prop === 'dim' || prop === 'gray' || prop === 'fg') return paint(38, RGB.hint);
		if (prop === 'clayBg') return paint(48, RGB.clay);
		return '';
	},
});

const DOT = '·';
const ARROW = '→';
const UPPER = '▀';

/** Terminal width the frames actually fit in. Narrow windows stay inside the real column count. */
export function termCols() {
	const term = process.stdout.columns || 80;
	return Math.max(40, Math.min(term, 88));
}

function cols() {
	return termCols();
}

export function stripAnsi(s) {
	return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** Display columns. ANSI sequences are zero-width; wide characters count as 2. */
export function displayWidth(s) {
	let w = 0;
	for (const atom of splitAtoms(stripAnsi(s))) {
		const code = atom.codePointAt(0) ?? 0;
		w += isWide(code) ? 2 : 1;
	}
	return w;
}

function isWide(code) {
	return (
		(code >= 0x1100 && code <= 0x115f)
		|| (code >= 0x2e80 && code <= 0xa4cf)
		|| (code >= 0xac00 && code <= 0xd7a3)
		|| (code >= 0xf900 && code <= 0xfaff)
		|| (code >= 0xff00 && code <= 0xff60)
		|| (code >= 0xffe0 && code <= 0xffe6)
	);
}

/** ANSI sequences stay intact; everything else is one character. */
function splitAtoms(s) {
	const atoms = [];
	const re = /\x1b\[[0-9;]*m/g;
	let last = 0;
	for (const m of String(s).matchAll(re)) {
		for (const ch of s.slice(last, m.index)) atoms.push(ch);
		atoms.push(m[0]);
		last = m.index + m[0].length;
	}
	for (const ch of s.slice(last)) atoms.push(ch);
	return atoms;
}

function pad(s, width) {
	const len = displayWidth(s);
	return len >= width ? s : `${s}${' '.repeat(width - len)}`;
}

export function truncate(s, width) {
	return fitLine(s, width);
}

/** Clip one physical line so a repaint does not wrap and desync the cursor. */
export function fitLine(s, width) {
	const limit = Math.max(1, width);
	if (displayWidth(s) <= limit) return s;
	const atoms = splitAtoms(String(s));
	let out = '';
	let w = 0;
	const budget = Math.max(1, limit - 1);
	for (const atom of atoms) {
		if (atom.startsWith('\x1b')) {
			out += atom;
			continue;
		}
		const dw = isWide(atom.codePointAt(0) ?? 0) ? 2 : 1;
		if (w + dw > budget) break;
		out += atom;
		w += dw;
	}
	return `${out}…${color.reset}`;
}

function wrapText(text, width) {
	const raw = String(text ?? '');
	const limit = Math.max(8, width);
	if (!raw) return [''];
	const lines = [];
	for (const paragraph of raw.split('\n')) {
		if (!paragraph.trim()) {
			lines.push('');
			continue;
		}
		// Keep column spacing when the row already fits (help text, doctor rows).
		if (displayWidth(paragraph) <= limit) {
			lines.push(paragraph);
			continue;
		}
		let cur = '';
		for (const word of paragraph.split(/\s+/)) {
			if (!word) continue;
			const pieces = breakToken(word, limit);
			for (let i = 0; i < pieces.length; i++) {
				const piece = pieces[i];
				if (!cur) {
					cur = piece;
					continue;
				}
				if (i > 0 || displayWidth(`${cur} ${piece}`) > limit) {
					lines.push(cur);
					cur = piece;
				} else {
					cur += ` ${piece}`;
				}
			}
		}
		if (cur) lines.push(cur);
	}
	return lines.length ? lines : [''];
}

function breakToken(token, width) {
	if (displayWidth(token) <= width) return [token];
	const parts = [];
	let cur = '';
	for (const atom of splitAtoms(token)) {
		if (atom.startsWith('\x1b')) {
			cur += atom;
			continue;
		}
		const dw = isWide(atom.codePointAt(0) ?? 0) ? 2 : 1;
		if (cur && displayWidth(cur) + dw > width) {
			parts.push(cur);
			cur = atom;
		} else {
			cur += atom;
		}
	}
	if (cur) parts.push(cur);
	return parts.length ? parts : [token];
}

/** Shell convention for the Copix data directory. Resolved paths are printed by /status and /doctor. */
export function dataDirLabel() {
	return process.platform === 'win32' ? '%USERPROFILE%\\Copix' : '~/Copix';
}

export function cliInstallCommand() {
	if (process.platform === 'win32') {
		return 'irm https://raw.githubusercontent.com/copixdev/Copix/refs/heads/main/cli/install.ps1 | iex';
	}
	return 'curl -fsSL https://raw.githubusercontent.com/copixdev/Copix/refs/heads/main/cli/install.sh | bash';
}

function box(lines, { label, tone } = {}) {
	if (plainMode) {
		const width = cols();
		const out = [];
		if (label) out.push(`${label}:`);
		for (const line of lines) {
			for (const wrapped of wrapText(stripAnsi(line), width)) out.push(scrubPlain(wrapped));
		}
		return out.join('\n');
	}
	const width = cols();
	const inner = width - 4;
	const edge = color.hint;
	const top = `${edge}╭${'─'.repeat(width - 2)}╮${color.reset}`;
	const bot = `${edge}╰${'─'.repeat(width - 2)}╯${color.reset}`;
	const out = [top];
	if (label) {
		const painted = tone === 'error'
			? `${color.bold}${color.clay}${label}${color.reset}`
			: `${color.bold}${label}${color.reset}`;
		out.push(`${edge}│${color.reset} ${pad(painted, inner)} ${edge}│${color.reset}`);
	}
	for (const line of lines) {
		for (const wrapped of wrapText(line, inner)) {
			out.push(`${edge}│${color.reset} ${pad(wrapped, inner)} ${edge}│${color.reset}`);
		}
	}
	out.push(bot);
	return out.join('\n');
}

function clipPlain(text, width) {
	const s = String(text ?? '');
	if (width <= 0) return '';
	if (displayWidth(s) <= width) return s;
	if (width === 1) return '…';
	let out = '';
	let w = 0;
	for (const ch of s) {
		const dw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
		if (w + dw > width - 1) break;
		out += ch;
		w += dw;
	}
	return `${out}…`;
}

function clipPath(text, width) {
	const s = String(text ?? '');
	if (width <= 0) return '';
	if (displayWidth(s) <= width) return s;
	if (width === 1) return '…';
	const chars = [...s];
	let out = '';
	let w = 0;
	for (let i = chars.length - 1; i >= 0; i--) {
		const dw = isWide(chars[i].codePointAt(0) ?? 0) ? 2 : 1;
		if (w + dw > width - 1) break;
		out = chars[i] + out;
		w += dw;
	}
	return `…${out}`;
}

/** Four squares: ink over clay, sage over clay. One row of upper-half blocks. */
export function pixelMark() {
	if (plainMode) return '';
	const bg = color.clayBg;
	return `${color.reset}${bg}${UPPER}${color.sage}${bg}${UPPER}${color.reset}`;
}

/**
 * One status line: active model in bold clay, workspace dimmed, Ollama check or cross.
 * Stays inside the terminal width so an 80-column window does not wrap it.
 */
export function formatStatusLine({ model = '', workspace = '', ollamaOk = false } = {}) {
	const name = String(model ?? '');
	const where = String(workspace ?? '');
	if (plainMode) {
		const oll = ollamaOk ? 'Ollama: ready' : 'Ollama: offline';
		return scrubPlain(`Model: ${name}  Workspace: ${where}  ${oll}`);
	}
	const width = Math.max(20, cols() - 1);
	const tailWidth = 8; // "✓ ollama"
	const gap = '  ';
	let modelPlain = name.replace(/\s+/g, ' ').trim();
	const maxModel = Math.max(8, Math.min(displayWidth(modelPlain) || 8, Math.floor(width * 0.5)));
	modelPlain = clipPlain(modelPlain, maxModel);
	let room = width - displayWidth(modelPlain) - tailWidth - gap.length * 2;
	let path = room >= 8 ? clipPath(where, room) : '';
	if (!path && displayWidth(modelPlain) + gap.length + tailWidth > width) {
		modelPlain = clipPlain(modelPlain, Math.max(4, width - gap.length - tailWidth));
	}
	const modelAnsi = `${color.bold}${color.clay}${modelPlain}${color.reset}`;
	const pathAnsi = path ? `${gap}${color.hint}${path}${color.reset}` : '';
	const mark = ollamaOk ? `${color.sage}✓${color.reset}` : `${color.clay}✗${color.reset}`;
	return `${modelAnsi}${pathAnsi}${gap}${mark} ${color.hint}ollama${color.reset}`;
}

export function startCardLines({ version, model, workspace, ollamaOk }) {
	if (plainMode) {
		return [
			`Copix ${version}`,
			formatStatusLine({ model, workspace, ollamaOk }),
		];
	}
	const mark = pixelMark();
	return [
		`${mark}  ${color.bold}Copix${color.reset}  ${color.hint}${version}${color.reset}`,
		formatStatusLine({ model, workspace, ollamaOk }),
	];
}

export function printBanner({ version, model, workspace, ollamaOk }) {
	console.log('');
	for (const line of startCardLines({ version, model, workspace, ollamaOk })) console.log(line);
	console.log('');
}

export function promptLabel() {
	return `${color.clay}${ARROW}${color.reset} `;
}

export function printPromptHints() {
	console.log(box([`${color.hint}Ask, plan, build anything${color.reset}`]));
}

export function printFooter({ model, workspace = '', ollamaOk = false }) {
	console.log(formatStatusLine({ model, workspace, ollamaOk }));
	console.log('');
}

export function beginUser(text) {
	console.log('');
	console.log(box([text], { label: 'Question' }));
	console.log('');
}

let streaming = false;
let stepOpen = false;
let toolArmed = false;
let replyRenderer = createReplyRenderer();

function toolDetail(args = {}) {
	return String(args.path || args.url || args.query || args.command || args.pattern || args.name || args.summary || '');
}

export function formatToolLine({ name, detail = '', state = 'run' } = {}) {
	const tip = String(detail || '');
	if (plainMode) {
		if (state === 'run') return scrubPlain(tip ? `Tool: ${name} - ${tip}` : `Tool: ${name}`);
		const mark = state === 'fail' ? 'failed' : 'ok';
		return scrubPlain(tip ? `Result: ${mark} - ${name} - ${tip}` : `Result: ${mark} - ${name}`);
	}
	const glyph = state === 'ok'
		? `${color.sage}✓${color.reset}`
		: state === 'fail'
			? `${color.clay}✗${color.reset}`
			: `${color.clay}▪${color.reset}`;
	const path = tip ? `  ${color.hint}${tip}${color.reset}` : '';
	return `${glyph} ${color.bold}${name}${color.reset}${path}`;
}

export function formatFileDiff(file, diff) {
	const preview = String(diff?.preview || '').split('\n').filter(Boolean).slice(0, 8);
	if (!preview.length) return '';
	const name = String(file || 'file');
	if (plainMode) return [scrubPlain(name), ...preview.map((line) => scrubPlain(line))].join('\n');
	const rows = [`${color.bold}${name}${color.reset}`];
	for (const line of preview) {
		if (line.startsWith('+')) rows.push(`${color.sage}${line}${color.reset}`);
		else if (line.startsWith('-')) rows.push(`${color.clay}${line}${color.reset}`);
		else rows.push(`${color.hint}${line}${color.reset}`);
	}
	return rows.join('\n');
}

function finishReplyHold() {
	const tail = replyRenderer.finish();
	if (tail) process.stdout.write(tail);
}

function disarmToolRow() {
	toolArmed = false;
}

export function beginAssistant() {
	streaming = false;
	stepOpen = false;
	toolArmed = false;
	replyRenderer = createReplyRenderer();
}

export function resetReplyStyle() {
	const tail = replyRenderer.reset();
	if (tail) process.stdout.write(tail);
	replyRenderer = createReplyRenderer();
}

export function writeModelLine(modelId, reason) {
	disarmToolRow();
	if (plainMode) {
		console.log(scrubPlain(reason ? `Model: ${modelId} (${reason})` : `Model: ${modelId}`));
		stepOpen = true;
		return;
	}
	const tip = reason ? `  ${color.hint}${reason}${color.reset}` : '';
	console.log(`Model ${color.bold}${color.clay}${modelId}${color.reset}${tip}`);
	stepOpen = true;
}

export function writeStatus(message) {
	if (!message) return;
	const clean = String(message).replace(/\s+/g, ' ').trim();
	if (!clean) return;
	disarmToolRow();
	if (plainMode) {
		console.log(scrubPlain(clean));
		stepOpen = true;
		return;
	}
	process.stdout.write(`\r${color.hint}${truncate(clean, cols() - 2)}${color.reset}${ESC}K`);
	stepOpen = true;
}

export function writeToolCall(name, args = {}) {
	toolArmed = false;
	if (streaming) {
		finishReplyHold();
		process.stdout.write('\n');
		streaming = false;
	}
	const line = fitLine(formatToolLine({ name, detail: toolDetail(args), state: 'run' }), Math.max(8, cols() - 1));
	process.stdout.write(`${line}\n`);
	toolArmed = Boolean(process.stdout.isTTY) && !plainMode;
	stepOpen = true;
}

export function writeToolResult(name, ok, preview, extra = {}) {
	const detail = toolDetail(extra.args || {}) || '';
	const line = fitLine(
		formatToolLine({ name, detail, state: ok ? 'ok' : 'fail' }),
		Math.max(8, cols() - 1),
	);
	if (toolArmed) process.stdout.write(`\x1b[1A\r\x1b[2K${line}\n`);
	else process.stdout.write(`${line}\n`);
	toolArmed = false;
	stepOpen = true;
	if (!ok) {
		const lines = String(preview ?? '').split('\n').filter(Boolean).slice(0, 8);
		for (const l of lines) {
			const text = plainMode ? `  ${scrubPlain(l)}` : `  ${color.hint}${truncate(l, cols() - 4)}${color.reset}`;
			process.stdout.write(`${text}\n`);
		}
		return;
	}
	const diff = formatFileDiff(detail || name, extra.diff);
	if (diff) process.stdout.write(`${diff}\n`);
}

export function writeAssistantDelta(delta) {
	disarmToolRow();
	if (!streaming) {
		if (stepOpen) process.stdout.write('\n');
		process.stdout.write('\n');
		streaming = true;
		stepOpen = false;
		replyRenderer = createReplyRenderer();
	}
	const out = replyRenderer.push(String(delta ?? ''));
	if (out) process.stdout.write(out);
}

export function endAssistantStream() {
	if (streaming) {
		finishReplyHold();
		process.stdout.write('\n');
		streaming = false;
	} else if (stepOpen) {
		process.stdout.write('\n');
	}
	stepOpen = false;
	toolArmed = false;
}

export function writeError(message) {
	disarmToolRow();
	if (streaming) {
		finishReplyHold();
		process.stdout.write('\n');
		streaming = false;
	}
	console.log('');
	console.log(box(wrapText(message, cols() - 4), { label: 'Error', tone: 'error' }));
	console.log('');
	stepOpen = false;
}

export function writeStep(label, detail = '') {
	disarmToolRow();
	if (plainMode) {
		console.log(scrubPlain(detail ? `${label} - ${detail}` : label));
		stepOpen = true;
		return;
	}
	const tip = detail ? `  ${color.hint}${detail}${color.reset}` : '';
	console.log(`${color.clay}▪${color.reset} ${label}${tip}`);
	stepOpen = true;
}

export function toneMark(ok) {
	if (ok === true) return `${color.sage}✓${color.reset}`;
	if (ok === false) return `${color.clay}✗${color.reset}`;
	return `${color.hint}${DOT}${color.reset}`;
}

export function modelListText(activeModel, installed = []) {
	const activeId = String(activeModel).replace(/^ollama\//, '');
	if (plainMode) {
		const rows = [`Active: ${scrubPlain(activeModel)}`];
		if (!installed.length) rows.push('None installed. Run: ollama pull qwen2.5:3b');
		else {
			for (const tag of installed) rows.push(scrubPlain(tag === activeId ? `${tag} (active)` : tag));
		}
		return `\n${box(rows, { label: 'Models' })}\n`;
	}
	const rows = [`${color.hint}active${color.reset}  ${color.bold}${color.clay}${scrubPlain(activeModel)}${color.reset}`, ''];
	if (!installed.length) {
		rows.push(`${color.hint}none installed. ollama pull qwen2.5:3b${color.reset}`);
	} else {
		for (const tag of installed) {
			const active = tag === activeId;
			rows.push(active
				? `${color.clay}▸${color.reset} ${color.bold}${color.clay}${tag}${color.reset} ${color.sage}✓${color.reset}`
				: `  ${tag}`);
		}
	}
	return `\n${box(rows, { label: 'Models' })}\n`;
}

export function statusText(pairs) {
	const col = Math.max(1, ...pairs.map(([key]) => displayWidth(key))) + 2;
	const rows = pairs.map(([key, value]) => {
		const paintedKey = `${color.hint}${key}${color.reset}`;
		const painted = plainMode ? scrubPlain(String(value ?? '')) : String(value ?? '');
		return `${paintedKey}${' '.repeat(col - displayWidth(key))}${painted}`;
	});
	return `\n${box(rows, { label: 'Status' })}\n`;
}

export function historyLine(title, meta) {
	const name = plainMode ? scrubPlain(title) : String(title ?? '');
	const detail = plainMode ? scrubPlain(meta) : `${color.hint}${meta}${color.reset}`;
	return `${name}  ${detail}`;
}

function createReplyRenderer() {
	let hold = '';
	let mode = 'text';
	let openStyle = false;

	function styleOn(code) {
		openStyle = true;
		return code;
	}
	function styleOff() {
		if (!openStyle) return '';
		openStyle = false;
		return color.reset;
	}
	function markerAt(text) {
		let best = -1;
		let which = '';
		for (const mark of ['```', '**', '`']) {
			const i = text.indexOf(mark);
			if (i !== -1 && (best === -1 || i < best)) {
				best = i;
				which = mark;
			}
		}
		return { index: best, mark: which };
	}
	function holdTail(text) {
		if (text.endsWith('``')) return 2;
		if (text.endsWith('`') || text.endsWith('*')) return 1;
		return 0;
	}
	function bar(line) {
		if (plainMode) return `${line}\n`;
		return `${color.hint}│${color.reset} ${line}\n`;
	}

	return {
		push(delta) {
			hold += String(delta ?? '');
			let out = '';
			while (hold.length) {
				if (mode === 'text') {
					const found = markerAt(hold);
					if (found.index === -1) {
						const tail = holdTail(hold);
						out += hold.slice(0, hold.length - tail);
						hold = hold.slice(hold.length - tail);
						break;
					}
					out += hold.slice(0, found.index);
					hold = hold.slice(found.index);
					if (found.mark === '```') {
						const nl = hold.indexOf('\n');
						if (nl === -1) break;
						mode = 'fence';
						hold = hold.slice(nl + 1);
						if (out && !out.endsWith('\n')) out += '\n';
						continue;
					}
					if (found.mark === '**') {
						mode = 'bold';
						hold = hold.slice(2);
						out += styleOn(color.bold);
						continue;
					}
					mode = 'code';
					hold = hold.slice(1);
					out += styleOn(color.clay);
					continue;
				}
				if (mode === 'bold') {
					const i = hold.indexOf('**');
					if (i === -1) {
						if (hold.endsWith('*')) {
							out += hold.slice(0, -1);
							hold = '*';
						} else {
							out += hold;
							hold = '';
						}
						break;
					}
					out += hold.slice(0, i) + styleOff();
					hold = hold.slice(i + 2);
					mode = 'text';
					continue;
				}
				if (mode === 'code') {
					const i = hold.indexOf('`');
					if (i === -1) {
						out += hold;
						hold = '';
						break;
					}
					out += hold.slice(0, i) + styleOff();
					hold = hold.slice(i + 1);
					mode = 'text';
					continue;
				}
				const nl = hold.indexOf('\n');
				if (nl === -1) break;
				const line = hold.slice(0, nl);
				hold = hold.slice(nl + 1);
				if (/^```[ \t]*$/.test(line)) {
					mode = 'text';
					continue;
				}
				out += bar(line);
			}
			return out;
		},
		finish() {
			let out = '';
			if (mode === 'fence') {
				if (hold && !/^```[ \t]*$/.test(hold)) out += bar(hold);
				hold = '';
				mode = 'text';
				return out;
			}
			out += hold;
			hold = '';
			if (mode !== 'text') out += styleOff();
			mode = 'text';
			return out;
		},
		reset() {
			const tail = styleOff();
			hold = '';
			mode = 'text';
			return tail;
		},
	};
}

export function renderReply(text) {
	const renderer = createReplyRenderer();
	return renderer.push(text) + renderer.finish();
}

export function boxDoctor(rows) {
	return box(rows, { label: 'Doctor' });
}

function alignRows(pairs) {
	const col = Math.max(...pairs.map(([cmd]) => displayWidth(cmd))) + 2;
	return pairs.map(([cmd, desc]) => {
		const description = `${color.hint}${desc}${color.reset}`;
		return `${cmd}${' '.repeat(col - displayWidth(cmd))}${description}`;
	});
}

export function helpText() {
	const dir = dataDirLabel();
	const sep = process.platform === 'win32' ? '\\' : '/';
	return [
		'',
		box([
			`${color.bold}Copix CLI${color.reset} — standalone agent for macOS, Windows, and Linux`,
			`${color.hint}Same tools as Copix Desktop · no account required${color.reset}`,
			'',
			...alignRows([
				['copix', 'interactive REPL'],
				['copix "prompt"', 'one-shot'],
				['copix -p <dir> "prompt"', 'workspace'],
				['copix doctor', 'environment check'],
			]),
			'',
			...alignRows([
				['/model [tag|auto]', 'pick a model, or pin a tag / auto'],
				['/models', 'list installed Ollama tags'],
				['/pull <tag>', 'download a model'],
				['/cwd [path]', 'show or change workspace (saved)'],
				['/status', 'ollama · model · workspace · paths'],
				['/doctor', 'Node, Ollama, models, paths'],
				['/history', 'recent sessions (Desktop sync)'],
				['/new', 'fresh conversation'],
				['/clear', 'wipe screen + fresh conversation'],
				['/keys', 'keyboard shortcuts'],
				['/plain [on|off]', 'screen-reader text, no color or boxes'],
				['/help', 'show this help'],
				['/exit', 'quit'],
			]),
			'',
			`${color.hint}↑↓ recalls earlier lines · tab completes a / command${color.reset}`,
			`${color.hint}Ctrl+C clears the line · Ctrl+C on an empty line quits${color.reset}`,
			'',
			`${color.bold}Tools${color.reset}: create_project write_file edit_file append_file`,
			'       delete_file read_file list_dir grep terminal',
			'       web_search web_fetch multitask spawn_subagent',
			'',
			'Install: copy the command printed under this card',
			`Settings: ${dir}${sep}settings.json`,
			`History: ${dir}${sep}sessions.json (shared with Desktop)`,
			'License: MIT — open source',
		], { label: 'Help' }),
		cliInstallCommand(),
		'',
	].join('\n');
}

export function keysText() {
	return [
		'',
		box([
			`${color.bold}Prompt${color.reset}`,
			'Enter          submit the line',
			'Up / Down      slash menu, or earlier lines when it is closed',
			'Tab            complete the highlighted command',
			'Left / Right   move the cursor',
			'Ctrl+A, Home   beginning of the line',
			'Ctrl+E, End    end of the line',
			'Ctrl+U         clear the line',
			'Ctrl+C         clear the line; quit when it is already empty',
			'Ctrl+D         quit when the line is empty',
			'',
			`${color.bold}Model picker (/model)${color.reset}`,
			'Up / Down, j / k    move',
			'1-9                 jump to that row',
			'Enter               choose the highlighted model',
			'Esc, Ctrl+C         cancel and keep the current model',
			'',
			`${color.bold}Plain text (/plain)${color.reset}`,
			'The prompt is a normal line. /model asks for a',
			'number or a model name. Empty Enter cancels.',
			'Ctrl+C clears the line there too, and quits',
			'only when that line is already empty.',
			'Set NO_COLOR to start in plain text next time.',
		], { label: 'Keys' }),
		'',
	].join('\n');
}
