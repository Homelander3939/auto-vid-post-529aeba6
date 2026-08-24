// Shared LM Studio lifecycle guard for every local-AI path in the uploader.
//
// The RTX 3090 cannot safely host both large Qwen models at once. Every caller
// therefore goes through one serialized transition: first eject every other
// loaded LLM, then (and only then) load the selected model. Embedding models are
// not agent LLMs and are left untouched.

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = 'http://127.0.0.1:1234';
const DEFAULT_MODEL = 'qwen3.8-27b-uncensored-aggressive';
const MANAGED_IDENTIFIER = 'uploader-local-agent';
// 10K is a conservative ceiling for the 27B Q4 model on the user's RTX 3090.
// It leaves materially more room for app state + tools than 8K without the
// VRAM jump of a 16K/32K load.
const DEFAULT_CONTEXT_LENGTH = 10240;
const DEFAULT_GPU_OFFLOAD = 'max';
let transitionTail = Promise.resolve();

function normalizeBaseUrl(value) {
  const normalized = String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  const parsed = new URL(normalized);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error('The local uploader model manager only permits loopback LM Studio URLs.');
  }
  return normalized;
}

function isAgentLLM(model) {
  return String(model?.type || '').toLowerCase() === 'llm'
    && !/(?:^|[-_/])(?:embed|embedding)(?:[-_/]|$)/i.test(String(model?.key || ''));
}

function flattenLoadedLLMs(models) {
  return (models || []).filter(isAgentLLM).flatMap((model) =>
    (Array.isArray(model.loadedInstances) ? model.loadedInstances : []).map((instance) => ({
      id: String(instance?.id || '').trim(),
      key: String(model.key || '').trim(),
      vision: model.vision === true,
      toolUse: model.toolUse === true,
      contextLength: Number(instance?.contextLength || instance?.context_length || instance?.config?.context_length || 0),
    })).filter((instance) => instance.id));
}

function planSingleModelTransition(models, preferredModel = DEFAULT_MODEL, loadIfMissing = true, requiredContextLength = 0) {
  const compatible = (models || []).filter(isAgentLLM);
  const preferred = String(preferredModel || DEFAULT_MODEL).trim().toLowerCase();
  const selected = compatible.find((model) => String(model.key || '').toLowerCase() === preferred
    || (Array.isArray(model.loadedInstances) ? model.loadedInstances : [])
      .some((instance) => String(instance?.id || '').toLowerCase() === preferred));
  if (!selected) throw new Error(`Selected LM Studio LLM is not installed: ${preferredModel}`);

  const loaded = flattenLoadedLLMs(compatible);
  const selectedKey = String(selected.key || '').toLowerCase();
  const minimumContext = Math.max(0, Number(requiredContextLength || 0));
  const keep = loaded.find((instance) => instance.key.toLowerCase() === selectedKey
    && (!minimumContext || Number(instance.contextLength || 0) >= minimumContext)) || null;
  return {
    selected,
    keep,
    unload: loaded.filter((instance) => !keep || instance.id !== keep.id),
    loadModel: keep || !loadIfMissing ? null : selected.key,
  };
}

function singleLoadedModel(models) {
  const loaded = flattenLoadedLLMs(models);
  return loaded.length === 1 ? loaded[0] : null;
}

function runExclusive(work) {
  const run = transitionTail.then(work, work);
  transitionTail = run.catch(() => undefined);
  return run;
}

function lmsPath() {
  const candidate = path.join(process.env.USERPROFILE || '', '.lmstudio', 'bin', 'lms.exe');
  if (!fs.existsSync(candidate)) throw new Error(`LM Studio CLI not found at ${candidate}`);
  return candidate;
}

async function runLms(args, timeout = 240000) {
  return execFileAsync(lmsPath(), args, {
    timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function isServerReady(baseUrl = DEFAULT_BASE_URL) {
  const url = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${url}/v1/models`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureLocalServer(baseUrl = DEFAULT_BASE_URL) {
  const url = normalizeBaseUrl(baseUrl);
  if (await isServerReady(url)) return;
  const port = new URL(url).port || '1234';
  await runLms(['server', 'start', '--port', port, '--bind', '127.0.0.1', '--cors'], 60000).catch(() => {});
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await isServerReady(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`LM Studio local server did not become ready at ${url}.`);
}

async function readNativeInventory(baseUrl = DEFAULT_BASE_URL) {
  const url = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${url}/api/v1/models`, { signal: controller.signal });
    if (!response.ok) throw new Error(`LM Studio model inventory returned ${response.status}`);
    const payload = await response.json();
    return (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({
      key: String(model?.key || '').trim(),
      label: String(model?.display_name || model?.key || '').trim(),
      type: String(model?.type || '').toLowerCase(),
      vision: model?.capabilities?.vision === true,
      toolUse: model?.capabilities?.trained_for_tool_use === true,
      loadedInstances: (Array.isArray(model?.loaded_instances) ? model.loaded_instances : [])
        .map((instance) => ({
          id: String(instance?.id || '').trim(),
          contextLength: Number(instance?.config?.context_length || instance?.context_length || 0),
        }))
        .filter((instance) => instance.id),
    })).filter((model) => model.key);
  } finally {
    clearTimeout(timer);
  }
}

async function readCliInventory() {
  const [{ stdout: installedText }, loadedResult] = await Promise.all([
    runLms(['ls', '--json'], 60000),
    runLms(['ps', '--json'], 60000).catch(() => ({ stdout: '[]' })),
  ]);
  const installed = JSON.parse(installedText || '[]');
  const loaded = JSON.parse(loadedResult?.stdout || '[]');
  return installed.map((model) => ({
    key: String(model?.modelKey || '').trim(),
    label: String(model?.displayName || model?.modelKey || '').trim(),
    type: String(model?.type || '').toLowerCase(),
    vision: model?.vision === true,
    toolUse: model?.trainedForToolUse === true,
    loadedInstances: loaded
      .filter((instance) => String(instance?.modelKey || '').toLowerCase() === String(model?.modelKey || '').toLowerCase())
      .map((instance) => ({
        id: String(instance?.identifier || '').trim(),
        contextLength: Number(instance?.contextLength || instance?.context_length || 0),
      }))
      .filter((instance) => instance.id),
  })).filter((model) => model.key);
}

async function readModelInventory(baseUrl = DEFAULT_BASE_URL) {
  return readNativeInventory(baseUrl).catch(() => readCliInventory());
}

async function waitForManagedModel(baseUrl, selectedKey, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inventory = await readModelInventory(baseUrl).catch(() => []);
    const selected = inventory.find((model) => String(model.key).toLowerCase() === String(selectedKey).toLowerCase());
    const instance = selected?.loadedInstances?.find((item) => item.id === MANAGED_IDENTIFIER)
      || selected?.loadedInstances?.[0];
    if (instance?.id) return { selected, instance };
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`LM Studio did not finish loading ${selectedKey} before timeout.`);
}

async function ensureSingleLocalLLM(options = {}) {
  return runExclusive(async () => {
    const baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    const preferredModel = String(options.preferredModel || DEFAULT_MODEL).trim();
    const loadIfMissing = options.loadIfMissing !== false;
    const contextLength = Math.max(4096, Number(options.contextLength || DEFAULT_CONTEXT_LENGTH));
    await ensureLocalServer(baseUrl);
    let inventory = await readModelInventory(baseUrl);
    const preserved = options.preserveLoaded === true ? singleLoadedModel(inventory) : null;
    if (preserved) {
      console.log(`[LMStudioGuard] Reusing the factory's only loaded LLM: ${preserved.id} (${preserved.key}).`);
      return {
        ready: true,
        modelId: preserved.id,
        modelKey: preserved.key,
        vision: preserved.vision,
        toolUse: preserved.toolUse,
        contextLength: preserved.contextLength || contextLength,
        unloaded: [],
        loadedNow: false,
      };
    }
    let plan = planSingleModelTransition(inventory, preferredModel, loadIfMissing, contextLength);

    // Eject every non-selected LLM before loading anything. The order is the
    // critical VRAM guarantee: unload completes first, then load may begin.
    for (const instance of plan.unload) {
      await runLms(['unload', instance.id], 60000);
      console.log(`[LMStudioGuard] Ejected ${instance.id} before model selection.`);
    }

    if (plan.keep) {
      return {
        ready: true,
        modelId: plan.keep.id,
        modelKey: plan.keep.key,
        vision: plan.keep.vision,
        toolUse: plan.keep.toolUse,
        contextLength: plan.keep.contextLength || contextLength,
        unloaded: plan.unload.map((item) => item.id),
        loadedNow: false,
      };
    }

    if (!plan.loadModel) {
      return {
        ready: false,
        modelId: '',
        modelKey: plan.selected.key,
        vision: plan.selected.vision,
        toolUse: plan.selected.toolUse,
        contextLength,
        unloaded: plan.unload.map((item) => item.id),
        loadedNow: false,
      };
    }

    // Re-read after ejection and refuse to load if any agent LLM still remains.
    inventory = await readModelInventory(baseUrl);
    const stillLoaded = flattenLoadedLLMs(inventory);
    if (stillLoaded.length) {
      throw new Error(`Refusing to load ${plan.loadModel}; another LLM is still loaded: ${stillLoaded.map((item) => item.id).join(', ')}`);
    }

    await runLms([
      'load', plan.loadModel,
      '--identifier', MANAGED_IDENTIFIER,
      '--context-length', String(contextLength),
      '--parallel', '1',
      '--gpu', String(options.gpuOffload || options.gpuFraction || DEFAULT_GPU_OFFLOAD),
      '--yes',
    ]);
    const loaded = await waitForManagedModel(baseUrl, plan.loadModel);
    console.log(`[LMStudioGuard] Loaded the only uploader LLM: ${loaded.instance.id} (${loaded.selected.key}).`);
    return {
      ready: true,
      modelId: loaded.instance.id,
      modelKey: loaded.selected.key,
      vision: loaded.selected.vision,
      toolUse: loaded.selected.toolUse,
      contextLength: loaded.instance.contextLength || contextLength,
      unloaded: plan.unload.map((item) => item.id),
      loadedNow: true,
    };
  });
}

async function getSingleLocalLLMStatus(baseUrl = DEFAULT_BASE_URL) {
  const inventory = await readModelInventory(baseUrl);
  const loaded = flattenLoadedLLMs(inventory);
  return {
    ok: loaded.length <= 1,
    loadedCount: loaded.length,
    loaded,
  };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_GPU_OFFLOAD,
  MANAGED_IDENTIFIER,
  ensureSingleLocalLLM,
  getSingleLocalLLMStatus,
  readModelInventory,
  __test: { flattenLoadedLLMs, isAgentLLM, planSingleModelTransition, singleLoadedModel },
};
