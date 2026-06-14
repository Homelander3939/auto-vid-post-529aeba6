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

async function waitForRealMediaPreview(page, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await page.locator('div[role="dialog"] img').evaluateAll((imgs) => imgs.filter((img) => {
      const r = img.getBoundingClientRect();
      const src = img.getAttribute('src') || '';
      const cls = `${img.className || ''} ${(img.closest('[class]') || {}).className || ''}`.toLowerCase();
      const looksLikeMedia = src.startsWith('blob:') || src.includes('media-exp') || src.includes('media.licdn') || cls.includes('image') || cls.includes('media');
      const bigEnough = r.width >= 90 && r.height >= 70;
      const notAvatar = !cls.includes('avatar') && !cls.includes('presence-entity') && !cls.includes('profile');
      return looksLikeMedia && bigEnough && notAvatar;
    }).length).catch(() => 0);
    if (count > 0) return true;
    await page.waitForTimeout(750);
  }
  return false;
}

async function resolvePostedLinkedInUrl(page, fallbackUrl) {
  await page.waitForTimeout(5000);
  const href = await page.locator(
    'a[href*="/feed/update/"], a[href*="urn:li:activity"], a[href*="/posts/"]'
  ).first().getAttribute('href').catch(() => null);
  if (href) {
    const absolute = href.startsWith('http') ? href : `https://www.linkedin.com${href.startsWith('/') ? '' : '/'}${href}`;
    return absolute.split('?')[0];
  }
  return fallbackUrl || page.url();
}

async function attachImagesToComposer(page, imageFiles) {
  const attachBtn = page.locator(
    'div[role="dialog"] button[aria-label*="photo" i], div[role="dialog"] button[aria-label*="image" i], div[role="dialog"] button[aria-label*="media" i], div[role="dialog"] button[aria-label*="add a photo" i]'
  ).first();
  await attachBtn.waitFor({ state: 'visible', timeout: 15000 });
  await attachBtn.scrollIntoViewIfNeeded().catch(() => {});

  // Start waiting BEFORE the click. LinkedIn often opens the native Windows file
  // picker directly; if we don't capture that FileChooser event, automation gets
  // stuck behind the popup shown in the user's screenshot.
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
  await attachBtn.click({ force: true }).catch(async () => { await attachBtn.click(); });
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(imageFiles);
    console.log(`[LinkedIn] Selected ${imageFiles.length} image(s) through native file chooser`);
  } else {
    await page.waitForTimeout(1000);
    const candidates = [
      page.locator('div[role="dialog"] input[type="file"][accept*="image"]').last(),
      page.locator('input[type="file"][accept*="image"]').last(),
      page.locator('input[type="file"]').last(),
    ];
    let attached = false;
    for (const input of candidates) {
      if (!(await input.count().catch(() => 0))) continue;
      attached = await input.setInputFiles(imageFiles, { timeout: 10000 }).then(() => true).catch(() => false);
      if (attached) break;
    }
    if (!attached) throw new Error('LinkedIn image picker opened but no controllable file input was found.');
  }

  if (!(await waitForRealMediaPreview(page, 45000))) {
    throw new Error('LinkedIn image file was selected, but no real media preview appeared. Aborting to avoid a text-only post.');
  }
  // LinkedIn can render a preview before the upload is committed. Wait longer and
  // require the real preview to still be present before pressing Next/Done.
  await page.waitForTimeout(5000 + (imageFiles.length - 1) * 1500);
  if (!(await waitForRealMediaPreview(page, 10000))) {
    throw new Error('LinkedIn image preview disappeared before it was attached. Aborting to avoid a text-only post.');
  }

  // Confirm the media dialog and return to the main composer.
  for (let i = 0; i < 4; i++) {
    const nextBtn = page.locator(
      'div[role="dialog"] button:has-text("Next"), div[role="dialog"] button:has-text("Done"), div[role="dialog"] button[aria-label="Next"], div[role="dialog"] button[aria-label="Done"]'
    ).last();
    if (!(await nextBtn.isVisible().catch(() => false))) break;
    for (let wait = 0; wait < 12; wait++) {
      const disabled = await nextBtn.getAttribute('aria-disabled').catch(() => null);
      const isDisabled = await nextBtn.isDisabled().catch(() => false);
      if (disabled !== 'true' && !isDisabled) break;
      await page.waitForTimeout(500);
    }
    await nextBtn.click({ force: true }).catch(async () => { await nextBtn.click(); });
    await page.waitForTimeout(2000);
  }

  if (!(await waitForRealMediaPreview(page, 20000))) {
    throw new Error('LinkedIn image was selected but no real preview remained in the post composer. Aborting to avoid a text-only post.');
  }
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
      await attachImagesToComposer(page, imageFiles);
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
    return { url: await resolvePostedLinkedInUrl(page, targetUrl) };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToLinkedIn };
