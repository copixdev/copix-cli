/**
 * Single-choice picker for the Copix CLI.
 * Raw mode matches the prompt (↑↓, enter, esc). Plain mode asks for a number or name.
 */
import readline from 'node:readline';
import { color, isPlain, termCols } from './ui.js';

const ESC = '\x1b[';

/** Kept in step with COPIX_MODEL_IDS in agent/models/modelCatalog.ts. */
export const SUGGESTED_MODELS = ['qwen2.5:3b', 'qwen2.5-coder:7b', 'mistral:7b', 'qwen3.5:4b'];

function cols() {
	return termCols();
}

/** Remove a block the cursor is sitting just below. Used when the picker closes. */
export function eraseBlock(write, lineCount) {
	if (lineCount <= 0) return;
	write(`${ESC}${lineCount}A`);
	for (let i = 0; i < lineCount; i++) write(`\r${ESC}2K\n`);
	write(`${ESC}${lineCount}A`);
}

function stripAnsi(s) {
	return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function charWidth(ch) {
	const code = ch.codePointAt(0) ?? 0;
	if (
		(code >= 0x1100 && code <= 0x115f)
		|| (code >= 0x2e80 && code <= 0xa4cf)
		|| (code >= 0xac00 && code <= 0xd7a3)
		|| (code >= 0xf900 && code <= 0xfaff)
		|| (code >= 0xff00 && code <= 0xff60)
		|| (code >= 0xffe0 && code <= 0xffe6)
	) return 2;
	return 1;
}

function displayWidth(s) {
	let w = 0;
	for (const ch of stripAnsi(s)) w += charWidth(ch);
	return w;
}

function padToWidth(s, width) {
	const w = displayWidth(s);
	return w >= width ? s : `${s}${' '.repeat(width - w)}`;
}

function truncatePlain(s, width) {
	const text = String(s ?? '');
	if (width <= 0) return '';
	if (displayWidth(text) <= width) return text;
	if (width === 1) return '…';
	let out = '';
	let w = 0;
	for (const ch of text) {
		const cw = charWidth(ch);
		if (w + cw > width - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

export function pickerWindow(length, index, size = 9) {
	const total = Math.max(0, length);
	const windowSize = Math.max(1, size);
	if (total <= windowSize) return { start: 0, end: total };
	const idx = Math.min(Math.max(index, 0), total - 1);
	let start = Math.max(0, idx - Math.floor((windowSize - 1) / 2));
	if (start + windowSize > total) start = total - windowSize;
	return { start, end: start + windowSize };
}

/**
 * Rows the /model picker offers. `auto` is always first.
 * Installed tags come next, then the usual Copix catalog tags that are missing.
 */
export function modelChoices({
	installed = [],
	selection = 'auto',
	modelId = '',
	suggested = SUGGESTED_MODELS,
} = {}) {
	const current = String(modelId || '').replace(/^ollama\//, '');
	const manual = selection === 'manual';
	const items = [{
		value: 'auto',
		label: 'auto',
		hint: manual ? 'route by task' : 'current · route by task',
	}];
	const seen = new Set(['auto']);
	const push = (tag, hint) => {
		const id = String(tag || '').trim();
		if (!id || seen.has(id)) return;
		seen.add(id);
		items.push({ value: id, label: id, hint });
	};
	for (const tag of installed) {
		const id = String(tag);
		push(id, manual && current === id ? 'installed · current' : 'installed');
	}
	for (const tag of suggested) {
		push(tag, manual && current === tag ? 'not installed · current' : 'not installed');
	}
	if (manual && current) push(current, 'current · not installed');
	return items;
}

export function initialModelIndex(items, model = {}) {
	if (model.selection === 'manual' && model.modelId) {
		const id = String(model.modelId).replace(/^ollama\//, '');
		const found = items.findIndex((item) => item.value === id);
		if (found >= 0) return found;
	}
	return 0;
}

/** Same install check the typed /model <tag> path already used. */
export function resolveModelChoice(choice, installed = []) {
	const raw = String(choice ?? '').trim();
	if (raw === 'auto') return { selection: 'auto', modelId: null, missing: false };
	const tag = raw.replace(/^ollama\//, '');
	const base = String(tag).split(':')[0];
	const missing = installed.length > 0 && !installed.some((m) => m === tag || m.startsWith(`${base}:`));
	return { selection: 'manual', modelId: tag, missing };
}

export function matchChoice(items, answer) {
	const raw = String(answer ?? '').trim();
	if (!raw) return null;
	if (/^\d+$/.test(raw)) {
		const n = Number(raw);
		if (n >= 1 && n <= items.length) return items[n - 1];
		return null;
	}
	const q = raw.toLowerCase();
	return items.find((item) => item.label.toLowerCase() === q || String(item.value).toLowerCase() === q) ?? null;
}

export function renderPickerLines({ label = 'Select', items = [], index = 0 } = {}) {
	const width = cols();
	const inner = width - 4;
	const idx = items.length ? Math.min(Math.max(index, 0), items.length - 1) : 0;
	const { start, end } = pickerWindow(items.length, idx, 9);
	const body = [];
	if (start > 0) body.push(`${color.muted}${start} more above${color.reset}`);
	for (let i = start; i < end; i++) body.push(pickerRow(items[i], i, i === idx, inner));
	if (end < items.length) body.push(`${color.muted}${items.length - end} more below${color.reset}`);

	const lines = [
		`${color.dim}╭${'─'.repeat(width - 2)}╮${color.reset}`,
		`${color.dim}│${color.reset} ${padToWidth(`${color.muted}${truncatePlain(label, inner)}${color.reset}`, inner)} ${color.dim}│${color.reset}`,
	];
	for (const row of body) {
		lines.push(`${color.dim}│${color.reset} ${padToWidth(row, inner)} ${color.dim}│${color.reset}`);
	}
	lines.push(`${color.dim}╰${'─'.repeat(width - 2)}╯${color.reset}`);
	lines.push(`${color.muted}↑↓ move  ·  1-9 jump  ·  enter select  ·  esc cancel${color.reset}`);
	return lines;
}

function pickerRow(item, i, selected, inner) {
	const n = String(i + 1).padStart(2, ' ');
	const fixed = 6;
	const room = Math.max(1, inner - fixed);
	const gap = '  ';
	let label = String(item.label);
	let hint = item.hint ? String(item.hint) : '';
	if (hint && label.length + gap.length + hint.length > room) {
		const hintRoom = room - label.length - gap.length;
		hint = hintRoom >= 3 ? truncatePlain(hint, hintRoom) : '';
	}
	if (displayWidth(label) > room) {
		label = truncatePlain(label, room);
		hint = '';
	}
	const labelAnsi = selected ? `${color.bold}${label}${color.reset}` : label;
	const hintAnsi = hint ? `${gap}${color.muted}${hint}${color.reset}` : '';
	const mark = selected ? `${color.accent}→${color.reset}` : ' ';
	return `${mark} ${n}  ${labelAnsi}${hintAnsi}`;
}

function readLine(prompt) {
	return new Promise((resolve) => {
		let settled = false;
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: Boolean(process.stdin.isTTY),
		});
		const done = (value) => {
			if (settled) return;
			settled = true;
			rl.close();
			resolve(value);
		};
		rl.on('SIGINT', () => done({ answer: null, submitted: false }));
		rl.on('close', () => done({ answer: null, submitted: false }));
		rl.question(prompt, (answer) => done({ answer: String(answer ?? ''), submitted: true }));
	});
}

function erasePicker(lineCount, { cursorBelow }) {
	const stdout = process.stdout;
	if (!stdout.isTTY || lineCount <= 0) return;
	const write = (chunk) => stdout.write(chunk);
	if (cursorBelow) {
		eraseBlock(write, lineCount);
		return;
	}
	const above = Math.max(0, lineCount - 1);
	if (above) write(`${ESC}${above}A`);
	for (let i = 0; i < lineCount; i++) write(`\r${ESC}2K\n`);
	write(`${ESC}${lineCount}A`);
}

async function selectPlain({ label, items }) {
	console.log('');
	console.log(label);
	for (let i = 0; i < items.length; i++) {
		const hint = items[i].hint ? ` - ${items[i].hint}` : '';
		console.log(`${i + 1}. ${items[i].label}${hint}`);
	}
	const answer = await readLine('Choose a number or name (empty cancels): ');
	// Blank line, label, each row, and the question line.
	erasePicker(items.length + 3, { cursorBelow: Boolean(answer?.submitted) });
	const text = answer?.answer;
	if (text == null || !String(text).trim()) return { item: null, reason: 'cancel' };
	const item = matchChoice(items, text);
	if (!item) return { item: null, reason: 'invalid' };
	return { item, reason: 'selected' };
}

function selectRaw({ label, items, initialIndex = 0 }) {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		const stdout = process.stdout;
		let index = Math.min(Math.max(initialIndex, 0), items.length - 1);
		let renderedLines = 0;
		const wasRaw = stdin.isRaw;
		stdin.setRawMode(true);
		stdin.resume();
		stdout.write(`${ESC}?25l`);

		function render() {
			const lines = renderPickerLines({ label, items, index });
			if (renderedLines > 0) stdout.write(`${ESC}${renderedLines}A`);
			for (const line of lines) stdout.write(`\r${ESC}2K${line}\n`);
			const extra = renderedLines - lines.length;
			if (extra > 0) {
				for (let i = 0; i < extra; i++) stdout.write(`\r${ESC}2K\n`);
				stdout.write(`${ESC}${extra}A`);
			}
			renderedLines = lines.length;
		}

		let closed = false;
		let partial = '';
		let escTimer = null;

		function move(delta) {
			index = (index + delta + items.length) % items.length;
			render();
		}

		function finish(item) {
			if (closed) return;
			closed = true;
			if (escTimer) clearTimeout(escTimer);
			eraseBlock((chunk) => stdout.write(chunk), renderedLines);
			renderedLines = 0;
			stdout.write(`${ESC}?25h`);
			stdin.removeListener('data', onData);
			if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
			stdin.pause();
			resolve(item);
		}

		// One chunk can hold several keys (arrow then enter). A lone Esc waits
		// briefly so a split arrow sequence is not treated as cancel.
		function consume(text) {
			let i = 0;
			while (i < text.length) {
				if (closed) return '';
				const rest = text.slice(i);
				if (rest === '\x1b' || rest === '\x1b[' || rest === '\x1bO') return rest;
				if (rest.startsWith('\x1b[A') || rest.startsWith('\x1bOA')) { move(-1); i += 3; continue; }
				if (rest.startsWith('\x1b[B') || rest.startsWith('\x1bOB')) { move(1); i += 3; continue; }
				if (rest.startsWith('\x1b[H')) { index = 0; render(); i += 3; continue; }
				if (rest.startsWith('\x1b[F')) { index = items.length - 1; render(); i += 3; continue; }
				if (
					rest.startsWith('\x1b[C') || rest.startsWith('\x1b[D')
					|| rest.startsWith('\x1bOC') || rest.startsWith('\x1bOD')
				) { i += 3; continue; }
				const csi = rest.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
				if (csi) { i += csi[0].length; continue; }
				if (rest.startsWith('\x1b')) { finish(null); return ''; }
				const ch = rest[0];
				if (ch === '\x03') { finish(null); return ''; }
				if (ch === '\r' || ch === '\n') { finish(items[index]); return ''; }
				if (ch === 'k') { move(-1); i += 1; continue; }
				if (ch === 'j') { move(1); i += 1; continue; }
				if (ch === '\x01') { index = 0; render(); i += 1; continue; }
				if (ch === '\x05') { index = items.length - 1; render(); i += 1; continue; }
				if (ch >= '1' && ch <= '9') {
					const n = Number(ch);
					if (n <= items.length) {
						index = n - 1;
						render();
					}
					i += 1;
					continue;
				}
				i += 1;
			}
			return '';
		}

		function onData(chunk) {
			if (closed) return;
			partial = consume(partial + chunk.toString('utf8'));
			if (closed) return;
			if (escTimer) clearTimeout(escTimer);
			escTimer = null;
			if (partial === '\x1b') {
				escTimer = setTimeout(() => {
					partial = '';
					finish(null);
				}, 40);
			}
		}

		stdin.on('data', onData);
		render();
	});
}

/**
 * Ask the user to pick one item.
 * Returns `{ item, reason }` where reason is selected, cancel, invalid, or unavailable.
 */
export async function selectOption({ label = 'Select', items = [], initialIndex = 0 } = {}) {
	if (!items.length) return { item: null, reason: 'cancel' };
	const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (!tty) return { item: null, reason: 'unavailable' };
	if (isPlain()) return selectPlain({ label, items });
	const item = await selectRaw({ label, items, initialIndex });
	return item ? { item, reason: 'selected' } : { item: null, reason: 'cancel' };
}
