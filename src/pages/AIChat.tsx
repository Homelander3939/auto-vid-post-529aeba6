import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Send, Bot, User, Loader2, MessageCircle, Paperclip,
  Mic, MicOff, File as FileIcon, X, Download, Video,
  Sparkles, Cpu, Activity, ListChecks, ExternalLink,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import ReactMarkdown from 'react-markdown';
import AgentRunPanel from '@/components/AgentRunPanel';
import { buildAgentRunPrompt, shouldLaunchAgentRun } from '@/lib/agentChat';

/* ── Types ───────────────────────────────────────────── */

interface FileAttachment {
  id: string;
  name: string;
  type: string;
  size: string;
  url: string;
  textContent?: string;
  isImage: boolean;
}

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  source?: 'app' | 'telegram';
  timestamp?: string;
  files?: FileAttachment[];
  images?: { url: string }[];
}

interface AgentRunPreview {
  id: string;
  prompt: string;
  status: string;
  error?: string | null;
  created_at: string;
  events?: Array<{ type: string; summary?: string; label?: string; message?: string; text?: string }>;
}

interface TelegramMediaItem {
  name?: string;
  type?: string;
  size?: number;
  url?: string;
}

interface TelegramRawUpdate {
  source?: string;
  update_id?: number;
  media?: {
    images?: TelegramMediaItem[];
    files?: TelegramMediaItem[];
  };
}

interface TelegramMessageRecord {
  chat_id?: number;
  created_at?: string;
  is_bot?: boolean;
  text?: string;
  raw_update?: TelegramRawUpdate;
}

interface ChatContextMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: { url: string }[];
  files?: Array<{ name: string; type: string; size: string; textContent?: string }>;
}

const APP_CHAT_STORAGE_KEY = 'ai-chat-browser-history-v1';
const MAX_STORED_MESSAGES = 200;
const BROWSER_MIRROR_SOURCE = 'browser-mirror';
const MAX_TEXT_ATTACHMENT_LENGTH = 10_000;
const AGENT_RUN_MARKER_PREFIX = '__AGENT_RUN__:';
const AGENT_RUN_MARKER_RE = new RegExp(`${AGENT_RUN_MARKER_PREFIX}([0-9a-f-]+)`, 'g');
const AGENT_RUN_MARKER_LINE_RE = new RegExp(`${AGENT_RUN_MARKER_PREFIX}[0-9a-f-]+\\n?`, 'g');
const SUGGESTED_PROMPTS = [
  'Check queued jobs',
  'Show scheduled uploads',
  'Build me a landing page with agentic flow',
  'Research a niche and create a content plan',
];

function isStoredMessage(value: unknown): value is Msg {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Msg>;
  return (record.role === 'user' || record.role === 'assistant')
    && typeof record.content === 'string';
}

/* ── Stream helper — local-worker-first, cloud fallback only if local is unavailable ── */

const LOCAL_WORKER_URL = 'http://localhost:3001';

async function isLocalWorkerAlive(): Promise<boolean> {
  try {
    const resp = await fetch(`${LOCAL_WORKER_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function sendLocalTelegram(body: Record<string, unknown>): Promise<boolean> {
  if (!(await isLocalWorkerAlive())) return false;
  const resp = await fetch(`${LOCAL_WORKER_URL}/api/telegram/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return resp.ok;
}

async function streamChat({
  messages,
  onDelta,
  onDone,
  onError,
}: {
  messages: ChatContextMessage[];
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (err: string) => void;
}) {
  if (!(await isLocalWorkerAlive())) {
    onError('Local worker is not reachable on port 3001. Start smart-launcher.bat and retry. Cloud AI fallback is disabled.');
    return;
  }
  const resp = await fetch(`${LOCAL_WORKER_URL}/api/ai-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({ error: 'Request failed' }));
    onError(data.error || `Local worker error ${resp.status}`);
    return;
  }

  if (!resp.body) { onError('No response stream'); return; }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith(':') || line.trim() === '') continue;
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') break;
      try {
        const parsed = JSON.parse(jsonStr);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) onDelta(content);
      } catch {
        buffer = line + '\n' + buffer;
        break;
      }
    }
  }
  onDone();
}

/* ── Telegram indicator ──────────────────────────────── */

function TelegramIndicator({ connected, count }: { connected: boolean; count: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary/60">
      {connected ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-xs font-medium text-emerald-600">Telegram synced</span>
          {count > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 ml-1">
              {count}
            </Badge>
          )}
        </>
      ) : (
        <>
          <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
          <span className="text-xs text-muted-foreground">Telegram offline</span>
        </>
      )}
    </div>
  );
}

/* ── Voice recorder hook ─────────────────────────────── */

function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
      setDuration(0);
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } catch (err) {
      console.error('Microphone access denied:', err);
      throw err;
    }
  }, []);

  const stop = useCallback((): Promise<Blob> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) return;
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        recorder.stream.getTracks().forEach((t) => t.stop());
        clearInterval(timerRef.current);
        setRecording(false);
        setDuration(0);
        resolve(blob);
      };
      recorder.stop();
    });
  }, []);

  return { recording, duration, start, stop };
}

/* ── Main component ──────────────────────────────────── */

export default function AIChat() {
  const { toast } = useToast();
  const [appMessages, setAppMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voice = useVoiceRecorder();

  /* ── Telegram status ───────────────── */
  const { data: settings } = useQuery({
    queryKey: ['settings-telegram'],
    queryFn: async () => {
      const { data } = await supabase
        .from('app_settings')
        .select('telegram_enabled, telegram_chat_id, ai_provider, ai_api_key, ai_model, ai_base_url')
        .eq('id', 1)
        .single();
      return data;
    },
  });
  const telegramEnabled = !!(settings?.telegram_enabled && settings?.telegram_chat_id);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(APP_CHAT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      setAppMessages(parsed.filter(isStoredMessage).slice(-MAX_STORED_MESSAGES));
    } catch (error) {
      console.error('Failed to restore browser chat history:', error);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(APP_CHAT_STORAGE_KEY, JSON.stringify(appMessages.slice(-MAX_STORED_MESSAGES)));
    } catch (error) {
      console.error('Failed to persist browser chat history:', error);
    }
  }, [appMessages]);

  /* ── Telegram history (polls every 4s) ── */
  const { data: telegramMessages } = useQuery({
    queryKey: ['telegram-history', settings?.telegram_chat_id || 'all'],
    queryFn: async () => {
      let query = supabase
        .from('telegram_messages')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(MAX_STORED_MESSAGES);
      if (settings?.telegram_chat_id) {
        query = query.eq('chat_id', Number(settings.telegram_chat_id));
      }
      const { data, error } = await query;
      if (error) console.error('Telegram fetch error:', error);
      return data || [];
    },
    refetchInterval: 2000,
  });

  const telegramSynced = telegramEnabled && (telegramMessages?.length ?? 0) > 0;

  const { data: recentAgentRuns } = useQuery({
    queryKey: ['chat-agent-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_runs')
        .select('id,prompt,status,error,created_at,events')
        .in('source', ['ai-chat', 'telegram', 'skill'])
        .order('created_at', { ascending: false })
        .limit(4);
      if (error) throw error;
      return (data || []) as AgentRunPreview[];
    },
    refetchInterval: 2000,
  });

  /* ── Resolve numeric chat_id from telegram_messages ── */
  const resolvedChatId = useMemo(() => {
    if (settings?.telegram_chat_id) return String(settings.telegram_chat_id);
    if (!telegramMessages?.length) return undefined;
    const latest = [...telegramMessages].reverse().find((m: any) => (m as TelegramMessageRecord).chat_id) as TelegramMessageRecord | undefined;
    return latest ? String(latest.chat_id) : undefined;
  }, [settings?.telegram_chat_id, telegramMessages]);

  const activeAgentRuns = (recentAgentRuns || []).filter((run) => run.status === 'running');
  const failedAgentRuns = (recentAgentRuns || []).filter((run) => run.status === 'failed');
  const latestAgentRun = recentAgentRuns?.[0] || null;

  /* ── Mirror helper: send text to Telegram ── */
  const mirrorToTelegram = useCallback(async (text: string) => {
    if (!telegramEnabled || !resolvedChatId || !text.trim()) return;
    try {
      const sentLocal = await sendLocalTelegram({ chat_id: resolvedChatId, text: text.slice(0, 3900) });
      if (!sentLocal) throw new Error('Local Telegram send failed');
    } catch (e) {
      console.error('Mirror to Telegram failed:', e);
    }
  }, [telegramEnabled, resolvedChatId]);

  const mirrorImageToTelegram = useCallback(async (file: FileAttachment, caption?: string) => {
    if (!telegramEnabled || !resolvedChatId || !file.url) return;
    try {
      const response = await fetch(file.url);
      const blob = await response.blob();
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
            reject(new Error('Invalid image data'));
            return;
          }
          const [, data] = reader.result.split(',', 2);
          if (!data) {
            reject(new Error('Invalid image data'));
            return;
          }
          resolve(data);
        };
        reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
        reader.readAsDataURL(blob);
      });
      const body = {
        chat_id: resolvedChatId,
        text: caption?.slice(0, 1000),
        photo_base64: base64,
        photo_mime_type: file.type || blob.type || 'image/png',
      };
      const sentLocal = await sendLocalTelegram(body);
      if (!sentLocal) throw new Error('Local Telegram photo send failed');
    } catch (error) {
      console.error('Mirror image to Telegram failed:', error);
    }
  }, [telegramEnabled, resolvedChatId]);

  const mirrorBrowserMessage = useCallback(async (speaker: 'You' | 'AI', text: string, files: FileAttachment[] = []) => {
    if (!telegramEnabled || !resolvedChatId) return;
    const imageFiles = files.filter((file) => file.isImage);
    const otherFiles = files.filter((file) => !file.isImage);
    const attachmentLines = otherFiles.map((file) => `• ${file.name}${file.url ? ` — ${file.url}` : ''}`);
    const summary = [
      `${speaker}: ${text.trim() || (files.length > 0 ? '[sent attachment]' : '')}`.trim(),
      attachmentLines.length > 0 ? `Attachments:\n${attachmentLines.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    if (summary) await mirrorToTelegram(summary);
    for (const [index, image] of imageFiles.entries()) {
      await mirrorImageToTelegram(image, index === 0 && !summary ? `${speaker} image: ${image.name}` : undefined);
    }
  }, [mirrorImageToTelegram, mirrorToTelegram, resolvedChatId, telegramEnabled]);

  /* ── Merge app + telegram messages by timestamp ── */
  const mapTelegramMediaToFiles = useCallback((rawUpdate?: TelegramRawUpdate): FileAttachment[] => {
    const media = rawUpdate?.media;
    if (!media) return [];

    const imageFiles: FileAttachment[] = (media.images || []).map((img, idx) => ({
      id: `${rawUpdate?.update_id || Date.now()}-img-${idx}`,
      name: img.name || `telegram-image-${idx + 1}.jpg`,
      type: img.type || 'image/jpeg',
      size: img.size ? `${Math.max(1, Math.round(img.size / 1024))} KB` : 'image',
      url: img.url,
      isImage: true,
    }));

    const otherFiles: FileAttachment[] = (media.files || [])
      .filter((f) => f.url)
      .map((f, idx) => ({
        id: `${rawUpdate?.update_id || Date.now()}-file-${idx}`,
        name: f.name || `telegram-file-${idx + 1}`,
        type: f.type || 'application/octet-stream',
        size: f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : 'file',
        url: f.url,
        isImage: (f.type || '').startsWith('image/'),
      }));

    return [...imageFiles, ...otherFiles];
  }, []);

  const messages = useMemo(() => {
    const tgMsgs: Msg[] = (telegramMessages || []).map((raw: any) => {
      const m = raw as TelegramMessageRecord;
      const mediaFiles = mapTelegramMediaToFiles(m.raw_update);
      const source = m.raw_update?.source === BROWSER_MIRROR_SOURCE ? 'app' : 'telegram';
      return {
        role: m.is_bot ? 'assistant' as const : 'user' as const,
        content: m.text || '',
        source,
        timestamp: m.created_at,
        files: mediaFiles.length > 0 ? mediaFiles : undefined,
        images: mediaFiles.some((f) => f.isImage)
          ? mediaFiles.filter((f) => f.isImage).map((f) => ({ url: f.url }))
          : undefined,
      };
    });

    const all = [...appMessages, ...tgMsgs];
    all.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return ta - tb;
    });
    return all;
  }, [appMessages, telegramMessages, mapTelegramMediaToFiles]);

  /* ── Auto-scroll ───────────────────── */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* ── File handling ─────────────────── */
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith('image/');
      const sizeStr = file.size < 1024 * 1024
        ? `${(file.size / 1024).toFixed(0)} KB`
        : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
      const ext = file.name.split('.').pop() || 'bin';
      const storagePath = `chat/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const { error } = await supabase.storage.from('videos').upload(storagePath, file);
      if (error) { toast({ title: 'Upload failed', description: error.message, variant: 'destructive' }); continue; }
      const { data: urlData } = supabase.storage.from('videos').getPublicUrl(storagePath);
      let textContent: string | undefined;
      if (file.type.startsWith('text/') || /\.(txt|md|csv|json)$/.test(file.name)) {
        try {
          textContent = await file.text();
          if (textContent.length > MAX_TEXT_ATTACHMENT_LENGTH) {
            textContent = textContent.slice(0, MAX_TEXT_ATTACHMENT_LENGTH) + '\n... (truncated)';
          }
        } catch {
          textContent = undefined;
        }
      }
      setPendingFiles((prev) => [...prev, { id: storagePath, name: file.name, type: file.type, size: sizeStr, url: urlData.publicUrl, textContent, isImage }]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removePendingFile = (id: string) => setPendingFiles((prev) => prev.filter((f) => f.id !== id));

  /* ── Voice handling ────────────────── */
  const handleVoiceToggle = async () => {
    if (voice.recording) {
      try {
        const blob = await voice.stop();
        const storagePath = `chat/voice-${Date.now()}.webm`;
        await supabase.storage.from('videos').upload(storagePath, blob);
        const { data: urlData } = supabase.storage.from('videos').getPublicUrl(storagePath);
        setPendingFiles((prev) => [...prev, {
          id: storagePath, name: `Voice message (${voice.duration}s)`, type: 'audio/webm',
          size: `${(blob.size / 1024).toFixed(0)} KB`, url: urlData.publicUrl, isImage: false,
        }]);
        setInput((prev) => prev || '🎤 Voice message — please listen and respond');
      } catch { toast({ title: 'Voice recording failed', variant: 'destructive' }); }
    } else {
      try { await voice.start(); }
      catch { toast({ title: 'Microphone access denied', description: 'Please allow microphone access.', variant: 'destructive' }); }
    }
  };

  /* ── Send message ──────────────────── */
  const send = async () => {
    const text = input.trim();
    if ((!text && pendingFiles.length === 0) || isLoading) return;

    const imageFiles = pendingFiles.filter((f) => f.isImage);
    const otherFiles = pendingFiles.filter((f) => !f.isImage);

    const userMsg: Msg = {
      role: 'user', content: text, source: 'app', timestamp: new Date().toISOString(),
      files: pendingFiles.length > 0 ? [...pendingFiles] : undefined,
      images: imageFiles.length > 0 ? imageFiles.map((f) => ({ url: f.url })) : undefined,
    };

    setAppMessages((prev) => [...prev, userMsg]);
    setInput('');
    setPendingFiles([]);
    setIsLoading(true);

    // Mirror user message to Telegram + send typing indicator
    if (telegramEnabled && resolvedChatId) {
      void mirrorBrowserMessage('You', text, pendingFiles);
      // Show "typing..." in Telegram while AI thinks
      void sendLocalTelegram({ chat_id: resolvedChatId, action: 'typing' });
    }

    let assistantSoFar = '';
    const upsert = (chunk: string) => {
      assistantSoFar += chunk;
      setAppMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last?.source === 'app' && !last?.timestamp) {
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantSoFar } : m));
        }
        return [...prev, { role: 'assistant', content: assistantSoFar, source: 'app' }];
      });
    };

    const contextMsgs: ChatContextMessage[] = appMessages.slice(-8).map((m) => {
      const base: ChatContextMessage = { role: m.role, content: m.content.slice(0, 1800) };
      if (m.images) base.images = m.images;
      if (m.files?.some((f) => !f.isImage)) {
        base.files = m.files.filter((f) => !f.isImage).map((f) => ({ name: f.name, type: f.type, size: f.size, textContent: f.textContent }));
      }
      return base;
    });

    const newMsg: ChatContextMessage = { role: 'user', content: text || 'Please analyze the attached file(s).' };
    if (imageFiles.length > 0) newMsg.images = imageFiles.map((f) => ({ url: f.url }));
    if (otherFiles.length > 0) newMsg.files = otherFiles.map((f) => ({ name: f.name, type: f.type, size: f.size, textContent: f.textContent }));
    contextMsgs.push(newMsg);

    if (shouldLaunchAgentRun(text, pendingFiles)) {
      try {
        const agentPrompt = buildAgentRunPrompt(text, pendingFiles);
        const localResp = await fetch(`${LOCAL_WORKER_URL}/api/agent-run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: agentPrompt,
            source: 'ai-chat',
            telegram_chat_id: resolvedChatId || null,
            chat_settings: settings ? {
              provider: (settings as any).ai_provider,
              apiKey: (settings as any).ai_api_key,
              model: (settings as any).ai_model,
              baseUrl: (settings as any).ai_base_url,
            } : null,
          }),
          signal: AbortSignal.timeout(5000),
        });
        const data = await localResp.json().catch(() => ({}));
        const error = !localResp.ok ? new Error(data?.error || 'Local agent run did not start') : null;
        if (error || data?.error || !data?.runId) {
          throw new Error(data?.error || error?.message || 'Agent run did not start');
        }

        // Keep the marker on its own line prefix so the chat UI can extract the run ID and mount AgentRunPanel.
        const startedMessage = `${AGENT_RUN_MARKER_PREFIX}${data.runId}
🚀 Real agent run started.

I switched this request from normal chat mode into autonomous execution so you can watch the real plan, tools, progress, and any errors live in this tab.

Open the activity panel on the right if you want to follow the process flow while it runs.`;
        setAppMessages((prev) => [...prev, {
          role: 'assistant',
          content: startedMessage,
          source: 'app',
          timestamp: new Date().toISOString(),
        }]);
        if (telegramEnabled && resolvedChatId) {
          void mirrorBrowserMessage('AI', '🚀 Real agent run started. Watch the live progress feed in the app.');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const failureMessage = `⚠️ I could not start the autonomous agent.\n\nReason: ${message}`;
        setAppMessages((prev) => [...prev, {
          role: 'assistant',
          content: failureMessage,
          source: 'app',
          timestamp: new Date().toISOString(),
        }]);
        toast({ title: 'Agent start failed', description: message, variant: 'destructive' });
      } finally {
        setIsLoading(false);
      }
      return;
    }

    try {
      await streamChat({
        messages: contextMsgs,
        onDelta: upsert,
        onDone: () => {
          setIsLoading(false);
          setAppMessages((prev) =>
            prev.map((m, i) =>
              i === prev.length - 1 && m.role === 'assistant' && !m.timestamp
                ? { ...m, timestamp: new Date().toISOString() } : m
            )
          );
          // Mirror AI response to Telegram
          if (telegramEnabled && resolvedChatId && assistantSoFar.trim()) {
            void mirrorBrowserMessage('AI', assistantSoFar);
          }
        },
        onError: (err) => {
          toast({ title: 'AI Error', description: err, variant: 'destructive' });
          setIsLoading(false);
        },
      });
    } catch {
      toast({ title: 'Connection error', variant: 'destructive' });
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const formatTime = (ts?: string) => {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  /* ── Render ────────────────────────── */
  const runningRuns = activeAgentRuns;
  const hasRunning = runningRuns.length > 0;

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col overflow-hidden bg-gradient-to-b from-background via-background to-secondary/20 md:h-[100dvh]">
      {/* Header — compact, sticky */}
      <header className="shrink-0 border-b bg-background/80 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/60 shadow-sm">
              <Sparkles className="h-4 w-4 text-primary-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">AI Assistant</h1>
              <p className="truncate text-[11px] text-muted-foreground">
                Agentic chat · skills · memory · live process flow
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {hasRunning && (
              <Badge variant="secondary" className="hidden gap-1.5 sm:flex">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                {runningRuns.length} running
              </Badge>
            )}
            <TelegramIndicator connected={telegramSynced} count={telegramMessages?.length ?? 0} />
          </div>
        </div>
      </header>

      {/* Main grid — chat left, live activity right */}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        {/* Chat column */}
        <section className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto overscroll-contain" ref={scrollRef}>
            <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                    <Bot className="h-7 w-7 text-primary" />
                  </div>
                  <h2 className="text-lg font-semibold">How can I help today?</h2>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    Quick questions stay conversational. Bigger requests launch a real agent run with live tool steps you can watch on the right.
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    {SUGGESTED_PROMPTS.map((q) => (
                      <button key={q} onClick={() => setInput(q)}
                        className="rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-foreground">
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {msg.role === 'assistant' && (
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                          <Bot className="h-4 w-4 text-primary" />
                        </div>
                      )}
                      <div className={`flex flex-col max-w-[88%] lg:max-w-[78%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                        {msg.source === 'telegram' && (
                          <div className="mb-1 flex items-center gap-1">
                            <MessageCircle className="h-3 w-3 text-sky-500" />
                            <span className="text-[10px] font-medium text-sky-500">Telegram</span>
                          </div>
                        )}

                        {msg.files && msg.files.length > 0 && (
                          <div className="mb-2 flex flex-wrap gap-2">
                            {msg.files.filter((f) => f.isImage).map((f) => (
                              <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"
                                className="block max-w-[280px] overflow-hidden rounded-xl border shadow-sm transition-shadow hover:shadow-md">
                                <img src={f.url} alt={f.name} className="h-auto max-h-48 w-full object-cover" />
                              </a>
                            ))}
                            {msg.files.filter((f) => !f.isImage && f.type?.startsWith('video/')).map((f) => (
                              <div key={f.id} className="max-w-[320px] overflow-hidden rounded-xl border shadow-sm">
                                <video src={f.url} controls preload="metadata" className="max-h-52 w-full rounded-t-xl" />
                                <div className="flex items-center gap-2 bg-secondary/50 px-3 py-1.5">
                                  <Video className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                  <p className="flex-1 truncate text-xs font-medium">{f.name}</p>
                                  <a href={f.url} target="_blank" rel="noopener noreferrer">
                                    <Download className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                                  </a>
                                </div>
                              </div>
                            ))}
                            {msg.files.filter((f) => !f.isImage && !f.type?.startsWith('video/')).map((f) => (
                              <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"
                                className="flex items-center gap-2 rounded-lg border bg-secondary/50 px-3 py-2 transition-colors hover:bg-secondary">
                                <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-medium">{f.name}</p>
                                  <p className="text-[10px] text-muted-foreground">{f.size}</p>
                                </div>
                                <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
                              </a>
                            ))}
                          </div>
                        )}

                        {msg.role === 'assistant' && msg.content && (msg.content.match(AGENT_RUN_MARKER_RE) || []).map((m, idx) => {
                          const id = m.replace(AGENT_RUN_MARKER_PREFIX, '');
                          return <div key={idx} className="mb-2 w-full"><AgentRunPanel runId={id} /></div>;
                        })}

                        {msg.content && (
                          <div className={`max-w-full overflow-hidden rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                            msg.role === 'user'
                              ? msg.source === 'telegram'
                                ? 'bg-sky-100 text-sky-900 dark:bg-sky-900/30 dark:text-sky-100'
                                : 'bg-primary text-primary-foreground'
                              : 'border bg-card text-card-foreground'
                          }`}>
                            {msg.role === 'assistant' ? (
                              <div className="prose prose-sm max-w-none break-words prose-neutral dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:break-all [&_code]:text-xs [&_img]:my-3 [&_img]:max-h-80 [&_img]:w-full [&_img]:rounded-lg [&_img]:object-cover [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted">
                                <ReactMarkdown>{msg.content.replace(AGENT_RUN_MARKER_LINE_RE, '')}</ReactMarkdown>
                              </div>
                            ) : (
                              <span className="whitespace-pre-wrap break-words">{msg.content}</span>
                            )}
                          </div>
                        )}

                        {msg.timestamp && (
                          <span className={`mt-1 px-1 text-[10px] text-muted-foreground/50 ${msg.role === 'user' ? 'text-right' : ''}`}>
                            {formatTime(msg.timestamp)}
                          </span>
                        )}
                      </div>
                      {msg.role === 'user' && (
                        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                          msg.source === 'telegram' ? 'bg-sky-100 dark:bg-sky-900/30' : 'bg-muted'
                        }`}>
                          {msg.source === 'telegram' ? (
                            <MessageCircle className="h-4 w-4 text-sky-500" />
                          ) : (
                            <User className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {(isLoading || hasRunning) && messages[messages.length - 1]?.role !== 'assistant' && (
                    <div className="flex gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                        <Bot className="h-4 w-4 text-primary" />
                      </div>
                      <div className="rounded-2xl border bg-card px-4 py-3 shadow-sm">
                        <div className="flex items-center gap-2">
                          <div className="flex gap-1.5">
                            <span className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:0ms]" />
                            <span className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:150ms]" />
                            <span className="h-2 w-2 animate-bounce rounded-full bg-primary/60 [animation-delay:300ms]" />
                          </div>
                          {hasRunning && (
                            <span className="text-[11px] text-muted-foreground">
                              Agent is working — see live steps on the right →
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Composer — sticky at bottom */}
          <div className="shrink-0 border-t bg-background/95 backdrop-blur-sm">
            <div className="mx-auto max-w-3xl px-3 py-3 md:px-6">
              {pendingFiles.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {pendingFiles.map((f) => (
                    <div key={f.id} className="group relative">
                      {f.isImage ? (
                        <div className="h-14 w-14 overflow-hidden rounded-lg border shadow-sm">
                          <img src={f.url} alt={f.name} className="h-full w-full object-cover" />
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 shadow-sm">
                          <FileIcon className="h-4 w-4 text-muted-foreground" />
                          <span className="max-w-[120px] truncate text-xs">{f.name}</span>
                        </div>
                      )}
                      <button onClick={() => removePendingFile(f.id)}
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-1.5 rounded-2xl border bg-background p-1.5 shadow-sm focus-within:ring-1 focus-within:ring-ring sm:gap-2 sm:p-2">
                <input ref={fileInputRef} type="file" accept="image/*,video/*,.txt,.md,.csv,.json,.pdf,.doc,.docx" multiple className="hidden" onChange={handleFileSelect} />
                <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
                  onClick={() => fileInputRef.current?.click()} disabled={isLoading}>
                  <Paperclip className="h-4 w-4" />
                </Button>

                <Button variant={voice.recording ? 'destructive' : 'ghost'} size="icon"
                  className={`hidden h-9 w-9 shrink-0 rounded-xl sm:flex ${!voice.recording ? 'text-muted-foreground hover:text-foreground' : ''}`}
                  onClick={handleVoiceToggle} disabled={isLoading}>
                  {voice.recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>

                {voice.recording && (
                  <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-2 py-1.5">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
                    <span className="tabular-nums text-xs font-medium text-destructive">{voice.duration}s</span>
                  </div>
                )}

                <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                  placeholder={voice.recording ? 'Recording…' : 'Ask anything, or describe a workflow…'}
                  className="min-h-[40px] max-h-32 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus-visible:ring-0 disabled:opacity-50"
                  rows={1} disabled={voice.recording} />

                <Button onClick={send} disabled={(!input.trim() && pendingFiles.length === 0) || isLoading || voice.recording}
                  size="icon" className="h-9 w-9 shrink-0 rounded-xl">
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
              <p className="mt-2 px-1 text-center text-[10px] text-muted-foreground">
                Press Enter to send · Shift+Enter for new line
              </p>
            </div>
          </div>
        </section>

        {/* Live activity sidebar — shows only what's running NOW */}
        <aside className="hidden min-h-0 flex-col border-l bg-secondary/20 lg:flex">
          <div className="shrink-0 border-b bg-background/60 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Activity className={`h-4 w-4 ${hasRunning ? 'animate-pulse text-primary' : 'text-muted-foreground'}`} />
                <h2 className="text-sm font-semibold">Live Process Flow</h2>
              </div>
              <Link to="/queue">
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                  <ListChecks className="h-3 w-3" />
                  Job Queue
                  <ExternalLink className="h-2.5 w-2.5" />
                </Button>
              </Link>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {hasRunning
                ? `Watching ${runningRuns.length} active run${runningRuns.length > 1 ? 's' : ''} — past runs live in the Job Queue.`
                : 'Idle. Active runs will stream here step-by-step.'}
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {hasRunning ? (
              runningRuns.map((run) => <AgentRunPanel key={run.id} runId={run.id} />)
            ) : (
              <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed bg-background/40 p-6 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                  <Cpu className="h-6 w-6 text-primary/60" />
                </div>
                <p className="text-sm font-medium text-foreground">No active runs</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Ask for research, an app build, content generation, or any workflow — the agent will spin up here with live tool steps.
                </p>
                {(recentAgentRuns?.length ?? 0) > 0 && (
                  <Link to="/queue" className="mt-4">
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                      <ListChecks className="h-3 w-3" />
                      View {recentAgentRuns?.length} past run{(recentAgentRuns?.length ?? 0) > 1 ? 's' : ''}
                    </Button>
                  </Link>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Mobile floating live runs banner */}
      {hasRunning && (
        <div className="fixed bottom-24 left-3 right-3 z-20 rounded-xl border bg-background/95 p-2.5 shadow-lg backdrop-blur-sm lg:hidden">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 animate-pulse text-primary" />
            <span className="text-xs font-medium">{runningRuns.length} agent run{runningRuns.length > 1 ? 's' : ''} active</span>
            <Link to="/queue" className="ml-auto">
              <Button variant="outline" size="sm" className="h-7 text-[11px]">View</Button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
