#!/usr/bin/env node
import { main } from '../src/main.js';

main(process.argv.slice(2)).catch(err => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
