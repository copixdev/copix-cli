/**
 * Cursor-style text UI for Copix CLI.
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
};

function cols() {
	return Math.max(56, Math.min(process.stdout.columns || 80, 96));
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
	const words = String(text).split(/\s+/);
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
	return lines.length ? lines : [''];
}

export function hr(char = '─') {
	return `${color.dim}${char.repeat(cols())}${color.reset}`;
}

export function printBanner({ version, model, workspace, ollamaOk, installedCount = 0 }) {
	const width = cols();
	const inner = width - 4;
	const line = (text) => `${color.dim}│${color.reset} ${pad(truncate(text, inner), inner)} ${color.dim}│${color.reset}`;
	const top = `${color.dim}┌${'─'.repeat(width - 2)}┐${color.reset}`;
	const mid = `${color.dim}├${'─'.repeat(width - 2)}┤${color.reset}`;
	const bot = `${color.dim}└${'─'.repeat(width - 2)}┘${color.reset}`;
	const status = ollamaOk
		? `${color.green}● ollama ready${color.reset}${installedCount ? `${color.dim} · ${installedCount} model${installedCount === 1 ? '' : 's'}${color.reset}` : ''}`
		: `${color.yellow}● ollama offline${color.reset}${color.dim} — ollama pull qwen2.5:3b${color.reset}`;

	console.log('');
	console.log(top);
	console.log(line(`${color.bold}Copix${color.reset}${color.dim}  cli ${version}${color.reset}`));
	console.log(mid);
	console.log(line(`${color.dim}model${color.reset}      ${model}`));
	console.log(line(`${color.dim}workspace${color.reset}  ${workspace}`));
	console.log(line(`${color.dim}tools${color.reset}      create_project · edit_file · terminal · …`));
	console.log(line(status));
	console.log(bot);
	console.log(`${color.dim}  /help  /model  /cwd  /clear  /exit${color.reset}`);
	console.log('');
}

export function promptLabel() {
	return `${color.cyan}${color.bold}❯${color.reset} `;
}

export function beginUser(text) {
	const width = cols() - 4;
	console.log(`${color.dim}╭─ you${color.reset}`);
	for (const l of wrapText(text, width)) {
		console.log(`${color.dim}│${color.reset} ${l}`);
	}
	console.log(`${color.dim}╰${color.reset}`);
}

let streaming = false;

export function beginAssistant() {
	streaming = false;
}

export function writeModelLine(modelId, reason) {
	const tip = reason ? `${color.dim}  ${reason}${color.reset}` : '';
	console.log(`${color.dim}· using ${color.reset}${color.cyan}${modelId}${color.reset}${tip}`);
}

export function writeStatus(message) {
	if (!message) return;
	process.stdout.write(`\r${color.dim}  … ${truncate(message, cols() - 6)}${color.reset}${ESC}K`);
}

export function writeToolCall(name, args = {}) {
	if (streaming) {
		process.stdout.write('\n');
		streaming = false;
	}
	const preview = args.path || args.command || args.pattern || args.name || args.summary || '';
	const detail = preview ? ` ${color.dim}${truncate(String(preview), cols() - 24)}${color.reset}` : '';
	console.log(`\n${color.cyan}  ⚙ ${name}${color.reset}${detail}`);
}

export function writeToolResult(_name, ok, preview) {
	const mark = ok === false ? `${color.red}✗${color.reset}` : `${color.green}✓${color.reset}`;
	const lines = String(preview ?? '').split('\n').filter(Boolean).slice(0, 6);
	if (!lines.length) {
		console.log(`${color.dim}    ${mark}${color.reset}`);
		return;
	}
	console.log(`${color.dim}    ${mark} ${truncate(lines[0], cols() - 8)}${color.reset}`);
	for (const l of lines.slice(1)) {
		console.log(`${color.dim}      ${truncate(l, cols() - 8)}${color.reset}`);
	}
}

export function writeAssistantDelta(delta) {
	if (!streaming) {
		process.stdout.write(`\n${color.green}╭─ copix${color.reset}\n${color.green}│${color.reset} `);
		streaming = true;
	}
	const text = String(delta ?? '');
	process.stdout.write(text.replace(/\n/g, `\n${color.green}│${color.reset} `));
}

export function endAssistantStream() {
	if (streaming) {
		process.stdout.write(`\n${color.green}╰${color.reset}\n`);
		streaming = false;
	} else {
		process.stdout.write('\n');
	}
}

export function writeError(message) {
	if (streaming) {
		process.stdout.write('\n');
		streaming = false;
	}
	const width = cols() - 4;
	console.log(`${color.red}╭─ error${color.reset}`);
	for (const l of wrapText(message, width)) {
		console.log(`${color.red}│${color.reset} ${l}`);
	}
	console.log(`${color.red}╰${color.reset}`);
	console.log('');
}

export function modelListText(activeModel, installed = []) {
	const lines = [
		hr(),
		`${color.bold}Models${color.reset}`,
		`${color.dim}active${color.reset}     ${activeModel}`,
		'',
		`${color.bold}Installed (ollama)${color.reset}`,
	];
	if (!installed.length) {
		lines.push(`${color.dim}  (none — run ollama pull qwen2.5:3b)${color.reset}`);
	} else {
		for (const tag of installed) {
			const mark = String(activeModel).includes(tag) || tag.startsWith(String(activeModel).replace(/^ollama\//, ''))
				? `${color.green}●${color.reset}`
				: `${color.dim}○${color.reset}`;
			lines.push(`  ${mark} ${tag}`);
		}
	}
	lines.push('', `${color.dim}Copix prefers your installed model when stretch tags are missing.${color.reset}`, hr());
	return lines.join('\n');
}

export function helpText() {
	return [
		hr(),
		`${color.bold}Copix CLI${color.reset}  — same agent & tools as Copix Desktop`,
		'',
		`${color.bold}Usage${color.reset}`,
		'  copix                     interactive session',
		'  copix "prompt"            one-shot',
		'  copix -p <dir> "prompt"   workspace directory',
		'',
		`${color.bold}Slash commands${color.reset}`,
		'  /help       this help',
		'  /model      show active model + installed Ollama tags',
		'  /cwd        print workspace',
		'  /clear      clear chat history',
		'  /exit       quit',
		'',
		`${color.bold}Tools${color.reset}`,
		'  create_project  edit_file  write_file  append_file  delete_file',
		'  read_file  list_dir  grep  terminal  multitask  spawn_subagent',
		'',
		`${color.bold}Settings${color.reset}`,
		'  ~/Copix/settings.json   provider: ollama   modelId: qwen2.5:3b',
		'  ollama pull qwen2.5:3b',
		hr(),
	].join('\n');
}
