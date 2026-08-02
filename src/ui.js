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

function cols() {
	return Math.max(52, Math.min(process.stdout.columns || 80, 88));
}

function stripAnsi(s) {
	return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function pad(s, width) {
	const len = stripAnsi(s).length;
	return len >= width ? s : `${s}${' '.repeat(width - len)}`;
}

function truncate(s, width) {
	const plain = stripAnsi(s);
	if (plain.length <= width) return s;
	return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function wrapText(text, width) {
	const raw = String(text ?? '');
	if (!raw.trim()) return [''];
	const words = raw.split(/\s+/);
	const lines = [];
	let cur = '';
	for (const w of words) {
		if (!cur) {
			cur = w;
			continue;
		}
		if (`${cur} ${w}`.length > width) {
			lines.push(cur);
			cur = w;
		} else {
			cur += ` ${w}`;
		}
	}
	if (cur) lines.push(cur);
	return lines;
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

export function printFooter({ model, mode = 'Agent', filesEdited = 0 }) {
	const files = filesEdited > 0 ? `${color.muted} ${DOT} ${filesEdited} file${filesEdited === 1 ? '' : 's'} edited${color.reset}` : '';
	console.log(`${color.accent}${MODE}${color.reset} ${mode}${color.muted}  ${DOT}  ${model}${files}${color.reset}`);
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
	const preview = args.path || args.command || args.pattern || args.name || args.summary || '';
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
	if (!installed.length) {
		rows.push('(none installed — ollama pull qwen2.5:3b)');
	} else {
		for (const tag of installed) {
			const active = String(activeModel).includes(tag)
				|| tag.startsWith(String(activeModel).replace(/^ollama\//, ''));
			rows.push(`${active ? `${color.accent}${HEX}${color.reset}` : `${color.muted}${HEX}${color.reset}`} ${tag}`);
		}
	}
	return `\n${box(rows, { label: 'Models' })}\n`;
}

export function helpText() {
	return [
		'',
		box([
			'Copix CLI — same agent & tools as Desktop',
			'',
			'copix                     interactive',
			'copix "prompt"            one-shot',
			'copix -p <dir> "prompt"   workspace',
			'',
			'/help /model /cwd /clear /exit',
			'',
			'Tools: create_project edit_file terminal',
			'       read_file list_dir grep multitask',
			'',
			'Settings: ~/Copix/settings.json',
			'Model:    ollama / qwen2.5:3b',
		], { label: 'Help' }),
		'',
	].join('\n');
}
