// Social Posts storage layer — multi-account, AI-powered post manager.
import { supabase } from '@/integrations/supabase/client';

const LOCAL_WORKER_URL = 'http://localhost:3001';

export type SocialPlatform = 'x' | 'linkedin' | 'facebook';
export const SOCIAL_PLATFORMS: SocialPlatform[] = ['x', 'linkedin', 'facebook'];

export interface SocialAccount {
  id: string;
  platform: string;
  label: string;
  email: string;
  password: string;
  enabled: boolean;
  is_default: boolean;
  created_at: string;
}

export interface SocialPostResult {
  name: string;
  status: 'pending' | 'uploading' | 'success' | 'error';
  url?: string;
  error?: string;
}

export interface PlatformVariant { description: string; hashtags: string[] }
export interface SourceMeta { folder: string; files: string[] }

export interface SocialPost {
  id: string;
  description: string;
  image_path: string | null;
  image_paths: string[];
  hashtags: string[];
  target_platforms: string[];
  status: string;
  scheduled_at: string | null;
  account_selections: Record<string, string>;
  ai_prompt: string | null;
  ai_sources: any[];
  platform_results: SocialPostResult[];
  platform_variants: Record<string, PlatformVariant>;
  source_meta?: SourceMeta | null;
  created_at: string;
  completed_at: string | null;
}

export interface AISettings {
  provider: string;
  apiKey: string;
  model: string;
  /** Optional base URL — used for self-hosted providers (LM Studio, Ollama, custom OpenAI-compatible). */
  baseUrl?: string;
}

export interface ImageKeyEntry {
  id: string;          // local uuid for list keys
  provider: string;    // unsplash | pexels | openai | google | nvidia | xai | lovable
  apiKey: string;      // empty for lovable
  model: string;       // model id for that provider
  label?: string;      // optional human label e.g. "Personal Google", "Work OpenAI"
  enabled: boolean;
}

export interface AgentSettings {
  researchProvider: string; // auto | brave | tavily | serper | firecrawl | local
  researchApiKey: string;
  imageProvider: string;    // legacy primary — auto | unsplash | pexels | openai | google | nvidia | xai | lovable
  imageApiKey: string;
  imageModel: string;       // legacy primary model id
  imageKeys: ImageKeyEntry[]; // up to 10 fallback keys, tried in order
  researchDepth: string;    // light | standard | deep
  localAgentUrl: string;
  taskMode: string;         // standard | multi-agent
  automationMode: string;   // safe | extended
  memoryEnabled: boolean;
  memoryMaxItems: number;
  shellEnabled: boolean;
  workspacePath: string;
}

function getMissingColumnName(error: { message?: string; details?: string } | null | undefined): string | null {
  const text = [error?.message, error?.details].filter(Boolean).join(' ');
  const quoted = text.match(/Could not find the '([^']+)' column/i);
  if (quoted?.[1]) return quoted[1];
  const doubleQuoted = text.match(/column "([^"]+)"/i);
  if (doubleQuoted?.[1]) return doubleQuoted[1];
  return null;
}

async function updateAppSettingsCompat(payload: Record<string, unknown>): Promise<void> {
  const nextPayload = { ...payload };
  const removedColumns = new Set<string>();
  const maxRetries = Math.min(Math.max(Object.keys(nextPayload).length, 1), 6);
  let attempts = 0;

  while (Object.keys(nextPayload).length > 0 && attempts < maxRetries) {
    attempts += 1;
    const { error } = await (supabase as any).from('app_settings').update(nextPayload).eq('id', 1);
    if (!error) return;

    const missingColumn = getMissingColumnName(error);
    if (!missingColumn || !(missingColumn in nextPayload) || removedColumns.has(missingColumn)) {
      throw new Error(error.message);
    }

    removedColumns.add(missingColumn);
    delete nextPayload[missingColumn];
  }

  throw new Error('Could not update agent settings: all retryable columns were rejected');
}

// Heuristic: detect provider from API key prefix.
// Returns { research?, image? } — both can be set if the key is ambiguous.
export function detectProviderFromKey(key: string): { research?: string; image?: string } {
  const k = (key || '').trim();
  if (!k) return {};
  // Brave: BSA-prefixed (e.g. "BSAxxxxxxxx...")
  if (/^BSA[A-Za-z0-9_-]{10,}$/.test(k)) return { research: 'brave' };
  // Tavily: tvly- prefix
  if (/^tvly-[A-Za-z0-9]{10,}$/i.test(k)) return { research: 'tavily' };
  // Firecrawl: fc- prefix
  if (/^fc-[A-Za-z0-9]{10,}$/i.test(k)) return { research: 'firecrawl' };
  // xAI: xai- prefix
  if (/^xai-[A-Za-z0-9_-]{20,}$/i.test(k)) return { image: 'xai' };
  // NVIDIA: nvapi- prefix
  if (/^nvapi-[A-Za-z0-9_-]{20,}$/i.test(k)) return { image: 'nvidia' };
  // Google AI Studio: AIza prefix (39 chars total typical)
  if (/^AIza[A-Za-z0-9_-]{20,}$/.test(k)) return { image: 'google' };
  // OpenAI: sk- (legacy) or sk-proj-
  if (/^sk-(proj-)?[A-Za-z0-9_-]{20,}$/.test(k)) return { image: 'openai' };
  // Anthropic: sk-ant-
  if (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return {};
  // Serper: 64-char hex
  if (/^[a-f0-9]{64}$/i.test(k)) return { research: 'serper' };
  // Pexels: 56-char alphanumeric
  if (/^[A-Za-z0-9]{50,60}$/.test(k) && !/^[a-f0-9]+$/i.test(k)) return { image: 'pexels' };
  // Unsplash Access Key: 43 chars typically, mixed case + dashes
  if (/^[A-Za-z0-9_-]{40,48}$/.test(k)) return { image: 'unsplash' };
  return {};
}

// --- AI settings (extended app_settings columns) ---
export async function getAISettings(): Promise<AISettings> {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  const row = (data || {}) as any;
  return {
    provider: row.ai_provider || 'lovable',
    apiKey: row.ai_api_key || '',
    model: row.ai_model || 'google/gemini-3-flash-preview',
    baseUrl: row.ai_base_url || '',
  };
}

export async function saveAISettings(s: AISettings): Promise<void> {
  const { error } = await supabase
    .from('app_settings')
    .update({
      ai_provider: s.provider,
      ai_api_key: s.apiKey,
      ai_model: s.model,
      ai_base_url: s.baseUrl || '',
    } as any)
    .eq('id', 1);
  if (error) throw new Error(error.message);
}

export async function getAgentSettings(): Promise<AgentSettings> {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  const r = (data || {}) as any;
  const rawKeys = Array.isArray(r.image_keys) ? r.image_keys : [];
  const imageKeys: ImageKeyEntry[] = rawKeys.map((k: any) => ({
    id: k.id || crypto.randomUUID(),
    provider: k.provider || 'lovable',
    apiKey: k.apiKey || '',
    model: k.model || '',
    label: k.label || '',
    enabled: k.enabled !== false,
  }));
  return {
    researchProvider: r.research_provider || 'auto',
    researchApiKey: r.research_api_key || '',
    imageProvider: r.image_provider || 'auto',
    imageApiKey: r.image_api_key || '',
    imageModel: r.image_model || '',
    imageKeys,
    researchDepth: r.research_depth || 'standard',
    localAgentUrl: r.local_agent_url || 'http://localhost:3001',
    taskMode: r.agent_task_mode || 'standard',
    automationMode: r.agent_automation_mode || 'safe',
    memoryEnabled: r.agent_memory_enabled !== false,
    memoryMaxItems: Math.min(Math.max(Number(r.agent_memory_max_items) || 8, 1), 20),
    shellEnabled: r.agent_shell_enabled === true,
    workspacePath: r.agent_workspace_path || '',
  };
}

export async function saveAgentSettings(s: AgentSettings): Promise<void> {
  const cleanKeys = (s.imageKeys || []).slice(0, 10).map((k) => ({
    id: k.id, provider: k.provider, apiKey: k.apiKey,
    model: k.model || '', label: k.label || '', enabled: k.enabled !== false,
  }));
  await updateAppSettingsCompat({
    research_provider: s.researchProvider,
    research_api_key: s.researchApiKey,
    image_provider: s.imageProvider,
    image_api_key: s.imageApiKey,
    image_model: s.imageModel || '',
    image_keys: cleanKeys as any,
    research_depth: s.researchDepth,
    local_agent_url: s.localAgentUrl,
    agent_task_mode: s.taskMode || 'standard',
    agent_automation_mode: s.automationMode || 'safe',
    agent_memory_enabled: s.memoryEnabled !== false,
    agent_memory_max_items: Math.min(Math.max(Number(s.memoryMaxItems) || 8, 1), 20),
    agent_shell_enabled: s.shellEnabled === true,
    agent_workspace_path: s.workspacePath || '',
  });
}

// --- Social accounts ---
export async function getSocialAccounts(): Promise<SocialAccount[]> {
  const { data, error } = await (supabase as any)
    .from('social_post_accounts')
    .select('*')
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  return data as SocialAccount[];
}

export async function saveSocialAccount(account: Partial<SocialAccount> & { platform: string }): Promise<SocialAccount> {
  if (account.id) {
    const { id, ...rest } = account;
    const { data, error } = await (supabase as any).from('social_post_accounts').update(rest).eq('id', id).select().single();
    if (error || !data) throw new Error(error?.message || 'Failed to update account');
    return data as SocialAccount;
  }
  const { data, error } = await (supabase as any).from('social_post_accounts').insert(account).select().single();
  if (error || !data) throw new Error(error?.message || 'Failed to create account');
  return data as SocialAccount;
}

export async function deleteSocialAccount(id: string): Promise<void> {
  const { error } = await (supabase as any).from('social_post_accounts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function setDefaultSocialAccount(id: string, platform: string): Promise<void> {
  await (supabase as any).from('social_post_accounts').update({ is_default: false }).eq('platform', platform);
  await (supabase as any).from('social_post_accounts').update({ is_default: true }).eq('id', id);
}

// --- Image upload to social-media bucket ---
export async function uploadSocialImage(file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'png';
  const storagePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from('social-media')
    .upload(storagePath, file, { cacheControl: '3600', upsert: false, contentType: file.type || 'image/png' });
  if (error) throw new Error(`Image upload failed: ${error.message}`);
  return storagePath;
}

export function getSocialImageUrl(storagePath: string | null): string | null {
  if (!storagePath) return null;
  const { data } = supabase.storage.from('social-media').getPublicUrl(storagePath);
  return data.publicUrl;
}

// --- Social posts ---
export async function listSocialPosts(): Promise<SocialPost[]> {
  const { data, error } = await (supabase as any)
    .from('social_posts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data.map((row: any) => ({
    ...row,
    hashtags: row.hashtags || [],
    target_platforms: row.target_platforms || [],
    image_paths: row.image_paths || [],
    account_selections: row.account_selections || {},
    ai_sources: row.ai_sources || [],
    platform_results: row.platform_results || [],
    platform_variants: row.platform_variants || {},
  })) as SocialPost[];
}

export async function createSocialPost(input: {
  description: string;
  imagePath: string | null;
  imagePaths?: string[];
  hashtags: string[];
  platforms: string[];
  accountSelections: Record<string, string>;
  scheduledAt?: string | null;
  aiPrompt?: string | null;
  aiSources?: any[];
  platformVariants?: Record<string, PlatformVariant>;
  sourceMeta?: SourceMeta | null;
}): Promise<SocialPost> {
  const platformResults: SocialPostResult[] = input.platforms.map((name) => ({ name, status: 'pending' }));
  const status = input.scheduledAt ? 'scheduled' : 'pending';
  const payload: any = {
    description: input.description,
    image_path: input.imagePath,
    image_paths: input.imagePaths && input.imagePaths.length ? input.imagePaths : (input.imagePath ? [input.imagePath] : []),
    hashtags: input.hashtags,
    target_platforms: input.platforms,
    account_selections: input.accountSelections,
    scheduled_at: input.scheduledAt || null,
    ai_prompt: input.aiPrompt || null,
    ai_sources: input.aiSources || [],
    status,
    platform_results: platformResults,
    platform_variants: input.platformVariants || {},
    source_meta: input.sourceMeta || null,
  };
  const { data, error } = await (supabase as any).from('social_posts').insert(payload).select().single();
  if (error || !data) throw new Error(error?.message || 'Failed to create post');
  return data as SocialPost;
}

export async function deleteSocialPost(id: string): Promise<void> {
  const { error } = await (supabase as any).from('social_posts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function retrySocialPost(id: string): Promise<void> {
  const { data: post } = await (supabase as any).from('social_posts').select('*').eq('id', id).single();
  if (!post) return;
  const results = (post.platform_results || []) as SocialPostResult[];
  results.filter((r) => r.status === 'error').forEach((r) => { r.status = 'pending'; r.error = undefined; });
  await (supabase as any).from('social_posts').update({ status: 'pending', platform_results: results }).eq('id', id);
}

// --- AI generation ---
export interface AIGenerateInput {
  prompt: string;
  platforms: string[];
  includeImage: boolean;
}

export interface AISource { title: string; url: string; note?: string }

export interface AIGenerateOutput {
  description: string;
  hashtags: string[];
  variants: Record<string, PlatformVariant>;
  imageUrl: string | null;
  imagePath: string | null;
  sources: AISource[];
  provider?: string;
  model?: string;
}

export interface AgentSource extends AISource {
  snippet?: string;
  favicon?: string;
  publishedAt?: string;
}

export interface AgentTool {
  kind: 'research' | 'scrape' | 'image' | 'llm';
  name: string;     // e.g. "brave", "local-browser", "unsplash", "lovable-ai"
  detail?: string;  // e.g. query, url, model
}

export type AIStreamEvent =
  | { type: 'job'; id: string }
  | { type: 'step'; id: string; emoji: string; label: string; status: 'active' | 'done' | 'error' }
  | { type: 'plan'; queries: string[]; imageStrategy: string; angle: string }
  | { type: 'source'; title: string; url: string; snippet?: string; favicon?: string; publishedAt?: string; note?: string }
  | { type: 'tool'; kind: AgentTool['kind']; name: string; detail?: string }
  | { type: 'variant'; platform: string; description: string; hashtags: string[] }
  | { type: 'sources'; sources: AgentSource[] }
  | { type: 'image'; imageUrl: string; imagePath: string; credit?: string }
  | { type: 'saved'; id: string; status: string }
  | { type: 'done'; variants: Record<string, PlatformVariant>; sources: AgentSource[]; imageUrl: string | null; imagePath: string | null; provider?: string; model?: string }
  | { type: 'error'; error: string };

// Persisted generation job — survives page navigation. The edge function mirrors every
// SSE event into generation_jobs.events so we can rehydrate the UI on reload.
export interface GenerationJob {
  id: string;
  prompt: string;
  platforms: string[];
  include_image: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  events: any[];
  result: AIGenerateOutput | null;
  error: string | null;
  saved_post_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AgentRunEvent {
  type: string;
  ts?: number;
  name?: string;
  label?: string;
  text?: string;
  summary?: string;
  message?: string;
  steps?: string[];
  ok?: boolean;
  data?: any;
  artifacts?: { kind: string; label: string; value: string }[];
}

export interface AgentRun {
  id: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  source: string;
  automation_mode?: string;
  task_mode?: string;
  events: AgentRunEvent[];
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export async function listGenerationJobs(): Promise<GenerationJob[]> {
  const { data } = await (supabase as any).from('generation_jobs')
    .select('*').order('created_at', { ascending: false }).limit(10);
  return (data || []) as GenerationJob[];
}

export async function getGenerationJob(id: string): Promise<GenerationJob | null> {
  const { data } = await (supabase as any).from('generation_jobs')
    .select('*').eq('id', id).maybeSingle();
  return (data || null) as GenerationJob | null;
}

// Mark a running job as cancelled. The edge function polls every 2s and aborts cleanly.
export async function cancelGenerationJob(id: string): Promise<void> {
  const { error } = await (supabase as any).from('generation_jobs').update({
    status: 'cancelled',
    error: 'Cancelled by user',
    completed_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'running');
  if (error) throw new Error(error.message);
}

// Cancel ALL running jobs at once — used from the panel "Cancel all" action.
export async function cancelAllRunningJobs(): Promise<number> {
  const { data, error } = await (supabase as any).from('generation_jobs').update({
    status: 'cancelled',
    error: 'Cancelled by user',
    completed_at: new Date().toISOString(),
  }).eq('status', 'running').select('id');
  if (error) throw new Error(error.message);
  return (data || []).length;
}

// Delete a single generation job from the queue (any status).
export async function deleteGenerationJob(id: string): Promise<void> {
  const { error } = await (supabase as any).from('generation_jobs').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function listAgentRuns(): Promise<AgentRun[]> {
  const { data } = await (supabase as any).from('agent_runs')
    .select('*').order('created_at', { ascending: false }).limit(10);
  return (data || []) as AgentRun[];
}

export async function cancelAgentRun(id: string): Promise<void> {
  await callLocalWorker<{ ok?: boolean; error?: string }>('/api/agent-run', { action: 'cancel', runId: id }, 10_000);
}

export async function deleteAgentRun(id: string): Promise<void> {
  const { error } = await (supabase as any).from('agent_runs').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Delete a single pending_commands row from the queue.
export async function deletePendingCommand(id: string): Promise<void> {
  const { error } = await (supabase as any).from('pending_commands').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Streaming generation via SSE — calls the edge function and emits parsed events as they arrive.
export async function generatePostStream(
  input: AIGenerateInput,
  onEvent: (e: AIStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const aiSettings = await getAISettings().catch(() => null);
  if (!(await isLocalWorkerAlive())) {
    throw new Error('Local worker is not reachable on port 3001. Start smart-launcher.bat and retry. Cloud AI fallback is disabled.');
  }
  const resp = await fetch(`${LOCAL_WORKER_URL}/api/generate-social-post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, stream: true, aiSettings }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    let msg = `Stream failed (${resp.status})`;
    try { const j = await resp.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) { currentEvent = ''; continue; }
      if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue; }
      if (line.startsWith('data: ')) {
        const payload = line.slice(6);
        try {
          const parsed = JSON.parse(payload);
          onEvent({ type: currentEvent as any, ...parsed });
        } catch { /* ignore parse errors */ }
      }
    }
  }
}

// Non-streaming fallback (kept for backward compat).
export async function generatePostWithAI(input: AIGenerateInput): Promise<AIGenerateOutput> {
  const data = await callLocalWorker<AIGenerateOutput>('/api/generate-social-post', { ...input, stream: false }, 120_000);
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as AIGenerateOutput;
}

export interface AIModel { id: string; label?: string }
async function callLocalWorker<T>(path: string, body: unknown, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(`${LOCAL_WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Local worker returned ${response.status}`);
  return data as T;
}

// Detect whether the user's local worker is reachable. Cached briefly to avoid
// hammering it on every dropdown render.
let localWorkerCheck: { at: number; alive: boolean } | null = null;
async function isLocalWorkerAlive(): Promise<boolean> {
  const now = Date.now();
  if (localWorkerCheck && now - localWorkerCheck.at < 5_000) return localWorkerCheck.alive;
  try {
    const r = await fetch(`${LOCAL_WORKER_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    const alive = r.ok;
    localWorkerCheck = { at: now, alive };
    return alive;
  } catch {
    localWorkerCheck = { at: now, alive: false };
    return false;
  }
}

// Local-worker-first model discovery. The worker can reach LM Studio on the LAN
// AND calls cloud providers directly with the user's own keys (zero Lovable cloud
// dependency). Falls back to the edge function only if the local worker is offline.
export async function listAIModels(provider: string, apiKey: string, baseUrl?: string): Promise<AIModel[]> {
  const data = await callLocalWorker<{ models: AIModel[] }>('/api/ai/models', { provider, apiKey, baseUrl });
  return data.models || [];
}

export interface ConnectionTestResult { ok: boolean; error?: string; latency?: number; provider?: string; model?: string; sample?: string }
export async function testAIConnection(provider: string, apiKey: string, model: string, baseUrl?: string): Promise<ConnectionTestResult> {
  return callLocalWorker<ConnectionTestResult>('/api/ai/test', { provider, apiKey, model, baseUrl });
}

export async function testAgentConnection(
  kind: 'research' | 'image',
  provider: string,
  apiKey: string,
  localUrl?: string,
  model?: string,
): Promise<ConnectionTestResult> {
  return callLocalWorker<ConnectionTestResult>('/api/agent/test', { kind, provider, apiKey, localUrl, model }, 30_000);
}

export interface ImageModelOption { id: string; label: string; recommended?: boolean }
export async function listImageModels(provider: string, apiKey: string): Promise<{ models: ImageModelOption[]; error?: string }> {
  return callLocalWorker<{ models: ImageModelOption[]; error?: string }>('/api/image/models', { provider, apiKey }, 15_000);
}

// ────────────────────────────────────────────────────────────
// Generation schedules — recurring AI post drafting → Telegram
// ────────────────────────────────────────────────────────────
export interface GenerationSchedule {
  id: number;
  name: string;
  enabled: boolean;
  cron_expression: string;
  upload_interval_minutes: number;
  target_platforms: string[];
  ai_prompt: string;
  include_image: boolean;
  account_selections: Record<string, string>;
  end_at: string | null;
  last_run_at: string | null;
  updated_at: string;
  // Post Campaign extensions
  auto_publish?: boolean;        // when true, drafts are immediately queued for publishing
  topic_mode?: boolean;          // treat ai_prompt as an evergreen topic; AI varies angle each run
  variation_hints?: string[];    // optional rotating angles/styles ("contrarian", "story", "data-driven"…)
  run_count?: number;
}

export async function listGenerationSchedules(): Promise<GenerationSchedule[]> {
  const { data, error } = await (supabase as any)
    .from('social_post_schedules')
    .select('*')
    .order('id', { ascending: true });
  if (error || !data) return [];
  return data.map((r: any) => ({
    ...r,
    target_platforms: r.target_platforms || [],
    account_selections: r.account_selections || {},
  })) as GenerationSchedule[];
}

export async function saveGenerationSchedule(s: Partial<GenerationSchedule>): Promise<GenerationSchedule> {
  const payload: any = {
    name: s.name || 'Generation Schedule',
    enabled: !!s.enabled,
    cron_expression: s.cron_expression || '0 9 * * *',
    upload_interval_minutes: s.upload_interval_minutes ?? 10,
    target_platforms: s.target_platforms || ['x', 'linkedin', 'facebook'],
    ai_prompt: s.ai_prompt || '',
    include_image: s.include_image !== false,
    account_selections: s.account_selections || {},
    end_at: s.end_at || null,
    auto_publish: !!s.auto_publish,
    topic_mode: !!s.topic_mode,
    variation_hints: s.variation_hints || [],
  };
  if (s.id) {
    const { data, error } = await (supabase as any)
      .from('social_post_schedules').update(payload).eq('id', s.id).select().single();
    if (error || !data) throw new Error(error?.message || 'Failed to update schedule');
    return data as GenerationSchedule;
  }
  const { data, error } = await (supabase as any)
    .from('social_post_schedules').insert(payload).select().single();
  if (error || !data) throw new Error(error?.message || 'Failed to create schedule');
  return data as GenerationSchedule;
}

export async function deleteGenerationSchedule(id: number): Promise<void> {
  const { error } = await (supabase as any).from('social_post_schedules').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Manually trigger a single schedule run (mostly for "Run now" testing).
export async function runGenerationScheduleNow(id: number): Promise<void> {
  await callLocalWorker('/api/generation-schedules/run-now', { scheduleId: id, force: true }, 120_000);
}
