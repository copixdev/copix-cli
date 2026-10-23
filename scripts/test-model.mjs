import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModelConfig } from '../agent/models/config.ts';
import { selectModelForTask } from '../agent/models/modelSelector.ts';
import { buildChatRequest } from '../agent/models/router.ts';
import { fitInstalledModel } from '../src/ollamaProfile.js';

const GB = 1024 ** 3;
const HOST_15GB = 16780574720;

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

test('8 GB auto does not fall back to a larger installed qwen tag', () => {
	const installed = ['qwen2.5-coder:7b'];
	const picked = selectModelForTask(
		'code',
		{
			provider: 'ollama',
			selection: 'auto',
			modelId: 'qwen2.5:3b',
			lowVram: true,
		},
		installed,
		'add a function',
		8 * GB,
	);
	assert.equal(picked, 'qwen2.5:3b');
	assert.equal(fitInstalledModel(picked, installed, 8 * GB), 'qwen2.5:3b');
	const config = resolveModelConfig(
		{
			provider: 'ollama',
			selection: 'auto',
			modelId: 'qwen2.5:3b',
			lowVram: true,
		},
		'code',
		installed,
		'add a function',
		{ totalMem: 8 * GB },
	);
	assert.equal(config.model, 'qwen2.5:3b');
	assert.equal(config.numCtx, 4096);
	assert.equal(config.keepAlive, '5m');
	assert.equal(config.singleModel, true);
});

test('15 GB auto uses the same 3B recommendation as the wizard', () => {
	const installed = ['qwen2.5:3b', 'qwen2.5-coder:7b'];
	const settings = {
		provider: 'ollama',
		selection: 'auto',
		modelId: 'qwen2.5:3b',
		lowVram: false,
	};
	assert.equal(selectModelForTask('code', settings, installed, 'add a function', HOST_15GB), 'qwen2.5:3b');
	assert.equal(selectModelForTask('code', { ...settings, lowVram: true }, installed, 'add a function', 15 * GB), 'qwen2.5:3b');
	const config = resolveModelConfig(settings, 'code', installed, 'add a function', { totalMem: HOST_15GB });
	assert.equal(config.model, 'qwen2.5:3b');
	assert.equal(config.numCtx, 4096);
	assert.equal(config.keepAlive, '5m');
	assert.equal(config.singleModel, true);
	assert.equal(fitInstalledModel(config.model, installed, HOST_15GB), 'qwen2.5:3b');
});

test('16 GB auto may use a 7B tag that fits that tier', () => {
	const picked = selectModelForTask(
		'code',
		{
			provider: 'ollama',
			selection: 'auto',
			modelId: 'qwen2.5:7b',
			lowVram: false,
		},
		['qwen2.5:3b', 'qwen2.5-coder:7b', 'qwen2.5:14b'],
		'add a function',
		16 * GB,
	);
	assert.equal(picked, 'qwen2.5-coder:7b');
	const onlyLarge = selectModelForTask(
		'code',
		{
			provider: 'ollama',
			selection: 'auto',
			modelId: 'qwen2.5:7b',
			lowVram: false,
		},
		['qwen2.5:14b'],
		'add a function',
		16 * GB,
	);
	assert.equal(onlyLarge, 'qwen2.5:7b');
});

test('a manual pin is left on the tag the user chose', () => {
	const picked = selectModelForTask(
		'code',
		{
			provider: 'ollama',
			selection: 'manual',
			modelId: 'qwen2.5-coder:7b',
			lowVram: true,
		},
		['qwen2.5-coder:7b'],
		'add a function',
		8 * GB,
	);
	assert.equal(picked, 'qwen2.5-coder:7b');
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
