// Facebook post uploader using a persistent Chrome profile.
// Full replacement for facebook.js.
// Keeps existing external contract: module.exports = { uploadToFacebook }.

const { launchPersistent, safeClose } = require('./social-post-base');

function normalizeFacebookPermalink(raw) {
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw, 'https://www.facebook.com');
  } catch {
    return null;
  }

  if (/(^|\.)facebook\.com$/i.test(url.hostname) && /^\/l\.php$/i.test(url.pathname)) {
    const embedded = url.searchParams.get('u');
    if (embedded) return normalizeFacebookPermalink(embedded);
  }

  if (/(^|\.)facebook\.com$/i.test(url.hostname) && /^\/plugins\/post\.php$/i.test(url.pathname)) {
    const embedded = url.searchParams.get('href');
    if (embedded) return normalizeFacebookPermalink(embedded);
  }

  if (!/(^|\.)(facebook|fb)\.com$/i.test(url.hostname)) return null;

  url.hash = '';

  const origin = 'https://www.facebook.com';
  const path = url.pathname.replace(/\/$/, '');
  const story = url.searchParams.get('story_fbid') || url.searchParams.get('fbid');
  const owner = url.searchParams.get('id');

  const combinedPath = path.match(/^\/(\d+)_(\d+)$/);
  if (combinedPath) {
    return `${origin}/permalink.php?story_fbid=${encodeURIComponent(combinedPath[2])}&id=${encodeURIComponent(combinedPath[1])}`;
  }

  if (story && owner) {
    return `${origin}/permalink.php?story_fbid=${encodeURIComponent(story)}&id=${encodeURIComponent(owner)}`;
  }

  if (
    /\/(?:posts|videos|reel|watch|photo|photos)\//i.test(path)
    || /^\/(?:photo|watch|reel)$/i.test(path)
    || /\/[^/]+\/permalink\//i.test(path)
    || /\/groups\/[^/]+\/(?:posts|permalink)\//i.test(path)
    || /\/permalink\.php$/i.test(path)
    || /\/story\.php$/i.test(path)
    || /\/photo\.php$/i.test(path)
    || /\/(?:share|shareable)\/(?:p|r|v|post|video)\//i.test(path)
    || /\/shares?\//i.test(path)
  ) {
    const keep = new URLSearchParams();

    for (const key of ['story_fbid', 'fbid', 'id']) {
      const value = url.searchParams.get(key);
      if (value) keep.set(key, value);
    }

    const query = keep.toString();
    return `${origin}${path}${query ? `?${query}` : ''}`;
  }

  return null;
}

function normalizePostText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#\w+/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFacebookPermalinkFromText(raw) {
  const text = String(raw || '');
  const candidates = [];

  for (const match of text.matchAll(/https?:\\?\/\\?\/(?:www\.|web\.|m\.)?(?:facebook|fb)\.com[^\s"'<>\\)]+/gi)) {
    candidates.push(match[0].replace(/\\\//g, '/').replace(/\\u0025/g, '%'));
  }

  for (const encoded of text.matchAll(/https?%3A%2F%2F(?:www\.|web\.|m\.)?(?:facebook|fb)\.com[^\s"'<>\\)]+/gi)) {
    try {
      candidates.push(decodeURIComponent(encoded[0]));
    } catch {}
  }

  for (const candidate of candidates) {
    const normalized = normalizeFacebookPermalink(candidate);
    if (normalized) return normalized;
  }

  return null;
}

async function prepareFacebookViewport(page) {
  await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});

  await page.context().newCDPSession(page).then(async (session) => {
    const win = await session.send('Browser.getWindowForTarget').catch(() => null);

    if (win && win.windowId) {
      await session.send('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { windowState: 'maximized' },
      }).catch(() => {});
    }
  }).catch(() => {});

  await page.keyboard.press('Control+0').catch(() => {});
  await page.waitForTimeout(500);
}

async function readFacebookClipboardUrl(page) {
  const clipped = await page.evaluate(() => navigator.clipboard?.readText?.()).catch(() => null);
  return normalizeFacebookPermalink(clipped) || extractFacebookPermalinkFromText(clipped);
}

async function facebookComposerOpen(page) {
  return await page.evaluate(() => {
    const textboxes = Array.from(document.querySelectorAll('div[role="textbox"][contenteditable="true"]'));

    return textboxes.some((tb) => {
      const r = tb.getBoundingClientRect();
      const style = window.getComputedStyle(tb);

      return r.width > 0
        && r.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    });
  }).catch(() => false);
}

async function clickFacebookModernComposerEntry(page) {
  const phrases = ['on your mind', 'Write something', 'Create post'];

  for (const phrase of phrases) {
    const els = page.getByText(phrase, { exact: false });
    const count = await els.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const el = els.nth(i);

      if (await el.isVisible().catch(() => false)) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);

        if (await facebookComposerOpen(page)) return true;
      }
    }
  }

  for (const phrase of phrases) {
    const els = page.locator(`[aria-label*="${phrase}" i]`);
    const count = await els.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const el = els.nth(i);

      if (await el.isVisible().catch(() => false)) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);

        if (await facebookComposerOpen(page)) return true;
      }
    }
  }

  return false;
}

async function findVisibleComposerTextbox(page) {
  const textboxes = page.locator(
    'div[role="dialog"] div[role="textbox"][contenteditable="true"], div[role="textbox"][contenteditable="true"]'
  );

  const count = await textboxes.count().catch(() => 0);

  for (let i = count - 1; i >= 0; i--) {
    const tb = textboxes.nth(i);

    if (await tb.isVisible().catch(() => false)) {
      return tb;
    }
  }

  return null;
}

async function insertFacebookTextIntoActiveComposer(page, fullText, { required = true } = {}) {
  if (!fullText) return true;

  const textbox = await findVisibleComposerTextbox(page);

  if (!textbox) {
    if (required) throw new Error('Facebook composer textbox is not visible.');
    return false;
  }

  await textbox.scrollIntoViewIfNeeded().catch(() => {});
  await textbox.click({ force: true }).catch(async () => {
    await textbox.evaluate((node) => node.focus()).catch(() => {});
  });

  await page.waitForTimeout(300);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});

  await page.keyboard.insertText(fullText).catch(async () => {
    await page.keyboard.type(fullText, { delay: 10 });
  });

  await page.waitForTimeout(800);
  return true;
}

async function clickVisibleDialogButton(page, names, timeout = 20000) {
  const wanted = names.map((n) => String(n).toLowerCase());
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const clicked = await page.evaluate((wantedNames) => {
      function isVisible(el) {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return r.width > 0
          && r.height > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none';
      }

      function isDisabled(el) {
        return el.getAttribute('aria-disabled') === 'true'
          || el.getAttribute('disabled') !== null
          || Boolean(el.closest('[aria-disabled="true"]'));
      }

      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(isVisible);
      const scopes = dialogs.length ? dialogs.reverse() : [document.body];

      for (const scope of scopes) {
        const candidates = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(isVisible);

        for (const el of candidates) {
          if (isDisabled(el)) continue;

          const text = (el.innerText || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

          const aria = (el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

          if (wantedNames.some((name) => text === name || aria === name)) {
            el.click();
            return true;
          }
        }
      }

      return false;
    }, wanted).catch(() => false);

    if (clicked) return true;
    await page.waitForTimeout(500);
  }

  return false;
}

async function clickFacebookNextSteps(page) {
  for (let step = 0; step < 4; step++) {
    const clicked = await clickVisibleDialogButton(page, ['Next', 'Done'], 2500);

    if (!clicked) break;

    await page.waitForTimeout(2500);
  }
}

async function attachImagesToFacebookComposer(page, imageFiles) {
  if (!imageFiles.length) return;

  let attached = false;

  const inputCandidates = [
    page.locator('div[role="dialog"] input[type="file"][accept*="image"]').last(),
    page.locator('div[role="dialog"] input[type="file"]').last(),
    page.locator('input[type="file"][accept*="image"]').last(),
    page.locator('input[type="file"]').last(),
  ];

  for (const input of inputCandidates) {
    if (!(await input.count().catch(() => 0))) continue;

    attached = await input
      .setInputFiles(imageFiles, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    if (attached) break;
  }

  if (!attached) {
    const attachBtn = page.locator(
      'div[role="dialog"] [aria-label="Photo/video"], div[role="dialog"] [aria-label*="Photo" i], [aria-label="Photo/video"], [aria-label*="Photo" i]'
    ).last();

    const chooserPromise = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
    await attachBtn.click({ force: true }).catch(() => {});

    const chooser = await chooserPromise;

    if (chooser) {
      await chooser.setFiles(imageFiles);
      attached = true;
    }
  }

  if (!attached) {
    throw new Error('Facebook image picker opened but no controllable file input was found.');
  }

  await page.waitForTimeout(6000 + (imageFiles.length * 1800));

  await clickFacebookNextSteps(page);
}

async function clickFacebookVerifiedPostButton(page) {
  const clicked = await clickVisibleDialogButton(page, ['Post'], 30000);

  if (clicked) return true;

  throw new Error('Could not click the Facebook Post button. Leaving source files for retry.');
}

async function waitForFacebookPublishToFinish(page) {
  await page.waitForFunction(() => {
    const visibleDialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter((d) => {
      const r = d.getBoundingClientRect();
      const style = window.getComputedStyle(d);

      return r.width > 0
        && r.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    });

    if (!visibleDialogs.length) return true;

    return visibleDialogs.every((dialog) => {
      const text = (dialog.innerText || '').toLowerCase();

      return text.includes('whatsapp')
        || text.includes('boost post')
        || text.includes('make it easier')
        || text.includes('invite friends')
        || text.includes('turn on notifications');
    });
  }, { timeout: 180000 }).catch(() => {});

  await page.waitForTimeout(5000);
}

async function dismissFacebookPostPublishPrompts(page) {
  for (let i = 0; i < 4; i++) {
    const closed = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      let found = false;

      for (const dialog of dialogs) {
        if (/whatsapp|make it easier|boost post|invite friends|turn on notifications/i.test(dialog.innerText || '')) {
          const btns = Array.from(dialog.querySelectorAll('[role="button"], button, a'));

          const closeBtn = btns.find((button) =>
            /not now|skip|done|close|×|x/i.test(button.innerText || button.getAttribute('aria-label') || '')
          );

          if (closeBtn) {
            closeBtn.click();
            found = true;
          }
        }
      }

      return found;
    }).catch(() => false);

    if (!closed) break;

    await page.waitForTimeout(1500);
  }
}

async function waitForFacebookShareDialog(page, timeout = 9000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const open = await page.evaluate(() => {
      function isVisible(el) {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return r.width > 0
          && r.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      }

      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(isVisible);

      return dialogs.some((dialog) => {
        const text = (dialog.innerText || '').toLowerCase();

        return text.includes('copy link')
          || text.includes('share now')
          || text.includes('whatsapp')
          || text.includes('your story');
      });
    }).catch(() => false);

    if (open) return true;

    await page.waitForTimeout(300);
  }

  return false;
}

async function getCopyLinkClickPoints(page) {
  return await page.evaluate(() => {
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return r.width > 0
        && r.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none';
    }

    function centerPoint(r) {
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      };
    }

    const points = [];
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'))
      .filter(isVisible)
      .reverse();

    for (const dialog of dialogs) {
      const dialogText = (dialog.innerText || '').toLowerCase();

      if (!dialogText.includes('copy link')) continue;

      const d = dialog.getBoundingClientRect();
      const all = Array.from(dialog.querySelectorAll('*')).filter(isVisible);

      // 1. Find exact visible "Copy link" label.
      const labelElements = all.filter((el) => {
        const text = (el.innerText || el.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();

        return text === 'copy link';
      });

      for (const labelEl of labelElements) {
        const r = labelEl.getBoundingClientRect();

        // In Facebook's UI the actual clickable circle icon is above the label.
        points.push({
          x: r.left + r.width / 2,
          y: r.top - 34,
          reason: 'icon above Copy link label',
        });

        points.push({
          x: r.left + r.width / 2,
          y: r.top - 44,
          reason: 'higher icon above Copy link label',
        });

        points.push({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          reason: 'Copy link label center',
        });

        // Try parent clickable tile if it exists.
        const clickable = labelEl.closest('[role="button"], button, [role="menuitem"], a');
        if (clickable && isVisible(clickable)) {
          points.push({
            ...centerPoint(clickable.getBoundingClientRect()),
            reason: 'Copy link clickable parent',
          });
        }
      }

      // 2. Find any clickable element whose text/aria includes "Copy link".
      const candidateElements = [];

      for (const el of all) {
        const label = `${el.innerText || ''} ${el.getAttribute?.('aria-label') || ''}`
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();

        if (!label.includes('copy link')) continue;

        const clickable = el.closest('[role="button"], button, [role="menuitem"], a') || el;
        if (!isVisible(clickable)) continue;

        const r = clickable.getBoundingClientRect();

        candidateElements.push({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          area: r.width * r.height,
          reason: 'element containing Copy link',
        });
      }

      candidateElements.sort((a, b) => b.area - a.area);

      for (const c of candidateElements.slice(0, 8)) {
        points.push(c);
      }

      // 3. Dialog-layout coordinate fallbacks.
      // Your screenshot: Copy link is the third icon in the bottom row.
      points.push({
        x: d.left + d.width * 0.425,
        y: d.bottom - 72,
        reason: 'dialog fallback copy icon center',
      });

      points.push({
        x: d.left + d.width * 0.425,
        y: d.bottom - 58,
        reason: 'dialog fallback copy lower icon',
      });

      points.push({
        x: d.left + d.width * 0.425,
        y: d.bottom - 40,
        reason: 'dialog fallback copy label',
      });

      points.push({
        x: d.left + d.width * 0.405,
        y: d.bottom - 72,
        reason: 'dialog fallback copy icon left adjustment',
      });

      points.push({
        x: d.left + d.width * 0.445,
        y: d.bottom - 72,
        reason: 'dialog fallback copy icon right adjustment',
      });

      break;
    }

    // Deduplicate close points.
    const unique = [];

    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < 0 || p.y < 0 || p.x > window.innerWidth || p.y > window.innerHeight) continue;

      const duplicate = unique.some((u) => Math.abs(u.x - p.x) < 5 && Math.abs(u.y - p.y) < 5);
      if (!duplicate) unique.push(p);
    }

    return unique;
  }).catch(() => []);
}

async function clickCopyLinkInOpenFacebookShareDialog(page) {
  console.log('[Facebook] Trying to click Copy link in Share dialog...');

  await page.evaluate(() => navigator.clipboard?.writeText?.('')).catch(() => {});

  const dialogOpen = await waitForFacebookShareDialog(page, 6000);
  if (!dialogOpen) {
    console.log('[Facebook] Share dialog is not open, cannot click Copy link.');
    return null;
  }

  const points = await getCopyLinkClickPoints(page);

  if (!points.length) {
    console.log('[Facebook] Could not find Copy link click coordinates.');
    return null;
  }

  for (let i = 0; i < points.length; i++) {
    const p = points[i];

    console.log(`[Facebook] Copy link click attempt ${i + 1}/${points.length}: x=${Math.round(p.x)}, y=${Math.round(p.y)}, reason=${p.reason || 'unknown'}`);

    await page.mouse.move(p.x, p.y).catch(() => {});
    await page.waitForTimeout(250);
    await page.mouse.click(p.x, p.y).catch(() => {});
    await page.waitForTimeout(700);

    // Some Facebook elements need a JS click on the element under the same point.
    await page.evaluate(({ x, y }) => {
      function isVisible(el) {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return r.width > 0
          && r.height > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none';
      }

      const target = document.elementFromPoint(x, y);
      if (!target) return false;

      const clickable = target.closest('[role="button"], button, [role="menuitem"], a') || target;

      if (!isVisible(clickable)) return false;

      clickable.click();
      return true;
    }, { x: p.x, y: p.y }).catch(() => false);

    for (let poll = 0; poll < 8; poll++) {
      await page.waitForTimeout(400);

      const url = await readFacebookClipboardUrl(page);
      if (url) {
        console.log(`[Facebook] Clipboard copied Facebook link: ${url}`);
        return url;
      }
    }
  }

  const finalTry = await readFacebookClipboardUrl(page);
  if (finalTry) {
    console.log(`[Facebook] Clipboard copied Facebook link after final read: ${finalTry}`);
    return finalTry;
  }

  console.log('[Facebook] Clicked Copy link candidates, but clipboard did not contain a valid Facebook URL.');
  return null;
}

async function clickBestVisibleShareButton(page, fullText, { allowLatestFallback = false } = {}) {
  const expected = normalizePostText(fullText);

  const importantWords = expected
    .split(' ')
    .filter((w) => w.length >= 4)
    .slice(0, 24);

  const best = await page.evaluate(({ expected, importantWords, allowLatestFallback }) => {
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return r.width > 0
        && r.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && r.bottom > 70
        && r.top < window.innerHeight - 20
        && r.right > 300
        && r.left < window.innerWidth - 20;
    }

    function normalize(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, '')
        .replace(/#\w+/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function clean(value) {
      return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    function ancestorScore(el) {
      let bestScore = 0;
      let bestText = '';

      let cur = el;

      for (let depth = 0; cur && depth < 22; depth++, cur = cur.parentElement) {
        if (!isVisible(cur)) continue;

        const r = cur.getBoundingClientRect();

        if (r.width < 300 || r.width > 1100) continue;
        if (r.height < 90 || r.height > 2200) continue;
        if (r.left < 260) continue;

        const rawText = cur.innerText || '';
        const text = normalize(rawText);

        if (!text) continue;

        let score = 0;

        const firstChunk = expected.slice(0, Math.min(45, expected.length));
        if (firstChunk && text.includes(firstChunk)) {
          score += 3500;
        }

        if (importantWords.length) {
          const matched = importantWords.filter((w) => text.includes(w)).length;
          score += matched * 180;
        }

        if (/technewslist/i.test(rawText)) score += 450;
        if (/just now|now|1m|2m|3m|4m|5m|minute|min/i.test(rawText)) score += 700;

        if (r.left > 500 && r.left < window.innerWidth - 300) score += 500;

        if (r.top > 80 && r.top < window.innerHeight) {
          score += Math.max(0, 1000 - r.top);
        }

        if (/like/i.test(rawText) && /comment/i.test(rawText)) score += 500;

        if (score > bestScore) {
          bestScore = score;
          bestText = rawText.slice(0, 260);
        }
      }

      return { score: bestScore, text: bestText };
    }

    const allNodes = Array.from(
      document.querySelectorAll('[role="button"], button, a, div, span')
    ).filter(isVisible);

    const candidates = [];

    for (const node of allNodes) {
      const label = clean(`${node.innerText || ''} ${node.getAttribute?.('aria-label') || ''}`);

      if (!(label === 'share' || label.endsWith(' share') || label.includes('share'))) {
        continue;
      }

      if (node.closest('div[role="dialog"]')) continue;

      const clickable = node.closest('[role="button"], button, a') || node;
      if (!isVisible(clickable)) continue;

      const r = clickable.getBoundingClientRect();
      const aScore = ancestorScore(clickable);

      let score = aScore.score;

      if (r.left > window.innerWidth / 2) score += 700;
      if (r.left > 900) score += 300;
      if (r.top > 250) score += 200;

      score += Math.max(0, r.left - 500) / 2;
      score += Math.max(0, r.top - 200) / 3;

      if (score >= 900 || allowLatestFallback) {
        candidates.push({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          score: score || 1,
          label,
          ancestorText: aScore.text,
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
        });
      }
    }

    if (!candidates.length && allowLatestFallback) {
      const fallbackShares = [];

      for (const node of allNodes) {
        const label = clean(`${node.innerText || ''} ${node.getAttribute?.('aria-label') || ''}`);
        if (!(label === 'share' || label.endsWith(' share') || label.includes('share'))) continue;
        if (node.closest('div[role="dialog"]')) continue;

        const clickable = node.closest('[role="button"], button, a') || node;
        if (!isVisible(clickable)) continue;

        const r = clickable.getBoundingClientRect();

        if (r.left < 650 || r.left > window.innerWidth - 60) continue;
        if (r.top < 220) continue;

        fallbackShares.push({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          score: r.left + r.top,
          label,
          ancestorText: '',
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
        });
      }

      fallbackShares.sort((a, b) => b.score - a.score);
      if (fallbackShares[0]) return fallbackShares[0];
    }

    candidates.sort((a, b) => b.score - a.score || b.top - a.top || b.left - a.left);

    return candidates[0] || null;
  }, { expected, importantWords, allowLatestFallback }).catch(() => null);

  if (!best) {
    console.log('[Facebook] No visible Share candidate found.');
    return false;
  }

  console.log(`[Facebook] Clicking visible Share candidate: score=${Math.round(best.score)}, x=${Math.round(best.x)}, y=${Math.round(best.y)}, label="${best.label}"`);

  await page.mouse.move(best.x, best.y).catch(() => {});
  await page.waitForTimeout(300);
  await page.mouse.click(best.x, best.y).catch(() => {});

  let opened = await waitForFacebookShareDialog(page, 9000);

  if (opened) return true;

  console.log('[Facebook] Share click did not open dialog. Trying JS element click fallback.');

  const clickedByJs = await page.evaluate(({ x, y }) => {
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return r.width > 0
        && r.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    }

    const el = document.elementFromPoint(x, y);
    if (!el) return false;

    const clickable = el.closest('[role="button"], button, a') || el;

    if (!isVisible(clickable)) return false;

    clickable.click();
    return true;
  }, { x: best.x, y: best.y }).catch(() => false);

  if (clickedByJs) {
    opened = await waitForFacebookShareDialog(page, 7000);
    if (opened) return true;
  }

  return false;
}

async function clickShareByPostCardGeometry(page, fullText, { allowLatestFallback = false } = {}) {
  const expected = normalizePostText(fullText);

  const importantWords = expected
    .split(' ')
    .filter((w) => w.length >= 4)
    .slice(0, 24);

  const card = await page.evaluate(({ expected, importantWords, allowLatestFallback }) => {
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return r.width > 0
        && r.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && r.bottom > 80
        && r.top < window.innerHeight - 20;
    }

    function normalize(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, '')
        .replace(/#\w+/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const candidates = [];
    const nodes = Array.from(document.querySelectorAll('[role="article"], div')).filter(isVisible);

    for (const node of nodes) {
      const r = node.getBoundingClientRect();

      if (r.width < 430 || r.width > 900) continue;
      if (r.height < 180 || r.height > 1300) continue;
      if (r.left < 450 || r.right > window.innerWidth - 40) continue;

      const raw = node.innerText || '';
      const text = normalize(raw);

      if (!text) continue;

      let score = 0;

      const firstChunk = expected.slice(0, Math.min(45, expected.length));
      if (firstChunk && text.includes(firstChunk)) score += 3500;

      if (importantWords.length) {
        const matched = importantWords.filter((w) => text.includes(w)).length;
        score += matched * 180;
      }

      if (/technewslist/i.test(raw)) score += 450;
      if (/just now|now|1m|2m|3m|4m|5m|minute|min/i.test(raw)) score += 700;
      if (/like/i.test(raw) && /comment/i.test(raw)) score += 500;

      if (r.top > 80 && r.top < window.innerHeight) {
        score += Math.max(0, 1000 - r.top);
      }

      if (score >= 900 || allowLatestFallback) {
        candidates.push({
          score: score || Math.max(1, 1000 - Math.abs(r.top)),
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          text: raw.slice(0, 220),
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.top - b.top);

    return candidates[0] || null;
  }, { expected, importantWords, allowLatestFallback }).catch(() => null);

  if (!card) {
    console.log('[Facebook] No post card geometry candidate found.');
    return false;
  }

  console.log(`[Facebook] Geometry card candidate: score=${Math.round(card.score)}, left=${Math.round(card.left)}, top=${Math.round(card.top)}, right=${Math.round(card.right)}, bottom=${Math.round(card.bottom)}`);

  const points = [
    { x: card.right - 90, y: card.bottom - 25 },
    { x: card.right - 105, y: card.bottom - 28 },
    { x: card.right - 120, y: card.bottom - 30 },
    { x: card.right - 90, y: card.bottom - 65 },
    { x: card.right - 105, y: card.bottom - 70 },
    { x: card.right - 120, y: card.bottom - 75 },
    { x: card.right - 150, y: card.bottom - 25 },
    { x: card.right - 150, y: card.bottom - 70 },
  ];

  for (const point of points) {
    if (point.x < 0 || point.y < 0) continue;

    console.log(`[Facebook] Geometry-clicking possible Share at x=${Math.round(point.x)}, y=${Math.round(point.y)}`);

    await page.mouse.move(point.x, point.y).catch(() => {});
    await page.waitForTimeout(250);
    await page.mouse.click(point.x, point.y).catch(() => {});

    const opened = await waitForFacebookShareDialog(page, 5000);

    if (opened) return true;

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
  }

  return false;
}

async function copyVisibleFacebookPostLink(page, fullText, { allowLatestFallback = false } = {}) {
  await page.evaluate(() => navigator.clipboard?.writeText?.('')).catch(() => {});

  let clickedShare = await clickBestVisibleShareButton(page, fullText, {
    allowLatestFallback,
  });

  if (!clickedShare) {
    clickedShare = await clickShareByPostCardGeometry(page, fullText, {
      allowLatestFallback,
    });
  }

  if (!clickedShare) return null;

  await page.waitForTimeout(1500);

  const copied = await clickCopyLinkInOpenFacebookShareDialog(page);

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);

  return copied;
}

async function currentFeedResolve(page, fullText) {
  console.log('[Facebook] Current feed resolver: scanning visible Share buttons first.');

  await prepareFacebookViewport(page);
  await page.keyboard.press('Escape').catch(() => {});
  await dismissFacebookPostPublishPrompts(page);

  for (let attempt = 1; attempt <= 8; attempt++) {
    console.log(`[Facebook] Current feed visible-share attempt ${attempt}/8`);

    await page.waitForTimeout(2200 + attempt * 800);

    const link = await copyVisibleFacebookPostLink(page, fullText, {
      allowLatestFallback: attempt >= 4,
    });

    if (link) return link;

    const move = attempt % 2 === 0 ? 260 : -180;

    await page.evaluate((y) => {
      window.scrollBy({
        top: y,
        left: 0,
        behavior: 'smooth',
      });
    }, move).catch(() => {});

    await page.waitForTimeout(1300);
  }

  return null;
}

async function openFacebookPageFeed(page, targetUrl) {
  console.log('[Facebook] Opening Page fallback.');

  await prepareFacebookViewport(page);

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(7000);

  await page.keyboard.press('Escape').catch(() => {});
  await dismissFacebookPostPublishPrompts(page);

  await prepareFacebookViewport(page);

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(2500);
}

async function pageFeedResolve(page, targetUrl, fullText) {
  console.log('[Facebook] Page fallback resolver: visible Share scan.');

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[Facebook] Page fallback attempt ${attempt}/3`);

    await openFacebookPageFeed(page, targetUrl);

    if (attempt > 1) {
      await page.waitForTimeout(attempt * 5000);
    }

    let link = await copyVisibleFacebookPostLink(page, fullText, {
      allowLatestFallback: attempt >= 2,
    });

    if (link) return link;

    const scrollSteps = [
      120, 160, 200, 240, 280,
      320, 360, 420, 500, 600,
    ];

    for (let i = 0; i < scrollSteps.length; i++) {
      const amount = scrollSteps[i];

      console.log(`[Facebook] Page slow scroll ${i + 1}/${scrollSteps.length}: ${amount}px`);

      await page.evaluate((y) => {
        window.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      }, amount).catch(() => {});

      await page.waitForTimeout(2000);

      link = await copyVisibleFacebookPostLink(page, fullText, {
        allowLatestFallback: attempt >= 2,
      });

      if (link) return link;
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(7000);
  }

  return null;
}

async function resolveFacebookPostedUrl(page, targetUrl, fullText, opts = {}) {
  const current = await currentFeedResolve(page, fullText);
  if (current) return current;

  const pageLink = await pageFeedResolve(page, targetUrl, fullText, opts);
  if (pageLink) return pageLink;

  return null;
}

async function uploadToFacebook(imagePath, { description, hashtags = [] }, opts = {}) {
  const imageFiles = Array.isArray(imagePath)
    ? imagePath.filter(Boolean)
    : (imagePath ? [imagePath] : []);

  const context = await launchPersistent('facebook', opts);

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://www.facebook.com',
    }).catch(() => {});

    const page = context.pages()[0] || await context.newPage();

    await prepareFacebookViewport(page);

    const targetUrl = (opts && opts.targetUrl && /^https?:\/\//i.test(opts.targetUrl))
      ? opts.targetUrl
      : 'https://www.facebook.com/';

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);

    await prepareFacebookViewport(page);

    if (page.url().includes('/login')) {
      throw new Error('Facebook requires login. Use Prepare in Settings to log in once.');
    }

    const fullText = hashtags.length
      ? `${description}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : (description || '');

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    if (!(await facebookComposerOpen(page))) {
      const opened = await clickFacebookModernComposerEntry(page);

      if (!opened) {
        throw new Error('Could not open the Facebook Create Post composer. Leaving source files for retry.');
      }

      await page.waitForTimeout(2000);
    }

    await insertFacebookTextIntoActiveComposer(page, fullText, { required: true });

    if (imageFiles.length) {
      await attachImagesToFacebookComposer(page, imageFiles);
    }

    await insertFacebookTextIntoActiveComposer(page, fullText, { required: false });

    console.log('[Facebook] Clicking final Post button...');
    await clickFacebookVerifiedPostButton(page);

    console.log('[Facebook] Waiting for Facebook publish to finish...');
    await waitForFacebookPublishToFinish(page);
    await dismissFacebookPostPublishPrompts(page);

    await prepareFacebookViewport(page);

    console.log('[Facebook] Resolving posted Facebook link...');
    const finalUrl = await resolveFacebookPostedUrl(page, targetUrl, fullText, opts);

    if (!finalUrl) {
      throw new Error('Facebook post was submitted, but could not copy the link from the latest/matching post. Leaving source files for retry.');
    }

    console.log(`[Facebook] Successfully posted and copied link: ${finalUrl}`);
    return { url: finalUrl };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToFacebook };