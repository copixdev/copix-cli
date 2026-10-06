#!/usr/bin/env node
/** Smoke-test Node CopixApi tools without calling a model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeCopixApi, expandWorkspaceHome, usersDirectoryPrefix } from '../src/nodeApi.js';
import { cliInstallCommand, displayWidth, helpText, termCols } from '../src/ui.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copix-smoke-'));
const api = createNodeCopixApi();
const sessionId = 'smoke';

const project = await api.createProject(sessionId, 'smoke-demo-agent', 'CLI smoke project', tmp);
if (!project.root.includes('smoke-demo-agent')) throw new Error(`bad project root: ${project.root}`);

await api.writeFile('hello.txt', 'hello from copix\n', project.root);
const read = await api.readFile('hello.txt', project.root);
if (!read.includes('hello from copix')) throw new Error('read_file mismatch');

await api.writeFile('hello.txt', 'hello from copix\nedited\n', project.root);
const before = await api.readFile('hello.txt', project.root);
// edit_file parity is in desktop router; here verify overwrite + append-style write
await api.writeFile('hello.txt', `${before}appended\n`, project.root);
const after = await api.readFile('hello.txt', project.root);
if (!after.includes('appended')) throw new Error('append-style write failed');
const listing = await api.listDir('.', project.root);
if (!listing.includes('hello.txt') || !listing.includes('README.md')) {
	throw new Error(`list_dir unexpected: ${listing.join(',')}`);
}

const term = await api.runTerminal('printf ok', project.root);
if (!term.includes('ok')) throw new Error(`terminal failed: ${term}`);

const found = await api.grep('hello from copix', undefined, project.root);
if (!found.includes('hello.txt') || !/hello\.txt:\d+:/.test(found)) {
	throw new Error(`grep failed: ${found}`);
}
const none = await api.grep('this-token-is-absent', undefined, project.root);
if (none !== 'No matches found') throw new Error(`grep empty: ${none}`);
const weird = await api.grep('(.*', undefined, project.root);
if (typeof weird !== 'string') throw new Error('grep threw on a bad pattern');

if (usersDirectoryPrefix('win32') !== 'C:/Users/') throw new Error('windows users prefix');
if (usersDirectoryPrefix('darwin') !== '/Users/') throw new Error('macos users prefix');
if (usersDirectoryPrefix('linux') !== '/home/') throw new Error('linux users prefix');
const expanded = expandWorkspaceHome('/user/ada', path.join(tmp, 'home'));
const expectedUsers = usersDirectoryPrefix().replace(/\/$/, '') + path.sep + 'ada';
if (path.normalize(expanded) !== path.normalize(expectedUsers)) {
	throw new Error(`expandWorkspaceHome: ${expanded} != ${expectedUsers}`);
}

const help = helpText();
const width = termCols();
for (const line of help.split('\n')) {
	if (!/[╭╮╰╯│]/.test(line)) continue;
	if (displayWidth(line) > width) throw new Error(`help line wider than ${width}: ${line}`);
}
if (!help.includes('write_file') || !help.includes('delete_file')) throw new Error('help is missing file tools');
if (!help.split('\n').includes(cliInstallCommand())) throw new Error('help install command is not its own line');
if (process.platform === 'win32' && !help.includes('%USERPROFILE%')) throw new Error('windows help path');
if (process.platform !== 'win32' && !help.includes('~/Copix/settings.json')) throw new Error('unix help path');

console.log('smoke-tools ok');
console.log('  project', project.root);
console.log('  files', listing.join(', '));

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });
