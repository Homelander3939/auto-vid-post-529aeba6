// Storage layer — uses Supabase for persistence.
// Works in Lovable preview (online) and locally when pulled from GitHub.

import { supabase } from '@/integrations/supabase/client';

export interface PlatformAccount {
  id: string;
  platform: string;
  label: string;
  email: string;
  password: string;
  enabled: boolean;
  is_default: boolean;
  created_at: string;
  recovery_phone?: string | null;
}

export interface AppSettings {
  folderPath: string;
  uploadMode: 'local' | 'cloud';
  deleteAfterUpload: boolean;
  youtube: { email: string; password: string; enabled: boolean };
  tiktok: { email: string; password: string; enabled: boolean };
  instagram: { email: string; password: string; enabled: boolean };
  telegram: { botToken: string; chatId: string; enabled: boolean };
}

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  platforms: string[];
}

export interface PlatformResult {
  name: string;
  status: 'pending' | 'uploading' | 'success' | 'error';
  url?: string;
  error?: string;
  recentStats?: Array<{
    title: string;
    views: string;
    likes: string;
    comments: string;
    url?: string;
  }>;
}

export interface UploadJob {
  id: string;
  video_file_name: string;
  video_storage_path: string | null;
  title: string;
  description: string;
  tags: string[];
  target_platforms: string[];
  status: string;
  platform_results: PlatformResult[];
  created_at: string;
  completed_at: string | null;
}

export interface ScheduleConfig {
  id?: number;
  name: string;
  enabled: boolean;
  cronExpression: string;
  platforms: string[];
  folderPath: string;
  endAt: string | null;
  uploadIntervalMinutes: number;
  /** Optional cap: only the last N (highest-numbered) videos in the folder are uploaded per run. */
  maxVideos?: number | null;
  accountSelections?: Record<string, string>;
  runCount?: number;
  maxRuns?: number | null;
  lastRunAt?: string | null;
}

export interface ScheduledUpload {
  id: string;
  video_file_name: string;
  video_storage_path: string | null;
  title: string;
  description: string;
  tags: string[];
  target_platforms: string[];
  scheduled_at: string;
  status: string;
  upload_job_id: string | null;
  created_at: string;
}

const defaultSettings: AppSettings = {
  folderPath: '',
  uploadMode: 'local',
  deleteAfterUpload: true,
  youtube: { email: '', password: '', enabled: false },
  tiktok: { email: '', password: '', enabled: false },
  instagram: { email: '', password: '', enabled: false },
  telegram: { botToken: '', chatId: '', enabled: false },
};

// --- Settings ---
export async function getSettings(): Promise<AppSettings> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !data) return defaultSettings;

  return {
    folderPath: data.folder_path,
    uploadMode: (data as any).upload_mode || 'local',
    deleteAfterUpload: (data as any).delete_after_upload !== false,
    youtube: { email: data.youtube_email, password: data.youtube_password, enabled: data.youtube_enabled },
    tiktok: { email: data.tiktok_email, password: data.tiktok_password, enabled: data.tiktok_enabled },
    instagram: { email: data.instagram_email, password: data.instagram_password, enabled: data.instagram_enabled },
    telegram: { botToken: data.telegram_bot_token, chatId: data.telegram_chat_id, enabled: data.telegram_enabled },
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const { error } = await supabase
    .from('app_settings')
    .update({
      folder_path: settings.folderPath,
      upload_mode: settings.uploadMode,
      delete_after_upload: settings.deleteAfterUpload,
      youtube_email: settings.youtube.email,
      youtube_password: settings.youtube.password,
      youtube_enabled: settings.youtube.enabled,
      tiktok_email: settings.tiktok.email,
      tiktok_password: settings.tiktok.password,
      tiktok_enabled: settings.tiktok.enabled,
      instagram_email: settings.instagram.email,
      instagram_password: settings.instagram.password,
      instagram_enabled: settings.instagram.enabled,
      telegram_bot_token: settings.telegram.botToken,
      telegram_chat_id: settings.telegram.chatId.trim(),
      telegram_enabled: settings.telegram.enabled,
    } as any)
    .eq('id', 1);

  if (error) {
    throw new Error(error.message || 'Failed to save settings');
  }
}

// --- Platform Accounts ---
export async function getPlatformAccounts(): Promise<PlatformAccount[]> {
  const { data, error } = await supabase
    .from('platform_accounts')
    .select('*')
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  return data as unknown as PlatformAccount[];
}

export async function savePlatformAccount(account: Partial<PlatformAccount> & { platform: string }): Promise<PlatformAccount> {
  if (account.id) {
    const { id, ...rest } = account;
    const { data, error } = await supabase.from('platform_accounts').update(rest as any).eq('id', id).select().single();
    if (error || !data) throw new Error(error?.message || 'Failed to update account');
    return data as unknown as PlatformAccount;
  } else {
    const { data, error } = await supabase.from('platform_accounts').insert(account as any).select().single();
    if (error || !data) throw new Error(error?.message || 'Failed to create account');
    return data as unknown as PlatformAccount;
  }
}

export async function deletePlatformAccount(id: string): Promise<void> {
  const { error } = await supabase.from('platform_accounts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function setDefaultAccount(id: string, platform: string): Promise<void> {
  // Unset all defaults for platform, then set the chosen one
  await supabase.from('platform_accounts').update({ is_default: false } as any).eq('platform', platform);
  await supabase.from('platform_accounts').update({ is_default: true } as any).eq('id', id);
}

// --- Video file upload to storage ---
export async function uploadVideoFile(file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'mp4';
  const storagePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  // Use upsert and set content type explicitly for better compatibility
  const { error } = await supabase.storage
    .from('videos')
    .upload(storagePath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || 'video/mp4',
    });

  if (error) {
    console.error('Storage upload error:', error);
    if (error.message?.includes('Payload too large') || error.message?.includes('413')) {
      throw new Error(`Video file too large. Maximum size is 50MB. Your file: ${(file.size / 1024 / 1024).toFixed(1)}MB`);
    }
    throw new Error(`Upload failed: ${error.message}`);
  }
  return storagePath;
}

export function getVideoUrl(storagePath: string): string {
  const { data } = supabase.storage.from('videos').getPublicUrl(storagePath);
  return data.publicUrl;
}

/**
 * Split a tags/hashtags string into individual tags.
 * Supports both comma-separated ("tag1, tag2") and space-separated hashtags ("#tag1 #tag2").
 */
function splitTags(value: string): string[] {
  if (!value) return [];
  // If the value contains commas, split by comma
  if (value.includes(',')) {
    return value.split(',').map((t) => t.trim()).filter(Boolean);
  }
  // Otherwise, split by spaces (handles "#tag1 #tag2 #tag3" format)
  return value.split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

// --- Text file parsing ---
export function parseTextContent(content: string): VideoMetadata {
  const lines = content.split('\n');
  const metadata: VideoMetadata = {
    title: '',
    description: '',
    tags: [],
    platforms: ['youtube', 'tiktok', 'instagram'],
  };

  // Matches section headers like "--- Description ---" or "=== VIDEO METADATA ==="
  const dashSectionRegex = /^-{2,}\s*(.+?)\s*-{2,}$/;
  const equalsSectionRegex = /^={2,}\s*(.+?)\s*={2,}$/;

  type Section = 'description' | 'keywords' | 'tags' | 'other' | null;
  let activeSection: Section = null;
  const descLines: string[] = [];
  const keywordLines: string[] = [];
  const tagLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // === ... === headers: reset to key:value mode (document-level marker)
    if (equalsSectionRegex.test(line)) {
      activeSection = null;
      continue;
    }

    // --- ... --- headers: enter named section
    const dashMatch = line.match(dashSectionRegex);
    if (dashMatch) {
      const sectionName = dashMatch[1].toLowerCase().trim();
      if (sectionName.includes('description') || sectionName.includes('caption')) {
        activeSection = 'description';
      } else if (sectionName.includes('keyword')) {
        activeSection = 'keywords';
      } else if (sectionName.includes('tag') || sectionName.includes('hashtag')) {
        activeSection = 'tags';
      } else {
        activeSection = 'other';
      }
      continue;
    }

    // Inside a named section: accumulate lines
    if (activeSection === 'description') {
      descLines.push(line);
      continue;
    } else if (activeSection === 'keywords') {
      // Skip lines that look like metadata key:value pairs (e.g., "Campaign: Romal History")
      if (!line.includes(':')) {
        keywordLines.push(line);
      }
      continue;
    } else if (activeSection === 'tags') {
      // Only collect lines that contain hashtags or are comma-separated tags
      if (line.includes('#') || (line.includes(',') && !line.includes(':'))) {
        tagLines.push(...splitTags(line));
      }
      continue;
    } else if (activeSection === 'other') {
      continue;
    }

    // No active section: parse key:value pairs
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    switch (key) {
      case 'title':
      case 'header':
      case 'headline':
        metadata.title = value;
        break;
      case 'description':
      case 'caption':
      case 'details':
        if (value) descLines.push(value);
        activeSection = 'description';
        break;
      case 'tags':
      case 'keywords':
      case 'hashtags':
        metadata.tags = splitTags(value);
        break;
      case 'platforms':
        metadata.platforms = value.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
        break;
    }
  }

  // Apply accumulated section data
  if (descLines.length > 0) {
    metadata.description = descLines.join('\n');
  }
  if (tagLines.length > 0 && metadata.tags.length === 0) {
    metadata.tags = tagLines;
  }
  if (keywordLines.length > 0 && metadata.tags.length === 0) {
    metadata.tags = splitTags(keywordLines.join(', '));
  }

  return metadata;
}

// --- Upload Jobs ---
export async function getQueue(): Promise<UploadJob[]> {
  const { data, error } = await supabase
    .from('upload_jobs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error || !data) return [];
  return data.map((row) => ({
    ...row,
    platform_results: (row.platform_results as any) || [],
  }));
}

export async function createUploadJob(
  videoFileName: string,
  videoStoragePath: string | null,
  metadata: VideoMetadata,
  platforms: string[],
  accountId?: string
): Promise<UploadJob> {
  const platformResults: PlatformResult[] = platforms.map((name) => ({
    name,
    status: 'pending' as const,
  }));

  const insertPayload: any = {
    video_file_name: videoFileName,
    video_storage_path: videoStoragePath,
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags,
    target_platforms: platforms,
    status: 'pending',
    platform_results: platformResults as any,
  };
  if (accountId) insertPayload.account_id = accountId;

  const { data, error } = await supabase
    .from('upload_jobs')
    .insert(insertPayload)
    .select()
    .single();

  if (error || !data) throw new Error(error?.message || 'Failed to create job');

  return { ...data, platform_results: platformResults };
}

export async function updateJobPlatformResults(
  jobId: string,
  platformResults: PlatformResult[],
  status?: string,
  completedAt?: string
): Promise<void> {
  const updates: any = { platform_results: platformResults };
  if (status) updates.status = status;
  if (completedAt) updates.completed_at = completedAt;

  await supabase.from('upload_jobs').update(updates).eq('id', jobId);
}

// No fake simulation. Jobs stay "pending" until the local Node.js server
// picks them up and performs real Playwright browser uploads.

export async function retryJob(jobId: string): Promise<void> {
  const { data: job } = await supabase
    .from('upload_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (!job) return;

  const results = (job.platform_results as any as PlatformResult[]) || [];
  results.filter((r) => r.status === 'error').forEach((r) => {
    r.status = 'pending';
    r.error = undefined;
  });

  await updateJobPlatformResults(jobId, results, 'pending');
}

export async function deleteJob(jobId: string): Promise<void> {
  // If the job has a browser session, stop it first
  const { data: job } = await supabase.from('upload_jobs').select('browserbase_session_id, status').eq('id', jobId).single();
  if (job?.browserbase_session_id && ['pending', 'processing', 'uploading'].includes(job.status)) {
    try {
      await supabase.functions.invoke('cloud-browser-status', {
        body: { action: 'stop', sessionId: job.browserbase_session_id },
      });
    } catch {}
  }
  await supabase.from('upload_jobs').delete().eq('id', jobId);
}

export async function stopJob(jobId: string): Promise<void> {
  const { data: job } = await supabase.from('upload_jobs').select('browserbase_session_id').eq('id', jobId).single();
  if (job?.browserbase_session_id) {
    try {
      await supabase.functions.invoke('cloud-browser-status', {
        body: { action: 'stop', sessionId: job.browserbase_session_id },
      });
    } catch {}
  }
  await supabase.from('upload_jobs').update({ status: 'failed' }).eq('id', jobId);
}

export async function clearQueue(): Promise<void> {
  await supabase.from('upload_jobs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
}

// --- Schedule (multiple configs) ---
export async function getSchedules(): Promise<ScheduleConfig[]> {
  const { data, error } = await supabase
    .from('schedule_config')
    .select('*')
    .order('id', { ascending: true });

  if (error || !data) return [];

  return data.map((row: any) => ({
    id: row.id,
    name: row.name || 'Schedule',
    enabled: row.enabled,
    cronExpression: row.cron_expression,
    platforms: row.platforms,
    folderPath: row.folder_path || '',
    endAt: row.end_at || null,
    uploadIntervalMinutes: row.upload_interval_minutes || 10,
    maxVideos: row.max_videos ?? null,
    accountSelections: row.account_selections || {},
    runCount: row.run_count || 0,
    maxRuns: row.max_runs ?? null,
    lastRunAt: row.last_run_at || null,
  }));
}

// Keep backward compat
export async function getSchedule(): Promise<ScheduleConfig> {
  const all = await getSchedules();
  return all[0] || { name: 'Schedule', enabled: false, cronExpression: '0 9 * * *', platforms: ['youtube', 'tiktok', 'instagram'], folderPath: '', endAt: null, uploadIntervalMinutes: 10 };
}

export async function saveSchedule(config: ScheduleConfig): Promise<ScheduleConfig> {
  const payload = {
    name: config.name || 'Schedule',
    enabled: config.enabled,
    cron_expression: config.cronExpression,
    platforms: config.platforms,
    folder_path: config.folderPath,
    end_at: config.endAt,
    upload_interval_minutes: config.uploadIntervalMinutes || 10,
    max_videos: config.maxVideos ?? null,
    account_selections: config.accountSelections || {},
    max_runs: config.maxRuns ?? null,
  } as any;

  if (config.id) {
    const { data, error } = await supabase.from('schedule_config').update(payload).eq('id', config.id).select().single();
    if (error) throw new Error(`Failed to update schedule: ${error.message}`);
    return data ? { ...config, id: data.id } : config;
  } else {
    const { data, error } = await supabase.from('schedule_config').insert(payload).select().single();
    if (error) throw new Error(`Failed to create schedule: ${error.message}`);
    return data ? { ...config, id: data.id } : config;
  }
}

export async function deleteScheduleConfig(id: number): Promise<void> {
  await supabase.from('schedule_config').delete().eq('id', id);
}

// --- Scheduled Uploads ---
export async function getScheduledUploads(): Promise<ScheduledUpload[]> {
  const { data, error } = await supabase
    .from('scheduled_uploads')
    .select('*')
    .order('scheduled_at', { ascending: true });

  if (error || !data) return [];
  return (data as ScheduledUpload[]).sort((a, b) => {
    const rank = (status: string) => status === 'scheduled' ? 0 : status === 'processing' ? 1 : 2;
    const rankDiff = rank(a.status) - rank(b.status);
    if (rankDiff !== 0) return rankDiff;
    const timeA = new Date(a.scheduled_at).getTime();
    const timeB = new Date(b.scheduled_at).getTime();
    return rank(a.status) === 2 ? timeB - timeA : timeA - timeB;
  });
}

export async function createScheduledUpload(
  videoFileName: string,
  videoStoragePath: string | null,
  metadata: VideoMetadata,
  platforms: string[],
  scheduledAt: string,
  accountId?: string
): Promise<ScheduledUpload> {
  const normalizedScheduledAt = Number.isNaN(new Date(scheduledAt).getTime())
    ? scheduledAt
    : new Date(scheduledAt).toISOString();

  const insertPayload: any = {
    video_file_name: videoFileName,
    video_storage_path: videoStoragePath,
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags,
    target_platforms: platforms,
    scheduled_at: normalizedScheduledAt,
    status: 'scheduled',
  };
  if (accountId) insertPayload.account_id = accountId;

  const { data, error } = await supabase
    .from('scheduled_uploads')
    .insert(insertPayload)
    .select()
    .single();

  if (error || !data) throw new Error(error?.message || 'Failed to create scheduled upload');
  return data as ScheduledUpload;
}

export async function deleteScheduledUpload(id: string): Promise<void> {
  await supabase.from('scheduled_uploads').delete().eq('id', id);
}

// --- Local Telegram notifications ---
export async function sendTelegramNotification(chatId: string, text: string): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:3001/api/telegram/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => ({}));
    return response.ok && data?.success !== false;
  } catch {
    return false;
  }
}
