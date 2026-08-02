/**
 * Interactive prompt box with slash-command menu (Cursor Agent style).
 * Raw-mode line editor: type inside the rectangle, `/` opens the menu,
 * ↑/↓ navigate, Tab completes, Enter submits, Ctrl+C cancels.
 */
import { color } from './ui.js';

const ESC = '\x1b[';

function cols() {
	return Math.max(52, Math.min(process.stdout.columns || 80, 88));
}

function stripAnsi(s) {
	return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** Approximate display width (CJK counts as 2). */
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

export const SLASH_COMMANDS = [
	{ cmd: '/model', args: '[tag|auto]', desc: 'Show models, or switch (e.g. /model qwen2.5:3b)' },
	{ cmd: '/models', args: '', desc: 'List installed Ollama models' },
	{ cmd: '/pull', args: '<tag>', desc: 'Download an Ollama model (ollama pull)' },
	{ cmd: '/cwd', args: '[path]', desc: 'Show or change the workspace directory' },
	{ cmd: '/status', args: '', desc: 'Ollama status, model, workspace, version' },
	{ cmd: '/history', args: '', desc: 'Recent agent sessions (synced with Desktop)' },
	{ cmd: '/new', args: '', desc: 'Start a fresh conversation' },
	{ cmd: '/clear', args: '', desc: 'Clear the screen and start fresh' },
	{ cmd: '/help', args: '', desc: 'Show usage, tools, and settings' },
	{ cmd: '/exit', args: '', desc: 'Quit Copix' },
];

function filteredCommands(buffer) {
	if (!buffer.startsWith('/')) return [];
	if (/\s/.test(buffer)) return []; // typing arguments — menu out of the way
	const q = buffer.slice(1).toLowerCase();
	return SLASH_COMMANDS.filter(c => c.cmd.slice(1).startsWith(q));
}

/**
 * Read one line inside a drawn box. Returns the submitted string,
 * or null on Ctrl+C / Ctrl+D with empty buffer.
 */
export function readPrompt({ placeholder = 'Ask, plan, build anything', footer = [] } = {}) {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		const stdout = process.stdout;
		let buffer = '';
		let cursor = 0;
		let menuIndex = 0;
		let renderedLines = 0;

		const wasRaw = stdin.isRaw;
		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
		stdout.write(`${ESC}?25l`); // hide hardware cursor — we draw our own

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
			const arrow = `${color.accent}→${color.reset} `;
			const inputLine = `${color.dim}│${color.reset} ${arrow}${padToWidth(text, Math.max(0, inner - 2))} ${color.dim}│${color.reset}`;

			lines.push(`${color.dim}╭${'─'.repeat(width - 2)}╮${color.reset}`);
			lines.push(inputLine);
			lines.push(`${color.dim}╰${'─'.repeat(width - 2)}╯${color.reset}`);

			if (menu.length) {
				for (let i = 0; i < menu.length; i++) {
					const m = menu[i];
					const sel = i === menuIndex;
					const mark = sel ? `${color.accent}→${color.reset}` : ' ';
					const label = `${m.cmd}${m.args ? ` ${m.args}` : ''}`;
					const cmd = sel ? `${color.bold}${label}${color.reset}` : label;
					lines.push(`${mark} ${padToWidth(cmd, 22)} ${color.muted}${m.desc}${color.reset}`);
				}
			} else if (!final) {
				for (const f of footer) lines.push(f);
			}

			// repaint block in place
			if (renderedLines > 0) {
				stdout.write(`${ESC}${renderedLines}A`);
			}
			for (const line of lines) {
				stdout.write(`\r${ESC}2K${line}\n`);
			}
			// clear leftover lines from a previously taller frame
			const extra = renderedLines - lines.length;
			if (extra > 0) {
				for (let i = 0; i < extra; i++) stdout.write(`\r${ESC}2K\n`);
				stdout.write(`${ESC}${extra}A`);
			}
			renderedLines = lines.length;
		}

		function finish(result) {
			render(true);
			stdout.write(`${ESC}?25h`);
			stdin.removeListener('data', onData);
			if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
			stdin.pause();
			resolve(result);
		}

		function onData(chunk) {
			const s = chunk.toString('utf8');
			const menu = filteredCommands(buffer);

			if (s === '\x03') { // Ctrl+C
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
			if (s === `${ESC}A`) { // up
				if (menu.length) menuIndex = (menuIndex - 1 + menu.length) % menu.length;
				render();
				return;
			}
			if (s === `${ESC}B`) { // down
				if (menu.length) menuIndex = (menuIndex + 1) % menu.length;
				render();
				return;
			}
			if (s === `${ESC}D`) { // left
				cursor = Math.max(0, cursor - 1);
				render();
				return;
			}
			if (s === `${ESC}C`) { // right
				cursor = Math.min(buffer.length, cursor + 1);
				render();
				return;
			}
			if (s === `${ESC}H` || s === '\x01') { cursor = 0; render(); return; }
			if (s === `${ESC}F` || s === '\x05') { cursor = buffer.length; render(); return; }
			if (s === '\x7f' || s === '\b') { // backspace
				if (cursor > 0) {
					buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
					cursor--;
					menuIndex = 0;
				}
				render();
				return;
			}
			if (s === '\x15') { // Ctrl+U — clear line
				buffer = '';
				cursor = 0;
				menuIndex = 0;
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
				render();
			}
		}

		stdin.on('data', onData);
		render();
	});
}
