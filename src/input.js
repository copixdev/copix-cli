/**
 * Interactive prompt box with slash-command menu.
 * Raw-mode line editor: type inside the rectangle, `/` opens the menu,
 * ↑/↓ navigate, Tab completes, Enter submits.
 * Ctrl+J or a trailing backslash then Enter continues on the next line.
 * Ctrl+C clears the line and quits only when the line is already empty.
 */
import readline from 'node:readline';
import { color, displayWidth, fitLine, isPlain, repaintFrame, stripAnsi, termCols } from './ui.js';

const ESC = '\x1b[';

function cols() {
	return termCols();
}

function padToWidth(s, width) {
	const w = displayWidth(s);
	return w >= width ? s : `${s}${' '.repeat(width - w)}`;
}

export const SLASH_COMMANDS = [
	{ cmd: '/model', args: '[tag|auto]', desc: 'Pick a model, or pin a tag (e.g. /model qwen2.5:3b)' },
	{ cmd: '/models', args: '', desc: 'List installed Ollama models' },
	{ cmd: '/pull', args: '<tag>', desc: 'Download an Ollama model (ollama pull)' },
	{ cmd: '/cwd', args: '[path]', desc: 'Show or change the workspace directory' },
	{ cmd: '/status', args: '', desc: 'Ollama status, model, workspace, version' },
	{ cmd: '/doctor', args: '', desc: 'Check Node, Ollama, models, and install paths' },
	{ cmd: '/context', args: '', desc: 'Turns and estimated tokens in this chat' },
	{ cmd: '/copy', args: '', desc: 'Copy the last reply' },
	{ cmd: '/undo', args: '', desc: 'Restore the last file edit' },
	{ cmd: '/history', args: '', desc: 'Recent agent sessions (synced with Desktop)' },
	{ cmd: '/new', args: '', desc: 'Start a fresh conversation' },
	{ cmd: '/clear', args: '', desc: 'Clear the screen and start fresh' },
	{ cmd: '/keys', args: '', desc: 'Keyboard shortcuts for the prompt and picker' },
	{ cmd: '/plain', args: '[on|off]', desc: 'Toggle screen-reader plain text' },
	{ cmd: '/help', args: '', desc: 'Show usage, tools, and settings' },
	{ cmd: '/exit', args: '', desc: 'Quit Copix' },
];

function editDistance(a, b) {
	const s = String(a);
	const t = String(b);
	const dp = Array.from({ length: s.length + 1 }, () => new Array(t.length + 1).fill(0));
	for (let i = 0; i <= s.length; i++) dp[i][0] = i;
	for (let j = 0; j <= t.length; j++) dp[0][j] = j;
	for (let i = 1; i <= s.length; i++) {
		for (let j = 1; j <= t.length; j++) {
			const cost = s[i - 1] === t[j - 1] ? 0 : 1;
			dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
		}
	}
	return dp[s.length][t.length];
}

function closestCommands(query, limit) {
	return SLASH_COMMANDS
		.map((command) => ({ command, distance: editDistance(query, command.cmd.slice(1).toLowerCase()) }))
		.filter((item) => item.distance > 0 && item.distance <= 2)
		.sort((a, b) => a.distance - b.distance || a.command.cmd.localeCompare(b.command.cmd))
		.slice(0, limit)
		.map((item) => item.command);
}

export function filteredCommands(buffer) {
	if (!buffer.startsWith('/')) return [];
	if (/\s/.test(buffer)) return []; // typing arguments — menu out of the way
	const q = buffer.slice(1).toLowerCase();
	if (q.includes('\\')) return [];
	const prefix = SLASH_COMMANDS.filter((command) => command.cmd.slice(1).toLowerCase().startsWith(q));
	if (prefix.length || !q) return prefix;
	return closestCommands(q, 4);
}

/** Nearest real commands for a mistyped slash token. Empty when it already matches. */
export function suggestCommands(token, limit = 3) {
	const raw = String(token ?? '').trim().toLowerCase();
	if (!raw.startsWith('/') || /\s/.test(raw.slice(1))) return [];
	const q = raw.slice(1);
	if (!q || SLASH_COMMANDS.some((command) => command.cmd === raw)) return [];
	return closestCommands(q, limit).map((command) => command.cmd);
}

/** Odd trailing backslashes continue the line. An even count is submitted as typed. */
export function continuedLine(buffer) {
	const text = String(buffer ?? '');
	let count = 0;
	for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i--) count += 1;
	if (count % 2 === 0) return null;
	return `${text.slice(0, -1)}\n`;
}

function cursorPoint(buffer, cursor) {
	const text = String(buffer ?? '');
	const rows = text.split('\n');
	let left = Math.max(0, Math.min(cursor, text.length));
	for (let i = 0; i < rows.length; i++) {
		if (left <= rows[i].length || i === rows.length - 1) {
			return { row: i, col: Math.min(left, rows[i].length), rows };
		}
		left -= rows[i].length + 1;
	}
	return { row: 0, col: 0, rows };
}

/** Move between visual lines. Null at the edge so the caller can recall history. */
export function moveCursorVertically(buffer, cursor, direction) {
	const text = String(buffer ?? '');
	const rows = text.split('\n');
	if (rows.length < 2) return null;
	const point = cursorPoint(text, cursor);
	const next = point.row + direction;
	if (next < 0 || next >= rows.length) return null;
	const col = Math.min(point.col, rows[next].length);
	let index = col;
	for (let i = 0; i < next; i++) index += rows[i].length + 1;
	return index;
}

export function lineBoundary(buffer, cursor, which) {
	const text = String(buffer ?? '');
	const at = Math.max(0, Math.min(cursor, text.length));
	if (which === 'start') {
		if (at === 0) return 0;
		return text.lastIndexOf('\n', at - 1) + 1;
	}
	const end = text.indexOf('\n', at);
	return end === -1 ? text.length : end;
}

export function parseSubmission(line) {
	const text = String(line ?? '').replace(/\r\n/g, '\n').trim();
	if (!text) return { kind: 'empty', text: '', cmd: '', arg: '' };
	if (text === 'exit') return { kind: 'command', text, cmd: '/exit', arg: '' };
	const head = text.split('\n')[0].trim();
	if (!head.startsWith('/')) return { kind: 'prompt', text, cmd: '', arg: '' };
	const flat = text.replace(/\s+/g, ' ').trim();
	const [cmd, ...rest] = flat.split(' ');
	return { kind: 'command', text, cmd, arg: rest.join(' ') };
}

function insertNewline(buffer, cursor) {
	const next = buffer.slice(0, cursor) + '\n' + buffer.slice(cursor);
	return { buffer: next, cursor: cursor + 1 };
}

export function promptFrame({
	buffer = '',
	cursor = 0,
	placeholder = 'Ask, plan, build anything',
	menu = [],
	menuIndex = 0,
	footer = [],
	final = false,
	width,
} = {}) {
	const frameWidth = width || cols();
	const inner = frameWidth - 4;
	const avail = Math.max(8, inner - 2);
	const lines = [];
	const point = cursorPoint(buffer, cursor);
	const rows = point.rows;
	const maxRows = 6;
	let start = 0;
	let end = rows.length;
	if (!buffer && !final) {
		end = 1;
	} else if (!final && rows.length > maxRows) {
		start = Math.max(0, Math.min(point.row - 2, rows.length - maxRows));
		end = start + maxRows;
	}

	const rowText = (logical) => {
		if (!buffer && !final) return `${color.muted}${placeholder}${color.reset}`;
		const row = rows[logical] ?? '';
		if (final) {
			let out = row;
			while (displayWidth(out) > avail) out = `…${out.slice(2)}`;
			return out;
		}
		if (logical !== point.row) return displayWidth(row) > avail ? fitLine(row, avail) : row;
		const chars = [...row];
		const cpCursor = [...row.slice(0, point.col)].length;
		let startCh = 0;
		while (displayWidth(chars.slice(startCh, cpCursor).join('')) > avail - 2) startCh += 1;
		let endCh = chars.length;
		while (displayWidth(chars.slice(startCh, endCh).join('')) > avail - 1 && endCh > cpCursor) endCh -= 1;
		const before = chars.slice(startCh, cpCursor).join('');
		const at = chars.slice(cpCursor, cpCursor + 1).join('') || ' ';
		const after = chars.slice(cpCursor + 1, endCh).join('');
		const scrolled = startCh > 0 ? `${color.muted}…${color.reset}` : '';
		return `${scrolled}${before}${ESC}7m${at}${ESC}27m${after}`;
	};

	lines.push(`${color.dim}╭${'─'.repeat(Math.max(0, frameWidth - 2))}╮${color.reset}`);
	for (let logical = start; logical < end; logical += 1) {
		const prefix = logical === 0 ? `${color.clay}→${color.reset} ` : '  ';
		const text = rowText(logical);
		lines.push(`${color.dim}│${color.reset} ${prefix}${padToWidth(text, Math.max(0, inner - 2))} ${color.dim}│${color.reset}`);
	}
	lines.push(`${color.dim}╰${'─'.repeat(Math.max(0, frameWidth - 2))}╯${color.reset}`);

	if (menu.length && !final) {
		const idx = Math.min(Math.max(menuIndex, 0), menu.length - 1);
		for (let i = 0; i < menu.length; i += 1) {
			const item = menu[i];
			const selected = i === idx;
			const mark = selected ? `${color.clay}→${color.reset}` : ' ';
			const label = `${item.cmd}${item.args ? ` ${item.args}` : ''}`;
			const cmd = selected ? `${color.clay}${label}${color.reset}` : label;
			lines.push(fitLine(`${mark} ${padToWidth(cmd, 22)} ${color.muted}${item.desc}${color.reset}`, frameWidth));
		}
	} else if (!final) {
		for (const line of footer) lines.push(fitLine(line, frameWidth));
	}
	return lines;
}

function readPlainPrompt({ placeholder, footer }) {
	return new Promise((resolve) => {
		for (const line of footer) {
			const text = stripAnsi(line).trim();
			if (text) process.stdout.write(`${text}\n`);
		}
		if (placeholder && footer.length === 0) process.stdout.write(`${placeholder}\n`);
		let settled = false;
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: Boolean(process.stdin.isTTY),
		});
		const parts = [];
		const done = (value) => {
			if (settled) return;
			settled = true;
			rl.close();
			resolve(value);
		};
		rl.on('SIGINT', () => {
			// Same rule as the drawn prompt: clear a typed line, quit only when it is empty.
			if (rl.line && rl.line.length > 0) {
				if (typeof rl._moveCursor === 'function') rl._moveCursor(Infinity);
				if (typeof rl._deleteLineLeft === 'function') rl._deleteLineLeft();
				return;
			}
			done(null);
		});
		rl.on('close', () => done(null));
		const ask = () => {
			if (settled) return;
			rl.question(parts.length ? '... ' : '> ', (answer) => {
				const typed = String(answer ?? '');
				const next = continuedLine(typed);
				if (next != null) {
					parts.push(next);
					ask();
					return;
				}
				parts.push(typed);
				done(parts.join('').trim());
			});
		};
		ask();
	});
}

/**
 * Read one line inside a drawn box. Returns the submitted string,
 * or null on Ctrl+D / Ctrl+C with an empty buffer.
 * Ctrl+C with text clears the line. ↑/↓ recall `history` when the slash menu is closed.
 * Plain-text mode uses a normal line so a screen reader can follow it.
 */
