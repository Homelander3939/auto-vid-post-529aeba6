// Polls and processes social_posts: downloads image, dispatches to per-platform uploader.
const path = require('path');
const fs = require('fs');
const { uploadToX } = require('./uploaders/x');
const { uploadToFacebook } = require('./uploaders/facebook');
const { uploadToTikTokPost } = require('./uploaders/tiktok-post');
const { uploadToLinkedIn } = require('./uploaders/linkedin');
const { getBrowserProfileForAccount, getJobAccountSelections } = require('./browserProfiles');

// `tiktok` is kept for backward-compat with old rows; new social posts use linkedin.
const uploaders = { x: uploadToX, facebook: uploadToFacebook, linkedin: uploadToLinkedIn, tiktok: uploadToTikTokPost };

const processing = new Set();

function cleanTelegramText(value, max = 900) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function loadAccounts(supabase, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data } = await supabase.from('social_post_accounts').select('*').in('id', unique);
  return new Map((data || []).map((a) => [a.id, a]));
}

async function downloadImage(supabase, imagePath, idx = 0) {
  if (!imagePath) return null;
  const { data, error } = await supabase.storage.from('social-media').download(imagePath);
  if (error || !data) throw new Error(`Image download failed: ${error?.message || 'unknown'}`);
  const tempDir = path.join(__dirname, 'data', 'temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const ext = path.extname(imagePath) || '.png';
  const localPath = path.join(tempDir, `social-${Date.now()}-${idx}${ext}`);
  fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
  return localPath;
}

async function downloadImages(supabase, post) {
  // Prefer multi-image bundle (image_paths). Fall back to single image_path for legacy posts.
  const list = Array.isArray(post.image_paths) && post.image_paths.length
    ? post.image_paths
    : (post.image_path ? [post.image_path] : []);
  const out = [];
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    try {
      const local = await downloadImage(supabase, list[i], i);
      if (local) out.push(local);
    } catch (e) {
      console.error('[SocialPosts] Image download failed:', e.message);
      errors.push(e.message);
    }
  }
  if (list.length && out.length !== list.length) {
    throw new Error(`Only downloaded ${out.length}/${list.length} required image(s): ${errors.join('; ') || 'unknown error'}`);
  }
  return out;
}

function cleanupSourceFiles(sourceMeta, shouldClean) {
  const src = sourceMeta || {};
  if (!src.folder || !Array.isArray(src.files) || !src.files.length) return '';

  if (!shouldClean) {
    return `\n\n🧹 Source files kept for retry in ${cleanTelegramText(src.folder, 120)}`;
  }

  const removed = [];
  const failed = [];
  for (const name of src.files) {
    const full = path.join(src.folder, name);
    try {
      if (fs.existsSync(full)) { fs.unlinkSync(full); removed.push(name); }
    } catch (e) {
      failed.push(`${name} (${e.message})`);
    }
  }

  let line = removed.length
    ? `\n\n🧹 Posted successfully and cleared ${removed.length} source file(s) from ${cleanTelegramText(src.folder, 120)}`
    : `\n\n🧹 No source files found to clear in ${cleanTelegramText(src.folder, 120)}`;
  if (removed.length) console.log(`[SocialPosts] Removed ${removed.length} source file(s) from ${src.folder}`);
  if (failed.length) line += `\n⚠️ Could not delete: ${cleanTelegramText(failed.join(', '), 200)}`;
  return line;
}

function stableStatusKey(results) {
  return results.map((r) => `${r.name}:${r.status || ''}`).join('|');
}

async function processSocialPost(supabase, postId, notify) {
  if (processing.has(postId)) return;
  processing.add(postId);

  let localImages = [];
  try {
    const { data: post } = await supabase.from('social_posts').select('*').eq('id', postId).single();
    if (!post) return;
    if (!['pending', 'scheduled'].includes(post.status)) return;

    await supabase.from('social_posts').update({ status: 'processing' }).eq('id', postId);

    const selections = { ...(post.account_selections || {}), ...getJobAccountSelections(postId) };
    const accountIds = Object.values(selections).filter(Boolean);
    const accountsById = await loadAccounts(supabase, accountIds);

    localImages = await downloadImages(supabase, post);

    let results = post.platform_results && post.platform_results.length
      ? post.platform_results
      : (post.target_platforms || []).map((name) => ({ name, status: 'pending' }));
    results = results.map((r) => ({ ...r, status: r.status === 'uploading' ? 'pending' : r.status }));

    for (const r of results) {
      if (r.status !== 'pending') continue;
      const uploader = uploaders[r.name];
      if (!uploader) {
        r.status = 'error'; r.error = `Unsupported platform: ${r.name}`;
        continue;
      }
      const accountId = selections[r.name];
      const account = accountId ? accountsById.get(accountId) : null;
      if (!account || !account.enabled) {
        r.status = 'error';
        r.error = `No enabled ${r.name} account selected. Add one in Settings.`;
        continue;
      }
      const profile = getBrowserProfileForAccount(account.id);
      const beforeStatus = stableStatusKey(results);
      try {
        // Use per-platform variant when available; fall back to the main description/hashtags
        const variant = (post.platform_variants || {})[r.name];
        const platformDescription = (variant && variant.description) ? variant.description : (post.description || '');
        const platformHashtags = (variant && variant.hashtags && variant.hashtags.length)
          ? variant.hashtags
          : (post.hashtags || []);
        // Pass an array when we have a multi-image bundle, single path otherwise
        // (uploaders normalise both forms — keeps legacy single-image posts working).
        const imageArg = localImages.length > 1 ? localImages : (localImages[0] || null);
        const out = await uploader(imageArg, {
          description: platformDescription,
          hashtags: platformHashtags,
        }, {
          accountId: account.id,
          browserProfileId: profile?.id,
          targetUrl: account.target_url || null,
        });
        r.status = 'success';
        r.url = out?.url || '';
      } catch (e) {
        console.error(`[SocialPosts] ${r.name} failed:`, e.message);
        r.status = 'error';
        r.error = e.message;
      }
      if (stableStatusKey(results) !== beforeStatus) {
        await supabase.from('social_posts').update({ platform_results: [...results] }).eq('id', postId);
      }
    }

    const successCount = results.filter((r) => r.status === 'success').length;
    const errorCount = results.filter((r) => r.status === 'error').length;
    const finalStatus = errorCount > 0 && successCount === 0 ? 'failed'
      : errorCount > 0 ? 'partial' : 'completed';

    await supabase.from('social_posts').update({
      status: finalStatus,
      platform_results: results,
      completed_at: new Date().toISOString(),
    }).eq('id', postId);

    // Cleanup must not depend on Telegram delivery. If at least one platform posted,
    // remove the source bundle so folder schedules behave like video uploads.
    const cleanupLine = cleanupSourceFiles(post.source_meta, successCount > 0);

    if (notify) {
      try {
        const scheduleTag = post.scheduled_at ? ' (scheduled)' : '';
        const lines = results.map((r) =>
          r.status === 'success' ? `✅ ${cleanTelegramText(r.name, 40)}${r.url ? `\n   🔗 ${cleanTelegramText(r.url, 300)}` : ''}`
          : r.status === 'error' ? `❌ ${cleanTelegramText(r.name, 40)}: ${cleanTelegramText(r.error || 'unknown error')}`
          : `⚪ ${r.name}: ${r.status}`
        );
        const emoji = finalStatus === 'completed' ? '🎉' : finalStatus === 'partial' ? '⚠️' : '❌';
        const preview = cleanTelegramText(post.description || '', 120);

        const msg = `${emoji} Social post ${finalStatus}${scheduleTag}\n${preview}\n\n${lines.join('\n\n')}${cleanupLine}`;
        console.log(`[SocialPosts] Notifying Telegram: ${finalStatus} (${results.length} platforms)`);
        const delivered = await notify(msg);
        if (delivered === false) throw new Error('notify callback returned false');
        console.log('[SocialPosts] Telegram notify OK');
      } catch (e) {
        console.error('[SocialPosts] Telegram notify FAILED:', e.message);
      }
    } else {
      console.warn('[SocialPosts] No notify callback provided — skipping Telegram');
    }
  } catch (e) {
    console.error('[SocialPosts] processor error:', e.message);
    await supabase.from('social_posts').update({ status: 'failed' }).eq('id', postId);
    // Try to send a failure notification even when the processor itself errored
    if (notify) {
      try { await notify(`❌ Social post processor error: ${e.message}`); } catch {}
    }
  } finally {
    for (const p of localImages) { try { fs.unlinkSync(p); } catch {} }
    processing.delete(postId);
  }
}

async function pollDueSocialPosts(supabase, notify) {
  try {
    const now = new Date().toISOString();
    const { data: due } = await supabase
      .from('social_posts')
      .select('id, status, scheduled_at')
      .in('status', ['pending', 'scheduled'])
      .or(`scheduled_at.is.null,scheduled_at.lte.${now}`)
      .limit(5);
    for (const post of (due || [])) {
      if (processing.has(post.id)) continue;
      processSocialPost(supabase, post.id, notify).catch((e) =>
        console.error(`[SocialPosts] ${post.id} error:`, e.message));
    }
  } catch (e) {
    console.error('[SocialPosts] poll error:', e.message);
  }
}

module.exports = { processSocialPost, pollDueSocialPosts };
