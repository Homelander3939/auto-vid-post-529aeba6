// Facebook post uploader using a persistent Chrome profile.
const { launchPersistent, safeClose } = require('./social-post-base');

async function uploadToFacebook(imagePath, { description, hashtags = [] }, opts = {}) {
  const imageFiles = Array.isArray(imagePath) ? imagePath.filter(Boolean) : (imagePath ? [imagePath] : []);
  const context = await launchPersistent('facebook', opts);
  try {
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

    // Capture URL when navigation/post happens
    const beforeUrl = page.url();
    const postBtn = page.locator(`${dialogSel} [aria-label="Post"][role="button"], ${dialogSel} div[role="button"]:has-text("Post"):not(:has-text("Postpone"))`).last();
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    // Wait for enabled
    for (let i = 0; i < 30; i++) {
      const disabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
      if (disabled !== 'true') break;
      await page.waitForTimeout(500);
    }
    await postBtn.click({ force: true }).catch(async () => { await postBtn.click(); });

    // Wait for dialog to close (post published)
    await page.locator(dialogSel).first().waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Try to capture the new post URL by looking for the most recent permalink
    let postUrl = page.url();
    if (postUrl === beforeUrl || postUrl === 'https://www.facebook.com/') {
      const permalink = await page.locator('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]').first().getAttribute('href').catch(() => null);
      if (permalink) {
        postUrl = permalink.startsWith('http') ? permalink : `https://www.facebook.com${permalink}`;
      }
    }
    return { url: postUrl || 'https://facebook.com/' };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToFacebook };
