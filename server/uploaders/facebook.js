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

function extractFacebookPermalinkFromPayload(payload) {
  const seen = new Set();
  const visit = (value) => {
    if (value == null) return null;
    if (typeof value === 'string') {
      return normalizeFacebookPermalink(value) || extractFacebookPermalinkFromText(value);
    }
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    for (const key of ['permalink_url', 'permalinkUrl', 'shareable_url', 'shareableUrl', 'wwwURL', 'www_url', 'url', 'href', 'share_uri', 'shareURI']) {
      const found = visit(value[key]);
      if (found) return found;
    }
    const combinedPostId = String(value.post_id || value.postID || value.legacy_story_hideable_id || '').match(/^(\d+)_(\d+)$/);
    if (combinedPostId) {
      return `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(combinedPostId[2])}&id=${encodeURIComponent(combinedPostId[1])}`;
    }
    const storyId = value.story_fbid || value.fbid || value.post_id || value.postID || value.legacy_story_hideable_id;
    const ownerId = value.actor_id || value.page_id || value.profile_id || value.owner_id || value.id;
    if (storyId && ownerId && String(storyId) !== String(ownerId)) {
      return `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(String(storyId))}&id=${encodeURIComponent(String(ownerId))}`;
    }
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      const found = visit(item);
      if (found) return found;
    }
    return null;
  };
  return visit(payload);
}

async function getActiveFacebookDialogIndex(page) {
  const clickedFallback = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 80 && r.height > 80 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const candidates = dialogs
      .map((el, index) => {
        const z = Number.parseInt(window.getComputedStyle(el).zIndex || '0', 10);
        const r = el.getBoundingClientRect();
        return { index, z: Number.isFinite(z) ? z : 0, top: r.top, left: r.left };
      })
      .filter((item) => visible(dialogs[item.index]));
    if (!candidates.length) return -1;
    candidates.sort((a, b) => (a.z - b.z) || (a.index - b.index) || (a.top - b.top) || (a.left - b.left));
    return candidates[candidates.length - 1].index;
  }).catch(() => -1);
}

async function getActiveFacebookDialogLocator(page) {
  const dialogs = page.locator('div[role="dialog"]');
  const count = await dialogs.count().catch(() => 0);
  if (!count) return dialogs.first();
  const activeIndex = await getActiveFacebookDialogIndex(page);
  const safeIndex = activeIndex >= 0 && activeIndex < count ? activeIndex : count - 1;
  return dialogs.nth(safeIndex);
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
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('aria-placeholder') || ''} ${el.getAttribute('placeholder') || ''} ${el.innerText || el.textContent || ''} ${root.innerText || root.textContent || ''}`;
      if (/search|comment|reply|message/i.test(label)) return false;
      if (/cover photo|profile picture|avatar|photo viewer|view photo|edit photo details|add a caption/i.test(label) && !/create post|what.*mind|write something|say something/i.test(label)) return false;
      return /what.*mind|say something|write something|create post|post text|compose/i.test(label)
        || (el.getAttribute('role') === 'textbox' && el.getAttribute('contenteditable') === 'true' && /\b(post|publish|share)\b/i.test(label));
    };
    const hasDialogComposer = Array.from(document.querySelectorAll(selector)).some((dialog) => visible(dialog)
      && Array.from(dialog.querySelectorAll('div[role="textbox"][contenteditable="true"]')).some((el) => visible(el) && isComposerTextbox(el)));
    if (hasDialogComposer) return true;
    return Array.from(document.querySelectorAll('main div[role="textbox"][contenteditable="true"], form textarea, main textarea'))
      .some((el) => visible(el) && isComposerTextbox(el));
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
      const text = (dialog.innerText || dialog.textContent || '').trim();
      const looksLikeComposer = /create post|what.*mind|write something|say something|post text|add to your post/i.test(text);
      const looksLikeWrongPhotoDialog = /cover photo|profile picture|avatar|photo viewer|view photo|edit photo details|make cover photo|update cover photo/i.test(text);
      if (!looksLikeWrongPhotoDialog || looksLikeComposer) continue;
      const close = Array.from(dialog.querySelectorAll('[aria-label="Close"], [aria-label="Close dialog"], [role="button"], button'))
        .find((el) => visible(el) && /^(close|×|x)$/i.test((el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim()));
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

async function clickFacebookModernComposerEntry(page, needsMedia = false) {
  const locators = [
    page.locator('main [role="button"]:has-text("on your mind"), main [aria-label*="What" i]:has-text("mind")').first(),
    page.locator('main [role="button"]:has-text("Create post"), main [aria-label*="Create post" i], a[href*="/composer/"]').first(),
    page.locator('main [role="button"]:has-text("Write something"), main [aria-label*="Write something" i], main [role="button"]:has-text("Say something")').first(),
  ];
  for (const entry of locators) {
    if (!(await entry.isVisible().catch(() => false))) continue;
    await entry.scrollIntoViewIfNeeded().catch(() => {});
    await entry.click({ force: true, timeout: 8000 }).catch(async () => { await entry.click({ timeout: 8000 }).catch(() => {}); });
    await page.waitForTimeout(1500);
    if (await facebookComposerOpen(page)) return true;
    await closeFacebookNonComposerDialogs(page);
    const menuPost = page.locator('[role="menuitem"]:has-text("Create post"), [role="menuitem"]:has-text("Post"), [role="menu"] [role="button"]:has-text("Create post")').first();
    if (await menuPost.isVisible().catch(() => false)) {
      await menuPost.click({ force: true }).catch(async () => { await menuPost.click().catch(() => {}); });
      await page.waitForTimeout(1500);
      if (await facebookComposerOpen(page)) return true;
    }
  }
  return await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 20 && r.height > 16 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const main = document.querySelector('main, [role="main"]') || document.body;
    const nodes = Array.from(main.querySelectorAll('a[href], [role="button"], button'));
    const scored = nodes.map((el) => {
      if (!visible(el)) return null;
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('href') || '').trim();
      const context = `${text} ${el.closest('[aria-label], section, article, div')?.getAttribute?.('aria-label') || ''}`;
      let score = 0;
      if (/create post|write something|what.*mind|say something|composer/i.test(context)) score += 100;
      if (/create$/i.test(text)) score += 15;
      // Never use global photo/media/profile/cover controls to open the composer;
      // those are what open page cover/photo editors instead of a post dialog.
      if (/cover|profile picture|avatar|photo viewer|view photo|photos?\b|video|image|media|story|reel|room|live|advertise|promote|search|comment|reply|message/i.test(context)) score -= 140;
      return { el, score };
    }).filter((item) => item && item.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return false;
    scored[0].el.click();
    return true;
  }).catch(() => false);
  if (!clickedFallback) return false;
  await page.waitForTimeout(1500);
  if (!(await facebookComposerOpen(page))) await closeFacebookNonComposerDialogs(page);
  if (await facebookComposerOpen(page)) return true;
  return false;
}

async function clickFacebookNextSteps(page, maxSteps = 4, expectedText = '') {
  for (let step = 0; step < maxSteps; step++) {
    const dialog = await getActiveFacebookDialogLocator(page);
    if (!(await dialog.isVisible().catch(() => false))) return step > 0;
    const postVisible = await dialog.locator('[aria-label="Post"][role="button"], [aria-label="Publish"][role="button"], [aria-label="Share"][role="button"], div[role="button"]:has-text("Post"):not(:has-text("Postpone")), div[role="button"]:has-text("Publish"), div[role="button"]:has-text("Share")').first().isVisible().catch(() => false);
    if (postVisible) return step > 0;
    const expected = normalizePostText(expectedText).slice(0, 45);
    if (expected) {
      const activeText = normalizePostText(await dialog.locator('div[role="textbox"][contenteditable="true"]').first().innerText({ timeout: 1000 }).catch(() => ''));
      if (activeText.includes(expected)) return step > 0;
    }
    const canAdvance = await dialog.evaluate((root, expectedNeedle) => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const normalize = (value) => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      const text = (root.innerText || root.textContent || '').trim();
      const hasExpectedText = expectedNeedle && normalize(text).includes(expectedNeedle);
      if (hasExpectedText) return false;
      const hasMedia = Array.from(root.querySelectorAll('img[src^="blob:"], video[src^="blob:"], [style*="blob:"], [aria-label*="Photo" i] img, [aria-label*="image" i] img')).some(visible);
      const looksLikeMediaEditor = /edit|crop|move|photo|image|media|preview|layout|caption|next|done|continue/i.test(text);
      const looksLikeFinalComposer = /what.*mind|create post|say something|write something/i.test(text);
      return hasMedia || (looksLikeMediaEditor && !looksLikeFinalComposer);
    }, expected).catch(() => true);
    if (!canAdvance) return step > 0;
    const buttons = dialog.locator('[role="button"], button');
    const count = await buttons.count().catch(() => 0);
    let clicked = false;
    for (let i = count - 1; i >= 0; i--) {
      const btn = buttons.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const disabled = await btn.getAttribute('aria-disabled').catch(() => null);
      if (disabled === 'true') continue;
      const label = (await btn.getAttribute('aria-label').catch(() => '') || '').trim();
      const body = (await btn.innerText().catch(() => '') || '').trim();
      const name = label || body;
      if (!/^(next|done|continue|save|add)$/i.test(name)) continue;
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      clicked = await btn.click({ timeout: 8000 }).then(() => true).catch(() => false);
      if (!clicked) clicked = await btn.click({ force: true, timeout: 8000 }).then(() => true).catch(() => false);
      if (clicked) break;
    }
    if (!clicked) return step > 0;
    await page.waitForTimeout(2500);
  }
  return true;
}

async function insertFacebookTextIntoActiveComposer(page, fullText, { onlyIfMissing = false } = {}) {
  const expected = normalizePostText(fullText).slice(0, 90);
  const textbox = await getFacebookTextComposerLocator(page);
  await textbox.waitFor({ state: 'visible', timeout: 20000 });
  const current = await textbox.innerText({ timeout: 3000 }).catch(() => '');
  const normalizedCurrent = normalizePostText(current);
  if (onlyIfMissing && expected && normalizedCurrent.includes(expected.slice(0, Math.min(45, expected.length)))) return;
  await textbox.click({ timeout: 8000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  if (fullText) {
    await page.keyboard.insertText(fullText).catch(async () => {
      await page.keyboard.type(fullText, { delay: 10 });
    });
  }
  await page.waitForTimeout(900);
  const written = await facebookTextExistsInComposer(page, fullText);
  if (expected && !written) {
    const inserted = await textbox.evaluate((el, value) => {
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false, null);
      const ok = document.execCommand('insertText', false, value || '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value || '' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return ok || Boolean((el.innerText || el.textContent || '').trim());
    }, fullText).catch(() => false);
    await page.waitForTimeout(600);
    if (!inserted || !(await facebookTextExistsInComposer(page, fullText))) {
      throw new Error('Facebook composer text could not be inserted. Leaving source files for retry.');
    }
  }
}

async function getFacebookComposerDialogIndex(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 80 && r.height > 80 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const candidates = dialogs.map((dialog, index) => {
      const dialogText = (dialog.innerText || dialog.textContent || '').trim();
      const textboxes = Array.from(dialog.querySelectorAll('div[role="textbox"][contenteditable="true"]')).filter(visible).length;
      const hasPost = Array.from(dialog.querySelectorAll('[role="button"], button')).some((btn) => {
        const label = (btn.getAttribute('aria-label') || '').trim();
        const body = (btn.innerText || btn.textContent || '').trim();
        return visible(btn) && !/postpone/i.test(`${label} ${body}`) && /^(post|publish|share)$/i.test(label || body);
      });
      const looksLikeComposer = /create post|what.*mind|write something|say something|post text|add to your post/i.test(dialogText);
      const looksLikePhotoViewer = /cover photo|profile picture|avatar|photo viewer|view photo|edit photo details|make cover photo|update cover photo/i.test(dialogText);
      const z = Number.parseInt(window.getComputedStyle(dialog).zIndex || '0', 10);
      return { index, textboxes, hasPost, looksLikeComposer, looksLikePhotoViewer, z: Number.isFinite(z) ? z : 0 };
    }).filter((item) => visible(dialogs[item.index]) && (item.hasPost || (item.textboxes > 0 && item.looksLikeComposer)) && !item.looksLikePhotoViewer);
    if (!candidates.length) return -1;
    candidates.sort((a, b) => ((a.hasPost ? 1 : 0) - (b.hasPost ? 1 : 0)) || (a.textboxes - b.textboxes) || (a.z - b.z) || (a.index - b.index));
    return candidates[candidates.length - 1].index;
  }).catch(() => -1);
}

async function getFacebookComposerDialogLocator(page) {
  const dialogs = page.locator('div[role="dialog"]');
  const count = await dialogs.count().catch(() => 0);
  if (!count) return dialogs.first();
  const composerIndex = await getFacebookComposerDialogIndex(page);
  if (composerIndex >= 0 && composerIndex < count) return dialogs.nth(composerIndex);
  return getActiveFacebookDialogLocator(page);
}

async function getFacebookTextComposerLocator(page) {
  const picked = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 40 && r.height > 18 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const candidates = [];
    dialogs.forEach((dialog, dialogIndex) => {
      if (!visible(dialog)) return;
      const z = Number.parseInt(window.getComputedStyle(dialog).zIndex || '0', 10);
      const buttons = Array.from(dialog.querySelectorAll('[role="button"], button'));
      const hasPost = buttons.some((btn) => {
        const label = (btn.getAttribute('aria-label') || '').trim();
        const body = (btn.innerText || btn.textContent || '').trim();
        return visible(btn) && !/postpone/i.test(`${label} ${body}`) && /^(post|publish|share)$/i.test(label || body);
      });
      const dialogText = (dialog.innerText || dialog.textContent || '').trim();
      const looksLikeComposer = /create post|what.*mind|write something|say something|post text|add to your post/i.test(dialogText);
      const looksLikePhotoViewer = /cover photo|profile picture|avatar|photo viewer|view photo|edit photo details|make cover photo|update cover photo/i.test(dialogText);
      if (looksLikePhotoViewer && !looksLikeComposer) return;
      const textboxes = Array.from(dialog.querySelectorAll('div[role="textbox"][contenteditable="true"]'));
      textboxes.forEach((textbox, textboxIndex) => {
        if (!visible(textbox)) return;
        const label = `${textbox.getAttribute('aria-label') || ''} ${textbox.getAttribute('aria-placeholder') || ''} ${textbox.getAttribute('placeholder') || ''}`;
        const combined = `${label} ${dialogText}`;
        if (/search|comment|reply|message/i.test(label)) return;
        if (!hasPost && !looksLikeComposer) return;
        const rect = textbox.getBoundingClientRect();
        let score = 0;
        if (hasPost) score += 80;
        if (/what.*mind|say something|write something|create post|post text|caption/i.test(combined)) score += 35;
        if (rect.width > 240) score += 15;
        if (rect.height > 35) score += 10;
        if (/add a caption|media|edit photo|crop|move/i.test(combined) && !hasPost) score -= 50;
        candidates.push({ dialogIndex, textboxIndex, score, z: Number.isFinite(z) ? z : 0 });
      });
    });
    candidates.sort((a, b) => (a.score - b.score) || (a.z - b.z) || (a.dialogIndex - b.dialogIndex) || (a.textboxIndex - b.textboxIndex));
    return candidates[candidates.length - 1] || null;
  }).catch(() => null);

  if (picked) {
    return page.locator('div[role="dialog"]').nth(picked.dialogIndex).locator('div[role="textbox"][contenteditable="true"]').nth(picked.textboxIndex);
  }
  const inlinePicked = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 80 && r.height > 18 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const textboxes = Array.from(document.querySelectorAll('main div[role="textbox"][contenteditable="true"], form div[role="textbox"][contenteditable="true"], main textarea, form textarea'));
    const candidates = textboxes.map((el, index) => {
      if (!visible(el)) return null;
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('aria-placeholder') || ''} ${el.getAttribute('placeholder') || ''} ${el.closest('form, main, [role="main"]')?.innerText || ''}`;
      if (/search|comment|reply|message/i.test(label)) return null;
      const rect = el.getBoundingClientRect();
      let score = rect.width > 260 ? 20 : 0;
      if (/what.*mind|say something|write something|create post|post text|caption|compose/i.test(label)) score += 50;
      if (el.closest('form')) score += 10;
      return { index, score, top: rect.top };
    }).filter(Boolean).sort((a, b) => (a.score - b.score) || (b.top - a.top));
    return candidates.length ? candidates[candidates.length - 1].index : -1;
  }).catch(() => -1);
  if (inlinePicked >= 0) {
    return page.locator('main div[role="textbox"][contenteditable="true"], form div[role="textbox"][contenteditable="true"], main textarea, form textarea').nth(inlinePicked);
  }
  const dialog = await getFacebookComposerDialogLocator(page);
  return dialog.locator('div[role="textbox"][contenteditable="true"]').first();
}

async function facebookTextExistsInComposer(page, expectedText) {
  const expected = normalizePostText(expectedText).slice(0, 90);
  if (!expected) return true;
  const wanted = expected.slice(0, Math.min(45, expected.length));
  return await page.evaluate((needle) => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 40 && r.height > 18 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(visible);
    for (const dialog of dialogs) {
      const dialogText = (dialog.innerText || dialog.textContent || '').trim();
      const looksLikeComposer = /create post|what.*mind|write something|say something|post text|add to your post/i.test(dialogText);
      if (/cover photo|profile picture|avatar|photo viewer|view photo|edit photo details|make cover photo|update cover photo/i.test(dialogText) && !looksLikeComposer) continue;
      const hasPost = Array.from(dialog.querySelectorAll('[role="button"], button')).some((btn) => {
        const label = (btn.getAttribute('aria-label') || '').trim();
        const body = (btn.innerText || btn.textContent || '').trim();
        return visible(btn) && /^(post|publish|share)$/i.test(label || body);
      });
      for (const textbox of Array.from(dialog.querySelectorAll('div[role="textbox"][contenteditable="true"]')).filter(visible)) {
        const text = normalize(textbox.innerText || textbox.textContent || '');
        if (text.includes(needle) && (hasPost || textbox.getBoundingClientRect().width > 200)) return true;
      }
    }
    return false;
  }, wanted).catch(() => false);
}

async function getFacebookReadyComposerIndex(page, expectedText, expectedMediaCount = 0) {
  const expected = normalizePostText(expectedText).slice(0, 90);
  const wanted = expected.slice(0, Math.min(45, expected.length));
  return await page.evaluate(({ needle, mediaCount }) => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const candidates = [];
    dialogs.forEach((dialog, index) => {
      if (!visible(dialog)) return;
      const dialogText = (dialog.innerText || dialog.textContent || '').trim();
      const looksLikeComposer = /create post|what.*mind|write something|say something|post text|add to your post/i.test(dialogText);
      if (/cover photo|profile picture|avatar|photo viewer|view photo|edit photo details|make cover photo|update cover photo/i.test(dialogText) && !looksLikeComposer) return;
      const hasPost = Array.from(dialog.querySelectorAll('[role="button"], button')).some((btn) => {
        const label = (btn.getAttribute('aria-label') || '').trim();
        const body = (btn.innerText || btn.textContent || '').trim();
        return visible(btn) && btn.getAttribute('aria-disabled') !== 'true' && !/postpone/i.test(`${label} ${body}`) && /^(post|publish|share)$/i.test(label || body);
      });
      if (!hasPost) return;
      const textOk = !needle || Array.from(dialog.querySelectorAll('div[role="textbox"][contenteditable="true"]')).some((textbox) => visible(textbox) && normalize(textbox.innerText || textbox.textContent || '').includes(needle));
      if (!textOk) return;
      const previews = Array.from(dialog.querySelectorAll('img[src^="blob:"], video[src^="blob:"], [style*="blob:"], [aria-label*="Photo" i] img, [aria-label*="image" i] img, [class*="x168nmei"] img')).filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.height > 40;
      }).length;
      if (mediaCount > 0 && previews < 1) return;
      const z = Number.parseInt(window.getComputedStyle(dialog).zIndex || '0', 10);
      candidates.push({ index, previews, z: Number.isFinite(z) ? z : 0 });
    });
    candidates.sort((a, b) => (a.z - b.z) || (a.index - b.index) || (a.previews - b.previews));
    return candidates.length ? candidates[candidates.length - 1].index : -1;
  }, { needle: wanted, mediaCount: expectedMediaCount }).catch(() => -1);
}

async function waitForFacebookReadyComposer(page, expectedText, expectedMediaCount = 0, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const readyIndex = await getFacebookReadyComposerIndex(page, expectedText, expectedMediaCount);
    if (readyIndex >= 0) return readyIndex;
    if (expectedText && !(await facebookTextExistsInComposer(page, expectedText))) {
      await insertFacebookTextIntoActiveComposer(page, expectedText, { onlyIfMissing: true }).catch(() => {});
    }
    await page.waitForTimeout(1000);
  }
  console.error('[Facebook] Ready composer wait diagnostics:', JSON.stringify(await getFacebookDiagnostics(page)));
  throw new Error('Facebook final composer never became ready with both text and media. Leaving source files for retry.');
}

async function getFacebookDiagnostics(page, dialogSel = 'div[role="dialog"]') {
  return await page.evaluate((selector) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const dialog = document.querySelector(selector);
    const root = dialog || document;
    const buttons = Array.from(root.querySelectorAll('[role="button"], button'))
      .filter(visible)
      .map((el) => ({
        text: (el.innerText || el.textContent || '').trim().slice(0, 50),
        label: (el.getAttribute('aria-label') || '').slice(0, 80),
        disabled: el.getAttribute('aria-disabled') || '',
      }))
      .filter((b) => /post|next|publish|share/i.test(`${b.text} ${b.label}`))
      .slice(0, 10);
    const previews = Array.from(root.querySelectorAll('img[src^="blob:"], video[src^="blob:"], [style*="blob:"], [aria-label*="Photo" i] img, [aria-label*="image" i] img, [class*="x168nmei"] img')).filter(visible).length;
    const busy = Array.from(root.querySelectorAll('[role="progressbar"], [aria-busy="true"], [aria-label*="Uploading" i], [aria-label*="Processing" i]')).filter(visible).length;
    const textbox = root.querySelector('div[role="textbox"][contenteditable="true"]');
    return {
      url: location.href,
      dialogVisible: Boolean(dialog && visible(dialog)),
      text: (textbox?.innerText || textbox?.textContent || '').trim().slice(0, 180),
      previews,
      busy,
      buttons,
      message: (root.innerText || root.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 350),
    };
  }, dialogSel).catch((e) => ({ error: e.message }));
}

function waitForFacebookCreatePostResponse(page, timeout = 90000) {
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
      if (!/(\/api\/graphql|\/graphql|composer|ufi\/post|create)/i.test(url)) return;
      if (response.status() >= 400) return;
      try {
        const body = await response.text();
        const fromText = extractFacebookPermalinkFromText(body);
        if (fromText) return finish(fromText);
        const cleaned = body.replace(/^for \(;;\);/, '').trim();
        const chunks = cleaned.split(/\n+/).filter(Boolean);
        for (const chunk of chunks) {
          try {
            const found = extractFacebookPermalinkFromPayload(JSON.parse(chunk));
            if (found) return finish(found);
          } catch {}
        }
      } catch {}
    };
    page.on('response', onResponse);
  });
}

async function waitForFacebookMediaReady(page, dialogSel, expectedCount, timeout = 120000) {
  if (!expectedCount) return;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const activeIndex = await getActiveFacebookDialogIndex(page);
    const state = await page.evaluate(({ selector, dialogIndex }) => {
      const dialogs = Array.from(document.querySelectorAll(selector));
      const dialog = dialogIndex >= 0 ? dialogs[dialogIndex] : (dialogs[dialogs.length - 1] || document);
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const previews = Array.from(dialog.querySelectorAll('img[src^="blob:"], video[src^="blob:"], [style*="blob:"], [aria-label*="Photo" i] img, [aria-label*="image" i] img, [class*="x168nmei"] img')).filter(visible).length;
      const busy = Array.from(dialog.querySelectorAll('[role="progressbar"], [aria-busy="true"], [aria-label*="Uploading" i], [aria-label*="Processing" i]')).some(visible);
      const text = (dialog.innerText || dialog.textContent || '').slice(0, 1000);
      return { previews, busy, text };
    }, { selector: dialogSel, dialogIndex: activeIndex }).catch(() => ({ previews: 0, busy: false, text: '' }));
    if (/couldn't upload|could not upload|failed to upload|unsupported|try again/i.test(state.text || '')) {
      throw new Error(`Facebook rejected the media: ${state.text}. Leaving source files for retry.`);
    }
    if (!state.busy && (state.previews >= expectedCount || state.previews > 0)) return;
    await page.waitForTimeout(750);
  }
  throw new Error('Facebook media upload did not finish. Leaving source files for retry.');
}

async function getFacebookPostButton(page, dialogSel) {
  const activeDialog = await getFacebookComposerDialogLocator(page);
  return getFacebookPostButtonInDialog(page, activeDialog, dialogSel);
}

async function getFacebookPostButtonInDialog(page, activeDialog, dialogSel, { allowGlobalFallback = true } = {}) {
  const groups = [
    activeDialog.locator('[aria-label="Post"][role="button"]'),
    activeDialog.locator('div[role="button"]:has-text("Post"):not(:has-text("Postpone"))'),
    activeDialog.locator('[aria-label="Publish"][role="button"], div[role="button"]:has-text("Publish")'),
    activeDialog.locator('[aria-label="Share"][role="button"], div[role="button"]:has-text("Share")'),
  ];
  if (allowGlobalFallback) groups.push(page.getByRole('button', { name: /^(Post|Publish|Share)$/ }));
  let fallback = null;
  for (const buttons of groups) {
    const count = await buttons.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const btn = buttons.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const box = await btn.boundingBox().catch(() => null);
      if (!box || box.width < 20 || box.height < 20) continue;
      const label = await btn.getAttribute('aria-label').catch(() => '') || '';
      const text = await btn.innerText().catch(() => '') || '';
      if (/postpone/i.test(`${label} ${text}`)) continue;
      if (/^(post|publish|share)$/i.test(label.trim()) || /^(post|publish|share)$/i.test(text.trim()) || /\b(post|publish|share)\b/i.test(text)) return btn;
      fallback = fallback || btn;
    }
  }
  if (fallback) return fallback;
  return allowGlobalFallback
    ? page.locator(`${dialogSel} [aria-label="Post"][role="button"], ${dialogSel} [aria-label="Publish"][role="button"], ${dialogSel} [aria-label="Share"][role="button"], ${dialogSel} div[role="button"]:has-text("Post"):not(:has-text("Postpone")), ${dialogSel} div[role="button"]:has-text("Publish"), ${dialogSel} div[role="button"]:has-text("Share")`).last()
    : activeDialog.locator('[aria-label="Post"][role="button"], div[role="button"]:has-text("Post"):not(:has-text("Postpone")), [aria-label="Publish"][role="button"], div[role="button"]:has-text("Publish"), [aria-label="Share"][role="button"], div[role="button"]:has-text("Share")').last();
}

async function clickFacebookPostButton(page, dialogSel) {
  const postBtn = await getFacebookPostButton(page, dialogSel);
  await postBtn.waitFor({ state: 'visible', timeout: 20000 });
  for (let i = 0; i < 45; i++) {
    const disabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
    if (disabled !== 'true') break;
    await page.waitForTimeout(500);
  }
  const stillDisabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
  if (stillDisabled === 'true') {
    console.error('[Facebook] Disabled Post diagnostics:', JSON.stringify(await getFacebookDiagnostics(page, dialogSel)));
    throw new Error('Facebook Post button stayed disabled. Leaving source files for retry.');
  }
  await postBtn.scrollIntoViewIfNeeded().catch(() => {});
  let clicked = await postBtn.click({ timeout: 10000 }).then(() => true).catch(() => false);
  if (!clicked) clicked = await postBtn.click({ force: true, timeout: 10000 }).then(() => true).catch(() => false);
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(visible);
      const scored = dialogs.map((dialog, index) => {
        const textboxes = Array.from(dialog.querySelectorAll('div[role="textbox"][contenteditable="true"]')).filter(visible).length;
        const hasPost = Array.from(dialog.querySelectorAll('[role="button"], button')).some((btn) => {
          const label = (btn.getAttribute('aria-label') || '').trim();
          const body = (btn.innerText || btn.textContent || '').trim();
          return visible(btn) && !/postpone/i.test(`${label} ${body}`) && /^(post|publish|share)$/i.test(label || body);
        });
        const z = Number.parseInt(window.getComputedStyle(dialog).zIndex || '0', 10);
        return { dialog, index, textboxes, hasPost, z: Number.isFinite(z) ? z : 0 };
      }).filter((item) => item.textboxes > 0 || item.hasPost)
        .sort((a, b) => ((a.hasPost ? 1 : 0) - (b.hasPost ? 1 : 0)) || (a.textboxes - b.textboxes) || (a.z - b.z) || (a.index - b.index));
      const dialog = scored.length ? scored[scored.length - 1].dialog : (dialogs[dialogs.length - 1] || document);
      const buttons = Array.from(dialog.querySelectorAll('[role="button"], button'));
      const btn = buttons.reverse().find((el) => visible(el)
        && el.getAttribute('aria-disabled') !== 'true'
        && /^(post|publish|share)$/i.test(((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim())));
      if (!btn) return false;
      btn.click();
      return true;
    }).catch(() => false);
  }
  if (!clicked) {
    console.error('[Facebook] Click Post diagnostics:', JSON.stringify(await getFacebookDiagnostics(page, dialogSel)));
    throw new Error('Could not click the Facebook Post button. Leaving source files for retry.');
  }
}

async function clickFacebookVerifiedPostButton(page, dialogSel, expectedText, expectedMediaCount = 0) {
  const readyIndex = await getFacebookReadyComposerIndex(page, expectedText, expectedMediaCount);
  if (readyIndex < 0) {
    console.error('[Facebook] Ready composer diagnostics:', JSON.stringify(await getFacebookDiagnostics(page, dialogSel)));
    throw new Error('Facebook final composer did not contain both text and media before posting. Leaving source files for retry.');
  }
  const dialog = page.locator('div[role="dialog"]').nth(readyIndex);
  const postBtn = await getFacebookPostButtonInDialog(page, dialog, dialogSel, { allowGlobalFallback: false });
  await postBtn.waitFor({ state: 'visible', timeout: 20000 });
  for (let i = 0; i < 45; i++) {
    const disabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
    if (disabled !== 'true') break;
    await page.waitForTimeout(500);
  }
  if ((await postBtn.getAttribute('aria-disabled').catch(() => null)) === 'true') {
    console.error('[Facebook] Disabled verified Post diagnostics:', JSON.stringify(await getFacebookDiagnostics(page, dialogSel)));
    throw new Error('Facebook Post button stayed disabled. Leaving source files for retry.');
  }
  await postBtn.scrollIntoViewIfNeeded().catch(() => {});
  let clicked = await postBtn.click({ timeout: 10000 }).then(() => true).catch(() => false);
  if (!clicked) clicked = await postBtn.click({ force: true, timeout: 10000 }).then(() => true).catch(() => false);
  if (!clicked) {
    console.error('[Facebook] Click verified Post diagnostics:', JSON.stringify(await getFacebookDiagnostics(page, dialogSel)));
    throw new Error('Could not click the verified Facebook Post button. Leaving source files for retry.');
  }
}

async function verifyFacebookComposerHasText(page, dialogSel, expectedText) {
  const expected = normalizePostText(expectedText).slice(0, 90);
  const exists = await facebookTextExistsInComposer(page, expectedText);
  if (expected && !exists) {
    throw new Error('Facebook composer text was not present before posting. Leaving source files for retry.');
  }
}

async function verifyFacebookComposerHasMedia(page, expectedCount) {
  if (!expectedCount) return;
  const dialog = await getFacebookComposerDialogLocator(page);
  const previews = await dialog.evaluate((root) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 40 && r.height > 40 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    return Array.from(root.querySelectorAll('img[src^="blob:"], video[src^="blob:"], [style*="blob:"], [aria-label*="Photo" i] img, [aria-label*="image" i] img, [class*="x168nmei"] img')).filter(visible).length;
  }).catch(() => 0);
  if (previews < Math.min(expectedCount, 1)) {
    throw new Error('Facebook media preview was not present in the final composer before posting. Leaving source files for retry.');
  }
}

async function attachImagesToFacebookComposer(page, imageFiles, dialogSel, expectedText = '') {
  if (!imageFiles.length) return;
  const expectedCount = imageFiles.length;
  let attached = false;
  const composerIndex = await getFacebookComposerDialogIndex(page);
  const directInputHandle = await page.evaluateHandle((dialogIndex) => {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const root = dialogIndex >= 0 ? dialogs[dialogIndex] : dialogs[dialogs.length - 1];
    if (!root) return null;
    const inputs = Array.from(root.querySelectorAll('input[type="file"]'))
      .filter((el) => !el.disabled && /image|photo|video|media|^$/i.test(el.getAttribute('accept') || ''));
    return inputs[inputs.length - 1] || null;
  }, composerIndex).catch(() => null);
  const directInput = directInputHandle ? directInputHandle.asElement() : null;
  if (directInput) {
    attached = await directInput.setInputFiles(imageFiles, { timeout: 15000 }).then(() => true).catch(() => false);
  }

  if (!attached) {
    const dialog = await getFacebookComposerDialogLocator(page);
    const attachBtn = dialog.locator('[aria-label="Photo/video"], [aria-label*="Photo" i], [aria-label*="image" i]').first();
    await attachBtn.waitFor({ state: 'visible', timeout: 15000 });
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
    await attachBtn.click({ force: true }).catch(async () => { await attachBtn.click(); });
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(imageFiles);
      attached = true;
    } else {
      await page.waitForTimeout(1000);
      const activeIndex = await getFacebookComposerDialogIndex(page);
      const inputHandle = await page.evaluateHandle((dialogIndex) => {
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
        const root = dialogIndex >= 0 ? dialogs[dialogIndex] : dialogs[dialogs.length - 1];
        if (!root) return null;
        const inputs = Array.from(root.querySelectorAll('input[type="file"]')).filter((el) => !el.disabled);
        return inputs[inputs.length - 1] || null;
      }, activeIndex).catch(() => null);
      const input = inputHandle ? inputHandle.asElement() : null;
      attached = input ? await input.setInputFiles(imageFiles, { timeout: 15000 }).then(() => true).catch(() => false) : false;
    }
  }

  if (!attached) throw new Error('Facebook image picker opened but no controllable file input was found. Leaving source files for retry.');
  await waitForFacebookMediaReady(page, dialogSel, expectedCount, 180000);
  await clickFacebookNextSteps(page, 5, expectedText);
  await page.waitForTimeout(1500);
  await waitForFacebookMediaReady(page, dialogSel, expectedCount, 60000);
}

async function waitForFacebookComposerToFinish(page, dialogSel, timeout = 420000) {
  const deadline = Date.now() + timeout;
  let lastState = null;
  while (Date.now() < deadline) {
    const activeIndex = await getActiveFacebookDialogIndex(page);
    const state = await page.evaluate(({ selector, dialogIndex }) => {
      const dialogs = Array.from(document.querySelectorAll(selector));
      const dialog = dialogIndex >= 0 ? dialogs[dialogIndex] : (dialogs[dialogs.length - 1] || null);
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const root = dialog || document;
      const text = (root.innerText || root.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 1000);
      const busy = Array.from(root.querySelectorAll('[role="progressbar"], [aria-busy="true"], [aria-label*="Posting" i], [aria-label*="Uploading" i], [aria-label*="Processing" i]')).some(visible);
      const postButtonVisible = Array.from(root.querySelectorAll('[role="button"], button')).some((btn) => {
        const label = (btn.getAttribute('aria-label') || '').trim();
        const body = (btn.innerText || btn.textContent || '').trim();
        return visible(btn) && /^(post|publish|share)$/i.test(label || body);
      });
      return { dialogVisible: visible(dialog), busy, postButtonVisible, text };
    }, { selector: dialogSel, dialogIndex: activeIndex }).catch(() => ({ dialogVisible: false, busy: false, postButtonVisible: false, text: '' }));
    lastState = state;
    if (/couldn.?t post|could not post|failed to post|try again|something went wrong/i.test(state.text || '')) {
      throw new Error(`Facebook rejected the post: ${state.text.slice(0, 260)}. Leaving source files for retry.`);
    }
    if (!state.dialogVisible) return true;
    if (!state.busy && !state.postButtonVisible && /posted|shared|published|view post|see post/i.test(state.text || '')) return true;
    await page.waitForTimeout(3000);
  }
  console.error('[Facebook] Composer still open diagnostics:', JSON.stringify(await getFacebookDiagnostics(page, dialogSel)));
  throw new Error(`Facebook did not confirm the post after waiting ${Math.round(timeout / 60000)} minutes${lastState?.text ? `: ${lastState.text.slice(0, 220)}` : ''}. Leaving source files for retry.`);
}

async function waitForFacebookPublishConfirmation(page, dialogSel, expectedText = '', timeout = 420000) {
  const deadline = Date.now() + timeout;
  const expected = normalizePostText(expectedText).slice(0, 70);
  let idleReadySince = 0;
  while (Date.now() < deadline) {
    const direct = normalizeFacebookPermalink(page.url());
    if (direct) return { confirmed: true, url: direct };
    const activeIndex = await getActiveFacebookDialogIndex(page);
    const state = await page.evaluate(({ selector, dialogIndex, needle }) => {
      const dialogs = Array.from(document.querySelectorAll(selector));
      const dialog = dialogIndex >= 0 ? dialogs[dialogIndex] : (dialogs[dialogs.length - 1] || null);
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const normalize = (value) => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      const root = dialog || document;
      const text = (root.innerText || root.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 1200);
      const busy = Array.from(root.querySelectorAll('[role="progressbar"], [aria-busy="true"], [aria-label*="Posting" i], [aria-label*="Uploading" i], [aria-label*="Processing" i]')).some(visible);
      const postButtonVisible = Array.from(root.querySelectorAll('[role="button"], button')).some((btn) => {
        const label = (btn.getAttribute('aria-label') || '').trim();
        const body = (btn.innerText || btn.textContent || '').trim();
        return visible(btn) && btn.getAttribute('aria-disabled') !== 'true' && !/postpone/i.test(`${label} ${body}`) && /^(post|publish|share)$/i.test(label || body);
      });
      const seePostVisible = Array.from(root.querySelectorAll('a, [role="button"], button')).some((el) => visible(el) && /^(see|view) post$/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()));
      return { dialogVisible: visible(dialog), busy, postButtonVisible, seePostVisible, hasExpectedText: needle ? normalize(text).includes(needle) : true, text };
    }, { selector: dialogSel, dialogIndex: activeIndex, needle: expected }).catch(() => ({ dialogVisible: false, busy: false, postButtonVisible: false, seePostVisible: false, hasExpectedText: true, text: '' }));
    if (/couldn.?t post|could not post|failed to post|try again|something went wrong/i.test(state.text || '')) {
      return { confirmed: false, error: state.text.slice(0, 300) };
    }
    if (!state.dialogVisible || state.seePostVisible || (!state.busy && !state.postButtonVisible && /posted|shared|published|view post|see post/i.test(state.text || ''))) {
      return { confirmed: true, url: null };
    }
    if (state.postButtonVisible && state.hasExpectedText && !state.busy) {
      if (!idleReadySince) idleReadySince = Date.now();
      if (Date.now() - idleReadySince > 15000) return { confirmed: false, retry: true, error: 'Facebook Post button stayed open after click.' };
    } else {
      idleReadySince = 0;
    }
    await page.waitForTimeout(1000);
  }
  return { confirmed: false, retry: true, error: `Facebook did not confirm the post after waiting ${Math.round(timeout / 60000)} minutes.` };
}

async function extractFacebookPermalinkFromArticles(page, snippet = '') {
  return await page.evaluate((rawSnippet) => {
    const normalizeUrl = (raw) => {
      try {
        const u = new URL(raw, 'https://www.facebook.com');
        if (/(^|\.)facebook\.com$/i.test(u.hostname) && /^\/plugins\/post\.php$/i.test(u.pathname)) {
          const embedded = u.searchParams.get('href');
          if (embedded) return normalizeUrl(embedded);
        }
        if (!/(^|\.)(facebook|fb)\.com$/i.test(u.hostname)) return null;
        const p = u.pathname.replace(/\/$/, '');
        const story = u.searchParams.get('story_fbid') || u.searchParams.get('fbid');
        const id = u.searchParams.get('id');
        const origin = 'https://www.facebook.com';
        const combinedPath = p.match(/^\/(\d+)_(\d+)$/);
        if (combinedPath) return `${origin}/permalink.php?story_fbid=${encodeURIComponent(combinedPath[2])}&id=${encodeURIComponent(combinedPath[1])}`;
        if (story && id) return `${origin}/permalink.php?story_fbid=${encodeURIComponent(story)}&id=${encodeURIComponent(id)}`;
        if (/\/(?:posts|videos|reel|watch|photo|photos)\//i.test(p) || /^\/(?:photo|watch|reel)$/i.test(p) || /\/[^/]+\/permalink\//i.test(p) || /\/groups\/[^/]+\/(?:posts|permalink)\//i.test(p) || /\/permalink\.php$/i.test(p) || /\/story\.php$/i.test(p) || /\/photo\.php$/i.test(p) || /\/(?:share|shareable)\/(?:p|r|v|post|video)\//i.test(p) || /\/shares?\//i.test(p)) {
          const keep = new URLSearchParams();
          for (const key of ['story_fbid', 'fbid', 'id']) {
            const value = u.searchParams.get(key);
            if (value) keep.set(key, value);
          }
          const query = keep.toString();
          return `${origin}${p}${query ? `?${query}` : ''}`;
        }
      } catch {}
      return null;
    };
    const normalizeText = (value) => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const wanted = normalizeText(rawSnippet).slice(0, 70);
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    const scored = (articles.length ? articles : [document.body]).slice(0, 8).map((article, index) => {
      const body = normalizeText(article.innerText || article.textContent || '');
      const fresh = /\b(just now|\d+\s*(m|min|mins|minute|minutes)|now)\b/i.test(article.innerText || '');
      const textMatch = wanted && body.includes(wanted.slice(0, Math.min(35, wanted.length)));
      return { article, score: (textMatch ? 20 : 0) + (fresh ? 15 : 0) - index };
    }).sort((a, b) => b.score - a.score);

    for (const { article } of scored) {
      const anchors = Array.from(article.querySelectorAll('a[href]'));
      const direct = anchors
        .map((a) => ({ href: a.getAttribute('href') || '', text: (a.innerText || a.textContent || a.getAttribute('aria-label') || '').trim() }))
        .filter((a) => !/comment|reaction|profile.php\?id=|\/friends\//i.test(a.href))
        .sort((a, b) => (/just now|\d+\s*(m|min)|hour|yesterday|at/i.test(b.text) ? 1 : 0) - (/just now|\d+\s*(m|min)|hour|yesterday|at/i.test(a.text) ? 1 : 0));
      for (const a of direct) {
        const out = normalizeUrl(a.href);
        if (out) return out;
      }
    }
    return null;
  }, snippet).catch(() => null);
}

async function openFreshFacebookArticleAndReadUrl(page, snippet = '', baselineUrls = []) {
  const baselineSet = new Set((Array.isArray(baselineUrls) ? baselineUrls : []).map(normalizeFacebookPermalink).filter(Boolean));
  for (let attempt = 0; attempt < 6; attempt++) {
    const clicked = await page.evaluate((rawSnippet) => {
      const normalizeText = (value) => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
      const wanted = normalizeText(rawSnippet).slice(0, 70);
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const articles = Array.from(document.querySelectorAll('[role="article"]')).slice(0, 8);
      const scored = articles.map((article, index) => {
        const text = article.innerText || article.textContent || '';
        const body = normalizeText(text);
        const textMatch = wanted && body.includes(wanted.slice(0, Math.min(35, wanted.length)));
        const fresh = /\b(just now|now|\d+\s*(m|min|mins|minute|minutes))\b/i.test(text);
        return { article, score: (textMatch ? 20 : 0) + (fresh ? 8 : 0) - index };
      }).filter((item) => item.score > -4).sort((a, b) => b.score - a.score);
      for (const { article } of scored) {
        const anchors = Array.from(article.querySelectorAll('a[href]')).filter(visible);
        const preferred = anchors.find((a) => /story_fbid=|fbid=|\/posts\/|\/permalink\.php|\/story\.php|\/photo\.php|\/share\/|\/shares?\//i.test(a.getAttribute('href') || ''))
          || anchors.find((a) => /just now|now|\d+\s*(m|min|mins|minute|minutes)|hour|yesterday|at/i.test((a.innerText || a.textContent || a.getAttribute('aria-label') || '').trim()));
        if (preferred) {
          preferred.scrollIntoView({ block: 'center', inline: 'center' });
          preferred.click();
          return true;
        }
      }
      window.scrollBy(0, Math.round(window.innerHeight * 0.8));
      return false;
    }, snippet).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(3500);
      const direct = normalizeFacebookPermalink(page.url());
      if (direct && !baselineSet.has(direct)) return direct;
      const fromSource = normalizeFacebookPermalink(await extractFacebookPermalinkFromPageSource(page));
      if (fromSource && !baselineSet.has(fromSource)) return fromSource;
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } else {
      await page.waitForTimeout(1500);
    }
  }
  return null;
}

async function extractFacebookPermalinkFromPageSource(page) {
  const html = await page.content().catch(() => '');
  return extractFacebookPermalinkFromText(html);
}

async function clickFacebookSeePostAndReadUrl(page) {
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const candidates = Array.from(document.querySelectorAll('a, [role="button"], button'))
      .filter((el) => visible(el) && /^(see|view) post$/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()));
    const target = candidates[candidates.length - 1];
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }).catch(() => false);
  if (!clicked) return null;
  await page.waitForTimeout(4000);
  return normalizeFacebookPermalink(page.url()) || normalizeFacebookPermalink(await extractFacebookPermalinkFromPageSource(page));
}

async function fetchRecentFacebookPermalinks(page, targetUrl = null, limit = 8, settleMs = 2500) {
  const scanUrl = targetUrl && /^https?:\/\//i.test(targetUrl) && !/^https?:\/\/(?:www\.)?facebook\.com\/?$/i.test(targetUrl)
    ? targetUrl
    : 'https://www.facebook.com/me';
  await page.goto(scanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
  const hrefs = await page.evaluate((maxItems) => {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    const roots = articles.length ? articles.slice(0, maxItems) : [document.body];
    const out = [];
    const seen = new Set();
    for (const root of roots) {
      for (const a of Array.from(root.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href') || '';
        if (!/story_fbid=|fbid=|\/posts\/|\/permalink\.php|\/story\.php|\/photo\.php|\/videos?\/|\/reel\/|\/groups\/[^/]+\/(?:posts|permalink)\/|\/(?:share|shareable)\/(?:p|r|v|post|video)\//i.test(href)) continue;
        if (/comment|reaction|profile\.php\?id=|\/friends\//i.test(href)) continue;
        const absolute = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
        if (seen.has(absolute)) continue;
        seen.add(absolute);
        out.push(absolute);
        if (out.length >= maxItems) return out;
      }
    }
    return out;
  }, limit).catch(() => []);
  return Array.from(new Set((Array.isArray(hrefs) ? hrefs : []).map(normalizeFacebookPermalink).filter(Boolean)));
}

async function fetchRecentFacebookPostCandidates(page, targetUrl = null, limit = 8, settleMs = 2500) {
  const scanUrl = targetUrl && /^https?:\/\//i.test(targetUrl) && !/^https?:\/\/(?:www\.)?facebook\.com\/?$/i.test(targetUrl)
    ? targetUrl
    : 'https://www.facebook.com/me';
  await page.goto(scanUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
  return await page.evaluate((maxItems) => {
    const normalizeUrl = (raw) => {
      try {
        const u = new URL(raw, 'https://www.facebook.com');
        if (!/(^|\.)(facebook|fb)\.com$/i.test(u.hostname)) return null;
        const p = u.pathname.replace(/\/$/, '');
        const story = u.searchParams.get('story_fbid') || u.searchParams.get('fbid');
        const id = u.searchParams.get('id');
        if (story && id) return `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(story)}&id=${encodeURIComponent(id)}`;
        if (/story_fbid=|fbid=|\/posts\/|\/permalink\.php|\/story\.php|\/photo\.php|\/videos?\/|\/reel\/|\/groups\/[^/]+\/(?:posts|permalink)\/|\/(?:share|shareable)\/(?:p|r|v|post|video)\//i.test(`${p}?${u.searchParams}`)) {
          const keep = new URLSearchParams();
          for (const key of ['story_fbid', 'fbid', 'id']) {
            const value = u.searchParams.get(key);
            if (value) keep.set(key, value);
          }
          const query = keep.toString();
          return `https://www.facebook.com${p}${query ? `?${query}` : ''}`;
        }
      } catch {}
      return null;
    };
    const out = [];
    const seen = new Set();
    const articles = Array.from(document.querySelectorAll('[role="article"]')).slice(0, maxItems * 2);
    for (const article of articles) {
      const text = (article.innerText || article.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 700);
      const fresh = /\b(just now|now|\d+\s*(m|min|mins|minute|minutes))\b/i.test(text);
      for (const a of Array.from(article.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href') || '';
        if (/comment|reaction|profile\.php\?id=|\/friends\//i.test(href)) continue;
        const normalized = normalizeUrl(href);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push({ url: normalized, text, fresh });
        if (out.length >= maxItems) return out;
      }
    }
    return out;
  }, limit).catch(() => []);
}

async function copyFacebookLinkFromTopArticle(page, snippet = '') {
  const articles = page.locator('[role="article"]');
  const count = Math.min(await articles.count().catch(() => 0), 5);
  const wanted = normalizePostText(snippet).slice(0, 45);
  for (let i = 0; i < count; i++) {
    const article = articles.nth(i);
    const body = normalizePostText(await article.innerText({ timeout: 3000 }).catch(() => ''));
    if (wanted && i > 0 && !body.includes(wanted.slice(0, Math.min(28, wanted.length))) && !/just now|\b1m\b|\b2m\b/i.test(body)) continue;
    const menu = article.locator('[aria-label*="Actions for this post" i], [aria-label="More"][role="button"], [aria-label*="More options" i][role="button"], [aria-label*="Open Menu" i][role="button"], div[aria-haspopup="menu"][role="button"]').last();
    if (!(await menu.isVisible().catch(() => false))) {
      const href = await article.locator('a[href*="story_fbid="], a[href*="/posts/"], a[href*="/permalink/"], a[href*="/groups/"][href*="/posts/"], a[href*="/share/"]').first().getAttribute('href').catch(() => null);
      const normalizedHref = normalizeFacebookPermalink(href);
      if (normalizedHref) return normalizedHref;
      continue;
    }
    await menu.scrollIntoViewIfNeeded().catch(() => {});
    await menu.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
    let copy = page.locator('[role="menuitem"]:has-text("Copy link"), [role="menuitem"]:has-text("Copy Link"), div[role="button"]:has-text("Copy link"), span:has-text("Copy link")').first();
    if (!(await copy.isVisible().catch(() => false))) {
      const embed = page.locator('[role="menuitem"]:has-text("Embed"), div[role="button"]:has-text("Embed"), span:has-text("Embed")').first();
      if (await embed.isVisible().catch(() => false)) {
        await embed.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1200);
        copy = page.locator('[role="button"]:has-text("Copy Code"), [role="button"]:has-text("Copy code"), span:has-text("Copy Code"), span:has-text("Copy code")').first();
      }
    }
    if (await copy.isVisible().catch(() => false)) {
      await copy.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      const clipped = await page.evaluate(() => navigator.clipboard?.readText?.()).catch(() => null);
      const normalized = normalizeFacebookPermalink(clipped) || extractFacebookPermalinkFromText(clipped);
      if (normalized) return normalized;
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return null;
}

function toBasicFacebookUrl(targetUrl = null) {
  try {
    const source = targetUrl && /^https?:\/\//i.test(targetUrl) ? targetUrl : 'https://www.facebook.com/';
    const url = new URL(source);
    if (!/(^|\.)(facebook|fb)\.com$/i.test(url.hostname)) return 'https://mbasic.facebook.com/';
    const path = url.pathname && url.pathname !== '/' ? url.pathname : '/me';
    return `https://mbasic.facebook.com${path}${url.search || ''}`;
  } catch {
    return 'https://mbasic.facebook.com/me';
  }
}

function toBasicFacebookPhotoUrl(targetUrl = null) {
  try {
    const base = new URL(toBasicFacebookUrl(targetUrl));
    if (/\/profile\.php$/i.test(base.pathname) && base.searchParams.get('id')) return base.toString();
    const path = base.pathname.replace(/\/$/, '') || '/me';
    return `https://mbasic.facebook.com${path}/photos/`;
  } catch {
    return 'https://mbasic.facebook.com/me/photos/';
  }
}

async function getFacebookBasicDiagnostics(page) {
  return await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    textareas: document.querySelectorAll('textarea').length,
    fileInputs: document.querySelectorAll('input[type="file"]').length,
    submitButtons: Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"], button, [role="button"]'))
      .map((el) => (el.value || el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim())
      .filter(Boolean)
      .slice(0, 20),
    pageText: (document.body?.innerText || document.body?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500),
  })).catch((e) => ({ error: e.message, url: page.url() }));
}

async function clickFacebookBasicEntry(page, needsMedia = false) {
  return await page.evaluate((wantMedia) => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const candidates = Array.from(document.querySelectorAll('a[href], input[type="submit"], button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const text = (el.value || el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
        const href = el.getAttribute('href') || '';
        const haystack = `${text} ${href}`;
        let score = 0;
        if (/composer|mbasic\/composer|create post|write something|what.*mind|publish|status update|status composer/i.test(haystack)) score += 90;
        if (/\bpost\b/i.test(text) && !/posts\/|photos?\/|profile picture|cover/i.test(haystack)) score += 35;
        // Photo/profile/cover links on mbasic often open galleries or cover-image
        // viewers, not the post composer. File upload is handled only after a
        // composer/form is open, so never use these as entry points.
        if (/cover|profile picture|avatar|photo viewer|view photo|photos?\b|video|image|media|story|reel|album|timeline photos|uploads|search|comment|reply|message|like|follow|share this/i.test(haystack)) score -= 140;
        return { el, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) return false;
    candidates[0].el.click();
    return true;
  }, needsMedia).catch(() => false);
}

async function getFacebookBasicState(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const textareas = Array.from(document.querySelectorAll('textarea')).filter(visible).length;
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((el) => !el.disabled).length;
    const submitLabels = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"], button, [role="button"]'))
      .filter((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .map((el) => (el.value || el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim())
      .filter(Boolean)
      .slice(0, 20);
    const body = (document.body?.innerText || document.body?.textContent || '').trim().replace(/\s+/g, ' ');
    return { textareas, fileInputs, submitLabels, hasSubmit: submitLabels.some((x) => /post|publish|share|next|continue|done|preview|upload|submit/i.test(x)), body: body.slice(0, 700), url: location.href };
  }).catch(() => ({ textareas: 0, fileInputs: 0, submitLabels: [], hasSubmit: false, body: '', url: page.url() }));
}

async function fillFacebookBasicText(page, fullText) {
  if (!fullText) return true;
  const areas = page.locator('textarea');
  const count = await areas.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i--) {
    const area = areas.nth(i);
    if (!(await area.isVisible().catch(() => false))) continue;
    const label = `${await area.getAttribute('name').catch(() => '') || ''} ${await area.getAttribute('placeholder').catch(() => '') || ''} ${await area.getAttribute('aria-label').catch(() => '') || ''}`;
    if (/search|comment|reply|message/i.test(label)) continue;
    await area.fill(fullText, { timeout: 10000 }).catch(async () => {
      await area.click({ timeout: 5000 }).catch(() => {});
      await page.keyboard.insertText(fullText).catch(() => {});
    });
    const written = normalizePostText(await area.inputValue().catch(() => '')).includes(normalizePostText(fullText).slice(0, 45));
    if (written) return true;
  }
  return false;
}

async function attachFacebookBasicImages(page, imageFiles) {
  if (!imageFiles.length) return true;
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i--) {
    const input = inputs.nth(i);
    const multiple = await input.getAttribute('multiple').catch(() => null);
    const files = multiple != null ? imageFiles : imageFiles.slice(0, 1);
    const attached = await input.setInputFiles(files, { timeout: 15000 }).then(() => true).catch(() => false);
    if (attached) return true;
  }
  return false;
}

async function clickFacebookBasicSubmit(page) {
  const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const forms = Array.from(document.forms).filter((form) => form.querySelector('textarea, input[type="file"]'));
    const roots = forms.length ? forms : [document.body];
    const candidates = [];
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll('input[type="submit"], button[type="submit"], button, [role="button"]'))) {
        if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const text = (el.value || el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
        if (/search|cancel|back|delete|remove/i.test(text)) continue;
        let score = 0;
        if (/^(post|publish|share)$/i.test(text)) score += 100;
        if (/post|publish|share/i.test(text)) score += 80;
        if (/next|continue|done|preview|upload|submit/i.test(text)) score += 40;
        candidates.push({ el, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const target = candidates.find((item) => item.score > 0);
    if (!target) return false;
    target.el.click();
    return true;
  }).catch(() => false);
  if (clicked) await navPromise;
  else await page.waitForTimeout(1000);
  return clicked;
}

async function tryUploadToFacebookBasic(page, targetUrl, fullText, imageFiles, baselinePermalinks = []) {
  const basicUrl = toBasicFacebookUrl(targetUrl);
  const startUrls = [basicUrl, 'https://mbasic.facebook.com/composer/mbasic/'];
  for (const startUrl of startUrls) {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (/login|checkpoint/i.test(page.url())) throw new Error('Facebook requires login. Use Prepare in Settings to log in once.');
    const state = await getFacebookBasicState(page);
    if (state.textareas || state.fileInputs || /photo|create post|write something|what.*mind|composer/i.test(state.body || '')) break;
  }

  let textWritten = false;
  let mediaAttached = imageFiles.length === 0;
  let submitted = false;
  for (let attempt = 0; attempt < 14; attempt++) {
    const state = await getFacebookBasicState(page);
    if (/couldn.?t post|could not post|failed to post|try again|something went wrong/i.test(state.body || '')) {
      throw new Error(`Facebook rejected the post: ${state.body.slice(0, 260)}. Leaving source files for retry.`);
    }

    if (!state.textareas || (imageFiles.length && !state.fileInputs && !mediaAttached)) {
      if (textWritten && mediaAttached && state.hasSubmit) {
        const clicked = await clickFacebookBasicSubmit(page);
        if (clicked) {
          submitted = true;
          await page.waitForTimeout(3500);
          const direct = normalizeFacebookPermalink(page.url());
          if (direct && !(baselinePermalinks || []).includes(direct)) return direct;
          const resolved = await resolvePostedFacebookUrl(page, targetUrl, fullText, baselinePermalinks).catch(() => null);
          if (resolved) return resolved;
          continue;
        }
      }
      const opened = await clickFacebookBasicEntry(page, imageFiles.length > 0 && !mediaAttached);
      if (opened) {
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1200);
        continue;
      }
      if (!state.textareas && attempt < 3) {
        await page.goto('https://mbasic.facebook.com/composer/mbasic/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1200);
        continue;
      }
    }

    if (!textWritten && state.textareas) {
      textWritten = await fillFacebookBasicText(page, fullText);
    }
    if (!mediaAttached && state.fileInputs) {
      mediaAttached = await attachFacebookBasicImages(page, imageFiles);
    }

    if (textWritten && mediaAttached) {
      const clicked = await clickFacebookBasicSubmit(page);
      if (!clicked) break;
      submitted = true;
      await page.waitForTimeout(3500);
      const direct = normalizeFacebookPermalink(page.url());
      if (direct && !(baselinePermalinks || []).includes(direct)) return direct;
      const afterClick = await getFacebookBasicState(page);
      if (afterClick.textareas || (afterClick.hasSubmit && /preview|review|confirm|add photo|photo|publish|post/i.test(`${afterClick.body} ${(afterClick.submitLabels || []).join(' ')}`))) {
        continue;
      }
      const resolved = await resolvePostedFacebookUrl(page, targetUrl, fullText, baselinePermalinks).catch(() => null);
      if (resolved) return resolved;
      textWritten = await facebookBasicPageContainsText(page, fullText);
      mediaAttached = imageFiles.length === 0 || !(await page.locator('input[type="file"]').count().catch(() => 0));
      if (!textWritten) textWritten = false;
    }
  }
  console.warn('[Facebook] Basic composer fallback did not complete:', JSON.stringify(await getFacebookBasicDiagnostics(page)));
  if (submitted) throw new Error('Facebook post may have been submitted, but exact post link could not be found. Leaving source files for retry.');
  return null;
}

async function facebookBasicPageContainsText(page, expectedText) {
  const wanted = normalizePostText(expectedText).slice(0, 45);
  if (!wanted) return true;
  return await page.evaluate((needle) => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const body = normalize(document.body?.innerText || document.body?.textContent || '');
    return body.includes(needle);
  }, wanted).catch(() => false);
}

async function resolvePostedFacebookUrl(page, targetUrl = null, snippet = '', baselineUrls = []) {
  const baselineSet = new Set((Array.isArray(baselineUrls) ? baselineUrls : []).map(normalizeFacebookPermalink).filter(Boolean));
  const wanted = normalizePostText(snippet).slice(0, 90);
  const fresh = (url) => {
    const normalized = normalizeFacebookPermalink(url);
    return normalized && !baselineSet.has(normalized) ? normalized : null;
  };
  const textMatches = (body = '') => {
    if (!wanted) return true;
    const normalized = normalizePostText(body);
    return normalized.includes(wanted.slice(0, Math.min(45, wanted.length)));
  };
  const direct = normalizeFacebookPermalink(page.url());
  if (direct && !baselineSet.has(direct)) return direct;

  const confirmationLink = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || '').trim();
      const href = a.getAttribute('href') || '';
      if (!/view post|see post|your post|posted|just now/i.test(text) && !/story_fbid=|fbid=|\/posts\/|\/permalink\.php|\/story\.php|\/share\//i.test(href)) continue;
      return href;
    }
    return null;
  }).catch(() => null);
  const fromConfirmation = fresh(confirmationLink);
  if (fromConfirmation) return fromConfirmation;

  const fromSeePost = fresh(await clickFacebookSeePostAndReadUrl(page));
  if (fromSeePost) return fromSeePost;

  await page.waitForTimeout(2500);
  const copied = fresh(await copyFacebookLinkFromTopArticle(page, snippet));
  if (copied) return copied;
  const onCurrentPage = fresh(await extractFacebookPermalinkFromArticles(page, snippet));
  if (onCurrentPage) return onCurrentPage;

  const urlsToScan = [];
  if (targetUrl && /^https?:\/\//i.test(targetUrl) && !/^https?:\/\/(?:www\.)?facebook\.com\/?$/i.test(targetUrl)) urlsToScan.push(targetUrl);
  urlsToScan.push('https://www.facebook.com/me');
  for (const scanUrl of urlsToScan) {
    await page.goto(scanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.waitForTimeout(4000 + Math.min(attempt, 8) * 1500);
      const candidates = await fetchRecentFacebookPostCandidates(page, scanUrl, 10, 1000).catch(() => []);
      const matchingCandidate = candidates.find((item) => fresh(item?.url) && textMatches(item?.text || ''));
      if (matchingCandidate) return fresh(matchingCandidate.url);
      const anyFreshCandidate = candidates.find((item) => fresh(item?.url) && item?.fresh);
      if (!wanted && anyFreshCandidate) return fresh(anyFreshCandidate.url);
      const copiedAfterNav = fresh(await copyFacebookLinkFromTopArticle(page, snippet));
      if (copiedAfterNav) return copiedAfterNav;
      const permalink = fresh(await extractFacebookPermalinkFromArticles(page, snippet));
      if (permalink) return permalink;
      const opened = fresh(await openFreshFacebookArticleAndReadUrl(page, snippet, baselineUrls));
      if (opened) return opened;
      const recent = await fetchRecentFacebookPermalinks(page, scanUrl, 8, 1000).catch(() => []);
      const newRecent = recent.find((url) => !baselineSet.has(url));
      if (newRecent) return newRecent;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
  }

  throw new Error('Facebook post was submitted, but exact post link could not be found. Leaving source files for retry.');
}

async function verifyPostedFacebookUrlContainsText(page, url, expectedText) {
  const expected = normalizePostText(expectedText).slice(0, 70);
  if (!expected || !url) return true;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const body = normalizePostText(await page.evaluate(() => {
    const article = document.querySelector('[role="article"]') || document.body;
    return (article?.innerText || article?.textContent || '').trim();
  }).catch(() => ''));
  if (!body.includes(expected.slice(0, Math.min(40, expected.length)))) {
    throw new Error('Facebook published URL did not contain the intended text, so it is not treated as a successful post. Leaving source files for retry.');
  }
  return true;
}

async function uploadToFacebook(imagePath, { description, hashtags = [] }, opts = {}) {
  const imageFiles = Array.isArray(imagePath) ? imagePath.filter(Boolean) : (imagePath ? [imagePath] : []);
  const context = await launchPersistent('facebook', opts);
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.facebook.com' }).catch(() => {});
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://facebook.com' }).catch(() => {});
    const page = context.pages()[0] || await context.newPage();
    const targetUrl = (opts && opts.targetUrl && /^https?:\/\//i.test(opts.targetUrl)) ? opts.targetUrl : 'https://www.facebook.com/';
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3500);

    const url = page.url();
    if (url.includes('/login')) {
      throw new Error('Facebook requires login. Use Prepare in Settings to log in once.');
    }

    const baselinePermalinks = await fetchRecentFacebookPermalinks(page, targetUrl, 8, 1500).catch(() => []);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const fullText = hashtags.length
      ? `${description}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : (description || '');

    // Prefer Facebook's lightweight/basic composer first. It is server-rendered,
    // uses stable textarea/file-input/form controls, and avoids the modern SPA's
    // nested popups where text/media can land in different dialogs.
    const basicUrl = await tryUploadToFacebookBasic(page, targetUrl, fullText, imageFiles, baselinePermalinks).catch((e) => {
      if (/requires login|rejected|may have been submitted|exact post link/i.test(e.message || '')) throw e;
      console.warn('[Facebook] Basic composer fallback unavailable:', e.message);
      return null;
    });
    if (basicUrl) {
      await verifyPostedFacebookUrlContainsText(page, basicUrl, fullText);
      return { url: basicUrl };
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Open composer if not already open
    const dialogSel = 'div[role="dialog"]';
    const dialogOpen = async () => await facebookComposerOpen(page, dialogSel);
    if (!(await dialogOpen())) {
      const opened = await clickFacebookModernComposerEntry(page, imageFiles.length > 0);
      if (!opened) throw new Error('Could not open the Facebook Create Post composer. Leaving source files for retry.');
      await page.waitForTimeout(2000);
    }

    // Facebook can open a media editor between upload and the final composer.
    // Put text into the real composer first, then verify/reinsert after media is
    // confirmed so we never advance to an image-only Post dialog.
    await insertFacebookTextIntoActiveComposer(page, fullText);
    await page.waitForTimeout(400);

    if (imageFiles.length) {
      await attachImagesToFacebookComposer(page, imageFiles, dialogSel, fullText);
    }

    // Some Facebook media flows clear/hide text after the media editor closes.
    // Re-write only if missing, then verify both text and media before Post.
    await insertFacebookTextIntoActiveComposer(page, fullText, { onlyIfMissing: true });

    let confirmed = false;
    let responsePermalink = null;
    let publishedUrl = null;
    let lastPostError = '';
    for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
      await waitForFacebookReadyComposer(page, fullText, imageFiles.length, 180000);
      await verifyFacebookComposerHasText(page, dialogSel, fullText);
      await verifyFacebookComposerHasMedia(page, imageFiles.length);
      const createPostPromise = waitForFacebookCreatePostResponse(page, 180000);
      await clickFacebookVerifiedPostButton(page, dialogSel, fullText, imageFiles.length);
      const result = await waitForFacebookPublishConfirmation(page, dialogSel, fullText, 420000);
      const captured = await Promise.race([
        createPostPromise,
        page.waitForTimeout(result.confirmed ? 45000 : 5000).then(() => null),
      ]).catch(() => null);
      responsePermalink = normalizeFacebookPermalink(captured) || responsePermalink;
      publishedUrl = normalizeFacebookPermalink(result.url) || responsePermalink || publishedUrl;
      confirmed = Boolean(result.confirmed);
      lastPostError = result.error || lastPostError;
      if (!confirmed && !result.retry) break;
      if (!confirmed) await page.waitForTimeout(2000);
    }

    if (!confirmed) {
      console.error('[Facebook] Publish diagnostics:', JSON.stringify(await getFacebookDiagnostics(page, dialogSel)));
      throw new Error(`Facebook did not confirm the post${lastPostError ? `: ${lastPostError}` : ''}. Leaving source files for retry.`);
    }

    // Give Facebook time to propagate the new post to the profile feed before
    // we go looking for its permalink.
    await page.waitForTimeout(8000);
    const baselineSet = new Set(baselinePermalinks);
    const normalizedResponsePermalink = normalizeFacebookPermalink(publishedUrl) || normalizeFacebookPermalink(responsePermalink);
    const finalUrl = (normalizedResponsePermalink && !baselineSet.has(normalizedResponsePermalink) ? normalizedResponsePermalink : null)
      || await resolvePostedFacebookUrl(page, targetUrl, fullText, baselinePermalinks).catch(async (e) => {
        const fromSource = normalizeFacebookPermalink(await extractFacebookPermalinkFromPageSource(page));
        if (fromSource && !baselineSet.has(fromSource)) return fromSource;
        console.error('[Facebook] Link resolution diagnostics:', JSON.stringify(await getFacebookDiagnostics(page, dialogSel)));
        throw e;
      });
    await verifyPostedFacebookUrlContainsText(page, finalUrl, fullText);
    return { url: finalUrl };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToFacebook };
