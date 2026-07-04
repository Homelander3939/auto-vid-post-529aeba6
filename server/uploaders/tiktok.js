const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill, analyzePage, waitForStateChange, runAgentTask } = require('./smart-agent');
const { sendTelegramPhoto, sendTelegram } = require('../telegram');
const { getTikTokPageDescription, isTikTokPublishedUrl, isTikTokVideoUrl } = require('./tiktok-state');
const { getSharedBrowserProfileDir } = require('../browserProfiles');
const { dismissOverlayBlockingFlow } = require('./overlay-dismiss');
const { launchPersistentSafe } = require('../profileLock');

const DEFAULT_USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'tiktok');

function resolveUserDataDir(browserProfileId, accountId) {
  if (browserProfileId) return getSharedBrowserProfileDir(browserProfileId);
  if (!accountId) return DEFAULT_USER_DATA_DIR;
  return path.join(__dirname, '..', 'data', 'browser-sessions', 'tiktok', accountId);
}


// TikTok Studio upload URL (updated — old /creator-center/upload no longer works)
const TIKTOK_UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';
const TIKTOK_UPLOAD_URL_ALT = 'https://www.tiktok.com/creator-center/upload';
const MAX_CAPTION_LENGTH = 2200;
const MAX_FAILURE_VISIBLE_TEXT_LENGTH = 240;
const MAX_FAILURE_MESSAGE_LENGTH = 500;
const MAX_TELEGRAM_DIAGNOSTIC_CAPTION_LENGTH = 900;
// How many 5-second polling intervals to wait for the Post button to become enabled (24 × 5s = 120s)
const MAX_POST_BUTTON_WAIT_ATTEMPTS = 24;

function normalizeTikTokVideoUrl(candidate = '') {
  const raw = String(candidate || '').trim();
  if (!raw) return '';

  let absolute = raw;
  if (raw.startsWith('/')) {
    absolute = `https://www.tiktok.com${raw}`;
  } else if (!/^https?:\/\//i.test(raw)) {
    absolute = `https://${raw.replace(/^\/+/, '')}`;
  }

  if (!isTikTokVideoUrl(absolute)) return '';

  try {
    const parsed = new URL(absolute);
    if (!parsed.hostname.includes('tiktok.com')) return '';
    return `https://www.tiktok.com${parsed.pathname}`;
  } catch {
    return '';
  }
}

async function extractTikTokVideoUrl(page) {
  // First try: direct links in DOM
  const domUrl = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href') || '')
      .filter((href) => href.includes('/video/'));
    return candidates[0] || '';
  }).catch(() => '');
  const normalizedDomUrl = normalizeTikTokVideoUrl(domUrl);
  if (normalizedDomUrl) return normalizedDomUrl;

  // Second try: URL bar
  const normalizedPageUrl = normalizeTikTokVideoUrl(page.url());
  if (normalizedPageUrl) return normalizedPageUrl;

  // Third try: parse visible text references to @user/video/id links
  const textUrl = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const match = text.match(/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/i);
    return match?.[0] || '';
  }).catch(() => '');

  return normalizeTikTokVideoUrl(textUrl);
}

async function assessTikTokCompletion(page) {
  const currentUrl = page.url();
  const dom = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const success =
      text.includes('posted') ||
      text.includes('your video is being uploaded') ||
      text.includes('your video is being processed') ||
      text.includes('video uploaded') ||
      text.includes('successfully') ||
      text.includes('upload complete') ||
      text.includes('your video has been') ||
      text.includes('published');
    const hardError =
      text.includes('upload failed') ||
      text.includes('couldn\'t upload') ||
      text.includes('try again later');
    return { success, hardError, summary: text.slice(0, 1200) };
  }).catch(() => ({ success: false, hardError: false, summary: '' }));

  if (dom.success) return { success: true, reason: 'TikTok UI shows upload/post completion.' };
  if (dom.hardError) return { success: false, needsHuman: true, reason: 'TikTok UI shows an upload/post error.' };
  if (isTikTokPublishedUrl(currentUrl)) {
    return { success: true, reason: `TikTok redirected to ${getTikTokPageDescription(currentUrl)}.` };
  }

  try {
    const ai = await analyzePage(page, 'TikTok post-completion check. Decide if upload succeeded/processing, or needs manual help.');
    const state = String(ai?.state || '').toLowerCase();
    if (['success', 'processing', 'uploading'].includes(state)) {
      return { success: true, reason: ai?.description || 'AI detected successful upload processing state.' };
    }
    return {
      success: false,
      needsHuman: Boolean(ai?.needs_human),
      reason: ai?.description || 'No clear TikTok completion signal found.',
    };
  } catch {
    return { success: false, needsHuman: false, reason: 'No clear TikTok completion signal found.' };
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateText(text, maxLength = 220) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

async function collectTikTokFailureDiagnostics(page, fallbackReason) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => (
    document.body?.innerText || ''
  )).catch(() => '');

  let aiDescription = '';
  try {
    const ai = await analyzePage(
      page,
      'TikTok upload failed after clicking Post. Briefly describe the exact screen, blocker, or current state.',
    );
    aiDescription = String(ai?.description || '');
  } catch {}

  return {
    reason: fallbackReason,
    url,
    title,
    pageDescription: getTikTokPageDescription(url),
    aiDescription,
    bodyText: truncateText(bodyText, MAX_FAILURE_VISIBLE_TEXT_LENGTH),
  };
}

function formatTikTokFailureMessage(diagnostics) {
  const details = [
    diagnostics.reason,
    diagnostics.aiDescription && diagnostics.aiDescription !== diagnostics.reason ? `AI: ${diagnostics.aiDescription}` : '',
    diagnostics.pageDescription ? `Page: ${diagnostics.pageDescription}` : '',
    diagnostics.url ? `URL: ${diagnostics.url}` : '',
    diagnostics.bodyText ? `Visible text: ${diagnostics.bodyText}` : '',
  ].filter(Boolean);

  return truncateText(details.join(' | '), MAX_FAILURE_MESSAGE_LENGTH);
}

async function navigateToTikTokUpload(page) {
  const urls = [
    TIKTOK_UPLOAD_URL,
    TIKTOK_UPLOAD_URL_ALT,
    'https://www.tiktok.com/upload',
    'https://www.tiktok.com/tiktokstudio/upload?lang=en',
  ];

  const hasUploadSurface = async () => {
    const hasFileInput = await page.$('input[type="file"]').catch(() => null);
    if (hasFileInput) return true;
    return page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return (
        text.includes('select video') ||
        text.includes('select file') ||
        text.includes('drag and drop') ||
        text.includes('drop it here') ||
        text.includes('upload video') ||
        text.includes('size and duration')
      );
    }).catch(() => false);
  };

  // Try to dismiss any blocking exit/leave dialog before navigating away
  const dismissBlockingLeaveDialog = async () => {
    try {
      await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        if (
          text.includes('leave') || text.includes('exit') ||
          text.includes('cancel your upload') || text.includes('discard')
        ) {
          const buttons = document.querySelectorAll('button, div[role="button"]');
          for (const btn of buttons) {
            const t = (btn.textContent || '').trim().toLowerCase();
            if (['leave', 'discard', 'yes', 'ok', 'confirm'].includes(t)) {
              btn.click();
              return;
            }
          }
        }
      });
    } catch {}
  };

  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`[TikTok] Navigating to upload page: ${url} (attempt ${attempt})`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e) {
        console.warn('[TikTok] Upload URL navigation warning:', e.message);
      }
      // Wait progressively up to ~12s, polling for upload surface
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(2000);
        if (await hasUploadSurface()) {
          console.log('[TikTok] Upload surface detected.');
          return true;
        }
      }
      await dismissBlockingLeaveDialog();
    }
  }

  // Last-resort diagnostic
  try {
    const u = page.url();
    const snippet = await page.evaluate(() => (document.body?.innerText || '').slice(0, 300)).catch(() => '');
    console.warn(`[TikTok] Upload surface not found. URL=${u} | text="${snippet.replace(/\s+/g, ' ')}"`);
  } catch {}
  return false;
}

async function dismissExitDialog(page) {
  // TikTok shows custom modals when navigating away or cancelling an upload.
  // "Sure you want to cancel your upload?" → click "No"
  // "Are you sure you want to exit?" → click "Cancel" / "Stay"
  // Always dismiss these to stay on the page and let the upload finish.
  try {
    const dismissed = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const isExitDialog =
        (text.includes('sure you want to cancel') && text.includes('upload')) ||
        (text.includes('are you sure') && (text.includes('exit') || text.includes('leave') || text.includes('cancel')));

      if (isExitDialog) {
        const buttons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          const btnText = (btn.textContent || '').trim().toLowerCase();
          // "No" dismisses the cancel-upload dialog; "Cancel"/"Stay"/"Keep editing" dismiss the exit dialogs
          if (btnText === 'no' || btnText === 'cancel' || btnText === 'stay' || btnText === 'keep editing') {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });
    if (dismissed) console.log('[TikTok] Dismissed exit confirmation dialog');
    return dismissed;
  } catch { return false; }
}

async function acceptContinueToPostDialog(page) {
  try {
    const clicked = await page.evaluate(() => {
      const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="dialog" i]'));

      const findPostNowButton = (root) => {
        const buttons = Array.from(root.querySelectorAll('button, div[role="button"]'));
        return buttons.find((btn) => {
          const text = normalize(btn.textContent);
          const label = normalize(btn.getAttribute('aria-label'));
          return (
            text === 'post now' ||
            text.includes('continue to post') ||
            text.includes('continue posting') ||
            label === 'post now' ||
            label.includes('continue to post') ||
            label.includes('continue posting')
          );
        });
      };

      for (const dialog of dialogs) {
        const text = normalize(dialog.textContent);
        const isContinueDialog =
          (text.includes('continue to post') || text.includes('continue posting')) &&
          (text.includes('check is complete') || text.includes('checking your video') || text.includes('potential issues'));
        if (!isContinueDialog) continue;

        const btn = findPostNowButton(dialog);
        if (btn) {
          btn.click();
          return true;
        }
      }

      // Fallback if modal isn't correctly marked as dialog
      const bodyText = normalize(document.body?.innerText);
      const bodyLooksLikeContinuePrompt =
        bodyText.includes('continue to post') &&
        (bodyText.includes('check is complete') || bodyText.includes('checking your video'));
      if (!bodyLooksLikeContinuePrompt) return false;

      const fallbackBtn = findPostNowButton(document);
      if (fallbackBtn) {
        fallbackBtn.click();
        return true;
      }

      return false;
    });

    if (clicked) {
      console.log('[TikTok] Accepted "Continue to post" dialog via "Post now"');
      return true;
    }
  } catch {}

  const clickedViaSelector = await smartClick(page, [
    '[role="dialog"] button:has-text("Post now")',
    'button:has-text("Post now")',
    'div[role="button"]:has-text("Post now")',
    'button:has-text("Continue to post")',
  ], 'Post now');

  if (clickedViaSelector) {
    console.log('[TikTok] Accepted "Continue to post" dialog via selector fallback');
  }

  return clickedViaSelector;
}

