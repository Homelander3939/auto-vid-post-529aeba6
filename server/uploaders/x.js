// X (Twitter) post uploader using a persistent Chrome profile.
const { launchPersistent, safeClose } = require('./social-post-base');

const X_COMPOSE_URL = 'https://x.com/compose/post';

async function getMyHandle(page) {
  // Try the side-nav profile link first
  const handleFromNav = await page.evaluate(() => {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')
      || document.querySelector('a[aria-label="Profile"]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
    return m ? m[1] : null;
  }).catch(() => null);
  if (handleFromNav) return handleFromNav;
  // Fallback: open the account switcher / look at any /<handle> profile link with screen name
  const handleFromMenu = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="UserAvatar-Container-unknown"]')
      || document.querySelector('header [data-testid^="UserAvatar-Container-"]');
    if (!el) return null;
    const tid = el.getAttribute('data-testid') || '';
    const m = tid.match(/^UserAvatar-Container-(.+)$/);
    return m && m[1] !== 'unknown' ? m[1] : null;
  }).catch(() => null);
  return handleFromMenu;
}

async function resolvePostedXUrl(page, handle, snippet) {
  // 1) Direct URL after publish
  const cur = page.url();
  const directMatch = cur.match(/https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/);
  if (directMatch) return directMatch[0];

  if (!handle) return cur;

  // 2) Navigate to own profile and read first tweet permalink
  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    const href = await page.evaluate((h) => {
      const links = Array.from(document.querySelectorAll(`a[href*="/${h}/status/"]`));
      for (const a of links) {
        const m = (a.getAttribute('href') || '').match(new RegExp(`^/${h}/status/\\d+$`));
        if (m) return a.getAttribute('href');
      }
      return null;
    }, handle).catch(() => null);
    if (href) return `https://x.com${href}`;
  } catch {}
  return `https://x.com/${handle}`;
}

async function uploadToX(imagePath, { description, hashtags = [] }, opts = {}) {
  const imageFiles = Array.isArray(imagePath) ? imagePath.filter(Boolean) : (imagePath ? [imagePath] : []);
  const context = await launchPersistent('x', opts);
  try {
    const page = context.pages()[0] || await context.newPage();

    // Visit home first to read the logged-in handle reliably
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const homeUrl = page.url();
    if (homeUrl.includes('/login') || homeUrl.includes('/i/flow/login')) {
      throw new Error('X requires login. Use Prepare in Settings to log in once.');
    }
    const myHandle = await getMyHandle(page);

    const targetUrl = (opts && opts.targetUrl && /^https?:\/\//i.test(opts.targetUrl)) ? opts.targetUrl : X_COMPOSE_URL;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const url = page.url();
    if (url.includes('/login') || url.includes('/i/flow/login')) {
      throw new Error('X requires login. Use Prepare in Settings to log in once.');
    }

    const textArea = page.locator('div[role="textbox"][data-testid^="tweetTextarea"]').first();
    await textArea.waitFor({ state: 'visible', timeout: 30000 });
    await textArea.click();

    const fullText = hashtags.length
      ? `${description}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : description;

    await page.keyboard.insertText(fullText);
    await page.waitForTimeout(1000);

    if (imageFiles.length) {
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await fileInput.setInputFiles(imageFiles).catch(async () => {
        const attach = page.locator('[data-testid="fileInput"], [aria-label*="media" i], [data-testid="attachments"]').first();
        await attach.click({ trial: true }).catch(() => {});
        await fileInput.setInputFiles(imageFiles);
      });
      await page.locator('[data-testid="attachments"] img, img[src^="blob:"]').first()
        .waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(5000 + (imageFiles.length - 1) * 2000);
    }

    const postBtn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    for (let i = 0; i < 20; i++) {
      const disabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
      if (disabled !== 'true') break;
      await page.waitForTimeout(500);
    }
    await postBtn.scrollIntoViewIfNeeded().catch(() => {});
    let clicked = false;
    await postBtn.click({ force: true, timeout: 10000 }).then(() => { clicked = true; }).catch(async () => {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter').catch(() => {});
    });

    // Wait for composer to disappear (real success signal)
    const composerGone = await textArea.waitFor({ state: 'detached', timeout: 20000 })
      .then(() => true).catch(() => false);
    const stillVisible = !composerGone && await textArea.isVisible().catch(() => false);
    if (stillVisible) {
      // Detect inline error toast
      const errToast = await page.locator('[data-testid="toast"], div[role="alert"]').first().textContent().catch(() => '');
      throw new Error(`X did not confirm the post (composer still open${errToast ? `: ${errToast.trim()}` : ''}). Leaving source files for retry.`);
    }

    await page.waitForTimeout(3000);
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
