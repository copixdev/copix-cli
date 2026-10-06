/**
 * Interactive prompt box with slash-command menu (Cursor Agent style).
 * Raw-mode line editor: type inside the rectangle, `/` opens the menu,
 * ↑/↓ navigate, Tab completes, Enter submits.
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
	{ cmd: '/history', args: '', desc: 'Recent agent sessions (synced with Desktop)' },
	{ cmd: '/new', args: '', desc: 'Start a fresh conversation' },
	{ cmd: '/clear', args: '', desc: 'Clear the screen and start fresh' },
	{ cmd: '/keys', args: '', desc: 'Keyboard shortcuts for the prompt and picker' },
	{ cmd: '/plain', args: '[on|off]', desc: 'Toggle screen-reader plain text' },
	{ cmd: '/help', args: '', desc: 'Show usage, tools, and settings' },
	{ cmd: '/exit', args: '', desc: 'Quit Copix' },
];

function filteredCommands(buffer) {
	if (!buffer.startsWith('/')) return [];
	if (/\s/.test(buffer)) return []; // typing arguments — menu out of the way
	const q = buffer.slice(1).toLowerCase();
	return SLASH_COMMANDS.filter(c => c.cmd.slice(1).startsWith(q));
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
		rl.question('> ', (answer) => done(String(answer ?? '').trim()));
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
			const width = cols();
			const inner = width - 4;
			const lines = [];
			const menu = final ? [] : filteredCommands(buffer);
			if (menuIndex >= menu.length) menuIndex = Math.max(0, menu.length - 1);

			// input text with block cursor (windowed so long input scrolls, not wraps)
			const avail = Math.max(8, inner - 2);
			let text;
			if (!buffer && !final) {
				text = `${color.muted}${placeholder}${color.reset}`;
			} else if (final) {
				let out = buffer;
				while (displayWidth(out) > avail) out = `…${out.slice(2)}`;
				text = out;
			} else {
				const chars = [...buffer];
				let start = 0;
				while (displayWidth(chars.slice(start, cursor).join('')) > avail - 2) start++;
				let end = chars.length;
				while (displayWidth(chars.slice(start, end).join('')) > avail - 1 && end > cursor) end--;
				const before = chars.slice(start, cursor).join('');
				const at = chars.slice(cursor, cursor + 1).join('') || ' ';
				const after = chars.slice(cursor + 1, end).join('');
				const scrolled = start > 0 ? `${color.muted}…${color.reset}` : '';
				text = `${scrolled}${before}${ESC}7m${at}${ESC}27m${after}`;
			}
			const arrow = `${color.clay}→${color.reset} `;
			const inputLine = `${color.dim}│${color.reset} ${arrow}${padToWidth(text, Math.max(0, inner - 2))} ${color.dim}│${color.reset}`;

			lines.push(`${color.dim}╭${'─'.repeat(width - 2)}╮${color.reset}`);
			lines.push(inputLine);
			lines.push(`${color.dim}╰${'─'.repeat(width - 2)}╯${color.reset}`);

			if (menu.length) {
				for (let i = 0; i < menu.length; i++) {
					const m = menu[i];
					const sel = i === menuIndex;
					const mark = sel ? `${color.clay}→${color.reset}` : ' ';
					const label = `${m.cmd}${m.args ? ` ${m.args}` : ''}`;
					const cmd = sel ? `${color.clay}${label}${color.reset}` : label;
					lines.push(fitLine(`${mark} ${padToWidth(cmd, 22)} ${color.muted}${m.desc}${color.reset}`, width));
				}
			} else if (!final) {
				for (const f of footer) lines.push(fitLine(f, width));
			}

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
			if (s === `${ESC}A` || s === '\x1bOA') { // up — menu, or earlier prompt
				if (menu.length) menuIndex = (menuIndex - 1 + menu.length) % menu.length;
				else if (history.length && historyIndex > 0) {
					if (historyIndex === history.length) draft = buffer;
					historyIndex -= 1;
					buffer = history[historyIndex] ?? '';
					cursor = buffer.length;
				}
				render();
				return;
			}
			if (s === `${ESC}B` || s === '\x1bOB') { // down
				if (menu.length) menuIndex = (menuIndex + 1) % menu.length;
				else if (historyIndex < history.length) {
					historyIndex += 1;
					buffer = historyIndex === history.length ? draft : (history[historyIndex] ?? '');
					cursor = buffer.length;
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
			if (s === `${ESC}H` || s === '\x01' || s === `${ESC}1~`) { cursor = 0; render(); return; }
			if (s === `${ESC}F` || s === '\x05' || s === `${ESC}4~`) { cursor = buffer.length; render(); return; }
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