export function readPrompt({ placeholder = 'Ask, plan, build anything', footer = [], history = [] } = {}) {
	if (isPlain()) return readPlainPrompt({ placeholder, footer });
	return new Promise((resolve) => {
		const stdin = process.stdin;
		const stdout = process.stdout;
		let buffer = '';
		let cursor = 0;
		let menuIndex = 0;
		let drawnLines = [];
		let historyIndex = history.length;
		let draft = '';

		const wasRaw = stdin.isRaw;
		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
		stdout.write(`${ESC}?25l`); // hide hardware cursor — we draw our own
		const onResize = () => render();
		stdout.on('resize', onResize);

		function render(final = false) {
			const menu = final ? [] : filteredCommands(buffer);
			if (menuIndex >= menu.length) menuIndex = Math.max(0, menu.length - 1);
			const lines = promptFrame({
				buffer,
				cursor,
				placeholder,
				menu,
				menuIndex,
				footer,
				final,
				width: cols(),
			});
			// Repaint from the top of the previous frame. After a narrow resize the
			// terminal has rewrapped those lines, so the cursor-up count is the
			// reflowed row count, then the rest of the screen is cleared.
			drawnLines = repaintFrame(
				(chunk) => stdout.write(chunk),
				drawnLines,
				lines,
				stdout.columns || 80,
			);
		}

		function breakLine() {
			const next = insertNewline(buffer, cursor);
			buffer = next.buffer;
			cursor = next.cursor;
			menuIndex = 0;
			historyIndex = history.length;
			render();
		}

		function finish(result) {
			render(true);
			stdout.write(`${ESC}?25h`);
			stdout.off('resize', onResize);
			stdin.removeListener('data', onData);
			if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
			stdin.pause();
			resolve(result);
		}

		function onData(chunk) {
			const s = chunk.toString('utf8');
			const menu = filteredCommands(buffer);

			if (s === '\x03') { // Ctrl+C — clear the line; quit only when it is already empty
				if (buffer) {
					buffer = '';
					cursor = 0;
					menuIndex = 0;
					historyIndex = history.length;
					draft = '';
					render();
					return;
				}
				finish(null);
				return;
			}
			if (s === '\x04') { // Ctrl+D
				if (!buffer) { finish(null); return; }
				return;
			}
			if (s === '\n' || s === '\x1b\r' || s === '\x1b\n' || s === '\x1b[13;2u') {
				breakLine();
				return;
			}
			const nl = s.search(/[\r\n]/);
			if (nl >= 0) {
				const before = s.slice(0, nl).replace(/[\x00-\x1f]/g, '');
				let rest = s.slice(nl + 1);
				if (s[nl] === '\r' && rest.startsWith('\n')) rest = rest.slice(1);
				if (before) {
					buffer = buffer.slice(0, cursor) + before + buffer.slice(cursor);
					cursor += before.length;
				}
				const menuNow = filteredCommands(buffer);
				const cont = continuedLine(buffer);
				if (cont != null) {
					buffer = cont;
					cursor = buffer.length;
					menuIndex = 0;
					historyIndex = history.length;
					render();
					if (rest) stdin.unshift(Buffer.from(rest, 'utf8'));
					return;
				}
				if (menuNow.length && buffer !== menuNow[menuIndex]?.cmd && !before) {
					buffer = menuNow[Math.min(menuIndex, menuNow.length - 1)].cmd;
					cursor = buffer.length;
				}
				finish(buffer.trim());
				// keep remaining piped lines for the next prompt (after listener detached)
				if (rest) stdin.unshift(Buffer.from(rest, 'utf8'));
				return;
			}
			if (s === '\t') {
				if (menu.length) {
					buffer = menu[menuIndex].cmd;
					cursor = buffer.length;
				}
				render();
				return;
			}
			if (s === `${ESC}A` || s === '\x1bOA') { // up — menu, previous line, or earlier prompt
				if (menu.length) menuIndex = (menuIndex - 1 + menu.length) % menu.length;
				else {
					const next = moveCursorVertically(buffer, cursor, -1);
					if (next != null) cursor = next;
					else if (history.length && historyIndex > 0) {
						if (historyIndex === history.length) draft = buffer;
						historyIndex -= 1;
						buffer = history[historyIndex] ?? '';
						cursor = buffer.length;
					}
				}
				render();
				return;
			}
			if (s === `${ESC}B` || s === '\x1bOB') { // down
				if (menu.length) menuIndex = (menuIndex + 1) % menu.length;
				else {
					const next = moveCursorVertically(buffer, cursor, 1);
					if (next != null) cursor = next;
					else if (historyIndex < history.length) {
						historyIndex += 1;
						buffer = historyIndex === history.length ? draft : (history[historyIndex] ?? '');
						cursor = buffer.length;
					}
				}
				render();
				return;
			}
			if (s === `${ESC}D` || s === '\x1bOD') { // left
				cursor = Math.max(0, cursor - 1);
				render();
				return;
			}
			if (s === `${ESC}C` || s === '\x1bOC') { // right
				cursor = Math.min(buffer.length, cursor + 1);
				render();
				return;
			}
			if (s === `${ESC}H` || s === '\x01' || s === `${ESC}1~`) { cursor = lineBoundary(buffer, cursor, 'start'); render(); return; }
			if (s === `${ESC}F` || s === '\x05' || s === `${ESC}4~`) { cursor = lineBoundary(buffer, cursor, 'end'); render(); return; }
			if (s === `${ESC}3~`) { // delete
				if (cursor < buffer.length) {
					buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
					menuIndex = 0;
					historyIndex = history.length;
				}
				render();
				return;
			}
			if (s === '\x7f' || s === '\b') { // backspace
				if (cursor > 0) {
					buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
					cursor--;
					menuIndex = 0;
					historyIndex = history.length;
				}
				render();
				return;
			}
			if (s === '\x15') { // Ctrl+U — clear line
				buffer = '';
				cursor = 0;
				menuIndex = 0;
				historyIndex = history.length;
				draft = '';
				render();
				return;
			}
			if (s.startsWith('\x1b')) return; // other escape sequences

			// printable input (including pasted text)
			const clean = s.replace(/[\x00-\x1f]/g, '');
			if (clean) {
				buffer = buffer.slice(0, cursor) + clean + buffer.slice(cursor);
				cursor += clean.length;
				menuIndex = 0;
				historyIndex = history.length;
				render();
			}
		}

		stdin.on('data', onData);
		render();
	});
}
