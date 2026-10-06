/** PTY fixture: read one prompt and print whether it quit. */
import { readPrompt } from '../src/input.js';
import { setPlain } from '../src/ui.js';

if (process.argv[2] === 'plain') setPlain(true);
const line = await readPrompt({ placeholder: 'Ask', footer: ['ready'] });
process.stdout.write(`\nLINE:${line === null ? 'null' : JSON.stringify(line)}\n`);
