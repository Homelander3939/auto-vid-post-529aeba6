const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { chromium } = require('playwright');
const { launchPersistentSafe } = require('./profileLock');
const { runAgentTask } = require('./uploaders/smart-agent');
const {
  browserMilestoneProgress,
  compileBrowserCompletionContract,
} = require('./agentKernel');

const DATA_ROOT = path.join(__dirname, 'data', 'local-browser-sessions');
const PROFILE_DIR = path.join(__dirname, 'data', 'browser-sessions', 'local-browser-operator');
const DEFAULT_URL = 'https://www.google.com/';
const MAX_EVENTS = 80;

let taskQueue = Promise.resolve();
const privateSessionTasks = new Map();

function oneLine(value, max = 500) {
  return String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function normalizeAllowedEmails(values = []) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean));
}

function redactSecrets(value, options = {}) {
  const allowedEmails = normalizeAllowedEmails(options.allowedEmails);
  return String(value || '')
    .replace(/(\b(?:password|passcode|api[_ -]?key|(?:access[_ -]?|auth[_ -]?)?token|secret)\s*(?::|=|\bis\b)\s*)["']?[^\s,;"']+/gi, '$1[redacted]')
    .replace(EMAIL_PATTERN, (email) => allowedEmails.has(email.toLowerCase()) ? email : '[account]');
}

function extractPublicEmails(value) {
  return [...new Set((String(value || '').match(EMAIL_PATTERN) || [])
    .map((email) => email.toLowerCase()))];
}

function requestsPublicContactEmail(task) {
  const text = String(task || '');
  return /\b(?:find|locate|get|extract|identify|show|give|send|tell|what(?:'s| is)?)\b[\s\S]{0,180}\b(?:contact|support|business|company)?\s*e-?mail\b/i.test(text)
    || /\b(?:contact|support|business|company)\s+e-?mail\b/i.test(text);
}

function requestsPublicContactInformation(task) {
  const text = String(task || '');
  return requestsPublicContactEmail(text)
    || /\b(?:find|locate|get|extract|identify|show|give|send|tell|collect|look\s*up)\b[\s\S]{0,180}\b(?:public\s+)?(?:company|business|website|their)?\s*contact\s+(?:info(?:rmation)?|details?|data)\b/i.test(text)
    || /\b(?:contact\s+(?:info(?:rmation)?|details?|data)|how\s+to\s+contact\s+(?:them|the\s+company|the\s+business))\b/i.test(text);
}

function extractPublicPhones(value) {
  const text = String(value || '');
  const candidates = [];
  for (const match of text.matchAll(/(?:^|\n)\s*(?:phone|telephone|tel\.?|mobile|whatsapp)\s*[:\-]?\s*([^\n]{5,80})/gim)) {
    const raw = String(match[1] || '').trim().replace(/\s{2,}.*/, '');
    const phone = raw.match(/\+?[\d][\d\s().\-]{5,}\d/)?.[0]?.trim();
    const digitCount = String(phone || '').replace(/\D/g, '').length;
    if (phone && digitCount >= 7 && digitCount <= 15) candidates.push(phone);
  }
  for (const match of text.matchAll(/\+[\d][\d\s().\-]{5,}\d/g)) {
    const phone = String(match[0] || '').trim();
    const digitCount = phone.replace(/\D/g, '').length;
    if (digitCount >= 7 && digitCount <= 15) candidates.push(phone);
  }
  return [...new Set(candidates)];
}

function extractPublicLocations(value) {
  const text = String(value || '');
  const candidates = [];
  for (const match of text.matchAll(/(?:^|\n)\s*(?:address|location|office|headquarters|hq)\s*[:\-]?\s*([^\n]{3,180})/gim)) {
    const location = String(match[1] || '').trim().replace(/\s{2,}.*/, '');
    if (location && !/^https?:/i.test(location)) candidates.push(location);
  }
  for (const match of text.matchAll(/\b([A-Z][A-Za-z .'-]{1,60},\s*[A-Z][A-Za-z .'-]{1,60})\s*(?:[·|\-]\s*)?Remote[- ]first\b/g)) {
    const location = String(match[1] || '').trim();
    if (location) candidates.push(`${location} · Remote-first`);
  }
  return [...new Set(candidates)];
}

function publicFactsForTask(task, pageText, mailtoEmails = [], sourceUrl = '') {
  if (!requestsPublicContactInformation(task)) {
    return { contactEmails: [], contactPhones: [], contactLocations: [], sourceUrls: [] };
  }
  const privateTaskEmails = new Set(extractPublicEmails(task));
  return {
    contactEmails: [...new Set([
      ...extractPublicEmails(pageText),
      ...(Array.isArray(mailtoEmails) ? mailtoEmails : []).flatMap(extractPublicEmails),
    ])].filter((email) => !privateTaskEmails.has(email)),
    contactPhones: extractPublicPhones(pageText),
    contactLocations: extractPublicLocations(pageText),
    sourceUrls: /^https?:\/\//i.test(String(sourceUrl || '')) ? [String(sourceUrl)] : [],
  };
}

function mergePublicContactFacts(facts = []) {
  const merged = {
    contactEmails: [],
    contactPhones: [],
    contactLocations: [],
    sourceUrls: [],
  };
  for (const item of facts) {
    for (const key of Object.keys(merged)) {
      if (Array.isArray(item?.[key])) merged[key].push(...item[key]);
    }
  }
  for (const key of Object.keys(merged)) merged[key] = [...new Set(merged[key].filter(Boolean))];
  return merged;
}

function formatPublicContactFacts(facts = {}) {
  const lines = [];
  if (facts.contactEmails?.length) lines.push(`Email: ${facts.contactEmails.join(', ')}`);
  if (facts.contactPhones?.length) lines.push(`Phone: ${facts.contactPhones.join(', ')}`);
  if (facts.contactLocations?.length) lines.push(`Location: ${facts.contactLocations.join(' | ')}`);
  return lines.join('\n');
}

function deriveTaskPermissions(task) {
  const text = String(task || '');
  const allowCalendarWrite = /\b(?:add|create|schedule|book)\b[\s\S]{0,100}\b(?:event|calendar|appointment|meeting)\b/i.test(text);
  return {
    allowCredentialEntry: /\b(?:credentials?|password|log\s*in|login|sign\s*in)\b/i.test(text),
    allowCalendarWrite,
    allowFormSubmission: allowCalendarWrite || /\b(?:create|add|submit|save|send|post|publish|apply|register|book|schedule|update|edit)\b/i.test(text),
    allowFileUpload: /\b(?:upload|attach|choose|select)\b[\s\S]{0,100}\b(?:file|image|photo|video|document|attachment)\b/i.test(text),
    allowDownload: /\b(?:download|export|save)\b[\s\S]{0,100}\b(?:file|image|photo|video|document|report|archive|pdf|csv|zip)\b/i.test(text),
    allowDestructive: /\b(?:delete|remove|cancel)\b[\s\S]{0,120}\b(?:the|this|named|id|event|item|record|account|post|file|booking|appointment)\b/i.test(text),
  };
}

function normalizeStartUrl(value) {
  const raw = oneLine(value, 2000) || DEFAULT_URL;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Local browser tasks only accept HTTP or HTTPS addresses.');
  }
  return url.toString();
}

function isSnapshotOnlyTask(task) {
  const text = String(task || '');
  if (requestsPublicContactInformation(text)) return false;
  return /^\s*(?:read|inspect|summari[sz]e|identify|list|extract|describe|review)\b/i.test(text);
}

async function readPageSnapshot(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const unique = (values, max) => [...new Set(values.map(clean).filter(Boolean))].slice(0, max);
    return {
      headings: unique(Array.from(document.querySelectorAll('h1,h2,h3,h4,[role="heading"]')).map((element) => element.textContent), 40),
      controls: unique(Array.from(document.querySelectorAll('a,button,[role="button"]')).map((element) => element.textContent || element.getAttribute('aria-label')), 40),
      body: clean(document.body?.innerText).slice(0, 6000),
    };
  }).catch(() => ({ headings: [], controls: [], body: '' }));
}

function publicStep(step = {}, options = {}) {
  const action = oneLine(step.action || 'working', 40);
  const verifiedLinks = Array.isArray(step.verifiedLinks)
    ? step.verifiedLinks.map((link) => ({
      url: oneLine(link?.url, 2000),
      text: oneLine(link?.text, 500),
    })).filter((link) => /^https?:\/\//i.test(link.url))
    : [];
  return {
    step: Number(step.step || 0),
    action,
    ok: step.ok !== false,
    message: oneLine(redactSecrets(step.reason || (step.ok === false ? 'Action did not complete.' : `${action} completed.`), options), 500),
    url: step.url && /^https?:/i.test(String(step.url)) ? oneLine(step.url, 1200) : null,
    phase: oneLine(step.phase || (action === 'observe' ? 'before' : 'after'), 20),
    state_changed: typeof step.stateChanged === 'boolean' ? step.stateChanged : null,
    screenshot_key: step.screenshotKey ? oneLine(step.screenshotKey, 180) : null,
    download_path: step.downloadPath ? oneLine(step.downloadPath, 1200) : null,
    verified_links: verifiedLinks,
    at: new Date().toISOString(),
  };
}

function checkpointHistory(history = [], options = {}) {
  return (Array.isArray(history) ? history : []).slice(-24).map((step) => ({
    step: Number(step?.step || 0),
    action: oneLine(step?.action || 'working', 40),
    ok: step?.ok !== false,
    stateChanged: typeof step?.stateChanged === 'boolean' ? step.stateChanged : null,
    reason: oneLine(redactSecrets(step?.reason || '', options), 500),
    url: /^https?:\/\//i.test(String(step?.url || '')) ? oneLine(step.url, 1200) : null,
    downloadPath: step?.downloadPath ? oneLine(step.downloadPath, 1200) : null,
    verifiedLinks: Array.isArray(step?.verifiedLinks)
      ? step.verifiedLinks.map((link) => ({ url: oneLine(link?.url, 2000), text: oneLine(link?.text, 500) })).filter((link) => /^https?:\/\//i.test(link.url))
      : [],
  }));
}

async function buildSessionCheckpoint(task, activePage, history = [], options = {}) {
  const publicTask = oneLine(redactSecrets(task), 4000);
  const contract = compileBrowserCompletionContract(publicTask);
  const snapshot = activePage ? await readPageSnapshot(activePage) : { body: '', controls: [] };
  const url = activePage ? oneLine(activePage.url(), 2000) : oneLine(options.url, 2000);
  const title = activePage ? oneLine(await activePage.title().catch(() => ''), 500) : oneLine(options.title, 500);
  const progress = browserMilestoneProgress(contract, {
    url,
    title,
    bodyText: snapshot.body,
    interactive: (snapshot.controls || []).map((text) => ({ text })),
  }, history);
  const lastVerification = [...history].reverse().find((step) => step?.verification)?.verification || null;
  return {
    version: 1,
    saved_at: new Date().toISOString(),
    safe_to_resume: options.hasPrivateInput !== true,
    resume_blocker: options.hasPrivateInput === true ? 'Private input is held only in memory and must be supplied again after restart.' : null,
    last_url: url,
    last_title: title,
    step_count: history.reduce((max, step) => Math.max(max, Number(step?.step || 0)), 0),
    contract,
    progress,
    verification: lastVerification,
    history: checkpointHistory(history, options),
  };
}

async function saveSessionCheckpoint(supabase, id, task, activePage, history = [], options = {}) {
  const checkpoint = await buildSessionCheckpoint(task, activePage, history, options);
  await updateSession(supabase, id, { checkpoint });
  return checkpoint;
}

async function evaluateBrowserActionSafety(action = {}, page = null, permissions = {}) {
  const type = oneLine(action.action, 40).toLowerCase();
  if (page) {
    const humanVerificationVisible = await page.evaluate(() => {
      const text = String(document.body?.innerText || '').toLowerCase().slice(0, 5000);
      return Boolean(
        document.querySelector('iframe[src*="recaptcha"],iframe[src*="captcha"],.g-recaptcha,.h-captcha,[data-sitekey]')
        || /\b(?:captcha|verify you(?:'re| are) human|i(?:'m| am) not a robot|human verification|unusual traffic)\b/.test(text)
      );
    }).catch(() => false);
    if (humanVerificationVisible) {
      return { allowed: false, reason: 'Human verification is visible and needs the user before the browser can continue.' };
    }
  }
  if (type === 'upload_file') {
    if (!permissions.allowFileUpload) return { allowed: false, reason: 'File upload was not requested in this browser task.' };
    let isFile = false;
    try {
      isFile = Boolean(action.value && fs.existsSync(String(action.value)) && fs.statSync(String(action.value)).isFile());
    } catch {
      isFile = false;
    }
    if (!isFile) {
      return { allowed: false, reason: 'The requested local upload file was not found.' };
    }
  }
  if (type === 'download' && !permissions.allowDownload) {
    return { allowed: false, reason: 'A file download was not requested in this browser task.' };
  }
  if (type === 'navigate') {
    try {
      normalizeStartUrl(action.url);
    } catch (error) {
      return { allowed: false, reason: error.message };
    }
  }

  let elementDescription = '';
  if (page && action.selector && ['click', 'fill', 'select'].includes(type)) {
    elementDescription = await page.$eval(action.selector, (element) => [
      element.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('name'),
      element.getAttribute('type'),
      element.getAttribute('value'),
    ].filter(Boolean).join(' ')).catch(() => '');
  }

  const signal = `${action.selector || ''} ${action.value || ''} ${action.reason || ''} ${elementDescription}`.toLowerCase();
  if (type === 'fill' && /one[- ]?time|otp|credit|card number|cvv|cvc|bank|routing|api[-_ ]?key/.test(signal)) {
    return { allowed: false, reason: 'Credential, verification-code, payment, or secret entry needs the user or a specialized account workflow.' };
  }
  if (type === 'fill' && /password|passcode|secret/.test(signal) && !permissions.allowCredentialEntry) {
    return { allowed: false, reason: 'Credential entry was not part of the user task.' };
  }

  if (type === 'click' && /\b(buy|purchase|pay|transfer|place order|confirm order|change password|two.factor|security settings)\b/.test(signal)) {
    return { allowed: false, reason: 'Payment, transfer, purchase, and account-security confirmations require the user.' };
  }
  if (type === 'click' && /\b(delete|remove|cancel)\b/.test(signal) && !permissions.allowDestructive) {
    return { allowed: false, reason: 'A destructive action was not explicitly requested.' };
  }
  if (type === 'click' && /\b(sign[ -]?in|log[ -]?in)\b/.test(signal) && !permissions.allowCredentialEntry) {
    return { allowed: false, reason: 'Login was not part of the user task.' };
  }
  if (type === 'click' && /\b(post|publish|send|submit|save|create|apply|register|book|schedule|update)\b/.test(signal) && !permissions.allowFormSubmission) {
    return { allowed: false, reason: 'A consequential final click was not authorized by this task.' };
  }

  return { allowed: true };
}

async function readSession(supabase, id) {
  const { data, error } = await supabase.from('browser_sessions').select('*').eq('id', id).single();
  if (error) throw new Error(error.message || String(error));
  return data;
}

async function updateSession(supabase, id, patch) {
  const { data, error } = await supabase.from('browser_sessions').update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq('id', id).select('*').single();
  if (error) throw new Error(error.message || String(error));
  return data;
}

async function appendEvent(supabase, id, event, page = null) {
  const current = await readSession(supabase, id);
  const events = [...(Array.isArray(current.events) ? current.events : []), event].slice(-MAX_EVENTS);
  const patch = {
    events,
    step_count: Math.max(Number(current.step_count || 0), Number(event.step || 0)),
  };
  if (page) {
    patch.current_url = oneLine(page.url(), 2000);
    patch.current_title = oneLine(await page.title().catch(() => ''), 500);
  }
  return updateSession(supabase, id, patch);
}

function screenshotPath(id) {
  return path.join(DATA_ROOT, id, 'latest.jpg');
}

async function captureSessionScreenshot(supabase, id, page, options = {}) {
  const target = screenshotPath(id);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const step = Math.max(0, Number(options.step || 0));
  const phase = oneLine(options.phase || 'after', 20).replace(/[^a-z0-9_-]/gi, '-') || 'after';
  const screenshotKey = `step-${String(step).padStart(3, '0')}-${phase}-${Date.now()}.jpg`;
  const historyTarget = path.join(directory, screenshotKey);
  try {
    const buffer = options.screenshotBase64
      ? Buffer.from(options.screenshotBase64, 'base64')
      : await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false });
    fs.writeFileSync(historyTarget, buffer);
    fs.writeFileSync(target, buffer);
  } catch {
    return null;
  }
  if (fs.existsSync(target)) {
    await updateSession(supabase, id, { screenshot_version: Date.now(), screenshot_available: true });
  }
  return screenshotKey;
}

function buildAgentGoal(task, permissions = deriveTaskPermissions(task)) {
  const credentialRule = permissions.allowCredentialEntry
    ? 'If the saved browser profile is already signed in, reuse that session and never navigate back to login. Otherwise, you may use the exact credentials supplied in this task only on the requested site. Never repeat them in logs, reasons, summaries, or messages. Stop for any verification code or CAPTCHA.'
    : 'Do not enter credentials, verification codes, or secrets.';
  const writeRule = permissions.allowFormSubmission
    ? 'You may complete and submit the exact form or creation task requested. Use only values supplied by the user or existing defaults; never invent dates, times, names, contact data, payment state, or notes. After submission, visually verify the requested result is present before reporting done.'
    : 'Do not submit forms or create external records unless the task explicitly requests it.';
  const fileRule = permissions.allowFileUpload || permissions.allowDownload
    ? 'File upload or download is allowed only to the extent explicitly requested in this task.'
    : 'Do not upload or download files.';
  return `${task}\n\nLOCAL VISION BROWSER RULES: Complete the allowed request yourself in the visible browser; never replace execution with a tutorial, manual instructions, or a suggestion that the user do the browser work. Break multi-part goals into private milestones and finish every requested part before reporting done. Operate the page directly, one verified action at a time, using the fewest necessary steps. Inspect the fresh screenshot, DOM controls, page landmarks, and exact discovered links before every action. When the user asks for facts such as public contact information, navigate to the relevant page, extract exact visible values, and return the values rather than placeholders or descriptions. Never invent or reconstruct an email, phone number, address, URL, date, identifier, or success state. ${credentialRule} ${writeRule} ${fileRule} Reuse the current signed-in state, adapt when selectors or layout change, handle cookie banners, menus, redirects, lazy content, popups and new tabs, and verify visible state changes. If one strategy makes no visible progress, inspect again and use a different grounded control or exact discovered href. Stop only when required user input, human verification, or a genuinely unsupported consequential action prevents completion. Never enter payment data, buy, transfer funds, change account security, or attempt to bypass human verification challenges.`;
}

async function prepareAuthenticatedTaskPage(page, startUrl, permissions = {}) {
  if (!permissions.allowCredentialEntry && !permissions.allowCalendarWrite) return false;
  const signedIn = await page.evaluate(() => {
    const text = String(document.body?.innerText || '').toLowerCase();
    return /\b(sign out|log out|logout)\b/.test(text);
  }).catch(() => false);
  if (!signedIn) return false;

  const dashboardControl = page.locator([
    'a[href*="/dashboard"]',
    'button:has-text("Dashboard")',
    '[role="button"]:has-text("Dashboard")',
    'a:has-text("Dashboard")',
  ].join(', ')).first();
  if (await dashboardControl.isVisible().catch(() => false)) {
    await dashboardControl.click({ timeout: 5000 }).catch(() => null);
  }
  await page.waitForTimeout(750).catch(() => null);
  return true;
}

async function runLocalBrowserSession(supabase, id, options = {}) {
  const notify = typeof options.notify === 'function' ? options.notify : null;
  const initial = await readSession(supabase, id);
  const privateTask = privateSessionTasks.get(id);
  if (initial.has_private_input === true && !privateTask) {
    const message = 'This browser task lost its in-memory login details after a backend restart. Resend the task to continue.';
    await updateSession(supabase, id, {
      status: 'needs_input',
      completed_at: new Date().toISOString(),
      error: message,
      summary: `🛑 Local Chromium stopped: ${message}`,
    });
    if (notify) await notify(`🛑 Local Chromium stopped\n${message}`).catch(() => null);
    return readSession(supabase, id);
  }
  const task = oneLine(privateTask || initial.task, 4000);
  const publicTask = oneLine(redactSecrets(task), 4000);
  const permissions = deriveTaskPermissions(task);
  const startUrl = normalizeStartUrl(initial.start_url);
  const initialHistory = initial.checkpoint?.safe_to_resume === true && Array.isArray(initial.checkpoint?.history)
    ? initial.checkpoint.history
    : [];
  const observedPublicFacts = [];
  let context;
  let page;

  const capturePublicFacts = async (activePage) => {
    if (!activePage || !requestsPublicContactInformation(task)) return;
    const pageText = await activePage.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const mailtoEmails = await activePage.locator('a[href^="mailto:"]').evaluateAll((links) => links
      .map((link) => String(link.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0])
      .filter(Boolean)).catch(() => []);
    observedPublicFacts.push(publicFactsForTask(task, pageText, mailtoEmails, activePage.url()));
  };

  await updateSession(supabase, id, {
    status: 'running',
    started_at: new Date().toISOString(),
    current_url: startUrl,
    error: null,
    framework_version: 3,
    vision_enabled: true,
    tool_calling_enabled: true,
  });

  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    context = await launchPersistentSafe(chromium, PROFILE_DIR, {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
      viewport: { width: 1440, height: 900 },
    }, { attempts: 2, waitMs: 15_000, label: 'local browser operator' });

    page = context.pages()[0] || await context.newPage();
    await appendEvent(supabase, id, publicStep({ action: 'launch', reason: 'Opened the saved local Chromium profile.', step: 0 }), page);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const navigationScreenshot = await captureSessionScreenshot(supabase, id, page, { step: 0, phase: 'navigate' });
    await appendEvent(supabase, id, publicStep({ action: 'navigate', reason: `Opened ${startUrl}`, url: startUrl, step: 0, screenshotKey: navigationScreenshot }), page);
    if (await prepareAuthenticatedTaskPage(page, startUrl, permissions)) {
      const resumeScreenshot = await captureSessionScreenshot(supabase, id, page, { step: 0, phase: 'resume' });
      await appendEvent(supabase, id, publicStep({
        action: 'resume',
        reason: 'Detected and reused the saved signed-in browser session.',
        step: 0,
        screenshotKey: resumeScreenshot,
      }), page);
    }

    // Read/inspect/list tasks do not need an expensive iterative control loop.
    // The browser still opens locally and produces the same auditable session,
    // but a deterministic page snapshot avoids pointless scrolling and saves VRAM.
    if (isSnapshotOnlyTask(task)) {
      const snapshot = await readPageSnapshot(page);
      const visibleItems = snapshot.headings.length ? snapshot.headings : snapshot.controls;
      const outcome = visibleItems.length
        ? `Visible page headings/items: ${visibleItems.join(' | ')}`.slice(0, 2400)
        : `Page text: ${snapshot.body.slice(0, 2200) || 'No readable page text was found.'}`;
      const inspectScreenshot = await captureSessionScreenshot(supabase, id, page, { step: 1, phase: 'inspect' });
      await appendEvent(supabase, id, publicStep({ action: 'inspect', reason: outcome, step: 1, ok: true, terminal: true, screenshotKey: inspectScreenshot }), page);
      const finalUrl = oneLine(page.url(), 2000);
      const finalTitle = oneLine(await page.title().catch(() => ''), 500);
      const summary = `✅ Local Chromium completed: ${publicTask}\n${outcome}\nPage: ${finalTitle || 'Untitled'}\n${finalUrl}`;
      await updateSession(supabase, id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        current_url: finalUrl,
        current_title: finalTitle,
        result: {
          success: true,
          final_state: 'snapshot-complete',
          summary: outcome,
          page_text_excerpt: snapshot.body.slice(0, 2500),
          headings: snapshot.headings,
          controls: snapshot.controls,
        },
        summary,
        checkpoint: await buildSessionCheckpoint(publicTask, page, [{
          action: 'done', step: 1, ok: true, stateChanged: true, reason: outcome,
        }], { hasPrivateInput: initial.has_private_input === true }),
      });
      if (notify) await notify(summary);
      return await readSession(supabase, id);
    }

    const result = await runAgentTask(page, buildAgentGoal(task, permissions), {
      maxSteps: 40,
      stepDelayMs: 150,
      useVision: true,
      verbose: true,
      handleCaptchas: false,
      planTimeoutMs: 75_000,
      downloadDir: path.join(process.env.USERPROFILE || path.dirname(__dirname), 'Downloads'),
      initialHistory,
      beforeAction: (action, activePage) => evaluateBrowserActionSafety(action, activePage, permissions),
      onRuntime: async (runtime) => {
        await updateSession(supabase, id, {
          agent_model: oneLine(runtime.modelId, 200),
          vision_enabled: runtime.visionActive === true,
          tool_calling_enabled: runtime.toolUse === true,
        });
      },
      onObserve: async (step, activePage, history, screenshotBase64) => {
        await capturePublicFacts(activePage);
        const screenshotKey = await captureSessionScreenshot(supabase, id, activePage, {
          step: step.step,
          phase: 'before',
          screenshotBase64,
        });
        await appendEvent(supabase, id, publicStep({ ...step, screenshotKey }), activePage);
        await saveSessionCheckpoint(supabase, id, publicTask, activePage, history, {
          hasPrivateInput: initial.has_private_input === true,
        });
      },
      onStep: async (step, activePage, history) => {
        const screenshotKey = await captureSessionScreenshot(supabase, id, activePage, { step: step.step, phase: step.terminal ? 'final' : 'after' });
        await appendEvent(supabase, id, publicStep({ ...step, screenshotKey }), activePage);
        await saveSessionCheckpoint(supabase, id, publicTask, activePage, history, {
          hasPrivateInput: initial.has_private_input === true,
        });
      },
    });

    page = result.page || page;

    const finalUrl = oneLine(page.url(), 2000);
    const finalTitle = oneLine(await page.title().catch(() => ''), 500);
    const pageText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const mailtoEmails = await page.locator('a[href^="mailto:"]').evaluateAll((links) => links
      .map((link) => String(link.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0])
      .filter(Boolean)).catch(() => []);
    observedPublicFacts.push(publicFactsForTask(task, pageText, mailtoEmails, finalUrl));
    const publicFacts = mergePublicContactFacts(observedPublicFacts);
    const allowedEmails = publicFacts.contactEmails;
    const bodyExcerpt = oneLine(pageText, 2500);
    const lastMeaningful = [...result.steps].reverse().find((step) => oneLine(step.reason));
    const verifiedLinks = [...new Map(result.steps
      .flatMap((step) => Array.isArray(step.verifiedLinks) ? step.verifiedLinks : [])
      .filter((link) => /^https?:\/\//i.test(String(link?.url || '')))
      .map((link) => [String(link.url), { url: oneLine(link.url, 2000), text: oneLine(link.text, 500) }])).values()];
    const verifiedFact = formatPublicContactFacts(publicFacts);
    const verifiedLinkFact = verifiedLinks.length
      ? `Verified page link${verifiedLinks.length === 1 ? '' : 's'}: ${verifiedLinks.map((link) => `${link.text ? `${link.text} — ` : ''}${link.url}`).join(' | ')}`
      : '';
    const outcome = verifiedFact
      || verifiedLinkFact
      || oneLine(redactSecrets(lastMeaningful?.reason, { allowedEmails }), 1000)
      || (result.success ? 'The requested browser task completed.' : `The browser stopped with status ${result.finalState}.`);
    const completed = result.success && result.finalState === 'done';
    const status = completed ? 'completed' : result.finalState === 'blocked' ? 'needs_input' : 'failed';
    const summary = `${completed ? '✅' : status === 'needs_input' ? '🛑' : '⚠️'} Local Chromium ${completed ? 'completed' : 'stopped'}: ${publicTask}\n${outcome}\nPage: ${finalTitle || 'Untitled'}\n${finalUrl}`;

    await captureSessionScreenshot(supabase, id, page, { step: Number(result.steps.length || 0), phase: 'complete' });
    await updateSession(supabase, id, {
      status,
      completed_at: new Date().toISOString(),
      current_url: finalUrl,
      current_title: finalTitle,
      result: {
        success: completed,
        final_state: result.finalState,
        summary: outcome,
        page_text_excerpt: bodyExcerpt,
        public_contact_emails: allowedEmails,
        public_contact_phones: publicFacts.contactPhones,
        public_contact_locations: publicFacts.contactLocations,
        public_contact_sources: publicFacts.sourceUrls,
        verified_links: verifiedLinks,
        actions: result.steps.map((step) => publicStep(step, { allowedEmails })),
        runtime: result.runtime,
        verification: [...result.steps].reverse().find((step) => step?.verification)?.verification || null,
      },
      summary,
      checkpoint: await buildSessionCheckpoint(publicTask, page, result.steps, {
        hasPrivateInput: initial.has_private_input === true,
      }),
    });
    if (notify) await notify(summary);
    return await readSession(supabase, id);
  } catch (error) {
    const message = oneLine(error.message || error, 1500);
    await updateSession(supabase, id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: message,
      summary: `❌ Local Chromium task failed: ${message}`,
    }).catch(() => null);
    if (notify) await notify(`❌ Local Chromium task failed\n${publicTask}\n${message}`).catch(() => null);
    throw error;
  } finally {
    privateSessionTasks.delete(id);
    if (context) await context.close().catch(() => null);
  }
}

async function createLocalBrowserSession(supabase, values = {}) {
  const task = oneLine(values.task, 4000);
  if (!task) throw new Error('A browser task is required.');
  const publicTask = oneLine(redactSecrets(task), 4000);
  const hasPrivateInput = publicTask !== task;
  const row = {
    id: randomUUID(),
    task: publicTask,
    start_url: normalizeStartUrl(values.url),
    source: oneLine(values.source || 'local-app', 100),
    has_private_input: hasPrivateInput,
    status: 'queued',
    events: [],
    result: null,
    summary: null,
    error: null,
    step_count: 0,
    screenshot_available: false,
    screenshot_version: null,
    framework_version: 3,
    vision_enabled: true,
    tool_calling_enabled: true,
    agent_model: null,
    checkpoint: {
      version: 1,
      saved_at: new Date().toISOString(),
      safe_to_resume: !hasPrivateInput,
      resume_blocker: hasPrivateInput ? 'Private input is held only in memory and must be supplied again after restart.' : null,
      last_url: normalizeStartUrl(values.url),
      last_title: '',
      step_count: 0,
      contract: compileBrowserCompletionContract(publicTask),
      progress: null,
      verification: null,
      history: [],
    },
  };
  const { data, error } = await supabase.from('browser_sessions').insert(row).select('*').single();
  if (error) throw new Error(error.message || String(error));
  if (hasPrivateInput) privateSessionTasks.set(row.id, task);
  return data;
}

