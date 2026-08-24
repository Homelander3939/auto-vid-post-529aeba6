// Local, last-chance upload recovery helper.
//
// The arbiter may inspect a screenshot and DOM through LM Studio, but execution
// is deliberately narrower than smart-agent's general-purpose agent loop:
// - no credential entry
// - no navigation
// - no file selection
// - no final Post / Publish / Share / Submit action
// - at most two bounded actions, followed by a caller-owned success check

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { listRows } = require('../localDatabase');
const { ensureSingleLocalLLM } = require('../lm-studio-model-manager');
const { extractPageContext, planNextAction, takeScreenshot } = require('./smart-agent');
const { reportArbiterEvent } = require('./arbiter-reporter');

const execFileAsync = promisify(execFile);

const ARBITER_DIR = path.join(__dirname, '..', 'data', 'arbiter-diagnostics');
const GENERIC_SAFE_LABELS = [
  'not now', 'not right now', 'got it', 'maybe later',
  'retry', 'try again', 'reload', 'refresh', 'accept cookies',
  'allow all cookies', 'decline optional cookies',
];
const POST_SUBMIT_SAFE_LABELS = [
  'not now', 'not right now', 'got it', 'maybe later',
  'accept cookies', 'allow all cookies', 'decline optional cookies',
];
const EXACT_FINAL_ACTION = /^(post|post now|publish|publish now|share|share now|tweet|submit|send|schedule|schedule post)$/i;
const SENSITIVE_ACTION = /(log\s*in|sign\s*in|password|verification code|security code|confirm identity|verify identity)/i;
const LOCAL_LM_BASE_URL = 'http://127.0.0.1:1234';
const DEFAULT_ARBITER_MODEL = 'qwen3.8-27b-uncensored-aggressive';
const FALLBACK_ARBITER_MODEL = 'qwen/qwen3.6-35b-a3b';
const ARBITER_MODEL_IDENTIFIER = 'uploader-arbiter-qwen';
const ARBITER_PLAN_TIMEOUT_MS = 90000;
let runtimeStartPromise = null;
let runtimeUsers = 0;

function normalizeLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function redactDiagnosticText(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, '[redacted-phone]')
    .replace(/\b\d{6}\b/g, '[redacted-code]')
    .replace(/([?&](?:token|key|code|secret|auth|password)=)[^&#\s]+/gi, '$1[redacted]')
    .slice(0, 4000);
}

async function probeLocalModelInventory() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${LOCAL_LM_BASE_URL}/api/v1/models`, { signal: controller.signal });
    if (!response.ok) return { reachable: false, models: [] };
    const payload = await response.json();
    const models = (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({
      key: String(model?.key || '').trim(),
      label: String(model?.display_name || model?.key || '').trim(),
      type: String(model?.type || '').toLowerCase(),
      vision: model?.capabilities?.vision === true,
      toolUse: model?.capabilities?.trained_for_tool_use === true,
      loaded: Array.isArray(model?.loaded_instances) && model.loaded_instances.length > 0,
      loadedId: String(model?.loaded_instances?.[0]?.id || '').trim(),
    })).filter((model) => model.key);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function runLms(args, timeout = 240000) {
  const lmsPath = path.join(process.env.USERPROFILE || '', '.lmstudio', 'bin', 'lms.exe');
  if (!fs.existsSync(lmsPath)) throw new Error(`LM Studio CLI not found at ${lmsPath}`);
  return execFileAsync(lmsPath, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

async function readCliModelInventory() {
  const [{ stdout: installedText }, loadedResult] = await Promise.all([
    runLms(['ls', '--json'], 60000),
    runLms(['ps', '--json'], 60000).catch(() => ({ stdout: '[]' })),
  ]);
  const installed = JSON.parse(installedText || '[]');
  const loaded = JSON.parse(loadedResult?.stdout || '[]');
  const loadedByKey = new Map(loaded.map((model) => [String(model?.modelKey || '').toLowerCase(), model]));
  return installed.map((model) => {
    const active = loadedByKey.get(String(model?.modelKey || '').toLowerCase());
    return {
      key: String(model?.modelKey || '').trim(),
      label: String(model?.displayName || model?.modelKey || '').trim(),
      type: String(model?.type || '').toLowerCase(),
      vision: model?.vision === true,
      toolUse: model?.trainedForToolUse === true,
      loaded: Boolean(active),
      loadedId: String(active?.identifier || '').trim(),
    };
  }).filter((model) => model.key);
}

function isAgentCompatibleModel(model) {
  return model && model.type === 'llm' && !/(?:^|[-_/])(?:embed|embedding)(?:[-_/]|$)/i.test(model.key);
}

function readPreferredArbiterModel() {
  const explicit = String(process.env.UPLOAD_ARBITER_MODEL || '').trim();
  if (explicit) return explicit;
  const settings = listRows('app_settings').find((row) => String(row.id) === '1') || {};
  if (String(settings.ai_provider || '').toLowerCase() === 'lmstudio' && settings.ai_model) {
    return String(settings.ai_model).trim();
  }
  return DEFAULT_ARBITER_MODEL;
}

function selectArbiterModel(models, preferredModel = DEFAULT_ARBITER_MODEL) {
  const compatible = (models || []).filter(isAgentCompatibleModel);
  const matches = (model, id) => {
    const target = String(id || '').toLowerCase();
    return String(model?.key || '').toLowerCase() === target || String(model?.loadedId || '').toLowerCase() === target;
  };
  const loaded = compatible.filter((model) => model.loaded);
  return loaded.find((model) => matches(model, preferredModel))
    || loaded.find((model) => matches(model, DEFAULT_ARBITER_MODEL))
    || loaded[0]
    || compatible.find((model) => matches(model, preferredModel))
    || compatible.find((model) => matches(model, DEFAULT_ARBITER_MODEL))
    || compatible.find((model) => matches(model, FALLBACK_ARBITER_MODEL))
    || compatible[0]
    || null;
}

async function getLocalModelInventory() {
  const probe = await probeLocalModelInventory();
  if (probe.models.length) return probe;
  const cliModels = await readCliModelInventory().catch(() => []);
  return { reachable: probe.reachable, models: cliModels };
}

async function waitForArbiterModel(modelKey, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { models } = await getLocalModelInventory();
    const match = models.find((model) => model.loaded && (
      String(model.loadedId || '').toLowerCase() === ARBITER_MODEL_IDENTIFIER
      || String(model.key || '').toLowerCase() === String(modelKey || '').toLowerCase()
    ));
    if (match) return match.loadedId || match.key;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return '';
}

async function startLocalArbiterRuntime() {
  try {
    const runtime = await ensureSingleLocalLLM({
      preferredModel: readPreferredArbiterModel(),
      baseUrl: LOCAL_LM_BASE_URL,
      loadIfMissing: true,
    });
    console.log(`[UploadArbiter] Using the shared single-model runtime: ${runtime.modelId}`);
    return {
      ready: true,
      ownedModel: false,
      ownedServer: false,
      modelId: runtime.modelId,
      modelKey: runtime.modelKey,
      useVision: runtime.vision,
    };
  } catch (error) {
    console.warn(`[UploadArbiter] Local AI runtime unavailable; safe DOM fallback remains active: ${error.message}`);
    return { ready: false, ownedModel: false, ownedServer: false, modelId: '', modelKey: readPreferredArbiterModel(), useVision: false, error: error.message };
  }
}

async function acquireLocalArbiterRuntime() {
  runtimeUsers += 1;
  if (!runtimeStartPromise) runtimeStartPromise = startLocalArbiterRuntime();
  return runtimeStartPromise;
}

async function releaseLocalArbiterRuntime() {
  runtimeUsers = Math.max(0, runtimeUsers - 1);
  if (runtimeUsers > 0) return;
  // Keep the one shared model available for AI Chat/Telegram. Switching the
  // selected model goes through the shared manager, which ejects this model
  // before it permits the next one to load.
  runtimeStartPromise = null;
}

function matchesAllowedLabel(label, allowedClickTexts = []) {
  const normalized = normalizeLabel(label);
  return [...GENERIC_SAFE_LABELS, ...allowedClickTexts]
    .map(normalizeLabel)
    .filter(Boolean)
    .some((allowed) => normalized === allowed || normalized.includes(allowed));
}

function isSafeArbiterClickDescriptor(descriptor = {}, allowedClickTexts = [], submissionAttempted = false) {
  const label = normalizeLabel([
    descriptor.text,
    descriptor.ariaLabel,
    descriptor.title,
    descriptor.value,
  ].filter(Boolean).join(' '));
  const type = normalizeLabel(descriptor.type);

  if (!label || descriptor.disabled || descriptor.ariaDisabled === 'true') return false;
  if (type === 'submit' || SENSITIVE_ACTION.test(label) || EXACT_FINAL_ACTION.test(label)) return false;
  if (submissionAttempted) {
    return POST_SUBMIT_SAFE_LABELS
      .map(normalizeLabel)
      .some((allowed) => label === allowed || label.includes(allowed));
  }
  return matchesAllowedLabel(label, allowedClickTexts);
}

async function elementDescriptor(locator) {
  return locator.evaluate((element) => ({
    text: (element.innerText || element.textContent || '').slice(0, 180),
    ariaLabel: element.getAttribute('aria-label') || '',
    title: element.getAttribute('title') || '',
    value: element.getAttribute('value') || '',
    type: element.getAttribute('type') || '',
    disabled: Boolean(element.disabled),
    ariaDisabled: element.getAttribute('aria-disabled') || '',
  })).catch(() => null);
}

async function pageFingerprint(page) {
  return page.evaluate(() => ({
    url: window.location.href,
    dialogs: document.querySelectorAll('[role="dialog"]:not([aria-hidden="true"])').length,
    files: document.querySelectorAll('input[type="file"]').length,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
  })).catch(() => ({ url: page.url(), dialogs: 0, files: 0, text: '' }));
}

function safeSlug(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unknown';
}

async function saveArbiterArtifact(page, details) {
  fs.mkdirSync(ARBITER_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stem = `${stamp}-${safeSlug(details.platform)}-${safeSlug(details.checkpoint)}`;
  const screenshotPath = path.join(ARBITER_DIR, `${stem}.jpg`);
  const recordPath = path.join(ARBITER_DIR, `${stem}.json`);

  try {
    const screenshot = await takeScreenshot(page);
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));
  } catch {}

  const context = await extractPageContext(page).catch(() => ({ url: page.url(), title: '', bodyText: '', interactive: [] }));
  const record = {
    createdAt: new Date().toISOString(),
    platform: details.platform,
    checkpoint: details.checkpoint,
    originalError: redactDiagnosticText(details.originalError),
    submissionAttempted: Boolean(details.submissionAttempted),
    model: String(details.model || 'safe DOM fallback'),
    page: {
      url: context.url,
      title: redactDiagnosticText(context.title),
      bodyText: redactDiagnosticText(context.bodyText),
      interactive: (context.interactive || []).slice(0, 40).map((item) => ({
        ...item,
        text: redactDiagnosticText(item.text),
        placeholder: redactDiagnosticText(item.placeholder),
        ariaLabel: redactDiagnosticText(item.ariaLabel),
      })),
    },
    decisions: [],
    result: 'running',
  };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  return { record, recordPath, screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : '' };
}

function saveArbiterResult(artifact, result, decisions) {
  if (!artifact?.recordPath) return;
  const record = { ...artifact.record, decisions, result, finishedAt: new Date().toISOString() };
  try { fs.writeFileSync(artifact.recordPath, JSON.stringify(record, null, 2)); } catch {}
}

async function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function clickSafeFallback(page, allowedClickTexts, submissionAttempted) {
  const candidates = page.locator('button:visible, [role="button"]:visible, [role="menuitem"]:visible, a:visible');
  const count = Math.min(await candidates.count().catch(() => 0), 80);
  for (let index = 0; index < count; index++) {
    const locator = candidates.nth(index);
    const descriptor = await elementDescriptor(locator);
    if (!isSafeArbiterClickDescriptor(descriptor, allowedClickTexts, submissionAttempted)) continue;
    if (await locator.click({ timeout: 5000 }).then(() => true).catch(() => false)) {
      return { clicked: true, descriptor };
    }
  }
  return { clicked: false, descriptor: null };
}

async function attemptUploadArbiterWithRuntime(page, options = {}) {
  const {
    platform = 'unknown',
    checkpoint = 'unknown',
    originalError = 'Uploader checkpoint stalled.',
    allowedClickTexts = [],
    submissionAttempted = false,
    maxSteps = 2,
    verify,
    planner = planNextAction,
    reporter = null,
    modelId = '',
    useVision = false,
    saveArtifacts = true,
  } = options;

  if (!page || page.isClosed?.()) {
    return { recovered: false, reason: 'Browser page was already closed.', artifactPath: '' };
  }

  const artifact = saveArtifacts
    ? await saveArbiterArtifact(page, { platform, checkpoint, originalError, submissionAttempted, model: modelId })
    : { record: {}, recordPath: '', screenshotPath: '' };
  const decisions = [];
  const before = await pageFingerprint(page);
  const allowedSummary = (submissionAttempted
    ? POST_SUBMIT_SAFE_LABELS
    : [...GENERIC_SAFE_LABELS, ...allowedClickTexts]).join(', ');
  const goal = [
    `Diagnose and clear a non-submission obstacle for ${platform} at checkpoint "${checkpoint}".`,
    `The normal uploader will continue afterward. Allowed click labels only: ${allowedSummary}.`,
    'Never click Post, Publish, Share, Tweet, Submit, Send, Schedule, Next, Done, or a file picker.',
    'Never fill credentials or verification codes and never navigate away.',
    `Original uploader error: ${redactDiagnosticText(originalError)}`,
  ].join(' ');

  const emitTrace = async (phase, details = {}) => {
    if (typeof reporter !== 'function') return null;
    return withTimeout(Promise.resolve(reporter(phase, {
      platform,
      checkpoint,
      model: modelId || 'safe DOM fallback',
      artifactPath: artifact.recordPath,
      ...details,
    })).catch((error) => {
      console.warn(`[UploadArbiter] Trace reporting failed: ${error.message}`);
      return null;
    }), 8000, null);
  };

  console.log(`[UploadArbiter] ${platform}/${checkpoint}: local AI inspection started. Artifact: ${artifact.recordPath}`);
  await emitTrace('received', { problem: redactDiagnosticText(originalError) });

  for (let step = 1; step <= Math.max(1, Math.min(maxSteps, 2)); step++) {
    if (typeof verify === 'function' && await verify().catch(() => false)) {
      saveArbiterResult(artifact, 'already-recovered', decisions);
      await emitTrace('resolved', { result: 'The checkpoint recovered before any arbiter action was necessary.' });
      return { recovered: true, reason: 'Checkpoint became ready before arbiter action.', artifactPath: artifact.recordPath };
    }

    const action = await withTimeout(
      planner(page, goal, decisions, { useVision, model: modelId, baseUrl: LOCAL_LM_BASE_URL, nativeApi: true }),
      ARBITER_PLAN_TIMEOUT_MS,
      { action: 'failed', reason: 'Local AI arbiter timed out.', goalReached: false },
    );
    const decision = { step, proposed: action, proposedExecuted: false, executed: false, denialReason: '' };

    if (action?.action === 'click' && action.selector) {
      const locator = page.locator(action.selector).first();
      const descriptor = await elementDescriptor(locator);
      decision.descriptor = descriptor;
      if (isSafeArbiterClickDescriptor(descriptor, allowedClickTexts, submissionAttempted)) {
        decision.proposedExecuted = await locator.click({ timeout: 5000 }).then(() => true).catch(() => false);
        decision.executed = decision.proposedExecuted;
      } else {
        decision.denialReason = 'AI click was outside the checkpoint allowlist.';
      }
    } else if (action?.action === 'wait') {
      await page.waitForTimeout(Math.max(500, Math.min(Number(action.ms) || 1500, 5000)));
      decision.proposedExecuted = true;
      decision.executed = true;
    } else if (action?.action === 'scroll') {
      const amount = Math.max(100, Math.min(Number(action.amount) || 300, 600));
      await page.evaluate(({ amount, direction }) => window.scrollBy(0, direction === 'up' ? -amount : amount), {
        amount,
        direction: action.direction,
      }).catch(() => {});
      decision.proposedExecuted = true;
      decision.executed = true;
    } else {
      decision.denialReason = `Action "${action?.action || 'unknown'}" is not permitted by the upload arbiter.`;
    }

    // If the model could not name a safe selector, use the same allowlist
    // deterministically against visible controls. The AI diagnosis still ran.
    if (!decision.executed) {
      const fallback = await clickSafeFallback(page, allowedClickTexts, submissionAttempted);
      if (fallback.clicked) {
        decision.fallback = fallback.descriptor;
        decision.executed = true;
      }
    }

    decisions.push(decision);
    const proposedTarget = decision.descriptor
      ? [decision.descriptor.text, decision.descriptor.ariaLabel, decision.descriptor.title].filter(Boolean).join(' / ')
      : String(action?.selector || '');
    await emitTrace('answer', {
      answer: action?.reason || 'The model returned no explanation.',
      action: action?.action || 'none',
      target: proposedTarget,
      executed: decision.proposedExecuted,
      denialReason: decision.denialReason,
    });
    await page.waitForTimeout(1500).catch(() => {});
    if (typeof verify === 'function' && await verify().catch(() => false)) {
      console.log(`[UploadArbiter] ${platform}/${checkpoint}: recovered safely at step ${step}.`);
      saveArbiterResult(artifact, 'recovered', decisions);
      const solvedAction = decision.fallback
        ? { action: 'safe fallback click', target: [decision.fallback.text, decision.fallback.ariaLabel, decision.fallback.title].filter(Boolean).join(' / ') }
        : { action: action?.action || 'safe action', target: proposedTarget };
      await emitTrace('resolved', {
        result: action?.reason || 'A permitted action cleared the checkpoint and verification passed.',
        ...solvedAction,
      });
      return { recovered: true, reason: action?.reason || 'Safe arbiter action cleared the checkpoint.', artifactPath: artifact.recordPath };
    }
  }

  const after = await pageFingerprint(page);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const reason = decisions.map((item) => item.proposed?.reason || item.denialReason).filter(Boolean).join(' | ')
    || 'No safe recovery action was available.';
  saveArbiterResult(artifact, changed ? 'changed-but-unverified' : 'not-recovered', decisions);
  console.warn(`[UploadArbiter] ${platform}/${checkpoint}: no verified recovery. ${reason}`);
  await emitTrace('failed', { result: reason });
  return { recovered: false, reason, artifactPath: artifact.recordPath };
}

async function attemptUploadArbiter(page, options = {}) {
  // Tests may inject a planner. Production calls acquire the real, local-only
  // vision model and release it in a finally block even when recovery fails.
  if (options.planner) return attemptUploadArbiterWithRuntime(page, options);
  const runtime = await acquireLocalArbiterRuntime();
  try {
    return await attemptUploadArbiterWithRuntime(page, {
      ...options,
      reporter: options.reporter || reportArbiterEvent,
      modelId: runtime.modelId || '',
      useVision: runtime.ready && runtime.useVision === true,
      planner: runtime.ready
        ? planNextAction
        : async () => ({ action: 'failed', reason: runtime.error || 'Local AI runtime was unavailable.', goalReached: false }),
    });
  } finally {
    await releaseLocalArbiterRuntime();
  }
}

module.exports = {
  attemptUploadArbiter,
  __test: { isSafeArbiterClickDescriptor, isAgentCompatibleModel, redactDiagnosticText, selectArbiterModel },
};
