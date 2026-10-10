/**
 * Copy the last reply. Uses the platform clipboard tool when one exists,
 * and otherwise writes ~/Copix/last-reply.txt.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function clipboardCandidates(platform = process.platform) {
	if (platform === 'win32') return [['clip', []]];
	if (platform === 'darwin') return [['pbcopy', []]];
	return [
		['wl-copy', []],
		['xclip', ['-selection', 'clipboard']],
		['xsel', ['--clipboard', '--input']],
	];
}

export function copyText(text, opts = {}) {
	const value = String(text ?? '');
	if (!value.trim()) return { ok: false, via: 'empty' };
	const platform = opts.platform ?? process.platform;
	const run = opts.run ?? defaultRun;
	for (const [cmd, args] of clipboardCandidates(platform)) {
		if (run(cmd, args, value)?.ok) return { ok: true, via: 'clipboard', command: cmd };
	}
	const dest = opts.dest ?? path.join(os.homedir(), 'Copix', 'last-reply.txt');
	const write = opts.writeFile ?? ((file, data) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, data);
	});
	write(dest, value.endsWith('\n') ? value : `${value}\n`);
	return { ok: true, via: 'file', path: dest };
}

function defaultRun(cmd, args, value) {
	const res = spawnSync(cmd, args, { input: value, encoding: 'utf8' });
	if (res.error || res.status !== 0) return { ok: false };
	return { ok: true };
}
