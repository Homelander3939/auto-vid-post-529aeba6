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
const TRANSIENT_ERROR_RECOVERY_LABELS = ['retry', 'try again', 'reload', 'refresh'];
const TRANSIENT_ERROR_PAGE = /(something went wrong|please try again|temporary error|could(?:n['’]t| not) load|failed to load|network error|connection error)/i;
const EXACT_FINAL_ACTION = /^(post|post now|publish|publish now|share|share now|tweet|submit|send|schedule|schedule post|next|done)$/i;
const SENSITIVE_ACTION = /(log\s*in|sign\s*in|password|verification code|security code|confirm identity|verify identity)/i;
const DESTRUCTIVE_ACTION = /(delete|discard|remove|erase|cancel\s+(?:the\s+)?upload|abort\s+(?:the\s+)?upload|abandon|sign\s*out|log\s*out|disconnect|revoke)/i;
const PURCHASE_OR_ACCOUNT_ACTION = /(buy|purchase|pay|checkout|subscribe|boost|promote|advertise|authorize account|grant access)/i;
const LOCAL_LM_BASE_URL = 'http://127.0.0.1:1234';
const DEFAULT_ARBITER_MODEL = 'qwen3.8-27b-uncensored-aggressive';
const ARBITER_MODEL_IDENTIFIER = 'uploader-local-agent';
const ARBITER_START_TIMEOUT_MS = 45000;
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
  return DEFAULT_ARBITER_MODEL;
}

function selectArbiterModel(models, _preferredModel = DEFAULT_ARBITER_MODEL) {
  const compatible = (models || []).filter(isAgentCompatibleModel);
  const matches = (model, id) => {
    const target = String(id || '').toLowerCase();
    return String(model?.key || '').toLowerCase() === target || String(model?.loadedId || '').toLowerCase() === target;
  };
  return compatible.find((model) => matches(model, DEFAULT_ARBITER_MODEL)) || null;
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
    const runtime = await withTimeout(ensureSingleLocalLLM({
      preferredModel: readPreferredArbiterModel(),
      baseUrl: LOCAL_LM_BASE_URL,
      loadIfMissing: true,
      contextLength: 16384,
    }), ARBITER_START_TIMEOUT_MS, null);
    if (!runtime) {
      throw new Error('Optional local AI did not become ready within 45 seconds; continuing with deterministic DOM recovery.');
    }
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

function matchesDeniedLabel(label, deniedClickTexts = []) {
  return deniedClickTexts
    .map(normalizeLabel)
    .filter(Boolean)
    .some((denied) => label === denied || label.includes(denied));
}

function assessArbiterClickDescriptor(descriptor = {}, options = {}) {
  const {
    allowedClickTexts = [],
    deniedClickTexts = [],
    submissionAttempted = false,
    modelProposed = false,
    allowContextualDialogActions = true,
  } = options;
  const label = normalizeLabel([
    descriptor.text,
    descriptor.ariaLabel,
    descriptor.title,
    descriptor.value,
  ].filter(Boolean).join(' '));
  const type = normalizeLabel(descriptor.type);

  if (!label) return { safe: false, reason: 'The proposed control has no accessible label.' };
  if (descriptor.disabled || descriptor.ariaDisabled === 'true') return { safe: false, reason: 'The proposed control is disabled.' };
  if (descriptor.href) return { safe: false, reason: 'Navigation links are outside the upload-arbiter scope.' };
  if (type === 'submit' || SENSITIVE_ACTION.test(label) || EXACT_FINAL_ACTION.test(label)) {
    return { safe: false, reason: 'Final submission and account-security actions stay owned by deterministic uploader code.' };
  }
  if (DESTRUCTIVE_ACTION.test(label) || PURCHASE_OR_ACCOUNT_ACTION.test(label) || matchesDeniedLabel(label, deniedClickTexts)) {
    return { safe: false, reason: 'The proposed click is destructive, commercial, account-changing, or explicitly denied at this checkpoint.' };
  }

  const knownSafe = (submissionAttempted
    ? [...POST_SUBMIT_SAFE_LABELS, ...allowedClickTexts]
    : [...GENERIC_SAFE_LABELS, ...allowedClickTexts])
      .map(normalizeLabel)
      .filter(Boolean)
      .some((allowed) => label === allowed || label.includes(allowed));
  if (knownSafe) return { safe: true, reason: 'The control matches a known-safe or caller-approved action.' };

  // Scenario-driven recovery: a vision-grounded model may choose a previously
  // unseen, reversible button inside the currently visible modal. Hard guards
  // above still prevent final submission, navigation, credentials, deletion,
  // account changes, and purchases. This avoids requiring a code release every
  // time a platform changes "Not now" to a new label.
  const interactiveRole = normalizeLabel(descriptor.role || descriptor.tag);
  if (modelProposed && allowContextualDialogActions && descriptor.inDialog
      && descriptor.dialogHasDraftEditor !== true
      && (!Number.isFinite(Number(descriptor.dialogButtonCount)) || Number(descriptor.dialogButtonCount) <= 12)
      && ['button', 'menuitem'].some((role) => interactiveRole.includes(role))) {
    return { safe: true, reason: 'The model selected a reversible control inside the active blocking dialog.' };
  }

  return { safe: false, reason: 'The proposed click is outside the checkpoint policy.' };
}

function transientRecoveryLabelsForBody(bodyText = '') {
  return TRANSIENT_ERROR_PAGE.test(String(bodyText || ''))
    ? [...TRANSIENT_ERROR_RECOVERY_LABELS]
    : [];
}

function isSafeArbiterClickDescriptor(descriptor = {}, allowedClickTexts = [], submissionAttempted = false, options = {}) {
  return assessArbiterClickDescriptor(descriptor, {
    ...options,
    allowedClickTexts,
    submissionAttempted,
  }).safe;
}

async function elementDescriptor(locator) {
  return locator.evaluate((element) => {
    const dialog = element.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    return {
      tag: String(element.tagName || '').toLowerCase(),
      role: element.getAttribute('role') || '',
      text: (element.innerText || element.textContent || '').slice(0, 180),
      ariaLabel: element.getAttribute('aria-label') || '',
      title: element.getAttribute('title') || '',
      value: element.getAttribute('value') || '',
      type: element.getAttribute('type') || '',
      href: element.getAttribute('href') || '',
      disabled: Boolean(element.disabled),
      ariaDisabled: element.getAttribute('aria-disabled') || '',
      inDialog: Boolean(dialog),
      dialogText: (dialog?.innerText || '').slice(0, 600),
      dialogButtonCount: dialog?.querySelectorAll('button, [role="button"], [role="menuitem"]').length || 0,
      dialogHasDraftEditor: Boolean(dialog?.querySelector('textarea, [contenteditable="true"], [contenteditable=""], input[type="file"]')),
    };
  }).catch(() => null);
}

async function pageFingerprint(page) {
  return page.evaluate(() => {
    const visibleDialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && element.getAttribute('aria-hidden') !== 'true';
      });
    return {
      url: window.location.href,
      dialogs: visibleDialogs.length,
      dialogText: visibleDialogs.map((element) => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').slice(0, 260)).join(' | '),
      files: document.querySelectorAll('input[type="file"]').length,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
    };
  }).catch(() => ({ url: page.url(), dialogs: 0, dialogText: '', files: 0, text: '' }));
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

async function clickSafeFallback(page, allowedClickTexts, deniedClickTexts, submissionAttempted) {
  const candidates = page.locator('button:visible, [role="button"]:visible, [role="menuitem"]:visible, a:visible');
  const count = Math.min(await candidates.count().catch(() => 0), 80);
  for (let index = 0; index < count; index++) {
    const locator = candidates.nth(index);
    const descriptor = await elementDescriptor(locator);
    if (!isSafeArbiterClickDescriptor(descriptor, allowedClickTexts, submissionAttempted, { deniedClickTexts })) continue;
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
    deniedClickTexts = [],
    submissionAttempted = false,
    maxSteps = 4,
    progressMeansRecovered = false,
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
  // A platform-wide transient error screen is not a final submission control.
  // Permit only its reversible Retry/Reload family after the page itself proves
  // that it is in a recognized error state. All destructive, account, payment,
  // navigation, and final Post/Publish guards below still apply unchanged.
  const effectiveAllowedClickTexts = [
    ...allowedClickTexts,
    ...transientRecoveryLabelsForBody(before.text),
  ];
  const knownSafeSummary = (submissionAttempted
    ? [...POST_SUBMIT_SAFE_LABELS, ...effectiveAllowedClickTexts]
    : [...GENERIC_SAFE_LABELS, ...effectiveAllowedClickTexts]).join(', ');
  const deniedSummary = deniedClickTexts.length ? deniedClickTexts.join(', ') : '(checkpoint hard guards only)';
  const goal = [
    `Diagnose and clear a non-submission obstacle for ${platform} at checkpoint "${checkpoint}".`,
    'The normal uploader will continue afterward and owns all final Post/Publish/Share actions.',
    `Known-safe labels: ${knownSafeSummary}. Explicitly denied labels: ${deniedSummary}.`,
    'You may choose a different visible button only when it is inside the active blocking dialog and is a reversible way to dismiss, defer, retry, or accept a non-account optional setting.',
    'Never click Post, Publish, Share, Tweet, Submit, Send, Schedule, Next, Done, or a file picker.',
    'Never delete/discard content, cancel an upload, buy/subscribe/promote, change an account, fill credentials or verification codes, or navigate away.',
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

  for (let step = 1; step <= Math.max(1, Math.min(maxSteps, 4)); step++) {
    if (typeof verify === 'function' && await verify().catch(() => false)) {
      saveArbiterResult(artifact, 'already-recovered', decisions);
      await emitTrace('resolved', { result: 'The checkpoint recovered before any arbiter action was necessary.' });
      return { recovered: true, reason: 'Checkpoint became ready before arbiter action.', artifactPath: artifact.recordPath };
    }

    const plannerHistory = decisions.map((item) => ({
      action: item.proposed?.action || 'observe',
      selector: item.proposed?.selector || '',
      ok: item.executed,
      stateChanged: item.stateChanged,
      reason: item.denialReason || item.proposed?.reason || '',
    }));
    const stepBefore = await pageFingerprint(page);
    const action = await withTimeout(
      planner(page, goal, plannerHistory, { useVision, model: modelId, baseUrl: LOCAL_LM_BASE_URL, nativeApi: true }),
      ARBITER_PLAN_TIMEOUT_MS,
      { action: 'failed', reason: 'Local AI arbiter timed out.', goalReached: false },
    );
    const decision = { step, proposed: action, proposedExecuted: false, executed: false, denialReason: '' };

    if (action?.action === 'click' && action.selector) {
      const locator = page.locator(action.selector).first();
      const descriptor = await elementDescriptor(locator);
      decision.descriptor = descriptor;
      const assessment = assessArbiterClickDescriptor(descriptor || {}, {
        allowedClickTexts: effectiveAllowedClickTexts,
        deniedClickTexts,
        submissionAttempted,
        modelProposed: true,
      });
      decision.policy = assessment;
      if (assessment.safe) {
        decision.proposedExecuted = await locator.click({ timeout: 5000 }).then(() => true).catch(() => false);
        decision.executed = decision.proposedExecuted;
      } else {
        decision.denialReason = assessment.reason;
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
      const fallback = await clickSafeFallback(page, effectiveAllowedClickTexts, deniedClickTexts, submissionAttempted);
      if (fallback.clicked) {
        decision.fallback = fallback.descriptor;
        decision.executed = true;
      }
    }

    await page.waitForTimeout(900).catch(() => {});
    const stepAfter = await pageFingerprint(page);
    decision.stateChanged = JSON.stringify(stepBefore) !== JSON.stringify(stepAfter);
    decision.dialogsBefore = stepBefore.dialogs;
    decision.dialogsAfter = stepAfter.dialogs;
    decisions.push(decision);
    const proposedTarget = decision.descriptor
      ? [decision.descriptor.text, decision.descriptor.ariaLabel, decision.descriptor.title].filter(Boolean).join(' / ')
      : String(action?.selector || '');
    await emitTrace('answer', {
      answer: action?.reason || 'The model returned no explanation.',
      action: action?.action || 'none',
      target: proposedTarget,
      executed: decision.executed,
      executionMode: decision.proposedExecuted ? 'model-selected click' : decision.fallback ? 'known-safe fallback click' : 'not executed',
      denialReason: decision.denialReason,
    });
    await page.waitForTimeout(600).catch(() => {});
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

    if (progressMeansRecovered && decision.executed && decision.stateChanged
        && stepBefore.dialogs > 0 && stepAfter.dialogs === 0) {
      console.log(`[UploadArbiter] ${platform}/${checkpoint}: blocking dialog cleared; returning control to the deterministic uploader.`);
      saveArbiterResult(artifact, 'obstacle-cleared', decisions);
      await emitTrace('resolved', {
        result: action?.reason || 'The blocking dialog was cleared and the normal uploader can resume.',
        action: action?.action || 'safe action',
        target: proposedTarget,
      });
      return {
        recovered: true,
        checkpointReady: false,
        obstacleCleared: true,
        reason: action?.reason || 'Blocking dialog cleared; normal uploader should resume.',
        artifactPath: artifact.recordPath,
      };
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
  __test: { assessArbiterClickDescriptor, isSafeArbiterClickDescriptor, isAgentCompatibleModel, redactDiagnosticText, selectArbiterModel, transientRecoveryLabelsForBody },
};
