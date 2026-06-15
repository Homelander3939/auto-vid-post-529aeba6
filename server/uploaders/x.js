// X (Twitter) post uploader using a persistent Chrome profile.
const { launchPersistent, safeClose } = require('./social-post-base');
const { dismissOverlayBlockingFlow } = require('./overlay-dismiss');

const X_COMPOSE_URL = 'https://x.com/compose/post';

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
    const composer = textbox?.closest('[role="dialog"], form, [data-testid="primaryColumn"]') || document;
    const attachments = composer.querySelector('[data-testid="attachments"]') || composer;
    const previews = Array.from(attachments.querySelectorAll('img[src^="blob:"], video, [data-testid="attachments"] img')).filter(visible).length;
    const busy = Array.from(attachments.querySelectorAll('[role="progressbar"], [aria-valuenow], [aria-busy="true"], [aria-label*="Uploading" i], [aria-label*="Processing" i]')).some(visible);
    return { previews, busy };
  }).catch(() => ({ previews: 0, busy: false }));
}

async function waitForXMediaReady(page, expectedCount, timeout = 90000) {
  if (!expectedCount) return true;
  const deadline = Date.now() + timeout;
  let enabledWithPreviewSince = 0;
  while (Date.now() < deadline) {
    const state = await getXMediaState(page);
    const postEnabled = await isXPostButtonEnabled(page).catch(() => false);
    if (state.previews >= expectedCount && !state.busy && postEnabled) return true;
    if (state.previews >= expectedCount && postEnabled) {
      if (!enabledWithPreviewSince) enabledWithPreviewSince = Date.now();
      if (Date.now() - enabledWithPreviewSince > 5000) return true;
    } else {
      enabledWithPreviewSince = 0;
    }
    await page.waitForTimeout(750);
  }
  return false;
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

async function waitForXPublishConfirmation(page, textArea, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const directUrl = page.url().match(/https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/);
    if (directUrl) return true;
    const stillVisible = await textArea.isVisible().catch(() => false);
    const toast = await visibleXProblemText(page);
    if (!stillVisible || /your post was sent|posted|view/i.test(toast)) return true;
    await page.waitForTimeout(750);
  }
  return false;
}

async function resolvePostedXUrl(page, handle, snippet) {
  const cur = page.url();
  const directMatch = cur.match(/https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/);
  if (directMatch) return directMatch[0].replace(/^https?:\/\/twitter\.com/i, 'https://x.com');
  if (!handle) return cur;

  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let attempt = 0; attempt < 6; attempt++) {
      await page.waitForTimeout(3000 + attempt * 1000);
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
    await textArea.click();

    const fullText = hashtags.length
      ? `${description || ''}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : (description || '');

    await page.keyboard.insertText(fullText);
    await page.waitForTimeout(1000);

    if (imageFiles.length) {
      const fileInput = page.locator('input[type="file"][accept*="image"], input[type="file"][accept*="video"], input[type="file"]').first();
      await fileInput.setInputFiles(imageFiles).catch(async () => {
        const attach = page.locator('[data-testid="fileInput"], [aria-label*="media" i]').first();
        await attach.click({ trial: true }).catch(() => {});
        await fileInput.setInputFiles(imageFiles);
      });
      await page.locator('[data-testid="attachments"] img, img[src^="blob:"], video').first()
        .waitFor({ state: 'visible', timeout: 30000 });
      const mediaReady = await waitForXMediaReady(page, imageFiles.length, 120000);
      if (!mediaReady) throw new Error('X media upload did not finish or Post button stayed disabled. Leaving source files for retry.');
    }

    let confirmed = false;
    for (let attempt = 0; attempt < 4 && !confirmed; attempt++) {
      await dismissOverlayBlockingFlow(page, { logPrefix: '[X]', clickBackground: false }).catch(() => {});
      await clickXPostButton(page);
      confirmed = await waitForXPublishConfirmation(page, textArea, 18000);
      if (!confirmed) {
        await textArea.click().catch(() => {});
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter').catch(() => {});
        confirmed = await waitForXPublishConfirmation(page, textArea, 12000);
      }
      if (!confirmed) await page.waitForTimeout(1500);
    }

    if (!confirmed) {
      const errToast = await visibleXProblemText(page);
      throw new Error(`X did not confirm the post${errToast ? `: ${errToast.trim()}` : ''}. Leaving source files for retry.`);
    }

    const finalUrl = await resolvePostedXUrl(page, myHandle, fullText);
    if (!/\/status\/\d+/.test(finalUrl)) {
      throw new Error('X post not visible on profile after publish. Treating as failure to avoid wrong link.');
    }
    return { url: finalUrl };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToX };
