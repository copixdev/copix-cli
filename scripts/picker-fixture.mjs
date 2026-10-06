/** PTY fixture: open the model picker and print the choice. */
import { selectOption } from '../src/select.js';
import { setPlain } from '../src/ui.js';

const mode = process.argv[2] || 'raw';
setPlain(mode === 'plain');

const items = [
	{ value: 'auto', label: 'auto', hint: 'route by task' },
	{ value: 'qwen2.5:3b', label: 'qwen2.5:3b', hint: 'installed' },
	{ value: 'mistral:7b', label: 'mistral:7b', hint: 'not installed' },
];

const result = await selectOption({ label: 'Model', items, initialIndex: 0 });
process.stdout.write(`\nPICKED:${result.item ? result.item.value : result.reason}\n`);