function enqueueLocalBrowserSession(supabase, id, options = {}) {
  taskQueue = taskQueue.catch(() => null).then(() => runLocalBrowserSession(supabase, id, options));
  return taskQueue;
}

async function resumeLocalBrowserSession(supabase, id, options = {}) {
  const current = await readSession(supabase, id);
  if (current.has_private_input === true || current.checkpoint?.safe_to_resume === false) {
    throw new Error('This session used private input that was intentionally not saved. Resend the task to continue safely.');
  }
  if (current.status === 'completed') throw new Error('This browser session is already completed.');
  if (['queued', 'running'].includes(current.status)) throw new Error('This browser session is already queued or running.');
  const resumeUrl = normalizeStartUrl(current.checkpoint?.last_url || current.current_url || current.start_url);
  const session = await updateSession(supabase, id, {
    status: 'queued',
    start_url: resumeUrl,
    completed_at: null,
    error: null,
    summary: 'Resuming from the last safe local checkpoint…',
  });
  enqueueLocalBrowserSession(supabase, id, options).catch(() => null);
  return session;
}

function getSessionScreenshotPath(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const target = screenshotPath(String(id));
  return fs.existsSync(target) ? target : null;
}

function getSessionScreenshotHistoryPath(id, key) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const safeKey = String(key || '');
  if (!/^step-\d{3}-[a-z0-9_-]+-\d+\.jpg$/i.test(safeKey)) return null;
  const directory = path.resolve(DATA_ROOT, String(id));
  const target = path.resolve(directory, safeKey);
  if (!target.startsWith(`${directory}${path.sep}`) || !fs.existsSync(target)) return null;
  return target;
}

module.exports = {
  buildAgentGoal,
  createLocalBrowserSession,
  enqueueLocalBrowserSession,
  evaluateBrowserActionSafety,
  deriveTaskPermissions,
  getSessionScreenshotPath,
  getSessionScreenshotHistoryPath,
  isSnapshotOnlyTask,
  normalizeStartUrl,
  prepareAuthenticatedTaskPage,
  publicStep,
  publicFactsForTask,
  requestsPublicContactInformation,
  requestsPublicContactEmail,
  resumeLocalBrowserSession,
  runLocalBrowserSession,
  buildSessionCheckpoint,
};
