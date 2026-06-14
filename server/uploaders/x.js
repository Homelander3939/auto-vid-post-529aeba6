// X (Twitter) post uploader using a persistent Chrome profile.
const { launchPersistent, safeClose } = require('./social-post-base');

const X_COMPOSE_URL = 'https://x.com/compose/post';

async function uploadToX(imagePath, { description, hashtags = [] }, opts = {}) {
  // Accept either a single path (legacy) or an array (multi-image bundle).
  const imageFiles = Array.isArray(imagePath) ? imagePath.filter(Boolean) : (imagePath ? [imagePath] : []);
  const context = await launchPersistent('x', opts);
  try {
    const page = context.pages()[0] || await context.newPage();
    const targetUrl = (opts && opts.targetUrl && /^https?:\/\//i.test(opts.targetUrl)) ? opts.targetUrl : X_COMPOSE_URL;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // If redirected to login, surface a clear error
    const url = page.url();
    if (url.includes('/login') || url.includes('/i/flow/login')) {
      throw new Error('X requires login. Use Prepare in Settings to log in once.');
    }

    // Compose textarea (X uses contenteditable)
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
      await page.waitForTimeout(4000 + (imageFiles.length - 1) * 1500);
    }

    const postBtn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    // Wait until enabled
    for (let i = 0; i < 20; i++) {
      const disabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
      if (disabled !== 'true') break;
      await page.waitForTimeout(500);
    }
    await postBtn.click();

    // Wait for navigation/toast indicating success
    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    return { url: finalUrl };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToX };
