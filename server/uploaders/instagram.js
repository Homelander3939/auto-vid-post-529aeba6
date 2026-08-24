const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill, analyzePage, waitForStateChange, runAgentTask } = require('./smart-agent');
const { getSharedBrowserProfileDir } = require('../browserProfiles');
const { dismissOverlayBlockingFlow } = require('./overlay-dismiss');
const { launchPersistentSafe } = require('../profileLock');
const { attemptUploadArbiter } = require('./upload-arbiter');

/**
 * Pre-process video to 9:16 (1080x1920) with black padding using ffmpeg.
 * Returns the path to the processed temp file, or the original path if ffmpeg fails.
 */
function prepareVerticalVideo(videoPath) {
  const ext = path.extname(videoPath);
  const tempPath = videoPath.replace(ext, `_ig_vertical${ext}`);

  try {
    // Probe dimensions using spawn to avoid shell quoting issues on Windows
    const { execFileSync } = require('child_process');

    let w, h;
    try {
      const probe = execFileSync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        videoPath
      ], { encoding: 'utf-8', timeout: 30000 }).trim();
      [w, h] = probe.split(',').map(Number);
    } catch (probeErr) {
      console.warn(`[Instagram] ffprobe failed: ${probeErr.message}`);
      return { processedPath: videoPath, needsCleanup: false };
    }

    console.log(`[Instagram] Source video dimensions: ${w}x${h}`);

    // Already portrait 9:16 — skip processing
    if (w > 0 && h > 0 && h / w >= 1.7) {
      console.log('[Instagram] Video is already portrait (9:16), skipping ffmpeg conversion');
      return { processedPath: videoPath, needsCleanup: false };
    }

    // Use execFileSync to avoid all shell quoting issues on Windows
    const vf = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black';
    const args = [
      '-y', '-i', videoPath,
      '-vf', vf,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      tempPath
    ];

    console.log(`[Instagram] Converting to 9:16 with black padding...`);
    console.log(`[Instagram] ffmpeg args: ${JSON.stringify(args)}`);
    execFileSync('ffmpeg', args, { stdio: 'pipe', timeout: 120000 });

    // Verify the output file exists and has size
    if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
      console.log(`[Instagram] Video converted to 1080x1920: ${tempPath} (${(fs.statSync(tempPath).size / 1024 / 1024).toFixed(1)} MB)`);
      return { processedPath: tempPath, needsCleanup: true };
    } else {
      console.warn('[Instagram] ffmpeg produced empty or missing output file');
      return { processedPath: videoPath, needsCleanup: false };
    }
  } catch (err) {
    console.error(`[Instagram] ffmpeg conversion FAILED: ${err.message}`);
    if (err.stderr) console.error(`[Instagram] ffmpeg stderr: ${err.stderr.toString().slice(0, 500)}`);
    // Clean up partial file
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    return { processedPath: videoPath, needsCleanup: false };
  }
}

const DEFAULT_USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram');

function resolveUserDataDir(browserProfileId, accountId) {
  if (browserProfileId) return getSharedBrowserProfileDir(browserProfileId);
  if (!accountId) return DEFAULT_USER_DATA_DIR;
  return path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram', accountId);
}

const MAX_CAPTION_LENGTH = 2200;
// How long to wait for the user's reels grid to load after navigating to their profile
const PROFILE_REELS_LOAD_WAIT_MS = 6000;
const INSTAGRAM_SHARE_READY_MAX_WAIT_MS = 180000;
const INSTAGRAM_SHARE_PROCESSING_MAX_WAIT_MS = 180000;
const INSTAGRAM_PROFILE_PUBLISH_WAIT_ATTEMPTS = 12;
const INSTAGRAM_PROFILE_PUBLISH_WAIT_INTERVAL_MS = 3000;
const INSTAGRAM_QUICK_PROFILE_LOAD_WAIT_MS = 1200;

function classifyInstagramAuthSnapshot(snapshot = {}) {
  const url = String(snapshot.url || '').toLowerCase();
  const text = String(snapshot.text || '').toLowerCase();
  const blockedReason =
    text.includes('incorrect password') || text.includes('password was incorrect') ? 'Instagram rejected the saved password.' :
    text.includes('try again later') || text.includes('wait a few minutes') ? 'Instagram temporarily limited login attempts.' :
    text.includes('account has been disabled') || text.includes('account is disabled') ? 'Instagram reports that this account is disabled.' :
    text.includes('couldn\'t log in') || text.includes('cannot log in') ? 'Instagram could not complete login with the saved session.' : '';
  const needsVerification = Boolean(
    snapshot.hasCode ||
    url.includes('/challenge/') ||
    url.includes('/checkpoint/') ||
    text.includes('confirm it\'s you') ||
    text.includes('confirm your identity') ||
    text.includes('suspicious login attempt') ||
    text.includes('security code')
  );
  return { blockedReason, needsVerification };
}

async function inspectInstagramAuthState(page) {
  const snapshot = await page.evaluate(() => ({
    url: window.location.href,
    text: (document.body?.innerText || '').slice(0, 4000),
    loggedIn: !!(document.querySelector('[aria-label="New post"]') ||
      document.querySelector('svg[aria-label="New post"]') ||
      document.querySelector('[aria-label="Home"]') ||
      document.querySelector('a[href="/direct/inbox/"]') ||
      document.querySelector('[aria-label="Search"]')),
    hasUsername: !!document.querySelector('input[name="username"]'),
    hasPassword: !!document.querySelector('input[name="password"]'),
    hasCode: !!document.querySelector('input[name="verificationCode"], input[name="security_code"], input[autocomplete="one-time-code"]'),
  })).catch(() => ({ url: page.url(), text: '', loggedIn: false, hasUsername: false, hasPassword: false, hasCode: false }));
  return { ...snapshot, ...classifyInstagramAuthSnapshot(snapshot) };
}

function normalizeInstagramPostUrl(candidate = '') {
  const raw = String(candidate || '').trim();
  if (!raw) return '';

  let absolute = raw;
  if (raw.startsWith('/')) {
    absolute = `https://www.instagram.com${raw}`;
  } else if (!/^https?:\/\//i.test(raw)) {
    absolute = `https://${raw.replace(/^\/+/, '')}`;
  }

  try {
    const parsed = new URL(absolute);
    const mediaMatch = parsed.pathname.match(/^\/(p|reel)\/([A-Za-z0-9_-]+)/i);
    if (!parsed.hostname.includes('instagram.com') || !mediaMatch) return '';
    return `https://www.instagram.com/${mediaMatch[1].toLowerCase()}/${mediaMatch[2]}/`;
  } catch {
    return '';
  }
}

async function resolveInstagramUsername(page) {
  return page.evaluate(() => {
    const blacklist = new Set(['explore', 'reels', 'direct', 'accounts', 'p', 'reel', 'create', 'stories', 'inbox']);

    const navSelectors = [
      'nav a[href^="/"][aria-label*="Profile" i]',
      'nav a[href^="/"][role="link"]',
      'a[href^="/"][aria-label*="Profile" i]',
    ];
    for (const sel of navSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const href = (el.getAttribute('href') || '').replace(/\/$/, '');
      const match = href.match(/^\/([a-zA-Z0-9._]+)$/);
      if (match && !blacklist.has(match[1])) return match[1];
    }

    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    for (const link of allLinks) {
      const href = (link.getAttribute('href') || '').replace(/\/$/, '');
      const match = href.match(/^\/([a-zA-Z0-9._]{3,30})$/);
      if (match && !blacklist.has(match[1])) return match[1];
    }

    return '';
  }).catch(() => '');
}

async function fetchRecentInstagramPostUrlsFromProfile(page, username, attempts = 4, limit = 8) {
  if (!username) return [];

  const profileUrls = [
    `https://www.instagram.com/${username}/reels/`,
    `https://www.instagram.com/${username}/`,
  ];

  for (const profileUrl of profileUrls) {
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch {
      continue;
    }

    for (let retry = 0; retry < attempts; retry++) {
      await page.waitForTimeout(retry === 0 ? PROFILE_REELS_LOAD_WAIT_MS : 10000);
      await page.evaluate(() => window.scrollTo({ top: 420, behavior: 'smooth' })).catch(() => {});
      await page.waitForTimeout(1000);

      const urls = await page.evaluate((maxItems) => {
        const scope = document.querySelector('main, [role="main"]') || document;
        const links = Array.from(scope.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
        const collected = [];
        const seen = new Set();

        for (const link of links) {
          const href = (link.getAttribute('href') || '').trim();
          if (!href) continue;
          const absolute = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          if (seen.has(absolute)) continue;
          seen.add(absolute);
          collected.push(absolute);
          if (collected.length >= maxItems) break;
        }

        return collected;
      }, limit).catch(() => []);

      const normalized = (Array.isArray(urls) ? urls : [])
        .map((url) => normalizeInstagramPostUrl(url))
        .filter(Boolean);

      if (normalized.length > 0) {
        return Array.from(new Set(normalized));
      }
    }
  }

  return [];
}

async function fetchLatestInstagramPostUrlFromProfile(page, username, attempts = 4) {
  const urls = await fetchRecentInstagramPostUrlsFromProfile(page, username, attempts, 1);
  return urls[0] || '';
}

async function fetchRecentInstagramPostUrlsQuick(page, username, limit = 8) {
  if (!username) return [];

  const profileUrls = [
    `https://www.instagram.com/${username}/reels/`,
    `https://www.instagram.com/${username}/`,
  ];

  for (const profileUrl of profileUrls) {
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(INSTAGRAM_QUICK_PROFILE_LOAD_WAIT_MS);

      let urls = await page.evaluate((maxItems) => {
        const scope = document.querySelector('main, [role="main"]') || document;
        const links = Array.from(scope.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
        const seen = new Set();
        const collected = [];

        for (const link of links) {
          const href = (link.getAttribute('href') || '').trim();
          if (!href) continue;
          const absolute = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          if (seen.has(absolute)) continue;
          seen.add(absolute);
          collected.push(absolute);
          if (collected.length >= maxItems) break;
        }

        return collected;
      }, limit).catch(() => []);

      if (!urls.length) {
        await page.evaluate(() => window.scrollTo({ top: 420, behavior: 'smooth' })).catch(() => {});
        await page.waitForTimeout(1000);
        urls = await page.evaluate((maxItems) => {
          const scope = document.querySelector('main, [role="main"]') || document;
          const links = Array.from(scope.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
          const seen = new Set();
          const collected = [];

          for (const link of links) {
            const href = (link.getAttribute('href') || '').trim();
            if (!href) continue;
            const absolute = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
            if (seen.has(absolute)) continue;
            seen.add(absolute);
            collected.push(absolute);
            if (collected.length >= maxItems) break;
          }

          return collected;
        }, limit).catch(() => []);
      }

      const normalized = (Array.isArray(urls) ? urls : [])
        .map((url) => normalizeInstagramPostUrl(url))
        .filter(Boolean);

      if (normalized.length > 0) {
        return Array.from(new Set(normalized));
      }
    } catch {}
  }

  return [];
}

// Finds the Share/Post/Publish button in the dialog header band using the same coordinate-based
// approach as findDialogHeaderNextButton inside the upload flow. This is necessary because
// Instagram renders the "Share" action in the header as a plain <div>/<a>/<span> — NOT as a
// <button> or <div role="button"> — so standard button queries miss it.
async function findDialogHeaderShareButton(page) {
  return page.evaluate(() => {
    const dialogEl = document.querySelector('[role="dialog"]') || document.body;
    const dialogRect = dialogEl.getBoundingClientRect();
    const HEADER_BAND_MAX_PX = 140;
    const HEADER_BAND_MIN_PX = 72;
    const HEADER_BAND_HEIGHT_RATIO = 0.22;
    const headerBandMaxTop = Math.min(
      HEADER_BAND_MAX_PX,
      Math.max(HEADER_BAND_MIN_PX, dialogRect.height * HEADER_BAND_HEIGHT_RATIO),
    );
    const SHARE_LABELS = ['share', 'post', 'publish'];
    const interactiveSelector = 'button, [role="button"], a, [tabindex]';
    const candidateSelector = 'button, [role="button"], a, span, div[tabindex], div';
    const seen = new Set();
    const candidates = [];
    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

    const matchesShareLabel = (el) => {
      const raw = (el.textContent || '').trim().toLowerCase();
      const rendered = (el.innerText || raw).trim().toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      return SHARE_LABELS.some((l) => raw === l || rendered === l || ariaLabel === l);
    };

    for (const el of dialogEl.querySelectorAll(candidateSelector)) {
      if (!matchesShareLabel(el)) continue;
      const candidate = el.closest(interactiveSelector) || el;
      if (!dialogEl.contains(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);

      if (!candidate.matches(interactiveSelector)) {
        const hasMatchingChild = Array.from(candidate.querySelectorAll(candidateSelector))
          .some((child) => child !== candidate && matchesShareLabel(child));
        if (hasMatchingChild) continue;
      }

      const rect = candidate.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const relativeTop = rect.top - dialogRect.top;
      if (relativeTop < -4 || relativeTop > headerBandMaxTop) continue;

      const style = window.getComputedStyle(candidate);
      if (
        style.display === 'none' || style.visibility === 'hidden' ||
        style.opacity === '0' || style.pointerEvents === 'none'
      ) continue;
      if (candidate.hasAttribute('disabled') || candidate.getAttribute('aria-disabled') === 'true') continue;

      const x = clamp(rect.left + rect.width / 2, rect.left + 1, rect.right - 1);
      const y = clamp(rect.top + rect.height / 2, rect.top + 1, rect.bottom - 1);
      const topEl = document.elementFromPoint(x, y);
      if (topEl && !(candidate === topEl || candidate.contains(topEl) || topEl.contains(candidate))) continue;

      candidates.push({ top: relativeTop, left: rect.left - dialogRect.left, x, y });
    }

    if (candidates.length === 0) return null;
    // Sort by vertical position (top ascending) first so we get the highest header element.
    // For ties, sort by horizontal position descending (rightmost wins) because Instagram
    // always places the primary action button (Share / Next) at the far right of the header.
    candidates.sort((a, b) => (a.top - b.top) || (b.left - a.left));
    return candidates[0];
  }).catch(() => null);
}

async function waitForInstagramShareButtonReady(page, maxWaitMs = INSTAGRAM_SHARE_READY_MAX_WAIT_MS) {
  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    // First, try to find the Share button in the dialog header band using coordinate-based lookup.
    // Instagram renders the "Share" action as a plain div/a/span in the header (same as "Next"),
    // so standard button queries would miss it. findDialogHeaderShareButton handles this.
    const headerShareCoords = await findDialogHeaderShareButton(page);
    if (headerShareCoords) {
      return { ready: true, reason: 'Share button found in dialog header band.' };
    }

    const state = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const scope = dialog || document;
      const text = (scope.textContent || '').toLowerCase();

      // Broader selector: include a, span, div in addition to button/div[role="button"] because
      // Instagram renders the header Share action without a role="button" attribute.
      const allEls = Array.from(scope.querySelectorAll('button, [role="button"], a, span'));
      const shareBtn = allEls.find((el) => {
        const label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const elText = (el.innerText || el.textContent || '').trim().toLowerCase();
        return elText === 'share' || elText === 'post' || elText === 'publish' || label === 'share' || label === 'post' || label === 'publish';
      });

      const style = shareBtn ? window.getComputedStyle(shareBtn) : null;
      const rect = shareBtn ? shareBtn.getBoundingClientRect() : null;
      const visible = !!(
        shareBtn &&
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        style &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );

      const enabled = !!(
        visible &&
        shareBtn &&
        !shareBtn.disabled &&
        shareBtn.getAttribute('aria-disabled') !== 'true' &&
        !String(shareBtn.className || '').toLowerCase().includes('disabled') &&
        (!style || style.pointerEvents !== 'none')
      );

      const isProcessing =
        text.includes('processing') ||
        text.includes('sharing...') ||
        text.includes('posting') ||
        text.includes('uploading') ||
        text.includes('preparing');

      const isShared =
        text.includes('your post has been shared') ||
        text.includes('your reel has been shared') ||
        text.includes('post shared') ||
        text.includes('reel shared');

      return {
        hasDialog: !!dialog,
        visible,
        enabled,
        isProcessing,
        isShared,
      };
    }).catch(() => ({ hasDialog: false, visible: false, enabled: false, isProcessing: false, isShared: false }));

    if (state.enabled) {
      return { ready: true, reason: 'Share button is visible and enabled.' };
    }
    if (state.isShared) {
      return { ready: false, alreadyShared: true, reason: 'Instagram already shows shared confirmation.' };
    }

    console.log('[Instagram] Waiting for Share button to become enabled...');
    await page.waitForTimeout(3000);
  }

  return { ready: false, alreadyShared: false, reason: 'Share button did not become enabled in time.' };
}

async function openLatestInstagramPostAndCaptureUrl(page, username, options = {}) {
  if (!username) return '';

  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 2500;
  const afterClickMs = Number.isFinite(options.afterClickMs) ? options.afterClickMs : 2000;
  const captureTimeoutMs = Number.isFinite(options.captureTimeoutMs) ? options.captureTimeoutMs : 8000;

  const profileUrls = [
    `https://www.instagram.com/${username}/reels/`,
    `https://www.instagram.com/${username}/`,
  ];

  for (const profileUrl of profileUrls) {
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(settleMs);

      const clickedHref = await page.evaluate(() => {
        const scope = document.querySelector('main, [role="main"]') || document;
        const links = Array.from(scope.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
        const first = links[0];
        if (!first) return '';

        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return first.getAttribute('href') || '';
      }).catch(() => '');

      await page.waitForTimeout(afterClickMs);

      const openedMediaUrl = await page.waitForFunction(() => {
        const href = window.location.href;
        if (/\/\/(?:www\.)?instagram\.com\/(?:reel|p)\//i.test(href)) return href;

        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          const mediaLink = dialog.querySelector('a[href*="/reel/"], a[href*="/p/"]');
          if (mediaLink) {
            const mediaHref = mediaLink.getAttribute('href') || '';
            return mediaHref.startsWith('http') ? mediaHref : `https://www.instagram.com${mediaHref}`;
          }
        }

        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
        if (/\/\/(?:www\.)?instagram\.com\/(?:reel|p)\//i.test(canonical)) return canonical;

        return '';
      }, { timeout: captureTimeoutMs }).then((handle) => handle.jsonValue()).catch(() => '');

      const normalized = normalizeInstagramPostUrl(openedMediaUrl)
        || normalizeInstagramPostUrl(clickedHref)
        || normalizeInstagramPostUrl(page.url());

      if (normalized) {
        console.log(`[Instagram] Opened latest reel/post and captured URL: ${normalized}`);
        return normalized;
      }
    } catch {}
  }

  return '';
}

async function clickInstagramShareButton(page) {
  // Strategy 0: Coordinate-based mouse click on the Share button in the dialog header band.
  // Instagram renders the "Share" action as a plain <div>/<a>/<span> in the header (same
  // pattern as the "Next" button on previous screens). page.mouse.click() dispatches the full
  // mousedown→click chain so React events fire reliably without any page scrolling.
  const headerCoords = await findDialogHeaderShareButton(page);
  if (headerCoords) {
    await page.mouse.click(headerCoords.x, headerCoords.y);
    console.log('[Instagram] Strategy 0: Coordinate-clicked Share button in dialog header band');
    return true;
  }

  // Strategy 1: DOM click on button/[role="button"]/a/span with matching text
  let shareClicked = await page.evaluate(() => {
    const dialogEl = document.querySelector('[role="dialog"]') || document.body;
    // Broader selector: Instagram may use a, span, or plain div without role="button"
    const allEls = dialogEl.querySelectorAll('button, [role="button"], a, span');
    for (const el of allEls) {
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const disabled =
        el.disabled ||
        el.getAttribute('aria-disabled') === 'true' ||
        String(el.className || '').toLowerCase().includes('disabled');
      if (disabled) continue;
      if (text === 'share' || text === 'post' || text === 'publish' || label === 'share' || label === 'post' || label === 'publish') {
        el.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);

  if (!shareClicked) {
    shareClicked = await smartClick(page, [
      '[role="dialog"] button:has-text("Share")',
      '[role="dialog"] [aria-label="Share"]',
      '[role="dialog"] a:has-text("Share")',
      '[role="dialog"] span:has-text("Share")',
      'button:has-text("Share")',
      '[aria-label="Share"]',
      'div[role="button"]:has-text("Share")',
      'button:has-text("Post")',
      'button:has-text("Publish")',
    ], 'Share');
  }

  if (!shareClicked) {
    console.log('[Instagram] Standard Share button not found, trying agent with vision...');
    try {
      const agentResult = await runAgentTask(page,
        'Find and click the blue "Share" button inside the Instagram post creation dialog to publish this reel. Do NOT scroll the page background — only interact with the dialog popup.',
        { maxSteps: 5, stepDelayMs: 600, useVision: true });
      shareClicked = agentResult.success;
    } catch (e) {
      console.warn('[Instagram] Agent share-click failed:', e.message);
    }
  }

  return shareClicked;
}

async function ensureInstagramPostFlow(page) {
  const readyState = await page.evaluate(() => {
    const scope = document.querySelector('[role="dialog"]') || document.body;
    const text = (scope.innerText || scope.textContent || '').toLowerCase();
    const buttons = Array.from(scope.querySelectorAll('button, a, div[role="button"], [role="menuitem"], [role="tab"]'));
    const hasSelectFromComputer = buttons.some((node) => {
      const value = `${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`.toLowerCase();
      return value.includes('select from computer') || value.includes('drag photos and videos here') || value.includes('drag videos here');
    });

    return {
      ready:
        !!scope.querySelector('input[type="file"]') ||
        hasSelectFromComputer ||
        text.includes('drag photos and videos here') ||
        text.includes('drag videos here') ||
        text.includes('select from computer') ||
        text.includes('crop') ||
        text.includes('trim'),
    };
  }).catch(() => ({ ready: false }));

  if (readyState.ready) {
    console.log('[Instagram] Upload surface already open');
    return true;
  }

  // Select "Post" from the create menu so video uploads as a Post with selectable crop (9:16)
  let postSelected = await page.evaluate(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const clickNode = (node) => {
      if (!node) return false;
      const target = node.closest('button, a, [role="button"], [role="tab"], label') || node;
      target.click();
      return true;
    };

    const nodes = Array.from(document.querySelectorAll('button, a, div[role="button"], [role="menuitem"], [role="tab"], span, div'));

    // Try "Post" first
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const text = normalize(node.textContent);
      const label = normalize(node.getAttribute('aria-label'));
      if (text === 'post' || label === 'post') {
        return clickNode(node);
      }
    }

    // Fallback: try "Reel" if "Post" option not found (some account types)
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const text = normalize(node.textContent);
      const label = normalize(node.getAttribute('aria-label'));
      if (text === 'reel' || label === 'reel') {
        return clickNode(node);
      }
    }

    return false;
  }).catch(() => false);

  if (!postSelected) {
    postSelected = await smartClick(page, [
      '[role="menuitem"]:has-text("Post")',
      'button:has-text("Post")',
      'a:has-text("Post")',
      '[role="tab"]:has-text("Post")',
      '[role="dialog"] button:has-text("Post")',
      '[aria-label="Post" i]',
      '[role="menuitem"]:has-text("Reel")',
      'button:has-text("Reel")',
      '[aria-label="Reel" i]',
    ], 'Post');
  }

  if (!postSelected) {
    try {
      const result = await runAgentTask(
        page,
        'Inside Instagram create flow menu, choose the "Post" option to upload a new post. If "Post" is not available, choose "Reel". Only interact with the popup/dialog.',
        { maxSteps: 5, stepDelayMs: 600, useVision: true },
      );
      postSelected = result.success;
    } catch (e) {
      console.warn('[Instagram] Agent post selection failed:', e.message);
    }
  }

  if (postSelected) {
    await page.waitForTimeout(1800);
    console.log('[Instagram] Explicitly selected Post flow');
  }

  const postFlowReady = await page.waitForFunction(() => {
    const scope = document.querySelector('[role="dialog"]') || document.body;
    const text = (scope.innerText || scope.textContent || '').toLowerCase();
    return (
      !!scope.querySelector('input[type="file"]') ||
      text.includes('select from computer') ||
      text.includes('drag photos and videos here') ||
      text.includes('drag videos here') ||
      text.includes('crop') ||
      text.includes('trim')
    );
  }, { timeout: 8000 }).then(() => true).catch(() => false);

  if (postFlowReady) {
    console.log('[Instagram] Post composer/file picker confirmed');
    return true;
  }

  return postSelected;
}

async function waitForInstagramUploadSurface(page, maxWaitMs = 15000) {
  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    const state = await page.evaluate(() => {
      const scope = document.querySelector('[role="dialog"]')
        || document.querySelector('main, [role="main"]')
        || document.body;
      const text = (scope.innerText || scope.textContent || '').toLowerCase();
      const path = window.location.pathname.toLowerCase();
      const clickables = Array.from(
        scope.querySelectorAll('button, a, label, div[role="button"], [role="button"], [role="tab"], span')
      );

      const hasFileInput = document.querySelectorAll('input[type="file"]').length > 0;
      const hasSelectButton = clickables.some((node) => {
        const value = `${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        return value.includes('select from computer')
          || value.includes('choose from computer')
          || value.includes('upload from computer')
          || value.includes('select file')
          || value.includes('choose file')
          || value.includes('drag photos and videos here')
          || value.includes('drag videos here');
      });

      // Do NOT include 'new post' or 'create new post' — those strings appear in the
      // always-visible sidebar nav and the create-type dropdown title, producing false
      // positives before the actual file-upload surface (drag zone / file input) is open.
      // Do NOT use path.includes('/create/') — that matches user profile pages like
      // instagram.com/create/select/ which is a real account, not an upload route.
      const looksLikeCreateFlow =
        text.includes('new reel')
        || text.includes('share to reels')
        || text.includes('reel details')
        || text.includes('drag photos and videos here')
        || text.includes('drag videos here')
        || text.includes('select from computer')
        || text.includes('crop')
        || text.includes('trim');

      return {
        ready: hasFileInput || hasSelectButton || looksLikeCreateFlow,
        hasDialog: !!document.querySelector('[role="dialog"]'),
        hasFileInput,
        hasSelectButton,
        path,
      };
    }).catch(() => ({ ready: false, hasDialog: false, hasFileInput: false, hasSelectButton: false, path: '' }));

    if (state.ready) {
      console.log(`[Instagram] Upload surface ready (path: ${state.path || 'unknown'}, dialog: ${state.hasDialog}, fileInput: ${state.hasFileInput}, selectButton: ${state.hasSelectButton})`);
      return state;
    }

    await page.waitForTimeout(1500);
  }

  return { ready: false, hasDialog: false, hasFileInput: false, hasSelectButton: false, path: '' };
}

async function forceOpenInstagramUploadSurface(page) {
  // Go back to home and retry clicking the + / Create button, then wait for the dialog.
  // Do NOT navigate to /create/select/ or /create/style/ — those are user profile pages,
  // not upload routes.
  try {
    console.log('[Instagram] Returning to home and retrying Create button...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Re-click the + button
    let clicked = await smartClick(page, [
      '[aria-label="New post"]',
      'svg[aria-label="New post"]',
      '[aria-label="Create"]',
      'svg[aria-label="Create"]',
      '[aria-label="New Post"]',
      'svg[aria-label="New Post"]',
    ], 'New post');

    if (!clicked) {
      clicked = await page.evaluate(() => {
        const svgLabels = ['New post', 'Create', 'New Post', 'Новая публикация', 'Crear'];
        for (const label of svgLabels) {
          const svg = document.querySelector(`svg[aria-label="${label}"]`);
          if (svg) {
            const parent = svg.closest('a, button, div[role="button"], span[role="link"]');
            if (parent) { parent.click(); return true; }
            svg.click();
            return true;
          }
        }
        const sidebarLinks = document.querySelectorAll('nav a, nav div[role="button"], [role="navigation"] a');
        for (const link of sidebarLinks) {
          const text = (link.textContent || '').trim().toLowerCase();
          const label = (link.getAttribute('aria-label') || '').toLowerCase();
          if (text === 'create' || text === 'new post' || label === 'create' || label === 'new post') {
            link.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
    }

    if (!clicked) return false;

    await page.waitForTimeout(2500);
    await ensureInstagramPostFlow(page).catch(() => false);
    const uploadSurface = await waitForInstagramUploadSurface(page, 6000);
    return uploadSurface.ready;
  } catch (err) {
    console.warn(`[Instagram] forceOpenInstagramUploadSurface failed: ${err.message}`);
    return false;
  }
}

async function closeInstagramShareResultPopup(page) {
  const closed = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;

    const closeSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label*="close" i]',
      'div[role="button"][aria-label="Close"]',
      'svg[aria-label="Close"]',
    ];

    for (const sel of closeSelectors) {
      const node = dialog.querySelector(sel);
      if (!node) continue;
      const clickable = node.closest('button, [role="button"], a') || node;
      clickable.click();
      return true;
    }

    const buttons = Array.from(dialog.querySelectorAll('button, div[role="button"]'));
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text === 'done' || text === 'close' || text === 'not now') {
        btn.click();
        return true;
      }
    }

    return false;
  }).catch(() => false);

  if (!closed) {
    await page.keyboard.press('Escape').catch(() => {});
  }

  if (closed) {
    await page.waitForTimeout(800);
  }

  return closed;
}

async function waitForNewInstagramPostUrl(page, username, baselineUrls = [], attempts = INSTAGRAM_PROFILE_PUBLISH_WAIT_ATTEMPTS) {
  if (!username) return '';

  const baselineSet = new Set(
    (Array.isArray(baselineUrls) ? baselineUrls : [])
      .map((url) => normalizeInstagramPostUrl(url))
      .filter(Boolean),
  );

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await closeInstagramShareResultPopup(page);

    // Primary strategy requested by user behavior:
    // after share confirmation, open profile -> open latest reel tile -> capture URL.
    const openedLatestUrl = await openLatestInstagramPostAndCaptureUrl(page, username, {
      settleMs: INSTAGRAM_QUICK_PROFILE_LOAD_WAIT_MS,
      afterClickMs: 900,
      captureTimeoutMs: 3500,
    });
    if (openedLatestUrl && !baselineSet.has(openedLatestUrl)) {
      return openedLatestUrl;
    }

    // Quick profile-grid poll for a newly appeared reel/post.
    const quickRecentUrls = await fetchRecentInstagramPostUrlsQuick(page, username, 8);
    const quickNewUrl = quickRecentUrls.find((url) => url && !baselineSet.has(url)) || '';
    if (quickNewUrl) {
      return quickNewUrl;
    }

    // Periodic deep fallback in case quick DOM sampling misses a delayed grid refresh.
    if (attempt % 4 === 0) {
      const deepRecentUrls = await fetchRecentInstagramPostUrlsFromProfile(page, username, 1, 8);
      const deepNewUrl = deepRecentUrls.find((url) => url && !baselineSet.has(url)) || '';
      if (deepNewUrl) {
        return deepNewUrl;
      }
    }

    console.log(`[Instagram] Waiting for new published post URL on profile... (${attempt}/${attempts})`);
    if (attempt < attempts) {
      await page.waitForTimeout(INSTAGRAM_PROFILE_PUBLISH_WAIT_INTERVAL_MS);
    }
  }

  return '';
}

async function waitForInstagramSharingToFinish(page, maxWaitMs = INSTAGRAM_SHARE_PROCESSING_MAX_WAIT_MS) {
  const started = Date.now();
  let seenProcessing = false;

  while (Date.now() - started < maxWaitMs) {
    const state = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const scope = dialog || document;
      const text = (scope.textContent || '').toLowerCase();
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const url = window.location.href;

      const isProcessing =
        text.includes('sharing...') ||
        text.includes('processing') ||
        text.includes('posting') ||
        text.includes('uploading') ||
        bodyText.includes('sharing...') ||
        bodyText.includes('processing') ||
        bodyText.includes('posting') ||
        bodyText.includes('uploading');

      const isShared =
        text.includes('your post has been shared') ||
        text.includes('your reel has been shared') ||
        text.includes('post shared') ||
        text.includes('reel shared') ||
        text.includes('shared successfully') ||
        bodyText.includes('your post has been shared') ||
        bodyText.includes('your reel has been shared') ||
        bodyText.includes('post shared') ||
        bodyText.includes('reel shared') ||
        bodyText.includes('shared successfully');

      return {
        hasDialog: !!dialog,
        isProcessing,
        isShared,
        redirectedToFeed: url === 'https://www.instagram.com/' || url === 'https://instagram.com/',
      };
    }).catch(() => ({ hasDialog: false, isProcessing: false, isShared: false, redirectedToFeed: false }));

    if (state.isProcessing) {
      seenProcessing = true;
      console.log('[Instagram] Share popup still processing...');
      await page.waitForTimeout(2000);
      continue;
    }

    if (state.isShared) {
      return { finished: true, reason: 'Instagram shows a shared confirmation.' };
    }

    if (seenProcessing && !state.isProcessing) {
      return {
        finished: true,
        reason: state.redirectedToFeed
          ? 'Instagram returned to feed after processing.'
          : 'Instagram processing state disappeared.',
      };
    }

    if (!state.hasDialog && state.redirectedToFeed) {
      return { finished: true, reason: 'Instagram closed popup and returned to feed.' };
    }

    await page.waitForTimeout(2000);
  }

  return { finished: false, reason: 'Instagram sharing/loading did not finish in time.' };
}

async function extractInstagramPostUrl(page) {
  // Only look for post/reel links inside a success-confirmation context (dialog, notification,
  // "View" button area).  Do NOT scan the whole page — the homepage/feed contains links from
  // other users that would be returned as false positives.
  return page.evaluate(() => {
    const successSelectors = [
      '[role="dialog"]',
      '[aria-label*="Post shared" i]',
      '[aria-label*="Reel shared" i]',
      '[aria-label*="Shared" i]',
    ];

    for (const containerSel of successSelectors) {
      const container = document.querySelector(containerSel);
      if (!container) continue;
      const text = (container.textContent || '').toLowerCase();
      const isSuccessContext =
        text.includes('shared') ||
        text.includes('published') ||
        text.includes('your post') ||
        text.includes('your reel') ||
        text.includes('view');
      if (!isSuccessContext) continue;

      for (const a of container.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/p/') || href.includes('/reel/')) {
          const normalized = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          return normalized;
        }
      }
    }
    return '';
  }).then((url) => normalizeInstagramPostUrl(url)).catch(() => '');
}

async function assessInstagramCompletion(page) {
  const dom = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    
    const success =
      text.includes('your post has been shared') ||
      text.includes('your reel has been shared') ||
      text.includes('post shared') ||
      text.includes('reel shared') ||
      text.includes('your video has been shared') ||
      text.includes('shared successfully');
    
    const isStillInDialog = text.includes('sharing...') || text.includes('processing');
    
    const hardError =
      text.includes('couldn\'t share') ||
      text.includes('try again') ||
      text.includes('upload failed') ||
      text.includes('something went wrong');
    
    return { success, isStillInDialog, hardError, summary: text.slice(0, 1200) };
  }).catch(() => ({ success: false, isStillInDialog: false, hardError: false, summary: '' }));

  if (dom.success) return { success: true, reason: 'Instagram UI confirms share/upload completion.' };
  if (dom.isStillInDialog) return { success: false, needsHuman: false, reason: 'Instagram is still processing the share.' };
  if (dom.hardError) return { success: false, needsHuman: true, reason: 'Instagram UI shows a blocking share/upload error.' };

  try {
    const ai = await analyzePage(page, 'Instagram post completion check. Decide whether posting succeeded or needs manual action.');
    const state = String(ai?.state || '').toLowerCase();
    if (['success', 'shared', 'completed', 'published', 'done'].includes(state)) {
      return { success: true, reason: ai?.description || 'AI detected successful/processing completion state.' };
    }
    if (['processing', 'uploading', 'pending'].includes(state)) {
      return { success: false, needsHuman: false, reason: ai?.description || 'Instagram is still processing the share.' };
    }
    return {
      success: false,
      needsHuman: Boolean(ai?.needs_human),
      reason: ai?.description || 'No clear Instagram completion signal found.',
    };
  } catch {
    return { success: false, needsHuman: false, reason: 'No clear Instagram completion signal found.' };
  }
}

async function uploadToInstagram(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  const userDataDir = resolveUserDataDir(credentials?.browserProfileId, credentials?.accountId);
  fs.mkdirSync(userDataDir, { recursive: true });

  // Pre-process video to 9:16 with black padding for Instagram Reels
  const { processedPath, needsCleanup } = prepareVerticalVideo(videoPath);
  const actualVideoPath = processedPath;

  console.log(`[Instagram] Starting upload... (profile: ${credentials?.browserProfileId || credentials?.accountId || 'default'})`);
  const context = await launchPersistentSafe(chromium, userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  }, { label: `instagram:${credentials?.browserProfileId || credentials?.accountId || 'default'}` });

  const page = context.pages()[0] || await context.newPage();

  // Handle native browser beforeunload dialogs
  page.on('dialog', async (dialog) => {
    console.log(`[Instagram] Browser dialog: "${dialog.message()}" — dismissing`);
    await dialog.dismiss().catch(() => {});
  });

  try {
    // ===== PHASE 1: LOGIN =====
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie dialog
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('allow') || text.includes('accept') || text.includes('decline optional')) { btn.click(); break; }
      }
    });
    await page.waitForTimeout(1000);

    let loginAttempts = 0;
    let loginPageNavigated = false;
    let credentialsSubmitted = false;
    let verificationRequested = false;
    let stalledPageReloaded = false;
    while (loginAttempts++ < 15) {
      const pageState = await inspectInstagramAuthState(page);
      if (pageState.loggedIn) { console.log('[Instagram] Logged in'); break; }
      if (pageState.blockedReason) throw new Error(pageState.blockedReason);

      if (pageState.needsVerification && !verificationRequested) {
        verificationRequested = true;
        console.log('[Instagram] Account verification needed...');
        const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
        const approval = await requestTelegramApproval({
          telegram: credentials.telegram,
          platform: 'Instagram',
          backend: credentials.backend,
          screenshotBuffer,
          customMessage: '🔐 <b>Instagram verification needed</b>\nReply with APPROVED after device confirmation or CODE 123456 if a code is required.',
        });
        if (approval?.code) {
          await tryFillVerificationCode(page, approval.code);
        }
        await page.waitForTimeout(5000);
        continue;
      }
      if (pageState.needsVerification) {
        // Do not navigate away from a challenge after the single approval
        // request. Give Instagram time to apply the device confirmation.
        await page.waitForTimeout(3000);
        continue;
      }

      if (pageState.hasUsername && pageState.hasPassword && !credentialsSubmitted) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('Instagram session expired and saved login credentials are incomplete. Open this account profile once and log in manually.');
        }
        credentialsSubmitted = true;
        console.log('[Instagram] Filling login...');
        await smartFill(page, ['input[name="username"]'], credentials.email);
        await page.waitForTimeout(300);
        await smartFill(page, ['input[name="password"]'], credentials.password);
        await page.waitForTimeout(300);
        await smartClick(page, ['button[type="submit"]'], 'Log In');
        await page.waitForTimeout(5000);

        // Dismiss "Save login info", "Turn on notifications", cookie banners, etc.
        for (let i = 0; i < 4; i++) {
          await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              const t = (btn.textContent || '').toLowerCase().trim();
              if (t === 'not now' || t === 'cancel' || t === 'dismiss' || t === 'skip' ||
                  t.includes('not right now') || t.includes('not now')) {
                btn.click();
                return;
              }
            }
          });
          await page.waitForTimeout(1500);
        }
        continue;
      }

      // Neither logged-in markers nor a login form — explicitly navigate to login page once
      if (!loginPageNavigated) {
        loginPageNavigated = true;
        console.log('[Instagram] No login form found — navigating to /accounts/login/');
        await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
        continue;
      }

      // Recover one stale/partially-rendered login page. This happens after a
      // long-idle persistent profile, and is safe because no media is selected.
      if (!stalledPageReloaded && loginAttempts >= 4) {
        stalledPageReloaded = true;
        console.log('[Instagram] Login page stalled — reloading once before failing.');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);
        continue;
      }

      await page.waitForTimeout(3000);
    }

    const finalAuthState = await inspectInstagramAuthState(page);
    if (!finalAuthState.loggedIn) {
      if (finalAuthState.blockedReason) throw new Error(finalAuthState.blockedReason);
      if (finalAuthState.needsVerification) {
        throw new Error('Instagram verification is still pending. Complete the Telegram/device approval, then retry.');
      }
      throw new Error('Instagram session expired and bounded login recovery did not complete. Open this saved account profile once and log in manually.');
    }

    // Capture baseline latest post URL before starting a new upload to prevent false-success
    // links (old posts from profile grid).
    let profileUsername = '';
    let baselineProfilePostUrls = [];
    let latestPostBeforeUpload = '';
    try {
      profileUsername = await resolveInstagramUsername(page);
      if (profileUsername) {
        baselineProfilePostUrls = await fetchRecentInstagramPostUrlsFromProfile(page, profileUsername, 2, 8);
        latestPostBeforeUpload = baselineProfilePostUrls[0] || '';
        if (latestPostBeforeUpload) {
          console.log(`[Instagram] Baseline latest post URL before upload: ${latestPostBeforeUpload}`);
        }
      }
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    } catch (baselineErr) {
      console.warn('[Instagram] Could not capture baseline latest post URL (non-fatal):', baselineErr.message);
    }

    // ===== PHASE 2: CREATE NEW POST =====
    console.log('[Instagram] Creating new post...');
    
    // Try multiple ways to open new post dialog
    let newPostClicked = await smartClick(page, [
      '[aria-label="New post"]',
      'svg[aria-label="New post"]',
      '[aria-label="Create"]',
      'svg[aria-label="Create"]',
      '[aria-label="New Post"]',
      'svg[aria-label="New Post"]',
    ], 'New post');
    
    if (!newPostClicked) {
      newPostClicked = await page.evaluate(() => {
        // Try SVG-based icons with various labels
        const svgLabels = ['New post', 'Create', 'New Post', 'Новая публикация', 'Crear'];
        for (const label of svgLabels) {
          const svg = document.querySelector(`svg[aria-label="${label}"]`);
          if (svg) {
            const parent = svg.closest('a, button, div[role="button"], span[role="link"]');
            if (parent) { parent.click(); return true; }
            svg.click();
            return true;
          }
        }
        // Try finding the create/plus icon by its typical position (left sidebar)
        const sidebarLinks = document.querySelectorAll('nav a, nav div[role="button"], [role="navigation"] a');
        for (const link of sidebarLinks) {
          const text = (link.textContent || '').trim().toLowerCase();
          const label = (link.getAttribute('aria-label') || '').toLowerCase();
          if (text.includes('create') || text.includes('new post') ||
              label.includes('create') || label.includes('new post')) {
            link.click();
            return true;
          }
        }
        return false;
      });
    }
    
    // Agent fallback: use LLM with vision to find the Create button
    if (!newPostClicked) {
      console.log('[Instagram] Standard selectors failed, trying agent to find Create button...');
      try {
        const agentResult = await runAgentTask(page,
          'On Instagram\'s main page, find and click the "Create" or "New post" button in the left sidebar navigation. It usually has a plus (+) icon.',
          { maxSteps: 5, stepDelayMs: 500 });
        newPostClicked = agentResult.success;
      } catch (e) {
        console.warn('[Instagram] Agent create-button click failed:', e.message);
      }
    }
    
    if (!newPostClicked) {
      const arbiter = await attemptUploadArbiter(page, {
        platform: 'Instagram video',
        checkpoint: 'open create flow',
        originalError: 'Could not find Create/New post button.',
        allowedClickTexts: ['create', 'new post'],
        verify: () => page.evaluate(() => {
          const text = (document.body?.innerText || '').toLowerCase();
          return Boolean(document.querySelector('input[type="file"], [role="dialog"], [role="menu"]')) ||
            (text.includes('post') && text.includes('reel') && text.includes('story'));
        }).catch(() => false),
      });
      newPostClicked = arbiter.recovered;
      if (!newPostClicked) {
        throw new Error(`Instagram: Could not find Create/New post button. AI arbiter could not safely clear the obstacle: ${arbiter.reason}. Make sure you are logged in.`);
      }
    }

    await page.waitForTimeout(3000);

    // ===== PHASE 2.5: SELECT "POST" FROM CREATE MENU =====
    // After clicking "+", Instagram may show a dropdown menu with options: Post, Reel, Story, etc.
    // Explicitly select "Post" to get the standard video upload flow with 9:16 crop option.
    console.log('[Instagram] Checking for create menu to select Post...');
    let postFlowReady = await ensureInstagramPostFlow(page);
    let uploadSurface = await waitForInstagramUploadSurface(page, 9000);

    if (!uploadSurface.ready) {
      console.warn('[Instagram] Create flow did not expose the upload surface yet; trying direct Instagram create routes...');
      const forcedCreateSurface = await forceOpenInstagramUploadSurface(page);
      if (forcedCreateSurface) {
        postFlowReady = true;
        uploadSurface = await waitForInstagramUploadSurface(page, 5000);
      }
    }

    if (!postFlowReady && !uploadSurface.ready) {
      console.warn('[Instagram] Post option was not explicitly confirmed and upload surface is still missing; continuing with fallback uploader detection');
    }
    await page.waitForTimeout(1200);

    // ===== PHASE 3: SELECT VIDEO FILE =====
    console.log('[Instagram] Setting video file...');
    let fileUploaded = false;

    // Strategy 1: Direct file input (may already be visible from the dialog)
    let fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      try {
        await fileInput.setInputFiles(actualVideoPath);
        fileUploaded = true;
        console.log('[Instagram] Video set via direct file input');
      } catch (e) {
        console.warn('[Instagram] Direct setInputFiles failed:', e.message);
      }
    }

    // Strategy 2: Click "Select from computer" then use fileChooser
    if (!fileUploaded) {
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          (async () => {
            const clicked = await smartClick(page, [
              '[role="dialog"] button:has-text("Select from computer")',
              '[role="dialog"] div[role="button"]:has-text("Select from computer")',
              '[role="dialog"] label:has-text("Select from computer")',
              'button:has-text("Select from computer")',
              'button:has-text("Select From Computer")',
              'button:has-text("Select from Computer")',
              'div[role="button"]:has-text("Select from computer")',
              'div[role="button"]:has-text("Select From Computer")',
              'label:has-text("Select from computer")',
              'label:has-text("Choose from computer")',
              'button:has-text("Select")',
              'button:has-text("Choose")',
            ], 'Select from computer');
            if (!clicked) {
              await page.evaluate(() => {
                const nodes = document.querySelectorAll('button, label, div[role="button"], [role="button"], span');
                for (const node of nodes) {
                  const text = `${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`.toLowerCase();
                  if (
                    text.includes('select from computer') ||
                    text.includes('choose from computer') ||
                    text.includes('upload from computer') ||
                    text.includes('drag videos here') ||
                    text.includes('drag photos and videos here') ||
                    text.includes('select file') ||
                    text.includes('choose file')
                  ) {
                    node.click();
                    return;
                  }
                }
              });
            }
          })(),
        ]);
        await fileChooser.setFiles(actualVideoPath);
        fileUploaded = true;
        console.log('[Instagram] Video set via fileChooser + Select from computer');
      } catch (e) {
        console.warn('[Instagram] fileChooser with Select button failed:', e.message);
      }
    }

    // Strategy 3: Force-discover hidden file inputs
    if (!fileUploaded) {
      const discovered = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length > 0) {
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
          try {
            await fileInput.setInputFiles(actualVideoPath);
            fileUploaded = true;
            console.log('[Instagram] Video set via forced file input');
          } catch {}
        }
      }
    }

    // Strategy 4: Agent fallback
    if (!fileUploaded) {
      console.log('[Instagram] Trying agent to find file upload...');
      try {
        const agentResult = await runAgentTask(page,
          'Find and click the "Select from computer" or similar button to open a file upload dialog on Instagram\'s create post dialog.',
          { maxSteps: 5, stepDelayMs: 500 });
        if (agentResult.success) {
          // Try file input again after agent interaction
          fileInput = await page.$('input[type="file"]');
          if (fileInput) {
            await fileInput.setInputFiles(actualVideoPath);
            fileUploaded = true;
          }
        }
      } catch {}
    }
    
    if (!fileUploaded) {
      const arbiter = await attemptUploadArbiter(page, {
        platform: 'Instagram video',
        checkpoint: 'upload input available',
        originalError: `Upload dialog not found after opening create flow at ${page.url()}.`,
        // The arbiter may clear Retry/cookie/promotional blockers, but it may
        // not press the file-picker itself. Existing code owns file selection.
        allowedClickTexts: [],
        verify: async () => Boolean(await page.$('input[type="file"]').catch(() => null)),
      });
      if (arbiter.recovered) {
        fileInput = await page.$('input[type="file"]').catch(() => null);
        if (fileInput) {
          await fileInput.setInputFiles(actualVideoPath);
          fileUploaded = true;
        }
      }
      if (!fileUploaded) {
        throw new Error(`Instagram upload dialog not found after opening create flow (url: ${page.url()}). AI arbiter could not safely clear the obstacle: ${arbiter.reason}. Try creating a post manually first to verify your session.`);
      }
    }

    console.log('[Instagram] Video file set, waiting for video to load in dialog...');

    // Wait for Instagram to process the uploaded video — look for a video preview or thumbnail
    for (let loadWait = 0; loadWait < 30; loadWait++) {
      const loadState = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return { loaded: false, hasDialog: false };
        const text = (dialog.textContent || '').toLowerCase();
        // Check if video preview rendered (video element, canvas, or img in dialog)
        const hasVideo = !!dialog.querySelector('video, canvas, img[src*="blob:"], img[src*="cdninstagram"]');
        // Check for loading indicators
        const isLoading = text.includes('loading') || text.includes('processing') ||
          !!dialog.querySelector('[role="progressbar"], [aria-label*="loading" i]');
        // Check for crop/trim controls which mean video is ready
        const hasCropControls = text.includes('crop') || text.includes('trim') || text.includes('adjust') ||
          text.includes('next') || text.includes('original') || text.includes('1:1') || text.includes('4:5') ||
          text.includes('16:9');
        return { loaded: hasVideo || hasCropControls, hasDialog: true, isLoading, hasCropControls };
      }).catch(() => ({ loaded: false, hasDialog: false }));

      if (loadState.loaded) {
        console.log(`[Instagram] Video loaded in dialog (crop controls: ${loadState.hasCropControls})`);
        break;
      }
      if (loadWait >= 29) {
        console.warn('[Instagram] Video load wait timed out, proceeding anyway');
      }
      await page.waitForTimeout(2000);
    }

    // Extra settle time for video to fully render
    await page.waitForTimeout(3000);

    console.log('[Instagram] Video loaded; continuing in reel composer...');
    await page.waitForTimeout(1500);

    // ===== PHASE 3.5: SELECT 9:16 VERTICAL ASPECT RATIO =====
    console.log('[Instagram] Attempting to select 9:16 aspect ratio in crop screen...');

    const trySelectInstagramCropRatio = async () => {
      // Strategy A: Playwright locator — handles scroll-into-view and React events natively.
      // Try multiple text/label variants since Instagram sometimes changes the label.
      const playwrightLocatorAttempts = [
        () => page.locator('[role="dialog"]').getByText('9:16', { exact: true }).first(),
        () => page.locator('[role="dialog"]').getByText('9:16').first(),
        () => page.locator('[role="dialog"] [aria-label*="9:16" i]').first(),
        () => page.locator('[role="dialog"] [aria-label*="9 16" i]').first(),
        () => page.locator('[role="dialog"] [aria-label*="vertical" i]').first(),
      ];

      for (const getLocator of playwrightLocatorAttempts) {
        try {
          const loc = getLocator();
          if (await loc.isVisible({ timeout: 600 })) {
            await loc.click({ force: true });
            await page.waitForTimeout(400);
            return '9:16';
          }
        } catch {}
      }

      // Strategy B: Coordinate-based mouse click — find the button via DOM, then click at
      // its viewport coordinates so React synthetic handlers fire (DOM .click() bypasses them).
      const nodeBox = await page.evaluate(() => {
        const scope = document.querySelector('[role="dialog"]') || document.body;
        const isVisible = (node) => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

        const nodes = Array.from(scope.querySelectorAll('button, label, div[role="button"], span[role="button"], [role="menuitem"], [role="tab"], span, div'));

        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const text = normalize(node.textContent);
          const label = normalize(node.getAttribute('aria-label'));
          // Match common text/label variants used by Instagram across different locales/versions
          if (
            text === '9:16' || text === '9 : 16' ||
            text.includes('9:16') || text.includes('9 / 16') ||
            label.includes('9:16') || label.includes('9 16') || label.includes('vertical')
          ) {
            const target = node.closest('button, label, [role="button"], [role="menuitem"], [role="tab"]') || node;
            const rect = target.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, found: true };
          }
        }
        return { found: false };
      }).catch(() => ({ found: false }));

      if (nodeBox?.found) {
        // Use Playwright mouse click (dispatches full mousedown/mouseup/click chain)
        // which is more reliable than a bare DOM .click() for React event handlers
        await page.mouse.click(nodeBox.x, nodeBox.y);
        await page.waitForTimeout(400);
        return '9:16';
      }
      return '';
    };

    // Step 1: First try to find the aspect ratio toggle button in the bottom-left of the crop screen
    // and click it to open the aspect ratio picker
    const openCropPicker = async () => {
      // Collect candidate coordinates via page.evaluate, then use page.mouse.click() so that
      // React synthetic event handlers (onClick, onMouseDown) fire correctly — DOM-level node.click()
      // inside evaluate() bypasses React's event delegation and the picker never opens.
      const coords = await page.evaluate(() => {
        const scope = document.querySelector('[role="dialog"]') || document.body;
        const frame = scope.getBoundingClientRect();
        const isVisible = (node) => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const centerOf = (node) => {
          const r = node.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };

        const clickables = Array.from(scope.querySelectorAll('button, div[role="button"], [role="button"], svg'));

        // Strategy A: labeled crop/aspect button — highest confidence
        for (const rawNode of clickables) {
          const node = rawNode.closest('button, [role="button"]') || rawNode;
          if (!isVisible(node)) continue;
          const label = normalize(node.getAttribute('aria-label'));
          if (label.includes('crop') || label.includes('aspect') || label.includes('resize') ||
              label.includes('select crop') || label.includes('photo outline')) {
            return { ...centerOf(node), found: true };
          }
        }

        // Strategy B: bottom-left icon button in the crop preview area
        let bestNode = null;
        let bestScore = -1;

        for (const rawNode of clickables) {
          const node = rawNode.closest('button, [role="button"]') || rawNode;
          if (!isVisible(node)) continue;
          const rect = node.getBoundingClientRect();

          // Must be in the bottom-left quadrant of the dialog
          if (rect.left > frame.left + frame.width * 0.45) continue;
          if (rect.top < frame.top + frame.height * 0.40) continue;

          const label = normalize(node.getAttribute('aria-label'));
          const hasSvg = !!node.querySelector('svg') || node.tagName.toLowerCase() === 'svg';
          const text = normalize(node.textContent);
          let score = 0;

          if (hasSvg) score += 8;
          if (!text || text.length < 3) score += 4;
          if (label.includes('crop') || label.includes('aspect') || label.includes('resize') || label.includes('original')) score += 10;
          score += Math.max(0, (frame.left + frame.width * 0.3 - rect.left) / 10);
          score += Math.max(0, (rect.top - frame.top - frame.height * 0.5) / 10);

          if (score > bestScore) {
            bestScore = score;
            bestNode = node;
          }
        }

        if (bestNode && bestScore > 3) {
          return { ...centerOf(bestNode), found: true };
        }

        return { found: false };
      }).catch(() => ({ found: false }));

      if (coords?.found) {
        await page.mouse.click(coords.x, coords.y);
        return true;
      }

      return false;
    };

    let selectedAspectRatio = await trySelectInstagramCropRatio();

    if (!selectedAspectRatio) {
      const cropToggleClicked = await openCropPicker();
      if (cropToggleClicked) {
        console.log('[Instagram] Opened crop ratio picker from lower-left control');
        // Wait for the aspect-ratio panel animation to fully complete
        await page.waitForTimeout(3000);
        selectedAspectRatio = await trySelectInstagramCropRatio();
        // Retry up to 3 more times if the first attempts didn't register (panel still animating)
        for (let retryIdx = 0; retryIdx < 3 && !selectedAspectRatio; retryIdx++) {
          await page.waitForTimeout(1200);
          selectedAspectRatio = await trySelectInstagramCropRatio();
        }
      }
    }

    // If still not found, try clicking the crop toggle again with a broader search
    if (!selectedAspectRatio) {
      try {
        // Use smartClick to find common crop toggle selectors
        const cropClicked = await smartClick(page, [
          '[role="dialog"] [aria-label*="crop" i]',
          '[role="dialog"] [aria-label*="aspect" i]',
          '[role="dialog"] [aria-label*="Select crop" i]',
          '[role="dialog"] [aria-label*="photo outline" i]',
        ], 'crop toggle');
        if (cropClicked) {
          await page.waitForTimeout(1200);
          selectedAspectRatio = await trySelectInstagramCropRatio();
        }
      } catch {}
    }

    if (!selectedAspectRatio) {
      try {
        console.log('[Instagram] Trying agent to select 9:16 aspect ratio...');
        const result = await runAgentTask(page,
          'Instagram crop/resize stage is open. In the bottom-left corner of the dialog, there is a small icon button that opens the aspect ratio picker. Click that button first to reveal aspect ratio options (like Original, 1:1, 4:5, 9:16, 16:9). Then select the "9:16" option. Do NOT click Next.',
          { maxSteps: 6, stepDelayMs: 700, useVision: true });
        if (result.success) {
          selectedAspectRatio = '9:16';
        }
      } catch (e) {
        console.warn('[Instagram] Agent aspect ratio selection failed:', e.message);
      }
    }

    if (selectedAspectRatio) {
      console.log(`[Instagram] Selected ${selectedAspectRatio} aspect ratio in crop screen`);
      await page.waitForTimeout(1200);
    } else {
      console.warn('[Instagram] Could not explicitly select 9:16 in crop screen; video will be uploaded with pre-processed 9:16 dimensions');
    }

    // Wait for the upload dialog/modal to appear
    const dialogAppeared = await page.waitForSelector('[role="dialog"], [aria-label*="create" i], [aria-label*="post" i]', { timeout: 10000 })
      .then(() => true).catch(() => false);
    if (dialogAppeared) {
      console.log('[Instagram] Upload dialog confirmed');
    }

    // ===== PHASE 4: CLICK THROUGH CROP/ADJUST SCREENS =====
    // Instagram shows: Crop → Edit (Cover photo/Trim) → Filter → Caption screens
    // The "Next" button is at the TOP of the dialog popup — do NOT scroll the page background.

    // Helper: detect which upload step the dialog is currently on.
    // Returns one of: 'caption' | 'edit' | 'filter' | 'crop' | 'unknown'
    const detectUploadStep = () => page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]') || document.body;
      const text = (dialog.innerText || dialog.textContent || '').toLowerCase();
      // Caption screen — check for the actual caption input field first (most specific)
      const hasCaptionField = !!dialog.querySelector(
        '[aria-label="Write a caption..."], [aria-label*="Write a caption"], ' +
        'textarea[placeholder*="caption" i], [contenteditable="true"][aria-label*="caption" i]',
      );
      if (hasCaptionField || text.includes('write a caption')) return 'caption';
      // Edit screen (Cover photo / Trim) — appears after Crop
      if ((text.includes('cover photo') || text.includes('trim')) && !text.includes('write a caption')) return 'edit';
      // Filter/Lux screen — appears between Edit and Caption on Reels
      if (text.includes('add a filter') || (text.includes('filter') && !text.includes('cover photo'))) return 'filter';
      // Crop / aspect-ratio screen — first screen after file selection
      if (
        text.includes('crop') || text.includes('original') ||
        text.includes('9:16') || text.includes('1:1') || text.includes('4:5') || text.includes('16:9')
      ) return 'crop';
      return 'unknown';
    }).catch(() => 'unknown');

    // Helper: find the header "Next"/"Continue" button inside the upload dialog.
    // The cover-photo step renders many non-header "Next" nodes, so restrict matching to the
    // visible header band and prefer the rightmost candidate there.
    const NEXT_BUTTON_POLL_INTERVAL_MS = 400;
    // How long to wait after the caption screen appears before trying to interact with elements.
    // Instagram's React re-renders the caption screen DOM after the initial mount, so element
    // handles obtained too early become stale ("not attached to DOM") before they can be clicked.
    const CAPTION_SCREEN_STABILIZATION_DELAY_MS = 2500;
    const findDialogHeaderNextButton = (options = {}) => page.evaluate(({ includeDisabled = false } = {}) => {
      const dialogEl = document.querySelector('[role="dialog"]') || document.body;
      const dialogRect = dialogEl.getBoundingClientRect();
      // Instagram keeps the header action row within a shallow top band of the dialog.
      // Use a capped ratio so we still match the header on both short and tall upload modals
      // without drifting into the cover-photo carousel controls below it.
      const HEADER_BAND_MAX_PX = 140;
      const HEADER_BAND_MIN_PX = 72;
      const HEADER_BAND_HEIGHT_RATIO = 0.22;
      // Keep the final bare div selector because Instagram sometimes renders the header action as
      // a plain div with only text; later filters narrow this broad scan back to the top header band.
      const nextCandidateSelector = 'button, [role="button"], a, span, div[tabindex], div';
      // Prefer true interactive ancestors when available, but still allow a plain text wrapper as a
      // last resort because Instagram occasionally omits role/tabindex on the header action.
      const headerBandMaxTop = Math.min(
        HEADER_BAND_MAX_PX,
        Math.max(HEADER_BAND_MIN_PX, dialogRect.height * HEADER_BAND_HEIGHT_RATIO),
      );
      const interactiveSelector = 'button, [role="button"], a, [tabindex]';
      const seen = new Set();
      const candidates = [];
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
      const allEls = dialogEl.querySelectorAll(nextCandidateSelector);
      const getNextLabelMeta = (el) => {
        const raw = (el.textContent || '').trim().toLowerCase();
        const rendered = (el.innerText || raw).trim().toLowerCase();
        const label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const hasVisibleTextMatch =
          raw === 'next' || rendered === 'next' ||
          raw === 'continue' || rendered === 'continue';
        const hasAriaLabelMatch = label === 'next' || label === 'continue';
        return (
          {
            matches: hasVisibleTextMatch || hasAriaLabelMatch,
            hasVisibleTextMatch,
          }
        );
      };

      for (const el of allEls) {
        const labelMeta = getNextLabelMeta(el);
        if (!labelMeta.matches) continue;

        const candidate = el.closest(interactiveSelector) || el;
        if (!dialogEl.contains(candidate) || seen.has(candidate)) continue;
        seen.add(candidate);

        if (!candidate.matches(interactiveSelector)) {
          // Skip wrapper nodes when a deeper matching child exists so coordinate clicks land on the
          // innermost visible control instead of an outer layout container with the same text.
          const hasMatchingChild = Array.from(candidate.querySelectorAll(nextCandidateSelector))
            .some((child) => child !== candidate && getNextLabelMeta(child).matches);
          if (hasMatchingChild) continue;
        }

        const rect = candidate.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;

        const relativeTop = rect.top - dialogRect.top;
        if (relativeTop < -4 || relativeTop > headerBandMaxTop) continue;

        const style = window.getComputedStyle(candidate);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0' ||
          style.pointerEvents === 'none'
        ) {
          continue;
        }

        const disabled = candidate.hasAttribute('disabled') || candidate.getAttribute('aria-disabled') === 'true';
        if (!includeDisabled && disabled) continue;

        const x = clamp(rect.left + rect.width / 2, rect.left + 1, rect.right - 1);
        const y = clamp(rect.top + rect.height / 2, rect.top + 1, rect.bottom - 1);
        const topEl = document.elementFromPoint(x, y);
        if (topEl && !(candidate === topEl || candidate.contains(topEl) || topEl.contains(candidate))) continue;

        candidates.push({
          top: relativeTop,
          left: rect.left - dialogRect.left,
          x,
          y,
          disabled,
          hasVisibleTextMatch: labelMeta.hasVisibleTextMatch,
        });
      }

      if (candidates.length === 0) return null;
      const visibleTextCandidates = candidates.filter((c) => c.hasVisibleTextMatch);
      const prioritized = visibleTextCandidates.length > 0 ? visibleTextCandidates : candidates;
      // Sort by header height first (top ascending), then by horizontal position (left descending)
      // so ties resolve to the furthest-right header action instead of left-side controls.
      prioritized.sort((a, b) => (a.top - b.top) || (b.left - a.left));
      return prioritized[0];
    }, options).catch(() => null);

    const waitForDialogHeaderNextEnabled = async (timeoutMs) => {
      const startedAt = Date.now();
      while ((Date.now() - startedAt) < timeoutMs) {
        const candidate = await findDialogHeaderNextButton({ includeDisabled: true });
        if (candidate && !candidate.disabled) return true;
        await page.waitForTimeout(NEXT_BUTTON_POLL_INTERVAL_MS);
      }
      return false;
    };

    let stuckIterations = 0;
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(2000);

      // Stop early if we've reached the caption/share screen
      const alreadyOnCaption = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]') || document.body;
        // Use specific checks to avoid false positives from the Crop/Edit screens.
        // Instagram pre-renders the caption field in the DOM even while on the Edit/Cover-photo
        // screen, so we MUST verify the field is actually visible inside the dialog viewport —
        // not just that it exists in the DOM or that "write a caption" appears anywhere in the
        // page text (which would catch hidden pre-rendered content).
        const dialogViewRect = dialog.getBoundingClientRect();
        const isInDialogViewport = (rect) =>
          rect.width > 0 && rect.height > 5 &&
          rect.top >= (dialogViewRect.top - 20) &&
          rect.bottom <= (dialogViewRect.bottom + 20);
        const captionFieldVisible = (() => {
          // Check contenteditable caption fields
          const ceSelectors = ['[aria-label="Write a caption..."]', '[aria-label*="Write a caption"]', '[contenteditable="true"][aria-label*="caption" i]'];
          for (const sel of ceSelectors) {
            const el = dialog.querySelector(sel);
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (isInDialogViewport(rect) && style.display !== 'none' && style.visibility !== 'hidden') return true;
          }
          // Also check textarea caption fields (Instagram Posts may use <textarea>)
          const ta = dialog.querySelector('textarea[placeholder*="caption" i]');
          if (ta) {
            const rect = ta.getBoundingClientRect();
            const style = window.getComputedStyle(ta);
            if (isInDialogViewport(rect) && style.display !== 'none' && style.visibility !== 'hidden') return true;
          }
          return false;
        })();
        return captionFieldVisible;
      }).catch(() => false);
      if (alreadyOnCaption) {
        console.log('[Instagram] Already on caption screen, stopping Next clicks');
        break;
      }

      // Detect current screen for step-aware handling.
      // Crop and Edit screens both need extra waiting for the Next button to become enabled.
      const currentStep = await detectUploadStep();
      const onEditScreen = currentStep === 'edit';
      const onCropScreen = currentStep === 'crop';
      console.log(`[Instagram] Upload step ${i + 1}/5: current screen = "${currentStep}"`);

      // Wait for the topmost "Next" button to become enabled.
      // On the Edit screen Instagram must finish generating cover-photo thumbnails (can take
      // 20-40+ s for long videos).  On the Crop screen the button may be briefly disabled while
      // the aspect-ratio animation settles.
      const needsNextWait = onEditScreen || onCropScreen;
      if (needsNextWait) {
        const waitLabel = onEditScreen ? 'Edit screen (Cover photo/Trim)' : 'Crop screen';
        const waitTimeout = onEditScreen ? 50000 : 12000;
        console.log(`[Instagram] On ${waitLabel}, waiting for Next button to become enabled...`);
        const nextButtonBecameEnabled = await waitForDialogHeaderNextEnabled(waitTimeout);
        if (!nextButtonBecameEnabled) {
          console.log(`[Instagram] ${waitLabel}: Next button not enabled after ${waitTimeout / 1000}s wait, trying anyway`);
        }

        // If still disabled, force-click the visible "Next" text button in the dialog header.
        // Playwright force:true bypasses pointer-events:none without scrolling the page background.
        if (!nextButtonBecameEnabled) {
          try {
            const dialogLoc = page.locator('[role="dialog"]').first();
            // :text-is("Next") matches by VISIBLE text only — thumbnail nav arrows carry
            // aria-label="Next" but have no visible text, so they won't accidentally match.
            const candidates = [
              dialogLoc.locator(':text-is("Next")').first(),
              page.locator(':text-is("Next")').first(),
            ];
            for (const loc of candidates) {
              try {
                if (await loc.count() > 0) {
                  await loc.click({ force: true, timeout: 2000 });
                  console.log(`[Instagram] ${waitLabel}: Force-clicked Next button after timeout`);
                  break;
                }
              } catch {
                // Force-click may throw if element detaches mid-transition — safe to ignore.
              }
            }
          } catch {
            // Outer guard for unexpected locator API errors.
          }
        }
      }

      // Strategy 1: Coordinate-based mouse click — get viewport coordinates of the topmost
      // enabled "Next" button via page.evaluate(), then fire a real page.mouse.click() at those
      // coordinates.  This is the SAME reliable approach used by openCropPicker() and
      // trySelectInstagramCropRatio().  Benefits:
      //   • Dispatches full mousedown/mousemove/mouseup/click chain → React events fire reliably.
      //   • Clicks at existing viewport coordinates — no scroll-into-view, so the page background
      //     behind the dialog is NEVER accidentally scrolled.
      //   • Works regardless of whether Instagram renders the button as <button>, <div>, <span>.
      //
      // IMPORTANT: On the Cover Photo / Edit screen there are TWO kinds of "Next" element:
      //   1. The dialog-HEADER "Next" button (top of the dialog) — advances to the next screen.
      //   2. Thumbnail navigation "Next" arrow (mid-dialog, aria-label="Next") — cycles covers.
      // Sorting candidates by their distance from the top of the dialog and picking the smallest
      // value guarantees we always click the header button, not a thumbnail navigation arrow.
      const clickNextInDialog = async () => {
        const coords = await findDialogHeaderNextButton();

        if (!coords) return false;
        // page.mouse.click() at the current viewport position — no element scrolling occurs.
        await page.mouse.click(coords.x, coords.y);
        return true;
      };

      let clicked = await clickNextInDialog();

      // On the Edit/Crop screen, if still not clicked after the wait, give it one more grace period.
      if (!clicked && (onEditScreen || onCropScreen)) {
        await page.waitForTimeout(3000);
        clicked = await clickNextInDialog();
      }

      // Strategy 2: Playwright locator click scoped to the dialog.
      // Use force:true to skip scroll-into-view — this prevents Playwright from scrolling
      // the page background behind the dialog popup when trying to reach the button.
      if (!clicked) {
        try {
          const dialogLoc = page.locator('[role="dialog"]').first();
          const nextLoc = dialogLoc.locator(':text-is("Next"), :text-is("Continue")').first();
          if (await nextLoc.count() > 0) {
            await nextLoc.click({ force: true, timeout: 3000 });
            clicked = true;
            console.log('[Instagram] Strategy 2: Clicked Next via Playwright locator (force:true)');
          }
        } catch {}
      }

      // Strategy 2b: Broader selector fallback (still dialog-scoped)
      if (!clicked) {
        clicked = await smartClick(page, [
          '[role="dialog"] button:has-text("Next")',
          '[role="dialog"] div[role="button"]:has-text("Next")',
          '[role="dialog"] a:has-text("Next")',
          '[role="dialog"] span:has-text("Next")',
        ], 'Next');
      }

      // Agent fallback — instruct it NOT to scroll the page background
      if (!clicked) {
        try {
          const result = await runAgentTask(page,
            'There is an Instagram post creation dialog/popup open. Click the "Next" button that is visible at the TOP of the dialog to advance to the next step. Do NOT scroll the page background. Only interact with the dialog popup.',
            { maxSteps: 4, stepDelayMs: 600, useVision: true });
          clicked = result.success;
        } catch {}
      }

      // On the Edit screen, verify we actually navigated away after clicking Next.
      // If still on Edit/Crop screen, the click may have landed on a still-disabled button — reset
      // clicked so the next iteration retries properly (avoids burning all 5 loop slots).
      // IMPORTANT: Do NOT use "write a caption" text as a negative signal — Instagram pre-renders
      // the caption field DOM node on all steps, so innerText may contain "write a caption" even
      // while the Edit screen is visible.  Instead check that a caption input is VISIBLE in the
      // dialog viewport, which is a reliable indication we actually advanced to the caption screen.
      if (clicked && onEditScreen) {
        await page.waitForTimeout(1500);
        const stillOnEdit = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]') || document.body;
          const text = (dialog.innerText || dialog.textContent || '').toLowerCase();
          // Must still show Edit screen indicators
          if (!text.includes('cover photo') && !text.includes('trim')) return false;
          // Check whether a caption input is NOW visible in the viewport — if so we've navigated
          const dialogViewRect = dialog.getBoundingClientRect();
          const captionInputs = dialog.querySelectorAll(
            '[aria-label="Write a caption..."], [aria-label*="Write a caption"], ' +
            'textarea[placeholder*="caption" i], [contenteditable="true"][aria-label*="caption" i]'
          );
          for (const el of captionInputs) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (
              rect.height > 5 && style.display !== 'none' && style.visibility !== 'hidden' &&
              rect.top >= (dialogViewRect.top - 20) && rect.bottom <= (dialogViewRect.bottom + 20)
            ) {
              return false; // caption input is visible — we've left the Edit screen
            }
          }
          return true; // Edit indicators present and no visible caption input → still on Edit
        }).catch(() => false);
        if (stillOnEdit) {
          console.log('[Instagram] Edit screen: still visible after Next click — click may not have registered, will retry');
          clicked = false;
        }
      }

      if (clicked && onCropScreen) {
        await page.waitForTimeout(1500);
        const stillOnCrop = await detectUploadStep().then(s => s === 'crop').catch(() => false);
        if (stillOnCrop) {
          console.log('[Instagram] Crop screen: still visible after Next click — click may not have registered, will retry');
          clicked = false;
        }
      }

      // Don't break early on a failed click when we know which step we're on and it needs retries.
      // Only break if Next wasn't found AND we're on an unknown/filter step (no special retry needed).
      if (!clicked) {
        stuckIterations += 1;
        // After 2 consecutive stuck iterations, an Instagram tip/announcement overlay
        // (e.g. "Video posts are now shared as reels") may be blocking interaction.
        // Try to dismiss it before continuing.
        if (stuckIterations >= 2) {
          console.log('[Instagram] Stuck for 2+ iterations — attempting to dismiss tip overlay');
          await dismissOverlayBlockingFlow(page, { logPrefix: '[Instagram]' });
          stuckIterations = 0;
        }
        if (!onEditScreen && !onCropScreen) break;
      } else {
        stuckIterations = 0;
      }
      await page.waitForTimeout(2000);
    }

    // ===== PHASE 5: ADD CAPTION =====
    // First verify we're on the caption/share screen — look for a VISIBLE caption INPUT field
    // within the dialog viewport. Do NOT use broad selectors like [contenteditable="true"] or
    // [aria-label*="caption" i] here because Instagram renders those on the Edit/Cover-photo
    // screen too (the alt-text input and pre-rendered caption field), causing false positives.
    const onCaptionScreen = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]') || document.body;
      const dialogViewRect = dialog.getBoundingClientRect();
      const captionInputs = dialog.querySelectorAll(
        '[aria-label="Write a caption..."], [aria-label*="Write a caption"], ' +
        'textarea[placeholder*="caption" i], [contenteditable="true"][aria-label*="caption" i]'
      );
      for (const el of captionInputs) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (
          rect.height > 5 && style.display !== 'none' && style.visibility !== 'hidden' &&
          rect.top >= (dialogViewRect.top - 20) && rect.bottom <= (dialogViewRect.bottom + 20)
        ) {
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (!onCaptionScreen) {
      console.log('[Instagram] Not on caption screen yet, trying to advance...');
      // Use coordinate-based click to avoid [aria-label="Next"] which matches the cover-photo
      // carousel arrow. findDialogHeaderNextButton() restricts to the header band only.
      const nextCoords = await findDialogHeaderNextButton();
      if (nextCoords) {
        await page.mouse.click(nextCoords.x, nextCoords.y);
      } else {
        await smartClick(page, [
          '[role="dialog"] button:has-text("Next")',
          'button:has-text("Next")',
          'div[role="button"]:has-text("Next")',
        ], 'Next');
      }
      await page.waitForTimeout(2000);
    }

    let caption = '';
    let captionFilled = false;
    let captionSelectors = [];
    let captionTruncated = '';

    if (metadata?.description || (metadata?.tags && metadata.tags.length > 0)) {
      const captionParts = [];
      if (metadata.description) captionParts.push(metadata.description);
      if (metadata.tags?.length) captionParts.push(metadata.tags.map(t => t.startsWith('#') ? t : '#' + t).join(' '));
      caption = captionParts.join('\n\n').trim();
      console.log(`[Instagram] Caption to fill (${caption.length} chars): ${caption.slice(0, 200)}...`);

      // Wait for a caption-specific field to appear in the dialog (not a generic contenteditable
      // which can match elements on the Edit/Cover-photo screen and cause false-ready signals).
      await page.waitForSelector(
        '[role="dialog"] [aria-label="Write a caption..."], ' +
        '[role="dialog"] [aria-label*="Write a caption"], ' +
        '[role="dialog"] textarea[placeholder*="caption" i], ' +
        '[role="dialog"] [contenteditable="true"][aria-label*="caption" i]',
        { timeout: 10000 }
      )
        .then(() => console.log('[Instagram] Caption field detected in dialog'))
        .catch(() => console.warn('[Instagram] Caption field not detected by waitForSelector, trying anyway'));
      // Give React/Instagram time to finish DOM transitions after navigating to the caption screen.
      // Without this, element handles obtained via page.$() may become detached before we can click them.
      await page.waitForTimeout(CAPTION_SCREEN_STABILIZATION_DELAY_MS);

      captionSelectors = [
        '[role="dialog"] [aria-label="Write a caption..."]',
        '[role="dialog"] [aria-label*="Write a caption"]',
        '[role="dialog"] [aria-label*="caption" i]',
        '[role="dialog"] textarea[aria-label*="caption" i]',
        '[role="dialog"] textarea[placeholder*="caption" i]',
        '[role="dialog"] [contenteditable="true"]',
        '[role="dialog"] textarea',
        '[aria-label="Write a caption..."]',
        '[contenteditable="true"]',
        'textarea',
      ];

      captionTruncated = caption.slice(0, MAX_CAPTION_LENGTH);

      // Strategy 0: Direct textarea value set — for native <textarea> elements.
      // Instagram Posts may use a <textarea>. We set the value via the native setter
      // to bypass React's synthetic event handling, then verify AFTER React has had
      // time to process the event (the previous implementation verified synchronously,
      // which always returned true even when React/DraftJS didn't update its state).
      if (!captionFilled) {
        const attempted = await page.evaluate((text) => {
          const dialog = document.querySelector('[role="dialog"]') || document.body;
          const textareas = Array.from(dialog.querySelectorAll('textarea'));
          for (const ta of textareas) {
            const rect = ta.getBoundingClientRect();
            const style = window.getComputedStyle(ta);
            if (rect.height < 5 || style.display === 'none' || style.visibility === 'hidden') continue;
            ta.focus();
            ta.click();
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(ta, text);
            } else {
              ta.value = text;
            }
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        }, captionTruncated);

        if (attempted) {
          // Wait for React to process the event and potentially re-render.
          // If React ignored the event, it will reset ta.value to '' on next render.
          // If React accepted it, ta.value will remain non-empty.
          await page.waitForTimeout(900);
          captionFilled = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]') || document.body;
            for (const ta of Array.from(dialog.querySelectorAll('textarea'))) {
              const style = window.getComputedStyle(ta);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              if ((ta.value || '').trim().length > 5) return true;
            }
            return false;
          });
          if (captionFilled) console.log('[Instagram] Caption filled via direct textarea value set');
        }
      }

      // Strategy 1: Native clipboard paste via Playwright keyboard shortcut.
      // DraftJS ignores synthetic ClipboardEvent but processes real Ctrl+V natively.
      if (!captionFilled) {
        for (const sel of captionSelectors) {
          if (captionFilled) break;
          try {
            const el = await page.$(sel);
            if (!el) continue;
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;

            // Re-query immediately before clicking to avoid a stale element handle — Instagram's
            // React may re-render the caption screen components between our visibility check and
            // the click, causing "Element is not attached to the DOM" errors.
            const freshEl = await page.$(sel);
            if (!freshEl) continue;
            await freshEl.click();
            await page.waitForTimeout(600);

            // Clear existing content
            await page.keyboard.press('Control+a');
            await page.waitForTimeout(150);
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(150);

            // Write to clipboard and paste natively
            await page.evaluate((text) => navigator.clipboard.writeText(text), captionTruncated);
            await page.waitForTimeout(200);
            await page.keyboard.press('Control+v');
            await page.waitForTimeout(1500);

            // Settle: click away then back to force DraftJS state flush.
            // IMPORTANT: Only use the video element as neutral target — clicking img or [role="img"]
            // elements can match cover photo thumbnails still in the DOM and navigate back to the
            // Edit screen, breaking the caption flow.
            const neutralEl = await page.$('[role="dialog"] video');
            if (neutralEl) {
              await neutralEl.click().catch(() => {});
              await page.waitForTimeout(500);
              await el.click();
              await page.waitForTimeout(500);
            }

            // Verify caption persisted in DraftJS state
            const pasted = await page.evaluate(() => {
              const dialog = document.querySelector('[role="dialog"]') || document.body;
              const sels = [
                '[aria-label="Write a caption..."]',
                '[aria-label*="Write a caption"]',
                '[aria-label*="caption" i]',
                'textarea[placeholder*="caption" i]',
              ];
              for (const s of sels) {
                const f = dialog.querySelector(s);
                if (!f) continue;
                const rect = f.getBoundingClientRect();
                if (rect.height < 5) continue;
                const content = (f.textContent || f.value || '').trim();
                if (content.length > 5) return true;
              }
              // Also check any contenteditable with substantial text
              for (const ce of dialog.querySelectorAll('[contenteditable="true"]')) {
                if (ce.getBoundingClientRect().height < 5) continue;
                if ((ce.textContent || '').trim().length > 5) return true;
              }
              return false;
            });

            if (pasted) {
              captionFilled = true;
              console.log(`[Instagram] Caption filled via native Ctrl+V paste on ${sel}`);
            }
          } catch (e) {
            console.warn(`[Instagram] Native paste strategy failed on ${sel}:`, e.message);
          }
        }
      }

      // Strategy 2: Keyboard typing with higher delay for DraftJS to keep up
      if (!captionFilled) {
        for (const sel of captionSelectors) {
          if (captionFilled) break;
          try {
            const el = await page.$(sel);
            if (!el) continue;
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            
            await el.click();
            await page.waitForTimeout(800);
            await page.keyboard.press('Control+a');
            await page.waitForTimeout(200);
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(200);

            // Type in chunks with intermediate verification
            const chunkSize = 500;
            for (let i = 0; i < captionTruncated.length; i += chunkSize) {
              const chunk = captionTruncated.slice(i, i + chunkSize);
              await page.keyboard.type(chunk, { delay: 35 });
              await page.waitForTimeout(300);
            }
            await page.waitForTimeout(1000);

            // Settle: click away and back.
            // Only use the video element as neutral target — img elements can match cover photo
            // thumbnails and trigger navigation back to the Edit screen.
            const neutralEl = await page.$('[role="dialog"] video');
            if (neutralEl) {
              await neutralEl.click().catch(() => {});
              await page.waitForTimeout(500);
              await el.click();
              await page.waitForTimeout(500);
            }
            
            const typed = await page.evaluate(() => {
              const dialog = document.querySelector('[role="dialog"]') || document.body;
              const sels = [
                '[aria-label="Write a caption..."]',
                '[aria-label*="Write a caption"]',
                '[aria-label*="caption" i]',
                'textarea[placeholder*="caption" i]',
              ];
              for (const s of sels) {
                const f = dialog.querySelector(s);
                if (!f) continue;
                const rect = f.getBoundingClientRect();
                if (rect.height < 5) continue;
                const content = (f.textContent || f.value || '').trim();
                if (content.length > 0) return content;
              }
              for (const ce of dialog.querySelectorAll('[contenteditable="true"]')) {
                if (ce.getBoundingClientRect().height < 5) continue;
                const c = (ce.textContent || '').trim();
                if (c.length > 0) return c;
              }
              return '';
            }).catch(() => '');
            
            if (typed.length > 0) {
              captionFilled = true;
              console.log(`[Instagram] Caption filled via keyboard on ${sel} (${typed.length} chars verified)`);
            } else {
              console.log(`[Instagram] Keyboard fill on ${sel} unverified, trying next...`);
            }
          } catch (e) {
            console.warn(`[Instagram] Keyboard caption strategy failed on ${sel}:`, e.message);
          }
        }
      }

      // Strategy 3: DOM execCommand (deprecated but still works in some headless builds)
      if (!captionFilled) {
        captionFilled = await page.evaluate((text) => {
          const editors = document.querySelectorAll(
            '[contenteditable="true"], textarea[aria-label*="caption" i], ' +
            '[aria-label="Write a caption..."], [aria-label*="Write a caption"],' +
            'textarea[placeholder*="caption" i], textarea'
          );
          for (const editor of editors) {
            if (editor.offsetHeight === 0) continue;
            editor.focus();
            editor.click();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
            const content = editor.textContent || editor.value || '';
            if (content.length > 0) return true;
          }
          return false;
        }, captionTruncated);
        if (captionFilled) console.log('[Instagram] Caption filled via execCommand');
      }

      // Strategy 4: Agent fallback
      if (!captionFilled) {
        console.warn('[Instagram] Could not fill caption with standard methods, trying agent...');
        try {
          await runAgentTask(page,
            `Find the caption text field (it may say "Write a caption...") and type the following text into it: "${caption.slice(0, 300)}"`,
            { maxSteps: 5, stepDelayMs: 500 });
          captionFilled = true;
        } catch (e) {
          console.warn('[Instagram] Agent caption fill failed:', e.message);
        }
      }

      if (!captionFilled) {
        console.warn('[Instagram] WARNING: Caption could not be filled. The post will be shared without a description.');
      }
    }
    await page.waitForTimeout(2000);

    // ===== PRE-SHARE CAPTION VERIFICATION =====
    // Final check: re-read caption field right before Share. If empty despite earlier success, retry once.
    if (caption && captionFilled) {
      const preShareCheck = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]') || document.body;
        const sels = [
          '[aria-label="Write a caption..."]',
          '[aria-label*="Write a caption"]',
          '[aria-label*="caption" i]',
          '[contenteditable="true"]',
          'textarea',
        ];
        for (const s of sels) {
          const f = dialog.querySelector(s);
          if (!f) continue;
          if (f.getBoundingClientRect().height < 5) continue;
          const content = (f.textContent || f.value || '').trim();
          if (content.length > 5) return true;
        }
        return false;
      });

      if (!preShareCheck) {
        console.warn('[Instagram] Pre-share check: caption field appears empty! Retrying with keyboard.type...');
        const retryCaption = captionTruncated || caption.slice(0, MAX_CAPTION_LENGTH);
        // Find and fill caption field one last time
        for (const sel of captionSelectors) {
          try {
            const el = await page.$(sel);
            if (!el) continue;
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            await el.click();
            await page.waitForTimeout(500);
            await page.keyboard.press('Control+a');
            await page.waitForTimeout(150);
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(150);
            await page.keyboard.type(retryCaption, { delay: 35 });
            await page.waitForTimeout(1500);
            console.log('[Instagram] Pre-share caption retry completed');
            break;
          } catch (e) {
            console.warn('[Instagram] Pre-share caption retry failed:', e.message);
          }
        }
      } else {
        console.log('[Instagram] Pre-share check: caption content verified ✓');
      }
    }

    // ===== PHASE 6: SHARE =====
    console.log('[Instagram] Sharing...');

    // Use LLM vision to confirm we are on the caption/share screen before clicking Share
    try {
      const shareCheck = await analyzePage(page,
        'Instagram post creation dialog: Are we on the final "Share" step where the caption has been filled? Is the blue "Share" button visible in the dialog? Describe the current state.');
      console.log(`[Instagram] Pre-share vision check: ${shareCheck?.description || 'no response'}`);
    } catch (e) {
      console.warn('[Instagram] Pre-share vision check failed (non-fatal):', e.message);
    }

    const shareReady = await waitForInstagramShareButtonReady(page, INSTAGRAM_SHARE_READY_MAX_WAIT_MS);
    if (!shareReady.ready && !shareReady.alreadyShared) {
      console.warn(`[Instagram] Share button readiness timeout: ${shareReady.reason}`);
    }

    // Click Share within the dialog once it's truly ready.
    let shareClicked = shareReady.alreadyShared ? true : false;
    if (!shareClicked) {
      for (let shareClickAttempt = 1; shareClickAttempt <= 4; shareClickAttempt++) {
        shareClicked = await clickInstagramShareButton(page);
        if (shareClicked) {
          const postClickStateChanged = await page.waitForFunction(() => {
            const text = (document.body?.innerText || '').toLowerCase();
            const url = window.location.href;
            const sharingOrShared =
              text.includes('sharing...') ||
              text.includes('processing') ||
              text.includes('your reel has been shared') ||
              text.includes('your post has been shared') ||
              text.includes('post shared') ||
              text.includes('reel shared') ||
              text.includes('shared successfully');
            const redirectedToFeed = url === 'https://www.instagram.com/';
            return sharingOrShared || redirectedToFeed;
          }, { timeout: 10000 }).then(() => true).catch(() => false);

          if (postClickStateChanged) {
            break;
          }
          console.log(`[Instagram] Share click attempt ${shareClickAttempt} did not trigger state change, retrying...`);
        }

        await page.waitForTimeout(1500);
      }
    }
    
    if (!shareClicked) {
      console.warn('[Instagram] Could not find Share button, requesting human help...');
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      await requestTelegramApproval({
        telegram: credentials.telegram,
        platform: 'Instagram',
        backend: credentials.backend,
        screenshotBuffer,
        screenshotCaption: '📸 <b>Instagram upload ready</b> — click Share and reply APPROVED',
        customMessage: '🚧 <b>Instagram uploader needs help</b>\nPlease click the Share button and reply APPROVED.',
      });
    }
    
    // Wait for Instagram share animation to finish, then immediately hand off to profile capture.
    console.log('[Instagram] Waiting for share animation/result to finish...');
    let postUrl = await extractInstagramPostUrl(page);

    const sharingWait = await waitForInstagramSharingToFinish(page, INSTAGRAM_SHARE_PROCESSING_MAX_WAIT_MS);
    if (!sharingWait.finished) {
      console.warn(`[Instagram] Share-processing wait timeout: ${sharingWait.reason}`);
    } else {
      console.log(`[Instagram] Share-processing completed: ${sharingWait.reason}`);
    }

    postUrl = postUrl || await extractInstagramPostUrl(page);

    // ===== PHASE 7: CHECK COMPLETION AND EXTRACT URL =====
    let completion = await assessInstagramCompletion(page);

    // If explicit success text wasn't detected but share-processing phase already completed,
    // proceed to profile verification instead of waiting a long extra window on this screen.
    if (!completion.success && sharingWait.finished) {
      completion = { success: true, needsHuman: false, reason: sharingWait.reason };
    }

    // Only do short retries when we still suspect upload is processing.
    if (!completion.success && !completion.needsHuman) {
      for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(3000);
        completion = await assessInstagramCompletion(page);
        postUrl = postUrl || await extractInstagramPostUrl(page);
        if (completion.success) break;
      }
    }

    if (!completion.success) {
      const arbiter = await attemptUploadArbiter(page, {
        platform: 'Instagram video',
        checkpoint: 'post-submit confirmation',
        originalError: completion.reason,
        submissionAttempted: true,
        verify: async () => (await assessInstagramCompletion(page)).success,
      });
      if (arbiter.recovered) {
        completion = await assessInstagramCompletion(page);
        postUrl = postUrl || await extractInstagramPostUrl(page);
      }
    }

    if (!completion.success && completion.needsHuman) {
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      await requestTelegramApproval({
        telegram: credentials.telegram,
        platform: 'Instagram',
        backend: credentials.backend,
        screenshotBuffer,
        screenshotCaption: '📸 <b>Instagram obstacle screen</b> — reply APPROVED once the step is completed',
        customMessage: `🚧 <b>Instagram uploader needs your help</b>\n${completion.reason}\n\nResolve the visible step and reply APPROVED.`,
      });

      await page.waitForTimeout(8000);
      completion = await assessInstagramCompletion(page);
      postUrl = postUrl || await extractInstagramPostUrl(page);
    }

    postUrl = normalizeInstagramPostUrl(postUrl);

    if (!profileUsername) {
      profileUsername = await resolveInstagramUsername(page);
    }

    // Always wait for a genuinely new URL on profile when possible (YouTube-like publish polling).
    // This prevents false positives where Share was clicked but publish had not finalized yet.
    if (profileUsername) {
      const newlyPublishedUrl = await waitForNewInstagramPostUrl(
        page,
        profileUsername,
        baselineProfilePostUrls,
        INSTAGRAM_PROFILE_PUBLISH_WAIT_ATTEMPTS,
      );
      if (!newlyPublishedUrl) {
        throw new Error('Instagram share popup completed, but no new reel/post appeared on profile yet. Upload was not confirmed as finished.');
      }

      postUrl = newlyPublishedUrl;
      completion = { success: true, needsHuman: false, reason: 'Verified new Instagram URL appeared on profile.' };
      console.log(`[Instagram] Verified new reel/post URL from profile: ${postUrl}`);
    }

    if (!completion.success && !postUrl) {
      throw new Error(`Instagram publish was not confirmed. ${completion.reason}`);
    }

    const baselineUrlSet = new Set((baselineProfilePostUrls || []).map((url) => normalizeInstagramPostUrl(url)).filter(Boolean));

    if (postUrl && baselineUrlSet.has(postUrl)) {
      throw new Error('Instagram publish was not confirmed as a new post. Captured URL already existed before upload.');
    }

    if (postUrl && latestPostBeforeUpload && postUrl === latestPostBeforeUpload) {
      throw new Error('Instagram publish was not confirmed as a new post. Latest profile post URL remained unchanged.');
    }

    if (postUrl) {
      console.log(`[Instagram] Using verified URL: ${postUrl}`);
    }

    postUrl = normalizeInstagramPostUrl(postUrl);
    if (!postUrl) {
      throw new Error('Instagram publish could not be verified with a real post URL. No /p/ or /reel/ link was found.');
    }
    if (latestPostBeforeUpload && postUrl === latestPostBeforeUpload) {
      throw new Error('Instagram publish was not confirmed as a new post. Latest profile post URL remained unchanged.');
    }

    console.log(`[Instagram] Upload complete! URL: ${postUrl || '(no URL extracted)'}`);

    await context.close();
    if (needsCleanup && actualVideoPath !== videoPath) {
      try { fs.unlinkSync(actualVideoPath); console.log('[Instagram] Cleaned up temp vertical video'); } catch {}
    }
    return { url: postUrl || '' };
  } catch (err) {
    console.error('[Instagram] Upload failed:', err.message);
    if (needsCleanup && actualVideoPath !== videoPath) {
      try { fs.unlinkSync(actualVideoPath); } catch {}
    }
    await context.close();
    throw err;
  }
}

module.exports = { uploadToInstagram, __test: { classifyInstagramAuthSnapshot } };
