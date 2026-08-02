/**
 * Copix CLI — same agent loop and tools as Copix Desktop (macOS/studio runAgent).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installNodeCopixApi } from './nodeApi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_SRC = path.resolve(__dirname, '../../macOS/studio/src');

const HELP = `
Copix — terminal coding agent (synced with Desktop)

Usage:
  copix                     Interactive REPL in the current directory
  copix "prompt"            One-shot agent turn
  copix -p <dir> "prompt"   Use a workspace directory
  copix --version           Print version
  copix --help              Show help

Tools (same as Desktop):
  create_project, multitask, read_file, write_file, append_file, edit_file,
  delete_file, list_dir, grep, terminal, spawn_subagent

Settings: ~/Copix/settings.json  (provider: ollama, modelId: qwen2.5:3b)
Install:  curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash
`.trim();

function parseArgs(argv) {
	const opts = { workspace: process.cwd(), prompt: '', help: false, version: false };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') opts.help = true;
		else if (a === '-v' || a === '--version') opts.version = true;
		else if (a === '-p' || a === '--workspace') opts.workspace = path.resolve(argv[++i] || process.cwd());
		else rest.push(a);
	}
	opts.prompt = rest.join(' ').trim();
	return opts;
}

async function loadDesktopModules() {
	const api = installNodeCopixApi();
	const [{ runAgent }, { resolveModelConfig }, { DEFAULT_SETTINGS }] = await Promise.all([
		import(pathToFileURL(path.join(STUDIO_SRC, 'models/router.ts')).href),
		import(pathToFileURL(path.join(STUDIO_SRC, 'models/config.ts')).href),
		import(pathToFileURL(path.join(STUDIO_SRC, 'types.ts')).href),
	]);
	return { api, runAgent, resolveModelConfig, DEFAULT_SETTINGS };
}

function makeCallbacks() {
	let thinking = false;
	return {
		onText: (chunk) => {
			if (thinking) {
				process.stdout.write('\n');
				thinking = false;
			}
			process.stdout.write(chunk);
		},
		onThinkingStart: () => {
			thinking = true;
			process.stdout.write('\x1b[2m');
		},
		onThinkingChunk: (chunk) => {
			process.stdout.write(chunk);
		},
		onThinkingEnd: () => {
			if (thinking) process.stdout.write('\x1b[0m\n');
			thinking = false;
		},
		onToolStart: (_id, tool, args) => {
			const preview = args.path || args.command || args.pattern || args.name || '';
			process.stdout.write(`\n\x1b[36m⚙ ${tool}\x1b[0m${preview ? ` ${String(preview).slice(0, 100)}` : ''}\n`);
		},
		onToolEnd: (_id, _tool, _args, meta) => {
			const clip = String(meta.result ?? '').split('\n').slice(0, 6).join('\n');
			if (clip) process.stdout.write(`\x1b[2m${clip}\x1b[0m\n`);
		},
		onStatus: (msg) => {
			if (msg) process.stdout.write(`\x1b[2m${msg}\x1b[0m\r`);
		},
		onClearText: () => undefined,
		onStructuredResponse: () => undefined,
	};
}

async function runOne({ prompt, workspaceRoot, history, runAgent, resolveModelConfig, api, settings }) {
	const config = resolveModelConfig(settings.model, settings.agentMode || 'code', [], prompt);
	const sessionId = `cli-${Date.now()}`;
	let root = workspaceRoot;

	const ac = new AbortController();
	const onSig = () => ac.abort();
	process.on('SIGINT', onSig);

	try {
		await runAgent(
			prompt,
			config,
			{
				sessionId,
				workspaceRoot: root,
				onWorkspaceChange: (next) => { root = next; },
				onSpawnSubagent: async (childPrompt, label) => {
					process.stdout.write(`\n\x1b[35m↳ subagent ${label || ''}\x1b[0m\n`);
					const childId = `cli-sub-${Date.now()}`;
					await runAgent(
						childPrompt,
						config,
						{ sessionId: childId, workspaceRoot: root, isSubagent: true },
						[],
						ac.signal,
						makeCallbacks(),
						{ mode: settings.agentMode || 'code' },
					);
					return { sessionId: childId };
				},
			},
			history,
			ac.signal,
			makeCallbacks(),
			{ mode: settings.agentMode || 'code' },
		);
		process.stdout.write('\n');
		history.push({ role: 'user', content: prompt });
		return root;
	} finally {
		process.off('SIGINT', onSig);
	}
}

async function repl(deps) {
	const { api, runAgent, resolveModelConfig } = deps;
	let workspaceRoot = deps.workspaceRoot;
	const settings = await api.getSettings();
	const status = await api.getServerStatus();
	const history = [];

	console.log(`\x1b[1mCopix\x1b[0m  ollama/${settings.model?.modelId || 'qwen2.5:3b'}  (${status.online ? 'ollama ✓' : 'ollama offline'})`);
	console.log(`\x1b[2mworkspace\x1b[0m  ${workspaceRoot}`);
	console.log(`\x1b[2mtools\x1b[0m      desktop-parity (create_project, edit_file, terminal, …)\n`);
	if (!status.online) {
		console.log('\x1b[33m⚠ Start Ollama, then: ollama pull qwen2.5:3b\x1b[0m\n');
	}

	const rl = readline.createInterface({ input, output, terminal: true });
	try {
		while (true) {
			let line;
			try {
				line = (await rl.question('\x1b[1mcopix>\x1b[0m ')).trim();
			} catch {
				break;
			}
			if (!line) continue;
			if (line === '/exit' || line === '/quit' || line === 'exit') break;
			if (line === '/help') { console.log(HELP); continue; }
			if (line === '/cwd') { console.log(workspaceRoot); continue; }
			if (line === '/clear') { history.length = 0; console.log('History cleared.'); continue; }
			try {
				workspaceRoot = await runOne({
					prompt: line,
					workspaceRoot,
					history,
					runAgent,
					resolveModelConfig,
					api,
					settings,
				});
			} catch (err) {
				console.error(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
			}
			console.log('');
		}
	} finally {
		rl.close();
	}
}

export async function main(argv) {
	const opts = parseArgs(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (opts.version) {
		const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		console.log(`copix ${pkg.version}`);
		return;
	}

	if (!fs.existsSync(path.join(STUDIO_SRC, 'models/router.ts'))) {
		throw new Error(
			`Desktop agent sources missing at ${STUDIO_SRC}. Re-run: curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash`,
		);
	}

	const deps = await loadDesktopModules();
	const workspaceRoot = fs.existsSync(opts.workspace) ? path.resolve(opts.workspace) : process.cwd();
	const settings = await deps.api.getSettings();

	if (opts.prompt) {
		const status = await deps.api.getServerStatus();
		console.log(`\x1b[1mCopix\x1b[0m  ollama/${settings.model?.modelId || 'qwen2.5:3b'}  (${status.online ? 'ollama ✓' : 'ollama offline'})`);
		console.log(`\x1b[2mworkspace\x1b[0m  ${workspaceRoot}\n`);
		await runOne({
			prompt: opts.prompt,
			workspaceRoot,
			history: [],
			runAgent: deps.runAgent,
			resolveModelConfig: deps.resolveModelConfig,
			api: deps.api,
			settings,
		});
		return;
	}

	await repl({ ...deps, workspaceRoot });
}
