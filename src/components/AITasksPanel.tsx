// Compact panel showing recent AI agent activity (post generation, research, image search)
// pulled from social_posts + pending_commands + generation_jobs tables. Lives at the top of
// the Job Queue page. Live generation jobs show step-by-step progress mirrored from the
// edge function so the user can watch progress even after navigating away from /social.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Sparkles, Search, Image as ImageIcon, ExternalLink, ChevronDown, ChevronUp, Cpu, Globe, FileText, Hash, Loader2, CheckCircle2, AlertTriangle, X as XIcon, Trash2, CalendarClock, Play } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useState } from 'react';
import { listSocialPosts, getSocialImageUrl, listGenerationJobs, cancelGenerationJob, cancelAllRunningJobs, deleteGenerationJob, deletePendingCommand, deleteSocialPost, listAgentRuns, cancelAgentRun, deleteAgentRun, listGenerationSchedules, saveGenerationSchedule, deleteGenerationSchedule, runGenerationScheduleNow, type SocialPost, type GenerationJob, type AgentRun, type GenerationSchedule } from '@/lib/socialPosts';
import { useToast } from '@/hooks/use-toast';
import { Link } from 'react-router-dom';

interface PendingCommand {
  id: string;
  command: string;
  args: any;
  status: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

async function listRecentCommands(): Promise<PendingCommand[]> {
  const { data } = await (supabase as any)
    .from('pending_commands')
    .select('*')
    .in('command', ['research_search', 'image_search', 'open_browser', 'browser_research', 'check_stats'])
    .order('created_at', { ascending: false })
    .limit(8);
  return (data || []) as PendingCommand[];
}

const COMMAND_ICONS: Record<string, any> = {
  research_search: Search,
  image_search: ImageIcon,
  open_browser: Globe,
  browser_research: Globe,
  check_stats: Hash,
};
const COMMAND_LABELS: Record<string, string> = {
  research_search: 'Web research',
  image_search: 'Image search',
  open_browser: 'Browser task',
  browser_research: 'Local browser research',
  check_stats: 'Stats check',
};
const AGENT_RUN_RECENT_EVENT_TYPES = ['tool_call', 'tool_result', 'thought', 'error', 'review', 'phase', 'finish'];
const AGENT_RUN_RECENT_EVENT_LIMIT = 8;

function isCountableToolResult(event: AgentRun['events'][number]) {
  return event.type === 'tool_result' && event.name !== 'plan' && event.name !== 'finish' && event.ok !== false;
}

function statusColor(status: string): string {
  if (status === 'completed' || status === 'success') return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30';
  if (status === 'failed' || status === 'error') return 'bg-destructive/10 text-destructive border-destructive/30';
  if (status === 'cancelled') return 'bg-muted text-muted-foreground border-border';
  if (status === 'processing' || status === 'pending' || status === 'draft' || status === 'running') return 'bg-amber-500/15 text-amber-700 border-amber-500/30';
  return 'bg-secondary text-secondary-foreground';
}

function PostRow({ post, onDelete }: { post: SocialPost; onDelete: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const imageUrl = getSocialImageUrl(post.image_path);
  const variantCount = Object.keys(post.platform_variants || {}).length;
  const sourceCount = (post.ai_sources || []).length;
  const isAI = !!post.ai_prompt;

  return (
    <Card className="border bg-card/60">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-3">
          {imageUrl && (
            <img src={imageUrl} alt="" className="w-12 h-12 rounded-md object-cover border shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <Badge variant="outline" className="gap-1 text-[10px] h-5">
                {isAI ? <Sparkles className="w-2.5 h-2.5 text-primary" /> : <FileText className="w-2.5 h-2.5" />}
                {isAI ? 'AI Post' : 'Manual Post'}
              </Badge>
              <Badge variant="outline" className={`text-[10px] h-5 ${statusColor(post.status)}`}>
                {post.status}
              </Badge>
              {post.target_platforms.map((p) => (
                <Badge key={p} variant="secondary" className="text-[10px] h-5 capitalize">{p}</Badge>
              ))}
              <span className="text-[10px] text-muted-foreground ml-auto">
                {new Date(post.created_at).toLocaleString()}
              </span>
            </div>
            {post.ai_prompt && (
              <p className="text-xs text-muted-foreground italic line-clamp-1">"{post.ai_prompt}"</p>
            )}
            <p className="text-xs line-clamp-2 mt-1">{post.description}</p>
            <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
              {variantCount > 0 && <span>📝 {variantCount} variant{variantCount === 1 ? '' : 's'}</span>}
              {sourceCount > 0 && <span>🔗 {sourceCount} source{sourceCount === 1 ? '' : 's'}</span>}
              {post.hashtags.length > 0 && <span>#️⃣ {post.hashtags.length} tags</span>}
            </div>
          </div>
          <div className="flex flex-col gap-1 items-end">
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              title="Delete from queue"
              onClick={() => onDelete(post.id)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground"
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
        {expanded && (
          <div className="border-t pt-2 space-y-1.5 text-[11px]">
            {post.ai_prompt && (
              <div><span className="font-medium text-muted-foreground">Prompt:</span> {post.ai_prompt}</div>
            )}
            {variantCount > 0 && (
              <div className="space-y-1">
                <div className="font-medium text-muted-foreground">Variants:</div>
                {Object.entries(post.platform_variants).map(([p, v]: [string, any]) => (
                  <div key={p} className="rounded bg-muted/40 px-2 py-1">
                    <span className="capitalize font-medium">{p}:</span>{' '}
                    <span className="text-muted-foreground">{v.description?.slice(0, 120)}…</span>
                  </div>
                ))}
              </div>
            )}
            {sourceCount > 0 && (
              <div>
                <span className="font-medium text-muted-foreground">Sources:</span>
                <div className="space-y-0.5 mt-1">
                  {(post.ai_sources || []).slice(0, 5).map((s: any, i: number) => (
                    <a key={i} href={s.url} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-primary hover:underline truncate">
                      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">{s.title || s.url}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
            {post.platform_results.length > 0 && (
              <div className="space-y-0.5">
                <div className="font-medium text-muted-foreground">Results:</div>
                {post.platform_results.map((r) => (
                  <div key={r.name} className="text-[11px] capitalize">
                    {r.name}: <span className={r.status === 'success' ? 'text-emerald-600' : r.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                      {r.status}{r.url ? ` — ${r.url}` : ''}{r.error ? ` — ${r.error}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CommandRow({ cmd, onDelete }: { cmd: PendingCommand; onDelete: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = COMMAND_ICONS[cmd.command] || Cpu;
  const label = COMMAND_LABELS[cmd.command] || cmd.command;
  let resultPreview = '';
  let resultCount = 0;
  let parsedResult: any = null;
  try {
    if (cmd.result) {
      parsedResult = JSON.parse(cmd.result);
      if (Array.isArray(parsedResult?.results)) resultCount = parsedResult.results.length;
      if (Array.isArray(parsedResult?.sources)) resultCount = parsedResult.sources.length;
      resultPreview = parsedResult?.summary
        || parsedResult?.results?.[0]?.title
        || parsedResult?.sources?.[0]?.title
        || cmd.result.slice(0, 80);
    }
  } catch { resultPreview = cmd.result?.slice(0, 80) || ''; }

  const links: Array<{ kind?: string; label?: string; url?: string }> = Array.isArray(parsedResult?.links) ? parsedResult.links : [];
  const sourceLinks = links.filter((l) => l.kind !== 'screenshot');
  const screenshotLinks = links.filter((l) => l.kind === 'screenshot');

  return (
    <Card className="border bg-card/60">
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <span className="text-xs font-medium">{label}</span>
              <Badge variant="outline" className={`text-[10px] h-5 ${statusColor(cmd.status)}`}>
                {cmd.status}
              </Badge>
              {resultCount > 0 && (
                <Badge variant="secondary" className="text-[10px] h-5">{resultCount} sources</Badge>
              )}
              {screenshotLinks.length > 0 && (
                <Badge variant="secondary" className="text-[10px] h-5">📸 {screenshotLinks.length}</Badge>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto">
                {new Date(cmd.created_at).toLocaleString()}
              </span>
            </div>
            {(cmd.args?.query || parsedResult?.query) && (
              <p className="text-xs text-muted-foreground line-clamp-1">"{cmd.args?.query || parsedResult?.query}"</p>
            )}
            {resultPreview && cmd.status === 'completed' && (
              <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">→ {resultPreview}</p>
            )}
            {cmd.status === 'completed' && (sourceLinks.length > 0 || screenshotLinks.length > 0) && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {sourceLinks.slice(0, 4).map((link, i) => (
                  <a key={`src-${i}`} href={link.url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-primary/30 text-primary hover:bg-primary/10 max-w-[200px] truncate">
                    <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{link.label || link.url}</span>
                  </a>
                ))}
                {screenshotLinks.map((link, i) => (
                  <a key={`shot-${i}`} href={link.url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10">
                    <ImageIcon className="w-2.5 h-2.5" />
                    {link.label || `Screenshot ${i + 1}`}
                  </a>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1 items-end">
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              title="Delete from queue"
              onClick={() => onDelete(cmd.id)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground"
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
        {expanded && cmd.result && (
          <pre className="mt-2 border-t pt-2 text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap break-words">
            {(() => { try { return JSON.stringify(JSON.parse(cmd.result), null, 2); } catch { return cmd.result; } })()}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function GenerationJobRow({ job, onCancel, onDelete }: { job: GenerationJob; onCancel: (id: string) => void; onDelete: (id: string) => void }) {
  const [expanded, setExpanded] = useState(job.status === 'running');
  const [cancelling, setCancelling] = useState(false);
  const events = (job.events || []) as any[];
  const steps = events.filter((e) => e.type === 'step') as any[];
  // Reduce to latest status per step id
  const stepMap = new Map<string, any>();
  for (const s of steps) stepMap.set(s.id, s);
  const stepList = Array.from(stepMap.values());
  const doneCount = stepList.filter((s) => s.status === 'done').length;
  const totalCount = Math.max(stepList.length, 1);
  const pct = job.status === 'completed' ? 100 : Math.round((doneCount / totalCount) * 100);
  const current = stepList.find((s) => s.status === 'active') || stepList[stepList.length - 1];
  const tools = events.filter((e) => e.type === 'tool');
  const sources = events.filter((e) => e.type === 'source');
  const variants = events.filter((e) => e.type === 'variant');

  const StatusIcon = job.status === 'completed' ? CheckCircle2
    : job.status === 'failed' || job.status === 'cancelled' ? AlertTriangle
    : Loader2;
  const iconClass = job.status === 'completed' ? 'text-emerald-500'
    : job.status === 'failed' ? 'text-destructive'
    : job.status === 'cancelled' ? 'text-muted-foreground'
    : 'text-primary animate-spin';

  return (
    <Card className={`border bg-card/60 ${job.status === 'running' ? 'border-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]' : ''}`}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <span className="text-xs font-medium">AI Post Generation</span>
              <Badge variant="outline" className={`text-[10px] h-5 ${statusColor(job.status)} gap-1`}>
                <StatusIcon className={`w-2.5 h-2.5 ${iconClass}`} />
                {job.status}
              </Badge>
              {(job.platforms || []).map((p) => (
                <Badge key={p} variant="secondary" className="text-[10px] h-5 capitalize">{p}</Badge>
              ))}
              <span className="text-[10px] text-muted-foreground ml-auto">
                {new Date(job.created_at).toLocaleString()}
              </span>
            </div>
            {job.prompt && (
              <p className="text-xs text-muted-foreground italic line-clamp-1">"{job.prompt}"</p>
            )}
            {current && (
              <p className="text-[11px] mt-1 truncate">
                <span className="mr-1">{current.emoji}</span>{current.label}
              </p>
            )}
            <div className="flex items-center gap-2 mt-1.5">
              <Progress value={pct} className="h-1.5 flex-1" />
              <span className="text-[10px] text-muted-foreground tabular-nums">{doneCount}/{stepList.length}</span>
            </div>
            <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
              {tools.length > 0 && <span>🔧 {tools.length} tool{tools.length === 1 ? '' : 's'}</span>}
              {sources.length > 0 && <span>🔗 {sources.length} source{sources.length === 1 ? '' : 's'}</span>}
              {variants.length > 0 && <span>📝 {variants.length} variant{variants.length === 1 ? '' : 's'}</span>}
              {job.saved_post_id && <Link to={`/social?post=${job.saved_post_id}`} className="text-primary hover:underline">→ View draft</Link>}
            </div>
          </div>
          <div className="flex flex-col gap-1 items-end">
            {job.status === 'running' && (
              <Button
                variant="outline" size="sm"
                className="h-7 text-[11px] gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                disabled={cancelling}
                onClick={async () => {
                  setCancelling(true);
                  try { await onCancel(job.id); } finally { setCancelling(false); }
                }}
              >
                <XIcon className="w-3 h-3" /> {cancelling ? 'Cancelling…' : 'Cancel'}
              </Button>
            )}
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                title="Delete from queue"
                onClick={() => onDelete(job.id)}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground"
                onClick={() => setExpanded((e) => !e)}>
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>
        </div>
        {expanded && stepList.length > 0 && (
          <div className="border-t pt-2 space-y-1 max-h-64 overflow-y-auto">
            {stepList.map((s, i) => (
              <div key={s.id + i} className="text-[11px] flex items-start gap-1.5">
                <span className="shrink-0">{s.emoji}</span>
                <span className={
                  s.status === 'done' ? 'text-muted-foreground'
                  : s.status === 'error' ? 'text-destructive'
                  : 'text-foreground font-medium'
                }>{s.label}</span>
              </div>
            ))}
            {job.error && <div className="text-[11px] text-destructive border-t pt-1.5 mt-1.5">{job.error}</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AgentRunRow({ run, onCancel, onDelete }: { run: AgentRun; onCancel: (id: string) => void; onDelete: (id: string) => void }) {
  const [expanded, setExpanded] = useState(run.status === 'running');
  const [cancelling, setCancelling] = useState(false);
  const events = Array.isArray(run.events) ? run.events : [];
  const planEvent = [...events].reverse().find((event) => event.type === 'plan');
  const plan = Array.isArray(planEvent?.steps) ? planEvent.steps : [];
  const recent = events
    .filter((event) => AGENT_RUN_RECENT_EVENT_TYPES.includes(event.type))
    .slice(-AGENT_RUN_RECENT_EVENT_LIMIT);
  const completedToolCount = events.filter(isCountableToolResult).length;
  const latestToolCall = [...events].reverse().find((event) => event.type === 'tool_call');
  const latestThought = [...events].reverse().find((event) => event.type === 'thought');
  const latestError = [...events].reverse().find((event) => event.type === 'error');
  const latestFinish = [...events].reverse().find((event) => event.type === 'finish');
  const currentLabel = latestError?.message
    || latestToolCall?.label
    || latestToolCall?.name
    || latestThought?.text
    || latestFinish?.summary
    || (run.status === 'running' ? 'Agent is thinking…' : 'Run completed');
  const totalCount = Math.max(plan.length || completedToolCount, 1);
  const pct = run.status === 'completed'
    ? 100
    : run.status === 'cancelled' || run.status === 'failed'
      ? Math.min(99, Math.round((completedToolCount / totalCount) * 100))
      : Math.round((completedToolCount / totalCount) * 100);
  const sourceLabel = run.source === 'ai-chat' ? 'chat' : run.source;

  return (
    <Card className={`border bg-card/60 ${run.status === 'running' ? 'border-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]' : ''}`}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
            <Cpu className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <span className="text-xs font-medium">Autonomous Agent</span>
              <Badge variant="outline" className={`text-[10px] h-5 ${statusColor(run.status)} gap-1`}>
                {run.status === 'running' ? <Loader2 className="w-2.5 h-2.5 animate-spin text-primary" /> : run.status === 'completed' ? <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" /> : <AlertTriangle className="w-2.5 h-2.5" />}
                {run.status}
              </Badge>
              <Badge variant="secondary" className="text-[10px] h-5 capitalize">{sourceLabel}</Badge>
              {run.automation_mode && <Badge variant="secondary" className="text-[10px] h-5">{run.automation_mode}</Badge>}
              <span className="text-[10px] text-muted-foreground ml-auto">
                {new Date(run.created_at).toLocaleString()}
              </span>
            </div>
            <p className="text-xs text-muted-foreground italic line-clamp-1">"{run.prompt}"</p>
            {currentLabel && (
              <p className="text-[11px] mt-1 truncate">
                <span className="mr-1">{run.status === 'failed' ? '⚠️' : run.status === 'completed' ? '✅' : '🤖'}</span>
                {currentLabel}
              </p>
            )}
            <div className="flex items-center gap-2 mt-1.5">
              <Progress value={pct} className="h-1.5 flex-1" />
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {Math.min(completedToolCount, totalCount)}/{totalCount}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1 items-end">
            {run.status === 'running' && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                disabled={cancelling}
                onClick={async () => {
                  setCancelling(true);
                  try { await onCancel(run.id); } finally { setCancelling(false); }
                }}
              >
                <XIcon className="w-3 h-3" /> {cancelling ? 'Cancelling…' : 'Cancel'}
              </Button>
            )}
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                title="Delete from queue"
                onClick={() => onDelete(run.id)}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground"
                onClick={() => setExpanded((value) => !value)}>
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>
        </div>
        {expanded && (
          <div className="border-t pt-2 space-y-2 text-[11px]">
            {plan.length > 0 && (
              <div className="space-y-1">
                <div className="font-medium text-muted-foreground">Plan</div>
                {plan.map((step, index) => (
                  <div key={`plan-${index}`} className="flex items-start gap-2">
                    <span className="text-muted-foreground">{index + 1}.</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            )}
            {recent.length > 0 && (
              <div className="space-y-1">
                <div className="font-medium text-muted-foreground">Recent activity</div>
                {recent.map((event, index) => (
                  <div key={`event-${index}`} className="text-muted-foreground">
                    {event.type === 'tool_call' && <>🔧 {event.name}{event.label ? ` → ${event.label}` : ''}</>}
                    {event.type === 'tool_result' && <>{event.ok === false ? '✗' : '✓'} {event.name}: {event.summary}</>}
                    {event.type === 'thought' && <>💭 {event.text}</>}
                    {event.type === 'review' && <>🧐 {event.text}</>}
                    {event.type === 'phase' && <>→ phase: {event.name}</>}
                    {event.type === 'finish' && <>✨ {event.summary}</>}
                    {event.type === 'error' && <span className="text-destructive">⚠️ {event.message}</span>}
                  </div>
                ))}
              </div>
            )}
            {run.error && <div className="text-destructive">{run.error}</div>}
            {(run as any).result?.kind === 'deep-research' && (
              <div className="border-t pt-2 mt-2 space-y-2">
                <div className="font-medium text-muted-foreground">Research report</div>
                {(run as any).result?.image_url && (
                  <img src={(run as any).result.image_url} alt="" className="w-full max-h-48 rounded-md object-cover border" />
                )}
                <pre className="whitespace-pre-wrap text-[11px] leading-relaxed max-h-72 overflow-y-auto bg-muted/40 p-2 rounded-md font-sans">{(run as any).result.report}</pre>
                {Array.isArray((run as any).result?.sources) && (run as any).result.sources.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="font-medium text-muted-foreground">Sources</div>
                    {(run as any).result.sources.map((s: any) => (
                      <a key={s.index} href={s.url} target="_blank" rel="noreferrer" className="block text-primary hover:underline truncate">
                        [{s.index}] {s.title || s.url}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AITasksPanel() {
  const [showAll, setShowAll] = useState(false);
  const [cancellingAll, setCancellingAll] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: posts = [] } = useQuery({
    queryKey: ['social_posts'], queryFn: listSocialPosts, refetchInterval: 5000,
  });
  const { data: commands = [] } = useQuery({
    queryKey: ['pending_commands_recent'], queryFn: listRecentCommands, refetchInterval: 5000,
  });
  const { data: genJobs = [] } = useQuery({
    queryKey: ['generation_jobs'], queryFn: listGenerationJobs,
    // Poll quickly while a job is running so the progress bar feels live.
    refetchInterval: (q) => ((q.state.data as GenerationJob[] | undefined)?.some((j) => j.status === 'running') ? 1500 : 8000),
  });
  const { data: agentRuns = [] } = useQuery({
    queryKey: ['agent_runs'], queryFn: listAgentRuns,
    refetchInterval: (q) => ((q.state.data as AgentRun[] | undefined)?.some((run) => run.status === 'running') ? 1500 : 8000),
  });

  const runningJobs = genJobs.filter((j) => j.status === 'running');
  const runningAgentRuns = agentRuns.filter((run) => run.status === 'running');
  const recentAgentRuns = showAll ? agentRuns : [...runningAgentRuns, ...agentRuns.filter((run) => run.status !== 'running').slice(0, 2)];
  const recentJobs = showAll ? genJobs : [...runningJobs, ...genJobs.filter((j) => j.status !== 'running').slice(0, 2)];
  const recentPosts = posts.slice(0, showAll ? posts.length : 4);
  const recentCommands = commands.slice(0, showAll ? commands.length : 4);
  const total = posts.length + commands.length + genJobs.length + agentRuns.length;

  const handleCancel = async (id: string) => {
    try {
      await cancelGenerationJob(id);
      toast({ title: 'Cancelled', description: 'The agent will stop within a couple of seconds.' });
      queryClient.invalidateQueries({ queryKey: ['generation_jobs'] });
    } catch (e: any) {
      toast({ title: 'Could not cancel', description: e.message, variant: 'destructive' });
    }
  };

  const handleCancelAgentRun = async (id: string) => {
    try {
      await cancelAgentRun(id);
      toast({ title: 'Cancelled', description: 'The autonomous agent is stopping.' });
      queryClient.invalidateQueries({ queryKey: ['agent_runs'] });
    } catch (e: any) {
      toast({ title: 'Could not cancel', description: e.message, variant: 'destructive' });
    }
  };

  const handleCancelAll = async () => {
    setCancellingAll(true);
    try {
      const n = await cancelAllRunningJobs();
      toast({ title: `Cancelled ${n} job${n === 1 ? '' : 's'}` });
      queryClient.invalidateQueries({ queryKey: ['generation_jobs'] });
    } catch (e: any) {
      toast({ title: 'Could not cancel', description: e.message, variant: 'destructive' });
    } finally {
      setCancellingAll(false);
    }
  };

  const handleDeleteJob = async (id: string) => {
    try {
      await deleteGenerationJob(id);
      queryClient.invalidateQueries({ queryKey: ['generation_jobs'] });
    } catch (e: any) {
      toast({ title: 'Could not delete', description: e.message, variant: 'destructive' });
    }
  };

  const handleDeleteAgentRun = async (id: string) => {
    try {
      await deleteAgentRun(id);
      queryClient.invalidateQueries({ queryKey: ['agent_runs'] });
    } catch (e: any) {
      toast({ title: 'Could not delete', description: e.message, variant: 'destructive' });
    }
  };

  const handleDeletePost = async (id: string) => {
    try {
      await deleteSocialPost(id);
      queryClient.invalidateQueries({ queryKey: ['social_posts'] });
    } catch (e: any) {
      toast({ title: 'Could not delete', description: e.message, variant: 'destructive' });
    }
  };

  const handleDeleteCommand = async (id: string) => {
    try {
      await deletePendingCommand(id);
      queryClient.invalidateQueries({ queryKey: ['pending_commands_recent'] });
    } catch (e: any) {
      toast({ title: 'Could not delete', description: e.message, variant: 'destructive' });
    }
  };

  if (total === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-primary" /> AI Agent Tasks ({total})
          {(runningJobs.length + runningAgentRuns.length) > 0 && (
            <Badge variant="outline" className="h-5 text-[10px] gap-1 border-primary/40 text-primary">
              <Loader2 className="w-2.5 h-2.5 animate-spin" /> {runningJobs.length + runningAgentRuns.length} live
            </Badge>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {runningJobs.length > 0 && (
            <Button
              variant="outline" size="sm"
              className="h-7 text-xs gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
              disabled={cancellingAll}
              onClick={handleCancelAll}
            >
              <XIcon className="w-3 h-3" />
              {cancellingAll ? 'Cancelling…' : `Cancel ${runningJobs.length > 1 ? 'all' : ''}`}
            </Button>
          )}
          <Link to="/social">
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
              Open Social Posts <ExternalLink className="w-3 h-3" />
            </Button>
          </Link>
          {total > 8 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs"
              onClick={() => setShowAll((s) => !s)}>
              {showAll ? 'Show less' : `Show all (${total})`}
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-2">
        {recentAgentRuns.map((run) => <AgentRunRow key={run.id} run={run} onCancel={handleCancelAgentRun} onDelete={handleDeleteAgentRun} />)}
        {recentJobs.map((j) => <GenerationJobRow key={j.id} job={j} onCancel={handleCancel} onDelete={handleDeleteJob} />)}
        {recentPosts.map((p) => <PostRow key={p.id} post={p} onDelete={handleDeletePost} />)}
        {recentCommands.map((c) => <CommandRow key={c.id} cmd={c} onDelete={handleDeleteCommand} />)}
      </div>
    </div>
  );
}
