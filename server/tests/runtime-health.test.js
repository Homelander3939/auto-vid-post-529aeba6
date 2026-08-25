const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRuntimeHealth, probeOptionalLocalAI, __test } = require('../runtime-health');

test('no loaded LM Studio model is standby and never degrades core uploads', async () => {
  const aiProbe = await probeOptionalLocalAI('http://127.0.0.1:1234', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
  });
  const health = buildRuntimeHealth({
    runtimeContractVersion: 7,
    database: 'local.sqlite',
    counts: { upload_jobs: 3 },
    aiConfig: { url: 'http://127.0.0.1:1234', model: 'qwen3.8-27b-uncensored-aggressive' },
    aiProbe,
  });

  assert.equal(health.status, 'ok');
  assert.equal(health.core.status, 'healthy');
  assert.equal(health.core.ai_required, false);
  assert.equal(health.core.automated_uploads_available, true);
  assert.equal(health.ai.status, 'standby');
  assert.equal(health.ai.available, false);
  assert.equal(health.ai.blocking, false);
});

test('offline LM Studio is reported quickly as an optional feature', async () => {
  const aiProbe = await probeOptionalLocalAI('http://127.0.0.1:1234', {
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  assert.equal(aiProbe.status, 'offline');
  assert.equal(aiProbe.available, false);
  assert.match(aiProbe.message, /uploads and schedules remain fully available/i);
});

test('inventory summary preserves the one-model guard without making it a core gate', () => {
  const result = __test.summarizeInventory({
    models: [{
      key: 'qwen3.8-27b-uncensored-aggressive',
      type: 'llm',
      loaded_instances: [{ id: 'uploader-local-agent', config: { context_length: 16384 } }],
    }],
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.available, true);
  assert.equal(result.singleModelGuard.loadedCount, 1);
});
