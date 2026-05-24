// Local server — autonomous browser automation worker.
// Reads jobs from Supabase, downloads videos, and uploads via Playwright.

// Load .env file if present (for LOVABLE_API_KEY and other env vars)
const dotenvPath = require('path').join(__dirname, '.env');
if (require('fs').existsSync(dotenvPath)) {
  const envContent = require('fs').readFileSync(dotenvPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
  console.log('[Server] Loaded .env file');
}

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { uploadToYouTube } = require('./uploaders/youtube');
const { uploadToTikTok } = require('./uploaders/tiktok');
const { uploadToInstagram } = require('./uploaders/instagram');
const { checkPlatformStats, formatStatsForTelegram, runBrowserTask } = require('./uploaders/stats-scraper');
const { sendTelegram } = require('./telegram');
const { scanFolder, scanAllFiles, getReadyPairs } = require('./folderWatcher');
const { parseTextFile } = require('./textParser');
const { processTelegramAIResponse, streamLMStudio, LM_STUDIO_URL, discoverLMStudioModels, refreshLMStudioConfigFromSettings, testLMStudioConnection } = require('./ai-handler');
const { handleAgentCommand } = require('./agentWorkspace');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const {
  closeBrowserProfileSession,
  copyScheduledSelectionsToJob,
  getBrowserProfileForAccount,
  getJobAccountSelections,
  getScheduledAccountSelections,
  linkAccountToBrowserProfile,
  listBrowserProfiles,
  openBrowserProfileSession,
  saveJobAccountSelections,
  saveScheduledAccountSelections,
  upsertBrowserProfile,
} = require('./browserProfiles');

const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));

// --- Supabase client ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mgcfeddzbgpcnzdgxzfp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nY2ZlZGR6YmdwY256ZGd4emZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDM3MDMsImV4cCI6MjA4OTU3OTcwM30.-EuZuspd55AdbVfpY5pFSw8Wuk_56iYbtOgCOMDOLhE';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Track jobs currently being processed to prevent duplicates
const processingJobs = new Set();

// --- Helpers ---
async function getSettings() {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  if (!data) throw new Error('No settings found. Configure settings in the web UI first.');

  let resolvedChatId = data.telegram_chat_id ? String(data.telegram_chat_id).trim() : '';
  if (data.telegram_enabled && !resolvedChatId) {
    const { data: latestMessage } = await supabase
      .from('telegram_messages')
      .select('chat_id')
      .eq('is_bot', false)
      .order('created_at', { ascending: false })
      .limit(1);

    const fallbackChatId = latestMessage?.[0]?.chat_id;
    if (fallbackChatId !== null && fallbackChatId !== undefined && String(fallbackChatId).trim()) {
      resolvedChatId = String(fallbackChatId).trim();
      await supabase.from('app_settings').update({ telegram_chat_id: resolvedChatId }).eq('id', 1);
    }
  }

  return {
    folderPath: data.folder_path,
    deleteAfterUpload: data.delete_after_upload !== false,
    youtube: { email: data.youtube_email, password: data.youtube_password, enabled: data.youtube_enabled },
    tiktok: { email: data.tiktok_email, password: data.tiktok_password, enabled: data.tiktok_enabled },
    instagram: { email: data.instagram_email, password: data.instagram_password, enabled: data.instagram_enabled },
    telegram: { botToken: data.telegram_bot_token, chatId: resolvedChatId, enabled: data.telegram_enabled },
    local_agent_url: data.local_agent_url || 'http://localhost:3001',
    backend: null,
  };
}

// Strip leaked LLM "thinking process" sections (common with Qwen/Gemma) so Telegram + chat
// only see the useful result. Mirrors the sanitization done in the cloud edge functions.
function sanitizeOutgoingMessage(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  const leakMarkers = [
    /(?:^|\n)\s*(?:here'?s\s+(?:a\s+)?)?thinking process\s*:/i,
    /(?:^|\n)\s*\d+\.\s*\*\*(?:analy[sz]e user input|check context|formulate response|self-correction|verification)\b/i,
    /(?:^|\n)\s*(?:draft|self-correction\/verification)\s*:/i,
  ];
  if (leakMarkers.some((re) => re.test(s))) {
    const next = s.match(/Next action\s*:\s*([^\n]+)/i)?.[1];
    s = next ? `Done. Next action: ${next.trim()}` : 'Done.';
  }
  return s.slice(0, 3900);
}

async function notifyTelegram(settings, message) {
  const text = sanitizeOutgoingMessage(message);
  if (!text) return;
  if (!settings.telegram?.enabled || !settings.telegram?.chatId) return;
  try {
    await sendTelegram(settings.telegram.botToken, settings.telegram.chatId, text, settings.backend);
  } catch (e) {
    console.error('[Telegram] Notification failed:', e.message);
  }
  // Mirror into telegram_messages so AI Chat (web) shows the same bot reply that the
  // user sees in Telegram. getUpdates does not return our own outgoing messages, so
  // without this mirror the chat UI never reflects worker-side notifications
  // (Instagram/social posts, browser results, stats summaries, etc.).
  try {
    const numericChat = Number(settings.telegram.chatId);
    if (Number.isFinite(numericChat)) {
      await supabase.from('telegram_messages').insert({
        update_id: -Math.floor(Date.now() + Math.random() * 1000),
        chat_id: numericChat,
        text: text.slice(0, 3000),
        is_bot: true,
        raw_update: { source: 'local-worker' },
      });
    }
  } catch (e) {
    // Non-fatal; logging only.
    console.warn('[Telegram] Mirror to chat history failed:', e.message);
  }
}

const uploaders = { youtube: uploadToYouTube, tiktok: uploadToTikTok, instagram: uploadToInstagram };

function resolveMetadataForVideo(baseDir, videoFileName, fallbackTitle = '', fallbackDescription = '', fallbackTags = []) {
  let resolvedTitle = fallbackTitle;
  let resolvedDescription = fallbackDescription;
  let resolvedTags = Array.isArray(fallbackTags) ? fallbackTags : [];

  if (!baseDir || !videoFileName) {
    return { title: resolvedTitle, description: resolvedDescription, tags: resolvedTags };
  }

  const stem = path.basename(videoFileName, path.extname(videoFileName));

  // 1. Exact stem match (preferred).
  const exactCandidates = [
    path.join(baseDir, `${stem}.txt`),
    path.join(baseDir, `${stem}.TXT`),
  ];
  let matchedTextPath = exactCandidates.find((candidate) => fs.existsSync(candidate));

  // 2. Fuzzy fallback: look for a .txt whose stem is a delimited prefix of the
  //    video stem. This handles cases where the user generated metadata as
  //    "Roman_History_43.txt" but the video file later got a date suffix
  //    appended ("Roman_History_43_2026-05-04_11-04-50.mp4"). The next char
  //    after the prefix must be a non-digit delimiter (_ - .) so that
  //    "Roman_History_4" does NOT incorrectly match "Roman_History_43*".
  if (!matchedTextPath) {
    try {
      const stemLower = stem.toLowerCase();
      let bestMatch = null;
      let bestLen = 0;
      for (const f of fs.readdirSync(baseDir)) {
        if (!/\.txt$/i.test(f)) continue;
        const txtStem = f.replace(/\.[^.]+$/, '').toLowerCase();
        if (txtStem.length === 0 || txtStem.length >= stemLower.length) continue;
        if (!stemLower.startsWith(txtStem)) continue;
        const next = stemLower.charAt(txtStem.length);
        if (next !== '_' && next !== '-' && next !== '.') continue;
        if (txtStem.length > bestLen) {
          bestLen = txtStem.length;
          bestMatch = path.join(baseDir, f);
        }
      }
      if (bestMatch) matchedTextPath = bestMatch;
    } catch { /* ignore readdir errors */ }
  }

  if (!matchedTextPath) {
    return { title: resolvedTitle, description: resolvedDescription, tags: resolvedTags };
  }

  try {
    const parsed = parseTextFile(matchedTextPath);
    if (parsed.title) resolvedTitle = parsed.title;
    if (parsed.description) resolvedDescription = parsed.description;
    if (Array.isArray(parsed.tags) && parsed.tags.length > 0) resolvedTags = parsed.tags;
    console.log(`[Worker] Matched metadata file for ${videoFileName}: ${path.basename(matchedTextPath)}`);
  } catch (err) {
    console.warn(`[Worker] Failed to parse metadata file for ${videoFileName}: ${err.message}`);
  }

  return { title: resolvedTitle, description: resolvedDescription, tags: resolvedTags };
}

function normalizeFolderPath(folderPath) {
  return String(folderPath || '')
    // Strip [folder] / [folder|N] / [folder|N|M] prefix
    .replace(/^\[folder(?:\|\d+(?:\|\d+)?)?\]\s*/i, '')
    .replace(/^"(.+)"$/, '$1')
    .replace(/^'(.+)'$/, '$1')
    .trim();
}

function parseFolderIntensity(marker) {
  const m = String(marker || '').match(/^\[folder\|(\d+)(?:\|\d+)?\]/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Optional max-count: [folder|intensity|count] — limits the campaign to the
// last N (highest-numbered) videos in the folder.
function parseFolderMaxCount(marker) {
  const m = String(marker || '').match(/^\[folder\|\d+\|(\d+)\]/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isFolderUploadMarker(value) {
  return typeof value === 'string' && /^\[folder(?:\|\d+(?:\|\d+)?)?\]\s/i.test(value);
}

function selectFolderPairsForUpload(folderPath, maxCount) {
  let pairs = scanAllFiles(folderPath);
  // "Number of last videos" means choose the highest-numbered N episodes,
  // but keep scanAllFiles' ascending story order so uploads run 4 → 5 → 6,
  // never 6 → 5 → 4.
  if (maxCount && pairs.length > maxCount) pairs = pairs.slice(-maxCount);
  return pairs;
}

function buildFolderPairMetadata(folderPath, pair, fallbackTitle = '', fallbackDescription = '', fallbackTags = []) {
  const cleanVideoStem = pair.videoFile.replace(/\.[^.]+$/, '');
  const generated = generateMetadataFromFilename(pair.videoFile);
  let entryTitle = fallbackTitle && fallbackTitle !== '(auto from folder)' ? fallbackTitle : generated.title || cleanVideoStem;
  let entryDesc = fallbackDescription || generated.description || '';
  let entryTags = Array.isArray(fallbackTags) && fallbackTags.length ? fallbackTags : (generated.tags || []);

  if (pair.textFile) {
    const meta = parseTextFile(path.join(folderPath, pair.textFile));
    if (meta.title) entryTitle = meta.title;
    if (meta.description) entryDesc = meta.description;
    if (meta.tags?.length) entryTags = meta.tags;
  }

  return {
    videoFileName: path.resolve(path.join(folderPath, pair.videoFile)),
    title: entryTitle || cleanVideoStem,
    description: entryDesc || '',
    tags: entryTags || [],
  };
}

function getReadyPlatforms(settings, requestedPlatforms = []) {
  return (Array.isArray(requestedPlatforms) ? requestedPlatforms : []).filter((platform) => {
    const config = settings?.[platform];
    return Boolean(config?.enabled && config?.email && config?.password);
  });
}

function normalizeAccountGroupKey(account = {}) {
  const label = String(account.label || '').trim().toLowerCase();
  if (label) return `label:${label}`;
  const emailPrefix = String(account.email || '').trim().toLowerCase().split('@')[0];
  return emailPrefix ? `email:${emailPrefix}` : '';
}

function getRelatedAccounts(accounts = [], seedAccount) {
  if (!seedAccount) return [];
  const key = normalizeAccountGroupKey(seedAccount);
  if (!key) return [seedAccount];
  return accounts.filter((account) => normalizeAccountGroupKey(account) === key);
}

function findLinkedSiblingBrowserProfile(account, accounts = []) {
  const siblings = getRelatedAccounts(accounts, account);
  for (const sibling of siblings) {
    const profile = getBrowserProfileForAccount(sibling.id);
    if (profile) return profile;
  }
  return null;
}

async function getAccountsByIds(accountIds = []) {
  const uniqueIds = [...new Set(accountIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const { data } = await supabase.from('platform_accounts').select('*').in('id', uniqueIds);
  return data || [];
}

async function getAllPlatformAccounts() {
  const { data } = await supabase.from('platform_accounts').select('*');
  return data || [];
}

async function getReadyPlatformsForSelections(settings, requestedPlatforms = [], selections = {}) {
  const selectedAccounts = await getAccountsByIds(Object.values(selections || {}));
  const selectedAccountsById = new Map(selectedAccounts.map((account) => [account.id, account]));

  return (Array.isArray(requestedPlatforms) ? requestedPlatforms : []).filter((platform) => {
    const selectedAccountId = selections?.[platform];
    const selectedAccount = selectedAccountId ? selectedAccountsById.get(selectedAccountId) : null;
    if (selectedAccount) {
      return Boolean(selectedAccount.enabled && selectedAccount.email && selectedAccount.password);
    }

    const config = settings?.[platform];
    return Boolean(config?.enabled && config?.email && config?.password);
  });
}

async function loadJobAccountContext(job) {
  const selections = getJobAccountSelections(job.id);
  const accountIds = new Set(Object.values(selections || {}).filter(Boolean));
  if (job.account_id) accountIds.add(job.account_id);

  const accounts = await getAccountsByIds([...accountIds]);
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const normalizedSelections = { ...selections };

  if (job.account_id) {
    const legacyAccount = accountsById.get(job.account_id);
    if (legacyAccount && !normalizedSelections[legacyAccount.platform]) {
      normalizedSelections[legacyAccount.platform] = legacyAccount.id;
    }
  }

  return {
    selections: normalizedSelections,
    accounts,
    accountsById,
  };
}

async function processJob(jobId, options = {}) {
  // Prevent duplicate processing
  if (processingJobs.has(jobId)) {
    console.log(`[Worker] Job ${jobId} already being processed, skipping`);
    return;
  }
  processingJobs.add(jobId);

  try {
    let { data: job } = await supabase.from('upload_jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'pending') {
      processingJobs.delete(jobId);
      return;
    }

    const settings = await getSettings();

    const accountContext = await loadJobAccountContext(job);

    if (isFolderUploadMarker(job.video_file_name) && parseFolderIntensity(job.video_file_name)) {
      const folderPath = normalizeFolderPath(job.video_file_name);
      const intensityMin = parseFolderIntensity(job.video_file_name);
      const maxCount = parseFolderMaxCount(job.video_file_name);
      const pairs = selectFolderPairsForUpload(folderPath, maxCount);

      if (pairs.length === 0) {
        console.error(`[Worker] No videos found in folder: ${folderPath}`);
        await supabase.from('upload_jobs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', jobId);
        await notifyTelegram(settings, `❌ Folder upload: no videos found in ${folderPath}`);
        return;
      }

      const requestedPlatforms = Array.isArray(job.target_platforms) ? job.target_platforms : [];
      const platformResults = requestedPlatforms.map((name) => ({ name, status: 'pending' }));
      const firstMeta = buildFolderPairMetadata(folderPath, pairs[0], job.title, job.description, job.tags);

      await supabase.from('upload_jobs').update({
        video_file_name: firstMeta.videoFileName,
        video_storage_path: null,
        title: firstMeta.title,
        description: firstMeta.description,
        tags: firstMeta.tags,
        platform_results: platformResults,
      }).eq('id', jobId);

      if (pairs.length > 1) {
        const baseTime = Date.now();
        const scheduledRows = pairs.slice(1).map((pair, idx) => {
          const meta = buildFolderPairMetadata(folderPath, pair, job.title, job.description, job.tags);
          return {
            video_file_name: meta.videoFileName,
            video_storage_path: null,
            title: meta.title,
            description: meta.description,
            tags: meta.tags,
            target_platforms: requestedPlatforms,
            account_id: job.account_id,
            scheduled_at: new Date(baseTime + (idx + 1) * intensityMin * 60_000).toISOString(),
            status: 'scheduled',
          };
        });

        const { data: scheduledChildren, error: scheduleError } = await supabase
          .from('scheduled_uploads')
          .insert(scheduledRows)
          .select();
        if (scheduleError) {
          console.error('[Worker] Folder fan-out scheduling failed:', scheduleError.message);
          await supabase.from('upload_jobs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', jobId);
          return;
        }
        for (const child of scheduledChildren || []) {
          try { saveScheduledAccountSelections(child.id, accountContext.selections); } catch {}
        }
      }

      console.log(`[Worker] Folder upload expanded ${pairs.length} video(s), starting with ${path.basename(firstMeta.videoFileName)}`);
      job = { ...job, video_file_name: firstMeta.videoFileName, video_storage_path: null, title: firstMeta.title, description: firstMeta.description, tags: firstMeta.tags, platform_results: platformResults };
    }

    const folderPathOverride = normalizeFolderPath(options.folderPath);
    const results = job.platform_results || [];

    // === CREDENTIAL VALIDATION: Skip platforms without credentials ===
    // If accountCredentials exists, use those for the matching platform
    for (const platform of results) {
      if (platform.status !== 'pending') continue;
      
      const selectedAccountId = accountContext.selections[platform.name];
      const selectedAccount = selectedAccountId ? accountContext.accountsById.get(selectedAccountId) : null;
      const ps = selectedAccount
        ? { email: selectedAccount.email, password: selectedAccount.password, enabled: selectedAccount.enabled }
        : settings[platform.name];
      
      if (!ps?.enabled) {
        platform.status = 'error';
        platform.error = `${platform.name} is not enabled in Settings`;
        continue;
      }
      if (!ps?.email || !ps?.password) {
        platform.status = 'error';
        platform.error = `${platform.name} credentials not configured. Add email & password in Settings.`;
        continue;
      }
    }

    const actionable = results.filter(r => r.status === 'pending');
    if (actionable.length === 0) {
      const errorMessages = results.filter(r => r.status === 'error').map(r => `❌ ${r.name}: ${r.error}`);
      await supabase.from('upload_jobs').update({
        status: 'failed', platform_results: results, completed_at: new Date().toISOString(),
      }).eq('id', jobId);
      await notifyTelegram(settings, `❌ <b>Upload Failed</b>\n📹 ${job.title || job.video_file_name}\n\n${errorMessages.join('\n')}`);
      return;
    }

    // Determine video path
    let videoPath;
    let resolvedTitle = job.title;
    let resolvedDescription = job.description;
    let resolvedTags = job.tags;

      if (job.video_storage_path) {
      const { data: fileData, error } = await supabase.storage.from('videos').download(job.video_storage_path);
      if (error || !fileData) {
        console.error('Failed to download video from storage:', error);
        await supabase.from('upload_jobs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', jobId);
        await notifyTelegram(settings, `❌ Failed to download video: ${job.video_file_name}`);
        return;
      }
      const tempDir = path.join(__dirname, 'data', 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      videoPath = path.join(tempDir, job.video_file_name);
      const buffer = Buffer.from(await fileData.arrayBuffer());
      fs.writeFileSync(videoPath, buffer);
    } else if (isFolderUploadMarker(job.video_file_name)) {
      const folderPath = normalizeFolderPath(job.video_file_name);
      const { videoFile, textFile } = scanFolder(folderPath);

      if (!videoFile) {
        console.error(`Video file not found in folder: ${folderPath}`);
        await supabase.from('upload_jobs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', jobId);
        await notifyTelegram(settings, `❌ No video file found in folder: ${folderPath}`);
        return;
      }

      videoPath = path.join(folderPath, videoFile);

      if (textFile) {
        const parsed = parseTextFile(path.join(folderPath, textFile));
        if (!resolvedTitle || resolvedTitle === '(auto from folder)') resolvedTitle = parsed.title || videoFile;
        if (!resolvedDescription) resolvedDescription = parsed.description || '';
        if (!Array.isArray(resolvedTags) || resolvedTags.length === 0) resolvedTags = parsed.tags || [];
      } else if (!resolvedTitle || resolvedTitle === '(auto from folder)') {
        const generated = generateMetadataFromFilename(videoFile);
        resolvedTitle = generated.title;
        if (!resolvedDescription) resolvedDescription = generated.description;
        if (!Array.isArray(resolvedTags) || resolvedTags.length === 0) resolvedTags = generated.tags;
      }
    } else if (path.isAbsolute(job.video_file_name)) {
      videoPath = job.video_file_name;
    } else {
      const baseFolder = folderPathOverride || normalizeFolderPath(settings.folderPath);
      if (baseFolder) {
        videoPath = path.join(baseFolder, job.video_file_name);
      }
    }

    if (!videoPath || !fs.existsSync(videoPath)) {
      console.error('Video file not found:', videoPath);
      await supabase.from('upload_jobs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', jobId);
      await notifyTelegram(settings, `❌ Video file not found: ${job.video_file_name}`);
      return;
    }

    const metadataBaseDir = path.dirname(videoPath);
    const matchedMetadata = resolveMetadataForVideo(
      metadataBaseDir,
      path.basename(videoPath),
      resolvedTitle,
      resolvedDescription,
      resolvedTags,
    );
    resolvedTitle = matchedMetadata.title;
    resolvedDescription = matchedMetadata.description;
    resolvedTags = matchedMetadata.tags;

    const metadata = { title: resolvedTitle, description: resolvedDescription, tags: resolvedTags };
    console.log(`[Worker] Job ${jobId} metadata — title: "${metadata.title}", desc: "${(metadata.description || '').slice(0, 80)}", tags: [${(metadata.tags || []).join(', ')}]`);
    await supabase.from('upload_jobs').update({ status: 'uploading', platform_results: results }).eq('id', jobId);

    for (const platform of results) {
      if (platform.status !== 'pending') continue;
      if (!uploaders[platform.name]) continue;

      platform.status = 'uploading';
      await supabase.from('upload_jobs').update({ platform_results: [...results] }).eq('id', jobId);

      try {
        console.log(`[Worker] Uploading to ${platform.name}...`);
        const selectedAccountId = accountContext.selections[platform.name];
        const selectedAccount = selectedAccountId ? accountContext.accountsById.get(selectedAccountId) : null;
        const platformCreds = selectedAccount
          ? { email: selectedAccount.email, password: selectedAccount.password, enabled: true, recoveryPhone: selectedAccount.recovery_phone || '' }
          : settings[platform.name];
        const browserProfile = selectedAccount
          ? getBrowserProfileForAccount(selectedAccount.id) || findLinkedSiblingBrowserProfile(selectedAccount, accountContext.accounts)
          : null;
        const accountId = selectedAccount && (!selectedAccount.is_default || browserProfile?.id)
          ? selectedAccount.id
          : undefined;

        if (selectedAccount) {
          console.log(`[Worker] Using account "${selectedAccount.label || selectedAccount.email}" for ${platform.name}${browserProfile?.id ? ` via shared profile ${browserProfile.id}` : ''}`);
        }

        const result = await uploaders[platform.name](videoPath, metadata, {
          ...platformCreds,
          accountId,
          browserProfileId: browserProfile?.id,
          telegram: settings.telegram,
          backend: settings.backend,
        });
        platform.status = 'success';
        platform.url = result.url || '';
        platform.recentStats = [];
        console.log(`[Worker] ${platform.name} upload SUCCESS`);
      } catch (err) {
        platform.status = 'error';
        platform.error = err.message;
        console.error(`[Worker] ${platform.name} upload FAILED:`, err.message);
      }

      await supabase.from('upload_jobs').update({ platform_results: [...results] }).eq('id', jobId);
    }

    // Final status
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const finalStatus = errorCount > 0 && successCount === 0 ? 'failed' : errorCount > 0 ? 'partial' : 'completed';

    await supabase.from('upload_jobs').update({
      status: finalStatus, platform_results: results, completed_at: new Date().toISOString(),
    }).eq('id', jobId);

    // === SEND FINAL TELEGRAM SUMMARY WITH STATS ===
    const lines = results.map(r => {
      if (r.status === 'success') return `✅ ${r.name}: Success${r.url ? ' — ' + r.url : ''}`;
      if (r.status === 'error') return `❌ ${r.name}: ${r.error}`;
      return `⚪ ${r.name}: ${r.status}`;
    });
    const emoji = finalStatus === 'completed' ? '🎉' : finalStatus === 'partial' ? '⚠️' : '❌';

    // === AUTO-DELETE LOCAL SOURCE FILES after any successful upload ===
    // Triggers whenever at least one platform succeeded, regardless of whether
    // the job came from a schedule, campaign, watched folder, or a one-off
    // manual upload pointing at a local absolute path. Storage-backed jobs
    // (downloaded from Supabase to a temp dir) are skipped — those temp files
    // are cleaned separately below.
    let cleanupLine = '';
    const isLocalSource = !job.video_storage_path && videoPath && fs.existsSync(videoPath);
    // Only cleanup when ALL selected platforms succeeded — preserve files for retry on partial failures.
    const allSucceeded = results.length > 0 && results.every(r => r.status === 'success');
    if (allSucceeded && settings.deleteAfterUpload !== false && isLocalSource) {
      try {
        const folderDir = path.dirname(videoPath);
        const stem = path.basename(videoPath).replace(/\.[^.]+$/, '');
        const deleted = [];
        try { fs.unlinkSync(videoPath); deleted.push(path.basename(videoPath)); } catch {}
        // Find sibling .txt with the same stem (case-insensitive)
        try {
          for (const f of fs.readdirSync(folderDir)) {
            if (f.toLowerCase() === `${stem.toLowerCase()}.txt`) {
              try { fs.unlinkSync(path.join(folderDir, f)); deleted.push(f); } catch {}
              break;
            }
          }
        } catch {}
        if (deleted.length) {
          const partialNote = finalStatus !== 'completed' ? ' (partial success)' : '';
          cleanupLine = `\n🧹 Cleaned up: ${deleted.join(' + ')}${partialNote}`;
          console.log(`[Worker] Job ${jobId} cleaned up local source files: ${deleted.join(', ')}`);
          // Forget queued state so a new file with the same name later gets picked up.
          try { folderWatchState.queued.delete(path.resolve(videoPath)); persistFolderWatchState(); } catch {}
        }
      } catch (e) {
        console.error(`[Worker] Cleanup failed for job ${jobId}:`, e.message);
      }
    }

    // === FALLBACK: storage-backed jobs (manually picked via browser file input) ===
    // The browser can't reveal absolute paths, so the worker downloads from Supabase
    // storage to a temp dir. If the user wants auto-delete, search known local folders
    // (global default + every enabled recurring schedule folder) for a file with the
    // same basename and delete it + its sibling .txt.
    if (allSucceeded && settings.deleteAfterUpload !== false && !isLocalSource && job.video_file_name) {
      try {
        const candidates = new Set();
        const addCand = (raw) => {
          if (!raw) return;
          try {
            const abs = path.resolve(raw);
            if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) candidates.add(abs);
          } catch {}
        };
        addCand(settings.folderPath);
        try {
          const { data: scheds } = await supabase.from('schedule_config').select('folder_path').eq('enabled', true);
          for (const s of scheds || []) addCand(s.folder_path);
        } catch {}
        try {
          const { data: fscheds } = await supabase.from('folder_schedules').select('folder_path').eq('enabled', true);
          for (const s of fscheds || []) addCand(s.folder_path);
        } catch {}

        const targetName = path.basename(String(job.video_file_name));
        const targetLower = targetName.toLowerCase();
        const stemLower = targetLower.replace(/\.[^.]+$/, '');
        const deleted = [];
        for (const dir of candidates) {
          let entries = [];
          try { entries = fs.readdirSync(dir); } catch { continue; }
          for (const f of entries) {
            const fl = f.toLowerCase();
            if (fl === targetLower || fl === `${stemLower}.txt`) {
              try { fs.unlinkSync(path.join(dir, f)); deleted.push(f); } catch {}
            }
          }
          if (deleted.some((d) => d.toLowerCase() === targetLower)) break; // found the video; stop searching other folders
        }
        if (deleted.length) {
          cleanupLine = `\n🧹 Cleaned up source files: ${deleted.join(' + ')}`;
          console.log(`[Worker] Job ${jobId} cleaned up storage-backed source files: ${deleted.join(', ')}`);
        }
      } catch (e) {
        console.error(`[Worker] Storage-backed cleanup failed for job ${jobId}:`, e.message);
      }
    }

    const summaryMsg = `${emoji} <b>Upload ${finalStatus}</b>\n📹 ${metadata.title || job.video_file_name}\n\n${lines.join('\n')}${cleanupLine}`;

    await notifyTelegram(settings, summaryMsg);

    // Cleanup temp file (Supabase-storage downloads)
    if (job.video_storage_path && videoPath) {
      try { fs.unlinkSync(videoPath); } catch {}
    }
  } finally {
    processingJobs.delete(jobId);
  }
}

// --- API Endpoints ---
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    mode: 'local',
    name: 'Auto Vid Post — Local Server',
    endpoints: {
      health: 'GET /api/health',
      processJob: 'POST /api/process/:id',
      processPending: 'POST /api/process-pending',
    },
  });
});

app.get('/api/health', async (req, res) => {
  const config = await refreshLMStudioConfigFromSettings(supabase).catch(() => ({ url: LM_STUDIO_URL, model: 'unknown' }));
  res.json({ status: 'ok', mode: 'local', ai: { provider: 'lmstudio', url: config.url, model: config.model } });
});

app.post('/api/telegram/send', async (req, res) => {
  try {
    const settings = await getSettings();
    const chatId = req.body?.chat_id || settings.telegram?.chatId;
    if (!settings.telegram?.enabled || !settings.telegram?.botToken) {
      return res.status(400).json({ success: false, error: 'Telegram is not configured locally. Add your bot token in Settings.' });
    }
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'Telegram chat ID is missing. Send a message to the bot, then use auto-detect in Settings.' });
    }
    if (req.body?.action) {
      const { sendChatActionViaBotToken } = require('./telegram');
      await sendChatActionViaBotToken(settings.telegram.botToken, chatId, req.body.action);
      return res.json({ success: true });
    }
    if (req.body?.photo_base64) {
      const { sendTelegramPhoto } = require('./telegram');
      await sendTelegramPhoto(settings.telegram.botToken, chatId, Buffer.from(req.body.photo_base64, 'base64'), req.body?.text || '', null);
      return res.json({ success: true });
    }
    await sendTelegram(settings.telegram.botToken, chatId, req.body?.text || '', null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/agent-run', async (req, res) => {
  try {
    const { action, runId, prompt, source = 'local-web', telegram_chat_id = null, chat_settings = null, aiSettings = null } = req.body || {};
    if (action === 'cancel' && runId) {
      await supabase.from('agent_runs').update({ status: 'cancelled', completed_at: new Date().toISOString(), error: 'Cancelled by user' }).eq('id', runId);
      return res.json({ ok: true });
    }
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const selectedAI = await resolveSelectedAIConfig(chat_settings || aiSettings || null);
    const { data, error } = await supabase.from('agent_runs').insert({
      prompt,
      source,
      telegram_chat_id,
      chat_settings: chat_settings || aiSettings || null,
      status: 'running',
      events: [],
      result: null,
      error: null,
      model: `${selectedAI.provider}:${selectedAI.model}`,
    }).select('id').single();
    if (error) throw error;
    setImmediate(() => runLocalAgent(data.id).catch((err) => console.error('[LocalAgent] run failed:', err.message)));
    res.json({ runId: data.id, local: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const LOCAL_DB_TABLES = new Set([
  'app_settings', 'platform_accounts', 'upload_jobs', 'scheduled_uploads', 'schedule_config',
  'social_post_accounts', 'social_posts', 'social_post_schedules', 'generation_jobs',
  'pending_commands', 'agent_skills', 'agent_memories', 'agent_runs', 'telegram_messages',
]);

function assertAllowedTable(table) {
  if (!LOCAL_DB_TABLES.has(String(table || ''))) throw new Error(`Local proxy table not allowed: ${table}`);
}

function applyLocalQueryFilters(query, filters = []) {
  for (const f of Array.isArray(filters) ? filters : []) {
    if (!f?.column) continue;
    if (f.op === 'eq') query = query.eq(f.column, f.value);
    else if (f.op === 'neq') query = query.neq(f.column, f.value);
    else if (f.op === 'in') query = query.in(f.column, Array.isArray(f.value) ? f.value : []);
    else if (f.op === 'is') query = query.is(f.column, f.value);
    else if (f.op === 'not') query = query.not(f.column, f.operator || 'is', f.value);
  }
  return query;
}

app.post('/api/db/select', async (req, res) => {
  try {
    const { table, columns = '*', filters = [], order = [], limit, single, maybeSingle } = req.body || {};
    assertAllowedTable(table);
    let query = supabase.from(table).select(columns);
    query = applyLocalQueryFilters(query, filters);
    const orders = Array.isArray(order) ? order : order ? [order] : [];
    for (const o of orders) if (o?.column) query = query.order(o.column, { ascending: o.ascending !== false });
    if (limit) query = query.limit(Number(limit));
    if (single) query = query.single();
    else if (maybeSingle) query = query.maybeSingle();
    const { data, error } = await query;
    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/db/update', async (req, res) => {
  try {
    const { table, payload, filters = [], select } = req.body || {};
    assertAllowedTable(table);
    let query = supabase.from(table).update(payload || {});
    query = applyLocalQueryFilters(query, filters);
    if (select) query = query.select(select === true ? '*' : select);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/db/insert', async (req, res) => {
  try {
    const { table, payload, select = '*' } = req.body || {};
    assertAllowedTable(table);
    let query = supabase.from(table).insert(payload || {});
    if (select) query = query.select(select === true ? '*' : select);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/db/delete', async (req, res) => {
  try {
    const { table, filters = [] } = req.body || {};
    assertAllowedTable(table);
    let query = supabase.from(table).delete();
    query = applyLocalQueryFilters(query, filters);
    const { error } = await query;
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function fetchOpenAICompatModels(endpoint, apiKey) {
  const resp = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
  if (!resp.ok) throw new Error(`Provider returned ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return rows.map((m) => ({ id: m.id || m.name, label: m.id || m.name })).filter((m) => m.id);
}

async function listProviderModels(provider, apiKey, baseUrl) {
  if (provider === 'lmstudio') return discoverLMStudioModels(baseUrl, apiKey || 'lm-studio');
  if (!apiKey) throw new Error('API key is required for this provider');
  if (provider === 'openai') return (await fetchOpenAICompatModels('https://api.openai.com/v1/models', apiKey)).filter((m) => /gpt|o\d|chat/i.test(m.id));
  if (provider === 'openrouter') return fetchOpenAICompatModels('https://openrouter.ai/api/v1/models', apiKey);
  if (provider === 'nvidia') return fetchOpenAICompatModels('https://integrate.api.nvidia.com/v1/models', apiKey);
  if (provider === 'xai') return fetchOpenAICompatModels('https://api.x.ai/v1/models', apiKey);
  if (provider === 'google') {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (!resp.ok) throw new Error(`Google returned ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return (data?.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name })).filter((m) => m.id);
  }
  if (provider === 'anthropic') {
    const resp = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (!resp.ok) throw new Error(`Anthropic returned ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return (data?.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
  }
  throw new Error(`Unknown provider: ${provider}`);
}

function openAICompatEndpoint(provider, baseUrl) {
  if (provider === 'lmstudio') return `${String(baseUrl || 'http://localhost:1234').replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1/chat/completions`;
  if (provider === 'openai') return 'https://api.openai.com/v1/chat/completions';
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
  if (provider === 'xai') return 'https://api.x.ai/v1/chat/completions';
  if (provider === 'nvidia') return 'https://integrate.api.nvidia.com/v1/chat/completions';
  throw new Error(`Provider ${provider} is not supported by the local worker chat path`);
}

function normalizeProviderName(value) {
  return String(value || 'lmstudio').trim().toLowerCase() || 'lmstudio';
}

function normalizeLMStudioBaseUrl(value) {
  return String(value || 'http://localhost:1234').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function shouldForceLocalLMStudio() {
  return String(process.env.LM_STUDIO_FORCE_LOCAL || '').toLowerCase() === 'true';
}

async function resolveSelectedAIConfig(override = null) {
  const { data: saved } = await supabase.from('app_settings').select('ai_provider,ai_base_url,ai_api_key,ai_model').eq('id', 1).single();
  const provider = normalizeProviderName(override?.provider || saved?.ai_provider || 'lmstudio');
  if (provider === 'lovable') throw new Error('Lovable AI is disabled for local-worker mode. Select LM Studio or your own API key provider in Settings.');

  if (provider === 'lmstudio') {
    const savedLm = override ? null : await refreshLMStudioConfigFromSettings(supabase);
    const baseUrl = normalizeLMStudioBaseUrl(shouldForceLocalLMStudio() ? (process.env.LM_STUDIO_URL || 'http://localhost:1234') : (override?.baseUrl || saved?.ai_base_url || savedLm?.url || process.env.LM_STUDIO_URL || 'http://localhost:1234'));
    const model = String(override?.model || saved?.ai_model || savedLm?.model || process.env.LM_STUDIO_MODEL || '').trim();
    const apiKey = String(override?.apiKey || saved?.ai_api_key || savedLm?.apiKey || process.env.LM_STUDIO_API_KEY || 'lm-studio').trim();
    if (!model) throw new Error('No LM Studio model selected. Load a model in LM Studio or choose one in Settings.');
    return { provider, baseUrl, model, apiKey, label: `lmstudio · ${model}` };
  }

  const model = String(override?.model || saved?.ai_model || '').trim();
  const apiKey = String(override?.apiKey || saved?.ai_api_key || '').trim();
  const baseUrl = String(override?.baseUrl || saved?.ai_base_url || '').trim();
  if (!model) throw new Error(`No model selected for ${provider}`);
  if (!apiKey) throw new Error(`API key is required for ${provider}`);
  return { provider, baseUrl, model, apiKey, label: `${provider} · ${model}` };
}

function createSseController(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function appendGenerationEvent(jobId, event, data) {
  if (!jobId) return;
  const payload = { type: event, ...data, _ts: Date.now() };
  try {
    const { data: current } = await supabase.from('generation_jobs').select('events').eq('id', jobId).maybeSingle();
    await supabase.from('generation_jobs').update({ events: [...(current?.events || []), payload] }).eq('id', jobId);
  } catch (err) {
    console.warn('[AI Post] Could not persist event:', err.message);
  }
}

async function localChatCompletion(messages, { tools, tool_choice, max_tokens = 2048, temperature = 0.4, aiSettings = null } = {}) {
  const config = await resolveSelectedAIConfig(aiSettings);
  const buildBody = (model) => ({
    model,
    messages,
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    temperature,
    max_tokens,
  });
  const bases = config.provider === 'lmstudio'
    ? [...new Set([config.baseUrl, process.env.LM_STUDIO_URL, 'http://localhost:1234', 'http://127.0.0.1:1234'].filter(Boolean).map(normalizeLMStudioBaseUrl))]
    : [config.baseUrl];
  let lastError = '';
  for (const base of bases) {
    const endpoint = openAICompatEndpoint(config.provider, base);
    const call = async (model) => fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey || 'lm-studio'}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(model)),
    });
    let response;
    try { response = await call(config.model); } catch (err) { lastError = `${config.provider} network error at ${base || endpoint}: ${err.message}`; continue; }
    let text = await response.text();
    if (config.provider === 'lmstudio' && !response.ok && /model|not found|unloaded|cannot find/i.test(text)) {
      const loaded = await discoverLMStudioModels(base, config.apiKey || 'lm-studio').catch(() => []);
      const fallbackModel = loaded[0]?.id;
      if (fallbackModel && fallbackModel !== config.model) {
        console.warn(`[AI] Saved LM Studio model unavailable (${config.model}); retrying loaded model ${fallbackModel}`);
        response = await call(fallbackModel);
        text = await response.text();
      }
    }
    if (response.ok) return JSON.parse(text || '{}');
    lastError = `${config.provider} returned ${response.status}: ${text.slice(0, 300)}`;
  }
  throw new Error(lastError || `${config.provider} request failed`);
}

function slugifyAgentRun(s) {
  return String(s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

async function appendAgentEvent(runId, event) {
  const { data: row } = await supabase.from('agent_runs').select('events').eq('id', runId).single();
  const events = Array.isArray(row?.events) ? row.events : [];
  events.push({ ...event, ts: Date.now() });
  await supabase.from('agent_runs').update({ events, updated_at: new Date().toISOString() }).eq('id', runId);
  return events;
}

async function setAgentRunStatus(runId, patch) {
  await supabase.from('agent_runs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', runId);
}

async function isAgentCancelled(runId) {
  const { data } = await supabase.from('agent_runs').select('status').eq('id', runId).single();
  return data?.status === 'cancelled';
}

const LOCAL_AGENT_TOOLS = [
  { type: 'function', function: { name: 'plan', description: 'Call first with 3-7 concise steps.', parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } } },
  { type: 'function', function: { name: 'research_deep', description: 'Search the web locally and return sourced findings.', parameters: { type: 'object', properties: { query: { type: 'string' }, depth: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'browser_task', description: 'Run a local browser research/automation task.', parameters: { type: 'object', properties: { task: { type: 'string' }, url: { type: 'string' } }, required: ['task'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a local workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a local workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List local workspace files.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_shell', description: 'Run an allowlisted local shell command.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'number' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'open_in_browser', description: 'Open a URL or workspace file locally.', parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } } },
  { type: 'function', function: { name: 'serve_preview', description: 'Serve the local workspace preview.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'remember_fact', description: 'Save durable memory.', parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, memory_type: { type: 'string' }, importance: { type: 'number' } }, required: ['title', 'content'] } } },
  { type: 'function', function: { name: 'finish', description: 'Finish the run with summary and artifacts.', parameters: { type: 'object', properties: { summary: { type: 'string' }, artifacts: { type: 'array', items: { type: 'object' } } }, required: ['summary'] } } },
];

async function runLocalAgent(runId) {
  const { data: run } = await supabase.from('agent_runs').select('*').eq('id', runId).single();
  if (!run) return;
  const settings = await getSettings().catch(() => null);
  const config = await resolveSelectedAIConfig(run.chat_settings || null);
  const workspaceSlug = slugifyAgentRun(run.prompt);
  try {
    await appendAgentEvent(runId, { type: 'preflight_ok', component: 'local_worker', alive: true, message: `Local worker connected · ${config.label}` });
    await appendAgentEvent(runId, { type: 'tool_call', name: 'plan', label: `${config.provider} plan` });
    await appendAgentEvent(runId, { type: 'plan', steps: [`Use selected LLM provider: ${config.label}`, 'Use local browser/tools when needed', 'Return final result without Lovable AI credits'] });
    await appendAgentEvent(runId, { type: 'tool_result', name: 'plan', ok: true, summary: 'Local plan recorded.' });

    let researchContext = '';
    if (/\b(research|latest|news|find out|crypto|web3|search|scrape|analy[sz]e)\b/i.test(run.prompt)) {
      await appendAgentEvent(runId, { type: 'tool_call', name: 'research_deep', label: run.prompt.slice(0, 80) });
      const r = await fetch(`http://localhost:${PORT}/api/research/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: run.prompt, count: 6 }),
      });
      const data = await r.json().catch(() => ({}));
      const sources = Array.isArray(data.results) ? data.results.slice(0, 6) : [];
      researchContext = sources.map((s, i) => `[${i + 1}] ${s.title || s.url}\n${s.snippet || ''}\n${s.url || ''}`).join('\n\n');
      await appendAgentEvent(runId, { type: 'tool_result', name: 'research_deep', ok: true, summary: `Found ${sources.length} sources locally.`, data: { sources } });
    }

    const reply = await localChatCompletion([
      { role: 'system', content: `You are a local-worker autonomous agent using the selected LLM provider (${config.label}). Do not mention cloud credits. Be concise and include useful sources when provided.` },
      { role: 'user', content: `${run.prompt}${researchContext ? `\n\nLocal research sources:\n${researchContext}` : ''}` },
    ], { max_tokens: 1800, temperature: 0.4, aiSettings: run.chat_settings || null });
    const summary = reply?.choices?.[0]?.message?.content || 'Done.';
    await appendAgentEvent(runId, { type: 'finish', summary });
    await setAgentRunStatus(runId, { status: 'completed', completed_at: new Date().toISOString(), result: { summary } });
    if (settings) {
      if (run.telegram_chat_id) settings.telegram.chatId = String(run.telegram_chat_id);
      await notifyTelegram(settings, `✅ Local agent completed\n\n${summary}`);
    }
  } catch (err) {
    await appendAgentEvent(runId, { type: 'error', message: err.message });
    await setAgentRunStatus(runId, { status: 'failed', completed_at: new Date().toISOString(), error: err.message });
    if (settings) {
      if (run.telegram_chat_id) settings.telegram.chatId = String(run.telegram_chat_id);
      await notifyTelegram(settings, `❌ Local agent failed: ${err.message}`);
    }
  }
}

function parseJsonFromText(text, fallback = {}) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) { try { return JSON.parse(fenced); } catch {} }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return fallback;
}

async function localJsonLLM(systemPrompt, userPrompt, fallback = {}, aiSettings = null) {
  const data = await localChatCompletion([
    { role: 'system', content: `${systemPrompt}\nReturn valid JSON only. No markdown.` },
    { role: 'user', content: userPrompt },
  ], { temperature: 0.55, max_tokens: 4096, aiSettings });
  return parseJsonFromText(data?.choices?.[0]?.message?.content || '', fallback);
}

async function storeImageFromUrl(imageUrl) {
  if (!imageUrl || String(imageUrl).startsWith('data:')) return { url: imageUrl || null, path: null };
  const resp = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return { url: imageUrl, path: null };
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const buffer = Buffer.from(await resp.arrayBuffer());
  const storagePath = `local-${Date.now()}-${randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from('social-media').upload(storagePath, buffer, { contentType, upsert: true });
  if (error) return { url: imageUrl, path: null };
  const { data } = supabase.storage.from('social-media').getPublicUrl(storagePath);
  return { url: data?.publicUrl || imageUrl, path: storagePath };
}

app.post('/api/ai/models', async (req, res) => {
  try {
    const { provider = 'lmstudio', baseUrl, apiKey } = req.body || {};
    const config = provider === 'lmstudio' ? await refreshLMStudioConfigFromSettings(supabase) : null;
    const models = await listProviderModels(provider, apiKey || config?.apiKey, baseUrl || config?.url);
    res.json({ models, provider, baseUrl: baseUrl || config?.url });
  } catch (err) {
    console.error('[AI] Model discovery failed:', err.message);
    res.status(502).json({ error: err.message || 'Could not load models' });
  }
});

// Provider-aware connection test. Runs from the LOCAL worker so it can reach
// LM Studio on private LANs and uses the user's OWN API keys for cloud providers
// — Lovable cloud is never involved.
async function testProviderConnection({ provider, baseUrl, apiKey, model }) {
  const t0 = Date.now();
  const targetModel = String(model || '').trim();

  if (provider === 'lmstudio') {
    const config = await refreshLMStudioConfigFromSettings(supabase);
    return testLMStudioConnection({
      baseUrl: baseUrl || config.url,
      apiKey: apiKey || config.apiKey,
      model: targetModel || config.model,
    });
  }

  if (!apiKey) throw new Error('API key is required for this provider');
  if (!targetModel) throw new Error('Model is required');

  // Google Gemini uses a different request shape
  if (provider === 'google') {
    const cleanModel = targetModel.replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 5 },
      }),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Google returned ${resp.status}: ${text.slice(0, 200)}`);
    return { ok: true, provider, model: targetModel, latency: Date.now() - t0 };
  }

  // OpenAI-compatible providers
  let endpoint;
  let modelId = targetModel;
  if (provider === 'openai') endpoint = 'https://api.openai.com/v1/chat/completions';
  else if (provider === 'openrouter') endpoint = 'https://openrouter.ai/api/v1/chat/completions';
  else if (provider === 'xai') endpoint = 'https://api.x.ai/v1/chat/completions';
  else if (provider === 'nvidia') endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
  else if (provider === 'anthropic') {
    endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    if (!modelId.startsWith('anthropic/')) modelId = `anthropic/${modelId}`;
  } else throw new Error(`Unknown provider: ${provider}`);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${provider} returned ${resp.status}: ${text.slice(0, 200)}`);
  return { ok: true, provider, model: targetModel, latency: Date.now() - t0 };
}

app.post('/api/ai/test', async (req, res) => {
  try {
    const { provider = 'lmstudio', baseUrl, apiKey, model } = req.body || {};
    const result = await testProviderConnection({ provider, baseUrl, apiKey, model });
    res.json(result);
  } catch (err) {
    console.error(`[AI] ${req.body?.provider || 'lmstudio'} test failed:`, err.message);
    res.status(200).json({ ok: false, error: err.message || 'Connection test failed' });
  }
});

app.post('/api/agent/test', async (req, res) => {
  try {
    const { kind = 'research', provider = 'local', apiKey = '', model = '' } = req.body || {};
    if (kind === 'research') {
      const r = await fetch(`http://localhost:${PORT}/api/research/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test', count: 1 }),
      });
      const data = await r.json().catch(() => ({}));
      return res.json({ ok: r.ok, provider: data.provider || provider || 'local', sample: data.results?.[0]?.title || 'local research ready' });
    }
    if (provider && provider !== 'auto' && provider !== 'local' && provider !== 'lovable') {
      const result = await testProviderConnection({ provider, apiKey, model: model || 'test' });
      return res.json(result);
    }
    res.json({ ok: true, provider: 'local', sample: 'local image/browser tools ready' });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

app.post('/api/image/models', async (req, res) => {
  const { provider = 'local' } = req.body || {};
  const map = {
    xai: ['grok-2-image', 'grok-2-image-1212'],
    openai: ['gpt-image-1', 'dall-e-3'],
    google: ['imagen-4.0-generate-preview-06-06', 'gemini-2.5-flash-image'],
    nvidia: ['stable-diffusion-3-medium'],
    local: ['local-browser-image-search'],
    auto: ['local-browser-image-search'],
  };
  const ids = map[provider] || map.local;
  res.json({ models: ids.map((id) => ({ id, label: id, recommended: id.includes('local') })) });
});

app.post('/api/generate-social-post', async (req, res) => {
  const { prompt, platforms = [], includeImage = true, stream = true, telegram_chat_id = null, aiSettings = null } = req.body || {};
  if (!prompt || !Array.isArray(platforms) || platforms.length === 0) {
    return res.status(400).json({ error: 'prompt and platforms are required' });
  }

  const send = stream ? createSseController(res) : () => {};
  let jobId = null;
  const persist = async (event, data) => appendGenerationEvent(jobId, event, data);
  const emit = async (event, data) => { send(event, data); await persist(event, data); };

  try {
    const { data: liveJobs } = await supabase.from('generation_jobs')
      .select('id, prompt').eq('status', 'running').order('created_at', { ascending: false }).limit(1);
    if (liveJobs?.length) {
      const error = 'Another generation is already running. Cancel it first or wait for it to finish.';
      if (stream) { await emit('error', { error }); res.end(); return; }
      return res.status(409).json({ error, busyJobId: liveJobs[0].id, busyPrompt: liveJobs[0].prompt });
    }

    const { data: jobRow, error: jobError } = await supabase.from('generation_jobs').insert({
      prompt, platforms, include_image: !!includeImage, status: 'running', events: [],
    }).select('id').single();
    if (jobError) throw jobError;
    jobId = jobRow.id;

    await emit('job', { id: jobId });
    const config = await resolveSelectedAIConfig(aiSettings);
    await emit('step', { id: 'init', emoji: '🚀', label: `Connecting to ${config.provider} through local worker…`, status: 'active' });
    await emit('step', { id: 'init', emoji: '✅', label: `Connected · ${config.label}`, status: 'done' });
    await emit('tool', { kind: 'llm', name: config.provider, detail: config.model });

    await emit('step', { id: 'plan', emoji: '🧠', label: 'Planning research strategy…', status: 'active' });
    const plan = await localJsonLLM(
      'You plan a real-time social post research workflow.',
      `Create JSON with keys: queries (array of 2-4 web search queries), imageQuery (string), imageStrategy (real_photo or none), angle (string), needsResearch (boolean). User request: ${prompt}. Platforms: ${platforms.join(', ')}.`,
      { queries: [prompt], imageQuery: prompt, imageStrategy: includeImage ? 'real_photo' : 'none', angle: prompt, needsResearch: true },
      aiSettings,
    );
    const queries = (Array.isArray(plan.queries) && plan.queries.length ? plan.queries : [prompt]).slice(0, 4);
    const imageStrategy = includeImage ? (plan.imageStrategy || 'real_photo') : 'none';
    await emit('step', { id: 'plan', emoji: '🧠', label: `Plan: ${plan.angle || prompt.slice(0, 80)}`, status: 'done' });
    await emit('plan', { queries, imageStrategy, angle: plan.angle || prompt });

    const sources = [];
    const seen = new Set();
    // Use saved research config (Brave first if provider+key set, then DDG, then local browser)
    const settingsRow = await supabase.from('app_settings').select('research_provider,research_api_key').eq('id', 1).single();
    const researchProvider = settingsRow.data?.research_provider || 'auto';
    const researchKey = settingsRow.data?.research_api_key || '';
    for (let i = 0; i < queries.length; i += 1) {
      const q = queries[i];
      await emit('step', { id: `search-${i}`, emoji: '🔎', label: `Searching: "${q}"`, status: 'active' });
      const fresh = [];
      // 1) Brave API if configured
      if ((researchProvider === 'brave' || researchProvider === 'auto') && researchKey) {
        try {
          const br = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`, {
            headers: { 'X-Subscription-Token': researchKey, Accept: 'application/json' },
          });
          if (br.ok) {
            const bj = await br.json();
            const items = (bj?.web?.results || []).slice(0, 5).map((x) => ({ title: x.title, url: x.url, snippet: x.description || '' }));
            items.filter((s) => s?.url && !seen.has(s.url)).forEach((s) => { seen.add(s.url); fresh.push(s); });
            if (items.length) await emit('tool', { kind: 'research', name: 'brave', detail: q });
          }
        } catch (e) { console.warn('[Research] Brave API failed:', e.message); }
      }
      // 2) DuckDuckGo / local browser fallback
      if (fresh.length < 3) {
        const r = await fetch(`http://localhost:${PORT}/api/research/search`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, count: 5 }),
        });
        const data = await r.json().catch(() => ({}));
        await emit('tool', { kind: 'research', name: data.provider || 'duckduckgo', detail: q });
        (data.results || []).filter((s) => s?.url && !seen.has(s.url)).slice(0, 5).forEach((s) => { seen.add(s.url); fresh.push(s); });
      }
      fresh.forEach((s) => sources.push({ ...s, favicon: s.url ? `https://www.google.com/s2/favicons?sz=32&domain=${hostnameOf(s.url)}` : '' }));
      await emit('step', { id: `search-${i}`, emoji: '🔎', label: `Found ${fresh.length} sources`, status: 'done' });
      for (const source of fresh) await emit('source', source);
    }

    // Deep-dive: fetch top source pages and extract readable article text so the LLM has
    // real content to summarise (not just headlines). Keeps it cheap by capping pages + chars.
    await emit('step', { id: 'deepread', emoji: '📖', label: `Reading top ${Math.min(sources.length, 4)} sources for deeper context…`, status: 'active' });
    const topSources = sources.slice(0, 4);
    await Promise.all(topSources.map(async (s) => {
      try {
        const r = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LovableAgent/1.0)' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const html = await r.text();
        // Strip scripts/styles, take text inside <article>/<main>/<p> if possible.
        const cleaned = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
        const articleMatch = cleaned.match(/<article[\s\S]*?<\/article>/i)?.[0]
          || cleaned.match(/<main[\s\S]*?<\/main>/i)?.[0]
          || cleaned;
        const text = articleMatch
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1800);
        if (text.length > 200) s.content = text;
      } catch (e) { /* skip page */ }
    }));
    const readCount = topSources.filter((s) => s.content).length;
    await emit('step', { id: 'deepread', emoji: '📖', label: `Extracted full text from ${readCount} of ${topSources.length} pages`, status: 'done' });

    await emit('step', { id: 'write', emoji: '✍️', label: `Writing ${platforms.length} tailored narrative posts with local LLM…`, status: 'active' });
    // Build a rich source block: include extracted page content when available, snippet otherwise.
    const sourcesBlock = sources.slice(0, 8).map((s, i) => {
      const body = s.content || s.snippet || '';
      return `[${i + 1}] ${s.title}\n${body}\nURL: ${s.url}`;
    }).join('\n\n');
    const platformLimits = { x: 280, twitter: 280, linkedin: 1200, facebook: 800, instagram: 1500, tiktok: 800 };
    const platformStyles = {
      x: 'Punchy, conversational, 1-3 short sentences. Strong hook in first 8 words. No bullet lists. No URLs.',
      twitter: 'Punchy, conversational, 1-3 short sentences. Strong hook in first 8 words. No bullet lists. No URLs.',
      linkedin: 'Professional storytelling: 3-5 short paragraphs. Open with a hook, give context, share insight, end with a question or CTA. No bullet lists of headlines — write a real narrative.',
      facebook: 'Friendly, story-driven, 2-4 short paragraphs. Conversational tone. End with a question to spark replies.',
      instagram: 'Lifestyle/inspirational tone, 2-4 short paragraphs separated by line breaks. Engaging hook, emojis OK (sparingly).',
      tiktok: 'Hooky and casual. Short punchy lines. Speak to the viewer directly.',
    };
    const platformGuide = platforms.map((p) => {
      const k = p.toLowerCase();
      return `- ${p} (max ~${platformLimits[k] || 800} chars): ${platformStyles[k] || 'Engaging, native to the platform.'}`;
    }).join('\n');
    let variants = {};
    // Try up to 2 attempts to coax valid JSON out of the local LLM
    for (let attempt = 0; attempt < 2 && Object.keys(variants).length === 0; attempt += 1) {
      const write = await localJsonLLM(
        'You are a senior social media writer. You DO NOT paste headlines or lists of links. You synthesise research into a real human-written story for each platform. Output ONLY a JSON object — no prose, no markdown fences. Hashtags are arrays of plain words WITHOUT the # symbol.',
        `Write a unique, human-sounding social post for EACH platform below, based on the research.\n\nUser goal: ${prompt}\nAngle: ${plan.angle || prompt}\n\nRULES:\n- Write a real narrative — flowing sentences and short paragraphs.\n- DO NOT list headlines, bullets of source titles, or "•" lines.\n- DO NOT include raw URLs in the body.\n- Pull concrete facts, names, numbers from the research below; weave them naturally.\n- Match each platform's tone and length.\n- 4-8 relevant hashtags per platform (no # symbol).\n\nPlatforms:\n${platformGuide}\n\nResearch (use this to inform the story):\n${sourcesBlock || '(no sources — write from general knowledge of the topic)'}\n\nReturn EXACTLY this shape:\n{"variants":{${platforms.map((p) => `"${p}":{"description":"<full narrative post here>","hashtags":["tag1","tag2"]}`).join(',')}}}`,
        { variants: {} },
        aiSettings,
      );
      variants = write.variants || {};
    }
    // Last-resort fallback: synthesise a narrative paragraph (NOT a bullet list) from research
    if (Object.keys(variants).length === 0) {
      const facts = sources.slice(0, 4)
        .map((s) => (s.content || s.snippet || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const opener = `Here's what's happening with ${plan.angle || prompt}:`;
      const body = facts.length
        ? facts.map((f) => f.split(/(?<=[.!?])\s/).slice(0, 2).join(' ')).join(' ')
        : `${prompt}. Latest reporting suggests this story is still developing — more soon.`;
      const baseTags = (plan.angle || prompt).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 5);
      platforms.forEach((p) => {
        const limit = platformLimits[p.toLowerCase()] || 800;
        variants[p] = { description: `${opener}\n\n${body}`.slice(0, limit), hashtags: baseTags };
      });
      await emit('step', { id: 'write-fallback', emoji: '🛟', label: 'LLM returned no JSON — synthesised narrative draft from extracted page text', status: 'done' });
    }
    await emit('step', { id: 'write', emoji: '✨', label: `Wrote ${Object.keys(variants).length} platform variants`, status: 'done' });
    for (const platform of platforms) {
      const v = variants[platform];
      if (v) await emit('variant', { platform, description: v.description || '', hashtags: Array.isArray(v.hashtags) ? v.hashtags : [] });
    }
    await emit('sources', { sources: sources.slice(0, 8) });

    let imageUrl = null;
    let imagePath = null;
    if (includeImage && imageStrategy !== 'none') {
      await emit('step', { id: 'image-local', emoji: '🌐', label: 'Finding image with local browser…', status: 'active' });
      const imgResp = await fetch(`http://localhost:${PORT}/api/research/image-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: plan.imageQuery || prompt, urls: sources.slice(0, 3).map((s) => s.url), count: 4 }),
      });
      const imgData = await imgResp.json().catch(() => ({}));
      const first = (imgData.images || [])[0];
      const rawUrl = typeof first === 'string' ? first : first?.url;
      if (rawUrl) {
        const stored = await storeImageFromUrl(rawUrl);
        imageUrl = stored.url; imagePath = stored.path;
        await emit('tool', { kind: 'image', name: imgData.provider || 'local-browser', detail: plan.imageQuery || prompt });
        await emit('step', { id: 'image-local', emoji: '🌐', label: `Image found via ${imgData.provider || 'local browser'}`, status: 'done' });
        await emit('image', { imageUrl, imagePath, credit: imgData.provider || 'Local browser scrape' });
      } else {
        await emit('step', { id: 'image-local', emoji: '⚠️', label: 'No usable image found locally', status: 'error' });
      }
    }

    let savedPostId = null;
    const primary = variants[platforms[0]] || Object.values(variants)[0];
    if (primary) {
      const { data: saved } = await supabase.from('social_posts').insert({
        description: primary.description || '', image_path: imagePath, hashtags: primary.hashtags || [], target_platforms: platforms,
        account_selections: {}, scheduled_at: null, ai_prompt: prompt, ai_sources: sources.slice(0, 8), status: 'draft',
        platform_results: platforms.map((name) => ({ name, status: 'pending' })), platform_variants: variants,
      }).select('id').single();
      savedPostId = saved?.id || null;
      if (savedPostId) await emit('saved', { id: savedPostId, status: 'draft' });
    }

    const result = { variants, sources: sources.slice(0, 8), imageUrl, imagePath, provider: config.provider, model: config.model };
    await emit('step', { id: 'done', emoji: '🎉', label: 'All done — generated through local worker and saved as draft!', status: 'done' });
    await emit('done', result);
    await supabase.from('generation_jobs').update({ status: 'completed', result, saved_post_id: savedPostId, completed_at: new Date().toISOString() }).eq('id', jobId);
    const settings = await getSettings().catch(() => null);
    if (settings?.telegram?.enabled) {
      const originalChat = settings.telegram.chatId;
      if (telegram_chat_id) settings.telegram.chatId = String(telegram_chat_id);
      // Comprehensive multi-platform summary so user sees ALL drafts + direct link in Telegram
      const variantBlocks = platforms.map((p) => {
        const v = variants[p];
        if (!v) return '';
        const tags = Array.isArray(v.hashtags) && v.hashtags.length ? `\n#${v.hashtags.slice(0, 8).join(' #')}` : '';
        return `━━━ ${p.toUpperCase()} ━━━\n${v.description || ''}${tags}`;
      }).filter(Boolean).join('\n\n');
      const sourceText = sources.length ? `\n\n📚 Sources:\n${sources.slice(0, 5).map((src, i) => `${i + 1}. ${src.title || src.url}\n${src.url || ''}`).join('\n')}` : '';
      const draftLink = savedPostId ? `\n\n🔗 Open draft: ${process.env.PUBLIC_APP_URL || 'http://localhost:8081'}/social?post=${savedPostId}` : '';
      const imgLine = imageUrl ? `\n\n🖼 Image: ${imageUrl}` : '';
      await notifyTelegram(settings, `✅ AI post generated (${platforms.join(', ')})\n\n${variantBlocks}${imgLine}${sourceText}${draftLink}`);
      settings.telegram.chatId = originalChat;
    }
    if (stream) res.end(); else res.json(result);
  } catch (err) {
    console.error('[AI Post] Local generation failed:', err.message);
    if (jobId) await supabase.from('generation_jobs').update({ status: 'failed', error: err.message, completed_at: new Date().toISOString() }).eq('id', jobId);
    if (stream) { await emit('error', { error: err.message }); res.end(); } else res.status(500).json({ error: err.message });
  }
});

// --- Research search endpoint (DuckDuckGo HTML → Brave/Google scrape via persistent browser) ---
// Used by the cloud AI agent when no research API key is configured.
// Strategy:
//   1) Cheap DuckDuckGo HTML scrape (no browser).
//   2) If empty/blocked, open a PERSISTENT Chromium context (shared profile, like uploads) and
//      try Brave Search → Google → DuckDuckGo, in that order. Visible by default so the user
//      can watch + intervene on captchas, matching the upload-flow behavior.
const { launchPersistent: launchPersistentSocial, safeClose: safeCloseSocial } = require('./uploaders/social-post-base');

async function scrapeWithLocalBrowser(query, count, { headless = false } = {}) {
  const context = await launchPersistentSocial('research', {});
  try {
    if (!headless) {
      // Visible mode is the default — but persistent context already shows. Nothing extra needed.
    }
    const page = await context.newPage();
    // 1) Brave (no captchas, often best results)
    try {
      await page.goto(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const r = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('div.snippet, div[data-type="web"], #results .snippet').forEach((el) => {
          if (out.length >= max) return;
          const a = el.querySelector('a[href^="http"]');
          const t = el.querySelector('.title, .snippet-title, h3, .url');
          const sn = el.querySelector('.snippet-description, .description, p');
          if (a && t) out.push({ title: (t.textContent || '').trim(), url: a.href, snippet: sn ? (sn.textContent || '').trim() : '' });
        });
        return out;
      }, count);
      if (r.length) return { provider: 'brave-local', results: r };
    } catch (e) { console.warn('[Research] Brave-local failed:', e.message); }

    // 2) DuckDuckGo via the visible browser (handles JS challenges DDG html sometimes shows)
    try {
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(800);
      const r = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('article[data-testid="result"], .react-results--main article').forEach((el) => {
          if (out.length >= max) return;
          const a = el.querySelector('a[data-testid="result-title-a"], h2 a');
          const sn = el.querySelector('[data-result="snippet"], .result__snippet');
          if (a) out.push({ title: (a.textContent || '').trim(), url: a.href, snippet: sn ? (sn.textContent || '').trim() : '' });
        });
        return out;
      }, count);
      if (r.length) return { provider: 'duckduckgo-local', results: r };
    } catch (e) { console.warn('[Research] DDG-local failed:', e.message); }

    // 3) Google as last resort (may show captcha — visible browser lets the user solve it)
    try {
      await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=${count}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const r = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('div.g, div.MjjYud').forEach((el) => {
          if (out.length >= max) return;
          const a = el.querySelector('a[href^="http"]');
          const h3 = el.querySelector('h3');
          const sn = el.querySelector('div[data-sncf], .VwiC3b, .yXK7lf');
          if (a && h3) out.push({ title: h3.textContent || '', url: a.href, snippet: sn ? (sn.textContent || '') : '' });
        });
        return out;
      }, count);
      if (r.length) return { provider: 'google-local', results: r };
    } catch (e) { console.warn('[Research] Google-local failed:', e.message); }

    return { provider: 'none', results: [] };
  } finally {
    await safeCloseSocial(context);
  }
}

async function searchImagesFromSourcePages(urls = [], count = 3) {
  const targets = [...new Set((Array.isArray(urls) ? urls : []).filter(Boolean))].slice(0, 4);
  if (targets.length === 0) return { provider: 'source-pages', images: [] };

  const context = await launchPersistentSocial('research', {});
  try {
    const page = await context.newPage();
    const images = [];
    const screenshotFallbacks = [];

    for (const targetUrl of targets) {
      if (images.length >= count) break;
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1200);

        const found = await page.evaluate(({ max, pageUrl }) => {
          const pushUnique = (list, item) => {
            if (!item?.url) return;
            if (list.some((entry) => entry.url === item.url)) return;
            list.push(item);
          };

          const absolutize = (value) => {
            if (!value) return '';
            try { return new URL(value, pageUrl).toString(); } catch { return ''; }
          };

          const isUsable = (value) => {
            const url = String(value || '').trim();
            if (!/^https?:/i.test(url)) return false;
            if (/sprite|icon|logo|avatar|1x1|blank|emoji/i.test(url)) return false;
            return true;
          };

          const out = [];

          const ogImage = document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]')?.getAttribute('content');
          const ogAlt = document.querySelector('meta[property="og:image:alt"], meta[name="twitter:image:alt"]')?.getAttribute('content') || '';
          const ogUrl = absolutize(ogImage);
          if (isUsable(ogUrl)) {
            pushUnique(out, { url: ogUrl, source: 'source-page-meta', pageUrl, title: document.title || '', alt: ogAlt || '' });
          }

          document.querySelectorAll('article img, main img, figure img, img').forEach((img) => {
            if (out.length >= max) return;
            const width = Number(img.getAttribute('width') || img.naturalWidth || img.clientWidth || 0);
            const height = Number(img.getAttribute('height') || img.naturalHeight || img.clientHeight || 0);
            if (width < 220 || height < 180) return;

            const candidate = absolutize(
              img.getAttribute('src') ||
              img.getAttribute('data-src') ||
              img.getAttribute('data-lazy-src') ||
              img.currentSrc ||
              ''
            );
            if (!isUsable(candidate)) return;

            const alt = (img.getAttribute('alt') || '').trim();
            pushUnique(out, {
              url: candidate,
              source: 'source-page-dom',
              pageUrl,
              title: document.title || '',
              alt,
            });
          });

          return out.slice(0, max);
        }, { max: Math.max(1, count - images.length), pageUrl: targetUrl });

        if (found.length) {
          images.push(...found.filter((item) => item?.url));
          continue;
        }

        // ── SCREENSHOT FALLBACK ──
        // If a source page exposed no usable image (paywall / aggressive lazy-loading /
        // pure text article), capture the viewport itself as a data: URL so the cloud
        // edge function can still attach something visual to the post.
        try {
          const buf = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
          if (buf && buf.length) {
            const dataUrl = `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`;
            const titleText = await page.title().catch(() => '');
            screenshotFallbacks.push({
              url: dataUrl,
              source: 'source-page-screenshot',
              pageUrl: targetUrl,
              title: titleText || hostnameOf(targetUrl) || targetUrl,
              alt: `Screenshot of ${targetUrl}`,
            });
            console.log(`[Image] Captured screenshot fallback for ${targetUrl} (${buf.length} bytes)`);
          }
        } catch (e) {
          console.warn(`[Image] Screenshot fallback failed for ${targetUrl}:`, e.message);
        }
      } catch (e) {
        console.warn(`[Image] Source page scan failed for ${targetUrl}:`, e.message);
      }
    }

    // Prefer real images; only fall back to screenshots if no real images were found.
    const finalImages = images.length ? images.slice(0, count) : screenshotFallbacks.slice(0, count);
    return { provider: 'source-pages', images: finalImages };
  } finally {
    await safeCloseSocial(context);
  }
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

app.post('/api/research/search', async (req, res) => {
  const { query, count = 6 } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query required' });

  const decode = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

  // 1) DuckDuckGo HTML (cheap, no browser)
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LovableAgent/1.0)' },
    });
    if (r.ok) {
      const html = await r.text();
      const results = [];
      const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = blockRe.exec(html)) && results.length < count) {
        let url = m[1];
        const uddg = url.match(/uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]);
        const title = decode(m[2].replace(/<[^>]+>/g, '').trim());
        const snippet = decode(m[3].replace(/<[^>]+>/g, '').trim());
        if (url && title) results.push({ title, url, snippet });
      }
      if (results.length) return res.json({ provider: 'duckduckgo', results });
    }
  } catch (e) { console.warn('[Research] DuckDuckGo HTML failed:', e.message); }

  // 2) Open a real persistent browser (visible) — same approach as video uploads.
  try {
    const out = await scrapeWithLocalBrowser(query, count, { headless: false });
    if (out.results.length) return res.json(out);
  } catch (e) { console.warn('[Research] Local browser scrape failed:', e.message); }

  return res.json({ provider: 'none', results: [] });
});

// Image search via local browser — DuckDuckGo Images (no captchas) → Bing Images fallback.
// Used by the cloud agent when stock providers (Unsplash/Pexels) are not configured.
app.post('/api/research/image-search', async (req, res) => {
  const { query, count = 5, urls = [] } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query required' });

  try {
    const sourcePageResults = await searchImagesFromSourcePages(urls, count);
    if (sourcePageResults.images.length) return res.json(sourcePageResults);
  } catch (e) {
    console.warn('[Image] Source-page image search failed:', e.message);
  }

  const context = await launchPersistentSocial('research', {});
  try {
    const page = await context.newPage();
    // 1) DuckDuckGo Images (uses XHR JSON under the hood, easy to parse from the page)
    try {
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);
      const images = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('img.tile--img__img, .tile--img img, img[data-src*="http"]').forEach((el) => {
          if (out.length >= max) return;
          const url = el.getAttribute('data-src') || el.getAttribute('src');
          if (url && url.startsWith('http')) out.push({ url, source: 'duckduckgo' });
        });
        return out;
      }, count);
      if (images.length) return res.json({ provider: 'duckduckgo-images', images });
    } catch (e) { console.warn('[Image] DDG images failed:', e.message); }

    // 2) Bing Images
    try {
      await page.goto(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);
      const images = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('a.iusc').forEach((el) => {
          if (out.length >= max) return;
          try {
            const m = JSON.parse(el.getAttribute('m') || '{}');
            if (m.murl) out.push({ url: m.murl, source: 'bing' });
          } catch {}
        });
        return out;
      }, count);
      if (images.length) return res.json({ provider: 'bing-images', images });
    } catch (e) { console.warn('[Image] Bing images failed:', e.message); }

    return res.json({ provider: 'none', images: [] });
  } finally {
    await safeCloseSocial(context);
  }
});

app.post('/api/process/:id', async (req, res) => {
  processJob(req.params.id).catch(e => console.error('[Worker] Job error:', e.message));
  res.json({ started: true });
});

// Serve screenshots captured by browser_research so the Job Queue UI can render
// openable preview links for each researched source page.
app.get('/api/browser-research/screenshot/:file', (req, res) => {
  try {
    const { SCREENSHOT_DIR } = require('./browserResearch');
    const file = String(req.params.file || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!file) return res.status(400).end('Bad filename');
    const full = path.join(SCREENSHOT_DIR, file);
    if (!full.startsWith(SCREENSHOT_DIR) || !fs.existsSync(full)) return res.status(404).end('Not found');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    res.status(500).end(String(e.message || e));
  }
});

async function triggerPendingUploadProcessing(limit = 5) {
  const { data: jobs } = await supabase
    .from('upload_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  const ids = (jobs || []).map(j => j.id).filter(id => !processingJobs.has(id));
  for (const id of ids) {
    processJob(id).catch((e) => console.error(`[Worker] Job ${id} error:`, e.message));
  }

  return ids.length;
}

app.post('/api/process-pending', async (req, res) => {
  try {
    const queued = await triggerPendingUploadProcessing(5);
    res.json({ queued });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/browser-profiles', (req, res) => {
  res.json(listBrowserProfiles());
});

app.get('/api/browser-profiles/account/:accountId', async (req, res) => {
  try {
    const accountId = String(req.params.accountId || '').trim();
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    const accounts = await getAllPlatformAccounts();
    const account = accounts.find((item) => item.id === accountId);
    const profile = getBrowserProfileForAccount(accountId) || (account ? findLinkedSiblingBrowserProfile(account, accounts) : null);
    res.json({ profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-profiles/job-selections', (req, res) => {
  try {
    const { jobId, selections } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    const saved = saveJobAccountSelections(jobId, selections || {});
    res.json({ selections: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-profiles/scheduled-selections', (req, res) => {
  try {
    const { scheduledId, selections } = req.body || {};
    if (!scheduledId) return res.status(400).json({ error: 'scheduledId is required' });
    const saved = saveScheduledAccountSelections(scheduledId, selections || {});
    res.json({ selections: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-profiles/open', async (req, res) => {
  try {
    const { accountId, label, platform, profileId } = req.body || {};
    const ALLOWED = ['youtube', 'tiktok', 'instagram', 'social-x', 'social-tiktok', 'social-facebook'];
    if (!platform || !ALLOWED.includes(platform)) {
      return res.status(400).json({ error: 'Valid platform is required' });
    }

    const isSocial = platform.startsWith('social-');
    const accountTable = isSocial ? 'social_post_accounts' : 'platform_accounts';
    const { data: rawAccounts } = await supabase.from(accountTable).select('*');
    const accounts = rawAccounts || [];
    const account = accountId ? accounts.find((item) => item.id === String(accountId)) : null;

    let profile = profileId
      ? upsertBrowserProfile({ profileId: String(profileId), label: label || account?.label || 'Browser Profile' })
      : account
        ? getBrowserProfileForAccount(account.id) || findLinkedSiblingBrowserProfile(account, accounts)
        : null;

    if (!profile) {
      profile = upsertBrowserProfile({
        label: label || account?.label || account?.email || 'Browser Profile',
      });
    }

    const linkedAccountIds = [];
    if (account) {
      const relatedAccounts = getRelatedAccounts(accounts, account);
      for (const relatedAccount of relatedAccounts) {
        linkAccountToBrowserProfile(relatedAccount.id, profile.id);
        linkedAccountIds.push(relatedAccount.id);
      }
    }

    await closeBrowserProfileSession(profile.id);
    await openBrowserProfileSession({ profileId: profile.id, platform });
    res.json({ profile, linkedAccountIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Social posts processing ---
const { processSocialPost, pollDueSocialPosts } = require('./socialPostProcessor');

app.post('/api/social-posts/process/:id', (req, res) => {
  const id = req.params.id;
  processSocialPost(supabase, id, async (msg) => {
    const settings = await getSettings().catch(() => null);
    if (settings) await notifyTelegram(settings, msg);
  }).catch((e) => console.error('[SocialPosts] Job error:', e.message));
  res.json({ started: true });
});

// --- Helpers for TechPulse social-post bundles ---
// A bundle = 1 .txt manifest (TECHPULSE_SOCIAL_POST_V1 format) + N image files
// in the same folder. Used by both the manual scan endpoint and the recurring
// folder schedule processor.
const SOCIAL_BUNDLE_IMG_RE = /\.(jpe?g|png|webp)$/i;

function parseBundleManifest(content) {
  const headers = {};
  const declaredImages = [];
  const sections = {};
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^---[A-Z_]+---$/.test(line.trim())) break;
    const m = line.match(/^([a-zA-Z_]+):\s*(.+)?$/);
    if (m) headers[m[1].toLowerCase()] = (m[2] || '').trim();
    else if (/^images:\s*$/i.test(line.trim())) {
      i++;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (!l || /^---[A-Z_]+---$/.test(l)) break;
        const mm = l.match(/^\d+\.\s*(.+)$/);
        if (mm) declaredImages.push(mm[1].trim()); else break;
        i++;
      }
      continue;
    }
    i++;
  }
  while (i < lines.length) {
    const open = lines[i].trim().match(/^---([A-Z_]+)---$/);
    if (open) {
      const name = open[1];
      const close = `---END_${name}---`;
      const buf = [];
      i++;
      while (i < lines.length && lines[i].trim() !== close) { buf.push(lines[i]); i++; }
      sections[name] = buf.join('\n').trim();
    }
    i++;
  }
  return { headers, declaredImages, sections };
}

function normalizePlatformName(p) {
  const t = String(p || '').toLowerCase().trim();
  if (t === 'x' || t === 'x.com' || t === 'twitter') return 'x';
  if (t === 'linkedin') return 'linkedin';
  if (t === 'facebook' || t === 'fb') return 'facebook';
  return null;
}

// Scan a folder, return parsed bundles. Each entry includes raw image bytes so
// the caller can either base64-encode them (browser scan) or upload them to
// Supabase storage (recurring schedule processor).
function scanLocalBundles(folderPath) {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error(`Folder not found: ${folderPath}`);
  }
  const entries = fs.readdirSync(folderPath);
  const txts = entries.filter((n) => n.toLowerCase().endsWith('.txt')).sort();
  const imgs = entries.filter((n) => SOCIAL_BUNDLE_IMG_RE.test(n));
  const bundles = [];
  for (const txt of txts) {
    let content = '';
    try { content = fs.readFileSync(path.join(folderPath, txt), 'utf-8'); } catch { continue; }
    if (!/TECHPULSE_SOCIAL_POST_V1/.test(content)) continue;
    const { headers, declaredImages, sections } = parseBundleManifest(content);
    const platforms = (headers.platforms || '')
      .split(',').map((p) => normalizePlatformName(p)).filter(Boolean);
    const liFb = sections['LINKEDIN_FACEBOOK_POST'] || '';
    const xText = sections['X_THREAD_OR_LONG_POST'] || liFb;
    const articleUrls = sections['ARTICLE_URLS'] || '';
    const tail = articleUrls
      ? '\n\n' + articleUrls.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const m = l.match(/^[^:]+:\s*(https?:\/\/.+)$/); return m ? m[1] : l;
        }).join('\n')
      : '';
    const texts = {};
    if (liFb) { texts.linkedin = (liFb + tail).trim(); texts.facebook = (liFb + tail).trim(); }
    if (xText) texts.x = xText.trim();
    // Auto-discover images by filename prefix when manifest doesn't list them.
    // Bundles like `2026-05-08-morning-post-01.txt` ↔
    // `2026-05-08-morning-post-01-story-01-*.jpg`.
    let imageNames = declaredImages.slice();
    if (imageNames.length === 0) {
      const stem = txt.replace(/\.[^.]+$/, '').toLowerCase();
      imageNames = imgs
        .filter((f) => f.toLowerCase().startsWith(stem))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }
    const images = [];
    for (const name of imageNames) {
      const match = imgs.find((f) => f.toLowerCase() === name.toLowerCase());
      if (!match) { images.push({ name, missing: true }); continue; }
      try {
        const buf = fs.readFileSync(path.join(folderPath, match));
        const ext = (match.match(/\.([a-z0-9]+)$/i) || [, 'jpg'])[1].toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        images.push({ name: match, mime, buffer: buf });
      } catch { images.push({ name, missing: true }); }
    }
    bundles.push({ manifestName: txt, content, platforms, texts, images });
  }
  return bundles;
}

// --- Scan a local folder for TechPulse social-post bundles (browser-facing) ---
app.post('/api/social-posts/scan-bundles', (req, res) => {
  try {
    let folderPath = String(req.body?.folderPath || '').trim().replace(/^["']|["']$/g, '');
    if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
    const bundles = scanLocalBundles(folderPath).map((b) => ({
      manifestName: b.manifestName,
      content: b.content,
      images: b.images.map((img) => img.missing
        ? { name: img.name, missing: true }
        : { name: img.name, mime: img.mime, dataBase64: img.buffer.toString('base64') }),
    }));
    res.json({ folderPath, count: bundles.length, bundles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload a bundle's images to the social-media storage bucket and return their paths.
async function uploadBundleImagesToStorage(bundle) {
  const paths = [];
  for (const img of bundle.images) {
    if (img.missing) continue;
    const key = `folder-schedule/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${img.name}`;
    const { error } = await supabase.storage.from('social-media').upload(key, img.buffer, {
      contentType: img.mime, upsert: false,
    });
    if (error) throw new Error(`Image upload failed: ${error.message}`);
    paths.push(key);
  }
  return paths;
}

app.post('/api/check-stats', async (req, res) => {
  const { platform } = req.body || {};
  if (!platform || !['youtube', 'tiktok', 'instagram'].includes(platform)) {
    return res.status(400).json({ error: 'Provide platform: youtube, tiktok, or instagram' });
  }
  
  try {
    const settings = await getSettings();
    const creds = settings[platform];
    if (!creds?.enabled || !creds?.email) {
      return res.status(400).json({ error: `${platform} not configured` });
    }

    // Non-blocking: start stats check and send results via Telegram
    (async () => {
      try {
        const stats = await checkPlatformStats(platform, {
          ...creds,
          telegram: settings.telegram,
          backend: settings.backend,
        });
        const platformName = platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Instagram';
        const msg = formatStatsForTelegram(platformName, stats);
        await notifyTelegram(settings, msg);
      } catch (err) {
        console.error(`[Stats] ${platform} check failed:`, err.message);
        const settings2 = await getSettings().catch(() => null);
        if (settings2) await notifyTelegram(settings2, `❌ Stats check failed for ${platform}: ${err.message}`);
      }
    })();

    res.json({ started: true, platform });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Stats check all platforms ---
app.post('/api/check-all-stats', async (req, res) => {
  try {
    const settings = await getSettings();
    const platforms = ['youtube', 'tiktok', 'instagram'].filter(p => settings[p]?.enabled && settings[p]?.email);
    
    if (platforms.length === 0) {
      return res.status(400).json({ error: 'No platforms configured' });
    }

    (async () => {
      const allStats = [];
      for (const platform of platforms) {
        try {
          const stats = await checkPlatformStats(platform, {
            ...settings[platform],
            telegram: settings.telegram,
            backend: settings.backend,
          });
          const platformName = platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Instagram';
          allStats.push(formatStatsForTelegram(platformName, stats));
        } catch (err) {
          allStats.push(`❌ ${platform}: ${err.message}`);
        }
      }
      await notifyTelegram(settings, allStats.join('\n\n'));
    })();

    res.json({ started: true, platforms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI Chat endpoint (uses LM Studio locally instead of cloud AI) ---
app.post('/api/ai-chat', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    await refreshLMStudioConfigFromSettings(supabase);

    // Detect research / deep-dive intent on the latest user message and pre-fetch sources
    // so the LLM has real material to write a long-form, well-cited answer from.
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    const lastText = String(lastUser?.content || '');
    const wantsResearch = /\b(research|deep[- ]?dive|investigate|latest|news|find out|summari[sz]e|sources?|cite|report on|look up|what'?s happening|latest on)\b/i.test(lastText);

    let augmentedMessages = messages;
    if (wantsResearch && lastText.trim().length > 5) {
      try {
        const settingsRow = await supabase.from('app_settings').select('research_provider,research_api_key').eq('id', 1).single();
        const researchProvider = settingsRow.data?.research_provider || 'auto';
        const researchKey = settingsRow.data?.research_api_key || '';
        const sources = [];
        const seen = new Set();
        // 1) Brave first if configured
        if ((researchProvider === 'brave' || researchProvider === 'auto') && researchKey) {
          try {
            const br = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(lastText)}&count=6`, {
              headers: { 'X-Subscription-Token': researchKey, Accept: 'application/json' },
            });
            if (br.ok) {
              const bj = await br.json();
              (bj?.web?.results || []).slice(0, 6).forEach((x) => {
                if (x?.url && !seen.has(x.url)) { seen.add(x.url); sources.push({ title: x.title, url: x.url, snippet: x.description || '' }); }
              });
            }
          } catch {}
        }
        // 2) DuckDuckGo / browser fallback
        if (sources.length < 4) {
          const r = await fetch(`http://localhost:${PORT}/api/research/search`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: lastText, count: 6 }),
          });
          const data = await r.json().catch(() => ({}));
          (data.results || []).forEach((s) => { if (s?.url && !seen.has(s.url)) { seen.add(s.url); sources.push(s); } });
        }
        // 3) Deep-read top sources
        await Promise.all(sources.slice(0, 4).map(async (s) => {
          try {
            const r = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LovableAgent/1.0)' }, signal: AbortSignal.timeout(8000) });
            if (!r.ok) return;
            const html = await r.text();
            const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
            const article = cleaned.match(/<article[\s\S]*?<\/article>/i)?.[0] || cleaned.match(/<main[\s\S]*?<\/main>/i)?.[0] || cleaned;
            const text = article.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
            if (text.length > 200) s.content = text;
          } catch {}
        }));
        // 4) Try to grab a representative image
        let imageUrl = null;
        try {
          const ir = await fetch(`http://localhost:${PORT}/api/research/image-search`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: lastText, urls: sources.slice(0, 3).map((s) => s.url), count: 3 }),
          });
          const id = await ir.json().catch(() => ({}));
          const first = (id.images || [])[0];
          imageUrl = typeof first === 'string' ? first : first?.url || null;
        } catch {}

        const sourcesBlock = sources.slice(0, 8).map((s, i) =>
          `[${i + 1}] ${s.title}\n${s.content || s.snippet || ''}\nURL: ${s.url}`).join('\n\n');
        const researchSystem = `You are an expert research assistant. The user asked for a deep dive. Real-time research was just performed on their behalf. Write a thorough, human-written report in MARKDOWN:\n\n- Open with a 1-2 sentence TL;DR.\n- Then 3-6 sections with ## headings covering the most important angles.\n- Use flowing prose (NOT a list of headlines). Pull concrete facts, names, numbers from the sources.\n- Cite sources inline as [1], [2], etc. matching the numbered list.\n- End with a "## Sources" section listing each numbered source as a markdown link.\n${imageUrl ? `- Include this hero image near the top: ![cover](${imageUrl})` : ''}\n\nRESEARCH MATERIAL:\n${sourcesBlock || '(no sources retrieved — answer from general knowledge and say so)'}\n`;
        augmentedMessages = [
          { role: 'system', content: researchSystem },
          ...messages,
        ];
      } catch (e) {
        console.warn('[AI-Chat] Research augmentation failed:', e.message);
      }
    }

    // Stream response from LM Studio (or selected provider via streamLMStudio helper)
    const streamResp = await streamLMStudio(augmentedMessages, supabase);
    if (!streamResp.ok) {
      const errText = await streamResp.text().catch(() => '');
      console.error('[AI-Chat] LM Studio error:', streamResp.status, errText);
      return res.status(500).json({ error: 'AI service error. Make sure LM Studio is running.' });
    }

    // Pipe the SSE stream through to the client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (streamResp.body && typeof streamResp.body.pipe === 'function') {
      streamResp.body.pipe(res);
    } else if (streamResp.body && typeof streamResp.body.getReader === 'function') {
      // Web ReadableStream (e.g. from our local SSE wrapper) — pump to the Node response.
      const reader = streamResp.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } finally {
          res.end();
        }
      };
      pump();
    } else {
      const text = await streamResp.text();
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (err) {
    console.error('[AI-Chat] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// --- Scheduled uploads ---
async function processScheduledUploads() {
  const now = new Date().toISOString();
  const settings = await getSettings();
  const { data: dueUploads } = await supabase
    .from('scheduled_uploads')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true });

  if (!dueUploads || dueUploads.length === 0) return;
  console.log(`[Scheduler] ${dueUploads.length} scheduled upload(s) due`);

  for (const item of dueUploads) {
    try {
      await supabase.from('scheduled_uploads').update({ status: 'processing' }).eq('id', item.id);

      let videoFileName = item.video_file_name;
      let videoStoragePath = item.video_storage_path;
      let itemTitle = item.title;
      let itemDescription = item.description;
      let itemTags = item.tags;
      let folderPathForJob = null;

      // Handle folder-based entries
      if (isFolderUploadMarker(videoFileName)) {
        const folderPath = normalizeFolderPath(videoFileName);
        const intensityMin = parseFolderIntensity(videoFileName);
        const maxCount = parseFolderMaxCount(videoFileName);

        // If an intensity is set, fan out: scan ALL videos and schedule them spaced by intensity.
        if (intensityMin) {
          let allPairs = selectFolderPairsForUpload(folderPath, maxCount);
          if (allPairs.length === 0) {
            console.error(`[Scheduler] No videos found in folder: ${folderPath}`);
            await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
            await notifyTelegram(settings, `❌ Scheduled folder upload: no videos found in ${folderPath}`);
            continue;
          }

          const baseTime = new Date(item.scheduled_at).getTime();
          const fanoutRows = allPairs.map((pair, idx) => {
            const meta = buildFolderPairMetadata(folderPath, pair, item.title, item.description, item.tags);
            return {
              // Store the absolute path so the worker resolves it regardless of
              // the global default folder (handled by the path.isAbsolute branch).
              video_file_name: meta.videoFileName,
              video_storage_path: null,
              title: meta.title,
              description: meta.description,
              tags: meta.tags,
              target_platforms: item.target_platforms,
              account_id: item.account_id,
              scheduled_at: new Date(baseTime + idx * intensityMin * 60_000).toISOString(),
              status: 'scheduled',
            };
          });

          const { data: inserted, error: fanErr } = await supabase
            .from('scheduled_uploads')
            .insert(fanoutRows)
            .select();
          if (fanErr) {
            console.error('[Scheduler] Fan-out insert failed:', fanErr.message);
            await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
            continue;
          }

          // Copy account selections from the parent to each fan-out child
          const parentSelections = getScheduledAccountSelections(item.id);
          for (const child of inserted || []) {
            try { saveScheduledAccountSelections(child.id, parentSelections); } catch {}
          }

          await supabase.from('scheduled_uploads').update({ status: 'completed' }).eq('id', item.id);
          const limitNote = maxCount ? ` (last ${allPairs.length} of folder)` : '';
          await notifyTelegram(settings, `📅 Scheduled ${inserted?.length || 0} videos from ${folderPath}${limitNote}, every ${intensityMin}m starting ${new Date(baseTime).toLocaleString()}`);
          continue;
        }

        // No intensity → legacy behavior: pick the latest single video.
        const { videoFile, textFile } = scanFolder(folderPath);
        if (!videoFile) {
          console.error(`[Scheduler] No video found in folder: ${folderPath}`);
          await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
          await notifyTelegram(settings, `❌ Scheduled upload failed: no video found in folder ${folderPath}`);
          continue;
        }
        videoFileName = videoFile;
        folderPathForJob = folderPath;
        videoStoragePath = null;
        if (textFile) {
          const meta = parseTextFile(path.join(folderPath, textFile));
          if (!itemTitle || itemTitle === '(auto from folder)') itemTitle = meta.title || videoFile;
          if (!itemDescription) itemDescription = meta.description || '';
          if (!itemTags?.length) itemTags = meta.tags || [];
        }
      }

      const requestedPlatforms = Array.isArray(item.target_platforms) ? item.target_platforms : [];
      const scheduledSelections = getScheduledAccountSelections(item.id);
      const readyPlatforms = await getReadyPlatformsForSelections(settings, requestedPlatforms, scheduledSelections);
      const primaryAccountId = readyPlatforms.map((platform) => scheduledSelections[platform]).find(Boolean) || item.account_id || null;

      if (readyPlatforms.length === 0) {
        console.log('[Scheduler] No enabled platforms with credentials for scheduled upload');
        await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
        await notifyTelegram(settings, `⚠️ Scheduled upload skipped: no enabled platforms with credentials for ${itemTitle || item.video_file_name}`);
        continue;
      }

      const platformResults = readyPlatforms.map(name => ({ name, status: 'pending' }));
      const { data: job, error } = await supabase
        .from('upload_jobs')
        .insert({
          video_file_name: videoFileName,
          video_storage_path: videoStoragePath,
          title: itemTitle || videoFileName,
          description: itemDescription || '',
          tags: itemTags || [],
          target_platforms: readyPlatforms,
          account_id: primaryAccountId,
          status: 'pending',
          platform_results: platformResults,
        })
        .select()
        .single();

      if (error || !job) {
        console.error('[Scheduler] Failed to create job:', error);
        await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
        continue;
      }

      await supabase.from('scheduled_uploads').update({ upload_job_id: job.id }).eq('id', item.id);
      copyScheduledSelectionsToJob(item.id, job.id);
      await processJob(job.id, { folderPath: folderPathForJob });

      const { data: processedJob } = await supabase
        .from('upload_jobs')
        .select('status')
        .eq('id', job.id)
        .single();

      const scheduledStatus = processedJob?.status === 'completed' ? 'completed' : 'error';
      await supabase.from('scheduled_uploads').update({ status: scheduledStatus }).eq('id', item.id);
    } catch (err) {
      console.error('[Scheduler] Error:', err.message);
      await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
    }
  }
}

// --- Recurring schedule: process ALL schedule configs ---

function generateMetadataFromFilename(filename) {
  // Strip extension
  let name = filename.replace(/\.[^.]+$/, '');
  // Remove common prefixes like dates, numbers
  name = name.replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_]?/, '');
  name = name.replace(/^\d+[-_\s]?/, '');
  // Replace separators with spaces
  const title = name.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Generate tags from words
  const words = title.toLowerCase().split(' ').filter(w => w.length > 2);
  const tags = [...new Set(words)].slice(0, 10).map(w => `#${w}`);
  // Generate description
  const description = `${title}\n\n${tags.join(' ')}\n\n#video #content`;
  return { title: title || filename, description, tags };
}

async function processRecurringSchedule(opts = {}) {
  const { onlyConfigId = null, force = false } = opts;
  try {
    let configs;
    if (onlyConfigId) {
      const { data } = await supabase.from('schedule_config').select('*').eq('id', onlyConfigId);
      configs = data || [];
    } else {
      const { data } = await supabase.from('schedule_config').select('*').eq('enabled', true);
      configs = data || [];
    }
    if (!configs || configs.length === 0) return { ran: 0 };
    const settings = await getSettings();
    const now = new Date();
    const currentMinute = now.getMinutes();
    const currentHour = now.getHours();
    const currentDow = now.getDay();

    for (const config of configs) {
      try {
        // Check end_at expiry
        if (config.end_at && new Date(config.end_at) < now) {
          console.log(`[Recurring] Schedule ${config.id} expired, disabling`);
          await supabase.from('schedule_config').update({ enabled: false }).eq('id', config.id);
          continue;
        }

        // Check max_runs cap
        if (config.max_runs && (config.run_count || 0) >= config.max_runs) {
          console.log(`[Recurring] Schedule ${config.id} reached max_runs (${config.max_runs}), disabling`);
          await supabase.from('schedule_config').update({ enabled: false }).eq('id', config.id);
          await notifyTelegram(settings, `🏁 Schedule "${config.name}" finished after ${config.run_count} runs (limit reached).`);
          continue;
        }

        const folderPath = normalizeFolderPath(config.folder_path);
        if (!folderPath) continue;

        // Parse cron to check if NOW matches (with a 1-minute grace window so schedules
        // saved a few seconds after their target minute still fire within ~90s).
        const [cronMin, cronHr, , , cronDow] = config.cron_expression.split(' ');
        const prevMinute = (currentMinute + 59) % 60;
        const minuteMatch = cronMin === '*'
          || parseInt(cronMin) === currentMinute
          || parseInt(cronMin) === prevMinute;
        const hourMatch = cronHr === '*'
          || (cronHr.startsWith('*/') ? currentHour % parseInt(cronHr.replace('*/', '')) === 0 : parseInt(cronHr) === currentHour);
        const dowMatch = cronDow === '*' || cronDow.split(',').map(Number).includes(currentDow);

        if (!force && (!minuteMatch || !hourMatch || !dowMatch)) continue;

        // Prevent running multiple times in the same minute window — persisted in DB
        const nowMinuteStart = new Date(now);
        nowMinuteStart.setSeconds(0, 0);
        if (!force && config.last_run_at) {
          const lastRun = new Date(config.last_run_at);
          // If last run was within the last 90 seconds, skip (already ran for this trigger)
          if (nowMinuteStart.getTime() - lastRun.getTime() < 90_000) continue;
        }

        // Persist last_run_at + increment run_count immediately to prevent duplicate runs on restart
        const newRunCount = (config.run_count || 0) + 1;
        await supabase.from('schedule_config').update({
          last_run_at: now.toISOString(),
          run_count: newRunCount,
        }).eq('id', config.id);

        console.log(`[Recurring] Schedule ${config.id} (${config.name}) matched at ${now.toISOString()}, run #${newRunCount}, scanning: ${folderPath}`);

        // Scan ALL files in folder, matched by name
        let allPairs = scanAllFiles(folderPath);
        if (allPairs.length === 0) {
          console.log(`[Recurring] No videos found in ${folderPath}`);
          await notifyTelegram(settings, `⚠️ Schedule "${config.name}": no videos found in ${folderPath}`);
          continue;
        }

        // Apply per-run max_videos cap (last N highest-numbered, kept in ascending order).
        const maxVideos = Number.isFinite(config.max_videos) && config.max_videos > 0 ? config.max_videos : null;
        if (maxVideos && allPairs.length > maxVideos) {
          allPairs = allPairs.slice(-maxVideos);
        }

        const requestedPlatforms = Array.isArray(config.platforms) && config.platforms.length
          ? config.platforms
          : ['youtube', 'tiktok', 'instagram'];
        const accountSelections = (config.account_selections && typeof config.account_selections === 'object')
          ? config.account_selections
          : {};
        const platforms = await getReadyPlatformsForSelections(settings, requestedPlatforms, accountSelections);
        const primaryAccountId = platforms.map((p) => accountSelections[p]).find(Boolean) || null;

        if (platforms.length === 0) {
          console.log(`[Recurring] Schedule "${config.name}": no enabled platforms with credentials`);
          await notifyTelegram(settings, `⚠️ Schedule "${config.name}" skipped: no enabled platforms with credentials`);
          continue;
        }

        const intervalMinutes = config.upload_interval_minutes || 60;
        console.log(`[Recurring] Found ${allPairs.length} videos, uploading with ${intervalMinutes}min interval`);

        // Process first video immediately, schedule rest with intensity spacing
        for (let i = 0; i < allPairs.length; i++) {
          const pair = allPairs[i];
          let title, description, tags;

          if (pair.textFile) {
            const meta = parseTextFile(path.join(folderPath, pair.textFile));
            title = meta.title || pair.videoFile;
            description = meta.description || '';
            tags = meta.tags?.length ? meta.tags : [];
          }

          // Auto-generate metadata from filename if no .txt or empty metadata
          if (!title || !description || !tags?.length) {
            const generated = generateMetadataFromFilename(pair.videoFile);
            if (!title) title = generated.title;
            if (!description) description = generated.description;
            if (!tags?.length) tags = generated.tags;
          }

          const platformResults = platforms.map(name => ({ name, status: 'pending' }));

          if (i === 0) {
            // First video: create job and process immediately
            const videoFileName = path.resolve(path.join(folderPath, pair.videoFile));
            const { data: job, error } = await supabase
              .from('upload_jobs')
              .insert({
                video_file_name: videoFileName,
                video_storage_path: null,
                title, description, tags,
                target_platforms: platforms,
                account_id: primaryAccountId,
                status: 'pending',
                platform_results: platformResults,
              })
              .select()
              .single();

            if (error || !job) {
              console.error(`[Recurring] Failed to create job for ${pair.videoFile}:`, error);
              continue;
            }

            try { saveJobAccountSelections(job.id, accountSelections); } catch {}
            console.log(`[Recurring] Created immediate job ${job.id} for ${pair.videoFile}`);
            await processJob(job.id, { folderPath });
          } else {
            // Subsequent videos: create scheduled uploads with spacing
            const scheduledAt = new Date(now.getTime() + i * intervalMinutes * 60_000).toISOString();
            const videoFileName = path.resolve(path.join(folderPath, pair.videoFile));
            const { data: schedRow, error } = await supabase
              .from('scheduled_uploads')
              .insert({
                video_file_name: videoFileName,
                video_storage_path: null,
                title, description, tags,
                target_platforms: platforms,
                account_id: primaryAccountId,
                scheduled_at: scheduledAt,
                status: 'scheduled',
              })
              .select()
              .single();

            if (error) {
              console.error(`[Recurring] Failed to schedule ${pair.videoFile}:`, error);
            } else {
              try { saveScheduledAccountSelections(schedRow.id, accountSelections); } catch {}
              console.log(`[Recurring] Scheduled ${pair.videoFile} for ${scheduledAt}`);
            }
          }
        }

        const tail = config.max_runs ? ` (run ${newRunCount}/${config.max_runs})` : '';
        await notifyTelegram(settings, `📋 Schedule "${config.name}"${tail}: ${allPairs.length} video(s) queued (1 now, ${allPairs.length - 1} scheduled every ${intervalMinutes}min)`);
      } catch (e) {
        console.error(`[Recurring] Error processing schedule ${config.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Recurring] Error:', e.message);
  }
}

// --- Recurring social-post folder schedules ---
// At each cron tick, finds enabled social_post_schedules with source_type='folder'
// whose cron expression matches now. For each, scans the configured folder, picks
// up to posts_per_run unprocessed bundles (tracked in imported_files), uploads
// the images to Supabase storage, and creates social_posts rows so the existing
// social-post poller publishes them immediately.
async function processSocialFolderSchedules(opts = {}) {
  const { onlyId = null, force = false } = opts;
  try {
    let query = supabase.from('social_post_schedules').select('*').eq('source_type', 'folder');
    if (onlyId) query = query.eq('id', onlyId); else query = query.eq('enabled', true);
    const { data: schedules } = await query;
    if (!schedules || !schedules.length) return;

    const now = new Date();
    const currentMinute = now.getMinutes();
    const currentHour = now.getHours();
    const currentDow = now.getDay();

    for (const sched of schedules) {
      try {
        if (sched.end_at && new Date(sched.end_at) < now) {
          await supabase.from('social_post_schedules').update({ enabled: false }).eq('id', sched.id);
          continue;
        }
        if (!force) {
          const [cMin, cHr, , , cDow] = String(sched.cron_expression || '0 9 * * *').split(' ');
          const prevMin = (currentMinute + 59) % 60;
          const minMatch = cMin === '*' || parseInt(cMin) === currentMinute || parseInt(cMin) === prevMin;
          const hrMatch = cHr === '*'
            || (cHr.startsWith('*/') ? currentHour % parseInt(cHr.replace('*/', '')) === 0 : parseInt(cHr) === currentHour);
          const dowMatch = cDow === '*' || cDow.split(',').map(Number).includes(currentDow);
          if (!minMatch || !hrMatch || !dowMatch) continue;
          if (sched.last_run_at) {
            const last = new Date(sched.last_run_at);
            if (now.getTime() - last.getTime() < 90_000) continue;
          }
        }

        const folderPath = String(sched.folder_path || '').trim();
        if (!folderPath) {
          console.log(`[FolderSched] Schedule ${sched.id} has no folder_path, skipping`);
          continue;
        }

        let bundles = [];
        try { bundles = scanLocalBundles(folderPath); }
        catch (e) {
          console.error(`[FolderSched] Scan failed: ${e.message}`);
          continue;
        }

        const already = new Set(sched.imported_files || []);
        const ready = bundles.filter((b) => !already.has(b.manifestName)
          && b.images.length > 0 && b.images.every((i) => !i.missing));
        const perRun = Math.max(1, Number(sched.posts_per_run) || 1);
        const pick = ready.slice(0, perRun);

        // Stamp last_run_at + run_count immediately so a restart doesn't re-fire.
        await supabase.from('social_post_schedules').update({
          last_run_at: now.toISOString(),
          run_count: (Number(sched.run_count) || 0) + 1,
        }).eq('id', sched.id);

        if (pick.length === 0) {
          console.log(`[FolderSched] "${sched.name}": nothing new in ${folderPath}`);
          continue;
        }

        const requestedPlatforms = Array.isArray(sched.target_platforms) && sched.target_platforms.length
          ? sched.target_platforms
          : ['x', 'linkedin', 'facebook'];
        const accountSelections = (sched.account_selections && typeof sched.account_selections === 'object')
          ? sched.account_selections
          : {};

        const newlyImported = [];
        for (const bundle of pick) {
          try {
            const paths = await uploadBundleImagesToStorage(bundle);
            const platforms = bundle.platforms.length ? bundle.platforms : requestedPlatforms;
            const variants = {};
            for (const p of platforms) if (bundle.texts[p]) variants[p] = { description: bundle.texts[p], hashtags: [] };
            const description = bundle.texts[platforms[0]] || bundle.texts.x || bundle.texts.linkedin || '';

            await supabase.from('social_posts').insert({
              description,
              image_path: paths[0] || null,
              image_paths: paths,
              hashtags: [],
              target_platforms: platforms,
              account_selections: accountSelections,
              platform_variants: variants,
              status: 'pending',
              scheduled_at: null,
            });
            newlyImported.push(bundle.manifestName);
            console.log(`[FolderSched] Queued post from ${bundle.manifestName}`);
          } catch (e) {
            console.error(`[FolderSched] Failed to queue ${bundle.manifestName}:`, e.message);
          }
        }

        if (newlyImported.length) {
          const merged = Array.from(new Set([...(sched.imported_files || []), ...newlyImported])).slice(-2000);
          await supabase.from('social_post_schedules').update({ imported_files: merged }).eq('id', sched.id);
        }
      } catch (e) {
        console.error(`[FolderSched] Schedule ${sched.id} error:`, e.message);
      }
    }
  } catch (e) {
    console.error('[FolderSched] Error:', e.message);
  }
}


async function fixStaleJobs() {
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: staleJobs } = await supabase
    .from('upload_jobs')
    .select('*')
    .eq('status', 'uploading')
    .lt('created_at', staleThreshold);

  if (!staleJobs?.length) return;
  for (const stale of staleJobs) {
    if (processingJobs.has(stale.id)) continue;
    const pr = stale.platform_results || [];
    let changed = false;
    for (const p of pr) {
      if (p.status === 'uploading') { p.status = 'error'; p.error = 'Timed out'; changed = true; }
    }
    if (changed) {
      const finalStatus = pr.every(p => p.status === 'success') ? 'completed' : pr.some(p => p.status === 'success') ? 'partial' : 'failed';
      await supabase.from('upload_jobs').update({
        platform_results: pr, status: finalStatus, completed_at: new Date().toISOString(),
      }).eq('id', stale.id);
    }
  }
}

// --- Pending commands (from Telegram bot via Supabase) ---
const runningCommands = new Set();

async function processPendingCommands() {
  try {
    const { data: commands } = await supabase
      .from('pending_commands')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(5);

    for (const cmd of (commands || [])) {
      if (runningCommands.has(cmd.id)) continue;
      runningCommands.add(cmd.id);

      // Mark as processing immediately
      await supabase.from('pending_commands').update({ status: 'processing' }).eq('id', cmd.id);

      // Execute asynchronously so cron is not blocked
      (async () => {
        try {
          if (cmd.command === 'check_stats') {
            const platform = cmd.args?.platform || 'all';
            const settings = await getSettings();
            const platforms = platform === 'all'
              ? ['youtube', 'tiktok', 'instagram'].filter(p => settings[p]?.enabled && settings[p]?.email)
              : [platform];

            if (platforms.length === 0) {
              await notifyTelegram(settings, `⚠️ No configured platforms found for stats check.`);
              await supabase.from('pending_commands').update({
                status: 'failed', result: 'No configured platforms', completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              return;
            }

            const allStats = [];
            for (const p of platforms) {
              try {
                const stats = await checkPlatformStats(p, {
                  ...settings[p],
                  telegram: settings.telegram,
                  backend: settings.backend,
                });
                const pName = p === 'youtube' ? 'YouTube' : p === 'tiktok' ? 'TikTok' : 'Instagram';
                if (!stats || stats.length === 0) {
                  allStats.push(`📊 ${pName}: No videos found. The browser opened and checked your ${pName} account but found no recent videos/stats yet. Try again after uploading some content.`);
                } else {
                  allStats.push(formatStatsForTelegram(pName, stats));
                }
              } catch (err) {
                const pName = p === 'youtube' ? 'YouTube' : p === 'tiktok' ? 'TikTok' : 'Instagram';
                allStats.push(`❌ ${pName} stats check failed: ${err.message}\n\nMake sure you have logged into ${pName} at least once by uploading a video first (this saves the browser session). Then try again.`);
              }
            }

            await notifyTelegram(settings, allStats.join('\n\n'));
            await supabase.from('pending_commands').update({
              status: 'completed', result: 'sent', completed_at: new Date().toISOString(),
            }).eq('id', cmd.id);
          } else if (cmd.command === 'ai_response') {
            // Process Telegram AI response locally via LM Studio
            const settings = await getSettings();
            console.log(`[Commands] ai_response: processing Telegram message from chat ${cmd.args?.chat_id}`);
            if (cmd.args?.chat_id) {
              settings.telegram.chatId = String(cmd.args.chat_id);
            }
            await processTelegramAIResponse(
              supabase,
              cmd.args,
              (_botToken, chatId, message) => sendTelegram(settings.telegram.botToken, chatId, message, null),
              null,
            );
            await supabase.from('pending_commands').update({
              status: 'completed', result: 'ai_reply_sent', completed_at: new Date().toISOString(),
            }).eq('id', cmd.id);
          } else if (cmd.command === 'open_browser') {
            const task = cmd.args?.task || 'Open the browser and navigate to Google';
            const startUrl = cmd.args?.url || null;
            const silent = cmd.args?.silent === true;
            const settings = await getSettings();

            console.log(`[Commands] open_browser: task="${task}"${startUrl ? `, url="${startUrl}"` : ''}`);
            const browserResult = await runBrowserTask(task, startUrl);
            const { summary } = browserResult;
            if (!silent) await notifyTelegram(settings, summary);
            await supabase.from('pending_commands').update({
              status: 'completed', result: JSON.stringify(browserResult), completed_at: new Date().toISOString(),
            }).eq('id', cmd.id);
          } else if (cmd.command === 'image_search') {
            const query = cmd.args?.query || '';
            const count = Number(cmd.args?.count) || 5;
            const urls = Array.isArray(cmd.args?.urls) ? cmd.args.urls.filter(Boolean) : [];
            console.log(`[Commands] image_search: "${query}" (count=${count}, urls=${urls.length})`);
            try {
              const r = await fetch(`http://localhost:${PORT}/api/research/image-search`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, count, urls }),
              });
              const data = await r.json().catch(() => ({}));
              await supabase.from('pending_commands').update({
                status: 'completed',
                result: JSON.stringify({ provider: data.provider || 'none', images: data.images || [] }),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              console.log(`[Commands] image_search done: ${(data.images || []).length} images via ${data.provider || 'none'}`);
            } catch (err) {
              await supabase.from('pending_commands').update({
                status: 'failed', result: err.message, completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
            }
          } else if (cmd.command === 'research_search') {
            // Cloud agent asked us to scrape DuckDuckGo/Google with the local browser.
            const query = cmd.args?.query || '';
            const count = Number(cmd.args?.count) || 6;
            console.log(`[Commands] research_search: "${query}" (count=${count})`);
            try {
              // Reuse the same logic as the /api/research/search endpoint by calling it via HTTP loopback.
              const r = await fetch(`http://localhost:${PORT}/api/research/search`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, count }),
              });
              const data = await r.json().catch(() => ({}));
              await supabase.from('pending_commands').update({
                status: 'completed',
                result: JSON.stringify({ provider: data.provider || 'none', results: data.results || [] }),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              console.log(`[Commands] research_search done: ${(data.results || []).length} results via ${data.provider || 'none'}`);
            } catch (err) {
              await supabase.from('pending_commands').update({
                status: 'failed', result: err.message, completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
            }
          } else if (cmd.command === 'browser_research') {
            // Deterministic local browser research: fetch sources, open the local browser,
            // capture screenshots + page text, optionally send screenshots to Telegram,
            // and persist a structured result for the Job Queue UI to render as openable links.
            try {
              const { runBrowserResearch } = require('./browserResearch');
              const settings = await getSettings();
              const { sendTelegramPhoto } = require('./telegram');
              const result = await runBrowserResearch(cmd.args || {}, {
                settings,
                sendTelegram: notifyTelegram,
                sendTelegramPhoto,
              });
              const screenshotLinks = (result.screenshots || []).map((s) => ({
                kind: 'screenshot',
                label: `📸 ${s.label || 'Screenshot'}`,
                url: `${settings.local_agent_url || 'http://localhost:3001'}/api/browser-research/screenshot/${encodeURIComponent(s.file)}`,
              }));
              const persisted = {
                provider: 'local-browser',
                summary: result.summary,
                query: result.query,
                sources: result.sources,
                captures: result.captures,
                links: [...(result.links || []), ...screenshotLinks],
              };
              await supabase.from('pending_commands').update({
                status: result.ok ? 'completed' : 'failed',
                result: JSON.stringify(persisted),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              const tgSummary = `🔎 Research done: "${result.query}"\n${result.summary}\n\n` +
                (result.sources || []).slice(0, 5).map((s, i) => `${i + 1}. ${s.title}\n${s.url}`).join('\n');
              await notifyTelegram(settings, tgSummary);
              console.log(`[Commands] browser_research done: ${(result.sources || []).length} sources, ${(result.screenshots || []).length} screenshots`);
            } catch (err) {
              await supabase.from('pending_commands').update({
                status: 'failed', result: JSON.stringify({ ok: false, error: err.message }),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
            }
          } else if (cmd.command && cmd.command.startsWith('agent_')) {
            // Agent workspace tools (write_file, read_file, list_files, run_shell, open_in_browser, serve_preview)
            try {
              const { handleAgentCommand } = require('./agentWorkspace');
              const result = await handleAgentCommand(cmd.command, cmd.args || {});
              await supabase.from('pending_commands').update({
                status: result && result.ok === false ? 'failed' : 'completed',
                result: JSON.stringify(result),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              console.log(`[Commands] ${cmd.command} → ${result && result.ok === false ? 'failed' : 'ok'}`);
            } catch (err) {
              await supabase.from('pending_commands').update({
                status: 'failed', result: JSON.stringify({ ok: false, error: err.message }),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
            }
          } else {
            await supabase.from('pending_commands').update({
              status: 'failed', result: `Unknown command: ${cmd.command}`, completed_at: new Date().toISOString(),
            }).eq('id', cmd.id);
          }
        } catch (err) {
          console.error(`[Commands] Command ${cmd.id} failed:`, err.message);
          const settingsForError = await getSettings().catch(() => null);
          if (settingsForError) {
            const isStats = cmd.command === 'check_stats';
            const errMsg = isStats
              ? `❌ Stats check failed: ${err.message}\n\nThis usually means:\n1. The browser could not open (Playwright not installed?)\n2. The platform session needs login — upload a video first to save the session\n3. The platform website changed its layout\n\nTip: Make sure smart-launcher.bat is running and you have uploaded at least one video to the platform.`
              : `❌ Browser task failed: ${err.message}\n\nTip: Make sure smart-launcher.bat is running and Playwright is installed (run install-browsers.bat).`;
            await notifyTelegram(settingsForError, errMsg);
          }
          await supabase.from('pending_commands').update({
            status: 'failed', result: err.message, completed_at: new Date().toISOString(),
          }).eq('id', cmd.id).catch(() => {});
        } finally {
          runningCommands.delete(cmd.id);
        }
      })();
    }
  } catch (e) {
    console.error('[Commands] Poll error:', e.message);
  }
}

// --- Folder watcher: auto-detect new video+txt pairs and queue them as upload_jobs ---
const FOLDER_WATCH_STATE_PATH = path.join(__dirname, 'data', 'folder-watch-state.json');
const folderWatchState = { queued: new Set(), sizes: {} };
try {
  if (fs.existsSync(FOLDER_WATCH_STATE_PATH)) {
    const raw = JSON.parse(fs.readFileSync(FOLDER_WATCH_STATE_PATH, 'utf8'));
    folderWatchState.queued = new Set(Array.isArray(raw.queued) ? raw.queued : []);
    folderWatchState.sizes = raw.sizes && typeof raw.sizes === 'object' ? raw.sizes : {};
  }
} catch (e) { console.error('[FolderWatch] State load failed:', e.message); }
function persistFolderWatchState() {
  try {
    fs.mkdirSync(path.dirname(FOLDER_WATCH_STATE_PATH), { recursive: true });
    fs.writeFileSync(FOLDER_WATCH_STATE_PATH, JSON.stringify({
      queued: Array.from(folderWatchState.queued),
      sizes: folderWatchState.sizes,
    }));
  } catch (e) { console.error('[FolderWatch] State save failed:', e.message); }
}

async function pollFolderWatchers() {
  let settings;
  try { settings = await getSettings(); } catch { return; }

  // Collect every folder we should watch, with a "source" descriptor for defaults.
  const folders = new Map(); // absPath -> { platforms, accountSelections, intensity }
  const addFolder = (raw, platforms, accountSelections, intensity) => {
    const norm = normalizeFolderPath(raw);
    if (!norm || !fs.existsSync(norm)) return;
    const abs = path.resolve(norm);
    if (!folders.has(abs)) folders.set(abs, { platforms, accountSelections, intensity });
  };

  // 1. Global default folder
  if (settings.folderPath) {
    const defaultPlatforms = ['youtube', 'tiktok', 'instagram'].filter((p) => settings[p]?.enabled && settings[p]?.email);
    if (defaultPlatforms.length) addFolder(settings.folderPath, defaultPlatforms, {}, 0);
  }

  // 2. Enabled recurring schedules
  try {
    const { data: schedules } = await supabase.from('schedule_config').select('*').eq('enabled', true);
    for (const s of schedules || []) {
      addFolder(s.folder_path, Array.isArray(s.platforms) && s.platforms.length ? s.platforms : ['youtube','tiktok','instagram'], s.account_selections || {}, s.upload_interval_minutes || 0);
    }
  } catch (e) { console.error('[FolderWatch] schedules read failed:', e.message); }

  // NOTE: We intentionally do NOT add folders from pending one-shot campaigns
  // (scheduled_uploads with [folder|N] markers). Those campaigns fan themselves
  // out into individual scheduled rows when their scheduled_at fires. Watching
  // their folders here would race the fan-out: the watcher would queue the same
  // videos as plain folder-watch upload_jobs (often with empty platform/account
  // selections), producing duplicate "New file detected" notifications followed
  // by spurious "Upload Failed" messages once credentials don't resolve. The
  // global default folder (#1) and enabled recurring schedules (#2) are still
  // watched, which covers all true "drop new files in and auto-upload" cases.

  if (folders.size === 0) return;

  let dirty = false;

  for (const [absFolder, cfg] of folders) {
    const ready = getReadyPairs(absFolder, folderWatchState.queued, folderWatchState.sizes);
    dirty = true; // sizes were updated
    if (ready.length === 0) continue;

    // Filter platforms to enabled-with-credentials ones
    const readyPlatforms = await getReadyPlatformsForSelections(settings, cfg.platforms || [], cfg.accountSelections || {});
    if (readyPlatforms.length === 0) {
      console.log(`[FolderWatch] ${absFolder}: skipping ${ready.length} new pair(s) — no ready platforms`);
      continue;
    }

    for (const pair of ready) {
      try {
        // Queue the detected pair itself. Do not use a generic [folder] marker here:
        // that would make the worker rescan the folder and pick the latest file,
        // which can reverse numbered episodes or duplicate the wrong video.
        const meta = parseTextFile(pair.textAbs);
        const { data: insJob, error: insErr } = await supabase.from('upload_jobs').insert({
          video_file_name: pair.videoAbs,
          video_storage_path: null,
          title: meta.title || pair.videoFile,
          description: meta.description || '',
          tags: meta.tags || [],
          target_platforms: readyPlatforms,
          account_id: readyPlatforms.map((p) => cfg.accountSelections?.[p]).find(Boolean) || null,
          status: 'pending',
          platform_results: readyPlatforms.map((name) => ({ name, status: 'pending' })),
        }).select().single();

        if (insErr) {
          console.error(`[FolderWatch] Failed to queue ${pair.videoAbs}:`, insErr.message);
          continue;
        }
        if (insJob && cfg.accountSelections && Object.keys(cfg.accountSelections).length) {
          try { saveJobAccountSelections(insJob.id, cfg.accountSelections); } catch {}
        }

        folderWatchState.queued.add(pair.videoAbs);
        dirty = true;
        console.log(`[FolderWatch] Queued new pair: ${pair.videoFile} (+ ${pair.textFile}) → job ${insJob?.id}`);
        await notifyTelegram(settings, `📥 New file detected: ${pair.videoFile}\nQueued for upload to ${readyPlatforms.join(', ')}`);
      } catch (e) {
        console.error(`[FolderWatch] Queue error for ${pair.videoAbs}:`, e.message);
      }
    }
  }

  if (dirty) persistFolderWatchState();
}

// --- Cron: poll every minute for uploads, every 15s for commands ---
let cronJob = null;
let commandPollInterval = null;
let uploadPollInterval = null;
let socialPollInterval = null;
let folderWatchInterval = null;
function setupCron() {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  if (commandPollInterval) { clearInterval(commandPollInterval); commandPollInterval = null; }
  if (uploadPollInterval) { clearInterval(uploadPollInterval); uploadPollInterval = null; }
  if (socialPollInterval) { clearInterval(socialPollInterval); socialPollInterval = null; }
  if (folderWatchInterval) { clearInterval(folderWatchInterval); folderWatchInterval = null; }

  // Folder watcher: auto-detect new video+txt pairs every 15s
  folderWatchInterval = setInterval(() => {
    pollFolderWatchers().catch((e) => console.error('[FolderWatch] Poll error:', e.message));
  }, 15000);

  // Fast poll: check pending uploads every 5 seconds for near-immediate browser start.
  uploadPollInterval = setInterval(async () => {
    try { await triggerPendingUploadProcessing(5); } catch (e) { console.error('[Uploads] Poll error:', e.message); }
  }, 5000);

  // Fast poll: check pending_commands every 3 seconds for responsive bot + research
  commandPollInterval = setInterval(async () => {
    try { await processPendingCommands(); } catch (e) { console.error('[Commands] Poll error:', e.message); }
  }, 3000);

  // Kick once immediately on startup/reload so new jobs don't wait for first interval tick.
  triggerPendingUploadProcessing(5).catch((e) => console.error('[Uploads] Initial trigger failed:', e.message));

  // Fast poll: due social posts every 10s
  socialPollInterval = setInterval(async () => {
    try {
      await pollDueSocialPosts(supabase, async (msg) => {
        const settings = await getSettings().catch(() => null);
        if (settings) await notifyTelegram(settings, msg);
      });
    } catch (e) { console.error('[SocialPosts] Poll error:', e.message); }
  }, 10000);

  cronJob = cron.schedule('* * * * *', async () => {
    try {
      await fixStaleJobs();
      await processScheduledUploads();
      await processRecurringSchedule();
      await processSocialFolderSchedules();
    } catch (e) {
      console.error('[Cron] Error:', e.message);
    }
  });
  console.log('[Cron] Active: uploads every 5s, social posts every 10s, schedules every minute, commands every 15s');
}

app.post('/api/refresh-cron', (req, res) => {
  setupCron();
  res.json({ ok: true });
});

app.post('/api/recurring/run-now', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    // Fire-and-forget; respond fast so UI is snappy
    processRecurringSchedule({ onlyConfigId: id, force: true })
      .catch((e) => console.error('[Recurring] run-now error:', e.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a folder-based social post schedule immediately, regardless of cron.
app.post('/api/social-folder-schedules/run-now', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    processSocialFolderSchedules({ onlyId: id, force: true })
      .catch((e) => console.error('[FolderSched] run-now error:', e.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generation-schedules/run-now', async (req, res) => {
  try {
    const { scheduleId } = req.body || {};
    const { data: schedule, error } = await supabase.from('social_post_schedules').select('*').eq('id', scheduleId).single();
    if (error || !schedule) return res.status(404).json({ error: 'Schedule not found' });
    const result = await fetch(`http://localhost:${PORT}/api/generate-social-post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: schedule.ai_prompt,
        platforms: schedule.target_platforms || ['x', 'linkedin', 'facebook'],
        includeImage: schedule.include_image !== false,
        stream: false,
      }),
    });
    const data = await result.json().catch(() => ({}));
    if (!result.ok || data?.error) return res.status(500).json({ error: data?.error || 'Local generation failed' });
    await supabase.from('social_post_schedules').update({ last_run_at: new Date().toISOString(), run_count: (Number(schedule.run_count) || 0) + 1 }).eq('id', scheduleId);
    res.json({ ok: true, result: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Start ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Auto Vid Post — Local Server`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Connected to backend: ${SUPABASE_URL}`);
  console.log(`   AI: LM Studio at ${LM_STUDIO_URL}`);
  console.log(`   Mode: Local Playwright automation + Local AI\n`);
  setupCron();
});
