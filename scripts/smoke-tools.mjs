#!/usr/bin/env node
/** Smoke-test Node CopixApi tools without calling a model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeCopixApi } from '../src/nodeApi.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copix-smoke-'));
const api = createNodeCopixApi();
const sessionId = 'smoke';

const project = await api.createProject(sessionId, 'smoke-demo-agent', 'CLI smoke project', tmp);
if (!project.root.includes('smoke-demo-agent')) throw new Error(`bad project root: ${project.root}`);

await api.writeFile('hello.txt', 'hello from copix\n', project.root);
const read = await api.readFile('hello.txt', project.root);
if (!read.includes('hello from copix')) throw new Error('read_file mismatch');

await api.writeFile('hello.txt', 'hello from copix\nedited\n', project.root);
const listing = await api.listDir('.', project.root);
if (!listing.includes('hello.txt') || !listing.includes('README.md')) {
	throw new Error(`list_dir unexpected: ${listing.join(',')}`);
}

const term = await api.runTerminal('printf ok', project.root);
if (!term.includes('ok')) throw new Error(`terminal failed: ${term}`);

console.log('smoke-tools ok');
console.log('  project', project.root);
console.log('  files', listing.join(', '));

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });
