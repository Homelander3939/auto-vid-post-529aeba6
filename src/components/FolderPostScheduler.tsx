// Recurring schedule for folder-driven social posts.
// At each cron tick the local worker scans the configured folder, picks up to
// `posts_per_run` unprocessed bundles (1 .txt + matching images), uploads the
// images to storage, and queues social_posts so they post immediately.
//
// Manifests already published are tracked in `imported_files` so they are not
// re-uploaded next tick.

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Calendar, FolderOpen, Play, Trash2, Plus, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

type Frequency = 'every_5m' | 'every_10m' | 'hourly' | 'every_6h' | 'every_12h' | 'daily' | 'weekly';

interface FolderSchedule {
  id: number;
  name: string;
  enabled: boolean;
  cron_expression: string;
  folder_path: string;
  posts_per_run: number;
  target_platforms: string[];
  source_type: string;
  last_run_at: string | null;
  run_count: number;
  imported_files: string[];
}

const HIDE_TIME: Frequency[] = ['every_5m', 'every_10m', 'hourly', 'every_6h', 'every_12h'];
const HIDE_MINUTE: Frequency[] = ['every_5m', 'every_10m'];

function buildCron(freq: Frequency, hour: number, minute: number): string {
  const m = String(minute);
  const h = String(hour);
  switch (freq) {
    case 'every_5m':  return `*/5 * * * *`;
    case 'every_10m': return `*/10 * * * *`;
    case 'hourly':    return `${m} * * * *`;
    case 'every_6h':  return `${m} */6 * * *`;
    case 'every_12h': return `${m} */12 * * *`;
    case 'daily':     return `${m} ${h} * * *`;
    case 'weekly':    return `${m} ${h} * * 1`;
  }
}

function parseCron(cron: string): { freq: Frequency; hour: number; minute: number } {
  const parts = (cron || '').split(' ');
  const [mStr, hStr, , , dowStr] = parts;
  if (mStr === '*/5') return { freq: 'every_5m', hour: 0, minute: 0 };
  if (mStr === '*/10') return { freq: 'every_10m', hour: 0, minute: 0 };
  const minute = parseInt(mStr) || 0;
  if (hStr === '*') return { freq: 'hourly', hour: 0, minute };
  if (hStr === '*/6') return { freq: 'every_6h', hour: 0, minute };
  if (hStr === '*/12') return { freq: 'every_12h', hour: 0, minute };
  const hour = parseInt(hStr) || 0;
  if (dowStr && dowStr !== '*') return { freq: 'weekly', hour, minute };
  return { freq: 'daily', hour, minute };
}

const FREQ_LABELS: Record<Frequency, string> = {
  every_5m: 'Every 5 minutes',
  every_10m: 'Every 10 minutes',
  hourly: 'Every hour',
  every_6h: 'Every 6 hours',
  every_12h: 'Every 12 hours',
  daily: 'Once a day',
  weekly: 'Once a week (Monday)',
};

const pad = (n: number) => String(n).padStart(2, '0');

function describe(cron: string): string {
  const { freq, hour, minute } = parseCron(cron);
  if (freq === 'every_5m') return `Every 5 minutes`;
  if (freq === 'every_10m') return `Every 10 minutes`;
  if (freq === 'hourly') return `Every hour at :${pad(minute)}`;
  if (freq === 'every_6h') return `Every 6 hours at :${pad(minute)}`;
  if (freq === 'every_12h') return `Every 12 hours at :${pad(minute)}`;
  if (freq === 'weekly') return `Mondays at ${pad(hour)}:${pad(minute)}`;
  return `Daily at ${pad(hour)}:${pad(minute)}`;
}

export default function FolderPostScheduler() {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<FolderSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('News posts');
  const [folderPath, setFolderPath] = useState('D:\\news posts');
  const [frequency, setFrequency] = useState<Frequency>('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [postsPerRun, setPostsPerRun] = useState(1);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('social_post_schedules')
      .select('*')
      .eq('source_type', 'folder')
      .order('id', { ascending: false });
    setLoading(false);
    if (error) { toast({ title: 'Load failed', description: error.message, variant: 'destructive' }); return; }
    setSchedules((data || []) as any);
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!folderPath.trim()) { toast({ title: 'Folder path required', variant: 'destructive' }); return; }
    setSaving(true);
    const { error } = await supabase.from('social_post_schedules').insert({
      name, enabled,
      cron_expression: buildCron(frequency, hour, minute),
      folder_path: folderPath.trim(),
      posts_per_run: Math.max(1, postsPerRun),
      source_type: 'folder',
      target_platforms: ['x', 'linkedin', 'facebook'],
    } as any);
    setSaving(false);
    if (error) { toast({ title: 'Save failed', description: error.message, variant: 'destructive' }); return; }
    toast({ title: 'Schedule created', description: 'Worker will scan the folder at each tick.' });
    setShowForm(false);
    load();
  };

  const toggle = async (s: FolderSchedule) => {
    await supabase.from('social_post_schedules').update({ enabled: !s.enabled } as any).eq('id', s.id);
    load();
  };

  const remove = async (id: number) => {
    if (!confirm('Delete this folder schedule?')) return;
    await supabase.from('social_post_schedules').delete().eq('id', id);
    load();
  };

  const runNow = async (id: number, ignoreImported = false) => {
    try {
      const r = await fetch('http://localhost:3001/api/social-folder-schedules/run-now', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, ignoreImported }),
      });
      const data = await r.json().catch(() => ({} as any));
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      const s = data?.summary?.schedules?.[0];
      const queued = data?.summary?.queued ?? 0;
      const errs: string[] = data?.summary?.errors || [];
      if (queued > 0) {
        toast({ title: `Queued ${queued} post(s)`, description: s ? s.queuedFiles.slice(0,3).join(', ') : '' });
      } else if (errs.length) {
        toast({ title: 'Errors', description: errs.slice(0,2).join(' · '), variant: 'destructive' });
      } else if (s) {
        toast({ title: 'Nothing queued', description: `${s.note} (scanned=${s.scanned}, alreadyImported=${s.alreadyImported}, missingImages=${s.missingImages}).` + (!ignoreImported && s.alreadyImported>0 ? ' Shift-click Run now to force re-run.' : '') });
      }
      setTimeout(load, 1500);
    } catch (e: any) {
      toast({ title: 'Run failed', description: e.message, variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="w-4 h-4 text-primary" /> Recurring folder schedules
          </CardTitle>
          <CardDescription>
            Periodically scan a local folder and auto-publish the next N bundles. Each bundle = 1 .txt + matching images.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={load} disabled={loading} className="gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={() => setShowForm((v) => !v)} className="gap-1.5">
            <Plus className="w-3.5 h-3.5" /> New
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {showForm && (
          <Card className="border-dashed">
            <CardContent className="p-3 space-y-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Folder on this PC</Label>
                  <div className="flex gap-1">
                    <FolderOpen className="w-4 h-4 text-muted-foreground self-center shrink-0" />
                    <Input value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="D:\news posts" className="h-8 text-xs font-mono" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Frequency</Label>
                  <Select value={frequency} onValueChange={(v) => setFrequency(v as Frequency)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(FREQ_LABELS) as Frequency[]).map((f) => (
                        <SelectItem key={f} value={f}>{FREQ_LABELS[f]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Posts per run</Label>
                  <Input type="number" min={1} value={postsPerRun} onChange={(e) => setPostsPerRun(Number(e.target.value) || 1)} className="h-8 text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Hour {HIDE_TIME.includes(frequency) ? '(ignored)' : ''}</Label>
                  <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))} disabled={HIDE_TIME.includes(frequency)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-60">
                      {Array.from({ length: 24 }, (_, i) => (
                        <SelectItem key={i} value={String(i)}>{pad(i)}:00</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Minute {HIDE_MINUTE.includes(frequency) ? '(ignored)' : ''}</Label>
                  <Select value={String(minute)} onValueChange={(v) => setMinute(Number(v))} disabled={HIDE_MINUTE.includes(frequency)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-60">
                      {Array.from({ length: 60 }, (_, i) => (
                        <SelectItem key={i} value={String(i)}>:{pad(i)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch checked={enabled} onCheckedChange={setEnabled} />
                  <span className="text-xs text-muted-foreground">{enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
                  <Button size="sm" onClick={save} disabled={saving}>Save schedule</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {schedules.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No recurring folder schedules yet. Click <span className="text-foreground">New</span> to create one.
          </p>
        )}

        {schedules.map((s) => (
          <Card key={s.id} className="border-border">
            <CardContent className="p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Switch checked={s.enabled} onCheckedChange={() => toggle(s)} />
                <span className="font-medium text-sm">{s.name}</span>
                <Badge variant="outline" className="text-[10px]">{describe(s.cron_expression)}</Badge>
                <Badge variant="secondary" className="text-[10px]">{s.posts_per_run} per run</Badge>
                <span className="text-[11px] text-muted-foreground ml-auto">
                  Runs: {s.run_count} · Imported: {s.imported_files?.length || 0}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground font-mono truncate">{s.folder_path}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={(e) => runNow(s.id, e.shiftKey || e.altKey)} title="Click = scan new bundles · Shift-click = re-publish already-imported bundles" className="gap-1.5 h-7">
                  <Play className="w-3 h-3" /> Run now
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(s.id)} className="gap-1.5 h-7 text-destructive">
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </CardContent>
    </Card>
  );
}
