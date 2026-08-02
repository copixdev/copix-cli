import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runAgentTurn } from './agent.js';
import { SETTINGS_PATH, loadSettings, resolveModelConfig, settingsHint } from './settings.js';

const HELP = `
Copix — terminal coding agent

Usage:
  copix                     Interactive REPL in the current directory
  copix "prompt"            One-shot agent turn
  copix -p <dir> "prompt"   Use a workspace directory
  copix --version           Print version
  copix --help              Show help

Settings: ~/Copix/settings.json
  model.provider   groq | openrouter | openai | ollama
  model.apiKey     API key for cloud providers
  model.modelId    Model id (optional)

Install:
  curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash
`.trim();

function printBanner(config, workspaceRoot) {
	const keyState = config.provider === 'ollama'
		? 'local'
		: (config.apiKey ? 'key ✓' : 'key missing');
	console.log(`\x1b[1mCopix\x1b[0m  ${config.provider}/${config.model}  (${keyState})`);
	console.log(`\x1b[2mworkspace\x1b[0m  ${workspaceRoot}`);
	console.log(`\x1b[2msettings\x1b[0m   ${SETTINGS_PATH}`);
	if (config.provider !== 'ollama' && !config.apiKey) {
		console.log(`\x1b[33m⚠ ${settingsHint(config)}\x1b[0m`);
	}
	console.log('');
}

function parseArgs(argv) {
	const opts = { workspace: process.cwd(), prompt: '', help: false, version: false };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') opts.help = true;
		else if (a === '-v' || a === '--version') opts.version = true;
		else if (a === '-p' || a === '--workspace') {
			opts.workspace = path.resolve(argv[++i] || process.cwd());
		}
		else if (a === '--') rest.push(...argv.slice(i + 1));
		else rest.push(a);
	}
	opts.prompt = rest.join(' ').trim();
	return opts;
}

async function repl(config, workspaceRoot) {
	const history = [];
	const rl = readline.createInterface({ input, output, terminal: true });
	printBanner(config, workspaceRoot);
	console.log('Type a task. Commands: /help  /cwd  /clear  /exit\n');

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
			if (line === '/help') {
				console.log(HELP);
				continue;
			}
			if (line === '/cwd') {
				console.log(workspaceRoot);
				continue;
			}
			if (line === '/clear') {
				history.length = 0;
				console.log('History cleared.');
				continue;
			}
			try {
				await runAgentTurn({
					prompt: line,
					config,
					workspaceRoot,
					history,
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
		const pkgPath = new URL('../package.json', import.meta.url);
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		console.log(`copix ${pkg.version}`);
		return;
	}

	const workspaceRoot = fs.existsSync(opts.workspace)
		? path.resolve(opts.workspace)
		: process.cwd();
	const settings = loadSettings();
	const config = resolveModelConfig(settings);

	if (opts.prompt) {
		printBanner(config, workspaceRoot);
		await runAgentTurn({
			prompt: opts.prompt,
			config,
			workspaceRoot,
			history: [],
		});
		return;
	}

	await repl(config, workspaceRoot);
}
