// Idempotent LM Studio readiness gate used by the Windows uploader launcher.
// It starts only the loopback API, keeps exactly one chat LLM resident, loads
// the model selected in local uploader settings, and requires a real response.

const fetch = require('node-fetch');
const { listRows } = require('./localDatabase');
const {
  DEFAULT_MODEL,
  ensureSingleLocalLLM,
  getSingleLocalLLMStatus,
} = require('./lm-studio-model-manager');

const DEFAULT_CONTEXT_LENGTH = 16384;

function localAISettings() {
  const row = listRows('app_settings').find((item) => String(item?.id) === '1') || {};
  const provider = String(row.ai_provider || 'lmstudio').trim().toLowerCase();
  return {
    provider,
    model: DEFAULT_MODEL,
    baseUrl: provider === 'lmstudio' && String(row.ai_base_url || '').trim()
      ? String(row.ai_base_url).trim()
      : 'http://127.0.0.1:1234',
  };
}

async function requireRealCompletion(baseUrl, modelId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(`${String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: '/no_think Reply with only READY.' }],
        temperature: 0,
        max_tokens: 128,
        reasoning_effort: 'none',
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`completion probe returned HTTP ${response.status}`);
    const payload = await response.json();
    const content = String(payload?.choices?.[0]?.message?.content || '').trim();
    if (!content) throw new Error('completion probe returned no assistant content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const settings = localAISettings();
  const contextLength = DEFAULT_CONTEXT_LENGTH;
  const baseUrl = process.env.UPLOADER_LM_BASE_URL || settings.baseUrl;
  const runtime = await ensureSingleLocalLLM({
    preferredModel: DEFAULT_MODEL,
    baseUrl,
    contextLength,
    loadIfMissing: true,
    gpuOffload: 'max',
  });
  if (!runtime.ready || !runtime.modelId) throw new Error('LM Studio did not provide a ready local uploader model.');

  const status = await getSingleLocalLLMStatus(baseUrl);
  if (!status.ok || status.loadedCount !== 1) {
    throw new Error(`Expected exactly one loaded chat LLM, found ${status.loadedCount}.`);
  }

  await requireRealCompletion(baseUrl, runtime.modelId);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    localOnly: true,
    modelId: runtime.modelId,
    modelKey: runtime.modelKey,
    contextLength: runtime.contextLength,
    vision: runtime.vision,
    toolUse: runtime.toolUse,
    loadedNow: runtime.loadedNow,
    unloaded: runtime.unloaded,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`[UploaderLMStudio] ${error.message}\n`);
  process.exitCode = 1;
});
