// Facebook post uploader using a persistent Chrome profile.
const { launchPersistent, safeClose } = require('./social-post-base');

function normalizeFacebookPermalink(raw) {
  if (!raw) return null;
  let url;
  try { url = new URL(raw, 'https://www.facebook.com'); } catch { return null; }
  if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return null;
  url.hash = '';

  const path = url.pathname.replace(/\/$/, '');
  const story = url.searchParams.get('story_fbid') || url.searchParams.get('fbid');
  const owner = url.searchParams.get('id');
  if (story && owner) return `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(story)}&id=${encodeURIComponent(owner)}`;
  if (/\/(?:posts|videos|reel|watch)\//i.test(path)
    || /\/groups\/[^/]+\/(?:posts|permalink)\//i.test(path)
    || /\/permalink\.php$/i.test(path)
    || /\/story\.php$/i.test(path)
    || /\/photo\.php$/i.test(path)
    || /\/share\/(?:p|r|v|post|video)\//i.test(path)) {
    const keep = new URLSearchParams();
    for (const key of ['story_fbid', 'fbid', 'id']) {
      const value = url.searchParams.get(key);
      if (value) keep.set(key, value);
    }
    const query = keep.toString();
    return `${url.origin}${path}${query ? `?${query}` : ''}`;
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

async function extractFacebookPermalinkFromArticles(page, snippet = '') {
  return await page.evaluate((rawSnippet) => {
    const normalizeUrl = (raw) => {
      try {
        const u = new URL(raw, 'https://www.facebook.com');
        if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null;
        const p = u.pathname.replace(/\/$/, '');
        const story = u.searchParams.get('story_fbid') || u.searchParams.get('fbid');
        const id = u.searchParams.get('id');
        if (story && id) return `https://www.facebook.com/permalink.php?story_fbid=${encodeURIComponent(story)}&id=${encodeURIComponent(id)}`;
        if (/\/(?:posts|videos|reel|watch)\//i.test(p) || /\/groups\/[^/]+\/(?:posts|permalink)\//i.test(p) || /\/permalink\.php$/i.test(p) || /\/story\.php$/i.test(p) || /\/photo\.php$/i.test(p) || /\/share\/(?:p|r|v|post|video)\//i.test(p)) {
          const keep = new URLSearchParams();
          for (const key of ['story_fbid', 'fbid', 'id']) {
            const value = u.searchParams.get(key);
            if (value) keep.set(key, value);
          }
          const query = keep.toString();
          return `${u.origin}${p}${query ? `?${query}` : ''}`;
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
        .filter((a) => !/comment|reaction|profile.php\?id=/i.test(a.href))
        .sort((a, b) => (/just now|\d+\s*(m|min)|hour|yesterday|at/i.test(b.text) ? 1 : 0) - (/just now|\d+\s*(m|min)|hour|yesterday|at/i.test(a.text) ? 1 : 0));
      for (const a of direct) {
        const out = normalizeUrl(a.href);
        if (out) return out;
      }
    }
    return null;
  }, snippet).catch(() => null);
}

async function copyFacebookLinkFromTopArticle(page, snippet = '') {
  const articles = page.locator('[role="article"]');
  const count = Math.min(await articles.count().catch(() => 0), 5);
  const wanted = normalizePostText(snippet).slice(0, 45);
  for (let i = 0; i < count; i++) {
    const article = articles.nth(i);
    const body = normalizePostText(await article.innerText({ timeout: 3000 }).catch(() => ''));
    if (wanted && i > 0 && !body.includes(wanted.slice(0, Math.min(28, wanted.length))) && !/just now|\b1m\b|\b2m\b/i.test(body)) continue;
    const menu = article.locator('[aria-label*="Actions for this post" i], [aria-label="More"][role="button"], [aria-label*="More options" i][role="button"], div[aria-haspopup="menu"][role="button"]').last();
    if (!(await menu.isVisible().catch(() => false))) continue;
    await menu.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
    const copy = page.locator('[role="menuitem"]:has-text("Copy link"), [role="menuitem"]:has-text("Copy Link"), div[role="button"]:has-text("Copy link"), span:has-text("Copy link")').first();
    if (await copy.isVisible().catch(() => false)) {
      await copy.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      const clipped = await page.evaluate(() => navigator.clipboard?.readText?.()).catch(() => null);
      const normalized = normalizeFacebookPermalink(clipped);
      if (normalized) return normalized;
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return null;
}

async function resolvePostedFacebookUrl(page, targetUrl = null, snippet = '') {
  const direct = normalizeFacebookPermalink(page.url());
  if (direct) return direct;

  await page.waitForTimeout(2500);
  const copied = await copyFacebookLinkFromTopArticle(page, snippet);
  if (copied) return copied;
  const onCurrentPage = await extractFacebookPermalinkFromArticles(page, snippet);
  if (onCurrentPage) return onCurrentPage;

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
  const fromConfirmation = normalizeFacebookPermalink(confirmationLink);
  if (fromConfirmation) return fromConfirmation;

  const urlsToScan = [];
  if (targetUrl && /^https?:\/\//i.test(targetUrl) && !/^https?:\/\/(?:www\.)?facebook\.com\/?$/i.test(targetUrl)) urlsToScan.push(targetUrl);
  urlsToScan.push('https://www.facebook.com/me');
  for (const scanUrl of urlsToScan) {
    await page.goto(scanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.waitForTimeout(3000 + attempt * 1500);
      const copiedAfterNav = await copyFacebookLinkFromTopArticle(page, snippet);
      if (copiedAfterNav) return copiedAfterNav;
      const permalink = await extractFacebookPermalinkFromArticles(page, snippet);
      if (permalink) return permalink;
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

    const textbox = page.locator(`${dialogSel} div[role="textbox"][contenteditable="true"]`).first();
    await textbox.waitFor({ state: 'visible', timeout: 15000 });
    await textbox.click();
    await page.keyboard.insertText(fullText).catch(async () => {
      await page.keyboard.type(fullText, { delay: 10 });
    });
    await page.waitForTimeout(800);

    // Dismiss any hashtag autocomplete popover that may be intercepting clicks
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);

    if (imageFiles.length) {
      // Try direct file input first (works even when popover is open)
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      let attached = await fileInput.setInputFiles(imageFiles).then(() => true).catch(() => false);
      if (!attached) {
        await page.locator(`${dialogSel} [aria-label="Photo/video"], ${dialogSel} [aria-label*="Photo" i]`).first().click().catch(() => {});
        await page.waitForTimeout(1500);
        await fileInput.setInputFiles(imageFiles).catch(() => {});
      }
      await page.waitForTimeout(5000 + (imageFiles.length - 1) * 1500);
    }

    // Dismiss popovers again before clicking buttons
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);

    // Some FB flows show "Next" before Post (e.g. when media is attached or for Pages)
    for (let i = 0; i < 3; i++) {
      const nextBtn = page.locator(`${dialogSel} [aria-label="Next"][role="button"], ${dialogSel} div[role="button"]:has-text("Next")`).first();
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click().catch(() => {});
        await page.waitForTimeout(2000);
      } else break;
    }

    const postBtn = page.locator(`${dialogSel} [aria-label="Post"][role="button"], ${dialogSel} div[role="button"]:has-text("Post"):not(:has-text("Postpone"))`).last();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    // Wait for enabled
    for (let i = 0; i < 30; i++) {
      const disabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
      if (disabled !== 'true') break;
      await page.waitForTimeout(500);
    }
    await postBtn.click({ force: true }).catch(async () => { await postBtn.click(); });

    // Wait for dialog to close (post published) — real success signal
    const dialogClosed = await page.locator(dialogSel).first()
      .waitFor({ state: 'detached', timeout: 45000 })
      .then(() => true).catch(() => false);
    if (!dialogClosed) {
      const stillOpen = await page.locator(dialogSel).first().isVisible().catch(() => false);
      if (stillOpen) {
        throw new Error('Facebook did not confirm the post (composer still open). Leaving source files for retry.');
      }
    }
    await page.waitForTimeout(3500);

    return { url: await resolvePostedFacebookUrl(page, targetUrl, fullText) };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToFacebook };
