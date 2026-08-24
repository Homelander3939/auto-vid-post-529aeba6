import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSettings } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ExternalLink, Monitor, RefreshCw, Eye, AlertCircle, Brain, Bot, Globe2, Play, ShieldCheck, CheckCircle2, Circle, RotateCcw, XCircle } from 'lucide-react';

type BrowserJob = any;
type RunningSession = { id: string; status?: string; startedAt?: string; createdAt?: string };
type AIStep = { step: number; action: string; reasoning: string; timestamp: string };
type LocalBrowserEvent = { step?: number; action?: string; ok?: boolean; message?: string; url?: string | null; at?: string; phase?: string; state_changed?: boolean | null; screenshot_key?: string | null; download_path?: string | null };
type BrowserVerificationCheck = { id: string; label?: string; passed?: boolean; detail?: string };
type BrowserMilestone = { id: string; label: string; complete?: boolean };
type BrowserCheckpoint = {
  safe_to_resume?: boolean;
  resume_blocker?: string | null;
  saved_at?: string;
  last_url?: string;
  contract?: { checks?: BrowserVerificationCheck[]; milestones?: BrowserMilestone[] };
  progress?: { current?: BrowserMilestone; rows?: BrowserMilestone[] } | null;
  verification?: { checks?: BrowserVerificationCheck[] } | null;
};
type LocalBrowserSession = {
  id: string;
  task: string;
  start_url?: string;
  source?: string;
  status: string;
  current_url?: string;
  current_title?: string;
  events?: LocalBrowserEvent[];
  summary?: string;
  error?: string;
  result?: { summary?: string; page_text_excerpt?: string; verification?: { checks?: BrowserVerificationCheck[] } | null };
  checkpoint?: BrowserCheckpoint;
  has_private_input?: boolean;
  screenshot_available?: boolean;
  screenshot_version?: number;
  agent_model?: string;
  vision_enabled?: boolean;
  tool_calling_enabled?: boolean;
  framework_version?: number;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
};

const LOCAL_BROWSER_API = 'http://127.0.0.1:3001';

function LocalBrowserSessions() {
  const requestedSession = new URLSearchParams(window.location.search).get('session');
  const [selectedId, setSelectedId] = useState<string | null>(requestedSession);
  const [task, setTask] = useState('');
  const [url, setUrl] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const [previewScreenshotKey, setPreviewScreenshotKey] = useState<string | null>(null);

  const { data: sessions = [], refetch, isFetching } = useQuery({
    queryKey: ['local-browser-sessions'],
    queryFn: async () => {
      const response = await fetch(`${LOCAL_BROWSER_API}/api/local-browser/sessions`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `Local browser returned HTTP ${response.status}`);
      return (Array.isArray(payload.sessions) ? payload.sessions : []) as LocalBrowserSession[];
    },
    refetchInterval: 1500,
  });

  useEffect(() => {
    if (selectedId && sessions.some((session) => session.id === selectedId)) return;
    const active = sessions.find((session) => ['queued', 'running'].includes(session.status));
    setSelectedId(active?.id || sessions[0]?.id || null);
  }, [sessions, selectedId]);

  const selected = sessions.find((session) => session.id === selectedId) || null;
  const events = Array.isArray(selected?.events) ? selected.events : [];
  const milestoneRows = selected?.checkpoint?.progress?.rows || selected?.checkpoint?.contract?.milestones || [];
  const verificationChecks = selected?.result?.verification?.checks
    || selected?.checkpoint?.verification?.checks
    || selected?.checkpoint?.contract?.checks
    || [];

  useEffect(() => setPreviewScreenshotKey(null), [selectedId]);

  const screenshotUrl = selected && previewScreenshotKey
    ? `${LOCAL_BROWSER_API}/api/local-browser/sessions/${selected.id}/screenshots/${encodeURIComponent(previewScreenshotKey)}`
    : selected ? `${LOCAL_BROWSER_API}/api/local-browser/sessions/${selected.id}/screenshot?v=${selected.screenshot_version || selected.updated_at || ''}` : '';

  const startSession = async () => {
    if (!task.trim()) return;
    setStarting(true);
    setStartError('');
    try {
      const response = await fetch(`${LOCAL_BROWSER_API}/api/local-browser/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: task.trim(), url: url.trim() || null, source: 'browser-page' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `Local browser returned HTTP ${response.status}`);
      setTask('');
      await refetch();
      setSelectedId(payload.session_id);
    } catch (error: any) {
      setStartError(error?.message || String(error));
    } finally {
      setStarting(false);
    }
  };

  const resumeSession = async () => {
    if (!selected) return;
    setResuming(true);
    setResumeError('');
    try {
      const response = await fetch(`${LOCAL_BROWSER_API}/api/local-browser/sessions/${selected.id}/resume`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `Local browser returned HTTP ${response.status}`);
      await refetch();
    } catch (error: any) {
      setResumeError(error?.message || String(error));
    } finally {
      setResuming(false);
    }
  };

  const statusVariant = (status?: string) => {
    if (status === 'completed') return 'default' as const;
    if (status === 'failed') return 'destructive' as const;
    return 'secondary' as const;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Local Chromium Browser</h1>
          <p className="text-muted-foreground mt-1 text-sm">Watch Qwen operate the visible browser on this PC — no Browserbase or cloud login.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Play className="w-4 h-4" />Run a local browser task</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Optional starting URL, for example https://example.com" />
          <Textarea value={task} onChange={(event) => setTask(event.target.value)} placeholder="Describe the exact task. Example: inspect this page and summarize the visible headings." rows={3} />
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <Button onClick={startSession} disabled={starting || !task.trim()}>
              <Globe2 className="w-4 h-4 mr-2" />{starting ? 'Starting…' : 'Open local Chromium'}
            </Button>
            <p className="text-xs text-muted-foreground">The real Chromium window opens on your desktop. This page mirrors screenshots and safe action summaries.</p>
          </div>
          {startError && <p className="text-sm text-destructive">{startError}</p>}
        </CardContent>
      </Card>

      {selected ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="overflow-hidden">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-sm truncate">{selected.task}</CardTitle>
                  <p className="text-xs text-muted-foreground truncate mt-1">{selected.current_title || selected.current_url || selected.start_url}</p>
                </div>
                <Badge variant={statusVariant(selected.status)}>{selected.status}</Badge>
              </div>
              <div className="flex gap-2 flex-wrap pt-2">
                <Badge variant="outline">Framework v{selected.framework_version || 1}</Badge>
                <Badge variant="outline">Vision {selected.vision_enabled ? 'on' : 'off'}</Badge>
                <Badge variant="outline">Tool calling {selected.tool_calling_enabled ? 'on' : 'fallback'}</Badge>
                {selected.agent_model && <Badge variant="outline" className="max-w-[260px] truncate">{selected.agent_model}</Badge>}
                {selected.checkpoint?.progress?.current?.label && <Badge variant="outline" className="max-w-[360px] truncate">Current: {selected.checkpoint.progress.current.label}</Badge>}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg overflow-hidden border bg-muted/20 min-h-[320px] flex items-center justify-center">
                {selected.screenshot_available ? (
                  <img
                    src={screenshotUrl}
                    alt={previewScreenshotKey ? 'Selected browser-step screenshot' : 'Latest local Chromium screenshot'}
                    className="block w-full h-auto max-h-[620px] object-contain"
                  />
                ) : (
                  <div className="py-20 text-center text-sm text-muted-foreground">
                    <Monitor className="w-10 h-10 mx-auto mb-3 opacity-40" />
                    {selected.status === 'queued' ? 'Waiting for the local Chromium worker…' : 'Screenshot will appear after navigation.'}
                  </div>
                )}
              </div>
              {(selected.summary || selected.error) && (
                <div className="rounded-md border p-3 text-sm whitespace-pre-wrap">{selected.summary || selected.error}</div>
              )}
              {(milestoneRows.length > 0 || verificationChecks.length > 0) && (
                <div className="grid gap-3 lg:grid-cols-2">
                  {milestoneRows.length > 0 && (
                    <div className="rounded-md border p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Task milestones</p>
                      <div className="space-y-2">
                        {milestoneRows.map((item) => (
                          <div key={item.id} className="flex items-start gap-2 text-xs">
                            {item.complete ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> : <Circle className="w-4 h-4 text-muted-foreground shrink-0" />}
                            <span>{item.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {verificationChecks.length > 0 && (
                    <div className="rounded-md border p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Completion proof</p>
                      <div className="space-y-2">
                        {verificationChecks.map((item) => (
                          <div key={item.id} className="flex items-start gap-2 text-xs">
                            {item.passed === true ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> : item.passed === false ? <XCircle className="w-4 h-4 text-destructive shrink-0" /> : <Circle className="w-4 h-4 text-muted-foreground shrink-0" />}
                            <div><p>{item.label || item.id}</p>{item.detail && <p className="text-muted-foreground mt-0.5">{item.detail}</p>}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {selected.checkpoint && !['queued', 'running', 'completed'].includes(selected.status) && (
                <div className="rounded-md border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="text-xs">
                    <p className="font-medium">Safe local checkpoint available</p>
                    <p className="text-muted-foreground mt-1">{selected.checkpoint.safe_to_resume ? 'Resume from the last verified page without repeating completed steps.' : selected.checkpoint.resume_blocker}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={resumeSession} disabled={resuming || selected.checkpoint.safe_to_resume !== true}>
                    <RotateCcw className={`w-4 h-4 mr-2 ${resuming ? 'animate-spin' : ''}`} />{resuming ? 'Resuming…' : 'Resume'}
                  </Button>
                </div>
              )}
              {resumeError && <p className="text-sm text-destructive">{resumeError}</p>}
              {selected.current_url && (
                <a href={selected.current_url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                  <ExternalLink className="w-3 h-3" />{selected.current_url}
                </a>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Bot className="w-4 h-4" />Browser action log</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px] pr-3">
                <div className="space-y-3">
                  {events.length ? events.map((event, index) => (
                    <button key={`${event.at}-${index}`} type="button" onClick={() => event.screenshot_key && setPreviewScreenshotKey(event.screenshot_key)} className={`w-full text-left flex gap-2 text-xs rounded-md p-1.5 ${event.screenshot_key ? 'hover:bg-muted/60 cursor-pointer' : 'cursor-default'}`}>
                      <span className="shrink-0 mt-0.5">{event.action === 'blocked' ? '🛑' : event.ok === false ? '⚠️' : '🧭'}</span>
                      <div className="min-w-0">
                        <p className="font-medium">{event.step ? `Step ${event.step}: ` : ''}{event.action || 'working'}{event.phase ? ` · ${event.phase}` : ''}</p>
                        <p className="text-muted-foreground leading-relaxed mt-0.5">{event.message}</p>
                        {event.state_changed === false && <p className="text-amber-500 mt-1">No visible state change; agent will choose another strategy.</p>}
                        {event.screenshot_key && <p className="text-primary mt-1">View this step’s screenshot</p>}
                        {event.at && <p className="text-muted-foreground/70 mt-1">{new Date(event.at).toLocaleTimeString()}</p>}
                      </div>
                    </button>
                  )) : <p className="text-sm text-muted-foreground">No actions recorded yet.</p>}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card className="border-dashed"><CardContent className="py-12 text-center text-sm text-muted-foreground">No local Chromium sessions yet. Start one here or ask AI Chat to use the Local Chromium Browser Operator skill.</CardContent></Card>
      )}

      {sessions.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Recent local sessions</h2>
          {sessions.map((session) => (
            <button key={session.id} type="button" onClick={() => setSelectedId(session.id)} className={`w-full text-left rounded-lg border p-3 transition-colors ${selectedId === session.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium truncate">{session.task}</p>
                <Badge variant={statusVariant(session.status)}>{session.status}</Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{session.created_at ? new Date(session.created_at).toLocaleString() : session.id}</p>
            </button>
          ))}
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4" />Local browser safety</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>The framework takes a fresh screenshot and DOM snapshot before every decision, executes one browser tool, captures the result, and verifies whether the visible state changed.</p>
          <p>It supports navigation, forms, saved login sessions, keyboard actions, hover menus, tabs/popups, downloads, and explicitly requested uploads or submissions. Human verification, payments, transfers, purchases, and account-security changes pause for you.</p>
          <p>Every enabled Agent Skill is included in fresh AI Chat and Telegram context. Logs show concise decisions and per-step screenshots without exposing typed secrets.</p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function BrowserSessions() {
  const [loading, setLoading] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [runningSessions, setRunningSessions] = useState<RunningSession[]>([]);
  const [debugUrls, setDebugUrls] = useState<Record<string, string>>({});
  const [showAILog, setShowAILog] = useState(true);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const isCloud = settings?.uploadMode === 'cloud';

  const { data: recentJobs, refetch: refetchJobs } = useQuery({
    queryKey: ['browser-sessions-jobs'],
    queryFn: async () => {
      const { data } = await supabase
        .from('upload_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(40);
      return (data || []) as BrowserJob[];
    },
    refetchInterval: 3000,
  });

  const fetchRunningSessions = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase.functions.invoke('cloud-browser-status', { body: {} });
      const sessions = Array.isArray(data?.sessions)
        ? data.sessions
        : Array.isArray(data?.sessions?.data)
          ? data.sessions.data
          : [];
      setRunningSessions(sessions);
      setDebugUrls(data?.debugUrls || {});

      if (!expandedSession && sessions.length > 0) {
        setExpandedSession(sessions[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch running sessions:', error);
      setRunningSessions([]);
      setDebugUrls({});
    } finally {
      setLoading(false);
    }
  }, [expandedSession]);

  useEffect(() => {
    if (!isCloud) return;
    fetchRunningSessions();
    const interval = setInterval(fetchRunningSessions, 8000);
    return () => clearInterval(interval);
  }, [isCloud, fetchRunningSessions]);

  const getBrowserbaseUrl = (sessionId: string) => `https://www.browserbase.com/sessions/${sessionId}`;

  const jobsBySession = new Map(
    (recentJobs || [])
      .filter((job: BrowserJob) => !!job.browserbase_session_id)
      .map((job: BrowserJob) => [job.browserbase_session_id, job]),
  );

  const completedJobs = (recentJobs || []).filter(
    (job: BrowserJob) => !!job.browserbase_session_id && ['completed', 'partial', 'error'].includes(job.status),
  );

  // Extract AI steps from a job
  const getAISteps = (job: BrowserJob): AIStep[] => {
    const results = Array.isArray(job?.platform_results) ? job.platform_results : [];
    const aiLog = results.find((r: any) => r.name === '_ai_log');
    return aiLog?.steps || [];
  };

  const actionIcon = (action: string) => {
    switch (action) {
      case 'click': return '👆';
      case 'type': return '⌨️';
      case 'navigate': return '🧭';
      case 'wait': return '⏳';
      case 'scroll': return '📜';
      case 'upload_file': return '📁';
      case 'need_verification': return '🔐';
      case 'done': return '✅';
      default: return '🔄';
    }
  };

  if (!isCloud) {
    return <LocalBrowserSessions />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Browser Sessions</h1>
          <p className="text-muted-foreground mt-1 text-sm">AI-powered cloud browser automation</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showAILog ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowAILog(!showAILog)}
          >
            <Brain className="w-4 h-4 mr-1.5" />
            AI Log
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fetchRunningSessions();
              refetchJobs();
            }}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {runningSessions.length > 0 ? (
        <div className="space-y-4">
          {runningSessions.map((session) => {
            const job = jobsBySession.get(session.id);
            const isOpen = expandedSession === session.id;
            const liveUrl = debugUrls[session.id];
            const aiSteps = job ? getAISteps(job) : [];

            return (
              <Card key={session.id}>
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="space-y-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {job?.title || job?.video_file_name || `Session ${session.id.slice(0, 8)}`}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary" className="gap-1">
                          <Bot className="w-3 h-3" />
                          AI Agent
                        </Badge>
                        <Badge variant="outline">running</Badge>
                        {job?.status && <Badge variant="outline">job: {job.status}</Badge>}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button variant={isOpen ? 'default' : 'outline'} size="sm" onClick={() => setExpandedSession(isOpen ? null : session.id)}>
                        <Eye className="w-4 h-4 mr-1.5" />
                        <span className="hidden sm:inline">{isOpen ? 'Hide Live' : 'Watch Live'}</span>
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => window.open(getBrowserbaseUrl(session.id), '_blank')}>
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className={`grid gap-4 ${showAILog && aiSteps.length > 0 ? 'lg:grid-cols-[1fr_320px]' : ''}`}>
                      {/* Live browser stream */}
                      <div className="rounded-lg overflow-hidden border border-border bg-card">
                        {liveUrl ? (
                          <iframe
                            src={liveUrl}
                            title={`Live session ${session.id}`}
                            className="w-full"
                            style={{ height: 'min(620px, 60vh)' }}
                            allow="autoplay; clipboard-write"
                            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                          />
                        ) : (
                          <div className="py-10 text-center text-sm text-muted-foreground">
                            Loading live debug stream… click refresh if needed.
                          </div>
                        )}
                      </div>

                      {/* AI Decision Log */}
                      {showAILog && aiSteps.length > 0 && (
                        <Card className="border-dashed">
                          <CardHeader className="pb-2 pt-3 px-3">
                            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                              <Brain className="w-3.5 h-3.5" />
                              AI Reasoning
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="p-0">
                            <ScrollArea className="h-[min(540px,55vh)]">
                              <div className="px-3 pb-3 space-y-2">
                                {aiSteps.map((s, i) => (
                                  <div key={i} className="flex items-start gap-2 text-xs">
                                    <span className="shrink-0 mt-0.5">{actionIcon(s.action)}</span>
                                    <div className="min-w-0">
                                      <span className="font-medium text-foreground">{s.action}</span>
                                      <p className="text-muted-foreground leading-relaxed mt-0.5">{s.reasoning}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </ScrollArea>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Monitor className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              No active sessions. Start a cloud upload — the AI agent will drive the browser automatically.
            </p>
          </CardContent>
        </Card>
      )}

      {completedJobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Recent Sessions</h2>
          <div className="space-y-2">
            {completedJobs.map((job: BrowserJob) => {
              const aiSteps = getAISteps(job);

              return (
                <Card key={job.id}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{job.title || job.video_file_name}</p>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap text-xs text-muted-foreground">
                          <Badge variant={job.status === 'error' ? 'destructive' : 'secondary'}>{job.status}</Badge>
                          {aiSteps.length > 0 && (
                            <Badge variant="outline" className="gap-1">
                              <Bot className="w-3 h-3" />
                              {aiSteps.length} steps
                            </Badge>
                          )}
                          {(job.platform_results as any[])?.filter((pr: any) => pr.name !== '_ai_log').map((pr: any, i: number) => (
                            <span key={i}>
                              {pr.name}: {pr.status === 'success' ? '✅' : pr.status === 'error' ? '❌' : '⏳'}
                              {pr.url && (
                                <a href={pr.url} target="_blank" rel="noopener" className="ml-1 text-primary hover:underline">
                                  link
                                </a>
                              )}
                            </span>
                          ))}
                          <span>{job.created_at && new Date(job.created_at).toLocaleString()}</span>
                        </div>
                      </div>

                      <Button variant="ghost" size="sm" onClick={() => window.open(getBrowserbaseUrl(job.browserbase_session_id), '_blank')}>
                        <ExternalLink className="w-4 h-4 mr-1.5" />
                        <span className="hidden sm:inline">Recording</span>
                      </Button>
                    </div>

                    {/* Expandable AI log for completed jobs */}
                    {showAILog && aiSteps.length > 0 && (
                      <ScrollArea className="max-h-40 border rounded-md p-2">
                        <div className="space-y-1">
                          {aiSteps.map((s, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs">
                              <span className="shrink-0">{actionIcon(s.action)}</span>
                              <span className="text-muted-foreground">
                                <span className="font-medium text-foreground">{s.action}</span> — {s.reasoning}
                              </span>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            About AI Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>The AI agent uses vision to understand each page and decides the next action — like a human would.</p>
          <p>It handles login, verification (via Telegram), file upload, metadata entry, and publishing automatically.</p>
          <p>Toggle "AI Log" to see step-by-step reasoning alongside the live browser stream.</p>
        </CardContent>
      </Card>
    </div>
  );
}