async function waitForVideoProcessing(page, maxWaitSeconds = 240) {
  // Wait for TikTok to finish processing the uploaded video file before attempting to post.
  // Checks for explicit upload-complete indicator and absence of any active progress signals.
  // NOTE: TikTok shows the caption editor and Post button even while the upload is still in
  // progress, so we must NOT rely solely on their presence — we must also confirm that there
  // is no active upload percentage or progress bar visible.
  console.log('[TikTok] Waiting for video processing to complete...');
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  for (let attempt = 0; attempt < Math.ceil(maxWaitSeconds / 5); attempt++) {
    if (Date.now() - startTime > maxWaitMs) break;

    const state = await page.evaluate(() => {
      const rawText = document.body?.innerText || '';
      const text = rawText.toLowerCase();

      // Active upload: percentage like "45.77%" or "seconds left" / "minutes left" are strong signals
      const hasProgressPercent = /\b\d+(\.\d+)?%/.test(rawText) && !rawText.includes('100%');
      const hasTimeLeft = text.includes('seconds left') || text.includes('minutes left');
      const hasProgressBar = !!(
        document.querySelector('[role="progressbar"]') ||
        document.querySelector('progress')
      );

      const isUploading =
        text.includes('uploading') ||
        text.includes('% uploaded') ||
        text.includes('processing video') ||
        hasProgressPercent ||
        hasTimeLeft;

      // Explicit upload-done signal (not just presence of "uploaded" which can appear in filenames)
      const uploadDone =
        text.includes('upload complete') ||
        text.includes('video uploaded') ||
        (text.includes('uploaded') && !text.includes('uploading') && !hasProgressPercent && !hasTimeLeft && !hasProgressBar);

      // Check for an ENABLED Post button (not just existence — TikTok shows it disabled during upload)
      const postBtnEl =
        document.querySelector('button[data-e2e="post-button"]') ||
        Array.from(document.querySelectorAll('button, div[role="button"]')).find(
          b => /^(post|publish)$/i.test((b.textContent || '').trim())
        );
      const hasPostBtn = !!postBtnEl;
      const hasEnabledPostBtn = !!(postBtnEl &&
        !postBtnEl.disabled &&
        postBtnEl.getAttribute('aria-disabled') !== 'true' &&
        !postBtnEl.classList.toString().toLowerCase().includes('disabled'));

      const hasCaption = !!(
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector('textarea')
      );
      return { isUploading, uploadDone, hasPostBtn, hasEnabledPostBtn, hasCaption, hasProgressPercent, hasProgressBar };
    }).catch(() => ({ isUploading: false, uploadDone: false, hasPostBtn: false, hasEnabledPostBtn: false, hasCaption: false, hasProgressPercent: false, hasProgressBar: false }));

    // Dismiss any exit dialog that may appear
    await dismissExitDialog(page);
    await acceptContinueToPostDialog(page);

    // Only treat as done when there are no active progress indicators AND Post button is enabled
    if (state.uploadDone ||
        (state.hasEnabledPostBtn && state.hasCaption && !state.isUploading && !state.hasProgressPercent && !state.hasProgressBar)) {
      console.log(`[TikTok] Video processing complete (${Math.round((Date.now() - startTime) / 1000)}s)`);
      return true;
    }

    if (state.hasPostBtn && !state.hasEnabledPostBtn && !state.isUploading) {
      console.log(`[TikTok] Post button exists but is still disabled... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
    } else if (state.isUploading || state.hasProgressPercent) {
      console.log(`[TikTok] Video still uploading... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
    }

    await page.waitForTimeout(5000);
  }

  console.warn('[TikTok] Video processing wait timed out, proceeding anyway');
  return false;
}

async function waitForPublishConfirmation(page, maxWaitSeconds = 300) {
  // After clicking Post, wait for TikTok to confirm the video is published/queued.
  // This is critical — exiting too early triggers "Sure you want to cancel your upload?"
  console.log('[TikTok] Waiting for publish confirmation...');
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  let stagnantEnabledPostTicks = 0;
  for (let attempt = 0; attempt < Math.ceil(maxWaitSeconds / 5); attempt++) {
    if (Date.now() - startTime > maxWaitMs) break;

    // Dismiss any exit dialog that may appear
    await dismissExitDialog(page);

    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const isPublishing =
        text.includes('posting') ||
        text.includes('publishing') ||
        text.includes('sharing') ||
        text.includes('uploading to tiktok');
      // TikTok success: explicit published messages OR redirect back to upload/manage page
      const isPublished =
        text.includes('your video has been published') ||
        text.includes('post published') ||
        text.includes('uploaded successfully') ||
        text.includes('your post is now live') ||
        text.includes('manage your posts') ||
        text.includes('video posted') ||
        text.includes('post successful') ||
        text.includes('submit successful') ||
        text.includes('your video will be') ||
        text.includes('your video is now') ||
        // "your video is being uploaded to tiktok" means it was accepted and is now processing in background
        text.includes('your video is being uploaded to tiktok') ||
        text.includes('video is being processed') ||
        text.includes('video is being uploaded');
      // TikTok often redirects back to the upload page or content page after a successful post
      const backToUpload =
        text.includes('select video to upload') ||
        text.includes('select video') ||
        text.includes('drag and drop');
      const url = window.location.href;
      // TikTok Studio content/manage page — video was submitted
      const onManagePage =
        url.includes('/content') ||
        url.includes('/manage') ||
        url.includes('tiktokstudio/content') ||
        url.includes('creator-center/content');
      const postBtn =
        document.querySelector('button[data-e2e="post-button"]') ||
        Array.from(document.querySelectorAll('button, div[role="button"]')).find(
          (b) => /^(post|publish)$/i.test((b.textContent || '').trim()),
        );
      const hasEnabledPostBtn = Boolean(
        postBtn &&
        !postBtn.disabled &&
        postBtn.getAttribute('aria-disabled') !== 'true' &&
        !postBtn.classList.toString().toLowerCase().includes('disabled'),
      );
      return { isPublishing, isPublished, backToUpload, onManagePage, hasEnabledPostBtn, url };
    }).catch(() => ({
      isPublishing: false,
      isPublished: false,
      backToUpload: false,
      onManagePage: false,
      hasEnabledPostBtn: false,
      url: '',
    }));

    if (state.isPublished || state.backToUpload || state.onManagePage) {
      console.log(`[TikTok] Video published/queued! (${Math.round((Date.now() - startTime) / 1000)}s)`);
      return true;
    }

    if (!state.isPublishing && state.hasEnabledPostBtn) {
      stagnantEnabledPostTicks += 1;
      if (stagnantEnabledPostTicks >= 6) {
        console.warn('[TikTok] Post button stayed enabled with no publish progress — likely click did not trigger submission');
        return false;
      }
    } else {
      stagnantEnabledPostTicks = 0;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (state.isPublishing) {
      console.log(`[TikTok] Still publishing... (${elapsed}s)`);
    } else if (attempt % 6 === 0) {
      // Every ~30s log current URL to aid debugging
      console.log(`[TikTok] Waiting for confirmation... (${elapsed}s)`);
    }

    await page.waitForTimeout(5000);
  }

  // Last-ditch check: navigate to content page to see if video was successfully submitted
  try {
    const shouldCheckContentPage = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const postBtn =
        document.querySelector('button[data-e2e="post-button"]') ||
        Array.from(document.querySelectorAll('button, div[role="button"]')).find(
          (b) => /^(post|publish)$/i.test((b.textContent || '').trim()),
        );
      const postEnabled = Boolean(
        postBtn &&
        !postBtn.disabled &&
        postBtn.getAttribute('aria-disabled') !== 'true' &&
        !postBtn.classList.toString().toLowerCase().includes('disabled'),
      );
      const stillEditingUpload =
        text.includes('replace') &&
        text.includes('description') &&
        text.includes('who can watch this video') &&
        postEnabled;
      return !stillEditingUpload;
    }).catch(() => true);

    if (!shouldCheckContentPage) {
      console.log('[TikTok] Skipping content-page fallback — upload editor is still active and Post can still be clicked');
      return false;
    }

    const currentUrl = page.url();
    if (!currentUrl.includes('/content') && !currentUrl.includes('/manage')) {
      console.log('[TikTok] Checking content page for recently posted video...');
      await page.goto('https://www.tiktok.com/tiktokstudio/content', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(4000);
      const hasContent = await page.evaluate(() => {
        const url = window.location.href;
        const text = (document.body?.innerText || '').toLowerCase();
        return url.includes('/content') || url.includes('/manage') ||
          text.includes('your videos') || !!document.querySelector('a[href*="/video/"]');
      }).catch(() => false);
      if (hasContent) {
        console.log('[TikTok] Content page reached — video was submitted successfully');
        return true;
      }
    }
  } catch (e) {
    console.warn('[TikTok] Content page check failed:', e.message);
  }

  console.warn('[TikTok] Publish confirmation timed out');
  return false;
}

async function uploadToTikTok(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  const userDataDir = resolveUserDataDir(credentials?.browserProfileId, credentials?.accountId);
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`[TikTok] Starting upload... (profile: ${credentials?.browserProfileId || credentials?.accountId || 'default'})`);
  const context = await launchPersistentSafe(chromium, userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  }, { label: `tiktok:${credentials?.browserProfileId || credentials?.accountId || 'default'}` });

  let page = context.pages()[0] || await context.newPage();

  // Handle native browser beforeunload dialogs (auto-dismiss to stay on page)
  page.on('dialog', async (dialog) => {
    console.log(`[TikTok] Browser dialog: "${dialog.message()}" — dismissing to stay on page`);
    await dialog.dismiss().catch(() => {});
  });

  // Background watcher: TikTok periodically shows promo modals like
  // "New editing features added — Got it" that block the upload flow.
  // Poll every ~2.5s and dismiss any visible "Got it / OK / Dismiss" button
  // inside a dialog. Skip background-click to avoid accidental form clicks.
  const promoWatcher = setInterval(() => {
    dismissOverlayBlockingFlow(page, {
      logPrefix: '[TikTok][PromoWatcher]',
      clickBackground: false,
    }).catch(() => {});
  }, 2500);

  try {
    // ===== PHASE 1: NAVIGATE TO UPLOAD PAGE =====
    const navigated = await navigateToTikTokUpload(page);
    if (!navigated) throw new Error('Could not navigate to TikTok upload page.');
    await page.waitForTimeout(2000);

    // ===== PHASE 1b: LOGIN IF NEEDED =====
    let loginAttempts = 0;
    while (loginAttempts++ < 15) {
      const url = page.url();

      // Check if we have a file input (means we're logged in and on upload page)
      const hasFileInput = await page.$('input[type="file"]');
      if (hasFileInput) {
        console.log('[TikTok] Logged in, upload page ready');
        break;
      }

      // Check if we're on the upload page without file input (page still loading)
      if ((url.includes('tiktokstudio/upload') || url.includes('creator-center/upload')) && !url.includes('login')) {
        // Wait a bit more for the page to fully render
        await page.waitForTimeout(3000);
        const retryInput = await page.$('input[type="file"]');
        if (retryInput) {
          console.log('[TikTok] Upload page loaded after wait');
          break;
        }
        // Try clicking "Select video" button which might reveal file input
        await page.evaluate(() => {
          const buttons = document.querySelectorAll('button, div[role="button"]');
          for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase();
            if (text.includes('select') || text.includes('upload') || text.includes('video')) {
              btn.click();
              return;
            }
          }
        });
        await page.waitForTimeout(2000);
        const retryInput2 = await page.$('input[type="file"]');
        if (retryInput2) break;
      }

      // Check for login page
      if (url.includes('login') || url.includes('passport')) {
        const pageState = await page.evaluate(() => {
          const hasEmail = !!document.querySelector('input[name="username"], input[type="email"], input[type="text"][placeholder*="email" i], input[type="text"][placeholder*="phone" i]');
          const hasPassword = !!document.querySelector('input[type="password"]');
          const hasCode = !!document.querySelector('input[type="tel"], input[name*="code" i]');
          return { hasEmail, hasPassword, hasCode };
        });

        // Try to switch to email/password login
        await page.evaluate(() => {
          const links = document.querySelectorAll('a, div[role="link"], span, p');
          for (const link of links) {
            const text = link.textContent?.toLowerCase() || '';
            if (text.includes('email') || text.includes('password') || text.includes('log in with email')) {
              link.click(); return;
            }
          }
        });
        await page.waitForTimeout(1500);

        if (pageState.hasEmail || pageState.hasPassword) {
          console.log('[TikTok] Filling login credentials...');
          await smartFill(page, [
            'input[name="username"]', 'input[type="email"]',
            'input[type="text"][placeholder*="email" i]', 'input[type="text"]',
          ], credentials.email);
          await page.waitForTimeout(500);

          if (pageState.hasPassword) {
            await smartFill(page, ['input[type="password"]'], credentials.password);
            await page.waitForTimeout(500);
            await smartClick(page, ['button[type="submit"]', 'button[data-e2e="submit-button"]'], 'Log in');
            await page.waitForTimeout(5000);
          }
          continue;
        }

        if (pageState.hasCode) {
          console.log('[TikTok] Verification code needed...');
          const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
          const approval = await requestTelegramApproval({
            telegram: credentials.telegram,
            platform: 'TikTok',
            backend: credentials.backend,
            screenshotBuffer,
            customMessage: '🔐 <b>TikTok verification needed</b>\nReply with APPROVED after device confirmation or CODE 123456 if a code is required.',
          });
          if (approval?.code) {
            await tryFillVerificationCode(page, approval.code);
            await page.waitForTimeout(5000);
          }
          continue;
        }
      }

      await page.waitForTimeout(3000);
    }

    // ===== PHASE 1c: RECOVER FROM "Something went wrong / Retry" =====
    let recoveryAttempts = 0;
    while (recoveryAttempts < 3) {
      const hasFile = await page.$('input[type="file"]').catch(() => null);
      if (hasFile) break;
      const broken = await page.evaluate(() => {
        const t = (document.body?.innerText || '').toLowerCase();
        return t.includes('something went wrong') || t.includes('please try again');
      }).catch(() => false);
      if (!broken) break;

      recoveryAttempts++;
      console.log(`[TikTok] Detected "Something went wrong" — opening fresh tab (attempt ${recoveryAttempts})`);
      await sendTelegram(
        credentials?.telegram?.botToken,
        credentials?.telegram?.chatId,
        `⚠️ TikTok upload page hit an error — reopening in a new tab (attempt ${recoveryAttempts}/3).`,
        credentials?.backend,
      ).catch(() => {});

      try {
        const fresh = await context.newPage();
        await fresh.goto(TIKTOK_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await fresh.waitForTimeout(4000);
        const ok = await fresh.$('input[type="file"]').catch(() => null);
        if (ok) {
          try { await page.close(); } catch {}
          page = fresh;
          console.log('[TikTok] Recovered upload page in new tab');
          break;
        } else {
          await fresh.goto('https://www.tiktok.com/creator-center/upload', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await fresh.waitForTimeout(4000);
          const ok2 = await fresh.$('input[type="file"]').catch(() => null);
          if (ok2) {
            try { await page.close(); } catch {}
            page = fresh;
            break;
          }
          try { await fresh.close(); } catch {}
        }
      } catch (e) {
        console.warn('[TikTok] Recovery tab failed:', e.message);
      }
      await page.waitForTimeout(3000);
    }

    // ===== PHASE 2: UPLOAD VIDEO =====
    console.log('[TikTok] Setting video file...');
    let fileUploaded = false;

    // Strategy 1: Direct setInputFiles on existing file input (works for hidden inputs)
    let fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      // Also check all frames (TikTok may embed upload in iframe)
      try {
        for (const frame of page.frames()) {
          fileInput = await frame.$('input[type="file"]').catch(() => null);
          if (fileInput) break;
        }
      } catch (e) {
        console.warn('[TikTok] Frame search for file input failed:', e.message);
      }
    }

    if (fileInput) {
      try {
        await fileInput.setInputFiles(videoPath);
        fileUploaded = true;
        console.log('[TikTok] Video set via direct file input');
      } catch (e) {
        console.warn('[TikTok] Direct setInputFiles failed:', e.message);
      }
    }

    // Strategy 2: Use fileChooser event + click "Select video" button
    if (!fileUploaded) {
      console.log('[TikTok] Trying fileChooser event pattern...');
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          (async () => {
            // Try clicking the Select video button
            const clicked = await smartClick(page, [
              'button:has-text("Select video")',
              'button:has-text("Select file")',
              'button:has-text("Upload")',
              'div[role="button"]:has-text("Select")',
              'label:has-text("Select")',
            ], 'Select video');
            if (!clicked) {
              // DOM-based button click
              await page.evaluate(() => {
                const btns = document.querySelectorAll('button, div[role="button"], label');
                for (const btn of btns) {
                  const t = (btn.textContent || '').toLowerCase();
                  if (t.includes('select video') || t.includes('select file') || t.includes('upload video')) {
                    btn.click();
                    return;
                  }
                }
                // Click the upload area itself
                const area = document.querySelector('[class*="upload"], [class*="Upload"]');
                if (area) area.click();
              });
            }
          })(),
        ]);
        await fileChooser.setFiles(videoPath);
        fileUploaded = true;
        console.log('[TikTok] Video set via fileChooser event');
      } catch (e) {
        console.warn('[TikTok] fileChooser pattern failed:', e.message);
      }
    }

    // Strategy 3: Force-find and make file input accept files
    if (!fileUploaded) {
      console.log('[TikTok] Trying force file input discovery...');
      const discovered = await page.evaluate(() => {
        // Find ANY file input, even deeply hidden ones
        const inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length > 0) {
          // Make it interactable
          inputs[0].style.display = 'block';
          inputs[0].style.opacity = '1';
          inputs[0].style.position = 'fixed';
          inputs[0].style.top = '0';
          inputs[0].style.left = '0';
          inputs[0].style.zIndex = '999999';
          return true;
        }
        return false;
      });
      if (discovered) {
        fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles(videoPath);
          fileUploaded = true;
          console.log('[TikTok] Video set via forced file input');
        }
      }
    }

    if (!fileUploaded) throw new Error('TikTok upload failed: could not set video file. Try logging in manually at https://www.tiktok.com/tiktokstudio/upload first.');

    console.log('[TikTok] Video file set, waiting for processing...');
    
    // Wait for video to fully upload and process before proceeding
    await waitForVideoProcessing(page, 240);

    // ===== PHASE 3: FILL CAPTION =====
    if (metadata?.description || (metadata?.tags && metadata.tags.length > 0)) {
      const captionParts = [];
      if (metadata.description) captionParts.push(metadata.description);
      if (metadata.tags?.length) captionParts.push(metadata.tags.map(t => t.startsWith('#') ? t : '#' + t).join(' '));
      const caption = captionParts.join('\n\n').trim();
      console.log(`[TikTok] Caption to fill (${caption.length} chars): ${caption.slice(0, 200)}...`);
      console.log('[TikTok] Setting caption...');
      
      let captionFilled = false;

      // Strategy 1: Find the caption editor and use keyboard approach (most reliable)
      const editorSelectors = [
        '[contenteditable="true"][data-text]',
        '[data-e2e="caption-editor"] [contenteditable="true"]',
        '.public-DraftEditor-content[contenteditable="true"]',
        '[class*="caption"] [contenteditable="true"]',
        '[class*="editor"] [contenteditable="true"]',
        '.DraftEditor-root [contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea',
      ];

      for (const sel of editorSelectors) {
        if (captionFilled) break;
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;

          await el.click();
          await page.waitForTimeout(300);
          // Select all existing text and replace
          await page.keyboard.press('Control+a');
          await page.waitForTimeout(100);
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(150);
          // Use 20ms delay — TikTok's DraftJS needs time to process each keystroke
          await page.keyboard.type(caption.slice(0, MAX_CAPTION_LENGTH), { delay: 20 });
          await page.waitForTimeout(500);

          // Verify the text was actually entered before marking as filled
          const typed = await page.evaluate(() => {
            const editors = document.querySelectorAll('[contenteditable="true"]');
            for (const editor of editors) {
              const content = (editor.textContent || '').trim();
              if (content.length > 0) return content;
            }
            const textareas = document.querySelectorAll('textarea');
            for (const ta of textareas) {
              const content = (ta.value || '').trim();
              if (content.length > 0) return content;
            }
            return '';
          }).catch(() => '');

          if (typed.length > 0) {
            captionFilled = true;
            console.log(`[TikTok] Caption filled via keyboard on ${sel} (${typed.length} chars verified)`);
          } else {
            console.log(`[TikTok] Keyboard fill on ${sel} unverified, trying next selector...`);
          }
        } catch {}
      }

      // Strategy 2: DOM-based execCommand (may work for some DraftJS editors)
      if (!captionFilled) {
        await page.evaluate((text) => {
          const editors = document.querySelectorAll('[contenteditable="true"]');
          for (const editor of editors) {
            if (editor.offsetHeight === 0) continue;
            editor.focus();
            editor.click();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
            return;
          }
          const textareas = document.querySelectorAll('textarea');
          for (const ta of textareas) {
            if (ta.offsetHeight > 0) {
              ta.focus();
              ta.value = text;
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              ta.dispatchEvent(new Event('change', { bubbles: true }));
              return;
            }
          }
          console.warn('[TikTok] execCommand: no visible editor or textarea found');
        }, caption.slice(0, MAX_CAPTION_LENGTH));

        await page.waitForTimeout(400);

        // Verify content was entered
        captionFilled = await page.evaluate(() => {
          const editors = document.querySelectorAll('[contenteditable="true"]');
          for (const editor of editors) {
            if ((editor.textContent || '').trim().length > 0) return true;
          }
          const textareas = document.querySelectorAll('textarea');
          for (const ta of textareas) {
            if ((ta.value || '').trim().length > 0) return true;
          }
          return false;
        }).catch(() => false);
        if (captionFilled) console.log('[TikTok] Caption filled via execCommand');
      }
      
      if (!captionFilled) {
        console.warn('[TikTok] Could not fill caption with standard methods, trying agent...');
        try {
          await runAgentTask(page, `Fill the caption/description field with: "${caption.slice(0, 300)}"`, { maxSteps: 5, stepDelayMs: 500 });
        } catch (e) {
          console.warn('[TikTok] Agent caption fill failed:', e.message);
        }
      }
    }
    await page.waitForTimeout(2000);

    // ===== PHASE 4: POST =====
    console.log('[TikTok] Posting...');

    // Wait for the Post button to become enabled (TikTok keeps it disabled while the video
    // is still being processed, even after the progress bar disappears).
    console.log('[TikTok] Waiting for Post button to become enabled...');
    const postBtnEnabled = await (async () => {
      for (let i = 0; i < MAX_POST_BUTTON_WAIT_ATTEMPTS; i++) {
        const state = await page.evaluate(() => {
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };

          const candidates = [];
          const direct = document.querySelector('button[data-e2e="post-button"]');
          if (direct) candidates.push(direct);

          document.querySelectorAll('button, div[role="button"]').forEach((btn) => {
            const txt = (btn.textContent || '').trim().toLowerCase();
            if (txt === 'post' || txt === 'publish') candidates.push(btn);
          });

          const visibleCandidates = candidates.filter(isVisible);
          const target = visibleCandidates[0] || candidates[0] || null;
          if (!target) return { found: false, enabled: false };

          const enabled = !target.disabled &&
            target.getAttribute('aria-disabled') !== 'true' &&
            !target.classList.toString().toLowerCase().includes('disabled');

          return { found: true, enabled };
        }).catch(() => ({ found: false, enabled: false }));

        if (state.enabled) return true;
        await dismissExitDialog(page);
        await page.waitForTimeout(5000);
      }
      return false;
    })();
    if (!postBtnEnabled) {
      console.warn('[TikTok] Post button did not become enabled within wait period, attempting click anyway');
    } else {
      console.log('[TikTok] Post button is enabled, proceeding to click');
    }

    // Scroll the Post button into view. TikTok Studio renders the upload form inside a
    // scrollable <div> — window.scrollTo() does not reach it. Prefer scrollIntoView() on
    // the button itself; fall back to scrolling every overflow:auto/scroll container.
    await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const postBtn = allBtns.find(b => /^(post|publish)$/i.test((b.textContent || '').trim()));
      if (postBtn) {
        postBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        // Fallback: scroll every scrollable container to its bottom.
        // Limit to common container element types to avoid traversing every DOM node.
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        document.querySelectorAll('div, section, main, form, article').forEach(el => {
          // getComputedStyle can throw on detached/special elements — ignore those
          try {
            const style = window.getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
              el.scrollTop = el.scrollHeight;
            }
          } catch { /* safe to skip — element may be detached or cross-origin */ }
        });
      }
    });
    await page.waitForTimeout(1500);

    // Use LLM vision to verify the page is ready to post (processing done, Post button visible)
    // Retry up to 3 times if actual upload/processing (not just background copyright/content
    // checks) is still in progress. Copyright/content checks run in parallel with an already-
    // enabled Post button and do NOT block posting — only real upload-progress indicators do.
    try {
      for (let visionAttempt = 0; visionAttempt < 3; visionAttempt++) {
        const readyCheck = await analyzePage(page,
          'TikTok upload form: Is the video file upload complete (no upload percentage or progress bar)? Is the red Post (or Publish) button visible and enabled at the bottom of the form? Describe what you see.');
        console.log(`[TikTok] Pre-post vision check: ${readyCheck?.description || 'no response'}`);
        const desc = String(readyCheck?.description || '').toLowerCase();
        // Copyright/content checks are normal background checks that do NOT block posting
        const isCopyrightOrContentCheck =
          desc.includes('copyright') || desc.includes('content check') || desc.includes('music check');
        // Only wait extra for genuine upload/file-transfer progress, not background checks
        const isRealUploadInProgress =
          !isCopyrightOrContentCheck &&
          (desc.includes('uploading') || desc.includes('upload in progress') ||
           desc.includes('upload progress') || desc.includes('% uploaded') ||
           desc.includes('progress bar'));
        if (isRealUploadInProgress) {
          console.log(`[TikTok] LLM detected file upload still in progress, waiting extra 20s... (attempt ${visionAttempt + 1}/3)`);
          await page.waitForTimeout(20000);
          // Scroll to Post button again after extra wait
          await page.evaluate(() => {
            const allBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const postBtn = allBtns.find(b => /^(post|publish)$/i.test((b.textContent || '').trim()));
            if (postBtn) postBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            else window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          });
          await page.waitForTimeout(1000);
        } else {
          // Page is ready (or only background checks are running) — proceed
          if (isCopyrightOrContentCheck) {
            console.log('[TikTok] Copyright/content checks in progress (non-blocking) — proceeding to post');
          }
          break;
        }
      }
    } catch (e) {
      console.warn('[TikTok] Pre-post vision check failed (non-fatal):', e.message);
    }

    // Snapshot the Post button state before clicking so we can detect that our click
    // actually registered even when TikTok doesn't yet show a "posting" text signal —
    // the button disappears, becomes disabled, or the whole upload form unmounts.
    const capturePostButtonState = async () => {
      return page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const direct = document.querySelector('button[data-e2e="post-button"]');
        const candidates = [];
        if (direct) candidates.push(direct);
        document.querySelectorAll('button, div[role="button"]').forEach((btn) => {
          const txt = (btn.textContent || '').trim().toLowerCase();
          if (txt === 'post' || txt === 'publish') candidates.push(btn);
        });
        const target = candidates.find(isVisible) || candidates[0] || null;
        if (!target) return { present: false, enabled: false };
        const enabled = !target.disabled &&
          target.getAttribute('aria-disabled') !== 'true' &&
          !target.classList.toString().toLowerCase().includes('disabled');
        return { present: isVisible(target), enabled };
      }).catch(() => ({ present: false, enabled: false }));
    };

    const hasPublishStarted = async (prevBtn) => {
      const state = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        const url = window.location.href;
        const publishingSignals =
          text.includes('posting') ||
          text.includes('publishing') ||
          text.includes('your video is being uploaded to tiktok') ||
          text.includes('video is being processed') ||
          text.includes('submit successful') ||
          text.includes('your video has been published') ||
          text.includes('uploaded successfully') ||
          text.includes('post published') ||
          text.includes('your post is now live') ||
          text.includes('video posted');
        const navigated =
          url.includes('/content') ||
          url.includes('/manage') ||
          /\/video\/\d+/i.test(url) ||
          url.includes('tiktokstudio/content');
        const resetToEmptyUpload =
          text.includes('select video to upload') ||
          text.includes('drag and drop') ||
          text.includes('or drop video here');
        return { started: publishingSignals || navigated || resetToEmptyUpload };
      }).catch(() => ({ started: false }));
      if (state.started) return true;

      // Secondary signal: the Post button was enabled+present before our click, but is
      // now gone or disabled. TikTok's newer Studio UI briefly does this while the
      // request is in flight, before any text feedback appears.
      if (prevBtn && prevBtn.present && prevBtn.enabled) {
        const now = await capturePostButtonState();
        if (!now.present || !now.enabled) return true;
      }
      return false;
    };

    const clickPostOnce = async () => {
      // Try strict Playwright click on primary post button first
      try {
        const btn = page.locator('button[data-e2e="post-button"]').first();
        const visible = await btn.isVisible({ timeout: 1200 }).catch(() => false);
        const enabled = visible ? await btn.isEnabled().catch(() => false) : false;
        if (visible && enabled) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          try {
            await btn.click({ timeout: 3000 });
            return true;
          } catch {
            // Force click bypasses pointer-events / overlay interception
            try { await btn.click({ timeout: 3000, force: true }); return true; } catch {}
            const box = await btn.boundingBox().catch(() => null);
            if (box) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              return true;
            }
          }
        }
      } catch {}

      // Text-based Playwright locator fallback (buttons without data-e2e)
      try {
        const alt = page.locator('button:has-text("Post"), button:has-text("Publish")').last();
        const visible = await alt.isVisible({ timeout: 1200 }).catch(() => false);
        const enabled = visible ? await alt.isEnabled().catch(() => false) : false;
        if (visible && enabled) {
          await alt.scrollIntoViewIfNeeded().catch(() => {});
          try { await alt.click({ timeout: 3000 }); return true; }
          catch { try { await alt.click({ timeout: 3000, force: true }); return true; } catch {} }
        }
      } catch {}

      // DOM fallback: click only visible + enabled post/publish buttons
      return page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const isEnabled = (el) => {
          return !el.disabled &&
            el.getAttribute('aria-disabled') !== 'true' &&
            !el.classList.toString().toLowerCase().includes('disabled');
        };

        const direct = document.querySelector('button[data-e2e="post-button"]');
        if (direct && isVisible(direct) && isEnabled(direct)) {
          direct.scrollIntoView({ behavior: 'instant', block: 'center' });
          direct.click();
          return true;
        }

        const candidates = Array.from(document.querySelectorAll('button, div[role="button"]')).filter((btn) => {
          const text = (btn.textContent || '').trim().toLowerCase();
          return (text === 'post' || text === 'publish') && isVisible(btn) && isEnabled(btn);
        });

        if (candidates.length > 0) {
          const target = candidates[0];
          target.scrollIntoView({ behavior: 'instant', block: 'center' });
          target.click();
          return true;
        }

        return false;
      }).catch(() => false);
    };

    let postClicked = false;
    let publishTriggered = false;

    for (let clickAttempt = 0; clickAttempt < 3 && !publishTriggered; clickAttempt++) {
      await dismissExitDialog(page);
      postClicked = await clickPostOnce();

      if (!postClicked) {
        if (clickAttempt === 1) {
          console.log('[TikTok] Standard Post click failed, trying agent with vision...');
          try {
            const agentResult = await runAgentTask(page,
              'Click the red Post or Publish button on TikTok Studio to publish this video. If needed, scroll inside the upload form to reveal the button. Do NOT scroll the page background.',
              { maxSteps: 8, stepDelayMs: 800, useVision: true });
            postClicked = agentResult.success;
          } catch (e) {
            console.warn('[TikTok] Agent post-click failed:', e.message);
          }
        }
      }

      if (!postClicked) {
        await page.waitForTimeout(2000);
        continue;
      }

      // TikTok often shows a blocking modal: "Continue to post?" -> must click "Post now"
      await page.waitForTimeout(1000);
      const approvedContinueDialog = await acceptContinueToPostDialog(page);
      if (approvedContinueDialog) {
        await page.waitForTimeout(1500);
      }

      await page.waitForTimeout(2500);
      publishTriggered = await hasPublishStarted();
      if (!publishTriggered) {
        console.warn(`[TikTok] Post click attempt ${clickAttempt + 1} did not trigger publish flow; retrying`);
        // After a failed attempt, a TikTok tip / "what's new" / promo overlay
        // may be intercepting clicks. Try to dismiss it before the next retry.
        if (clickAttempt >= 1) {
          await dismissOverlayBlockingFlow(page, { logPrefix: '[TikTok]' });
        }
      }
    }

    if (!publishTriggered && postClicked) {
      // One extra targeted attempt for the "Post now" confirmation modal before escalating.
      const approvedContinueDialog = await acceptContinueToPostDialog(page);
      if (approvedContinueDialog) {
        await page.waitForTimeout(2000);
        publishTriggered = await hasPublishStarted();
      }
    }
    
    if (!postClicked) {
      console.warn('[TikTok] Could not find Post button, requesting human help...');
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      await requestTelegramApproval({
        telegram: credentials.telegram,
        platform: 'TikTok',
        backend: credentials.backend,
        screenshotBuffer,
        screenshotCaption: '📸 <b>TikTok upload ready</b> — click Post button and reply APPROVED',
        customMessage: '🚧 <b>TikTok uploader needs help</b>\nPlease click the Post/Publish button and reply APPROVED.',
      });
      await page.waitForTimeout(8000);
      publishTriggered = await hasPublishStarted();
    }
    
    // Wait for the publish to fully complete — this is critical to avoid the "exit" dialog
    if (publishTriggered) {
      const confirmed = await waitForPublishConfirmation(page, 240);
      if (!confirmed) {
        console.warn('[TikTok] Publish confirmation was not detected in time; continuing with deep completion checks');
      }
    }

    // ===== PHASE 5: CHECK COMPLETION =====
    let completion = await assessTikTokCompletion(page);
    let videoUrl = await extractTikTokVideoUrl(page);

    // Wait longer if still uploading/processing
    if (!completion.success && !completion.needsHuman) {
      for (let i = 0; i < 12; i++) {
        await dismissExitDialog(page);
        await page.waitForTimeout(5000);
        completion = await assessTikTokCompletion(page);
        videoUrl = videoUrl || await extractTikTokVideoUrl(page);
        if (completion.success) break;
      }
    }

    // If still no URL, try navigating to the profile to get the latest video URL
    if (!videoUrl) {
      try {
        // Navigate to TikTok profile/manage page to find the published video
        await page.goto('https://www.tiktok.com/tiktokstudio/content', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        videoUrl = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            if (href.includes('/video/')) {
              return href.startsWith('http') ? href : `https://www.tiktok.com${href}`;
            }
          }
          return '';
        }).catch(() => '');
        if (videoUrl) console.log(`[TikTok] Found published video URL from content page: ${videoUrl}`);
      } catch (e) {
        console.warn('[TikTok] Could not navigate to content page for URL:', e.message);
      }
    }

    videoUrl = normalizeTikTokVideoUrl(videoUrl);

    if (completion.success && !videoUrl) {
      throw new Error('TikTok publish appears complete, but no real TikTok video URL was found. Post link verification failed.');
    }

    if (!completion.success && completion.needsHuman) {
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      await requestTelegramApproval({
        telegram: credentials.telegram,
        platform: 'TikTok',
        backend: credentials.backend,
        screenshotBuffer,
        screenshotCaption: '📸 <b>TikTok obstacle screen</b> — reply APPROVED after you resolve the step',
        customMessage: `🚧 <b>TikTok uploader needs your help</b>\n${completion.reason}\n\nResolve the on-screen step and reply APPROVED.`,
      });

      await page.waitForTimeout(8000);
      await dismissExitDialog(page);
      completion = await assessTikTokCompletion(page);
      videoUrl = videoUrl || await extractTikTokVideoUrl(page);
    }

    if (!completion.success) {
      const failureDiagnostics = await collectTikTokFailureDiagnostics(page, completion.reason);
      const failureMessage = formatTikTokFailureMessage(failureDiagnostics);
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);

      if (screenshotBuffer && credentials.telegram?.enabled && credentials.telegram?.chatId) {
        await sendTelegramPhoto(
          credentials.telegram.botToken,
          credentials.telegram.chatId,
          screenshotBuffer,
          `📸 <b>TikTok publish failure</b>\n${escapeHtml(truncateText(failureMessage, MAX_TELEGRAM_DIAGNOSTIC_CAPTION_LENGTH))}`,
          credentials.backend,
        ).catch((telegramError) => {
          console.warn('[TikTok] Failed to send diagnostic screenshot:', telegramError.message);
        });
      }

      throw new Error(`TikTok publish was not confirmed. ${failureMessage}`);
    }

    console.log(`[TikTok] Upload complete! URL: ${videoUrl || '(no URL extracted)'}`);

    // Dismiss any exit dialog before closing
    await dismissExitDialog(page);
    clearInterval(promoWatcher);
    await context.close();
    return { url: videoUrl || '' };
  } catch (err) {
    console.error('[TikTok] Upload failed:', err.message);
    try { await dismissExitDialog(page); } catch {}
    clearInterval(promoWatcher);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToTikTok };
