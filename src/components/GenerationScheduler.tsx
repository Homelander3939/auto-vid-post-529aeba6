// Recurring AI post-generation scheduler — same visual frequency picker as the
// upload Schedule page. Each schedule periodically calls generate-social-post,
// which drafts the post AND pushes a Telegram preview automatically.
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Plus, Save, Trash2, ChevronDown, ChevronUp, Repeat, Clock, Timer, Sparkles, Play,
} from 'lucide-react';
import {
  listGenerationSchedules, saveGenerationSchedule, deleteGenerationSchedule,
  runGenerationScheduleNow, getSocialAccounts, SOCIAL_PLATFORMS,
  type GenerationSchedule, type SocialAccount,
} from '@/lib/socialPosts';

type FrequencyMode = 'interval' | 'hourly' | 'daily' | 'weekly';
type DurationUnit = 'hours' | 'days' | 'weeks';
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PLATFORM_LABELS: Record<string, string> = { x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook' };
const INTERVAL_MINUTE_OPTIONS = [5, 10, 15, 20, 30, 45];

function clampMinute(v: number) {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(59, v));
}

function cronToState(cron: string) {
  const parts = (cron || '0 9 * * *').split(' ');
  if (parts.length !== 5) return { mode: 'daily' as FrequencyMode, minute: 0, hour: 9, weekdays: [1,2,3,4,5], interval: 1, intervalMinutes: 10 };
  const [min, hr, , , dow] = parts;
  // Interval mode: */N minutes
  if (min.startsWith('*/') && hr === '*') {
    const intervalMinutes = parseInt(min.replace('*/', ''), 10) || 10;
    return { mode: 'interval' as FrequencyMode, minute: 0, hour: 9, weekdays: [1,2,3,4,5], interval: 1, intervalMinutes };
  }
  const minute = min === '*' ? 0 : parseInt(min) || 0;
  const hour = hr === '*' ? 0 : parseInt(hr.replace('*/', '')) || 9;
  if (hr === '*' || hr.startsWith('*/')) {
    const interval = hr === '*' ? 1 : parseInt(hr.replace('*/', '')) || 1;
    return { mode: 'hourly' as FrequencyMode, minute, hour: interval, weekdays: [1,2,3,4,5], interval, intervalMinutes: 10 };
  }
  if (dow !== '*') {
    const weekdays = dow.split(',').map(Number).filter((n) => !isNaN(n));
    return { mode: 'weekly' as FrequencyMode, minute, hour, weekdays, interval: 1, intervalMinutes: 10 };
  }
  return { mode: 'daily' as FrequencyMode, minute, hour, weekdays: [1,2,3,4,5], interval: 1, intervalMinutes: 10 };
}

function stateToCron(mode: FrequencyMode, hour: number, minute: number, weekdays: number[], interval: number, intervalMinutes: number) {
  switch (mode) {
    case 'interval': return `*/${Math.max(1, intervalMinutes)} * * * *`;
    case 'hourly': return interval === 1 ? `${minute} * * * *` : `${minute} */${interval} * * *`;
    case 'daily':  return `${minute} ${hour} * * *`;
    case 'weekly': return `${minute} ${hour} * * ${weekdays.sort().join(',')}`;
  }
}

function humanReadable(cron: string) {
  const s = cronToState(cron);
  const t = `${s.hour.toString().padStart(2, '0')}:${s.minute.toString().padStart(2, '0')}`;
  switch (s.mode) {
    case 'interval': return `Every ${s.intervalMinutes} min`;
    case 'hourly': return s.interval === 1 ? `Every hour at :${s.minute.toString().padStart(2, '0')}` : `Every ${s.interval}h at :${s.minute.toString().padStart(2, '0')}`;
    case 'daily':  return `Daily at ${t}`;
    case 'weekly': return `${s.weekdays.sort().map((d) => DAYS_OF_WEEK[d]).join(', ')} at ${t}`;
  }
}

// All cron expressions are interpreted in Asia/Tbilisi (UTC+4) by the
// run-due-generations edge function. The dropdowns below show Tbilisi time.
const localTz = 'Asia/Tbilisi (UTC+4)';

function ScheduleCard({
  schedule, accounts, onSave, onDelete, onRunNow,
}: {
  schedule: GenerationSchedule;
  accounts: SocialAccount[];
  onSave: (s: GenerationSchedule) => void;
  onDelete?: () => void;
  onRunNow?: (e?: any) => void;
}) {
  const isNew = !schedule.id;
  const [expanded, setExpanded] = useState(isNew);
  const [name, setName] = useState(schedule.name);
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [aiPrompt, setAiPrompt] = useState(schedule.ai_prompt);
  const [includeImage, setIncludeImage] = useState(schedule.include_image);
  const [platforms, setPlatforms] = useState<string[]>(schedule.target_platforms);
  const [accountSel, setAccountSel] = useState<Record<string, string>>(schedule.account_selections || {});
  const [endAt, setEndAt] = useState<string | null>(schedule.end_at);
  // Post Campaign extensions
  const [autoPublish, setAutoPublish] = useState(!!schedule.auto_publish);
  const [topicMode, setTopicMode] = useState(!!schedule.topic_mode);
  const [variationHintsRaw, setVariationHintsRaw] = useState((schedule.variation_hints || []).join(', '));

  const parsed = cronToState(schedule.cron_expression);
  const [mode, setMode] = useState<FrequencyMode>(parsed.mode);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [weekdays, setWeekdays] = useState<number[]>(parsed.weekdays);
  const [interval, setInterval] = useState(parsed.interval);
  const [intervalMinutes, setIntervalMinutes] = useState(parsed.intervalMinutes);

  // Source + batching (parity with video-upload scheduler)
  const [sourceType, setSourceType] = useState<'ai' | 'folder'>(schedule.source_type === 'folder' ? 'folder' : 'ai');
  const [folderPath, setFolderPath] = useState(schedule.folder_path || '');
  const [postsPerRun, setPostsPerRun] = useState(Math.max(1, Math.min(20, Number(schedule.posts_per_run) || 1)));

  const [useDuration, setUseDuration] = useState(!!schedule.end_at);
  const [durationAmount, setDurationAmount] = useState(7);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('days');

  const cron = useMemo(
    () => stateToCron(mode, hour, minute, weekdays, interval, intervalMinutes),
    [mode, hour, minute, weekdays, interval, intervalMinutes],
  );
  const summary = humanReadable(cron);

  useEffect(() => {
    if (!useDuration) { setEndAt(null); return; }
    const ms = durationUnit === 'hours' ? durationAmount * 3600000
      : durationUnit === 'days' ? durationAmount * 86400000
      : durationAmount * 604800000;
    setEndAt(new Date(Date.now() + ms).toISOString());
  }, [useDuration, durationAmount, durationUnit]);

  const accountsByPlatform = useMemo(() => {
    const m: Record<string, SocialAccount[]> = {};
    for (const p of SOCIAL_PLATFORMS) m[p] = accounts.filter((a) => a.platform === p && a.enabled);
    return m;
  }, [accounts]);

  // Auto-default account selection for each chosen platform (parity with video
  // upload scheduler) so the worker never fails with "No enabled account
  // selected" just because the user did not open the picker.
  useEffect(() => {
    setAccountSel((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const p of platforms) {
        const list = accountsByPlatform[p] || [];
        if (!list.length) continue;
        if (!next[p] || !list.find((a) => a.id === next[p])) {
          const def = list.find((a) => a.is_default) || list[0];
          next[p] = def.id;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [platforms, accountsByPlatform]);

  const togglePlatform = (p: string) => setPlatforms((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  const toggleWeekday = (d: number) => setWeekdays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);

  const handleSave = () => {
    const variationHints = variationHintsRaw
      .split(/[,\n]+/).map((h) => h.trim()).filter(Boolean);
    // Make sure every selected platform has a concrete account_id, picking the
    // default/first enabled one when the user didn't open the picker.
    const finalAccountSel: Record<string, string> = { ...accountSel };
    for (const p of platforms) {
      const list = accountsByPlatform[p] || [];
      if (!list.length) continue;
      if (!finalAccountSel[p] || !list.find((a) => a.id === finalAccountSel[p])) {
        const def = list.find((a) => a.is_default) || list[0];
        finalAccountSel[p] = def.id;
      }
    }
    onSave({
      ...schedule,
      name: name || 'Generation Schedule',
      enabled, cron_expression: cron,
      target_platforms: platforms,
      ai_prompt: aiPrompt,
      include_image: includeImage,
      account_selections: finalAccountSel,
      end_at: endAt,
      // Folder mode forces auto-publish (no AI draft step).
      auto_publish: sourceType === 'folder' ? true : autoPublish,
      topic_mode: sourceType === 'folder' ? false : topicMode,
      variation_hints: variationHints,
      source_type: sourceType,
      folder_path: folderPath.trim(),
      posts_per_run: postsPerRun,
    });
  };

  return (
    <Card>
      <CardContent className="pt-4 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
            <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${enabled ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30'}`} />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{name || 'Untitled Schedule'}</p>
              <p className="text-xs text-muted-foreground truncate">
                {summary} · {platforms.map((p) => PLATFORM_LABELS[p] || p).join(', ') || 'no platforms'}
                {schedule.last_run_at && ` · last: ${new Date(schedule.last_run_at).toLocaleString()}`}
              </p>
            </div>
            {expanded ? <ChevronUp className="w-4 h-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />}
          </button>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {expanded && (
          <div className="space-y-4 pt-2 border-t">
            <div className="space-y-1.5">
              <Label className="text-xs">Schedule Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Daily AI Trends Digest" />
            </div>

            {/* ── Source mode: AI vs Local Folder ─────────────────────── */}
            <div className="space-y-2">
              <Label className="text-xs">Post Source</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={sourceType === 'ai' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSourceType('ai')}
                >AI-generated</Button>
                <Button
                  variant={sourceType === 'folder' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSourceType('folder')}
                >Local folder</Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {sourceType === 'folder'
                  ? 'Local worker scans the folder, pairs each .txt caption with its sibling image(s) (.jpg/.png/.webp) by filename stem, and publishes via the same pipeline as "Publish now". Telegram is notified per post.'
                  : 'Each tick the AI writes a fresh post (or topic-campaign variation) and publishes / drafts it.'}
              </p>
            </div>

            {sourceType === 'folder' && (
              <div className="space-y-1.5">
                <Label className="text-xs">Folder path (absolute)</Label>
                <Input
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  placeholder="D:\\news posts"
                />
                <p className="text-[11px] text-muted-foreground">
                  Paste the full path. The local worker reads this folder; processed files are remembered so nothing reposts.
                </p>
              </div>
            )}

            {sourceType === 'ai' && (
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> {topicMode ? 'Campaign Topic' : 'AI Prompt'}
                </Label>
                <Textarea
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  rows={4}
                  placeholder={topicMode
                    ? "Topic the AI should keep posting about, e.g. 'Sustainable urban gardening for beginners'"
                    : "What should the AI write about each run? e.g. 'Latest AI news this week, focus on developer tools'"}
                />
                <p className="text-xs text-muted-foreground">
                  {topicMode
                    ? 'Each run, the AI rotates a fresh angle (story, contrarian take, data, tip, question…) so the campaign feels human and varied.'
                    : 'Same prompt is sent to the agent every run. Each result is saved as a draft and previewed in Telegram.'}
                </p>
              </div>
            )}

            {sourceType === 'ai' && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-3">
                <div className="flex items-start gap-3">
                  <Switch checked={topicMode} onCheckedChange={setTopicMode} />
                  <div className="flex-1 min-w-0">
                    <Label className="text-xs font-medium">Topic Campaign Mode</Label>
                    <p className="text-[11px] text-muted-foreground">
                      AI acts as a creative SMM manager — varies hooks, angles, and tone every run so consecutive posts on the same topic stay fresh.
                    </p>
                  </div>
                </div>

                {topicMode && (
                  <div className="space-y-1.5 pl-9">
                    <Label className="text-xs">Variation Angles (optional, comma-separated)</Label>
                    <Input
                      value={variationHintsRaw}
                      onChange={(e) => setVariationHintsRaw(e.target.value)}
                      placeholder="contrarian take, story, data insight, quick tip, behind-the-scenes"
                    />
                  </div>
                )}

                <div className="flex items-start gap-3 border-t pt-3">
                  <Switch checked={autoPublish} onCheckedChange={setAutoPublish} />
                  <div className="flex-1 min-w-0">
                    <Label className="text-xs font-medium">Auto-Publish to Selected Accounts</Label>
                    <p className="text-[11px] text-muted-foreground">
                      {autoPublish
                        ? '⚠ Posts go LIVE automatically each run — no manual approval.'
                        : 'Off: each run saves a draft and pings Telegram for manual approval.'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {sourceType === 'ai' && (
              <div className="flex items-center gap-3">
                <Checkbox id={`img-${schedule.id ?? 'new'}`} checked={includeImage} onCheckedChange={(v) => setIncludeImage(!!v)} />
                <Label htmlFor={`img-${schedule.id ?? 'new'}`} className="text-xs">Include AI-generated image</Label>
              </div>
            )}

            {/* ── Batch size (posts per tick) ─────────────────────────── */}
            <div className="space-y-1.5">
              <Label className="text-xs">Posts per run</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={postsPerRun}
                onChange={(e) => setPostsPerRun(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)))}
              />
              <p className="text-[11px] text-muted-foreground">
                How many posts to publish each time the schedule fires (1–20). Combine with the interval below to control posting cadence.
              </p>
            </div>

            <div className="space-y-3">
              <Label className="text-xs flex items-center gap-1.5"><Repeat className="w-3.5 h-3.5" /> Frequency</Label>
              <div className="grid grid-cols-4 gap-2">
                {(['interval', 'hourly', 'daily', 'weekly'] as FrequencyMode[]).map((m) => (
                  <Button key={m} variant={mode === m ? 'default' : 'outline'} size="sm" onClick={() => setMode(m)} className="capitalize">{m}</Button>
                ))}
              </div>

              {mode === 'interval' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Every N minutes</Label>
                  <Select value={String(intervalMinutes)} onValueChange={(v) => setIntervalMinutes(Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {INTERVAL_MINUTE_OPTIONS.map((n) => <SelectItem key={n} value={String(n)}>Every {n} min</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Fires continuously. With {postsPerRun} post(s) per run, that publishes ~{Math.round((60 / intervalMinutes) * postsPerRun)} post(s) per hour.
                  </p>
                </div>
              )}

              {mode === 'hourly' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Every N hours</Label>
                    <Select value={String(interval)} onValueChange={(v) => setInterval(Number(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{[1, 2, 3, 4, 6, 8, 12].map((n) => <SelectItem key={n} value={String(n)}>{n}h</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">At minute (0-59)</Label>
                    <Input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(clampMinute(parseInt(e.target.value, 10)))} />
                  </div>
                </div>
              )}

              {mode === 'daily' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Hour</Label>
                    <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{HOURS.map((h) => <SelectItem key={h} value={String(h)}>{h.toString().padStart(2, '0')}:00</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Minute (0-59)</Label>
                    <Input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(clampMinute(parseInt(e.target.value, 10)))} />
                  </div>
                </div>
              )}

              {mode === 'weekly' && (
                <>
                  <div>
                    <Label className="text-xs mb-2 block">Days</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {DAYS_OF_WEEK.map((d, i) => (
                        <Button key={i} variant={weekdays.includes(i) ? 'default' : 'outline'} size="sm" onClick={() => toggleWeekday(i)} className="w-11 h-9 text-xs px-0">{d}</Button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Hour</Label>
                      <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{HOURS.map((h) => <SelectItem key={h} value={String(h)}>{h.toString().padStart(2, '0')}:00</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Minute (0-59)</Label>
                      <Input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(clampMinute(parseInt(e.target.value, 10)))} />
                    </div>
                  </div>
                </>
              )}

              <p className="text-xs text-muted-foreground">Time zone: <span className="font-medium">{localTz}</span></p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs flex items-center gap-1.5"><Timer className="w-3.5 h-3.5" /> Duration</Label>
              <div className="flex items-center gap-3">
                <Switch checked={useDuration} onCheckedChange={setUseDuration} />
                <span className="text-xs">{useDuration ? 'Runs for set duration' : 'Runs indefinitely'}</span>
              </div>
              {useDuration && (
                <div className="grid grid-cols-2 gap-3">
                  <Input type="number" min={1} value={durationAmount} onChange={(e) => setDurationAmount(Math.max(1, parseInt(e.target.value) || 1))} />
                  <Select value={durationUnit} onValueChange={(v) => setDurationUnit(v as DurationUnit)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hours">Hours</SelectItem>
                      <SelectItem value="days">Days</SelectItem>
                      <SelectItem value="weeks">Weeks</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div>
              <Label className="text-xs mb-2 block">Platforms</Label>
              <div className="flex flex-wrap gap-2">
                {SOCIAL_PLATFORMS.map((p) => (
                  <Button key={p} variant={platforms.includes(p) ? 'default' : 'outline'} size="sm" onClick={() => togglePlatform(p)}>
                    {PLATFORM_LABELS[p]}
                  </Button>
                ))}
              </div>
            </div>

            {platforms.map((p) => {
              const list = accountsByPlatform[p] || [];
              if (list.length === 0) {
                return (
                  <div key={p} className="space-y-1.5">
                    <Label className="text-xs">{PLATFORM_LABELS[p]} Account</Label>
                    <p className="text-[11px] text-destructive">
                      No enabled {PLATFORM_LABELS[p]} account — add one in Settings or scheduled posts will fail.
                    </p>
                  </div>
                );
              }
              return (
                <div key={p} className="space-y-1.5">
                  <Label className="text-xs">{PLATFORM_LABELS[p]} Account</Label>
                  <Select value={accountSel[p] || ''} onValueChange={(v) => setAccountSel((s) => ({ ...s, [p]: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                    <SelectContent>
                      {list.map((a) => <SelectItem key={a.id} value={a.id}>{a.label || a.email}{a.is_default ? ' ★' : ''}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}

            <div className="flex items-center gap-2 text-xs text-muted-foreground border-t pt-3">
              <Clock className="w-3.5 h-3.5 text-primary" />
              <span>{summary}</span>
              <code className="bg-muted px-1 rounded font-mono">{cron}</code>
              {endAt && <span>· Ends {new Date(endAt).toLocaleDateString()}</span>}
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button onClick={handleSave} className="flex-1 gap-2" size="sm">
                <Save className="w-3.5 h-3.5" /> Save
              </Button>
              {!isNew && onRunNow && (
                <Button variant="outline" size="sm" onClick={onRunNow} className="gap-2">
                  <Play className="w-3.5 h-3.5" /> Run now
                </Button>
              )}
              {!isNew && onDelete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="hover:text-destructive">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
                      <AlertDialogDescription>This stops all future automatic generations.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onDelete} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function GenerationScheduler() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: schedules = [] } = useQuery({ queryKey: ['generation_schedules'], queryFn: listGenerationSchedules, refetchInterval: 10000 });
  const { data: accounts = [] } = useQuery({ queryKey: ['social_accounts'], queryFn: getSocialAccounts });
  const [drafts, setDrafts] = useState<Partial<GenerationSchedule>[]>([]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['generation_schedules'] });

  const handleSave = async (s: GenerationSchedule, isDraft = false) => {
    try {
      await saveGenerationSchedule(s);
      toast({ title: 'Saved', description: 'Generation schedule updated.' });
      if (isDraft) setDrafts([]);
      refresh();
    } catch (e: any) {
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    }
  };

  const handleDelete = async (id: number) => {
    try { await deleteGenerationSchedule(id); toast({ title: 'Deleted' }); refresh(); }
    catch (e: any) { toast({ title: 'Error', description: e.message, variant: 'destructive' }); }
  };

  const handleRunNow = async (id: number, ignoreImported = false) => {
    try {
      const r = await runGenerationScheduleNow(id, { ignoreImported });
      const s = r?.summary?.schedules?.[0];
      const queued = r?.summary?.queued ?? 0;
      const errs = r?.summary?.errors || [];
      if (queued > 0) {
        toast({ title: `Queued ${queued} post(s)`, description: s ? `${s.queuedFiles.slice(0,3).join(', ')}${s.queuedFiles.length>3?'…':''}` : 'Publishing now.' });
      } else if (errs.length) {
        toast({ title: 'Run finished with errors', description: errs.slice(0,2).join(' · '), variant: 'destructive' });
      } else if (s) {
        toast({
          title: 'Nothing queued',
          description: `${s.note} (scanned=${s.scanned}, alreadyImported=${s.alreadyImported}, missingImages=${s.missingImages}).` + (!ignoreImported && s.alreadyImported > 0 ? ' Click Run now again with Shift to force re-run.' : ''),
        });
      } else {
        toast({ title: 'Triggered', description: 'No summary returned.' });
      }
      refresh();
    } catch (e: any) {
      toast({ title: 'Trigger failed', description: e.message, variant: 'destructive' });
    }
  };

  const addDraft = () => setDrafts((d) => [...d, {
    name: 'New Post Campaign',
    enabled: true,
    cron_expression: '0 9 * * *',
    upload_interval_minutes: 10,
    target_platforms: ['x', 'linkedin', 'facebook'],
    ai_prompt: '',
    include_image: true,
    account_selections: {},
    end_at: null,
    last_run_at: null,
    auto_publish: false,
    topic_mode: true,
    variation_hints: [],
    source_type: 'ai',
    folder_path: '',
    posts_per_run: 1,
  }]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Post Campaigns & Schedules</h2>
          <p className="text-xs text-muted-foreground">
            Recurring AI-generated posts. Enable Topic Campaign Mode for creative SMM-manager-style varied posts on a single topic, and Auto-Publish to send them live to LinkedIn / X / Facebook automatically.
          </p>
        </div>
        <Button size="sm" onClick={addDraft} className="gap-2">
          <Plus className="w-4 h-4" /> New Campaign
        </Button>
      </div>

      {drafts.map((d, idx) => (
        <ScheduleCard
          key={`draft-${idx}`}
          schedule={d as GenerationSchedule}
          accounts={accounts}
          onSave={(s) => handleSave(s, true)}
        />
      ))}

      {schedules.map((s) => (
        <ScheduleCard
          key={s.id}
          schedule={s}
          accounts={accounts}
          onSave={(updated) => handleSave(updated)}
          onDelete={() => handleDelete(s.id)}
          onRunNow={(e?: any) => handleRunNow(s.id, !!(e && (e.shiftKey || e.altKey)))}
        />
      ))}

      {schedules.length === 0 && drafts.length === 0 && (
        <div className="text-center text-muted-foreground py-12 text-sm">
          No campaigns yet. Create one to have AI act as your daily / weekly social media manager — drafting (and optionally posting) creative content automatically.
        </div>
      )}
    </div>
  );
}
