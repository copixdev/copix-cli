import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

function resolvePath(filePath, workspaceRoot) {
	const root = workspaceRoot || process.cwd();
	if (!filePath || filePath === '.' || filePath === './') return root;
	if (path.isAbsolute(filePath)) return filePath;
	return path.resolve(root, filePath);
}

function isSensitive(filePath) {
	const base = path.basename(filePath).toLowerCase();
	return (
		base === '.env'
		|| base.endsWith('.env')
		|| base.includes('credentials')
		|| base === 'id_rsa'
		|| base === 'id_ed25519'
		|| /\.(pem|key)$/i.test(base)
	);
}

export const TOOL_DEFS = [
	{
		type: 'function',
		function: {
			name: 'list_dir',
			description: 'List files and folders in a directory (relative to workspace).',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Directory path (default: workspace root)' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read a UTF-8 text file from the workspace.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path' },
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'write_file',
			description: 'Create or overwrite a UTF-8 text file in the workspace.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path' },
					content: { type: 'string', description: 'Full file contents' },
				},
				required: ['path', 'content'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'edit_file',
			description: 'Replace an exact string in a file. old_string must match uniquely.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					old_string: { type: 'string' },
					new_string: { type: 'string' },
				},
				required: ['path', 'old_string', 'new_string'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'grep',
			description: 'Search file contents with ripgrep (rg) or a Node fallback.',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string' },
					path: { type: 'string', description: 'Optional subdirectory to search' },
				},
				required: ['pattern'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'terminal',
			description: 'Run a shell command in the workspace (bash/zsh on Unix, PowerShell on Windows).',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string' },
					cwd: { type: 'string', description: 'Optional working directory' },
				},
				required: ['command'],
			},
		},
	},
];

async function runProcess(command, cwd) {
	const isWin = process.platform === 'win32';
	return new Promise(resolve => {
		const proc = isWin
			? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], { cwd })
			: spawn(process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', ['-lc', command], { cwd });
		let out = '';
		proc.stdout?.on('data', d => { out += d.toString(); });
		proc.stderr?.on('data', d => { out += d.toString(); });
		proc.on('error', err => resolve(err.message));
		proc.on('close', code => resolve(out.trim() || `(exit ${code ?? 0})`));
		setTimeout(() => {
			proc.kill();
			resolve(out.trim() || '(timeout 120s)');
		}, 120_000);
	});
}

async function grepFallback(pattern, root) {
	const results = [];
	const max = 80;
	async function walk(dir) {
		if (results.length >= max) return;
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (results.length >= max) return;
			if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|rs|go|java|txt|yml|yaml)$/i.test(entry.name)) continue;
			try {
				const text = await fs.readFile(full, 'utf8');
				const lines = text.split('\n');
				const re = new RegExp(pattern, 'i');
				for (let i = 0; i < lines.length; i++) {
					if (re.test(lines[i])) {
						results.push(`${path.relative(root, full)}:${i + 1}:${lines[i].slice(0, 200)}`);
						if (results.length >= max) return;
					}
				}
			} catch {
				/* skip binary / unreadable */
			}
		}
	}
	await walk(root);
	return results.length ? results.join('\n') : 'No matches found';
}

export async function executeTool(name, args, workspaceRoot) {
	const ws = workspaceRoot || process.cwd();

	switch (name) {
		case 'list_dir': {
			const full = resolvePath(args.path || '.', ws);
			const entries = await fs.readdir(full, { withFileTypes: true });
			return entries
				.filter(e => e.name !== 'node_modules' && e.name !== '.git')
				.map(e => (e.isDirectory() ? `${e.name}/` : e.name))
				.join('\n') || '(empty)';
		}
		case 'read_file': {
			const full = resolvePath(String(args.path || ''), ws);
			if (isSensitive(full)) throw new Error('Refused: sensitive file');
			const content = await fs.readFile(full, 'utf8');
			const lines = content.split('\n').length;
			return content.length > 80_000
				? `${content.slice(0, 80_000)}\n… truncated (${lines} lines)`
				: content;
		}
		case 'write_file': {
			const full = resolvePath(String(args.path || ''), ws);
			if (isSensitive(full)) throw new Error('Refused: sensitive file');
			await fs.mkdir(path.dirname(full), { recursive: true });
			await fs.writeFile(full, String(args.content ?? ''), 'utf8');
			return `Wrote ${full}`;
		}
		case 'edit_file': {
			const full = resolvePath(String(args.path || ''), ws);
			if (isSensitive(full)) throw new Error('Refused: sensitive file');
			const before = await fs.readFile(full, 'utf8');
			const oldStr = String(args.old_string ?? '');
			const newStr = String(args.new_string ?? '');
			const count = before.split(oldStr).length - 1;
			if (!oldStr || count === 0) throw new Error('old_string not found');
			if (count > 1) throw new Error(`old_string matched ${count} times — make it unique`);
			await fs.writeFile(full, before.replace(oldStr, newStr), 'utf8');
			return `Patched ${full}`;
		}
		case 'grep': {
			const root = args.path ? resolvePath(String(args.path), ws) : ws;
			const pattern = String(args.pattern || '');
			if (!pattern) throw new Error('pattern required');
			const hasRg = fsSync.existsSync('/usr/bin/rg')
				|| fsSync.existsSync('/opt/homebrew/bin/rg')
				|| fsSync.existsSync('/usr/local/bin/rg');
			if (hasRg) {
				const out = await runProcess(
					`rg --no-heading --line-number --max-count 80 ${JSON.stringify(pattern)} ${JSON.stringify(root)}`,
					ws,
				);
				if (/No matches|exit 1|Install ripgrep/i.test(out) && !out.includes(':')) {
					return grepFallback(pattern, root);
				}
				return out || 'No matches found';
			}
			return grepFallback(pattern, root);
		}
		case 'terminal': {
			const cwd = args.cwd ? resolvePath(String(args.cwd), ws) : ws;
			const command = String(args.command || '');
			if (!command.trim()) throw new Error('command required');
			return runProcess(command, cwd);
		}
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}
