// X (Twitter) post uploader using a persistent Chrome profile.
const { launchPersistent, safeClose } = require('./social-post-base');
const { dismissOverlayBlockingFlow } = require('./overlay-dismiss');

const X_COMPOSE_URL = 'https://x.com/compose/post';
const X_MAX_IMAGES = 4;
const X_MAX_CHARS = 280;
const X_SAFE_CHARS = 275;

function xLength(value) {
  return Array.from(String(value || '').replace(/\r\n/g, '\n')).length;
}

function trimToXLimit(value, limit = X_SAFE_CHARS) {
  const chars = Array.from(String(value || '').trim());
  if (chars.length <= limit) return chars.join('');
  const hard = chars.slice(0, Math.max(0, limit - 1)).join('');
  const soft = hard.replace(/\s+\S{0,24}$/, '').trim();
  return `${(soft.length >= 80 ? soft : hard).trim()}…`;
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
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  const tags = formatXHashtags(hashtags);
  const fittingTags = [];
  for (const tag of tags) {
    const candidateTags = fittingTags.concat(tag).join(' ');
    if (xLength(candidateTags) <= 80) fittingTags.push(tag);
  }
  let tagLine = fittingTags.join(' ');
  while (tagLine && xLength(tagLine) > X_SAFE_CHARS) {
    fittingTags.pop();
    tagLine = fittingTags.join(' ');
  }
  if (!desc) return trimToXLimit(tagLine, X_SAFE_CHARS);
  const separator = tagLine ? '\n\n' : '';
  const descLimit = X_SAFE_CHARS - xLength(separator) - xLength(tagLine);
  const safeDesc = trimToXLimit(desc, Math.max(40, descLimit));
  return trimToXLimit(`${safeDesc}${separator}${tagLine}`.trim(), X_SAFE_CHARS);
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

async function insertXText(page, textArea, text) {
  await textArea.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.evaluate(() => {
    const el = document.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]');
    if (!el) return;
    el.textContent = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null }));
  }).catch(() => {});
  const inserted = await page.evaluate((value) => {
    const el = document.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]');
    if (!el) return false;
    el.focus();
    const ok = document.execCommand('insertText', false, value || '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value || '' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return ok || Boolean((el.innerText || el.textContent || '').trim());
  }, text).catch(() => false);
  if (!inserted) await page.keyboard.insertText(text);
}

async function ensureXTextWithinLimit(page, textArea, desiredText) {
  let safeText = trimToXLimit(desiredText, X_SAFE_CHARS);
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await page.evaluate(() => {
      const el = document.querySelector('div[role="textbox"][data-testid^="tweetTextarea"]');
      const text = (el?.innerText || el?.textContent || '').trim();
      const problem = Array.from(document.querySelectorAll('[data-testid="toast"], div[role="alert"], [aria-live="assertive"], [aria-live="polite"]'))
        .map((n) => (n.innerText || n.textContent || '').trim())
        .filter(Boolean)
        .join(' | ')
        .slice(0, 500);
      return { text, problem };
    }).catch(() => ({ text: '', problem: '' }));
    const over = String(state.problem || '').match(/exceeded the character limit by\s+(\d+)/i);
    if (xLength(state.text) <= X_MAX_CHARS && !over && !/upgrade to premium to write longer posts|character limit/i.test(state.problem || '')) {
      return safeText;
    }
    const reduceBy = over ? Number(over[1]) + 8 : Math.max(8, xLength(state.text) - X_SAFE_CHARS + 8);
    safeText = trimToXLimit(safeText, Math.max(40, xLength(safeText) - reduceBy));
    await insertXText(page, textArea, safeText);
    await page.waitForTimeout(500);
  }
  return safeText;
}

async function getXPostButton(page) {
  const buttons = page.locator('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], [aria-label="Post"][role="button"]');
  const count = await buttons.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i--) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const label = await btn.getAttribute('aria-label').catch(() => '') || '';
    const text = await btn.innerText().catch(() => '') || '';
    if (/^post$/i.test(label.trim()) || /\bpost\b/i.test(text)) return btn;
  }
  return buttons.last();
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
    const text = (composer.innerText || composer.textContent || '').slice(0, 1000);
    const problem = Array.from(document.querySelectorAll('[data-testid="toast"], div[role="alert"], [aria-live="assertive"], [aria-live="polite"]'))
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
    const readyEnough = postEnabled && !state.busy && hasExpectedPreview;
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
  const btn = await waitForEnabledXPostButton(page);
  const ariaDisabled = await btn.getAttribute('aria-disabled').catch(() => null);
  const disabled = await btn.isDisabled().catch(() => false);
  if (ariaDisabled === 'true' || disabled) {
    throw new Error('X Post button never became enabled. Leaving source files for retry.');
  }

  await btn.scrollIntoViewIfNeeded().catch(() => {});
  let clicked = await btn.click({ timeout: 10000 }).then(() => true).catch(() => false);
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
  if (!clicked) throw new Error('Could not click the X Post button. Leaving source files for retry.');
}

async function visibleXProblemText(page) {
  return await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid="toast"], div[role="alert"], [aria-live="assertive"], [aria-live="polite"]'));
    return nodes.map((n) => (n.innerText || n.textContent || '').trim()).filter(Boolean).join(' | ').slice(0, 300);
  }).catch(() => '');
}

async function extractXStatusUrl(page) {
  const directMatch = page.url().match(/https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/);
  if (directMatch) return directMatch[0].replace(/^https?:\/\/twitter\.com/i, 'https://x.com');
  return await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('[data-testid="toast"] a[href*="/status/"], div[role="alert"] a[href*="/status/"], a[href*="/status/"]'));
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const absolute = href.startsWith('http') ? href : `https://x.com${href}`;
      const m = absolute.match(/https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/);
      if (m) return m[0].replace(/^https?:\/\/twitter\.com/i, 'https://x.com');
    }
    return null;
  }).catch(() => null);
}

async function waitForXPublishConfirmation(page, textArea, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const statusUrl = await extractXStatusUrl(page);
    if (statusUrl) return { confirmed: true, url: statusUrl };
    const stillVisible = await textArea.isVisible().catch(() => false);
    const toast = await visibleXProblemText(page);
    if (/failed|error|try again|could not|something went wrong/i.test(toast)) return { confirmed: false, error: toast };
    if (!stillVisible || /your post was sent|posted|view/i.test(toast)) return { confirmed: true, url: null };
    await page.waitForTimeout(750);
  }
  return { confirmed: false, error: '' };
}

async function resolvePostedXUrl(page, handle, snippet) {
  const direct = await extractXStatusUrl(page);
  if (direct) return direct;
  if (!handle) return page.url();

  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let attempt = 0; attempt < 8; attempt++) {
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
      if (href) return href;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
  } catch {}
  return `https://x.com/${handle}`;
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
    const myHandle = configuredHandle || await getMyHandle(page);

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
    if (xLength(fullText) > X_MAX_CHARS) {
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

    let confirmed = false;
    let publishedUrl = null;
    let lastError = '';
    for (let attempt = 0; attempt < 4 && !confirmed; attempt++) {
      await dismissOverlayBlockingFlow(page, { logPrefix: '[X]', clickBackground: false }).catch(() => {});
      await clickXPostButton(page);
      let result = await waitForXPublishConfirmation(page, textArea, 22000);
      confirmed = result.confirmed;
      publishedUrl = result.url || publishedUrl;
      lastError = result.error || lastError;
      if (!confirmed) {
        await textArea.click().catch(() => {});
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter').catch(() => {});
        result = await waitForXPublishConfirmation(page, textArea, 15000);
        confirmed = result.confirmed;
        publishedUrl = result.url || publishedUrl;
        lastError = result.error || lastError;
      }
      if (!confirmed) await page.waitForTimeout(1500);
    }

    if (!confirmed) {
      const errToast = lastError || await visibleXProblemText(page);
      throw new Error(`X did not confirm the post${errToast ? `: ${errToast.trim()}` : ''}. Leaving source files for retry.`);
    }

    const finalUrl = publishedUrl || await resolvePostedXUrl(page, myHandle, postedText);
    if (!/\/status\/\d+/.test(finalUrl)) {
      throw new Error('X post not visible on profile after publish. Treating as failure to avoid wrong link.');
    }
    return { url: finalUrl };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToX };
