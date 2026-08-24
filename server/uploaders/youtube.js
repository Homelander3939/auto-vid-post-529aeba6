const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { sendTelegram } = require('../telegram');
const { smartClick, smartFill, waitForStateChange, analyzePage } = require('./smart-agent');
const { getSharedBrowserProfileDir } = require('../browserProfiles');
const { dismissOverlayBlockingFlow } = require('./overlay-dismiss');
const { launchPersistentSafe } = require('../profileLock');
const { attemptUploadArbiter } = require('./upload-arbiter');

const DEFAULT_USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'youtube');
const YT_STUDIO_URL = 'https://studio.youtube.com';
const YT_UPLOAD_URL = 'https://studio.youtube.com/upload';

function resolveUserDataDir(browserProfileId, accountId) {
  if (browserProfileId) return getSharedBrowserProfileDir(browserProfileId);
  if (!accountId) return DEFAULT_USER_DATA_DIR;
  return path.join(__dirname, '..', 'data', 'browser-sessions', 'youtube', accountId);
}

async function gotoYouTubePage(page, url, timeout = 60000, settleMs = 2500) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForTimeout(settleMs);
}

async function safeScreenshot(page) {
  return page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
}

async function inspectGoogleAuthState(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const emailInput = document.querySelector('#identifierId, input[type="email"], input[name="identifier"]');
    const passwordInput = document.querySelector('input[type="password"]:not([aria-hidden="true"])');
    const codeInput = document.querySelector('input[type="tel"], input[name*="code" i], input[autocomplete="one-time-code"]');
    // Recovery-phone full-number input (Google asks user to type full number whose mask matches)
    const phoneInput = document.querySelector('input[type="tel"][name*="phone" i], input[id*="phone" i], input[aria-label*="phone" i]');

    const accountChips = Array.from(document.querySelectorAll('[data-identifier], [data-email], div[role="link"], li[role="link"]'));
    const accountEmails = accountChips
      .map((el) => (el.getAttribute('data-identifier') || el.getAttribute('data-email') || el.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 8);

    const continueBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find((btn) => {
      const t = (btn.textContent || '').toLowerCase().trim();
      return t === 'continue' || t.includes('continue as') || t === 'yes' || t.includes('i agree') || t.includes('next');
    });

    const matchNumber = (() => {
      const bigNumbers = document.querySelectorAll('[data-number], .vdE7Oc, .eKnrVb');
      for (const el of bigNumbers) {
        const v = (el.textContent || '').trim();
        if (/^\d{1,3}$/.test(v)) return v;
      }
      const textMatch = text.match(/tap\s+(\d{1,3})/i) || text.match(/number\s*[:=]?\s*(\d{1,3})/i);
      return textMatch?.[1] || '';
    })();

    // Detect recovery phone screens. Examples:
    //   "Confirm your recovery phone number"
    //   "To continue, first verify it's you. Enter the phone number ending in •• 42"
    //   "Enter the phone number associated with your account"
    const isRecoveryPhonePrompt = (
      text.includes('recovery phone') ||
      text.includes('confirm your phone') ||
      text.includes('verify your phone') ||
      (text.includes('phone number') && (text.includes('ending in') || text.includes('to continue')))
    ) && isVisible(phoneInput);

    // Mask tail (last 2 digits Google shows, e.g. •• 42)
    let recoveryPhoneTail = '';
    const maskMatch = text.match(/[•·*\.]{1,3}\s*(\d{2,4})/);
    if (maskMatch?.[1]) recoveryPhoneTail = maskMatch[1];
    if (!recoveryPhoneTail) {
      const endingMatch = text.match(/ending in[^\d]{0,10}(\d{2,4})/i);
      if (endingMatch?.[1]) recoveryPhoneTail = endingMatch[1];
    }

    // Multiple "ends in XX" radio/list options for picking which phone to use
    const phoneOptions = Array.from(document.querySelectorAll('[role="link"], [role="button"], li, div'))
      .map((el) => (el.textContent || '').trim())
      .filter((t) => /ending in|ends in|••\s*\d{2,4}|\.\.\.\s*\d{2,4}/i.test(t))
      .slice(0, 6);

    return {
      urlPath: window.location.pathname || '',
      hasEmailInput: isVisible(emailInput),
      hasPasswordInput: isVisible(passwordInput),
      isIdentifierStep: (window.location.pathname || '').includes('/identifier'),
      isPasswordStep: (window.location.pathname || '').includes('/challenge/pwd') || text.includes('enter your password'),
      hasCodeInput: isVisible(codeInput),
      hasPhoneInput: isVisible(phoneInput),
      isRecoveryPhonePrompt,
      recoveryPhoneTail,
      phoneOptions,
      hasPhonePrompt: text.includes('check your phone') || text.includes('tap yes') || text.includes('confirm it') || text.includes('approve sign-in'),
      hasNumberMatchPrompt: text.includes('choose a number') || text.includes('match the number') || text.includes('try another way'),
      isChooseAccount: text.includes('choose an account') || text.includes('select an account'),
      hasCaptcha: text.includes('not a robot') || text.includes('captcha') || text.includes('unusual traffic'),
      hasContinueButton: !!continueBtn,
      accountEmails,
      emailValue: (emailInput && 'value' in emailInput) ? String(emailInput.value || '') : '',
      matchNumber,
    };
  });
}

async function clickByText(page, texts) {
  return page.evaluate((labels) => {
    const wanted = labels.map((t) => t.toLowerCase());
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div[role="link"], li[role="link"], a, span'));
    for (const node of nodes) {
      const text = (node.textContent || '').trim().toLowerCase();
      if (!text) continue;
      if (wanted.some((w) => text === w || text.includes(w))) {
        node.click();
        return true;
      }
    }
    return false;
  }, texts);
}

async function chooseGoogleAccount(page, email) {
  const clickedByData = await page.evaluate((targetEmail) => {
    const normalized = String(targetEmail || '').toLowerCase().trim();
    const nodes = Array.from(document.querySelectorAll('[data-identifier], [data-email], div[role="link"], li[role="link"]'));
    for (const node of nodes) {
      const text = ((node.getAttribute('data-identifier') || node.getAttribute('data-email') || node.textContent || '')).toLowerCase();
      if (normalized && text.includes(normalized)) {
        node.click();
        return true;
      }
    }
    return false;
  }, email);

  if (clickedByData) return true;
  return clickByText(page, ['use another account', 'another account']);
}

async function chooseGoogleVerificationMethod(page, method) {
  if (!method) return;

  await clickByText(page, ['try another way', 'another way', 'choose another option', 'more ways to verify']);
  await page.waitForTimeout(1200);

  if (method === 'phone') {
    await clickByText(page, ['use your phone', 'google prompt', 'tap yes on your phone', 'phone']);
  } else if (method === 'code') {
    await clickByText(page, ['verification code', 'use a verification code', 'authenticator app', 'text message', 'sms']);
  }

  await page.waitForTimeout(1500);
}

async function submitGoogleEmail(page, email) {
  console.log('[YouTube] Entering email...');
  const urlBefore = page.url();
  const filled = await smartFill(page, ['#identifierId', 'input[type="email"]', 'input[name="identifier"]'], email);
  if (!filled) return false;

  await page.waitForTimeout(300);
  const clickedNext = await smartClick(page, ['#identifierNext button', '#identifierNext', 'button:has-text("Next")'], 'Next');
  if (!clickedNext) {
    await page.keyboard.press('Enter').catch(() => {});
  }

  await waitForStateChange(page, urlBefore, 8000);
  await page.waitForTimeout(1200);
  return true;
}

async function submitGooglePassword(page, password) {
  console.log('[YouTube] Entering password...');
  const urlBefore = page.url();
  const filled = await smartFill(page, [
    'input[type="password"]:not([aria-hidden="true"])',
    'input[name="Passwd"]',
  ], password);
  if (!filled) return false;

  await page.waitForTimeout(300);
  const clickedNext = await smartClick(page, ['#passwordNext button', '#passwordNext', 'button:has-text("Next")'], 'Next');
  if (!clickedNext) {
    await page.keyboard.press('Enter').catch(() => {});
  }

  await waitForStateChange(page, urlBefore, 9000);
  await page.waitForTimeout(1400);
  return true;
}

async function getYouTubeFileInput(page) {
  return page.$('input[type="file"]');
}

async function ensureStudioUploadPage(page) {
  await gotoYouTubePage(page, YT_UPLOAD_URL, 45000, 2500);
  const fileInput = await getYouTubeFileInput(page);
  if (fileInput) return fileInput;

  await gotoYouTubePage(page, YT_STUDIO_URL, 45000, 2000);
  return getYouTubeFileInput(page);
}

function isLikelyYouTubeUrl(url) {
  if (!url) return false;
  const value = String(url).trim();
  return /youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\//i.test(value);
}

function extractYouTubeVideoId(value) {
  const input = String(value || '').trim();
  if (!input) return '';

  const watchMatch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/i);
  if (watchMatch?.[1]) return watchMatch[1];

  const shortMatch = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i);
  if (shortMatch?.[1]) return shortMatch[1];

  const shortsMatch = input.match(/\/shorts\/([a-zA-Z0-9_-]{11})/i);
  if (shortsMatch?.[1]) return shortsMatch[1];

  const studioMatch = input.match(/\/video\/([a-zA-Z0-9_-]{11})\//i);
  if (studioMatch?.[1]) return studioMatch[1];

  return '';
}

function toWatchUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  if (isLikelyYouTubeUrl(raw)) {
    const id = extractYouTubeVideoId(raw);
    return id ? `https://www.youtube.com/watch?v=${id}` : raw;
  }

  const id = extractYouTubeVideoId(raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : '';
}

async function captureVideoUrlCandidate(page, currentUrl = '') {
  const current = toWatchUrl(currentUrl);
  if (current) return current;

  const fromPageUrl = toWatchUrl(page.url());
  if (fromPageUrl) return fromPageUrl;

  const fromDom = await page.evaluate(() => {
    const candidates = [];
    const nodes = document.querySelectorAll('a[href], input[value], ytcp-video-info a[href]');
    for (const node of nodes) {
      const href = (node.getAttribute('href') || '').trim();
      const value = (node.getAttribute('value') || '').trim();
      const text = (node.textContent || '').trim();
      if (href) candidates.push(href);
      if (value) candidates.push(value);
      if (text) candidates.push(text);
    }
    candidates.push(window.location.href || '');
    return candidates;
  }).catch(() => []);

  for (const candidate of (Array.isArray(fromDom) ? fromDom : [])) {
    const normalized = toWatchUrl(candidate);
    if (normalized) return normalized;
  }

  return '';
}

async function assessYouTubePostPublishState(page) {
  // Use shadow-DOM-aware upload detection first — this catches the upload progress
  // dialog even when it lives inside custom web-component shadow roots.
  const uploadDialogVisible = await isUploadDialogVisible(page).catch(() => false);
  if (uploadDialogVisible) {
    return {
      successLike: false,
      isUploading: true,
      reason: 'Video upload is still in progress (upload dialog visible). Waiting for the file transfer to complete.',
    };
  }

  const dom = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const hasPublished =
      text.includes('video published') ||
      text.includes('your video is uploaded') ||
      text.includes('published on youtube');
    const hasProcessing =
      text.includes('video processing') ||
      text.includes('finish processing before your video is public') ||
      text.includes('checks complete') ||
      text.includes('no issues found') ||
      text.includes('uploaded and is being processed');
    // File transfer still in progress — not an obstacle, just needs more time
    const isStillUploading =
      text.includes('video uploading') ||
      text.includes('still uploading') ||
      text.includes('uploading and will be public') ||
      text.includes('keep this browser tab open until uploading') ||
      /uploading\s+\d+\s*%/.test(text);
    const hasHardError =
      text.includes('copyright claim') ||
      text.includes('blocked in') ||
      text.includes('couldn\'t publish') ||
      text.includes('upload failed');

    return {
      hasPublished,
      hasProcessing,
      isStillUploading,
      hasHardError,
      summary: text.slice(0, 1200),
    };
  }).catch(() => ({ hasPublished: false, hasProcessing: false, isStillUploading: false, hasHardError: false, summary: '' }));

  if (dom.hasPublished || dom.hasProcessing) {
    return {
      successLike: true,
      reason: dom.hasPublished
        ? 'YouTube shows a published confirmation.'
        : 'YouTube shows processing/checks complete, which means upload finished and processing continues server-side.',
    };
  }

  // File is still being transferred — not an obstacle, caller should wait
  if (dom.isStillUploading) {
    return {
      successLike: false,
      isUploading: true,
      reason: 'Video upload is still in progress. Waiting for the file transfer to complete before checking for confirmation.',
    };
  }

  if (dom.hasHardError) {
    return {
      successLike: false,
      needsHuman: true,
      reason: 'YouTube shows a blocking publish/upload error on screen.',
    };
  }

  let aiState = null;
  try {
    aiState = await analyzePage(page, 'YouTube publish stage. Decide if the page is success/processing or a true blocker that requires human help.');
  } catch {
    aiState = null;
  }

  const state = String(aiState?.state || '').toLowerCase();
  const description = String(aiState?.description || '').trim();
  // 'logged_in' means we landed back on Studio dashboard — treat as success-like because
  // YouTube often redirects to the dashboard immediately after publishing.
  const successStates = new Set(['success', 'processing', 'uploading', 'logged_in']);

  if (successStates.has(state)) {
    return {
      successLike: true,
      reason: description || 'AI recognized this as a successful/processing final state.',
    };
  }

  return {
    successLike: false,
    needsHuman: Boolean(aiState?.needs_human),
    reason: description || 'No reliable final confirmation detected yet.',
  };
}

async function selectVisibilityPublic(page) {
  // Strategy 1: getByRole — most reliable ARIA-based selection, pierces Shadow DOM
  // YouTube radio buttons may contain extra text like "Public\nMake your video visible to everyone"
  // so we use /public/i (non-anchored) instead of exact match.
  try {
    const radio = page.getByRole('radio', { name: /public/i }).first();
    if (await radio.isVisible({ timeout: 2000 }).catch(() => false)) {
      await radio.click();
      return true;
    }
  } catch {}

  // Strategy 2: Playwright locators with non-anchored hasText — works even when the radio
  // button element contains additional description text beyond just "Public".
  try {
    const radio = page.locator('[role="radio"]').filter({ hasText: 'Public' }).first();
    if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
      await radio.click();
      return true;
    }
  } catch {}

  // Strategy 3: Playwright getByLabel
  try {
    const label = page.getByLabel(/public/i).first();
    if (await label.isVisible({ timeout: 1500 }).catch(() => false)) {
      await label.click();
      return true;
    }
  } catch {}

  // Strategy 3: CSS attribute selectors via smartClick
  const clicked = await smartClick(page, [
    'ytcp-radio-button[name="PUBLIC"]',
    'tp-yt-paper-radio-button[name="PUBLIC"]',
    '[name="PUBLIC"]',
    'input[name="PUBLIC"]',
  ], 'Public');

  if (clicked) return true;

  // Strategy 4: getByText with broader matching
  try {
    const publicText = page.getByText('Public', { exact: true }).first();
    if (await publicText.isVisible({ timeout: 1500 }).catch(() => false)) {
      await publicText.click();
      return true;
    }
  } catch {}

  // Strategy 5: Deep Shadow DOM traversal via page.evaluate
  const deepClicked = await page.evaluate(() => {
    function deepQueryAll(root) {
      const results = [];
      const candidates = Array.from(root.querySelectorAll(
        'ytcp-radio-button, tp-yt-paper-radio-button, [role="radio"], label'
      ));
      results.push(...candidates);
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot));
      }
      return results;
    }

    const nodes = deepQueryAll(document);
    for (const node of nodes) {
      const text = (node.textContent || node.innerText || '').toLowerCase().trim();
      if (!text) continue;
      if (
        text.startsWith('public') &&
        !text.includes('unlisted') &&
        !text.includes('private') &&
        !text.includes('schedule')
      ) {
        const inner = node.querySelector('button, input[type="radio"], [role="radio"]') || node;
        inner.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);

  if (deepClicked) return true;

  // Strategy 6: Coordinate-based click on the "Public" radio using page.mouse
  // This fires full React/Polymer event chain unlike DOM .click()
  const coords = await page.evaluate(() => {
    function deepQueryAll(root) {
      const results = [];
      const candidates = Array.from(root.querySelectorAll(
        'ytcp-radio-button, tp-yt-paper-radio-button, [role="radio"], label'
      ));
      results.push(...candidates);
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot));
      }
      return results;
    }

    const nodes = deepQueryAll(document);
    for (const node of nodes) {
      const text = (node.textContent || node.innerText || '').toLowerCase().trim();
      if (!text) continue;
      if (
        text.startsWith('public') &&
        !text.includes('unlisted') &&
        !text.includes('private') &&
        !text.includes('schedule')
      ) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, found: true };
        }
      }
    }
    return { found: false };
  }).catch(() => ({ found: false }));

  if (coords?.found) {
    await page.mouse.click(coords.x, coords.y);
    return true;
  }

  return false;
}

async function selectAudienceNotMadeForKids(page) {
  // Strategy 1: Playwright getByLabel / getByText — these pierce Shadow DOM natively
  try {
    const label = page.getByLabel(/^no[,:]?\s*(it'?s\s*)?not made for kids/i);
    if (await label.isVisible({ timeout: 1500 }).catch(() => false)) {
      await label.click();
      return true;
    }
  } catch {}

  try {
    const radio = page.locator('[role="radio"]').filter({ hasText: /not made for kids/i }).first();
    if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
      await radio.click();
      return true;
    }
  } catch {}

  // Strategy 2: CSS attribute selectors via page.$() (Playwright pierces one Shadow DOM level)
  const clicked = await smartClick(page, [
    'ytcp-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
    'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
    '[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
    'input[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
  ], "No, it's not made for kids");

  if (clicked) return true;

  // Strategy 3: Deep Shadow DOM traversal via page.evaluate
  return page.evaluate(() => {
    function deepQueryAll(root) {
      const results = [];
      const candidates = Array.from(root.querySelectorAll(
        'ytcp-radio-button, tp-yt-paper-radio-button, [role="radio"], label'
      ));
      results.push(...candidates);
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot));
      }
      return results;
    }

    const nodes = deepQueryAll(document);
    for (const node of nodes) {
      const text = (node.textContent || node.innerText || '').toLowerCase().trim();
      if (!text) continue;
      if (text.includes('not made for kids') || text.includes("no, it's not")) {
        // Prefer clicking the inner button/input if present
        const inner = node.querySelector('button, input[type="radio"], [role="radio"]') || node;
        inner.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
}

async function acceptUploadAgreements(page) {
  return page.evaluate(() => {
    const agreementWords = ['i agree', 'i understand', 'confirm', 'acknowledge', 'accept'];
    let clicked = 0;
    const candidates = Array.from(document.querySelectorAll('ytcp-checkbox-lit, tp-yt-paper-checkbox, [role="checkbox"], input[type="checkbox"]'));

    for (const box of candidates) {
      const container = box.closest('label, ytcp-checkbox-lit, tp-yt-paper-checkbox, div, span') || box;
      const text = ((container?.textContent || box.textContent || '')).toLowerCase();
      if (!agreementWords.some((word) => text.includes(word))) continue;

      const isChecked = box.getAttribute('aria-checked') === 'true' || box.checked === true;
      if (isChecked) continue;

      box.click();
      clicked += 1;
    }

    return clicked;
  }).catch(() => 0);
}

async function clickNextWizardStep(page) {
  const clicked = await smartClick(page, [
    '#next-button',
    'ytcp-button#next-button',
    'button[aria-label="Next"]',
    'button:has-text("Next")',
  ], 'Next');
  if (clicked) return { clicked: true, disabled: false };

  return page.evaluate(() => {
    const btn = document.querySelector('#next-button, ytcp-button#next-button, button[aria-label="Next"]');
    if (!btn) return { clicked: false, disabled: false };
    const disabled = btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('disabled');
    if (disabled) return { clicked: false, disabled: true };

    const target = btn.querySelector('button') || btn;
    target.click();
    return { clicked: true, disabled: false };
  }).catch(() => ({ clicked: false, disabled: false }));
}

async function isVisibilityStep(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const deepQueryAll = (root, selector) => {
      const results = [];
      results.push(...Array.from(root.querySelectorAll(selector)));
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot, selector));
      }
      return results;
    };

    const visibleDialog = deepQueryAll(document, 'ytcp-uploads-dialog, [role="dialog"]')
      .find((node) => isVisible(node));
    const scope = visibleDialog || document;

    const stepNodes = deepQueryAll(scope, '[aria-label], [role="tab"], [role="listitem"], tp-yt-paper-tab, ytcp-step-badge');
    const activeVisibilityStep = stepNodes.some((node) => {
      const text = (node.textContent || node.innerText || '').toLowerCase().trim();
      if (!text.includes('visibility')) return false;
      if (!isVisible(node)) return false;

      const selected =
        node.getAttribute('aria-selected') === 'true' ||
        node.getAttribute('aria-current') === 'step' ||
        node.getAttribute('aria-current') === 'true' ||
        node.getAttribute('aria-checked') === 'true' ||
        node.classList.contains('selected') ||
        node.classList.contains('active') ||
        node.classList.contains('iron-selected');

      return selected;
    });

    const visibleRadios = deepQueryAll(scope, 'ytcp-radio-button, tp-yt-paper-radio-button, [role="radio"], input[type="radio"], label');
    const visibleVisibilityOptions = new Set();

    for (const node of visibleRadios) {
      if (!isVisible(node)) continue;
      const text = (node.textContent || node.innerText || node.getAttribute?.('aria-label') || '').toLowerCase().trim();
      if (!text) continue;
      if (text.includes('public')) visibleVisibilityOptions.add('public');
      if (text.includes('private')) visibleVisibilityOptions.add('private');
      if (text.includes('unlisted')) visibleVisibilityOptions.add('unlisted');
      if (visibleVisibilityOptions.size >= 2) break;
    }

    return activeVisibilityStep || visibleVisibilityOptions.size >= 2;
  }).catch(() => false);
}

async function waitForPublishConfirmation(page, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const published = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return (
        text.includes('video published') ||
        text.includes('checks complete') ||
        text.includes('your video is uploaded') ||
        text.includes('video processing') ||
        text.includes('finish processing before your video is public') ||
        text.includes('no issues found') ||
        text.includes('uploaded and is being processed')
      );
    }).catch(() => false);

    if (published) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

// After clicking "Publish", YouTube sometimes shows a confirmation dialog when
// the file is still uploading or being checked, e.g.:
//   "Your video is still uploading. Publish anyway?"
//   "Checks aren't complete. Publish anyway?"
// If we don't click "Publish anyway", the publish action is dropped and the
// video stays in Drafts. This helper polls briefly for that dialog and confirms.
async function confirmPublishAnywayIfPrompted(page, totalWaitMs = 20000) {
  const started = Date.now();
  let clickedAt = null;
  const CONFIRM_LABELS = [
    'publish anyway',
    'publish anyways',
    'continue publishing',
    'schedule anyway',
    'save anyway',
  ];

  while (Date.now() - started < totalWaitMs) {
    const result = await page.evaluate((labels) => {
      const dialogs = Array.from(document.querySelectorAll(
        'tp-yt-paper-dialog, ytcp-dialog, [role="dialog"], [role="alertdialog"]'
      ));
      for (const dlg of dialogs) {
        const style = window.getComputedStyle(dlg);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = dlg.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 60) continue;
        const buttons = Array.from(dlg.querySelectorAll(
          'button, ytcp-button, tp-yt-paper-button, [role="button"]'
        ));
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (!text) continue;
          if (labels.some((l) => text === l || text.includes(l))) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              btn.click();
              return { clicked: true, label: text };
            }
          }
        }
      }
      return { clicked: false };
    }, CONFIRM_LABELS).catch(() => ({ clicked: false }));

    if (result.clicked) {
      console.log(`[YouTube] Confirmed publish dialog by clicking: "${result.label}"`);
      clickedAt = Date.now();
      // Give YT a moment to commit and re-show the dialog if needed; loop once
      // more to catch chained confirmations.
      await page.waitForTimeout(2500);
      // Stop scanning ~3s after the click — usually only one confirmation appears.
      if (Date.now() - clickedAt > 3000) break;
      continue;
    }
    await page.waitForTimeout(1000);
  }
  return clickedAt !== null;
}

// Detects if the "Video uploading" progress dialog is currently shown using Playwright
// locators that pierce Shadow DOM (YouTube Studio uses custom web components whose
// innerText is NOT visible via document.body.innerText).
async function isUploadDialogVisible(page) {
  // Check for the custom modal element itself (most reliable)
  try {
    if (await page.locator('ytcp-uploads-still-processing-modal').isVisible({ timeout: 1500 })) return true;
  } catch {}
  // Check for the upload percentage text (e.g. "Uploading 91%")
  try {
    if (await page.getByText(/uploading\s+\d+\s*%/i).isVisible({ timeout: 1000 })) return true;
  } catch {}
  // Check for the "keep this browser tab open" instruction text
  try {
    if (await page.getByText(/keep this browser tab open until uploading/i).isVisible({ timeout: 1000 })) return true;
  } catch {}
  // Check for "still uploading and will be public" body text
  try {
    if (await page.getByText(/still uploading and will be public/i).isVisible({ timeout: 1000 })) return true;
  } catch {}
  return false;
}

// Detects if the "Video uploading" progress dialog is currently shown.
// YouTube shows this while the file is still being transferred (e.g. "Uploading 32% … 2 minutes left").
// Uses both Playwright locators (shadow DOM-aware) and a fallback DOM text scan.
async function isVideoUploadInProgress(page) {
  // Playwright-native check first (pierces shadow DOM)
  if (await isUploadDialogVisible(page)) return true;

  // Fallback: plain DOM innerText scan (catches cases where the text leaks into the light DOM)
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    return (
      text.includes('video uploading') ||
      text.includes('still uploading') ||
      text.includes('uploading and will be public') ||
      text.includes('keep this browser tab open until uploading') ||
      /uploading\s+\d+\s*%/.test(text)
    );
  }).catch(() => false);
}

// Detects if YouTube Studio is still transcoding/processing the video
// (e.g. "Processing video..." / "Processing up to HD… 3 minutes left").
// This is different from the file-upload phase — the file is already transferred
// but YouTube is still encoding it server-side.
async function isVideoTranscodingInProgress(page) {
  try {
    if (await page.getByText(/processing up to hd/i).isVisible({ timeout: 1000 })) return true;
  } catch {}
  try {
    if (await page.getByText(/processing video/i).isVisible({ timeout: 1000 })) return true;
  } catch {}
  try {
    if (await page.getByText(/checking\s+\d+\s*%/i).isVisible({ timeout: 1000 })) return true;
  } catch {}
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    return (
      text.includes('processing up to hd') ||
      (text.includes('processing') && /\d+\s*minutes? left/.test(text)) ||
      // "Checking 1%... 10 minutes left" — YouTube's checks phase
      (text.includes('checking') && /\d+\s*%/.test(text)) ||
      (/checking\s+\d+\s*%/.test(text)) ||
      // Generic "X minutes left" with checking
      (text.includes('checking') && /\d+\s*minutes? left/.test(text))
    );
  }).catch(() => false);
}

// Waits (up to maxWaitMs, default 10 min) for YouTube's server-side transcoding to finish.
// Polls every 20 s. Returns true when processing is no longer detected.
async function waitForVideoTranscodingToComplete(page, maxWaitMs = 10 * 60 * 1000) {
  const started = Date.now();
  const maxMinutes = Math.round(maxWaitMs / 60000);
  console.log(`[YouTube] Video transcoding in progress — waiting for it to complete (up to ${maxMinutes} minutes)...`);

  while (Date.now() - started < maxWaitMs) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const stillProcessing = await isVideoTranscodingInProgress(page);
    if (!stillProcessing) {
      console.log(`[YouTube] Video transcoding completed after ${elapsed}s`);
      return true;
    }
    const progressText = await page.evaluate(() => {
      const match = (document.body?.innerText || '').match(/processing[^\n]*/i);
      return match ? match[0].trim().slice(0, 80) : '';
    }).catch(() => '');
    console.log(`[YouTube] Still transcoding... (${elapsed}s elapsed)${progressText ? ' — ' + progressText : ''}`);
    await page.waitForTimeout(20000);
  }
  console.warn('[YouTube] Transcoding wait timed out');
  return false;
}

// Waits (up to maxWaitMs, default 90 min) for the upload progress dialog to clear
// and a success/processing confirmation to appear. Polls every 20 s so it doesn't
// overwhelm YouTube Studio with unnecessary checks.
// maxWaitMs is set to 90 minutes to handle very large video files.
async function waitForVideoUploadToComplete(page, maxWaitMs = 90 * 60 * 1000) {
  const started = Date.now();
  const maxMinutes = Math.round(maxWaitMs / 60000);
  console.log(`[YouTube] Video upload in progress — waiting for it to complete (up to ${maxMinutes} minutes)...`);

  let noSignalCount = 0;

  while (Date.now() - started < maxWaitMs) {
    const elapsed = Math.round((Date.now() - started) / 1000);

    // Check for a final success/processing state first
    const confirmed = await waitForPublishConfirmation(page, 3000);
    if (confirmed) {
      console.log(`[YouTube] Upload & processing confirmed after ${elapsed}s`);
      return true;
    }

    // Still uploading?
    const stillUploading = await isVideoUploadInProgress(page);
    if (stillUploading) {
      noSignalCount = 0;
      const progressText = await page.evaluate(() => {
        // Try to grab the percentage / time-remaining line from the dialog
        const dialog = document.querySelector(
          'ytcp-uploads-still-processing-modal, [class*="upload-progress"], ytcp-video-upload-progress, .ytcp-upload-progress'
        );
        return (dialog?.innerText || '').trim().slice(0, 120);
      }).catch(() => '');
      console.log(`[YouTube] Still uploading... (${elapsed}s elapsed)${progressText ? ' — ' + progressText : ''}`);
      await page.waitForTimeout(20000);
      continue;
    }

    // Dialog gone but no confirmation yet — wait a bit and retry before giving up.
    // YouTube can briefly hide the dialog between polling cycles so we require several
    // consecutive "no signal" readings before declaring the upload done without confirmation.
    noSignalCount += 1;
    if (noSignalCount < 3) {
      await page.waitForTimeout(8000);
      continue;
    }
    break;
  }

  // One final generous confirmation check
  return waitForPublishConfirmation(page, 20000);
}

async function extractPublishedVideoUrl(page) {
  const url = await page.evaluate(() => {
    const candidates = [
      'a.style-scope.ytcp-video-info[href*="youtu"]',
      'a[href*="youtu.be"]',
      'a[href*="youtube.com/watch"]',
      'a[href*="youtube.com/shorts/"]',
      '.video-url-fadeable a',
      'input#share-url',
      'input[readonly][value*="youtu"]',
    ];

    for (const selector of candidates) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const href = node.href || node.value || node.textContent || '';
      if (href) return String(href).trim();
    }
    return '';
  }).catch(() => '');

  return isLikelyYouTubeUrl(url) ? url : '';
}

async function requestHumanObstacleHelp(page, credentials, reason) {
  const screenshotBuffer = await safeScreenshot(page);
  const message =
    `🚧 <b>YouTube uploader needs your help</b>\n` +
    `${reason}\n\n` +
    `Please do one of these:\n` +
    `• Reply <b>APPROVED</b> after you fix it on-screen\n` +
    `• Reply <b>METHOD PHONE</b> or <b>METHOD CODE</b> for verification flow\n` +
    `• Reply <b>CODE 123456</b> if code input is shown`;

  const approval = await requestTelegramApproval({
    telegram: credentials.telegram,
    platform: 'YouTube',
    customMessage: message,
    screenshotBuffer,
    screenshotCaption: '📸 <b>YouTube obstacle screen</b> — review this screen and reply with your instruction',
    backend: credentials.backend,
  });

  if (!approval) throw new Error('Uploader is blocked and no Telegram response was received.');

  if (approval.method) {
    await chooseGoogleVerificationMethod(page, approval.method);
  }
  if (approval.code) {
    await tryFillVerificationCode(page, approval.code);
    await page.waitForTimeout(5000);
  }
  if (approval.approved) {
    await page.waitForTimeout(2500);
  }

  return approval;
}

async function uploadToYouTube(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  const userDataDir = resolveUserDataDir(credentials?.browserProfileId, credentials?.accountId);
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`[YouTube] Starting upload... (profile: ${credentials?.browserProfileId || credentials?.accountId || 'default'})`);
  const context = await launchPersistentSafe(chromium, userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  }, { label: `youtube:${credentials?.browserProfileId || credentials?.accountId || 'default'}` });

  const page = context.pages()[0] || await context.newPage();

  try {
    // ===== PHASE 1: LOGIN =====
    await gotoYouTubePage(page, YT_STUDIO_URL, 60000, 3000);

    let loginAttempts = 0;
    const MAX_LOGIN_ATTEMPTS = 60;
    let verificationRequested = false;
    let lastStateKey = '';
    let repeatedStateCount = 0;
    let phoneOptionPicked = false;
    let loggedIn = false;
    let loggedOutNotified = false;
    const recoveryPhone = String(credentials?.recoveryPhone || '598574742').replace(/\D/g, '');

    while (loginAttempts++ < MAX_LOGIN_ATTEMPTS) {
      const url = page.url();

      // Success: we're on YouTube Studio
      if (url.includes('studio.youtube.com') && !url.includes('accounts.google.com')) {
        console.log('[YouTube] Logged in to YouTube Studio');
        loggedIn = true;
        break;
      }

      // Google login flow
      if (url.includes('accounts.google.com')) {
        if (!loggedOutNotified) {
          loggedOutNotified = true;
          console.log('[YouTube] Profile is logged out — auto-logging in');
          await sendTelegram(
            credentials?.telegram?.botToken,
            credentials?.telegram?.chatId,
            `⚠️ YouTube Chrome profile is logged out — auto-logging in as ${credentials?.email || '(no email)'}.`,
            credentials?.backend,
          ).catch(() => {});
        }
        const auth = await inspectGoogleAuthState(page);
        const stateKey = [
          auth.urlPath,
          auth.hasEmailInput ? 'email' : '',
          auth.isIdentifierStep ? 'identifier-step' : '',
          auth.hasPasswordInput ? 'password' : '',
          auth.isPasswordStep ? 'password-step' : '',
          auth.hasCodeInput ? 'code' : '',
          auth.hasPhonePrompt ? 'phone' : '',
          auth.isChooseAccount ? 'choose' : '',
          auth.hasContinueButton ? 'continue' : '',
        ].filter(Boolean).join('|') || 'unknown';

        if (stateKey === lastStateKey) repeatedStateCount += 1;
        else repeatedStateCount = 0;
        lastStateKey = stateKey;

        if (auth.hasPasswordInput || auth.isPasswordStep) {
          verificationRequested = false;
          const submitted = await submitGooglePassword(page, credentials.password);
          if (!submitted && auth.hasContinueButton) {
            await clickByText(page, ['next', 'continue']);
            await page.waitForTimeout(2200);
          }
          continue;
        }

        if (auth.hasEmailInput || auth.isIdentifierStep) {
          verificationRequested = false;
          if (auth.hasEmailInput) {
            await submitGoogleEmail(page, credentials.email);
          } else if (auth.hasContinueButton) {
            await clickByText(page, ['next', 'continue']);
            await page.waitForTimeout(2200);
          }
          continue;
        }

        // Recovery phone screen — Google asks user to enter the full phone number
        // matching the masked tail (e.g. "•• 42"). Auto-fill from credentials.recoveryPhone.
        if (auth.isRecoveryPhonePrompt && auth.hasPhoneInput) {
          const tail = (auth.recoveryPhoneTail || '').replace(/\D/g, '');
          const matchesTail = !tail || recoveryPhone.endsWith(tail);
          if (recoveryPhone && matchesTail) {
            console.log(`[YouTube] Recovery-phone prompt detected (mask •• ${tail || '??'}) — auto-filling ${recoveryPhone}`);
            await sendTelegram(
              credentials?.telegram?.botToken,
              credentials?.telegram?.chatId,
              `📞 YouTube asked to confirm recovery phone (ending ${tail || '??'}). Auto-filling ${recoveryPhone}.`,
              credentials?.backend,
            ).catch(() => {});
            await smartFill(page, [
              'input[type="tel"][name*="phone" i]',
              'input[id*="phone" i]',
              'input[aria-label*="phone" i]',
              'input[type="tel"]',
            ], recoveryPhone);
            await page.waitForTimeout(400);
            const clicked = await smartClick(page, [
              '#next button', '#identifierNext button', 'button[type="submit"]',
              'button:has-text("Next")', 'button:has-text("Continue")',
            ], 'Next');
            if (!clicked) await page.keyboard.press('Enter').catch(() => {});
            await page.waitForTimeout(3500);
            continue;
          } else {
            console.log(`[YouTube] Recovery-phone tail mismatch (mask=${tail}, stored=${recoveryPhone}) — escalating to Telegram`);
            // Fall through to Telegram request below
          }
        }

        // Picking from a list of phones ("ending in XX" options)
        if (auth.phoneOptions && auth.phoneOptions.length > 0 && recoveryPhone && !phoneOptionPicked) {
          const tail2 = recoveryPhone.slice(-2);
          const picked = await page.evaluate((tail) => {
            const nodes = Array.from(document.querySelectorAll('[role="link"], [role="button"], li, div'));
            for (const n of nodes) {
              const t = (n.textContent || '').trim();
              if (/ending in|ends in|••|\.\.\./i.test(t) && t.includes(tail)) {
                n.click();
                return true;
              }
            }
            return false;
          }, tail2);
          if (picked) {
            phoneOptionPicked = true;
            console.log(`[YouTube] Picked phone option ending in ${tail2}`);
            await page.waitForTimeout(2500);
            continue;
          }
        }

        if (auth.isChooseAccount || auth.accountEmails.length > 0) {
          console.log('[YouTube] Choosing Google account...');
          const chose = await chooseGoogleAccount(page, credentials.email);
          if (chose) {
            await page.waitForTimeout(2500);
            continue;
          }
        }

        if (auth.hasContinueButton) {
          const clicked = await clickByText(page, ['continue', 'continue as', 'yes', 'i agree', 'next']);
          if (clicked) {
            await page.waitForTimeout(2500);
            continue;
          }
        }

        // 2FA / Verification — only request Telegram help when credentials are not requested
        if (!auth.hasEmailInput && !auth.hasPasswordInput && (auth.hasCodeInput || auth.hasPhonePrompt || auth.hasNumberMatchPrompt)) {
          if (verificationRequested && repeatedStateCount < 3) {
            await page.waitForTimeout(2500);
            continue;
          }

          console.log('[YouTube] Verification detected — requesting Telegram help...');
          verificationRequested = true;

          const screenshotBuffer = await safeScreenshot(page);
          let verificationMessage = `🔐 <b>YouTube verification needed</b>\n`;
          verificationMessage += `Reply with one of:\n`;
          verificationMessage += `• <b>METHOD PHONE</b> (use phone approval)\n`;
          verificationMessage += `• <b>METHOD CODE</b> (use one-time code)\n`;
          verificationMessage += `• <b>APPROVED</b> (already approved)\n`;
          verificationMessage += `• <b>CODE 123456</b>\n\n`;
          if (auth.matchNumber) {
            verificationMessage += `Google shows number <b>${auth.matchNumber}</b>. Choose that number on your phone.`;
          } else if (auth.hasPhonePrompt) {
            verificationMessage += `Google is asking for phone/device approval.`;
          } else {
            verificationMessage += `Google is asking for a verification code.`;
          }

          let approval = await requestTelegramApproval({
            telegram: credentials.telegram,
            platform: 'YouTube',
            customMessage: verificationMessage,
            screenshotBuffer,
            backend: credentials.backend,
          });

          if (!approval) throw new Error('Verification required but no response received. Check Telegram.');

          if (approval.method) {
            await chooseGoogleVerificationMethod(page, approval.method);
          }

          if (!approval.code && !approval.approved) {
            approval = await requestTelegramApproval({
              telegram: credentials.telegram,
              platform: 'YouTube',
              customMessage: approval.method === 'code'
                ? '⌨️ <b>YouTube verification code mode selected</b>\nSend: CODE 123456'
                : '📱 <b>YouTube phone approval mode selected</b>\nApprove on your phone, then reply: APPROVED',
              screenshotBuffer: await safeScreenshot(page),
              backend: credentials.backend,
            });

            if (!approval) throw new Error('Verification step timed out — no Telegram response received.');
            if (approval.method) {
              await chooseGoogleVerificationMethod(page, approval.method);
            }
          }

          if (approval.code) {
            await tryFillVerificationCode(page, approval.code);
            await page.waitForTimeout(6000);
          } else {
            await page.waitForTimeout(9000);
          }

          await waitForStateChange(page, url, 12000).catch(() => {});
          await page.waitForTimeout(1500);
          continue;
        }

        if (auth.hasCaptcha) {
          throw new Error('Google asked for CAPTCHA/unusual-traffic check. Complete it manually once, then retry upload.');
        }

        if (repeatedStateCount >= 2) {
          console.log('[YouTube] Auth state stuck, retrying via YouTube Studio route...');
          if (repeatedStateCount >= 5) {
            await requestHumanObstacleHelp(
              page,
              credentials,
              'Login is looping on the same Google screen. Choose verification method or complete this step and reply APPROVED.'
            );
            repeatedStateCount = 0;
            await page.waitForTimeout(2000);
            continue;
          }

          await gotoYouTubePage(page, YT_STUDIO_URL, 45000, 2500).catch(() => {});
          continue;
        }

        console.log('[YouTube] Waiting on Google auth page...');
        await page.waitForTimeout(2500);
        continue;
      }

      if (url.includes('youtube.com')) {
        await gotoYouTubePage(page, YT_STUDIO_URL, 45000, 2500).catch(() => {});
        continue;
      }

      await gotoYouTubePage(page, YT_STUDIO_URL, 45000, 2500).catch(() => {});
    }

    if (!loggedIn) {
      const recoveredInput = await ensureStudioUploadPage(page).catch(() => null);
      if (recoveredInput) {
        loggedIn = true;
      }
    }

    if (!loggedIn) {
      const finalShot = await safeScreenshot(page);
      await sendTelegram(
        credentials?.telegram?.botToken,
        credentials?.telegram?.chatId,
        `❌ YouTube auto-login failed after ${MAX_LOGIN_ATTEMPTS} attempts. Open the Chrome profile and finish login manually.`,
        credentials?.backend,
      ).catch(() => {});
      if (finalShot && credentials?.telegram?.chatId) {
        try {
          const { sendTelegramPhoto } = require('../telegram');
          await sendTelegramPhoto(credentials.telegram.botToken, credentials.telegram.chatId, finalShot, '📸 YouTube blocked screen', credentials.backend);
        } catch {}
      }
      throw new Error('Login did not complete — still blocked on Google sign-in flow after multiple attempts.');
    }

    // ===== PHASE 2: OPEN UPLOAD DIALOG =====
    console.log('[YouTube] Opening upload dialog...');
    let cachedVideoUrl = '';

    let fileInput = await ensureStudioUploadPage(page);

    if (!fileInput) {
      // Try clicking Create button
      let createClicked = await smartClick(page, [
        '#create-icon',
        'ytcp-button#create-icon',
        '[aria-label="Create"]',
        'button[aria-label="Create"]',
      ], 'Create');

      if (!createClicked) {
        await page.evaluate(() => {
          const btn = document.querySelector('#create-icon') ||
                      document.querySelector('[aria-label="Create"]') ||
                      document.querySelector('ytcp-button#create-icon');
          if (btn) { btn.click(); return true; }
          return false;
        });
      }
      await page.waitForTimeout(1800);

      // Click "Upload videos" from dropdown
      let uploadMenuClicked = await smartClick(page, [
        '#text-item-0',
        'tp-yt-paper-item:first-child',
        '[test-id="upload-icon"]',
      ], 'Upload video');

      if (!uploadMenuClicked) {
        await page.evaluate(() => {
          const items = document.querySelectorAll('tp-yt-paper-item, ytcp-text-menu a, [role="menuitem"], [role="option"]');
          for (const item of items) {
            if (item.textContent?.toLowerCase().includes('upload video')) { item.click(); return; }
          }
          if (items.length > 0) items[0].click();
        });
      }
      await page.waitForTimeout(2500);
      fileInput = await getYouTubeFileInput(page);
    }

    if (!fileInput) {
      console.log('[YouTube] Upload dialog not found, trying direct navigation...');
      await gotoYouTubePage(page, YT_UPLOAD_URL, 45000, 3000);
      fileInput = await getYouTubeFileInput(page);
    }

    if (!fileInput) {
      // Last resort: try clicking Create again with a different strategy
      await gotoYouTubePage(page, 'https://studio.youtube.com', 30000, 3000);
      // Click using page coordinates — Create button is usually top-right area
      await page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll('button, ytcp-button'));
        for (const btn of allButtons) {
          const text = btn.textContent?.toLowerCase() || '';
          const label = btn.getAttribute('aria-label')?.toLowerCase() || '';
          if (text.includes('create') || label.includes('create') || text.includes('upload')) {
            btn.click();
            break;
          }
        }
      });
      await page.waitForTimeout(2000);
      // Now try to find Upload videos option
      await page.evaluate(() => {
        const items = document.querySelectorAll('tp-yt-paper-item, [role="menuitem"], [role="option"], a');
        for (const item of items) {
          if (item.textContent?.toLowerCase().includes('upload')) { item.click(); return; }
        }
      });
      await page.waitForTimeout(3000);
      fileInput = await page.$('input[type="file"]');
    }

    if (!fileInput) {
      const arbiter = await attemptUploadArbiter(page, {
        platform: 'YouTube video',
        checkpoint: 'open upload dialog',
        originalError: 'Could not open YouTube upload dialog.',
        allowedClickTexts: ['create', 'upload videos', 'upload video'],
        verify: async () => Boolean(await getYouTubeFileInput(page)),
      });
      if (arbiter.recovered) fileInput = await getYouTubeFileInput(page);
      if (!fileInput) {
        throw new Error(`Could not open YouTube upload dialog. AI arbiter could not safely clear the obstacle: ${arbiter.reason}. Try logging in manually first at https://studio.youtube.com`);
      }
    }

    // ===== PHASE 3: UPLOAD VIDEO FILE =====
    console.log('[YouTube] Setting video file...');
    await fileInput.setInputFiles(videoPath);
    console.log('[YouTube] Video file set, waiting for processing...');
    await page.waitForTimeout(8000);
    cachedVideoUrl = await captureVideoUrlCandidate(page, cachedVideoUrl);

    // ===== PHASE 4: FILL TITLE & DESCRIPTION =====
    // Wait for the title textbox to appear (YouTube Studio loads it async)
    for (let waitIdx = 0; waitIdx < 10; waitIdx++) {
      const hasTextbox = await page.$('#textbox');
      if (hasTextbox) break;
      await page.waitForTimeout(1500);
    }

    if (metadata?.title) {
      console.log(`[YouTube] Setting title: "${metadata.title.slice(0, 60)}"`);
      // Primary: keyboard approach — most reliable across Chromium versions.
      // execCommand is deprecated and may silently fail without updating the field.
      let titleFilled = false;
      const titleBox = await page.$('#textbox');
      if (titleBox) {
        try {
          await titleBox.click({ clickCount: 3 });
          await page.waitForTimeout(200);
          await page.keyboard.press('Control+a');
          await page.waitForTimeout(100);
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(100);
          await page.keyboard.type(metadata.title, { delay: 15 });
          titleFilled = true;
          console.log('[YouTube] Title filled via keyboard');
        } catch (e) {
          console.warn('[YouTube] Keyboard title fill failed:', e.message);
        }
      }
      if (!titleFilled) {
        // Fallback: execCommand
        await page.evaluate((title) => {
          const textboxes = document.querySelectorAll('#textbox');
          const titleBox = textboxes[0];
          if (!titleBox) return;
          titleBox.focus();
          titleBox.click();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, title);
        }, metadata.title);
        console.log('[YouTube] Title fill attempted via execCommand fallback');
      }
    }

    if (metadata?.description || (metadata?.tags && metadata.tags.length > 0)) {
      const descParts = [];
      if (metadata.description) descParts.push(metadata.description);
      if (metadata.tags && metadata.tags.length > 0) {
        descParts.push(metadata.tags.map(t => t.startsWith('#') ? t : '#' + t).join(' '));
      }
      const fullDescription = descParts.join('\n\n');
      console.log(`[YouTube] Description to fill (${fullDescription.length} chars): ${fullDescription.slice(0, 200)}...`);

      // First, try to click the description area to ensure it's expanded and focused.
      // YouTube Studio collapses the description box until clicked.
      await page.evaluate(() => {
        const labels = document.querySelectorAll('label, span, div, [placeholder]');
        for (const el of labels) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (text.includes('tell viewers about your video') || text.includes('description')) {
            el.click();
            return;
          }
        }
      }).catch(() => {});
      await page.waitForTimeout(800);

      // Wait for description textbox to appear (2nd #textbox)
      let descBoxReady = false;
      for (let waitIdx = 0; waitIdx < 10; waitIdx++) {
        const count = await page.$$eval('#textbox', els => els.length).catch(() => 0);
        if (count >= 2) { descBoxReady = true; break; }
        await page.waitForTimeout(1000);
      }

      // Primary: keyboard approach (most reliable)
      const allTextboxes = await page.$$('#textbox').catch(() => []);
      const descBox = allTextboxes[1] || null;
      let descFilled = false;
      if (descBox) {
        try {
          await descBox.click({ clickCount: 3 });
          await page.waitForTimeout(200);
          await page.keyboard.press('Control+a');
          await page.waitForTimeout(100);
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(100);
          await page.keyboard.type(fullDescription, { delay: 15 });
          descFilled = true;
          console.log('[YouTube] Description filled via keyboard');
        } catch (e) {
          console.warn('[YouTube] Keyboard description fill failed:', e.message);
        }
      }

      if (!descFilled) {
        // Fallback: execCommand
        const execFilled = await page.evaluate((desc) => {
          const textboxes = document.querySelectorAll('#textbox');
          if (textboxes.length > 1) {
            const descBox = textboxes[1];
            descBox.focus();
            descBox.click();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, desc);
            const content = (descBox.textContent || descBox.innerText || '').trim();
            return content.length > 0;
          }
          return false;
        }, fullDescription);
        if (execFilled) {
          console.log('[YouTube] Description filled via execCommand fallback');
        } else {
          console.warn('[YouTube] Could not find description textbox — description NOT filled');
        }
      }
    }

    // Try to expand "Show more" to access the Tags field
    if (metadata?.tags && metadata.tags.length > 0) {
      try {
        const expanded = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, ytcp-button, [role="button"]'));
          for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase().trim();
            if (text === 'show more' || text.includes('show more')) {
              btn.click();
              return true;
            }
          }
          return false;
        });
        if (expanded) {
          await page.waitForTimeout(1500);
          const tagString = metadata.tags.map(t => t.replace(/^#/, '')).join(', ');
          const tagsFilled = await page.evaluate((tags) => {
            const inputs = document.querySelectorAll('input[placeholder*="tag" i], input[aria-label*="tag" i], #tags-container input');
            for (const input of inputs) {
              if (input.offsetHeight === 0) continue;
              input.focus();
              input.click();
              input.value = tags;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            const textboxes = document.querySelectorAll('#chip-bar input, #tags-textbox input, [aria-label*="Tags" i] input');
            for (const tb of textboxes) {
              if (tb.offsetHeight === 0) continue;
              tb.focus();
              tb.value = tags;
              tb.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            }
            return false;
          }, tagString);
          if (tagsFilled) {
            console.log(`[YouTube] Tags filled: ${tagString.slice(0, 100)}`);
            await page.keyboard.press('Enter').catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[YouTube] Tags fill failed (non-fatal):', e.message);
      }
    }
    await page.waitForTimeout(2000);

    // Audience selection
    for (let attempt = 0; attempt < 3; attempt++) {
      const picked = await selectAudienceNotMadeForKids(page);
      if (picked) break;
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(1200);

    // ===== PHASE 5: NAVIGATE WIZARD (Next × 3) =====
    console.log('[YouTube] Navigating upload wizard...');
    let nextClicks = 0;
    let stuckRounds = 0;
    while (nextClicks < 3) {
      if (await isVisibilityStep(page)) break;

      await page.waitForTimeout(1200);
      // Re-attempt audience selection on every iteration — YouTube sometimes
      // resets the selection after navigating or if the element was not yet
      // rendered when the previous attempt ran.
      for (let attempt = 0; attempt < 2; attempt++) {
        const picked = await selectAudienceNotMadeForKids(page);
        if (picked) break;
        await page.waitForTimeout(600);
      }
      await acceptUploadAgreements(page);

      const next = await clickNextWizardStep(page);
      if (next.clicked) {
        nextClicks += 1;
        stuckRounds = 0;
        cachedVideoUrl = await captureVideoUrlCandidate(page, cachedVideoUrl);
        await page.waitForTimeout(2200);
        continue;
      }

      stuckRounds += 1;
      if (next.disabled && stuckRounds >= 2) {
        // Before asking for human help, check if the Next button is disabled because
        // the video is still being transcoded by YouTube — just wait in that case.
        if (await isVideoTranscodingInProgress(page)) {
          console.log('[YouTube] Next button disabled because video is still transcoding — waiting for processing to complete...');
          await waitForVideoTranscodingToComplete(page);
          stuckRounds = 0;
          continue;
        }
        await requestHumanObstacleHelp(
          page,
          credentials,
          'The Next button is disabled (usually audience/agreements/required fields). Please complete the visible requirement, then reply APPROVED.'
        );
        stuckRounds = 0;
        continue;
      }

      if (stuckRounds >= 2) {
        // Try dismissing any tip / coachmark / "what's new" overlay that may be
        // blocking the wizard before escalating further.
        console.log('[YouTube] Wizard stuck — attempting to dismiss any tip overlay');
        await dismissOverlayBlockingFlow(page, { logPrefix: '[YouTube]' });
      }

      if (stuckRounds >= 4) {
        // Same transcoding check for the general "stuck" case.
        if (await isVideoTranscodingInProgress(page)) {
          console.log('[YouTube] Wizard stuck because video is still transcoding — waiting for processing to complete...');
          await waitForVideoTranscodingToComplete(page);
          stuckRounds = 0;
          continue;
        }
        await requestHumanObstacleHelp(
          page,
          credentials,
          'Uploader cannot progress to the next step. Please guide/fix this step on-screen, then reply APPROVED.'
        );
        stuckRounds = 0;
      }
    }

    if (!(await isVisibilityStep(page))) {
      throw new Error('YouTube upload wizard did not reach the visibility step.');
    }

    // ===== PHASE 6: SET VISIBILITY TO PUBLIC =====
    console.log('[YouTube] Setting visibility to Public...');
    let publicSelected = false;
    for (let vAttempt = 0; vAttempt < 6 && !publicSelected; vAttempt++) {
      if (vAttempt > 0) {
        await page.waitForTimeout(1500);
        // On retries, try scrolling to make visibility options visible
        await page.evaluate(() => {
          const dialog = document.querySelector('ytcp-uploads-dialog, [role="dialog"]');
          if (dialog) dialog.scrollTop = dialog.scrollHeight;
        }).catch(() => {});
        await page.waitForTimeout(500);
      }
      publicSelected = await selectVisibilityPublic(page);

      if (publicSelected) {
        await page.waitForTimeout(800);
        const confirmed = await page.evaluate(() => {
          function deepQueryAll(root) {
            const results = [];
            results.push(...Array.from(root.querySelectorAll('[role="radio"], tp-yt-paper-radio-button, ytcp-radio-button')));
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot));
            }
            return results;
          }
          for (const r of deepQueryAll(document)) {
            const text = (r.textContent || '').toLowerCase().trim();
            if (!text.startsWith('public')) continue;
            const checked = r.getAttribute('aria-checked') === 'true' || r.checked === true;
            const inner = r.querySelector('input[type="radio"]');
            const innerChecked = inner ? (inner.checked || inner.getAttribute('aria-checked') === 'true') : false;
            if (checked || innerChecked) return true;
          }
          return false;
        }).catch(() => false);

        if (!confirmed) {
          console.warn(`[YouTube] Public not confirmed selected on attempt ${vAttempt + 1}, retrying...`);
          publicSelected = false;
        } else {
          console.log('[YouTube] Visibility set to Public and confirmed');
        }
      }
    }

    // Last resort: use Telegram to ask human to set Public manually
    if (!publicSelected) {
      // Before escalating to human, check if the video is still being transcoded by
      // YouTube ("Processing up to HD… X minutes left"). In that state the radio
      // buttons are often disabled — just wait and retry automatically.
      if (await isVideoTranscodingInProgress(page)) {
        console.log('[YouTube] Cannot select Public visibility because video is still transcoding — waiting for processing to complete...');
        await waitForVideoTranscodingToComplete(page);
        await page.waitForTimeout(1500);
        for (let retryAttempt = 0; retryAttempt < 4 && !publicSelected; retryAttempt++) {
          if (retryAttempt > 0) await page.waitForTimeout(1500);
          publicSelected = await selectVisibilityPublic(page);
          if (publicSelected) console.log('[YouTube] Visibility set to Public after waiting for transcoding');
        }
      }
    }

    if (!publicSelected) {
      console.warn('[YouTube] Could not auto-select Public visibility — asking for human help...');
      try {
        await requestHumanObstacleHelp(
          page,
          credentials,
          'Could not select "Public" visibility. Please click the "Public" radio button on this screen, then reply APPROVED.'
        );
        // After human intervention, re-verify
        publicSelected = await selectVisibilityPublic(page).catch(() => false);
        if (!publicSelected) {
          // Even if we can't confirm, human said they did it, so proceed
          publicSelected = true;
          console.log('[YouTube] Proceeding after human confirmed Public visibility');
        }
      } catch (humanErr) {
        console.warn('[YouTube] Human help for visibility failed:', humanErr.message);
      }
    }
    await page.waitForTimeout(1500);
    cachedVideoUrl = await captureVideoUrlCandidate(page, cachedVideoUrl);

    // ===== PHASE 7: PUBLISH =====
    console.log('[YouTube] Publishing...');
    await smartClick(page, ['#done-button', '#publish-button'], 'Publish');

    // Also try JS click
    await page.evaluate(() => {
      const btn = document.querySelector('#done-button') || document.querySelector('#publish-button');
      if (btn) btn.click();
    });
    await page.waitForTimeout(6000);

    // Handle the "Your video is still being checked / uploaded — Publish anyway?"
    // confirmation dialog. If we ignore it, clicking Publish has no effect and the
    // video gets stranded as a draft once we close the tab.
    await confirmPublishAnywayIfPrompted(page);

    cachedVideoUrl = await captureVideoUrlCandidate(page, cachedVideoUrl);

    // Check immediately whether the file is still transferring.
    // If so, wait patiently (up to 90 min) instead of escalating to human help.
    if (await isVideoUploadInProgress(page)) {
      console.log('[YouTube] Upload dialog detected — waiting for file transfer to finish before checking confirmation...');
      await waitForVideoUploadToComplete(page);
    }

    let publishConfirmed = await waitForPublishConfirmation(page, 30000);
    if (!publishConfirmed) {
      const postPublish = await assessYouTubePostPublishState(page);
      if (postPublish.successLike) {
        publishConfirmed = true;
      } else if (postPublish.isUploading) {
        // Still uploading — give it the full wait before escalating
        console.log('[YouTube] Upload still in progress after initial checks — waiting for file transfer to complete...');
        publishConfirmed = await waitForVideoUploadToComplete(page);
      }

      if (!publishConfirmed) {
        // Re-evaluate after any waiting above
        const finalCheck = await assessYouTubePostPublishState(page);
        if (finalCheck.successLike) {
          publishConfirmed = true;
        } else if (finalCheck.isUploading) {
          // Upload still going even after the extended wait — keep waiting
          console.log('[YouTube] Upload continuing — entering extended wait...');
          publishConfirmed = await waitForVideoUploadToComplete(page);
        } else {
          const arbiter = await attemptUploadArbiter(page, {
            platform: 'YouTube video',
            checkpoint: 'post-submit confirmation',
            originalError: `Publish confirmation was not clearly detected. ${finalCheck.reason}`,
            submissionAttempted: true,
            verify: async () => (await assessYouTubePostPublishState(page)).successLike,
          });
          if (arbiter.recovered) {
            publishConfirmed = true;
          } else {
            await requestHumanObstacleHelp(
              page,
              credentials,
              `Publish confirmation was not clearly detected. ${finalCheck.reason}\nThe local AI arbiter found no safe automatic action. Complete any remaining YouTube step and reply APPROVED.`
            );
          }
          // After human APPROVED: upload may still be in progress — wait for it before declaring success
          if (!publishConfirmed && await isVideoUploadInProgress(page)) {
            console.log('[YouTube] Upload still running after APPROVED — waiting for file transfer to complete...');
            await waitForVideoUploadToComplete(page);
          }
          if (!publishConfirmed) publishConfirmed = await waitForPublishConfirmation(page, 30000);
          if (!publishConfirmed) {
            const secondCheck = await assessYouTubePostPublishState(page);
            publishConfirmed = secondCheck.successLike;
          }
        }
      }
    }

    if (!publishConfirmed) {
      throw new Error('Publish was not confirmed, so URL was not returned.');
    }

    // ===== PHASE 7.5: SAFETY WAIT BEFORE CLOSING TAB =====
    // YouTube shows a "Your video is still uploading. Are you sure you want to leave?"
    // beforeunload prompt if we close while file transfer or initial server processing
    // is still active. Closing through that dialog leaves the video as a DRAFT instead
    // of publishing it. Make absolutely sure neither the upload dialog nor active
    // transcoding is in progress before tearing down the context.
    try {
      // 1) Drain any remaining file-transfer activity (handles slow uploads).
      if (await isVideoUploadInProgress(page)) {
        console.log('[YouTube] Upload dialog still visible after publish confirmation — waiting for file transfer to fully finish before closing tab...');
        await waitForVideoUploadToComplete(page);
      }

      // 2) Wait for server-side transcoding/checks to finish so YouTube no longer
      //    needs the tab open. Capped to 10 min — after that the video is safe
      //    to close because YouTube has the file.
      if (await isVideoTranscodingInProgress(page)) {
        console.log('[YouTube] Transcoding/checks still running — waiting before closing tab to avoid the "leave site?" draft trap...');
        await waitForVideoTranscodingToComplete(page);
      }

      // 3) Final settle delay so the publish action is committed server-side.
      await page.waitForTimeout(8000);

      // 4) Try to capture the published URL one more time now that processing settled.
      cachedVideoUrl = await captureVideoUrlCandidate(page, cachedVideoUrl);
    } catch (waitErr) {
      console.warn('[YouTube] Pre-close safety wait encountered an issue:', waitErr.message);
    }

    // ===== PHASE 8: EXTRACT VIDEO URL =====
    const videoUrl =
      await extractPublishedVideoUrl(page)
      || cachedVideoUrl
      || await captureVideoUrlCandidate(page, '');

    console.log(`[YouTube] Upload complete! URL: ${videoUrl || 'not captured'}`);

    await safeCloseContext(context, page);
    return { url: videoUrl || undefined };
  } catch (err) {
    console.error('[YouTube] Upload failed:', err.message);
    await safeCloseContext(context, page);
    throw err;
  }
}

// Closes the browser context safely, auto-accepting any "Leave site?" beforeunload
// dialog that YouTube shows when a video is still mid-process. Without this handler
// Playwright can hang on close, or — worse — the dialog can cancel the navigation
// and leave the freshly-uploaded video stranded as a draft.
async function safeCloseContext(context, page) {
  try {
    if (page && !page.isClosed?.()) {
      page.on('dialog', async (dialog) => {
        try { await dialog.accept(); } catch {}
      });
      // Disable beforeunload handlers entirely so the close is silent.
      try {
        await page.evaluate(() => {
          window.onbeforeunload = null;
          window.addEventListener('beforeunload', (e) => { e.stopImmediatePropagation(); }, true);
        });
      } catch {}
      try { await page.close({ runBeforeUnload: false }); } catch {}
    }
  } catch {}
  try { await context?.close(); } catch {}
}

module.exports = { uploadToYouTube };
