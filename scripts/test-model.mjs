import assert from 'node:assert/strict';
import test from 'node:test';
import { selectModelForTask } from '../agent/models/modelSelector.ts';
import { buildChatRequest } from '../agent/models/router.ts';

const GB = 1024 ** 3;

test('8 GB auto mode stays on the recommended tag', () => {
	const picked = selectModelForTask(
		'code',
		{
			provider: 'ollama',
			selection: 'auto',
			modelId: 'qwen2.5:3b',
			lowVram: true,
		},
		['qwen2.5:3b', 'qwen2.5-coder:7b'],
		'add a function',
		8 * GB,
	);
	assert.equal(picked, 'qwen2.5:3b');
});

test('Ollama num_ctx goes to /api/chat', () => {
	const req = buildChatRequest(
		{
			provider: 'ollama',
			model: 'qwen2.5:3b',
			baseUrl: 'http://127.0.0.1:11434/v1',
			numCtx: 4096,
			numPredict: 8192,
			keepAlive: '5m',
			singleModel: true,
		},
		'qwen2.5:3b',
		[{ role: 'user', content: 'hi' }],
		undefined,
		8192,
	);
	assert.equal(req.url, 'http://127.0.0.1:11434/api/chat');
	assert.equal(req.body.keep_alive, '5m');
	assert.equal(req.body.options.num_ctx, 4096);
	assert.equal(req.body.options.num_predict, 8192);
	assert.equal(String(req.url).includes('/v1/'), false);
});
