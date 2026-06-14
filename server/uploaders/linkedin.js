// LinkedIn post uploader using a persistent Chrome profile.
// Pattern mirrors x.js / facebook.js — open the share composer, type text, attach
// optional image, click Post. Failures throw so the social post processor can mark
// the platform_results row as 'error' and surface it in the UI/Telegram.
const { launchPersistent, safeClose } = require('./social-post-base');

const LI_FEED_URL = 'https://www.linkedin.com/feed/';

async function uploadToLinkedIn(imagePath, { description, hashtags = [] }, opts = {}) {
  const imageFiles = Array.isArray(imagePath) ? imagePath.filter(Boolean) : (imagePath ? [imagePath] : []);
  const context = await launchPersistent('linkedin', opts);
  try {
    const page = context.pages()[0] || await context.newPage();
    const targetUrl = (opts && opts.targetUrl && /^https?:\/\//i.test(opts.targetUrl)) ? opts.targetUrl : LI_FEED_URL;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const url = page.url();
    if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/uas/login')) {
      throw new Error('LinkedIn requires login. Use Prepare in Settings to log in once.');
    }

    // Open the share modal — the "Start a post" button on the home feed.
    const startBtn = page.locator(
      'button:has-text("Start a post"), button[aria-label*="Start a post" i], .share-box-feed-entry__trigger'
    ).first();
    await startBtn.waitFor({ state: 'visible', timeout: 20000 });
    await startBtn.click();

    // The share composer mounts as a dialog with a contenteditable text area.
    const editor = page.locator('div[role="dialog"] div[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 15000 });
    await editor.click();

    const fullText = hashtags.length
      ? `${description}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : description;
    await page.keyboard.insertText(fullText);
    await page.waitForTimeout(800);

    if (imageFiles.length) {
      // Click the image attach button inside the dialog, then set the files.
      const attachBtn = page.locator(
        'div[role="dialog"] button[aria-label*="photo" i], div[role="dialog"] button[aria-label*="image" i]'
      ).first();
      await attachBtn.click({ trial: false }).catch(() => {});
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await fileInput.setInputFiles(imageFiles);
      await page.waitForTimeout(2500 + (imageFiles.length - 1) * 1500);
      // Some LinkedIn flows pop a "Next" / "Done" button to confirm the image before
      // returning to the post composer.
      const nextBtn = page.locator(
        'div[role="dialog"] button:has-text("Next"), div[role="dialog"] button:has-text("Done")'
      ).first();
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    // Click Post — wait for it to enable.
    const postBtn = page.locator('div[role="dialog"] button:has-text("Post")').first();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    for (let i = 0; i < 20; i++) {
      const disabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
      const isDisabled = await postBtn.isDisabled().catch(() => false);
      if (disabled !== 'true' && !isDisabled) break;
      await page.waitForTimeout(500);
    }
    await postBtn.click();

    await page.waitForTimeout(6000);
    return { url: page.url() };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToLinkedIn };
