// X (Twitter) post uploader using a persistent Chrome profile.
const { launchPersistent, safeClose } = require('./social-post-base');
// NOTE: do NOT import overlay-dismiss here. The compose UI is a role="dialog"
// and X's close (✕) button has a screen-reader-only "Close" span — the generic
// overlay dismisser would click it, trigger the "Save / Discard draft" prompt,
// and the post would end up submitted without text (only media).

const X_COMPOSE_URL = 'https://x.com/compose/post';
const X_MAX_IMAGES = 4;
const X_MAX_CHARS = 280; // hard cap on the X free tier
const X_SAFE_CHARS = 260; // buffer for hidden unicode/url counting in X UI
const X_URL_WEIGHT = 23;  // t.co always wraps URLs to ~23 chars

function xLength(value) {
  return Array.from(String(value || '').replace(/\r\n/g, '\n')).length;
}

// X counts every URL as 23 chars regardless of real length.
function xWeightedLength(value) {
  const s = String(value || '').replace(/\r\n/g, '\n');
  const urls = s.match(/https?:\/\/\S+/g) || [];
  const stripped = s.replace(/https?:\/\/\S+/g, '');
  return Array.from(stripped).length + urls.length * X_URL_WEIGHT;
}

function normalizeForXMatch(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueUrls(value) {
  const seen = new Set();
  const out = [];
  for (const raw of String(value || '').match(/https?:\/\/\S+/g) || []) {
    const url = raw.replace(/[),.;!?]+$/g, '');
    const key = url.toLowerCase();
    if (!url || seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

function stripXNoise(value) {
  return String(value || '')
    .replace(/^[\s\n]*TechPulse\s*:\s*/i, '')
    .replace(/^[\s\n]*\d+\.\s*[^:\n]{2,40}\s*:\s*/i, '')
    .replace(/^\s*(?:x|twitter)(?:_post| post)?\s*:\s*/i, '')
    .replace(/^\s*\d+\s*\/\s*\d+\s*/gm, '')
    .replace(/\b(?:LINKEDIN|FACEBOOK|X)_(?:POST|THREAD_OR_LONG_POST)\b/gi, '')
    .trim();
}

function firstXStory(value) {
  let s = stripXNoise(value)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Automatic folder manifests can contain a whole digest/thread in one field.
  // For free X accounts publish one concise story, not the full multi-story text.
  const splitters = [
    /\s*;\s*(?=\d+\.\s*[^:]{2,45}:)/,
    /\n\s*(?=\d+\.\s*[^:]{2,45}:)/,
    /\n\s*(?=\d+\s*\/\s*\d+)/,
    /\n\s*-{3,}\s*\n/,
  ];
  for (const re of splitters) {
    const parts = s.split(re).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts[0].length >= 35) { s = parts[0]; break; }
  }
  return stripXNoise(s);
}

// URL-aware trim. Preserves the first URL, strips hashtags first, then truncates
// body words. Always fits within the safe X free-tier limit.
function trimToXLimit(value, limit = X_SAFE_CHARS) {
  let s = String(value || '').trim();
  if (xWeightedLength(s) <= limit) return s;

  const urlRe = /https?:\/\/\S+/g;
  const urls = s.match(urlRe) || [];
  if (urls.length > 1) {
    const first = urls[0];
    let seen = false;
    s = s.replace(urlRe, (u) => {
      if (u === first && !seen) { seen = true; return u; }
      return '';
    }).replace(/[ \t]{2,}/g, ' ').trim();
  }
  if (xWeightedLength(s) <= limit) return s;

  s = s.replace(/\s*#[\p{L}0-9_]+/gu, '').replace(/[ \t]{2,}/g, ' ').trim();
  if (xWeightedLength(s) <= limit) return s;

  const firstUrl = (s.match(urlRe) || [])[0] || '';
  let body = firstUrl ? s.replace(firstUrl, '').trim() : s;
  const tail = firstUrl ? `\n${firstUrl}` : '';
  while (xWeightedLength((body + tail).trim()) + 1 > limit && body.length > 0) {
    const cut = body.replace(/\s*\S+\s*$/, '').trim();
    body = cut === body ? body.slice(0, Math.max(0, body.length - 1)) : cut;
  }
  if (body && !/[.!?…]$/.test(body)) body = body.replace(/[,;:\-\s]+$/, '') + '…';
  let result = (body + tail).trim();
  while (xWeightedLength(result) > limit && body.length > 0) {
    body = body.replace(/\s*\S+\s*$/, '').trim();
    if (body && !/[.!?…]$/.test(body)) body = body.replace(/[,;:\-\s]+$/, '') + '…';
    result = (body + tail).trim();
  }
  if (xWeightedLength(result) > limit) result = Array.from(result).slice(0, limit).join('').trim();
  return result;
}

function formatXHashtags(hashtags = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(hashtags) ? hashtags : []) {
    const tag = String(raw || '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(`#${tag}`);
  }
  return out;
}

function buildXPostText(description, hashtags = []) {
  const raw = String(description || '').replace(/\r\n/g, '\n');
  const firstUrl = uniqueUrls(raw)[0] || '';

  let body = firstXStory(raw)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // X automatic campaign posts get max one hashtag. Keep the link, remove tag
  // stuffing, then trim the body. Manual posts go through this same uploader too.
  const inlineTags = formatXHashtags(raw.match(/#[\p{L}\p{N}_]+/gu) || []);
  const tags = [...inlineTags, ...formatXHashtags(hashtags)].filter((tag, idx, arr) =>
    arr.findIndex((x) => x.toLowerCase() === tag.toLowerCase()) === idx,
  ).slice(0, 1);

  let tail = [tags[0], firstUrl].filter(Boolean).join('\n');
  tail = tail ? `\n\n${tail}` : '';
  if (xWeightedLength(tail.trim()) > 70 && firstUrl) tail = `\n\n${firstUrl}`;

  while (body && xWeightedLength(`${body}${tail}`.trim()) + 1 > X_SAFE_CHARS) {
    const cut = body.replace(/\s*\S+\s*$/, '').trim();
    body = cut === body ? body.slice(0, Math.max(0, body.length - 1)) : cut;
  }
  if (body && !/[.!?…]$/.test(body)) body = body.replace(/[,;:\-\s]+$/, '') + '…';
  const candidate = `${body}${tail}`.trim() || firstUrl;
  return trimToXLimit(candidate, X_SAFE_CHARS);
}

function handleFromXUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/(^|\.)x\.com$/i.test(url.hostname) && !/(^|\.)twitter\.com$/i.test(url.hostname)) return null;
    const first = url.pathname.split('/').filter(Boolean)[0];
    if (!first || /^(home|compose|intent|i|settings|notifications|messages|search|explore)$/i.test(first)) return null;
    return /^[A-Za-z0-9_]{1,15}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

function normalizeXStatusUrl(raw, expectedHandle = null) {
  if (!raw) return null;
  try {
    const url = new URL(raw, 'https://x.com');
    if (!/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) return null;
    const m = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
    if (!m) return null;
    if (expectedHandle && m[1].toLowerCase() !== String(expectedHandle).toLowerCase()) return null;
    return `https://x.com/${m[1]}/status/${m[2]}`;
  } catch {
    return null;
  }
}

async function getMyHandle(page) {
  const handleFromNav = await page.evaluate(() => {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')
      || document.querySelector('a[aria-label="Profile"]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
    return m ? m[1] : null;
  }).catch(() => null);
  if (handleFromNav) return handleFromNav;

  const handleFromAvatar = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="UserAvatar-Container-unknown"]')
      || document.querySelector('header [data-testid^="UserAvatar-Container-"]');
    if (!el) return null;
    const tid = el.getAttribute('data-testid') || '';
    const m = tid.match(/^UserAvatar-Container-(.+)$/);
    return m && m[1] !== 'unknown' ? m[1] : null;
  }).catch(() => null);
  return handleFromAvatar;
}

async function clearXComposer(page, textArea) {
  // X /compose/post may auto-restore a prior unsent draft (especially after a
  // failed scheduled run). A simple Ctrl+A+Backspace clears the visible text
  // but X's React state can still mark the textbox as "over limit" because the
  // restored draft was over limit. Explicitly discard the draft when X offers
  // to, then fall back to selecting-all + Backspace until empty.
  await textArea.click().catch(() => {});
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(150);
    const current = await textArea.evaluate((el) => (el.innerText || el.textContent || '').trim()).catch(() => '');
    if (!current) return;
  }
}

async function insertXText(page, textArea, text) {
  await clearXComposer(page, textArea);

  // X is React-controlled. CDP keyboard insertion can make text appear while
  // React's composer state remains empty, so the media-only Post button becomes
  // enabled and publishes photos without text. execCommand('insertText') fires
  // the beforeinput/input sequence React listens for; use it as the primary path.
  const desired = String(text || '');
  if (!desired) return;
  const inserted = await textArea.evaluate((el, value) => {
    el.focus();
    let ok = false;
    const chunks = String(value || '').match(/[\s\S]{1,24}/g) || [];
    for (const chunk of chunks) ok = document.execCommand('insertText', false, chunk) || ok;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value || '' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const visible = (el.innerText || el.textContent || '').trim();
    return { ok, visible };
  }, desired).catch(() => ({ ok: false, visible: '' }));

  let visibleText = String(inserted?.visible || '').trim();
  if ((!inserted?.ok || !visibleText) && desired) {
    await textArea.click().catch(() => {});
    await page.keyboard.insertText(desired).catch(() => {});
    await page.waitForTimeout(400);
    visibleText = await textArea.evaluate((el) => (el.innerText || el.textContent || '').trim()).catch(() => '');
  }
  if (!visibleText && desired) {
    await textArea.click().catch(() => {});
    await page.keyboard.type(desired, { delay: 1 }).catch(() => {});
    await page.waitForTimeout(400);
    visibleText = await textArea.evaluate((el) => (el.innerText || el.textContent || '').trim()).catch(() => '');
  }
  if (!visibleText) throw new Error('X composer text could not be inserted. Leaving source files for retry.');
}

async function ensureXTextWithinLimit(page, textArea, desiredText) {
  // Trust ONLY the actual textbox length. Page-level toasts ("Upgrade to
  // Premium to write longer posts", lingering "exceeded the character limit"
  // banners from a restored draft, drafts side-panel previews, etc.) live
  // outside the textbox and previously caused this loop to falsely abort,
  // which is why scheduled X uploads kept failing while manual posts worked.
  let safeText = trimToXLimit(desiredText, X_SAFE_CHARS);
  for (let attempt = 0; attempt < 4; attempt++) {
    const text = await textArea.evaluate((el) => (el.innerText || el.textContent || '').trim()).catch(() => '');
    if (xWeightedLength(text) <= X_MAX_CHARS && text) return safeText;
    safeText = trimToXLimit(safeText, Math.max(40, Math.min(X_SAFE_CHARS, xLength(safeText)) - 32));
    await insertXText(page, textArea, safeText);
    await page.waitForTimeout(500);
  }
  return safeText;
}

async function getXPostButton(page) {
  const locatorGroups = [
    page.locator('[role="dialog"] [role="button"]:has-text("Post"), [role="dialog"] button:has-text("Post")'),
    page.locator('[role="dialog"] [data-testid="tweetButton"], [role="dialog"] [aria-label="Post"][role="button"]'),
    page.locator('[data-testid="primaryColumn"] [data-testid="tweetButtonInline"], [data-testid="primaryColumn"] [data-testid="tweetButton"], [data-testid="primaryColumn"] [aria-label="Post"][role="button"]'),
    page.locator('main [data-testid="tweetButtonInline"], main [data-testid="tweetButton"], main [aria-label="Post"][role="button"]'),
    page.getByRole('button', { name: /^Post$/ }),
    page.locator('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], [aria-label="Post"][role="button"]'),
  ];

  let fallback = null;
  for (const buttons of locatorGroups) {
    const count = await buttons.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const btn = buttons.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const box = await btn.boundingBox().catch(() => null);
      if (!box || box.width < 20 || box.height < 20) continue;
      const label = await btn.getAttribute('aria-label').catch(() => '') || '';
      const text = await btn.innerText().catch(() => '') || '';
      const looksLikePost = /^post$/i.test(label.trim()) || /^post$/i.test(text.trim()) || /\bpost\b/i.test(text);
      if (looksLikePost) return btn;
      fallback = fallback || btn;
    }
  }
  return fallback || page.locator('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], [aria-label="Post"][role="button"]').last();
}

async function findXPostButtonCoords(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' && s.pointerEvents !== 'none';
    };
    const clickTarget = (el) => el.closest('button, [role="button"], [tabindex]') || el;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
    const scope = dialogs.length ? dialogs[dialogs.length - 1] : (document.querySelector('main') || document.body);
    const nodes = Array.from(scope.querySelectorAll('button, [role="button"], [tabindex], span, div'));
    const seen = new Set();
    const candidates = [];
    for (const node of nodes) {
      const rawText = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
      const label = (node.getAttribute('aria-label') || '').trim();
      if (!/^post$/i.test(rawText) && !/^post$/i.test(label)) continue;
      const target = clickTarget(node);
      if (!scope.contains(target) || seen.has(target) || !visible(target)) continue;
      seen.add(target);
      if (target.getAttribute('aria-disabled') === 'true' || target.hasAttribute('disabled')) continue;
      const rect = target.getBoundingClientRect();
      const x = Math.max(rect.left + 2, Math.min(rect.right - 2, rect.left + rect.width / 2));
      const y = Math.max(rect.top + 2, Math.min(rect.bottom - 2, rect.top + rect.height / 2));
      const topEl = document.elementFromPoint(x, y);
      if (topEl && !(target === topEl || target.contains(topEl) || topEl.contains(target))) continue;
      candidates.push({ x, y, right: rect.right, bottom: rect.bottom, text: rawText, label });
    }
    candidates.sort((a, b) => (b.bottom - a.bottom) || (b.right - a.right));
    return candidates[0] || null;
  }).catch(() => null);
}

