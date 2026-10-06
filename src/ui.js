/**
 * Cursor Agent–style text UI for Copix CLI.
 * Question card · hexagon timeline · → prompt · footer meta.
 */

const ESC = '\x1b[';

export const color = {
	reset: `${ESC}0m`,
	bold: `${ESC}1m`,
	dim: `${ESC}2m`,
	italic: `${ESC}3m`,
	red: `${ESC}31m`,
	green: `${ESC}32m`,
	yellow: `${ESC}33m`,
	blue: `${ESC}34m`,
	magenta: `${ESC}35m`,
	cyan: `${ESC}36m`,
	gray: `${ESC}90m`,
	fg: `${ESC}38;2;28;28;30m`,
	muted: `${ESC}38;2;120;120;128m`,
	accent: `${ESC}38;2;124;92;255m`,
	cardBg: `${ESC}48;2;244;244;245m`,
	cardFg: `${ESC}38;2;28;28;30m`,
};

const HEX = '⬢';
const DOT = '·';
const ARROW = '→';
const MODE = '◉';

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

function box(lines, { label } = {}) {
	const width = cols();
	const inner = width - 4;
	const top = `${color.dim}╭${'─'.repeat(width - 2)}╮${color.reset}`;
	const bot = `${color.dim}╰${'─'.repeat(width - 2)}╯${color.reset}`;
	const out = [top];
	if (label) {
		out.push(`${color.dim}│${color.reset} ${pad(`${color.muted}${label}${color.reset}`, inner)} ${color.dim}│${color.reset}`);
	}
	for (const line of lines) {
		for (const wrapped of wrapText(line, inner)) {
			out.push(`${color.dim}│${color.reset} ${pad(wrapped, inner)} ${color.dim}│${color.reset}`);
		}
	}
	out.push(bot);
	return out.join('\n');
}

export function printBanner({ version, model, workspace, ollamaOk, installedCount = 0 }) {
	const status = ollamaOk
		? `${color.green}${HEX}${color.reset} ollama ready${installedCount ? `${color.muted} ${DOT} ${installedCount} model${installedCount === 1 ? '' : 's'}${color.reset}` : ''}`
		: `${color.yellow}${HEX}${color.reset} ollama offline${color.muted} ${DOT} run ollama pull qwen2.5:3b${color.reset}`;

	console.log('');
	console.log(`${color.bold}Copix${color.reset}${color.muted}  agent cli ${version}${color.reset}`);
	console.log(`${color.muted}${MODE}${color.reset} ${model}${color.muted}  ${DOT}  ${truncate(workspace, cols() - 24)}${color.reset}`);
	console.log(status);
	console.log('');
}

export function promptLabel() {
	return `${color.accent}${ARROW}${color.reset} `;
}

export function printPromptHints() {
	console.log(box([`${color.muted}Ask, plan, build anything${color.reset}`]));
}

export function printFooter({ model, mode = 'Agent', filesEdited = 0, workspace = '' }) {
	const files = filesEdited > 0 ? `${color.muted} ${DOT} ${filesEdited} file${filesEdited === 1 ? '' : 's'} edited${color.reset}` : '';
	const where = workspace
		? `${color.muted}  ${DOT}  ${truncate(workspace, Math.max(16, cols() - 28))}${color.reset}`
		: '';
	console.log(`${color.accent}${MODE}${color.reset} ${mode}${color.muted}  ${DOT}  ${model}${files}${where}${color.reset}`);
	console.log(`${color.muted}/ commands  ${DOT}  /model  ${DOT}  /cwd  ${DOT}  /clear  ${DOT}  /exit${color.reset}`);
	console.log('');
}

export function beginUser(text) {
	console.log('');
	console.log(box([text], { label: 'Question' }));
	console.log('');
}

let streaming = false;
let stepOpen = false;

export function beginAssistant() {
	streaming = false;
	stepOpen = false;
}

export function writeModelLine(modelId, reason) {
	const tip = reason ? `${color.muted} ${DOT} ${reason}${color.reset}` : '';
	console.log(`${color.fg}${HEX}${color.reset} Model ${color.bold}${modelId}${color.reset}${tip}`);
	stepOpen = true;
}

export function writeStatus(message) {
	if (!message) return;
	const clean = String(message).replace(/\s+/g, ' ').trim();
	if (!clean) return;
	process.stdout.write(`\r${color.muted}${HEX} ${truncate(clean, cols() - 4)}${color.reset}${ESC}K`);
	stepOpen = true;
}

export function writeToolCall(name, args = {}) {
	if (streaming) {
		process.stdout.write('\n');
		streaming = false;
	}
	if (stepOpen) process.stdout.write('\n');
	const preview = args.path || args.url || args.query || args.command || args.pattern || args.name || args.summary || '';
	const detail = preview
		? `${color.muted} ${DOT} ${truncate(String(preview), cols() - 20)}${color.reset}`
		: '';
	console.log(`${color.fg}${HEX}${color.reset} ${name}${detail}`);
	stepOpen = true;
}

export function writeToolResult(_name, ok, preview) {
	const mark = ok === false ? `${color.red}✗${color.reset}` : `${color.green}✓${color.reset}`;
	const lines = String(preview ?? '').split('\n').filter(Boolean).slice(0, 5);
	if (!lines.length) {
		console.log(`${color.muted}  ${HEX}${color.reset} ${mark}`);
		return;
	}
	console.log(`${color.accent}  ${HEX}${color.reset} ${mark} ${color.muted}${truncate(lines[0], cols() - 10)}${color.reset}`);
	for (const l of lines.slice(1)) {
		console.log(`${color.muted}    ${truncate(l, cols() - 6)}${color.reset}`);
	}
}

export function writeAssistantDelta(delta) {
	if (!streaming) {
		if (stepOpen) process.stdout.write('\n');
		process.stdout.write('\n');
		streaming = true;
		stepOpen = false;
	}
	process.stdout.write(String(delta ?? ''));
}

export function endAssistantStream() {
	if (streaming) {
		process.stdout.write('\n');
		streaming = false;
	} else if (stepOpen) {
		process.stdout.write('\n');
	}
	stepOpen = false;
}

export function writeError(message) {
	if (streaming) {
		process.stdout.write('\n');
		streaming = false;
	}
	console.log('');
	console.log(box(wrapText(message, cols() - 4), { label: 'Error' }));
	console.log('');
	stepOpen = false;
}

export function writeStep(label, detail = '') {
	const tip = detail ? `${color.muted} ${DOT} ${detail}${color.reset}` : '';
	console.log(`${color.fg}${HEX}${color.reset} ${label}${tip}`);
	stepOpen = true;
}

export function modelListText(activeModel, installed = []) {
	const rows = [`active ${DOT} ${activeModel}`, ''];
	const activeId = String(activeModel).replace(/^ollama\//, '');
	if (!installed.length) {
		rows.push('(none installed — ollama pull qwen2.5:3b)');
	} else {
		for (const tag of installed) {
			const active = tag === activeId;
			rows.push(`${active ? `${color.accent}${HEX}${color.reset}` : `${color.muted}${HEX}${color.reset}`} ${tag}`);
		}
	}
	return `\n${box(rows, { label: 'Models' })}\n`;
}

export function boxDoctor(rows) {
	return box(rows, { label: 'Doctor' });
}

function alignRows(pairs) {
	const col = Math.max(...pairs.map(([cmd]) => displayWidth(cmd))) + 2;
	return pairs.map(([cmd, desc]) => `${cmd}${' '.repeat(col - displayWidth(cmd))}${desc}`);
}

export function helpText() {
	const dir = dataDirLabel();
	const sep = process.platform === 'win32' ? '\\' : '/';
	return [
		'',
		box([
			'Copix CLI — standalone agent for macOS, Windows, and Linux',
			'Same tools as Copix Desktop · no account required',
			'',
			...alignRows([
				['copix', 'interactive REPL'],
				['copix "prompt"', 'one-shot'],
				['copix -p <dir> "prompt"', 'workspace'],
				['copix doctor', 'environment check'],
			]),
			'',
			...alignRows([
				['/model [tag|auto]', 'show or switch model (saved)'],
				['/models', 'list installed Ollama tags'],
				['/pull <tag>', 'download a model'],
				['/cwd [path]', 'show or change workspace (saved)'],
				['/status', 'ollama · model · workspace · paths'],
				['/doctor', 'Node, Ollama, models, paths'],
				['/history', 'recent sessions (Desktop sync)'],
				['/new', 'fresh conversation'],
				['/clear', 'wipe screen + fresh conversation'],
				['/exit', 'quit'],
			]),
			'',
			'↑↓ recalls earlier lines · tab completes a / command',
			'Ctrl+C clears the line · Ctrl+C on an empty line quits',
			'',
			'Tools: create_project write_file edit_file append_file',
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
