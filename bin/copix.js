#!/usr/bin/env node
import { register } from 'tsx/esm/api';

register();

const { main } = await import('../src/main.js');
main(process.argv.slice(2)).catch(err => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
