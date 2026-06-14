// LinkedIn post uploader using a persistent Chrome profile.
// Handles both the personal feed (/feed/) and Page admin URLs
// (linkedin.com/company/<id>/admin/page-posts/published/) where the composer
// auto-opens and we must NOT wait for a "Start a post" button.
const { launchPersistent, safeClose } = require('./social-post-base');

const LI_FEED_URL = 'https://www.linkedin.com/feed/';

async function isDialogOpen(page) {
  return await page.locator('div[role="dialog"] div[contenteditable="true"]').first().isVisible().catch(() => false);
}

async function openComposer(page) {
  // If a composer dialog is already mounted (Page admin auto-opens it), do nothing.
  if (await isDialogOpen(page)) return;

  // Try "Start a post" entry on the feed.
  const startBtn = page.locator(
    'button:has-text("Start a post"), button[aria-label*="Start a post" i], .share-box-feed-entry__trigger'
  ).first();
  if (await startBtn.isVisible().catch(() => false)) {
    await startBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
    if (await isDialogOpen(page)) return;
  }

  // Try "Create" on Page admin views.
  const createBtn = page.locator('button:has-text("Create"), a:has-text("Create")').first();
  if (await createBtn.isVisible().catch(() => false)) {
    await createBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
    const startPost = page.locator('button:has-text("Start a post"), [role="menuitem"]:has-text("Start a post")').first();
    if (await startPost.isVisible().catch(() => false)) {
      await startPost.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  // Final wait for the composer.
  await page.locator('div[role="dialog"] div[contenteditable="true"]').first()
    .waitFor({ state: 'visible', timeout: 20000 });
}

async function uploadToLinkedIn(imagePath, { description, hashtags = [] }, opts = {}) {
  const imageFiles = Array.isArray(imagePath) ? imagePath.filter(Boolean) : (imagePath ? [imagePath] : []);
  const context = await launchPersistent('linkedin', opts);
  try {
    const page = context.pages()[0] || await context.newPage();
    const targetUrl = (opts && opts.targetUrl && /^https?:\/\//i.test(opts.targetUrl)) ? opts.targetUrl : LI_FEED_URL;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const url = page.url();
    if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/uas/login')) {
      throw new Error('LinkedIn requires login. Use Prepare in Settings to log in once.');
    }

    await openComposer(page);

    const editor = page.locator('div[role="dialog"] div[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 15000 });
    await editor.click();
    await page.waitForTimeout(300);

    const fullText = hashtags.length
      ? `${description}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : (description || '');

    // Try insertText first (fastest), fall back to typing if the editor didn't pick it up.
    await page.keyboard.insertText(fullText).catch(() => {});
    await page.waitForTimeout(600);
    const currentText = await editor.innerText().catch(() => '');
    if (fullText && !currentText.trim()) {
      await editor.click();
      await page.keyboard.type(fullText, { delay: 10 });
      await page.waitForTimeout(500);
    }

    if (imageFiles.length) {
      const attachBtn = page.locator(
        'div[role="dialog"] button[aria-label*="photo" i], div[role="dialog"] button[aria-label*="image" i], div[role="dialog"] button[aria-label*="media" i]'
      ).first();
      await attachBtn.click({ trial: false }).catch(() => {});
      await page.waitForTimeout(500);
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(imageFiles).catch(() => {});
      await page.waitForTimeout(3000 + (imageFiles.length - 1) * 1500);
      // LinkedIn often shows a "Next" / "Done" button to confirm the image.
      for (let i = 0; i < 3; i++) {
        const nextBtn = page.locator(
          'div[role="dialog"] button:has-text("Next"), div[role="dialog"] button:has-text("Done")'
        ).first();
        if (await nextBtn.isVisible().catch(() => false)) {
          await nextBtn.click().catch(() => {});
          await page.waitForTimeout(1500);
        } else break;
      }
    }

    // Click Post — wait for it to enable. Filter out "Post settings" / "Post to anyone" buttons.
    const postBtn = page.locator(
      'div[role="dialog"] button.share-actions__primary-action, div[role="dialog"] button[aria-label="Post"], div[role="dialog"] button:has-text("Post"):not(:has-text("Post to")):not(:has-text("settings"))'
    ).first();
    await postBtn.waitFor({ state: 'visible', timeout: 20000 });
    for (let i = 0; i < 40; i++) {
      const disabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
      const isDisabled = await postBtn.isDisabled().catch(() => false);
      if (disabled !== 'true' && !isDisabled) break;
      await page.waitForTimeout(500);
    }
    await postBtn.click({ force: true }).catch(async () => {
      await postBtn.click();
    });

    // Wait for the dialog to disappear (post submitted).
    await page.waitForSelector('div[role="dialog"] div[contenteditable="true"]', { state: 'detached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    return { url: page.url() };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToLinkedIn };
