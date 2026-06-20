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
  return await page.evaluate(() => {
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

async function clickFacebookNextSteps(page, maxSteps = 4) {
  for (let step = 0; step < maxSteps; step++) {
    const dialog = await getActiveFacebookDialogLocator(page);
    const buttons = dialog.locator('[aria-label="Next"][role="button"], div[role="button"]:has-text("Next")');
    const count = await buttons.count().catch(() => 0);
    let clicked = false;
    for (let i = count - 1; i >= 0; i--) {
      const btn = buttons.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const disabled = await btn.getAttribute('aria-disabled').catch(() => null);
      if (disabled === 'true') continue;
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
  const dialog = await getFacebookComposerDialogLocator(page);
  const textbox = dialog.locator('div[role="textbox"][contenteditable="true"]').first();
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
      const textboxes = Array.from(dialog.querySelectorAll('div[role="textbox"][contenteditable="true"]')).filter(visible).length;
      const hasPost = Array.from(dialog.querySelectorAll('[role="button"], button')).some((btn) => {
        const label = (btn.getAttribute('aria-label') || '').trim();
        const body = (btn.innerText || btn.textContent || '').trim();
        return visible(btn) && !/postpone/i.test(`${label} ${body}`) && /^(post|publish)$/i.test(label || body);
      });
      const z = Number.parseInt(window.getComputedStyle(dialog).zIndex || '0', 10);
      return { index, textboxes, hasPost, z: Number.isFinite(z) ? z : 0 };
    }).filter((item) => visible(dialogs[item.index]) && (item.textboxes > 0 || item.hasPost));
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
    const previews = Array.from(root.querySelectorAll('img[src^="blob:"], video[src^="blob:"], [aria-label*="Photo" i] img, [aria-label*="image" i] img')).filter(visible).length;
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
      const previews = Array.from(dialog.querySelectorAll('img[src^="blob:"], video[src^="blob:"], [aria-label*="Photo" i] img, [aria-label*="image" i] img')).filter(visible).length;
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
  const groups = [
    activeDialog.locator('[aria-label="Post"][role="button"]'),
    activeDialog.locator('div[role="button"]:has-text("Post"):not(:has-text("Postpone"))'),
    activeDialog.locator('[aria-label="Publish"][role="button"], div[role="button"]:has-text("Publish")'),
    page.getByRole('button', { name: /^Post$/ }),
  ];
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
      if (/^(post|publish)$/i.test(label.trim()) || /^(post|publish)$/i.test(text.trim()) || /\bpost\b/i.test(text)) return btn;
      fallback = fallback || btn;
    }
  }
  return fallback || page.locator(`${dialogSel} [aria-label="Post"][role="button"], ${dialogSel} div[role="button"]:has-text("Post"):not(:has-text("Postpone"))`).last();
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
          return visible(btn) && !/postpone/i.test(`${label} ${body}`) && /^(post|publish)$/i.test(label || body);
        });
        const z = Number.parseInt(window.getComputedStyle(dialog).zIndex || '0', 10);
        return { dialog, index, textboxes, hasPost, z: Number.isFinite(z) ? z : 0 };
      }).filter((item) => item.textboxes > 0 || item.hasPost)
        .sort((a, b) => ((a.hasPost ? 1 : 0) - (b.hasPost ? 1 : 0)) || (a.textboxes - b.textboxes) || (a.z - b.z) || (a.index - b.index));
      const dialog = scored.length ? scored[scored.length - 1].dialog : (dialogs[dialogs.length - 1] || document);
      const buttons = Array.from(dialog.querySelectorAll('[role="button"], button'));
      const btn = buttons.reverse().find((el) => visible(el)
        && el.getAttribute('aria-disabled') !== 'true'
        && /^(post|publish)$/i.test(((el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim())));
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

async function verifyFacebookComposerHasText(page, dialogSel, expectedText) {
  const expected = normalizePostText(expectedText).slice(0, 90);
  const dialog = await getFacebookComposerDialogLocator(page);
  const state = await dialog.locator('div[role="textbox"][contenteditable="true"]').first().innerText({ timeout: 5000 }).catch(() => '');
  const normalized = normalizePostText(state);
  if (expected && !normalized.includes(expected.slice(0, Math.min(45, expected.length)))) {
    throw new Error('Facebook composer text was not present before posting. Leaving source files for retry.');
  }
}

async function attachImagesToFacebookComposer(page, imageFiles, dialogSel) {
  if (!imageFiles.length) return;
  const expectedCount = imageFiles.length;
  let attached = false;
  const directInputs = [
    page.locator(`${dialogSel} input[type="file"][accept*="image"]`).last(),
    page.locator(`${dialogSel} input[type="file"]`).last(),
    page.locator('input[type="file"][accept*="image"]').last(),
    page.locator('input[type="file"]').last(),
  ];
  for (const input of directInputs) {
    if (!(await input.count().catch(() => 0))) continue;
    attached = await input.setInputFiles(imageFiles, { timeout: 15000 }).then(() => true).catch(() => false);
    if (attached) break;
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
      const input = page.locator('input[type="file"][accept*="image"], input[type="file"]').last();
      attached = await input.setInputFiles(imageFiles, { timeout: 15000 }).then(() => true).catch(() => false);
    }
  }

  if (!attached) throw new Error('Facebook image picker opened but no controllable file input was found. Leaving source files for retry.');
  await waitForFacebookMediaReady(page, dialogSel, expectedCount, 180000);
  await clickFacebookNextSteps(page, 5);
  await page.waitForTimeout(1500);
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
        return visible(btn) && /^(post|publish)$/i.test(label || body);
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
      return { article, score: (textMatch ? 20 : 0) + (fresh ? 8 : 0) - index };
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

async function extractFacebookPermalinkFromPageSource(page) {
  const html = await page.content().catch(() => '');
  return extractFacebookPermalinkFromText(html);
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
      const recent = await fetchRecentFacebookPermalinks(page, scanUrl, 8, 1000).catch(() => []);
      const newRecent = recent.find((url) => !baselineSet.has(url));
      if (newRecent) return newRecent;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
  }

  throw new Error('Facebook post was submitted, but exact post link could not be found. Leaving source files for retry.');
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

    // Open composer if not already open
    const dialogSel = 'div[role="dialog"]';
    const dialogOpen = async () => await page.locator(dialogSel).first().isVisible().catch(() => false);
    if (!(await dialogOpen())) {
      const prompt = page.locator('[role="button"]:has-text("on your mind"), [aria-label*="What" i]:has-text("mind")').first();
      await prompt.waitFor({ state: 'visible', timeout: 30000 });
      await prompt.click();
      await page.waitForTimeout(2000);
    }

    if (imageFiles.length) {
      await attachImagesToFacebookComposer(page, imageFiles, dialogSel);
    }

    await insertFacebookTextIntoActiveComposer(page, fullText);
    await page.waitForTimeout(400);

    // Some Facebook media flows open a temporary editor over the real composer.
    // After media is attached/confirmed, write text only into the dialog that has
    // the final Post button so suggestions/edit overlays cannot steal the post.
    await insertFacebookTextIntoActiveComposer(page, fullText, { onlyIfMissing: true });

    const createPostPromise = waitForFacebookCreatePostResponse(page, 180000);
    await verifyFacebookComposerHasText(page, dialogSel, fullText);
    await clickFacebookPostButton(page, dialogSel);

    // Wait for the composer/spinner to fully finish. Facebook Page posts can
    // keep rolling for several minutes; do not close or resolve early.
    await waitForFacebookComposerToFinish(page, dialogSel, 420000);

    // Give Facebook time to propagate the new post to the profile feed before
    // we go looking for its permalink.
    await page.waitForTimeout(4000);
    const responsePermalink = await Promise.race([
      createPostPromise,
      page.waitForTimeout(45000).then(() => null),
    ]).catch(() => null);

    const baselineSet = new Set(baselinePermalinks);
    const normalizedResponsePermalink = normalizeFacebookPermalink(responsePermalink);
    const finalUrl = (normalizedResponsePermalink && !baselineSet.has(normalizedResponsePermalink) ? normalizedResponsePermalink : null)
      || await resolvePostedFacebookUrl(page, targetUrl, fullText, baselinePermalinks).catch(async (e) => {
        const fromSource = normalizeFacebookPermalink(await extractFacebookPermalinkFromPageSource(page));
        if (fromSource && !baselineSet.has(fromSource)) return fromSource;
        console.error('[Facebook] Link resolution diagnostics:', JSON.stringify(await getFacebookDiagnostics(page, dialogSel)));
        throw e;
      });
    return { url: finalUrl };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToFacebook };
