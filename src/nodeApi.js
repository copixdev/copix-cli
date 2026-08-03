/**
 * Node implementation of the desktop CopixApi (electron/preload).
 * Shared by the CLI so runAgent + tools match Copix Desktop.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COPIX_DIR = path.join(os.homedir(), 'Copix');
const SETTINGS_PATH = path.join(COPIX_DIR, 'settings.json');

function expandWorkspaceHome(raw, userHome) {
	let home = raw?.trim() ?? '';
	if (!home || /copix-output/i.test(home.replace(/\\/g, '/'))) {
		return path.normalize(userHome);
	}
	const username = process.env.USER || process.env.USERNAME || path.basename(userHome) || 'user';
	home = home.replace(/\{username\}/gi, username);
	home = home.replace(/%USERNAME%/gi, username);
	home = home.replace(/%USERPROFILE%/gi, userHome);
	if (home.startsWith('~')) {
		home = path.join(userHome, home.slice(1).replace(/^[/\\]+/, ''));
	}
	return path.normalize(home);
}

const DEFAULT_SETTINGS = {
	model: {
		provider: 'ollama',
		apiKey: '',
		selection: 'auto',
		modelId: 'qwen2.5:3b',
		lowVram: false,
	},
	layout: { sidebarWidth: 220, editorWidth: 420 },
	workspace: { homeDirectory: '' },
	theme: 'dark',
	agentMode: 'code',
};

const terminalListeners = new Map();

function projectsRoot() {
	try {
		const raw = JSON.parse(fsSync.readFileSync(SETTINGS_PATH, 'utf8'));
		return expandWorkspaceHome(raw.workspace?.homeDirectory, os.homedir());
	} catch {
		return path.normalize(os.homedir());
	}
}

function slugify(name) {
	return name
		.trim()
		.toLowerCase()
		.replace(/['"]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64) || 'project';
}

function normalizeUserPath(raw, workspaceRoot) {
	let p = String(raw || '').trim().replace(/\\/g, '/');
	if (!p) throw new Error('Empty path');
	const home = os.homedir();
	const username = path.basename(home);
	const isWin = process.platform === 'win32';

	p = p.replace(/^macintosh hd[/:]?/i, '/');
	if (p.startsWith('~/') || p === '~') {
		return path.normalize(path.join(home, p.slice(1).replace(/^\/+/, '')));
	}
	if (/^\/?users\//i.test(p)) {
		const rest = p.replace(/^\/?users\/[^/]+\/?/i, '');
		const named = p.match(/^\/?users\/([^/]+)/i)?.[1];
		const base = named && named.toLowerCase() !== 'current' && named !== '{username}'
			? (isWin ? `C:/Users/${named}` : `/Users/${named}`)
			: home;
		p = rest ? `${base.replace(/\\/g, '/')}/${rest}` : base.replace(/\\/g, '/');
	}
	p = p.replace(/\{username\}/gi, username);
	if (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) return path.normalize(p);
	return path.normalize(path.join(workspaceRoot || projectsRoot(), p));
}

function resolvePath(target, workspaceRoot) {
	if (path.isAbsolute(target)) return path.normalize(target);
	if (!workspaceRoot) throw new Error('No workspace — open a folder or start a new chat');
	return path.normalize(path.join(workspaceRoot, target));
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

async function listTree(dir, max = 400) {
	const out = [];
	async function walk(current, depth) {
		if (out.length >= max || depth > 6) return;
		let entries;
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'Library') continue;
			const full = path.join(current, e.name);
			const rel = path.relative(dir, full).replace(/\\/g, '/');
			if (e.isDirectory()) {
				out.push(`${rel}/`);
				await walk(full, depth + 1);
			} else {
				out.push(rel);
			}
			if (out.length >= max) break;
		}
	}
	await walk(dir, 0);
	return out.sort();
}

async function gitInit(dir) {
	if (fsSync.existsSync(path.join(dir, '.git'))) return;
	await new Promise(resolve => {
		const proc = spawn('git', ['init'], { cwd: dir, shell: true });
		proc.on('close', () => resolve());
		proc.on('error', () => resolve());
	});
}

function emitTerminal(streamId, chunk) {
	const set = terminalListeners.get(streamId);
	if (!set) return;
	for (const cb of set) cb(chunk);
}

async function runProcess(command, cwd, streamId) {
	const isWin = process.platform === 'win32';
	return new Promise(resolve => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const proc = isWin
			? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], { cwd })
			: spawn(process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', ['-lc', command], { cwd });
		let out = '';
		proc.stdout?.on('data', d => {
			const s = d.toString();
			out += s;
			if (streamId) emitTerminal(streamId, s);
		});
		proc.stderr?.on('data', d => {
			const s = d.toString();
			out += s;
			if (streamId) emitTerminal(streamId, s);
		});
		proc.on('error', err => done(err.message));
		proc.on('close', code => done(out.trim() || `(exit ${code ?? 0})`));
		const timer = setTimeout(() => {
			proc.kill();
			done(out.trim() || '(timeout 120s)');
		}, 120_000);
	});
}

export function createNodeCopixApi() {
	return {
		platform: process.platform,
		getPlatform: () => process.platform,
		getProjectsRoot: async () => {
			const root = projectsRoot();
			await fs.mkdir(root, { recursive: true });
			return root;
		},
		browseHomeDirectory: async () => projectsRoot(),
		createSessionWorkspace: async () => {
			const root = projectsRoot();
			await fs.mkdir(root, { recursive: true });
			return { root, tree: await listTree(root) };
		},
		createProject: async (_sessionId, name, description, outputPath) => {
			const slug = slugify(name || 'project');
			let dest;
			if (outputPath?.trim()) {
				const normalized = normalizeUserPath(outputPath, projectsRoot());
				const baseSlug = slugify(path.basename(normalized));
				const exists = fsSync.existsSync(normalized);
				const isDir = exists && fsSync.statSync(normalized).isDirectory();
				const emptyDir = isDir
					&& fsSync.readdirSync(normalized).filter(e => e !== '.DS_Store' && e !== '.git').length === 0;
				const isExplicit = baseSlug === slug || baseSlug.startsWith(`${slug}-`);
				if (isExplicit && (!exists || emptyDir)) dest = normalized;
				else if (isDir || /[/\\]$/.test(outputPath) || !isExplicit) dest = path.join(normalized, slug);
				else dest = normalized;
			} else {
				dest = path.join(projectsRoot(), slug);
			}
			let n = 1;
			const baseDest = dest;
			while (fsSync.existsSync(dest)) {
				const populated = fsSync.readdirSync(dest).filter(e => e !== '.DS_Store').length > 0;
				if (!populated) break;
				dest = `${baseDest}-${n++}`;
			}
			await fs.mkdir(dest, { recursive: true });
			const title = String(name || slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
			const readmePath = path.join(dest, 'README.md');
			if (!fsSync.existsSync(readmePath)) {
				await fs.writeFile(
					readmePath,
					`# ${title}\n\n${description?.trim() || 'Created by Copix agent.'}\n`,
					'utf8',
				);
			}
			await gitInit(dest);
			return { root: dest, tree: await listTree(dest) };
		},
		openFolder: async () => {
			const root = projectsRoot();
			return { root, tree: await listTree(root) };
		},
		cloneRepo: async (url) => {
			const parent = projectsRoot();
			const name = slugify(url.split('/').pop()?.replace(/\.git$/, '') || 'repo');
			const dest = path.join(parent, name);
			await fs.mkdir(parent, { recursive: true });
			if (!fsSync.existsSync(dest)) {
				await new Promise((resolve, reject) => {
					const proc = spawn('git', ['clone', '--depth', '1', url, dest], { shell: true });
					proc.on('close', code => (code === 0 ? resolve() : reject(new Error('git clone failed'))));
					proc.on('error', reject);
				});
			}
			return { root: dest, tree: await listTree(dest) };
		},
		getWorkspace: async (workspaceRoot) => {
			if (!workspaceRoot || !fsSync.existsSync(workspaceRoot)) return undefined;
			return { root: workspaceRoot, tree: await listTree(workspaceRoot) };
		},
		getRepoRemote: async (workspaceRoot) => new Promise(resolve => {
			const proc = spawn('git', ['remote', 'get-url', 'origin'], { cwd: workspaceRoot, shell: true });
			let out = '';
			proc.stdout.on('data', d => { out += d; });
			proc.on('close', code => resolve(code === 0 ? out.trim() : undefined));
			proc.on('error', () => resolve(undefined));
		}),
		readFile: async (filePath, workspaceRoot) => {
			const full = resolvePath(filePath, workspaceRoot);
			if (isSensitive(full)) throw new Error('Refused: sensitive file');
			return fs.readFile(full, 'utf8');
		},
		writeFile: async (filePath, content, workspaceRoot) => {
			const full = resolvePath(filePath, workspaceRoot);
			if (isSensitive(full)) throw new Error('Refused: sensitive file');
			await fs.mkdir(path.dirname(full), { recursive: true });
			await fs.writeFile(full, content, 'utf8');
			return full;
		},
		deleteFile: async (filePath, workspaceRoot) => {
			const full = resolvePath(filePath, workspaceRoot);
			await fs.unlink(full);
			return full;
		},
		listDir: async (dirPath, workspaceRoot) => {
			const full = resolvePath(dirPath || '.', workspaceRoot);
			const entries = await fs.readdir(full, { withFileTypes: true });
			return entries
				.filter(e => e.name !== 'node_modules' && e.name !== '.git' && e.name !== 'Library')
				.map(e => (e.isDirectory() ? `${e.name}/` : e.name));
		},
		grep: async (pattern, searchPath, workspaceRoot) => {
			const root = searchPath ? resolvePath(searchPath, workspaceRoot) : (workspaceRoot || process.cwd());
			return runProcess(
				`rg --no-heading --line-number --max-count 80 ${JSON.stringify(pattern)} ${JSON.stringify(root)} || true`,
				workspaceRoot || process.cwd(),
			);
		},
		runTerminal: async (cmd, workspaceRoot, cwd, _elevate, streamId) => {
			const workDir = cwd ? resolvePath(cwd, workspaceRoot) : (workspaceRoot || process.cwd());
			return runProcess(String(cmd || ''), workDir, streamId);
		},
		onTerminalOutput: (streamId, cb) => {
			if (!terminalListeners.has(streamId)) terminalListeners.set(streamId, new Set());
			terminalListeners.get(streamId).add(cb);
			return () => {
				terminalListeners.get(streamId)?.delete(cb);
			};
		},
		getSettings: async () => {
			await fs.mkdir(COPIX_DIR, { recursive: true });
			if (!fsSync.existsSync(SETTINGS_PATH)) {
				await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8');
				return structuredClone(DEFAULT_SETTINGS);
			}
			try {
				const raw = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
				const mergedModel = {
					...DEFAULT_SETTINGS.model,
					...(raw.model || {}),
					provider: 'ollama',
				};
				// Drop leftover cloud model ids (e.g. Groq) so CLI/Desktop stay on Ollama.
				const id = String(mergedModel.modelId || '');
				if (!id || /llama-3|gpt-|claude|gemini|mixtral|groq/i.test(id) || id.includes('/')) {
					mergedModel.modelId = DEFAULT_SETTINGS.model.modelId;
				}
				return {
					...DEFAULT_SETTINGS,
					...raw,
					model: mergedModel,
				};
			} catch {
				return structuredClone(DEFAULT_SETTINGS);
			}
		},
		setSettings: async (settings) => {
			await fs.mkdir(COPIX_DIR, { recursive: true });
			await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
		},
		loadChatSessions: async () => {
			try {
				return await fs.readFile(path.join(COPIX_DIR, 'sessions.json'), 'utf8');
			} catch {
				return null;
			}
		},
		saveChatSessions: async (json) => {
			await fs.mkdir(COPIX_DIR, { recursive: true });
			await fs.writeFile(path.join(COPIX_DIR, 'sessions.json'), json, 'utf8');
		},
		openExternal: async (url) => {
			const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
			spawn(opener, [url], { shell: true, detached: true }).unref();
		},
		openIdeWindow: async () => ({ ok: false, message: 'IDE window is desktop-only' }),
		getServerStatus: async () => {
			try {
				const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
				if (!res.ok) return { online: false, hasModel: false, models: [], provider: 'ollama' };
				const data = await res.json();
				const models = (data.models || []).map(m => m.name);
				return {
					online: true,
					hasModel: models.some(n => n.startsWith('qwen2.5')),
					models,
					provider: 'ollama',
				};
			} catch {
				return { online: false, hasModel: false, models: [], provider: 'ollama' };
			}
		},
		startServer: async () => {
			const status = await createNodeCopixApi().getServerStatus();
			return status.online
				? { ok: true, message: 'Ollama online' }
				: { ok: false, message: 'Start Ollama from ollama.com' };
		},
		pullOllamaModel: async (model = 'qwen2.5:3b') => {
			const out = await runProcess(`ollama pull ${JSON.stringify(model)}`, os.homedir());
			return { ok: !/error|failed/i.test(out), message: out.slice(0, 400) };
		},
		ensureCopixModels: async () => {
			const status = await createNodeCopixApi().getServerStatus();
			if (!status.online) return { ok: false, message: 'Ollama offline', pulled: [] };
			return { ok: true, message: 'Ollama ready', pulled: [] };
		},
		onPullProgress: () => () => undefined,
		onMenuAction: () => () => undefined,
	};
}

export function installNodeCopixApi(api = createNodeCopixApi()) {
	const g = globalThis;
	g.copix = api;
	g.window = g.window || {};
	g.window.copix = api;
	return api;
}