async function waitForXPostButtonCoords(page, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const coords = await findXPostButtonCoords(page);
    if (coords) return coords;
    await page.waitForTimeout(500);
  }
  return null;
}

async function isXPostButtonEnabled(page) {
  const btn = await getXPostButton(page);
  if (!(await btn.isVisible().catch(() => false))) return false;
  const ariaDisabled = await btn.getAttribute('aria-disabled').catch(() => null);
  const disabled = await btn.isDisabled().catch(() => false);
  return ariaDisabled !== 'true' && !disabled;
}

async function getXMediaState(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const textbox = document.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]');
    const composer = textbox?.closest('[role="dialog"], form, main, [data-testid="primaryColumn"]') || document;
    const previews = Array.from(composer.querySelectorAll([
      '[data-testid="attachments"] img',
      '[data-testid="attachments"] video',
      '[data-testid="attachments"] [aria-label*="Image" i]',
      '[data-testid="attachments"] [aria-label*="Photo" i]',
      '[data-testid="attachments"] [style*="background-image"]',
      'img[src^="blob:"]',
      'video[src^="blob:"]',
      '[style*="blob:"]',
      '[role="img"][aria-label*="Image" i]',
    ].join(','))).filter(visible).length;
    const busy = Array.from(composer.querySelectorAll([
      '[role="progressbar"]',
      '[aria-busy="true"]',
      '[aria-label*="Uploading" i]',
      '[aria-label*="Processing" i]',
      '[data-testid*="progress" i]',
    ].join(','))).some(visible);
    const text = (textbox?.innerText || textbox?.textContent || '').slice(0, 400);
    const problem = Array.from(document.querySelectorAll('[data-testid="toast"], div[role="alert"], [aria-live="assertive"]'))
      .map((n) => (n.innerText || n.textContent || '').trim())
      .filter(Boolean)
      .join(' | ')
      .slice(0, 400);
    return { previews, busy, problem: [problem, text].filter(Boolean).join(' | ').slice(0, 700) };
  }).catch(() => ({ previews: 0, busy: false, problem: '' }));
}

async function waitForXMediaReady(page, expectedCount, timeout = 120000) {
  if (!expectedCount) return true;
  const deadline = Date.now() + timeout;
  let stableReadySince = 0;
  let lastState = null;
  while (Date.now() < deadline) {
    const state = await getXMediaState(page);
    lastState = state;
    if (/failed to upload|could not upload|unsupported|too large|try again/i.test(state.problem || '')) {
      throw new Error(`X rejected the media: ${state.problem}. Leaving source files for retry.`);
    }
    const postEnabled = await isXPostButtonEnabled(page).catch(() => false);
    const hasExpectedPreview = state.previews >= Math.min(expectedCount, X_MAX_IMAGES);
    // X often leaves a decorative/progress element visible after images already
    // have previews and the real Post button is enabled. Button-enabled + stable
    // expected previews is the strongest publish-ready signal.
    const readyEnough = postEnabled && hasExpectedPreview;
    if (readyEnough) {
      if (!stableReadySince) stableReadySince = Date.now();
      if (Date.now() - stableReadySince >= 2500) return true;
    } else {
      stableReadySince = 0;
    }
    await page.waitForTimeout(750);
  }
  const detail = lastState ? ` previews=${lastState.previews}, busy=${lastState.busy}, message=${lastState.problem || 'none'}` : '';
  throw new Error(`X media upload did not become publish-ready.${detail}. Leaving source files for retry.`);
}

async function verifyXComposerHasText(page, expectedText, timeout = 15000) {
  const expected = String(expectedText || '').trim();
  const expectedNeedle = normalizeForXMatch(expected).slice(0, Math.min(70, normalizeForXMatch(expected).length));
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const el = document.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]');
      const text = (el?.innerText || el?.textContent || '').trim();
      const composer = el?.closest('[role="dialog"], form, main, [data-testid="primaryColumn"]') || document;
      const enabledButton = Array.from(composer.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], [aria-label="Post"][role="button"], button, [role="button"]'))
        .some((btn) => {
          const r = btn.getBoundingClientRect();
          const s = window.getComputedStyle(btn);
          const label = (btn.getAttribute('aria-label') || '').trim();
          const body = (btn.innerText || btn.textContent || '').trim();
          return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
            && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled
            && (/^post$/i.test(label) || /^post$/i.test(body));
        });
      return { text, enabledButton };
    }).catch(() => ({ text: '', enabledButton: false }));
    last = state.text || '';
    const normalized = normalizeForXMatch(last);
    if (state.enabledButton && last && (!expectedNeedle || normalized.includes(expectedNeedle))) return true;
    await page.waitForTimeout(500);
  }
  throw new Error(`X composer text was not committed before posting (visible text: ${last.slice(0, 120) || 'empty'}). Leaving source files for retry.`);
}

async function waitForEnabledXPostButton(page, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let lastButton = null;
  while (Date.now() < deadline) {
    lastButton = await getXPostButton(page);
    if (await lastButton.isVisible().catch(() => false)) {
      const ariaDisabled = await lastButton.getAttribute('aria-disabled').catch(() => null);
      const disabled = await lastButton.isDisabled().catch(() => false);
      if (ariaDisabled !== 'true' && !disabled) return lastButton;
    }
    await page.waitForTimeout(500);
  }
  return lastButton || await getXPostButton(page);
}

async function clickXPostButton(page) {
  const btn = await waitForEnabledXPostButton(page, 45000);
  const ariaDisabled = await btn.getAttribute('aria-disabled').catch(() => null);
  const disabled = await btn.isDisabled().catch(() => false);
  let clicked = false;
  if (ariaDisabled !== 'true' && !disabled) {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    clicked = await btn.click({ timeout: 10000 }).then(() => true).catch(() => false);
  }
  if (!clicked) clicked = await btn.click({ force: true, timeout: 10000 }).then(() => true).catch(() => false);
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const candidates = Array.from(document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], [aria-label="Post"][role="button"]'));
      const btn = candidates.reverse().find((el) => visible(el) && el.getAttribute('aria-disabled') !== 'true');
      if (!btn) return false;
      btn.click();
      return true;
    }).catch(() => false);
  }
  if (!clicked) {
    const coords = await waitForXPostButtonCoords(page, 15000);
    if (coords) {
      await page.mouse.click(coords.x, coords.y);
      clicked = true;
    }
  }
  if (!clicked) throw new Error('Could not click the X Post button. Leaving source files for retry.');
}

async function visibleXProblemText(page) {
  return await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid="toast"], div[role="alert"], [aria-live="assertive"], [aria-live="polite"]'));
    return nodes.map((n) => (n.innerText || n.textContent || '').trim()).filter(Boolean).join(' | ').slice(0, 300);
  }).catch(() => '');
}

async function getXDiagnostics(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const buttons = Array.from(document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], [aria-label="Post"][role="button"], button, div[role="button"]'))
      .filter(visible)
      .map((el) => ({
        text: (el.innerText || el.textContent || '').trim().slice(0, 40),
        label: (el.getAttribute('aria-label') || '').slice(0, 80),
        testid: el.getAttribute('data-testid') || '',
        disabled: el.getAttribute('aria-disabled') || '',
      }))
      .filter((b) => /post/i.test(`${b.text} ${b.label} ${b.testid}`))
      .slice(0, 8);
    const composer = document.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]')?.closest('[role="dialog"], form, main, [data-testid="primaryColumn"]') || document;
    const previews = Array.from(composer.querySelectorAll('[data-testid="attachments"] img, [data-testid="attachments"] video, img[src^="blob:"], video[src^="blob:"], [style*="blob:"]')).filter(visible).length;
    const busy = Array.from(composer.querySelectorAll('[role="progressbar"], [aria-busy="true"], [aria-label*="Uploading" i], [aria-label*="Processing" i], [data-testid*="progress" i]')).filter(visible).length;
    const textbox = document.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]');
    const text = (textbox?.innerText || textbox?.textContent || '').trim().slice(0, 180);
    const message = Array.from(document.querySelectorAll('[data-testid="toast"], div[role="alert"], [aria-live="assertive"], [aria-live="polite"]'))
      .map((n) => (n.innerText || n.textContent || '').trim()).filter(Boolean).join(' | ').slice(0, 300);
    return { url: location.href, text, previews, busy, buttons, message };
  }).catch((e) => ({ error: e.message }));
}

async function extractXStatusUrl(page, expectedHandle = null) {
  const direct = normalizeXStatusUrl(page.url(), expectedHandle);
  if (direct) return direct;
  return await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('[data-testid="toast"] a[href*="/status/"], div[role="alert"] a[href*="/status/"], a[href*="/status/"]'));
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const absolute = href.startsWith('http') ? href : `https://x.com${href}`;
      const m = absolute.match(/https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/);
      if (m) return m[0].replace(/^https?:\/\/twitter\.com/i, 'https://x.com');
    }
    return null;
  }).then((url) => normalizeXStatusUrl(url, expectedHandle)).catch(() => null);
}

function xUrlFromCreateTweetPayload(payload, fallbackHandle) {
  const create = payload?.data?.create_tweet || payload?.data?.createTweet || payload?.create_tweet;
  const result = create?.tweet_results?.result || create?.tweet?.result || create?.tweet || payload?.data?.tweetResult?.result || null;
  const tweet = result?.tweet || result;
  const id = tweet?.rest_id || tweet?.legacy?.id_str || result?.rest_id || result?.legacy?.id_str;
  const userResult = tweet?.core?.user_results?.result || result?.core?.user_results?.result || tweet?.author?.legacy || null;
  const handle = userResult?.legacy?.screen_name || userResult?.screen_name || tweet?.legacy?.user_screen_name || fallbackHandle;
  if (id && handle) return `https://x.com/${handle}/status/${id}`;
  return null;
}

function waitForXCreateTweetResponse(page, fallbackHandle, timeout = 90000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      page.off('response', onResponse);
      resolve(value || null);
    };
    const timer = setTimeout(() => finish(null), timeout);
    const onResponse = async (response) => {
      const url = response.url();
      if (!/CreateTweet|graphql/i.test(url)) return;
      if (response.status() >= 400) return;
      try {
        const json = await response.json();
        const direct = xUrlFromCreateTweetPayload(json, fallbackHandle);
        if (direct) return finish(direct);
      } catch {}
    };
    page.on('response', onResponse);
  });
}

async function waitForCreateTweetUrl(promise, timeout = 30000) {
  return await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
  ]).catch(() => null);
}

async function waitForXPublishConfirmation(page, textArea, timeout = 45000, expectedHandle = null) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const statusUrl = await extractXStatusUrl(page, expectedHandle);
    if (statusUrl) return { confirmed: true, url: statusUrl };
    const stillVisible = await textArea.isVisible().catch(() => false);
    const toast = await visibleXProblemText(page);
    if (/exceeded the character limit|upgrade to premium to write longer posts/i.test(toast)) return { confirmed: false, error: toast };
    if (/failed|error|try again|could not|something went wrong/i.test(toast)) return { confirmed: false, error: toast };
    if (!stillVisible || /your post was sent|posted|view/i.test(toast)) return { confirmed: true, url: null };
    await page.waitForTimeout(750);
  }
  return { confirmed: false, error: '' };
}

async function fetchRecentXStatusUrlsFromProfile(page, handle, limit = 8, settleMs = 2500) {
  if (!handle) return [];
  await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
  const urls = await page.evaluate(({ h, maxItems }) => {
    const out = [];
    const seen = new Set();
    for (const article of Array.from(document.querySelectorAll('article'))) {
      for (const a of Array.from(article.querySelectorAll(`a[href*="/${h}/status/"]`))) {
        const href = a.getAttribute('href') || '';
        const absolute = href.startsWith('http') ? href : `https://x.com${href}`;
        const m = absolute.match(new RegExp(`https?://(?:x|twitter)\\.com/${h}/status/\\d+`, 'i'));
        if (!m || seen.has(m[0])) continue;
        seen.add(m[0]);
        out.push(m[0].replace(/^https?:\/\/twitter\.com/i, 'https://x.com'));
        if (out.length >= maxItems) return out;
      }
    }
    return out;
  }, { h: handle, maxItems: limit }).catch(() => []);
  return (Array.isArray(urls) ? urls : []).map((url) => normalizeXStatusUrl(url, handle)).filter(Boolean);
}

async function resolvePostedXUrl(page, handle, snippet, baselineUrls = []) {
  const direct = await extractXStatusUrl(page, handle);
  if (direct) return direct;
  if (!handle) return null;

  const baselineSet = new Set((Array.isArray(baselineUrls) ? baselineUrls : [])
    .map((url) => normalizeXStatusUrl(url, handle)).filter(Boolean));

  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500 + attempt * 1000);
      const href = await page.evaluate(({ h, text }) => {
        const norm = (value) => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();
        const wanted = norm(text).slice(0, 90);
        const articleLinks = [];
        for (const article of Array.from(document.querySelectorAll('article'))) {
          const body = norm(article.innerText || article.textContent || '');
          const score = wanted && body.includes(wanted.slice(0, Math.min(45, wanted.length))) ? 10 : 0;
          for (const a of Array.from(article.querySelectorAll(`a[href*="/${h}/status/"]`))) {
            articleLinks.push({ href: a.getAttribute('href') || '', score });
          }
        }
        const looseLinks = Array.from(document.querySelectorAll(`a[href*="/${h}/status/"]`)).map((a) => ({ href: a.getAttribute('href') || '', score: 0 }));
        const ordered = articleLinks.concat(looseLinks).sort((a, b) => b.score - a.score).map((x) => x.href);
        for (const href of ordered) {
          const absolute = href.startsWith('http') ? href : `https://x.com${href}`;
          const m = absolute.match(new RegExp(`https?://(?:x|twitter)\\.com/${h}/status/\\d+`));
          if (m) return m[0].replace(/^https?:\/\/twitter\.com/i, 'https://x.com');
        }
        return null;
      }, { h: handle, text: snippet || '' }).catch(() => null);
      const normalized = normalizeXStatusUrl(href, handle);
      if (normalized && !baselineSet.has(normalized)) return normalized;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
  } catch {}
  return null;
}

async function verifyPostedXUrlContainsText(page, url, expectedText) {
  const expected = normalizeForXMatch(expectedText);
  if (!expected || !url) return true;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const articleText = await page.evaluate(() => {
    const article = document.querySelector('article');
    return (article?.innerText || article?.textContent || '').trim().replace(/\s+/g, ' ');
  }).catch(() => '');
  const articleNorm = normalizeForXMatch(articleText);
  const needle = expected.slice(0, Math.min(35, expected.length));
  if (needle && !articleNorm.includes(needle)) {
    throw new Error('X published URL did not contain the intended text, so it is not treated as a successful post. Leaving source files for retry.');
  }
  return true;
}

async function uploadToX(imagePath, { description, hashtags = [] }, opts = {}) {
  const imageFiles = Array.isArray(imagePath) ? imagePath.filter(Boolean) : (imagePath ? [imagePath] : []);
  const xImageFiles = imageFiles.slice(0, X_MAX_IMAGES);
  if (imageFiles.length > X_MAX_IMAGES) {
    console.warn(`[X] X supports ${X_MAX_IMAGES} images per post; uploading first ${X_MAX_IMAGES} of ${imageFiles.length}.`);
  }
  const context = await launchPersistent('x', opts);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const homeUrl = page.url();
    if (homeUrl.includes('/login') || homeUrl.includes('/i/flow/login')) {
      throw new Error('X requires login. Use Prepare in Settings to log in once.');
    }
    const configuredHandle = handleFromXUrl(opts?.targetUrl);
    const actualHandle = await getMyHandle(page);
    let myHandle = actualHandle || configuredHandle;
    const baselineProfileStatusUrls = myHandle
      ? await fetchRecentXStatusUrlsFromProfile(page, myHandle, 8, 1500).catch(() => [])
      : [];

    // Always use the real composer URL. A configured account URL is a profile
    // reference for resolving the final link, not a place where posts can be made.
    await page.goto(X_COMPOSE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const url = page.url();
    if (url.includes('/login') || url.includes('/i/flow/login')) {
      throw new Error('X requires login. Use Prepare in Settings to log in once.');
    }

    const textArea = page.locator('div[role="textbox"][data-testid^="tweetTextarea"]').first();
    await textArea.waitFor({ state: 'visible', timeout: 30000 });

    const fullText = buildXPostText(description || '', hashtags);
    if (xWeightedLength(fullText) > X_MAX_CHARS) {
      throw new Error('X text could not be shortened under the 280 character limit. Leaving source files for retry.');
    }

    await insertXText(page, textArea, fullText);
    await page.waitForTimeout(1000);
    const postedText = await ensureXTextWithinLimit(page, textArea, fullText);

    if (xImageFiles.length) {
      const fileInput = page.locator('input[type="file"][accept*="image"], input[type="file"][accept*="video"], input[type="file"]').first();
      await fileInput.setInputFiles(xImageFiles).catch(async () => {
        const attach = page.locator('[data-testid="fileInput"], [aria-label*="media" i]').first();
        await attach.click({ trial: true }).catch(() => {});
        await fileInput.setInputFiles(xImageFiles);
      });
      await page.locator('[data-testid="attachments"] img, [data-testid="attachments"] video, [data-testid="attachments"] [style*="background-image"], img[src^="blob:"], video[src^="blob:"], [style*="blob:"]').first()
        .waitFor({ state: 'visible', timeout: 45000 });
      await waitForXMediaReady(page, xImageFiles.length, 120000);
    }

    const readComposerText = async () => await page.evaluate(() => {
      const el = document.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]');
      return ((el?.innerText || el?.textContent || '')).trim();
    }).catch(() => '');

    let confirmed = false;
    let publishedUrl = null;
    let lastError = '';
    for (let attempt = 0; attempt < 4 && !confirmed; attempt++) {
      // Guard: make sure the composer still contains our text. If the textbox
      // was cleared (e.g. by accidental focus loss or a popover), re-insert
      // it. Refuse to click Post on an empty textbox — that's how we ended up
      // posting media-only tweets previously.
      const currentText = await readComposerText();
      const currentNeedle = normalizeForXMatch(postedText).slice(0, Math.min(70, normalizeForXMatch(postedText).length));
      if (!currentText || (currentNeedle && !normalizeForXMatch(currentText).includes(currentNeedle))) {
        await textArea.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await insertXText(page, textArea, postedText);
        await page.waitForTimeout(800);
        const recheck = await readComposerText();
        if (!recheck || (currentNeedle && !normalizeForXMatch(recheck).includes(currentNeedle))) {
          throw new Error('X composer lost or changed its text before posting and could not be refilled. Leaving source files for retry.');
        }
      }

      await verifyXComposerHasText(page, postedText, 15000);
      const createTweetPromise = waitForXCreateTweetResponse(page, myHandle, 90000);
      await clickXPostButton(page);
      let result = await waitForXPublishConfirmation(page, textArea, 22000, myHandle);
      const responseUrl = await waitForCreateTweetUrl(createTweetPromise, result.confirmed ? 30000 : 5000);
      if (responseUrl && !myHandle) myHandle = handleFromXUrl(responseUrl) || myHandle;
      confirmed = result.confirmed;
      publishedUrl = responseUrl || result.url || publishedUrl;
      lastError = result.error || lastError;
      if (!confirmed) await page.waitForTimeout(1500);
    }

    if (!confirmed) {
      const errToast = lastError || await visibleXProblemText(page);
      console.error('[X] Publish diagnostics:', JSON.stringify(await getXDiagnostics(page)));
      throw new Error(`X did not confirm the post${errToast ? `: ${errToast.trim()}` : ''}. Leaving source files for retry.`);
    }

    const finalUrl = normalizeXStatusUrl(publishedUrl, myHandle)
      || (myHandle ? await resolvePostedXUrl(page, myHandle, postedText, baselineProfileStatusUrls) : null);
    if (!finalUrl || !/\/status\/\d+/.test(finalUrl)) {
      console.error('[X] Link resolution diagnostics:', JSON.stringify(await getXDiagnostics(page)));
      throw new Error('X post was submitted, but a new exact profile status URL could not be verified. Leaving source files for retry.');
    }
    await verifyPostedXUrlContainsText(page, finalUrl, postedText);
    return { url: finalUrl };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToX };
