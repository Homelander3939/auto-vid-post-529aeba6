// Smart browser agent helper for local Playwright uploaders.
// Takes screenshots, analyzes page state with AI, and decides next action.
// This gives the local server the same intelligence as the cloud version.
//
// ─────────────────────────────────────────────────────────────────────────────
// Agentic capabilities (page-agent-style, adapted for server-side Playwright)
// ─────────────────────────────────────────────────────────────────────────────
// page-agent (https://github.com/alibaba/page-agent) is a *client-side*
// library designed to run inside browser JavaScript context.  It cannot be
// used directly here because our automation runs from a Node.js server that
// controls Chromium through Playwright's remote protocol.
//
// Instead we implement the same core concept natively:
//   1. extractPageContext() – lightweight, text-based DOM snapshot (no screenshot
//      required, mirrors page-agent's DOM-first approach).
//   2. planNextAction()     – sends context + natural-language goal to the LLM
//      and receives a concrete Playwright action to execute.
//   3. executeAgentAction() – executes the LLM-chosen action via Playwright.
//   4. runAgentTask()       – iterative plan → execute loop until goal is
//      reached, failed, or the maximum step budget is exhausted.
//
// All four functions are exported and can be used directly by the uploaders
// (youtube.js, tiktok.js, instagram.js) for complex sequences that are hard
// to hard-code, or from any new agentic flow.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { ensureSingleLocalLLM } = require('../lm-studio-model-manager');
const {
  browserObservationBudget,
  compactBrowserObservation,
  normalizePlannedBrowserAction,
  verifyBrowserCompletion,
} = require('../agentKernel');
const { getTikTokPageDescription, isTikTokPublishedUrl, isTikTokUploadUrl } = require('./tiktok-state');

// LM Studio local model configuration
// Override with env vars: LM_STUDIO_URL, LM_STUDIO_MODEL, LM_STUDIO_API_KEY
const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234';
const DEFAULT_LM_STUDIO_MODEL = 'qwen3.8-27b-uncensored-aggressive';

// Track consecutive LLM failures to reduce log spam
let _llmConsecutiveFailures = 0;
// Log the first N failures verbosely, then every Nth failure thereafter to avoid spam
const LLM_SPAM_THRESHOLD = 3;

function redactAgentLog(value) {
  return String(value || '')
    .replace(/(\b(?:password|passcode|api[_ -]?key|(?:access[_ -]?|auth[_ -]?)?token|secret)\s*(?::|=|\bis\b)\s*)["']?[^\s,;"']+/gi, '$1[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[account]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns a user-friendly hint for common LLM connection errors.
 */
function getLLMErrorHint(err) {
  if (err.message === 'Invalid URL' || err.code === 'ERR_INVALID_URL') {
    return '(check LM_STUDIO_URL in server/.env — must include http:// or https://)';
  }
  if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
    return '(LM Studio not running — start LM Studio to enable AI assistance)';
  }
  return '';
}

function getLmStudioBaseUrl() {
  let base = (process.env.LM_STUDIO_URL || DEFAULT_LM_STUDIO_URL).trim().replace(/\/$/, '');
  // Auto-fix missing protocol prefix (common misconfiguration)
  if (base && !base.startsWith('http://') && !base.startsWith('https://')) {
    base = 'http://' + base;
  }
  try {
    new URL(base); // throws if URL is still invalid
    return base;
  } catch {
    console.warn(`[SmartAgent] LM_STUDIO_URL "${base}" is not a valid URL, using default (${DEFAULT_LM_STUDIO_URL})`);
    return DEFAULT_LM_STUDIO_URL;
  }
}

function getLmStudioUrl() {
  return `${getLmStudioBaseUrl()}/v1/chat/completions`;
}

function getLmStudioModel() {
  return process.env.LM_STUDIO_MODEL || DEFAULT_LM_STUDIO_MODEL;
}

// LM Studio does not require authentication; key is optional
function getApiKey() {
  return process.env.LM_STUDIO_API_KEY || process.env.LOVABLE_API_KEY || 'lm-studio';
}

// Vision is enabled by default — set LM_STUDIO_VISION=false to disable
function isVisionEnabled() {
  const val = (process.env.LM_STUDIO_VISION || 'true').toLowerCase();
  return val !== 'false' && val !== '0';
}

const BROWSER_ACTION_TOOL = {
  type: 'function',
  function: {
    name: 'browser_action',
    description: 'Choose exactly one observable browser action that advances the user goal.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'fill', 'select', 'press', 'hover', 'check', 'uncheck', 'navigate', 'back', 'reload', 'scroll', 'wait', 'upload_file', 'download', 'done', 'failed'],
        },
        ref: { type: 'string', description: 'Fresh element/link reference such as E3 or L2 from the grounded page view.' },
        selector: { type: 'string', description: 'A selector from the visible interactive-element list.' },
        value: { type: 'string', description: 'Text, option value, key name, or local file path required by the action.' },
        url: { type: 'string', description: 'Full HTTP/HTTPS URL for navigate.' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number' },
        ms: { type: 'number' },
        reason: { type: 'string', description: 'One short, user-safe explanation without secrets.' },
        goalReached: { type: 'boolean' },
      },
      required: ['action', 'reason', 'goalReached'],
      additionalProperties: false,
    },
  },
};

/**
 * Take a screenshot and return as base64
 */
async function takeScreenshot(page) {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 60 });
  return buffer.toString('base64');
}

/**
 * Analyze the current page state using LM Studio AI (with optional vision)
 */
async function analyzePage(page, context) {
  const url = page.url();
  const title = await page.title();

  const ctx = await extractPageContext(page).catch(() => ({ url, title, interactive: [], bodyText: '' }));
  const interactiveSummary = ctx.interactive.slice(0, 40)
    .map(e => `  [${e.tag}] selector="${e.selector}" text="${e.text}"`)
    .join('\n');

  const textPart = `Page body text (truncated):\n${ctx.bodyText}\n\nInteractive elements:\n${interactiveSummary}`;

  // Build user message — include screenshot if vision is enabled
  let userContent;
  if (isVisionEnabled()) {
    try {
      const screenshotB64 = await takeScreenshot(page);
      userContent = [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotB64}` } },
        { type: 'text', text: textPart },
      ];
    } catch {
      userContent = textPart;
    }
  } else {
    userContent = textPart;
  }

  try {
    const runtime = await ensureSingleLocalLLM({
      preferredModel: getLmStudioModel(),
      baseUrl: getLmStudioBaseUrl(),
      loadIfMissing: true,
    });
    const response = await fetch(getLmStudioUrl(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: runtime.modelId,
        messages: [
          {
            role: 'system',
            content: `You are a browser automation expert. Analyze the page DOM${isVisionEnabled() ? ' and the screenshot' : ''} and tell me the current state.

Context: ${context}
Current URL: ${url}
Page title: ${title}

Respond ONLY with a JSON object:
{
  "state": "login_email" | "login_password" | "verification_2fa" | "verification_code" | "logged_in" | "upload_page" | "upload_dialog" | "uploading" | "fill_details" | "processing" | "success" | "error" | "unknown",
  "description": "Brief description of what you see",
  "needs_human": false,
  "next_action": "Description of what to do next",
  "selector_hint": "CSS selector if obvious, or null"
}`,
          },
          {
            role: 'user',
            content: userContent,
          }
        ],
        max_tokens: 300,
        temperature: 0.1,
        reasoning_effort: 'none',
      }),
    });

    if (!response.ok) {
      console.error('[SmartAgent] AI analysis failed:', response.status);
      return analyzeDOMOnly(page, context);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        _llmConsecutiveFailures = 0; // reset on success
        return JSON.parse(jsonMatch[0]);
      } catch {
        console.log('[SmartAgent] Failed to parse AI response, using DOM analysis');
      }
    }
  } catch (err) {
    _llmConsecutiveFailures++;
    if (_llmConsecutiveFailures <= LLM_SPAM_THRESHOLD ||
        _llmConsecutiveFailures % LLM_SPAM_THRESHOLD === 0) {
      const hint = getLLMErrorHint(err);
      console.warn(`[SmartAgent] LM Studio request failed, using DOM analysis: ${err.message}${hint ? ' ' + hint : ''}`);
    }
  }

  return analyzeDOMOnly(page, context);
}

/**
 * Fallback: analyze page using DOM signals only
 */
async function analyzeDOMOnly(page, context) {
  const url = page.url();
  const info = await page.evaluate(() => {
    const text = (document.body?.innerText || '').substring(0, 2000).toLowerCase();
    return {
      hasEmailInput: !!document.querySelector('input[type="email"], input[name="username"], input[id="identifierId"]'),
      hasPasswordInput: !!document.querySelector('input[type="password"]:not([aria-hidden="true"])'),
      hasCodeInput: !!document.querySelector('input[type="tel"][autocomplete="one-time-code"], input[name*="code" i]'),
      hasFileInput: !!document.querySelector('input[type="file"]'),
      hasCreateButton: !!document.querySelector('#create-icon, [aria-label="Create"], [aria-label="New post"]'),
      hasCaptcha: !!(
        document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], iframe[title*="recaptcha" i]') ||
        document.querySelector('.g-recaptcha, .h-captcha, #captcha, [data-sitekey]') ||
        document.querySelector('[class*="captcha" i], [id*="captcha" i]')
      ),
      hasRobotCheck: text.includes('not a robot') || text.includes('are you a robot') ||
                     text.includes('verify you are human') || text.includes('unusual traffic') ||
                     text.includes('automated queries') || text.includes('bot detection') ||
                     text.includes('security check') || text.includes('prove you') ||
                     text.includes('confirm you are not') || text.includes('human verification'),
      hasCheckbox: !!(
        document.querySelector('iframe[src*="recaptcha"] + div, .recaptcha-checkbox') ||
        document.querySelector('[role="checkbox"]')
      ),
      bodyText: text,
      title: document.title,
    };
  });

  // CAPTCHA / robot detection — use LLM vision to try to solve
  if (info.hasCaptcha || info.hasRobotCheck) {
    return {
      state: 'captcha',
      description: info.hasRobotCheck ? 'Robot/human verification challenge detected' : 'CAPTCHA challenge detected',
      needs_human: false,
      next_action: 'Attempt to solve the challenge using vision analysis',
      has_checkbox: info.hasCheckbox,
    };
  }

  if (url.includes('accounts.google.com')) {
    if (info.hasPasswordInput) return { state: 'login_password', description: 'Google password entry', needs_human: false, next_action: 'Enter password' };
    if (info.hasEmailInput) return { state: 'login_email', description: 'Google email entry', needs_human: false, next_action: 'Enter email' };
    if (info.hasCodeInput) return { state: 'verification_code', description: '2FA code entry', needs_human: true, next_action: 'Enter verification code' };
    if (info.bodyText.includes('check your phone') || info.bodyText.includes('tap yes')) {
      return { state: 'verification_2fa', description: 'Phone approval needed', needs_human: true, next_action: 'Approve on phone' };
    }
    return { state: 'verification_2fa', description: 'Unknown Google auth state', needs_human: true, next_action: 'Check verification' };
  }

  if (url.includes('login') || url.includes('signin')) {
    if (info.hasPasswordInput && info.hasEmailInput) return { state: 'login_email', description: 'Login form', needs_human: false, next_action: 'Fill credentials' };
    if (info.hasPasswordInput) return { state: 'login_password', description: 'Password entry', needs_human: false, next_action: 'Enter password' };
    return { state: 'login_email', description: 'Login page', needs_human: false, next_action: 'Fill credentials' };
  }

  if (info.hasCreateButton) return { state: 'logged_in', description: 'Dashboard ready', needs_human: false, next_action: 'Click create/upload button' };
  if (info.hasFileInput) return { state: 'upload_dialog', description: 'Upload dialog visible', needs_human: false, next_action: 'Set file on input' };

  if (url.includes('studio.youtube.com') && !url.includes('accounts.google.com')) {
    return { state: 'logged_in', description: 'YouTube Studio dashboard', needs_human: false, next_action: 'Click Create button' };
  }

  if (isTikTokPublishedUrl(url)) {
    return { state: 'success', description: getTikTokPageDescription(url), needs_human: false, next_action: 'Review published video' };
  }

  if (isTikTokUploadUrl(url)) {
    return { state: 'upload_page', description: getTikTokPageDescription(url), needs_human: false, next_action: 'Upload video' };
  }

  if (url.includes('tiktok.com/tiktokstudio')) {
    return { state: 'logged_in', description: getTikTokPageDescription(url), needs_human: false, next_action: 'Open upload flow' };
  }

  if (url.includes('tiktok.com/creator') || url.includes('tiktok.com/upload')) {
    return { state: 'upload_page', description: 'TikTok creator page', needs_human: false, next_action: 'Upload video' };
  }

  if (url.includes('instagram.com') && !url.includes('login')) {
    return { state: 'logged_in', description: 'Instagram feed', needs_human: false, next_action: 'Click create post' };
  }

  return { state: 'unknown', description: 'Unknown page state', needs_human: false, next_action: 'Navigate to platform' };
}

/**
 * Wait for navigation/state change with smart polling
 */
async function waitForStateChange(page, previousUrl, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(1000);
    const currentUrl = page.url();
    if (currentUrl !== previousUrl) return true;
    // Check if page finished loading
    const ready = await page.evaluate(() => document.readyState === 'complete').catch(() => false);
    if (ready && Date.now() - start > 3000) return true;
  }
  return false;
}

/**
 * Robust element click with multiple strategies
 */
async function smartClick(page, selectors, fallbackText) {
  // Try each selector
  for (const sel of (Array.isArray(selectors) ? selectors : [selectors])) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          await el.click();
          return true;
        }
      }
    } catch {}
  }

  // Fallback: find by text content
  if (fallbackText) {
    try {
      const el = await page.locator(`text="${fallbackText}"`).first();
      if (await el.isVisible()) {
        await el.click();
        return true;
      }
    } catch {}
    
    // Try role-based
    try {
      const el = await page.getByRole('button', { name: new RegExp(fallbackText, 'i') }).first();
      if (await el.isVisible()) {
        await el.click();
        return true;
      }
    } catch {}
  }

  return false;
}

/**
 * Robust text input with native value setting
 */
async function smartFill(page, selectors, value) {
  for (const sel of (Array.isArray(selectors) ? selectors : [selectors])) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      
      await el.click();
      await page.waitForTimeout(200);
      
      // Triple-click to select all, then type
      await el.click({ clickCount: 3 });
      await page.waitForTimeout(100);
      await page.keyboard.type(value, { delay: 30 });
      return true;
    } catch {}
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC LOOP  (page-agent concept adapted for server-side Playwright)
// ─────────────────────────────────────────────────────────────────────────────

// Configuration constants for the agentic loop
const MAX_BODY_TEXT_LENGTH = 4500;
const MAX_INTERACTIVE_ELEMENTS = 80;
const SELECTOR_WAIT_TIMEOUT = 5000;

/**
 * Extract a lightweight, text-based snapshot of the page that can be sent to
 * an LLM without a screenshot.  The snapshot includes:
 *  - Current URL and page title
 *  - All interactive elements (buttons, inputs, selects, links, contenteditable)
 *    with their text, aria-label, name, id, type, placeholder, href attributes
 *  - First 1,500 characters of visible body text
 *
 * This mirrors page-agent's "DOM-first, no multi-modal" philosophy and keeps
 * token counts low while giving the model enough context to decide what to do.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{url:string, title:string, interactive:object[], bodyText:string}>}
 */
async function extractPageContext(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');

  const interactive = await page.evaluate((maxBodyLen) => {
    const TAG_SELECTORS = [
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'a[href]',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="tab"]',
      '[contenteditable="true"]',
      '[contenteditable=""]',
    ].join(',');

    /**
     * Return a stable CSS selector for an element so the agent can click/fill it.
     * Prefers id, then name, then aria-label, then nth-of-type index.
     */
    function selectorFor(el) {
      const tag = el.tagName.toLowerCase();
      const isUnique = (selector) => {
        try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
      };
      const attrValue = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (el.id) {
        const selector = `#${CSS.escape(el.id)}`;
        if (isUnique(selector)) return selector;
      }
      for (const attr of ['data-testid', 'name', 'aria-label', 'placeholder', 'href']) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        const selector = `${tag}[${attr}="${attrValue(value)}"]`;
        if (isUnique(selector)) return selector;
      }

      // Build a complete parent-qualified path. The old implementation returned
      // a parent-relative nth-of-type selector without the parent, which could
      // click the first matching element anywhere on the page.
      const parts = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName.toLowerCase();
        if (current.id) {
          parts.unshift(`#${CSS.escape(current.id)}`);
          break;
        }
        const parent = current.parentElement;
        let part = currentTag;
        if (parent) {
          const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        const selector = parts.join(' > ');
        if (isUnique(selector)) return selector;
        current = parent;
      }
      return parts.join(' > ') || tag;
    }

    const elements = [];
    const seen = new Set();
    document.querySelectorAll(TAG_SELECTORS).forEach((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const clipped = {
        left: Math.max(0, rect.left),
        top: Math.max(0, rect.top),
        right: Math.min(viewportWidth, rect.right),
        bottom: Math.min(viewportHeight, rect.bottom),
      };
      const inViewport = clipped.right > clipped.left && clipped.bottom > clipped.top;
      const hitPoints = inViewport ? [
        [0.5, 0.5],
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ] : [];
      const hitVisible = hitPoints.some(([xRatio, yRatio]) => {
        const x = clipped.left + ((clipped.right - clipped.left) * xRatio);
        const y = clipped.top + ((clipped.bottom - clipped.top) * yRatio);
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && (hit === el || el.contains(hit)));
      });
      const visible = rect.width > 0 && rect.height > 0 && inViewport && hitVisible &&
        style.visibility !== 'hidden' && style.display !== 'none' &&
        Number(style.opacity || 1) > 0 && el.getAttribute('aria-hidden') !== 'true';
      if (!visible) return;

      const sel = selectorFor(el);
      if (seen.has(sel)) return;
      seen.add(sel);

      const obj = {
        tag: el.tagName.toLowerCase(),
        selector: sel,
        text: (el.textContent || '').trim().substring(0, 80),
        type: el.getAttribute('type') || null,
        placeholder: el.getAttribute('placeholder') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        // Resolve relative links now. The agent must never reconstruct a URL
        // slug from visible text when the browser already knows the exact href.
        href: el.tagName.toLowerCase() === 'a' ? (el.href || null) : (el.getAttribute('href') || null),
        role: el.getAttribute('role') || null,
        disabled: el.disabled || false,
        position: `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`,
        filled: ['input', 'textarea'].includes(el.tagName.toLowerCase())
          ? Boolean(String(el.value || '').trim())
          : null,
        checked: typeof el.checked === 'boolean' ? el.checked : null,
      };
      elements.push(obj);
    });

    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const landmarks = [...new Set(Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"],nav,main,form'))
      .map((element) => clean(element.getAttribute('aria-label') || element.textContent))
      .filter(Boolean))].slice(0, 50);
    const discoveredLinks = [...new Map(Array.from(document.querySelectorAll('a[href]'))
      .map((element) => ({ href: element.href || '', text: clean(element.textContent || element.getAttribute('aria-label')) }))
      .filter((item) => /^https?:\/\//i.test(item.href))
      .map((item) => [item.href, item])).values()].slice(0, 80);
    const bodyText = (document.body?.innerText || '').substring(0, maxBodyLen);
    return { interactive: elements, bodyText, landmarks, discoveredLinks };
  }, MAX_BODY_TEXT_LENGTH).catch(() => ({ interactive: [], bodyText: '', landmarks: [], discoveredLinks: [] }));

  return {
    url,
    title,
    interactive: interactive.interactive,
    bodyText: interactive.bodyText,
    landmarks: interactive.landmarks,
    discoveredLinks: interactive.discoveredLinks,
  };
}

/**
 * Ask the LLM for the single best next Playwright action to advance toward
 * `goal`, given the current page context and the history of prior steps.
 *
 * The LLM returns a structured action object:
 * {
 *   action:    "click" | "fill" | "select" | "navigate" | "scroll" | "wait" | "done" | "failed",
 *   selector:  string | null,   // CSS selector (for click/fill/select)
 *   value:     string | null,   // text to type (fill) or option value (select)
 *   url:       string | null,   // destination URL (navigate)
 *   direction: "up" | "down",   // scroll direction
 *   amount:    number,          // pixels to scroll
 *   ms:        number,          // milliseconds to wait
 *   reason:    string,          // brief explanation
 *   goalReached: boolean        // true if the goal is already achieved
 * }
 *
 * @param {import('playwright').Page} page
 * @param {string} goal
 * @param {object[]} history   Previous action objects (for loop-prevention)
 * @param {{ useVision?: boolean, screenshotBase64?: string, model?: string, baseUrl?: string, apiKey?: string, nativeApi?: boolean, skipModelGuard?: boolean }} [opts]
 * @returns {Promise<object>}
 */
async function planNextAction(page, goal, history = [], opts = {}) {
  const ctx = await extractPageContext(page);
  const useVision = opts.useVision !== undefined ? opts.useVision : isVisionEnabled();
  const observationBudget = browserObservationBudget(goal, history, {
    vision: useVision,
    contextLength: opts.contextLength,
  });
  const observation = compactBrowserObservation(ctx, goal, history, observationBudget);
  const attachGrounding = (action) => {
    if (!action) return action;
    return {
      ...action,
      _groundingContext: {
        url: ctx.url,
        title: ctx.title,
        bodyText: ctx.bodyText,
        interactive: ctx.interactive.map((element) => ({
          selector: element.selector,
          tag: element.tag,
          type: element.type,
          text: element.text,
          ariaLabel: element.ariaLabel,
          placeholder: element.placeholder,
          href: element.href,
        })),
        discoveredLinks: ctx.discoveredLinks,
      },
    };
  };
  const useNativeApi = opts.nativeApi === true;
  const preferredModel = String(opts.model || getLmStudioModel()).trim();
  const normalizedBaseUrl = String(opts.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  const requestApiKey = String(opts.apiKey || getApiKey()).trim() || 'lm-studio';

  const recentHistory = history.slice(-observationBudget.historySteps).map((h, i) =>
    `  Step ${i + 1}: ${h.action}${h.selector ? ` selector="${h.selector}"` : ''}${h.ok === true ? ' ok=true' : h.ok === false ? ' ok=false' : ''}${h.stateChanged === true ? ' changed=true' : h.stateChanged === false ? ' changed=false' : ''} → ${redactAgentLog(h.reason || '')}`
  ).join('\n');

  const milestoneRows = observation.progress.rows
    .map((item) => `  [${item.complete ? 'done' : item.id === observation.progress.current?.id ? 'current' : 'pending'}] ${item.id}: ${item.label}`)
    .join('\n');
  const systemPrompt = `You are the decision component inside a deterministic Playwright browser runtime.
Code owns navigation state, action execution, safety, screenshots, and completion checks. Your only job is to choose ONE grounded next action.

GOAL: ${goal}

PAGE CONTEXT
  URL   : ${observation.url}
  Title : ${observation.title}
  Relevant body text: ${observation.bodyText}

TASK MILESTONES (persistent code-owned state):
${milestoneRows}
  Current milestone: ${observation.progress.current?.id || 'verify'}
  Observation mode: ${observationBudget.tier} (failures=${observationBudget.signals.failures}, stalled=${observationBudget.signals.stalled}, rejected=${observationBudget.signals.rejected})

PAGE LANDMARKS:
${observation.landmarks.map((item) => `  - ${item}`).join('\n') || '  (none found)'}

DISCOVERED PAGE LINKS (exact hrefs; they may be below the current viewport):
${observation.links.map((item) => `  [${item.ref}] text="${item.text}" href="${item.href}"`).join('\n') || '  (none found)'}

INTERACTIVE ELEMENTS (visible only):
${observation.elements.map(e =>
    `  [${e.ref}] [${e.tag}] text="${e.text}" href="${e.href || ''}" position="${e.position || ''}" type="${e.type}" placeholder="${e.placeholder}" ariaLabel="${e.ariaLabel}" filled="${e.filled}" checked="${e.checked}"`
  ).join('\n')}

PREVIOUS STEPS:
${recentHistory || '  (none yet)'}

Respond with a JSON object and nothing else:
{
  "action":    "click|fill|select|press|hover|check|uncheck|navigate|back|reload|scroll|wait|upload_file|download|done|failed",
  "ref":       "E1 or L1, or null",
  "selector":  "<CSS selector or null>",
  "value":     "<text to type or option value, or null>",
  "url":       "<full URL for navigate, or null>",
  "direction": "up|down",
  "amount":    300,
  "ms":        1000,
  "reason":    "<one-sentence explanation>",
  "goalReached": false
}

Rules:
- Use "done" when you are confident the goal has been fully achieved.
- Use "failed" only when no progress is possible (e.g., captcha, blocked).
- For a multi-part goal, keep track of every requested result or state and do not use "done" until all parts are visibly verified.
- Choose a fresh E# or L# reference. Code resolves it to the exact selector or href; do not invent CSS.
- If the needed control is not currently visible, use an exact DISCOVERED PAGE LINK, a menu/search control, or scroll to the relevant landmark. Never guess the destination.
- For a requested link or URL, copy an exact absolute href from the INTERACTIVE ELEMENTS list or use the exact current PAGE CONTEXT URL. Never infer, shorten, translate, or reconstruct a URL slug from visible text.
- Never repeat the exact same action twice in a row.
- Never fill an input marked filled="true" unless the goal explicitly asks to replace its existing value.
- If the previous action says changed=false, inspect the screenshot and choose a different selector or strategy.
- Use press for keyboard actions such as Enter, Escape, Tab, or ArrowDown.
- Use hover for menus that reveal controls only after pointer movement.
- Use back or reload when navigation recovery is necessary.
- Use upload_file or download only when the goal explicitly requires it.
- Return exact public facts only when they are present in the current page body, an exact mailto link, or a previously observed verified page. Never return placeholders such as [account].
- Never claim completion from an action alone: visually verify the requested result on the current page first.
- Do not plan later actions, explain a tutorial, or repeat the full goal. Choose only the next action for the current milestone.
- Call the browser_action tool with one action. The JSON format above is a fallback only.`;

  // Build user content with optional vision
  let userContent;
  if (useVision) {
    try {
      const screenshotB64 = opts.screenshotBase64 || await takeScreenshot(page);
      userContent = [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotB64}` } },
        { type: 'text', text: 'What is the next action? Look at the screenshot and the interactive elements listed above.' },
      ];
    } catch {
      userContent = 'What is the next action?';
    }
  } else {
    userContent = 'What is the next action?';
  }

  try {
    const guardedBaseUrl = normalizedBaseUrl || getLmStudioBaseUrl();
    const runtime = opts.skipModelGuard
      ? { modelId: preferredModel }
      : await ensureSingleLocalLLM({
        preferredModel,
        baseUrl: guardedBaseUrl,
        loadIfMissing: true,
      });
    const requestModel = runtime.modelId || preferredModel;
    const requestUrl = `${guardedBaseUrl}${useNativeApi ? '/api/v1/chat' : '/v1/chat/completions'}`;
    const openAIRequest = {
      model: requestModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: 260,
      temperature: 0.1,
      reasoning_effort: 'none',
      tools: [BROWSER_ACTION_TOOL],
      tool_choice: 'auto',
    };
    const nativeInput = Array.isArray(userContent)
      ? userContent.map((item) => item.type === 'image_url'
        ? { type: 'image', data_url: item.image_url.url }
        : { type: 'text', content: item.text || '' })
      : [{ type: 'text', content: userContent }];
    const nativeRequest = {
      model: requestModel,
      system_prompt: systemPrompt,
      input: nativeInput,
      reasoning: 'off',
      store: false,
      max_output_tokens: 400,
      temperature: 0.1,
    };
    const requestHeaders = {
      'Authorization': `Bearer ${requestApiKey}`,
      'Content-Type': 'application/json',
    };
    let response = await fetch(requestUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(useNativeApi ? nativeRequest : openAIRequest),
    });

    // Some otherwise vision-capable local models expose no native tool-call
    // parser. Keep the same screenshot-grounded planner and fall back to its
    // strict JSON contract instead of failing the whole browser session.
    if (!useNativeApi && !response.ok && [400, 404, 422].includes(response.status)) {
      const { tools, tool_choice, ...jsonFallbackRequest } = openAIRequest;
      response = await fetch(requestUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(jsonFallbackRequest),
      });
    }

    if (!response.ok) {
      console.error('[SmartAgent] planNextAction API error:', response.status);
      return { action: 'failed', reason: `Browser planner API error ${response.status}`, goalReached: false, retryable: true };
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    const toolCall = Array.isArray(message.tool_calls)
      ? message.tool_calls.find((item) => item?.function?.name === 'browser_action')
      : null;
    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      _llmConsecutiveFailures = 0;
      return attachGrounding(normalizePlannedBrowserAction(parsed, observation));
    }
    const text = useNativeApi
      ? (data.output || []).filter((item) => item?.type === 'message').map((item) => item.content || '').join('\n')
      : (message.content || message.reasoning_content || message.reasoning || '');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      _llmConsecutiveFailures = 0; // reset on success
      return attachGrounding(normalizePlannedBrowserAction(parsed, observation));
    }
  } catch (err) {
    _llmConsecutiveFailures++;
    if (_llmConsecutiveFailures <= LLM_SPAM_THRESHOLD ||
        _llmConsecutiveFailures % LLM_SPAM_THRESHOLD === 0) {
      const hint = getLLMErrorHint(err);
      console.error(`[SmartAgent] planNextAction error: ${err.message}${hint ? ' ' + hint : ''}`);
    }
  }

  return { action: 'failed', reason: 'Could not parse the browser planner response', goalReached: false, retryable: true };
}

/**
 * Execute a single agent action returned by `planNextAction`.
 *
 * @param {import('playwright').Page} page
 * @param {object} action  Action object from planNextAction
 * @param {{downloadDir?:string}} [options]
 * @returns {Promise<boolean>}  true if the action was applied successfully
 */
async function executeAgentAction(page, action, options = {}) {
  const { action: type, selector, value, url, direction, amount, ms } = action;

  try {
    switch (type) {
      case 'click': {
        if (!selector) return false;
        await page.waitForSelector(selector, { timeout: SELECTOR_WAIT_TIMEOUT, state: 'visible' }).catch(() => {});
        const el = await page.$(selector);
        if (!el) {
          // Fallback: try text-based click using action.value or action.reason
          const fallbackText = value || '';
          return smartClick(page, [selector], fallbackText);
        }
        await el.click();
        return true;
      }
      case 'fill': {
        if (!selector) return false;
        await page.waitForSelector(selector, { timeout: SELECTOR_WAIT_TIMEOUT, state: 'visible' }).catch(() => {});
        return smartFill(page, [selector], value || '');
      }
      case 'select': {
        if (!selector || !value) return false;
        await page.selectOption(selector, value);
        return true;
      }
      case 'press': {
        const key = String(value || 'Enter').slice(0, 40);
        if (selector) await page.locator(selector).press(key);
        else await page.keyboard.press(key);
        return true;
      }
      case 'hover': {
        if (!selector) return false;
        await page.locator(selector).hover({ timeout: SELECTOR_WAIT_TIMEOUT });
        return true;
      }
      case 'check': {
        if (!selector) return false;
        await page.locator(selector).check({ timeout: SELECTOR_WAIT_TIMEOUT });
        return true;
      }
      case 'uncheck': {
        if (!selector) return false;
        await page.locator(selector).uncheck({ timeout: SELECTOR_WAIT_TIMEOUT });
        return true;
      }
      case 'navigate': {
        if (!url) return false;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return true;
      }
      case 'back': {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        return true;
      }
      case 'reload': {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        return true;
      }
      case 'scroll': {
        const px = amount || 300;
        const sign = direction === 'up' ? -1 : 1;
        await page.evaluate((delta) => window.scrollBy(0, delta), sign * px);
        return true;
      }
      case 'wait': {
        await page.waitForTimeout(ms || 1000);
        return true;
      }
      case 'upload_file': {
        // Trigger file chooser by clicking the upload button, then set the file
        if (!value) {
          console.warn('[SmartAgent] upload_file action requires value (file path)');
          return false;
        }
        try {
          const clickTarget = selector || 'text=Select video';
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 10000 }),
            page.click(clickTarget).catch((clickErr) =>
              page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) el.click();
              }, clickTarget).catch((evalErr) => {
                console.warn('[SmartAgent] upload_file click fallback failed:', evalErr.message);
              })
            ),
          ]);
          await fileChooser.setFiles(value);
          return true;
        } catch (e) {
          console.warn('[SmartAgent] upload_file fallback to setInputFiles:', e.message);
          const fi = await page.$('input[type="file"]');
          if (fi) { await fi.setInputFiles(value); return true; }
          return false;
        }
      }
      case 'download': {
        if (!selector) return false;
        const downloadDir = options.downloadDir || path.join(process.env.USERPROFILE || process.cwd(), 'Downloads');
        fs.mkdirSync(downloadDir, { recursive: true });
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30000 }),
          page.locator(selector).click({ timeout: SELECTOR_WAIT_TIMEOUT }),
        ]);
        const suggested = String(download.suggestedFilename() || 'download.bin').replace(/[^a-zA-Z0-9._ -]/g, '_');
        const target = path.join(downloadDir, suggested);
        await download.saveAs(target);
        action.downloadPath = target;
        return true;
      }
      case 'done':
      case 'failed':
        return true; // Caller checks action.action to decide whether to stop
      default:
        console.warn('[SmartAgent] Unknown action type:', type);
        return false;
    }
  } catch (err) {
    console.warn(`[SmartAgent] executeAgentAction(${type}) error:`, err.message);
    return false;
  }
}

/**
 * Detect and attempt to solve CAPTCHA/robot challenges on the current page.
 * Uses LLM vision to analyze the challenge and decide how to interact with it.
 * 
 * Handles:
 * - reCAPTCHA "I'm not a robot" checkbox
 * - Cloudflare "Verify you are human" challenges
 * - Generic "are you a robot" text challenges
 * - Cookie/security consent screens that block progress
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{detected:boolean, handled:boolean, reason:string}>}
 */
async function detectAndHandleCaptcha(page) {
  const info = await page.evaluate(() => {
    const text = (document.body?.innerText || '').substring(0, 3000).toLowerCase();
    const hasCaptchaFrame = !!(
      document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], iframe[title*="recaptcha" i]') ||
      document.querySelector('.g-recaptcha, .h-captcha, #captcha, [data-sitekey]') ||
      document.querySelector('[class*="captcha" i], [id*="captcha" i]')
    );
    const hasRobotText = text.includes('not a robot') || text.includes('are you a robot') ||
                         text.includes('verify you are human') || text.includes('unusual traffic') ||
                         text.includes('automated queries') || text.includes('bot detection') ||
                         text.includes('security check') || text.includes('prove you') ||
                         text.includes('confirm you are not') || text.includes('human verification') ||
                         text.includes('verify you\'re human') || text.includes('verification challenge');
    const hasCheckbox = !!(
      document.querySelector('[role="checkbox"]') ||
      document.querySelector('input[type="checkbox"]') ||
      document.querySelector('.recaptcha-checkbox-border')
    );
    const hasVerifyButton = !!(
      Array.from(document.querySelectorAll('button, [role="button"], a')).find(el => {
        const t = (el.textContent || '').toLowerCase();
        return t.includes('verify') || t.includes('continue') || t.includes('confirm') || t.includes('i am human');
      })
    );
    return { hasCaptchaFrame, hasRobotText, hasCheckbox, hasVerifyButton };
  }).catch(() => ({ hasCaptchaFrame: false, hasRobotText: false, hasCheckbox: false, hasVerifyButton: false }));

  if (!info.hasCaptchaFrame && !info.hasRobotText) {
    return { detected: false, handled: false, reason: 'No CAPTCHA detected' };
  }

  // Human-verification challenges are a hard pause. The runtime may capture
  // and explain the blocker, but it must not click, solve, or ask a model to
  // bypass CAPTCHA or anti-bot controls.
  console.log('[SmartAgent] Human verification detected; pausing for user input.');
  return {
    detected: true,
    handled: false,
    reason: 'Human verification requires the user to complete the challenge in the visible browser.',
  };
}

/**
 *
 * This is the equivalent of page-agent's `agent.execute()` method, adapted for
 * server-side Playwright where we control the browser externally rather than
 * injecting scripts into the page.
 *
 * @example
 * const { success, steps } = await runAgentTask(page,
 *   'Log in to YouTube Studio using the stored session, then click Upload');
 *
 * @param {import('playwright').Page} page
 * @param {string} goal          Natural-language description of the desired outcome
 * @param {object} [options]
 * @param {number}  [options.maxSteps=15]     Maximum plan→execute iterations
 * @param {number}  [options.stepDelayMs=800] Pause between steps (ms)
 * @param {boolean} [options.useVision=false] Attach screenshot to each LLM call
 * @param {boolean} [options.verbose=true]    Log each step to console
 * @param {boolean} [options.handleCaptchas=true] Try the legacy CAPTCHA helper
 * @param {Function} [options.onStep]          Observe a completed/planned step
 * @param {Function} [options.beforeAction]    Guard an action before it executes
 * @param {number} [options.planTimeoutMs=120000] Maximum time for one LLM decision
 * @returns {Promise<{success:boolean, steps:object[], finalState:string}>}
 */
async function captureSafePageState(page) {
  return page.evaluate(() => {
    const visibleDialogs = Array.from(document.querySelectorAll('[role="dialog"],dialog,[aria-modal="true"]'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((element) => String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160))
      .slice(0, 4);
    const fields = Array.from(document.querySelectorAll('input,textarea,select'))
      .slice(0, 80)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        name: element.getAttribute('name') || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '',
        filled: Boolean(String(element.value || '').trim()),
        checked: typeof element.checked === 'boolean' ? element.checked : null,
        disabled: Boolean(element.disabled),
      }));
    return {
      url: location.href,
      title: document.title,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      body: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1800),
      visibleDialogs,
      fields,
    };
  }).then((state) => JSON.stringify(state)).catch(() => `${page.url()}|unavailable`);
}

async function dismissStandardConsentOverlay(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const exactLabels = /^(?:accept(?: all)?(?: cookies)?|allow all(?: cookies)?|agree(?: and continue)?|i agree|got it|continue without accepting|reject all(?: cookies)?)$/i;
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'));
    for (const element of candidates) {
      const label = clean(element.textContent || element.getAttribute('aria-label') || element.getAttribute('value'));
      if (!exactLabels.test(label)) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
      const container = element.closest('[role="dialog"],dialog,[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="consent" i],[class*="privacy" i]');
      const context = clean(container?.textContent || element.parentElement?.textContent || '').slice(0, 1400);
      if (!/\b(?:cookie|consent|privacy|tracking|personal data)\b/i.test(context)) continue;
      element.click();
      return { clicked: true, label };
    }
    return { clicked: false, label: '' };
  }).catch(() => ({ clicked: false, label: '' }));
}

function extractHttpUrls(value) {
  return [...new Set((String(value || '').match(/https?:\/\/[^\s"'<>]+/gi) || [])
    .map((url) => url.replace(/[),.;\]}]+$/g, ''))
    .filter(Boolean))];
}

function normalizeComparableUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

const PUBLIC_EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function originalBrowserGoal(goal) {
  return String(goal || '').split(/\n\nLOCAL VISION BROWSER RULES:/i)[0].trim();
}

function requestsPublicContactFacts(goal) {
  const text = String(goal || '');
  return /\b(?:find|locate|get|extract|identify|show|give|send|tell|collect|look\s*up)\b[\s\S]{0,220}\b(?:public\s+)?(?:contact|support|business|company)?\s*(?:e-?mail|contact\s+(?:info(?:rmation)?|details?|data)|phone|telephone|address|location)\b/i.test(text)
    || /\b(?:contact\s+(?:info(?:rmation)?|details?|data)|how\s+to\s+contact\s+(?:them|the\s+company|the\s+business))\b/i.test(text);
}

function extractsEmailSpecifically(goal) {
  return /\b(?:e-?mail|email address)\b/i.test(String(goal || ''));
}

function extractGroundedEmails(value) {
  return [...new Set((String(value || '').match(PUBLIC_EMAIL_PATTERN) || []).map((email) => email.toLowerCase()))];
}

function extractGroundedPhones(value) {
  const values = [];
  for (const match of String(value || '').matchAll(/(?:^|\n|\b)(?:phone|telephone|tel\.?|mobile|whatsapp)\s*[:\-]?\s*(\+?[\d][\d\s().\-]{5,}\d)/gim)) {
    const phone = String(match[1] || '').trim();
    const digitCount = phone.replace(/\D/g, '').length;
    if (digitCount >= 7 && digitCount <= 15) values.push(phone);
  }
  for (const match of String(value || '').matchAll(/\+[\d][\d\s().\-]{5,}\d/g)) {
    const phone = String(match[0] || '').trim();
    const digitCount = phone.replace(/\D/g, '').length;
    if (digitCount >= 7 && digitCount <= 15) values.push(phone);
  }
  return [...new Set(values)];
}

function completionGroundingContexts(action = {}, history = []) {
  const contexts = [...history, action]
    .map((item) => item?._groundingContext)
    .filter(Boolean);
  return contexts.length ? contexts : [action._groundingContext].filter(Boolean);
}

function validatePublicContactCompletion(goal, action = {}, contexts = []) {
  const userGoal = originalBrowserGoal(goal);
  if (!requestsPublicContactFacts(userGoal)) return { allowed: true };
  const groundingText = contexts.map((context) => [
    context.bodyText || '',
    ...(context.interactive || []).map((item) => `${item.text || ''} ${item.href || ''}`),
    ...(context.discoveredLinks || []).map((item) => `${item.text || ''} ${item.href || ''}`),
  ].join('\n')).join('\n');
  const reason = String(action.reason || '');
  const groundedEmails = extractGroundedEmails(groundingText);
  const reportedEmails = extractGroundedEmails(reason);
  const groundedPhones = extractGroundedPhones(groundingText);
  const reportedPhones = extractGroundedPhones(reason);

  if (reportedEmails.some((email) => !groundedEmails.includes(email))) {
    return { allowed: false, reason: 'Completion rejected: the reported email was not observed in the live page text or an exact mailto link.' };
  }
  const groundedPhoneDigits = new Set(groundedPhones.map((phone) => phone.replace(/\D/g, '')));
  if (reportedPhones.some((phone) => !groundedPhoneDigits.has(phone.replace(/\D/g, '')))) {
    return { allowed: false, reason: 'Completion rejected: the reported phone number was not observed in the live page text.' };
  }
  if (extractsEmailSpecifically(userGoal) && !reportedEmails.length) {
    return { allowed: false, reason: groundedEmails.length
      ? 'Completion rejected: return the exact public email visible on the page instead of a placeholder or description.'
      : 'Completion rejected: no public email has been grounded yet. Navigate to the contact or support page and inspect it.' };
  }
  if (!extractsEmailSpecifically(userGoal) && !reportedEmails.length && !reportedPhones.length) {
    return { allowed: false, reason: 'Completion rejected: contact information was requested, but no exact grounded email or phone number was reported.' };
  }
  return { allowed: true };
}

/**
 * Refuse factual URL completion unless every reported URL is grounded in the
 * live page. Same-origin links are also fetched through the browser context so
 * a guessed but dead route can never be returned as a successful result.
 */
async function validateAgentCompletion(page, goal, action = {}, history = []) {
  const userGoal = originalBrowserGoal(goal);
  const observedContext = action._groundingContext || (page ? await extractPageContext(page) : null);
  const groundedAction = observedContext && !action._groundingContext ? { ...action, _groundingContext: observedContext } : action;
  const contexts = completionGroundingContexts(groundedAction, history);
  const typedValidation = verifyBrowserCompletion({ goal: userGoal, action: groundedAction, history, contexts });
  if (!typedValidation.allowed) return { ...typedValidation, verifiedLinks: [] };
  const contactValidation = validatePublicContactCompletion(userGoal, groundedAction, contexts);
  const checks = [...typedValidation.checks];
  const contactCheck = typedValidation.contract.checks.find((item) => item.id === 'public-contact');
  if (!contactValidation.allowed) {
    if (contactCheck) checks.push({ ...contactCheck, passed: false, detail: contactValidation.reason });
    return { ...contactValidation, contract: typedValidation.contract, checks, verifiedLinks: [] };
  }
  if (contactCheck) checks.push({ ...contactCheck, passed: true, detail: 'Exact requested contact values were grounded in the live page.' });
  if (!/\b(?:link|url)\b/i.test(userGoal)) return { ...typedValidation, checks, allowed: true, verifiedLinks: [] };

  const reported = [...new Set([
    ...extractHttpUrls(groundedAction.reason),
    ...extractHttpUrls(groundedAction.url),
    ...extractHttpUrls(groundedAction.value),
  ].map(normalizeComparableUrl).filter(Boolean))];
  if (!reported.length) {
    const exactLinkCheck = typedValidation.contract.checks.find((item) => item.id === 'exact-link');
    return {
      allowed: false,
      reason: 'Completion rejected: the requested link was not reported. Read and return one exact visible DOM href.',
      contract: typedValidation.contract,
      checks: exactLinkCheck ? [...checks, { ...exactLinkCheck, passed: false, detail: 'No URL was reported.' }] : checks,
      verifiedLinks: [],
    };
  }

  // Validate against the exact DOM snapshot that accompanied the vision frame.
  // Animated carousels can change between the screenshot request and the LLM
  // response, so re-reading only the later frame would reject a real link.
  const currentContext = groundedAction._groundingContext || await extractPageContext(page);
  const currentUrl = normalizeComparableUrl(currentContext.url);
  const grounded = new Map();
  for (const context of contexts.length ? contexts : [currentContext]) {
    for (const element of [...(context.interactive || []), ...(context.discoveredLinks || [])]) {
      const url = normalizeComparableUrl(element.href);
      if (url) grounded.set(url, { url, text: String(element.text || '').trim() });
    }
    const contextUrl = normalizeComparableUrl(context.url);
    if (contextUrl) grounded.set(contextUrl, { url: contextUrl, text: String(context.title || '').trim() });
  }

  const verifiedLinks = [];
  for (const url of reported) {
    const exact = grounded.get(url);
    if (!exact) {
      return {
        allowed: false,
        reason: 'Completion rejected: the reported URL is not an exact visible DOM href or the current page URL. Inspect the fresh page and copy an exact href.',
        verifiedLinks: [],
      };
    }

    try {
      const pageOrigin = currentUrl ? new URL(currentUrl).origin : '';
      if (new URL(url).origin === pageOrigin) {
        const response = await page.context().request.get(url, {
          failOnStatusCode: false,
          timeout: 12_000,
        });
        if (response.status() >= 400) {
          return {
            allowed: false,
            reason: `Completion rejected: the exact page link returned HTTP ${response.status()}. Choose another live visible href.`,
            verifiedLinks: [],
          };
        }
      }
    } catch (error) {
      return {
        allowed: false,
        reason: `Completion rejected: the reported link could not be verified (${String(error.message || error).slice(0, 160)}).`,
        verifiedLinks: [],
      };
    }
    verifiedLinks.push(exact);
  }

  const exactLinkCheck = typedValidation.contract.checks.find((item) => item.id === 'exact-link');
  if (exactLinkCheck) checks.push({ ...exactLinkCheck, passed: true, detail: `${verifiedLinks.length} exact live URL(s) verified.` });
  return { ...typedValidation, checks, allowed: true, verifiedLinks };
}

async function runAgentTask(page, goal, options = {}) {
  const {
    maxSteps = 15,
    stepDelayMs = 800,
    useVision = isVisionEnabled(),
    verbose = true,
    handleCaptchas = true,
    onStep = null,
    onObserve = null,
    onRuntime = null,
    beforeAction = null,
    planTimeoutMs = 120_000,
    downloadDir = null,
    initialHistory = [],
  } = options;

  const history = (Array.isArray(initialHistory) ? initialHistory : []).slice(-24).map((item) => ({ ...item }));
  const stepOffset = history.reduce((max, item) => Math.max(max, Number(item?.step || 0)), 0);
  let success = false;
  let finalState = 'incomplete';
  let visionFrames = 0;
  let plannerCalls = 0;
  let actionAttempts = 0;
  let stalledActions = 0;
  let rejectedCompletions = 0;
  const startedAt = Date.now();
  let activePage = page;
  const baseUrl = getLmStudioBaseUrl();
  const runtime = await ensureSingleLocalLLM({
    preferredModel: getLmStudioModel(),
    baseUrl,
    loadIfMissing: true,
  });
  if (!runtime.ready || !runtime.modelId) throw new Error('No local browser-agent model is ready in LM Studio.');
  const visionActive = Boolean(useVision && runtime.vision !== false);
  if (typeof onRuntime === 'function') await onRuntime({ ...runtime, visionActive });

  if (verbose) console.log(`[AgentTask] Goal received (${String(goal || '').length} characters): "${redactAgentLog(goal).slice(0, 240)}"`);

  for (let iteration = 1; iteration <= maxSteps; iteration++) {
    const step = stepOffset + iteration;
    await activePage.waitForTimeout(stepDelayMs).catch(() => {});

    let screenshotBase64 = null;
    if (visionActive) screenshotBase64 = await takeScreenshot(activePage).catch(() => null);
    if (screenshotBase64) visionFrames += 1;
    if (typeof onObserve === 'function') {
      await onObserve({
        action: 'observe',
        reason: visionActive ? 'Captured the current page for visual planning.' : 'Read the current page structure for planning.',
        step,
        ok: true,
        phase: 'before',
      }, activePage, history, screenshotBase64);
    }

    try {
      if (handleCaptchas) {
        const captchaCheck = await detectAndHandleCaptcha(activePage);
        if (captchaCheck.detected && !captchaCheck.handled) {
          const reason = 'Human verification is visible and needs user input before the browser can continue.';
          history.push({ action: 'blocked', reason, step, ok: false });
          finalState = 'blocked';
          if (typeof onStep === 'function') await onStep({ action: 'blocked', reason, step, ok: false, terminal: true }, activePage, history);
          break;
        }
        if (captchaCheck.detected && captchaCheck.handled) {
          history.push({ action: 'captcha_solve', reason: captchaCheck.reason, step, ok: true });
          continue;
        }
      }
    } catch (err) {
      if (verbose) console.warn('[AgentTask] CAPTCHA detection error:', err.message);
    }

    const consent = await dismissStandardConsentOverlay(activePage);
    if (consent.clicked) {
      const automatic = {
        action: 'auto_consent',
        reason: `Dismissed the standard consent overlay using “${consent.label}”.`,
        step,
        ok: true,
        stateChanged: true,
      };
      history.push(automatic);
      if (typeof onStep === 'function') await onStep(automatic, activePage, history);
      continue;
    }

    let action;
    let planTimer;
    try {
      plannerCalls += 1;
      action = await Promise.race([
        planNextAction(activePage, goal, history, {
          useVision: visionActive,
          screenshotBase64,
          model: runtime.modelId,
          baseUrl,
          skipModelGuard: true,
          contextLength: runtime.contextLength,
        }),
        new Promise((_, reject) => {
          planTimer = setTimeout(() => reject(new Error(`Browser AI decision timed out after ${Math.round(planTimeoutMs / 1000)} seconds`)), planTimeoutMs);
        }),
      ]);
    } catch (err) {
      const reason = `Browser planning failed: ${err.message}`;
      history.push({ action: 'observe', reason, step, ok: false });
      if (typeof onStep === 'function') await onStep({ action: 'observe', reason, step, ok: false }, activePage, history);
      if (iteration >= maxSteps) finalState = 'error';
      continue;
    } finally {
      if (planTimer) clearTimeout(planTimer);
    }

    if (verbose) {
      console.log(`[AgentTask] Step ${iteration}/${maxSteps} (overall ${step}): ${action.action}` +
        (action.selector ? ` selector="${action.selector}"` : '') +
        (action.value ? ' value=[redacted input]' : '') +
        (action.url ? ` url="${action.url}"` : '') +
        ` | ${redactAgentLog(action.reason || '')}`);
    }

    if (action.action === 'failed' && action.retryable && iteration < maxSteps) {
      const retry = { ...action, action: 'observe', step, ok: false };
      history.push(retry);
      if (typeof onStep === 'function') await onStep(retry, activePage, history);
      continue;
    }

    const repeatedSuccessfulFill = action.action === 'fill' && action.selector
      && history.some((item) => item.action === 'fill' && item.selector === action.selector && item.ok === true);
    if (repeatedSuccessfulFill) {
      const observation = {
        action: 'observe',
        selector: action.selector,
        reason: 'This field was already filled successfully. Choose a different incomplete field or continue to the next action.',
        step,
        ok: true,
      };
      history.push(observation);
      if (typeof onStep === 'function') await onStep(observation, activePage, history);
      continue;
    }

    const actionSignature = JSON.stringify({
      action: action.action,
      selector: action.selector || '',
      value: action.value || '',
      url: action.url || '',
      direction: action.direction || '',
    });
    const repeatedStalledAction = history.slice(-4).some((item) => item.stateChanged === false
      && JSON.stringify({
        action: item.action,
        selector: item.selector || '',
        value: item.value || '',
        url: item.url || '',
        direction: item.direction || '',
      }) === actionSignature);
    if (repeatedStalledAction) {
      stalledActions += 1;
      const observation = {
        action: 'observe',
        reason: 'That strategy already produced no visible change. Inspect the current screenshot, landmarks, and exact discovered links, then choose a different grounded action.',
        step,
        ok: false,
      };
      history.push(observation);
      if (typeof onStep === 'function') await onStep(observation, activePage, history);
      continue;
    }

    history.push({ ...action, step });

    if (action.action === 'done') {
      const completion = await validateAgentCompletion(activePage, goal, action, history);
      if (!completion.allowed) {
        rejectedCompletions += 1;
        const rejected = {
          action: 'observe',
          reason: completion.reason,
          step,
          ok: false,
          completionRejected: true,
        };
        history[history.length - 1] = rejected;
        if (typeof onStep === 'function') await onStep(rejected, activePage, history);
        if (verbose) console.warn(`[AgentTask] ${completion.reason}`);
        continue;
      }
      const completedAction = {
        ...action,
        verifiedLinks: completion.verifiedLinks,
        verification: { contract: completion.contract, checks: completion.checks },
        step,
        ok: true,
        terminal: true,
      };
      history[history.length - 1] = completedAction;
      success = true;
      finalState = 'done';
      if (typeof onStep === 'function') await onStep(completedAction, activePage, history);
      break;
    }

    if (action.action === 'failed') {
      finalState = 'failed';
      if (typeof onStep === 'function') await onStep({ ...action, step, ok: false, terminal: true }, activePage, history);
      break;
    }

    if (typeof beforeAction === 'function') {
      const verdict = await beforeAction(action, activePage, history);
      if (verdict === false || verdict?.allowed === false) {
        const reason = typeof verdict === 'object' && verdict?.reason
          ? String(verdict.reason)
          : 'Action blocked by the browser safety policy';
        history.push({ action: 'blocked', reason, step, ok: false });
        finalState = 'blocked';
        if (typeof onStep === 'function') await onStep({ action: 'blocked', reason, step, ok: false, terminal: true }, activePage, history);
        break;
      }
    }

    const beforeState = await captureSafePageState(activePage);
    const browserContext = activePage.context();
    actionAttempts += 1;
    const ok = await executeAgentAction(activePage, action, { downloadDir });
    await activePage.waitForTimeout(400).catch(() => {});
    const openPages = browserContext.pages().filter((candidate) => !candidate.isClosed());
    const newestPage = openPages[openPages.length - 1];
    if (newestPage && newestPage !== activePage) {
      activePage = newestPage;
      await activePage.bringToFront().catch(() => {});
      await activePage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    }
    const afterState = await captureSafePageState(activePage);
    const stateChanged = Boolean(ok && (beforeState !== afterState || action.downloadPath));
    const recorded = { ...action, step, ok, stateChanged };
    history[history.length - 1] = recorded;
    if (typeof onStep === 'function') await onStep(recorded, activePage, history);
    if (!ok && verbose) console.warn(`[AgentTask] Step ${step} action could not be executed; the next visual observation will choose another strategy.`);
  }

  if (finalState === 'incomplete' && verbose) console.warn(`[AgentTask] Step budget (${maxSteps}) exhausted without completion.`);
  return {
    success,
    steps: history,
    finalState,
    page: activePage,
    runtime: {
      modelId: runtime.modelId,
      modelKey: runtime.modelKey,
      contextLength: runtime.contextLength || null,
      vision: visionActive,
      visionFrames,
      toolUse: runtime.toolUse === true,
      metrics: {
        plannerCalls,
        actionAttempts,
        stalledActions,
        rejectedCompletions,
        elapsedMs: Date.now() - startedAt,
      },
    },
  };
}

module.exports = {
  takeScreenshot,
  analyzePage,
  analyzeDOMOnly,
  waitForStateChange,
  smartClick,
  smartFill,
  getApiKey,
  isVisionEnabled,
  // Agentic loop API
  extractPageContext,
  planNextAction,
  executeAgentAction,
  runAgentTask,
  validateAgentCompletion,
  detectAndHandleCaptcha,
  redactAgentLog,
  dismissStandardConsentOverlay,
};
