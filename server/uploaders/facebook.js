// Facebook post uploader using a persistent Chrome profile.
const { launchPersistent, safeClose } = require('./social-post-base');

function normalizeFacebookPermalink(raw) {
  if (!raw) return null;
  let url;
  try { url = new URL(raw, 'https://www.facebook.com'); } catch { return null; }
  if (/(^|\.)facebook\.com$/i.test(url.hostname) && /^\/plugins\/post\.php$/i.test(url.pathname)) {
    const embedded = url.searchParams.get('href');
    if (embedded) return normalizeFacebookPermalink(embedded);
  }
  if (!/(^|\.)(facebook|fb)\.com$/i.test(url.hostname)) return null;
  url.hash = '';

  const path = url.pathname.replace(/\/$/, '');
  const story = url.searchParams.get('story_fbid') || url.searchParams.get('fbid');
  const owner = url.searchParams.get('id');
  const origin = 'https://www.facebook.com';
  const combinedPath = path.match(/^\/(\d+)_(\d+)$/);
  if (combinedPath) return `${origin}/permalink.php?story_fbid=${encodeURIComponent(combinedPath[2])}&id=${encodeURIComponent(combinedPath[1])}`;
  if (story && owner) return `${origin}/permalink.php?story_fbid=${encodeURIComponent(story)}&id=${encodeURIComponent(owner)}`;
  if (/\/(?:posts|videos|reel|watch|photo|photos)\//i.test(path)
    || /^\/(?:photo|watch|reel)$/i.test(path)
    || /\/[^/]+\/permalink\//i.test(path)
    || /\/groups\/[^/]+\/(?:posts|permalink)\//i.test(path)
    || /\/permalink\.php$/i.test(path)
    || /\/story\.php$/i.test(path)
    || /\/photo\.php$/i.test(path)
    || /\/(?:share|shareable)\/(?:p|r|v|post|video)\//i.test(path)
    || /\/shares?\//i.test(path)) {
    const keep = new URLSearchParams();
    for (const key of ['story_fbid', 'fbid', 'id']) {
      const value = url.searchParams.get(key);
      if (value) keep.set(key, value);
    }
    const query = keep.toString();
    return `${origin}${path}${query ? `?${query}` : ''}`;
  }
  return null;
}

function normalizePostText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#\w+/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFacebookPermalinkFromText(raw) {
  const text = String(raw || '');
  const candidates = [];
  for (const match of text.matchAll(/https?:\\?\/\\?\/(?:www\.|web\.|m\.)?(?:facebook|fb)\.com[^\s"'<>\\)]+/gi)) {
    candidates.push(match[0].replace(/\\\//g, '/').replace(/\\u0025/g, '%'));
  }
  for (const encoded of text.matchAll(/https?%3A%2F%2F(?:www\.|web\.|m\.)?(?:facebook|fb)\.com[^\s"'<>\\)]+/gi)) {
    try { candidates.push(decodeURIComponent(encoded[0])); } catch {}
  }
  for (const candidate of candidates) {
    const normalized = normalizeFacebookPermalink(candidate);
    if (normalized) return normalized;
  }
  return null;
}

async function facebookComposerOpen(page, dialogSel = 'div[role="dialog"]') {
  return await page.evaluate((selector) => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 80 && r.height > 40 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const isComposerTextbox = (el) => {
      const root = el.closest('[role="dialog"], form, main, [role="main"]') || document;
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.innerText || ''} ${root.innerText || ''}`;
      if (/search|comment|reply|message/i.test(label)) return false;
      return /what.*mind|say something|write something|create post|post text/i.test(label)
        || (el.getAttribute('role') === 'textbox' && el.getAttribute('contenteditable') === 'true');
    };
    return Array.from(document.querySelectorAll(selector)).some((dialog) => visible(dialog)
      && Array.from(dialog.querySelectorAll('div[role="textbox"][contenteditable="true"]')).some((el) => visible(el) && isComposerTextbox(el)));
  }, dialogSel).catch(() => false);
}

async function closeFacebookNonComposerDialogs(page) {
  const closed = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 40 && r.height > 40 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(visible);
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const dialog = dialogs[i];
      const text = (dialog.innerText || '').trim();
      if (/create post|what.*mind|write something/i.test(text)) continue;
      const close = Array.from(dialog.querySelectorAll('[aria-label="Close"], [aria-label="Close dialog"], [role="button"], button'))
        .find((el) => visible(el) && /^(close|×|x)$/i.test((el.getAttribute('aria-label') || el.innerText || '').trim()));
      if (close) {
        close.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
  if (closed) await page.waitForTimeout(900);
  return closed;
}

async function clickFacebookModernComposerEntry(page) {
  const phrases = ['on your mind', 'write something', 'create post', 'create a post', 'start a post', 'say something'];

  // Strategy A: DOM scan — find any visible element whose text or aria-label matches,
  // walk up to nearest clickable ancestor, click via JS to bypass overlay issues.
  for (let attempt = 0; attempt < 4; attempt++) {
    const clicked = await page.evaluate((phrases) => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 20 && r.height > 12 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const matches = (txt) => {
        const t = (txt || '').toLowerCase();
        if (!t) return false;
        if (/comment|search|message|reply|caption|story|reel/i.test(t)) return false;
        return phrases.some((p) => t.includes(p));
      };
      const all = Array.from(document.querySelectorAll('div, span, a, button, [role="button"], [aria-label]'));
      const candidates = [];
      for (const el of all) {
        if (!isVisible(el)) continue;
        const aria = el.getAttribute('aria-label') || '';
        const txt = el.innerText || '';
        if (!matches(aria) && !matches(txt)) continue;
        // prefer small leaf-ish elements (avoid huge containers)
        if ((el.innerText || '').length > 120) continue;
        candidates.push(el);
      }
      // sort by vertical position so we hit the page's own composer prompt (top of feed)
      candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      for (const el of candidates) {
        // walk up to nearest clickable ancestor
        let target = el;
        for (let i = 0; i < 6 && target; i++) {
          const role = target.getAttribute && target.getAttribute('role');
          if (role === 'button' || target.tagName === 'BUTTON' || target.tagName === 'A' || target.onclick) break;
          if (target.parentElement) target = target.parentElement; else break;
        }
        try {
          target.scrollIntoView({ block: 'center' });
          const r = target.getBoundingClientRect();
          // dispatch real mouse events at element center
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
          }
          return true;
        } catch (e) { /* try next */ }
      }
      return false;
    }, phrases).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(2000);
      if (await facebookComposerOpen(page)) return true;
    }

    // Strategy B: Playwright getByText fallback with real mouse click at coordinates
    for (const phrase of phrases) {
      const loc = page.getByText(new RegExp(phrase, 'i')).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        const box = await loc.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 80 }).catch(() => {});
          await page.waitForTimeout(2000);
          if (await facebookComposerOpen(page)) return true;
        }
      }
    }

    // Strategy C: keyboard shortcut "p" opens Create Post on facebook.com pages
    await page.keyboard.press('p').catch(() => {});
    await page.waitForTimeout(1500);
    if (await facebookComposerOpen(page)) return true;

    await closeFacebookNonComposerDialogs(page);
    await page.waitForTimeout(800);
  }

  return false;
}

async function insertFacebookTextIntoActiveComposer(page, fullText) {
  if (!fullText) return;
  const textbox = page.locator('div[role="dialog"] div[role="textbox"][contenteditable="true"]').first();
  await textbox.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await textbox.click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.insertText(fullText).catch(async () => {
    await page.keyboard.type(fullText, { delay: 10 });
  });
  await page.waitForTimeout(1000);
}

async function clickFacebookNextSteps(page) {
  for (let step = 0; step < 3; step++) {
    const nextBtn = page.locator('div[role="dialog"] [role="button"]:has-text("Next"), div[role="dialog"] button:has-text("Next")').last();
    if (await nextBtn.isVisible().catch(() => false)) {
      const disabled = await nextBtn.getAttribute('aria-disabled').catch(() => 'false');
      if (disabled !== 'true') {
        await nextBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    } else {
      break;
    }
  }
}

async function attachImagesToFacebookComposer(page, imageFiles) {
  if (!imageFiles.length) return;
  const attachBtn = page.locator('div[role="dialog"] [aria-label="Photo/video"], div[role="dialog"] [aria-label*="Photo" i]').first();
  await attachBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
  await attachBtn.click({ force: true }).catch(() => {});
  const chooser = await chooserPromise;

  if (chooser) {
    await chooser.setFiles(imageFiles);
  } else {
    const input = page.locator('div[role="dialog"] input[type="file"]').last();
    await input.setInputFiles(imageFiles, { timeout: 10000 }).catch(() => {});
  }

  await page.waitForTimeout(4000 + (imageFiles.length * 1500));
  await clickFacebookNextSteps(page);
}

async function clickFacebookVerifiedPostButton(page) {
  const postBtns = page.locator('div[role="dialog"] [role="button"], div[role="dialog"] button').filter({ hasText: /^Post$/i });
  const count = await postBtns.count().catch(() => 0);

  for (let i = count - 1; i >= 0; i--) {
    const btn = postBtns.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      for (let wait = 0; wait < 20; wait++) {
        const disabled = await btn.getAttribute('aria-disabled').catch(() => 'false');
        if (disabled !== 'true') break;
        await page.waitForTimeout(500);
      }
      await btn.click({ force: true }).catch(() => {});
      return true;
    }
  }

  const fb = page.getByRole('button', { name: 'Post', exact: true }).last();
  if (await fb.isVisible().catch(() => false)) {
    await fb.click({ force: true }).catch(() => {});
    return true;
  }

  throw new Error('Could not click the Facebook Post button. Leaving source files for retry.');
}

async function dismissFacebookPostPublishPrompts(page) {
  for (let i = 0; i < 3; i++) {
    const closed = await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 40 && r.height > 30 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      let found = false;
      for (const dialog of dialogs) {
        if (!visible(dialog)) continue;
        if (/whatsapp|make it easier|boost post|invite friends|turn on notifications/i.test(dialog.innerText || '')) {
          const btns = Array.from(dialog.querySelectorAll('[role="button"], button, a'));
          const closeBtn = btns.find((button) => /not now|skip|done|close|×|x/i.test(button.innerText || button.getAttribute('aria-label') || ''));
          if (closeBtn) {
            closeBtn.click();
            found = true;
          }
        }
      }
      return found;
    }).catch(() => false);
    if (!closed) break;
    await page.waitForTimeout(1500);
  }
}

async function copyFacebookLinkViaShareDialog(page, snippet = '') {
  const wanted = normalizePostText(snippet).slice(0, 45);
  const articles = page.locator('[role="article"]');
  const count = Math.min(await articles.count().catch(() => 0), 5);

  for (let i = 0; i < count; i++) {
    const article = articles.nth(i);
    const body = normalizePostText(await article.innerText({ timeout: 3000 }).catch(() => ''));
    if (wanted && i > 0 && !body.includes(wanted.slice(0, Math.min(28, wanted.length))) && !/just now|now|\b\d+\s*(m|min|mins|minute|minutes)\b/i.test(body)) continue;

    const shareBtn = article.locator('[role="button"]:has-text("Share"), [aria-label="Share"], span:has-text("Share")').last();
    if (!(await shareBtn.isVisible().catch(() => false))) continue;

    await shareBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    await shareBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2000);

    const copyBtn = page.locator('div[role="dialog"] [role="button"]:has-text("Copy link"), div[role="dialog"] span:has-text("Copy link"), [role="menuitem"]:has-text("Copy link")').last();
    if (await copyBtn.isVisible().catch(() => false)) {
      await copyBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);

      const clipped = await page.evaluate(() => navigator.clipboard?.readText?.()).catch(() => null);
      const normalized = normalizeFacebookPermalink(clipped) || extractFacebookPermalinkFromText(clipped);
      if (normalized) return normalized;
    }

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
  return null;
}

async function uploadToFacebook(imagePath, { description, hashtags = [] }, opts = {}) {
  const imageFiles = Array.isArray(imagePath) ? imagePath.filter(Boolean) : (imagePath ? [imagePath] : []);
  const context = await launchPersistent('facebook', opts);
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.facebook.com' }).catch(() => {});
    const page = context.pages()[0] || await context.newPage();
    const targetUrl = (opts && opts.targetUrl && /^https?:\/\//i.test(opts.targetUrl)) ? opts.targetUrl : 'https://www.facebook.com/';

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3500);

    if (page.url().includes('/login')) {
      throw new Error('Facebook requires login. Use Prepare in Settings to log in once.');
    }

    const fullText = hashtags.length ? `${description}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}` : (description || '');
    const dialogSel = 'div[role="dialog"]';

    await closeFacebookNonComposerDialogs(page);
    if (!(await facebookComposerOpen(page, dialogSel))) {
      const opened = await clickFacebookModernComposerEntry(page);
      if (!opened) throw new Error('Could not open the Facebook Create Post composer. Leaving source files for retry.');
      await page.waitForTimeout(2000);
    }

    await insertFacebookTextIntoActiveComposer(page, fullText);
    await page.waitForTimeout(400);

    if (imageFiles.length) {
      await attachImagesToFacebookComposer(page, imageFiles);
    }

    await insertFacebookTextIntoActiveComposer(page, fullText);

    console.log('[Facebook] Clicking Post button...');
    await clickFacebookVerifiedPostButton(page);

    console.log('[Facebook] Waiting for upload circle to finish...');
    await page.waitForFunction(() => {
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
      if (dialogs.length === 0) return true;
      for (const dialog of dialogs) {
        const text = (dialog.innerText || '').toLowerCase();
        if (text.includes('whatsapp') || text.includes('boost post') || text.includes('make it easier') || text.includes('invite friends')) return true;
      }
      return false;
    }, { timeout: 180000 }).catch(() => {});

    await dismissFacebookPostPublishPrompts(page);

    console.log('[Facebook] Navigating to Page to copy link...');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);

    await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
    await page.waitForTimeout(3000);

    const finalUrl = await copyFacebookLinkViaShareDialog(page, fullText);

    if (!finalUrl) {
      throw new Error('Facebook post was submitted, but could not copy the link from the Share button. Leaving source files for retry.');
    }

    console.log(`[Facebook] Successfully posted and copied link: ${finalUrl}`);
    return { url: finalUrl };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToFacebook };