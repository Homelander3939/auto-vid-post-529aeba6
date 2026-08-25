const fetch = require('node-fetch');

function normalizeBaseUrl(value) {
  return String(value || 'http://127.0.0.1:1234').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function summarizeInventory(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const loaded = models
    .filter((model) => String(model?.type || '').toLowerCase() === 'llm')
    .flatMap((model) => (Array.isArray(model?.loaded_instances) ? model.loaded_instances : []).map((instance) => ({
      id: String(instance?.id || '').trim(),
      key: String(model?.key || '').trim(),
      context_length: Number(instance?.config?.context_length || instance?.context_length || 0),
    })))
    .filter((model) => model.id);

  return {
    available: loaded.length === 1,
    status: loaded.length === 1 ? 'ready' : loaded.length === 0 ? 'standby' : 'degraded',
    message: loaded.length === 1
      ? 'The optional local AI arbiter is ready.'
      : loaded.length === 0
        ? 'No LLM is loaded. Automated uploads and schedules remain available; AI loads only when requested.'
        : 'More than one LLM is loaded. Automated uploads remain available while the single-model guard repairs AI on demand.',
    singleModelGuard: {
      ok: loaded.length <= 1,
      loadedCount: loaded.length,
      loaded,
      error: null,
    },
  };
}

async function probeOptionalLocalAI(baseUrl, options = {}) {
  const timeoutMs = Math.max(100, Number(options.timeoutMs || 900));
  const request = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(`${normalizeBaseUrl(baseUrl)}/api/v1/models`, { signal: controller.signal });
    if (!response.ok) throw new Error(`LM Studio inventory returned ${response.status}`);
    return summarizeInventory(await response.json());
  } catch (error) {
    return {
      available: false,
      status: 'offline',
      message: 'LM Studio is offline. Automated uploads and schedules remain fully available; AI will retry only when requested.',
      singleModelGuard: {
        ok: null,
        loadedCount: 0,
        loaded: [],
        error: String(error?.message || error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildRuntimeHealth({ runtimeContractVersion, database, counts, aiConfig, aiProbe }) {
  return {
    status: 'ok',
    mode: 'local',
    runtime_contract_version: runtimeContractVersion,
    core: {
      status: 'healthy',
      ai_required: false,
      automated_uploads_available: true,
      schedules_available: true,
      social_posts_available: true,
    },
    database,
    counts,
    ai: {
      provider: 'lmstudio',
      optional: true,
      blocking: false,
      lazy_load: true,
      url: aiConfig.url,
      model: aiConfig.model,
      status: aiProbe.status,
      available: aiProbe.available,
      message: aiProbe.message,
      single_model_guard: {
        ok: aiProbe.singleModelGuard.ok,
        loaded_count: aiProbe.singleModelGuard.loadedCount,
        loaded: aiProbe.singleModelGuard.loaded.map((item) => ({ id: item.id, key: item.key })),
        error: aiProbe.singleModelGuard.error,
      },
    },
  };
}

module.exports = {
  buildRuntimeHealth,
  probeOptionalLocalAI,
  __test: { normalizeBaseUrl, summarizeInventory },
};
