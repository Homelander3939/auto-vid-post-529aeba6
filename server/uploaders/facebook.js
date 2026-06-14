// Facebook post uploader using a persistent Chrome profile.
const { launchPersistent, safeClose } = require('./social-post-base');

async function uploadToFacebook(imagePath, { description, hashtags = [] }, opts = {}) {
  const imageFiles = Array.isArray(imagePath) ? imagePath.filter(Boolean) : (imagePath ? [imagePath] : []);
  const context = await launchPersistent('facebook', opts);
  try {
    const page = context.pages()[0] || await context.newPage();
    const targetUrl = (opts && opts.targetUrl && /^https?:\/\//i.test(opts.targetUrl)) ? opts.targetUrl : 'https://www.facebook.com/';
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const url = page.url();
    if (url.includes('/login')) {
      throw new Error('Facebook requires login. Use Prepare in Settings to log in once.');
    }

    const fullText = hashtags.length
      ? `${description}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : description;

    // Click the "What's on your mind?" prompt
    const prompt = page.locator('[role="button"]:has-text("on your mind"), [aria-label*="What" i]:has-text("mind")').first();
    await prompt.waitFor({ state: 'visible', timeout: 30000 });
    await prompt.click();
    await page.waitForTimeout(2000);

    // Composer textbox
    const textbox = page.locator('div[role="textbox"][contenteditable="true"]').first();
    await textbox.waitFor({ state: 'visible', timeout: 15000 });
    await textbox.click();
    await page.keyboard.insertText(fullText);
    await page.waitForTimeout(1000);

    if (imageFiles.length) {
      // Click "Photo/video" button to reveal file input
      await page.locator('[aria-label="Photo/video"], [aria-label*="Photo" i]').first().click().catch(() => {});
      await page.waitForTimeout(1500);
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await fileInput.setInputFiles(imageFiles);
      await page.waitForTimeout(5000 + (imageFiles.length - 1) * 1500);
    }

    const postBtn = page.locator('[aria-label="Post"][role="button"], div[role="button"]:has-text("Post")').last();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    await postBtn.click();

    await page.waitForTimeout(6000);
    return { url: 'https://facebook.com/' };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToFacebook };
