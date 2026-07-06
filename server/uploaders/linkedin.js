// LinkedIn post uploader using a persistent Chrome profile.
// Handles both the personal feed (/feed/) and Page admin URLs
// (linkedin.com/company/<id>/admin/page-posts/published/) where the composer
// auto-opens and we must NOT wait for a "Start a post" button.
const { launchPersistent, safeClose } = require('./social-post-base');

const LI_FEED_URL = 'https://www.linkedin.com/feed/';

async function isDialogOpen(page) {
  return await page.locator('div[role="dialog"] div[contenteditable="true"]').first().isVisible().catch(() => false);
}

async function getVisibleDialogCount(page) {
  return await page.locator('div[role="dialog"]:visible').count().catch(() => 0);
}

async function getComposerText(page) {
  return await page.locator('div[role="dialog"] div[contenteditable="true"]').first().innerText().catch(() => '');
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

async function countRealMediaPreviews(page) {
  return await page.locator('div[role="dialog"]').last().evaluate((dialog) => {
    const reject = /(avatar|profile|presence|actor|member|identity|entity-photo|ghost-person|article|external|url-preview|link-preview|third-party|embed)/i;
    const accept = /(share-images|share-media|media|image|photo|video|carousel|creation-state)/i;
    const nodes = Array.from(dialog.querySelectorAll('img, video, [style*="background-image"]'));
    return nodes.filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 80) return false;
      const chain = [];
      let cur = el;
      for (let i = 0; cur && i < 5; i++, cur = cur.parentElement) {
        chain.push(`${cur.className || ''} ${cur.getAttribute?.('data-test-id') || ''} ${cur.getAttribute?.('aria-label') || ''}`);
      }
      const text = chain.join(' ');
      if (reject.test(text)) return false;
      const src = el.getAttribute('src') || '';
      const style = el.getAttribute('style') || '';
      const explicitMedia = src.startsWith('blob:') || src.startsWith('data:image') || ((/media\.licdn|media-exp|dms\/image/i.test(src) || /background-image:\s*url/i.test(style)) && accept.test(text));
      return explicitMedia || accept.test(text);
    }).length;
  }).catch(() => 0);
}

async function waitForRealMediaPreview(page, expectedCount = 1, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await countRealMediaPreviews(page);
    if (count >= Math.max(1, expectedCount)) return true;
    await page.waitForTimeout(750);
  }
  return false;
}

function extractActivityUrn(str) {
  if (!str) return null;
  const m = String(str).match(/urn:li:activity:(\d+)|\/feed\/update\/urn%3Ali%3Aactivity%3A(\d+)|activity[-:](\d{15,25})|\/posts\/[^\/"?#]*-(\d{15,25})-/i);
  if (!m) return null;
  return m[1] || m[2] || m[3] || m[4] || null;
}

async function snapshotFeedActivityIds(page) {
  return await page.evaluate(() => {
    const ids = new Set();
    const rx = /urn:li:activity:(\d+)|activity[-:](\d{15,25})/gi;
    const html = document.documentElement.outerHTML;
    let m;
    while ((m = rx.exec(html)) !== null) ids.add(m[1] || m[2]);
    return Array.from(ids);
  }).catch(() => []);
}

async function resolvePostedLinkedInUrl(page, fallbackUrl, capturedUrn, beforeIds) {
  const before = new Set(beforeIds || []);
  if (capturedUrn && !before.has(capturedUrn)) return `https://www.linkedin.com/feed/update/urn:li:activity:${capturedUrn}/`;
  // Poll for a NEW activity URN not present before we clicked Post.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const now = await snapshotFeedActivityIds(page);
    const fresh = now.find((id) => !before.has(id));
    if (fresh) return `https://www.linkedin.com/feed/update/urn:li:activity:${fresh}/`;
    await page.waitForTimeout(1000);
  }
  return null;
}

async function getLinkedInSubmitState(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && r.width > 4 && r.height > 4;
    };
    const badText = /(post settings|post to|who can see|comment control|schedule|cancel|back|next|done)/i;
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(visible);
    const searchRoots = dialogs.length ? dialogs.slice().reverse() : [document];
    for (const root of searchRoots) {
      const buttons = Array.from(root.querySelectorAll('button, [role="button"]')).filter(visible);
      const exact = buttons.find((btn) => {
        const text = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim();
        if (!/^(post|publish|share|post anyway)$/i.test(text)) return false;
        if (badText.test(text) && !/^post anyway$/i.test(text)) return false;
        return true;
      });
      if (!exact) continue;
      const ariaDisabled = exact.getAttribute('aria-disabled') === 'true';
      const disabled = exact.disabled === true || ariaDisabled || exact.className?.toString?.().includes('disabled');
      const box = exact.getBoundingClientRect();
      return {
        found: true,
        enabled: !disabled,
        text: (exact.innerText || exact.textContent || exact.getAttribute('aria-label') || '').trim(),
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
      };
    }
    return { found: false, enabled: false, text: '', x: 0, y: 0 };
  }).catch(() => ({ found: false, enabled: false, text: '', x: 0, y: 0 }));
}

async function getLinkedInComposerError(page) {
  return await page.evaluate(() => {
    const text = Array.from(document.querySelectorAll('div[role="alert"], .artdeco-toast-item, [data-test-artdeco-toast-item-type], div[role="dialog"]'))
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 3000);
    const m = text.match(/(?:something went wrong|unable to post|couldn.?t post|failed to post|try again|review your post|unsupported|remove this|too long|exceeds|error)[^\n]{0,180}/i);
    return m ? m[0].trim() : '';
  }).catch(() => '');
}

async function clickLinkedInSubmit(page) {
  const locators = [
    page.locator('div[role="dialog"] button.share-actions__primary-action:visible').last(),
    page.locator('div[role="dialog"] button[aria-label="Post"]:visible').last(),
    page.locator('div[role="dialog"] button:has-text("Post anyway"):visible').last(),
    page.locator('div[role="dialog"] button:has-text("Post"):not(:has-text("Post to")):not(:has-text("settings")):visible').last(),
    page.locator('div[role="dialog"] button:has-text("Publish"):visible').last(),
    page.locator('div[role="dialog"] button:has-text("Share"):visible').last(),
  ];

  for (const locator of locators) {
    if (!(await locator.count().catch(() => 0))) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    const ariaDisabled = await locator.getAttribute('aria-disabled').catch(() => null);
    const disabled = await locator.isDisabled().catch(() => false);
    if (ariaDisabled === 'true' || disabled) continue;
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    if (await locator.click({ timeout: 5000 }).then(() => true).catch(() => false)) return true;
    if (await locator.click({ force: true, timeout: 5000 }).then(() => true).catch(() => false)) return true;
    const clickedByJs = await locator.evaluate((el) => { el.click(); return true; }).catch(() => false);
    if (clickedByJs) return true;
  }

  const state = await getLinkedInSubmitState(page);
  if (state.found && state.enabled && state.x && state.y) {
    await page.mouse.click(state.x, state.y).catch(() => {});
    return true;
  }
  return false;
}

async function waitForLinkedInSubmitReady(page, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const err = await getLinkedInComposerError(page);
    if (err) throw new Error(`LinkedIn refused the post: ${err}`);
    const state = await getLinkedInSubmitState(page);
    if (state.found && state.enabled) return state;
    await page.waitForTimeout(1000);
  }
  const state = await getLinkedInSubmitState(page);
  throw new Error(state.found
    ? `LinkedIn Post button stayed disabled (${state.text || 'Post'}). Media/text was not accepted by the composer.`
    : 'LinkedIn Post button was not found in the composer.');
}

async function submitLinkedInPost(page) {
  let lastError = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    await waitForLinkedInSubmitReady(page, attempt === 1 ? 60000 : 20000);
    const beforeDialogs = await getVisibleDialogCount(page);
    const clicked = await clickLinkedInSubmit(page);
    if (!clicked) {
      lastError = 'Post button was visible but automation could not click it.';
      await page.waitForTimeout(1000);
      continue;
    }

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const err = await getLinkedInComposerError(page);
      if (err) throw new Error(`LinkedIn refused the post: ${err}`);

      // Some LinkedIn safety flows open a second confirmation dialog. Press its
      // final Post/Publish button too instead of waiting forever on the composer.
      const dialogCount = await getVisibleDialogCount(page);
      const state = await getLinkedInSubmitState(page);
      if (dialogCount > beforeDialogs && state.found && state.enabled) {
        await clickLinkedInSubmit(page);
        await page.waitForTimeout(1500);
      }

      if (!(await isDialogOpen(page))) return true;
      const currentState = await getLinkedInSubmitState(page);
      if (!currentState.found || !currentState.enabled) {
        // Button disappeared/disabled after click: likely submitting. Keep waiting.
        await page.waitForTimeout(1000);
        continue;
      }
      await page.waitForTimeout(1000);
    }
    lastError = `LinkedIn composer stayed open after Post click attempt ${attempt}.`;
  }
  throw new Error(`${lastError || 'LinkedIn post was not confirmed.'} Post was not published.`);
}


async function attachImagesToComposer(page, imageFiles) {
  if (!imageFiles.length) return;
  const attachBtn = page.locator(
    'div[role="dialog"] button[aria-label*="photo" i], div[role="dialog"] button[aria-label*="image" i], div[role="dialog"] button[aria-label*="media" i], div[role="dialog"] button[aria-label*="add a photo" i]'
  ).first();
  const expectedCount = Math.min(imageFiles.length, 9);

  // Prefer LinkedIn's real file input when it already exists. This bypasses the
  // native Windows picker entirely and is more reliable than clicking the image
  // button first.
  let attached = false;
  const directInputs = [
    page.locator('div[role="dialog"] input[type="file"][accept*="image"]').last(),
    page.locator('input[type="file"][accept*="image"]').last(),
    page.locator('div[role="dialog"] input[type="file"]').last(),
  ];
  for (const input of directInputs) {
    if (!(await input.count().catch(() => 0))) continue;
    attached = await input.setInputFiles(imageFiles, { timeout: 12000 }).then(() => true).catch(() => false);
    if (attached) {
      console.log(`[LinkedIn] Selected ${imageFiles.length} image(s) through file input`);
      break;
    }
  }

  if (!attached) {
    await attachBtn.waitFor({ state: 'visible', timeout: 15000 });
    await attachBtn.scrollIntoViewIfNeeded().catch(() => {});

    // Start waiting BEFORE the click. LinkedIn often opens the native Windows file
    // picker directly; if we don't capture that FileChooser event, automation gets
    // stuck behind the popup shown in the user's screenshot.
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 }).catch(() => null);
    await attachBtn.click({ force: true }).catch(async () => { await attachBtn.click(); });
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(imageFiles);
      attached = true;
      console.log(`[LinkedIn] Selected ${imageFiles.length} image(s) through native file chooser`);
    }

    if (!attached) {
      await page.waitForTimeout(1000);
      const candidates = [
        page.locator('div[role="dialog"] input[type="file"][accept*="image"]').last(),
        page.locator('input[type="file"][accept*="image"]').last(),
        page.locator('input[type="file"]').last(),
      ];
      for (const input of candidates) {
        if (!(await input.count().catch(() => 0))) continue;
        attached = await input.setInputFiles(imageFiles, { timeout: 10000 }).then(() => true).catch(() => false);
        if (attached) break;
      }
    }
  }
  if (!attached) throw new Error('LinkedIn image picker opened but no controllable file input was found.');

  if (!(await waitForRealMediaPreview(page, expectedCount, 45000))) {
    throw new Error('LinkedIn image file was selected, but no real media preview appeared. Aborting to avoid a text-only post.');
  }
  // LinkedIn can render a preview before the upload is committed. Wait longer and
  // require the real preview to still be present before pressing Next/Done.
  await page.waitForTimeout(5000 + (imageFiles.length - 1) * 1500);
  if (!(await waitForRealMediaPreview(page, expectedCount, 10000))) {
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

  const finalCount = await countRealMediaPreviews(page);
  if (finalCount < expectedCount) {
    throw new Error('LinkedIn image was selected but no real preview remained in the post composer. Aborting to avoid a text-only post.');
  }
  console.log(`[LinkedIn] Confirmed ${finalCount}/${expectedCount} media preview(s) in composer`);
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

    const fullText = hashtags.length
      ? `${description}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : (description || '');

    await openComposer(page);

    // Attach media BEFORE inserting URLs/text. Otherwise LinkedIn may render a
    // large article link preview and our media checks can mistake that preview
    // for an uploaded photo, causing text/link-only posts.
    if (imageFiles.length) {
      await attachImagesToComposer(page, imageFiles);
    }

    const editor = page.locator('div[role="dialog"] div[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 15000 });
    await editor.click();
    await page.waitForTimeout(300);

    // Try insertText first (fastest), fall back to typing if the editor didn't pick it up.
    await page.keyboard.insertText(fullText).catch(() => {});
    await page.waitForTimeout(600);
    const currentText = await editor.innerText().catch(() => '');
    if (fullText && !currentText.trim()) {
      await editor.click();
      await page.keyboard.type(fullText, { delay: 10 });
      await page.waitForTimeout(500);
    }

    if (fullText && !(await getComposerText(page)).trim()) {
      throw new Error('LinkedIn composer accepted the media but not the post text. Aborting to avoid an empty/media-only post.');
    }

    if (imageFiles.length && !(await waitForRealMediaPreview(page, Math.min(imageFiles.length, 9), 10000))) {
      throw new Error('LinkedIn uploaded media was not present after filling the post text. Aborting to avoid a text-only post.');
    }

    // Snapshot existing activity URNs on the page BEFORE clicking Post, and
    // start listening for the create-post network response to capture the new URN.
    const beforeIds = await snapshotFeedActivityIds(page);
    let capturedUrn = null;
    const onResponse = async (resp) => {
      try {
        const url = resp.url();
        if (!/contentcreation|normShares|feed\/api|voyager\/api\/(contentcreation|feed)/i.test(url)) return;
        const fromUrl = extractActivityUrn(url);
        if (fromUrl) { capturedUrn = capturedUrn || fromUrl; return; }
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json') && !ct.includes('text')) return;
        const body = await resp.text().catch(() => '');
        const fromBody = extractActivityUrn(body);
        if (fromBody) capturedUrn = capturedUrn || fromBody;
      } catch {}
    };
    page.on('response', onResponse);

    try {
      await submitLinkedInPost(page);

      // Give the network response a moment to arrive.
      for (let i = 0; i < 20 && !capturedUrn; i++) await page.waitForTimeout(500);

      const posted = await resolvePostedLinkedInUrl(page, targetUrl, capturedUrn, beforeIds);
      if (!posted) {
        throw new Error('LinkedIn post was submitted but no new activity URL could be confirmed. Refusing to report a stale URL.');
      }
      return { url: posted };
    } finally {
      page.off('response', onResponse);
    }
  } finally {
    await safeClose(context);
  }
}


module.exports = { uploadToLinkedIn };
