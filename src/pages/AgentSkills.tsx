import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sparkles, Github, Play, Trash2, Plus, CheckCircle2, BookOpen, Loader2, Brain, Upload, Link as LinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';

interface Skill {
  id: string;
  name: string;
  slug: string;
  description: string;
  source: string;
  source_url?: string;
  triggers: string[];
  steps: SkillStep[];
  system_prompt: string;
  tags: string[];
  enabled: boolean;
  use_count: number;
  last_used_at?: string;
  created_at: string;
  risk_level?: 'read-only' | 'guarded-write' | 'guided';
  required_inputs?: string[];
}

interface SkillStep {
  note?: string;
  tool?: string;
  description?: string;
  task?: string;
  command?: string;
}

interface PendingSkill {
  name?: string;
  description?: string;
  steps?: SkillStep[];
}

interface PendingRun {
  id: string;
  prompt: string;
  pending_skill: PendingSkill | null;
  created_at: string;
}

interface AgentMemory {
  id: string;
  title: string;
  content: string;
  memory_type: string;
  tags: string[];
  enabled: boolean;
  use_count: number;
  created_at: string;
}

const IMPORTABLE_ZIP_ENTRY_RE = /\.(json|md|txt|yaml|yml|toml|prompt|skill|agent|instructions)$/i;
const IMPORTABLE_FILE_ACCEPT = '.json,.md,.txt,.yaml,.yml,.toml,.prompt,.skill,.agent,.instructions';
const DEFAULT_MEMORY_IMPORTANCE = 60;
const MIN_MEMORY_IMPORTANCE = 1;
const MAX_MEMORY_IMPORTANCE = 100;

function arrayValue<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [parsed as T];
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean) as T[];
    }
  }
  return [value as T];
}

function normalizeSkill(row: any): Skill {
  return {
    ...row,
    id: String(row?.id || ''),
    name: String(row?.name || row?.title || row?.slug || 'Untitled local skill'),
    slug: String(row?.slug || row?.id || 'local-skill'),
    description: String(row?.description || ''),
    source: String(row?.source || 'manual'),
    triggers: arrayValue<string>(row?.triggers).map(String),
    steps: arrayValue<SkillStep>(row?.steps).map((step) => typeof step === 'string' ? { note: step } : (step || {})),
    system_prompt: String(row?.system_prompt || row?.instructions || ''),
    tags: arrayValue<string>(row?.tags).map(String),
    enabled: row?.enabled !== false,
    use_count: Number(row?.use_count || 0),
    created_at: String(row?.created_at || ''),
    risk_level: row?.risk_level || 'guided',
    required_inputs: arrayValue<string>(row?.required_inputs).map(String),
  };
}

function normalizeMemory(row: any): AgentMemory {
  return {
    ...row,
    id: String(row?.id || ''),
    title: String(row?.title || row?.key || 'Recovered local memory'),
    content: String(row?.content || ''),
    memory_type: String(row?.memory_type || row?.status || 'fact'),
    tags: arrayValue<string>(row?.tags).map(String),
    enabled: row?.enabled !== false,
    use_count: Number(row?.use_count || 0),
    created_at: String(row?.created_at || ''),
  };
}

function clampImportance(value: number) {
  return Math.min(Math.max(Number(value) || DEFAULT_MEMORY_IMPORTANCE, MIN_MEMORY_IMPORTANCE), MAX_MEMORY_IMPORTANCE);
}

function getStepDisplayText(step: SkillStep) {
  return step.note || step.tool || step.description || step.task || step.command || 'Untitled step';
}

export default function AgentSkills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [pending, setPending] = useState<PendingRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', description: '', triggers: '', system_prompt: '', steps: '' });
  const [memoryDraft, setMemoryDraft] = useState({ title: '', content: '', memory_type: 'fact', tags: '', importance: DEFAULT_MEMORY_IMPORTANCE });
  const zipInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    const [s, m, p] = await Promise.all([
      supabase.from('agent_skills').select('*').order('created_at', { ascending: false }),
      supabase.from('agent_memories').select('*').order('importance', { ascending: false }).order('created_at', { ascending: false }).limit(30),
      supabase.from('agent_runs').select('id,prompt,pending_skill,created_at').not('pending_skill', 'is', null).order('created_at', { ascending: false }).limit(20),
    ]);
    setSkills(((s.data as any[]) || []).map(normalizeSkill));
    setMemories(((m.data as any[]) || []).map(normalizeMemory));
    setPending(((p.data as any[]) || []).map((row) => ({
      ...row,
      id: String(row?.id || ''),
      prompt: String(row?.prompt || ''),
      pending_skill: row?.pending_skill && typeof row.pending_skill === 'object' ? row.pending_skill : null,
      created_at: String(row?.created_at || ''),
    })));
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel('agent_skills_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_skills' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_memories' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_runs' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const installFromGithub = async () => {
    if (!installUrl.trim()) return;
    setInstalling(true);
    try {
      const { data, error } = await supabase.functions.invoke('agent-skills', {
        body: { action: 'install_github', url: installUrl.trim() },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      const installedCount = Number(data?.count || (Array.isArray(data?.skills) ? data.skills.length : 0)) || 1;
      toast.success(installedCount > 1 ? `Installed ${installedCount} skills` : `Installed: ${data.skill.name}`);
      setInstallUrl('');
      load();
    } catch (e: unknown) {
      toast.error(`Install failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setInstalling(false);
    }
  };

  const installFromZip = async (file: File) => {
    setInstalling(true);
    try {
      const zip = await JSZip.loadAsync(file);
      const importableEntries = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .filter((entry) => !entry.name.startsWith('__MACOSX/'))
        .filter((entry) => IMPORTABLE_ZIP_ENTRY_RE.test(entry.name))
        .slice(0, 40);

      if (importableEntries.length === 0) {
        throw new Error('No importable skill files found in that ZIP. Include JSON, Markdown, YAML, TOML, or TXT skill files.');
      }

      const files = await Promise.all(importableEntries.map(async (entry) => ({
        path: entry.name,
        content: await entry.async('string'),
      })));

      const { data, error } = await supabase.functions.invoke('agent-skills', {
        body: { action: 'install_bundle', sourceName: file.name, files },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      const installedCount = Number(data?.count || (Array.isArray(data?.skills) ? data.skills.length : 0)) || 1;
      toast.success(installedCount > 1 ? `Installed ${installedCount} skills from ZIP` : `Installed: ${data.skill.name}`);
      load();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'ZIP install failed';
      toast.error(message);
    } finally {
      if (zipInputRef.current) zipInputRef.current.value = '';
      setInstalling(false);
    }
  };

  const installFromFiles = async (files: FileList | File[]) => {
    const importable = Array.from(files).filter((file) => IMPORTABLE_ZIP_ENTRY_RE.test(file.name));
    if (importable.length === 0) {
      toast.error('Choose a JSON, Markdown, YAML, TOML, TXT, .prompt, .skill, or .agent file.');
      return;
    }

    setInstalling(true);
    try {
      const payload = await Promise.all(importable.map(async (file) => ({
        path: file.name,
        content: await file.text(),
      })));
      const { data, error } = await supabase.functions.invoke('agent-skills', {
        body: { action: 'install_bundle', sourceName: 'local-files', files: payload },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      const installedCount = Number(data?.count || (Array.isArray(data?.skills) ? data.skills.length : 0)) || 1;
      toast.success(installedCount > 1 ? `Installed ${installedCount} skills from files` : `Installed: ${data.skill.name}`);
      load();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'File install failed';
      toast.error(message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
      setInstalling(false);
    }
  };

  const acceptPending = async (runId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('agent-skills', {
        body: { action: 'accept_pending', runId },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      toast.success(`Skill saved: ${data.skill.name}`);
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to save skill');
    }
  };

  const dismissPending = async (runId: string) => {
    await supabase.from('agent_runs').update({ pending_skill: null }).eq('id', runId);
    load();
  };

  const runSkill = async (id: string) => {
    setRunning(id);
    try {
      const { data, error } = await supabase.functions.invoke('agent-skills', {
        body: { action: 'run_skill', skillId: id },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      toast.success(String(data?.summary || 'Skill completed locally.').slice(0, 220));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to run skill');
    } finally {
      setRunning(null);
    }
  };

  const toggleEnabled = async (id: string, enabled: boolean) => {
    await supabase.from('agent_skills').update({ enabled }).eq('id', id);
    load();
  };

  const toggleMemory = async (id: string, enabled: boolean) => {
    await supabase.from('agent_memories').update({ enabled }).eq('id', id);
    load();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this skill?')) return;
    await supabase.from('agent_skills').delete().eq('id', id);
    load();
  };

  const removeMemory = async (id: string) => {
    if (!confirm('Delete this memory?')) return;
    await supabase.from('agent_memories').delete().eq('id', id);
    load();
  };

  const createManual = async () => {
    if (!draft.name.trim()) return;
    let parsedSteps: SkillStep[] = [];
    try {
      parsedSteps = draft.steps.trim()
        ? draft.steps.split('\n').filter(Boolean).map((line) => ({ note: line.trim() }))
        : [];
    } catch { /* */ }
    const slug = draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) + '-' + Date.now().toString(36);
    const { error } = await (supabase.from('agent_skills') as any).insert({
      name: draft.name,
      slug,
      description: draft.description,
      source: 'manual',
      triggers: draft.triggers.split(',').map((t: string) => t.trim()).filter(Boolean),
      system_prompt: draft.system_prompt,
      steps: parsedSteps,
      tags: [],
      enabled: true,
      use_count: 0,
      risk_level: 'guided',
      required_inputs: [],
    });
    if (error) { toast.error(error.message); return; }
    toast.success('Skill created');
    setCreateOpen(false);
    setDraft({ name: '', description: '', triggers: '', system_prompt: '', steps: '' });
    load();
  };

  const createMemory = async () => {
    if (!memoryDraft.title.trim() || !memoryDraft.content.trim()) return;
    const { error } = await supabase.from('agent_memories').insert({
      title: memoryDraft.title.trim(),
      content: memoryDraft.content.trim(),
      memory_type: memoryDraft.memory_type,
      tags: memoryDraft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      importance: clampImportance(memoryDraft.importance),
      enabled: true,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('Memory saved');
    setMemoryOpen(false);
    setMemoryDraft({ title: '', content: '', memory_type: 'fact', tags: '', importance: DEFAULT_MEMORY_IMPORTANCE });
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-primary" /> Agent Skills
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Reusable routines the agent can run. Every enabled skill, its triggers, required inputs, purpose, and mapped tool are included in the agent’s fresh AI Chat and Telegram context.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={() => setMemoryOpen(true)}>
            <Brain className="w-4 h-4 mr-1.5" /> New Memory
          </Button>
          <Button variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1.5" /> New Skill
          </Button>
        </div>
      </div>

      {/* Install from link / files */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <LinkIcon className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Install from link or file</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Paste a GitHub repo, a GitHub/raw file URL, or any direct remote skill file. Large GitHub repositories are scanned through their file tree, so models, binaries, media, caches, and unrelated source files are skipped instead of rejecting the whole repository by ZIP size. You can also import a local skill file or ZIP bundle. The importer recognizes <code className="text-[10px] bg-secondary px-1 rounded">SKILL.md</code>, <code className="text-[10px] bg-secondary px-1 rounded">skills/</code>, <code className="text-[10px] bg-secondary px-1 rounded">agents/</code>, <code className="text-[10px] bg-secondary px-1 rounded">commands/</code>, and Claude/OpenClaw/Hermes prompt files.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Input
            placeholder="https://github.com/owner/repo  or  https://example.com/skill.md"
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            disabled={installing}
          />
          <Button onClick={installFromGithub} disabled={installing || !installUrl.trim()}>
            {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Github className="w-4 h-4 mr-1.5" /> Install link</>}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMPORTABLE_FILE_ACCEPT}
            className="hidden"
            multiple
            onChange={(e) => {
              if (e.target.files?.length) void installFromFiles(e.target.files);
            }}
          />
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={installing}>
            {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Upload className="w-4 h-4 mr-1.5" /> Upload file</>}
          </Button>
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void installFromZip(file);
            }}
          />
          <Button variant="outline" onClick={() => zipInputRef.current?.click()} disabled={installing}>
            {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4 mr-1.5" />}
            Upload ZIP
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Imported instructions use the app’s existing allowlisted tools. A skill that requires an external CLI or model is marked as guided until that runtime is installed separately.
        </p>
      </Card>

      {/* Pending proposals from agent runs */}
      {pending.length > 0 && (
        <Card className="p-4 border-primary/30 bg-primary/5">
          <h2 className="text-sm font-medium mb-2 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-primary" /> Proposed by Agent ({pending.length})
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            The agent thinks these workflows are worth saving as reusable skills.
          </p>
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="border rounded-lg p-3 bg-background">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">{p.pending_skill?.name || 'Untitled'}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{p.pending_skill?.description}</div>
                    <div className="text-[10px] text-muted-foreground mt-1 italic">From: "{p.prompt.slice(0, 100)}"</div>
                    {p.pending_skill?.steps?.length ? (
                      <ol className="text-xs text-muted-foreground mt-2 ml-4 list-decimal space-y-0.5">
                        {p.pending_skill.steps.slice(0, 5).map((s, i) => (
                          <li key={i}>{getStepDisplayText(s)}</li>
                        ))}
                      </ol>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <Button size="sm" onClick={() => acceptPending(p.id)}>Approve</Button>
                    <Button size="sm" variant="ghost" onClick={() => dismissPending(p.id)}>Dismiss</Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div>
        <h2 className="text-sm font-medium mb-2 flex items-center gap-2">
          <Brain className="w-4 h-4 text-muted-foreground" /> Persistent Memory ({memories.length})
        </h2>
        {memories.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground border-dashed space-y-3">
            <p>No persistent memories yet. In multi-agent mode the agent can now save durable facts, workflow notes, and subtask context here.</p>
            <Button variant="outline" size="sm" onClick={() => setMemoryOpen(true)}>
              <Brain className="w-4 h-4 mr-1.5" /> Add memory manually
            </Button>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {memories.map((memory) => (
              <Card key={memory.id} className="p-4 flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="font-medium text-sm min-w-0 truncate">{memory.title}</div>
                  <Badge variant="outline" className="text-[9px] shrink-0">{memory.memory_type}</Badge>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-3 mb-2">{memory.content}</p>
                {memory.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {memory.tags.slice(0, 5).map((tag, i) => (
                      <Badge key={i} variant="secondary" className="text-[9px]">{tag}</Badge>
                    ))}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground mb-3">
                  used {memory.use_count} times
                </div>
                <div className="mt-auto flex items-center gap-2">
                  <Switch checked={memory.enabled} onCheckedChange={(v) => toggleMemory(memory.id, v)} />
                  <Button size="icon" variant="ghost" onClick={() => removeMemory(memory.id)} className="ml-auto">
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Skills list */}
      <div>
        <h2 className="text-sm font-medium mb-2 flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-muted-foreground" /> My Skills ({skills.length})
        </h2>
        {loading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
        ) : skills.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground border-dashed">
            No skills yet. Install one from GitHub above, create one manually, or let the agent propose one after a successful task.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {skills.map((sk) => (
              <Card key={sk.id} className="p-4 flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="font-medium text-sm flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{sk.name}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Badge variant="outline" className="text-[9px]">{sk.risk_level}</Badge>
                    <Badge variant="outline" className="text-[9px]">{sk.source}</Badge>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{sk.description || 'No description'}</p>
                {sk.triggers.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {sk.triggers.slice(0, 4).map((t, i) => (
                      <Badge key={i} variant="secondary" className="text-[9px]">{t}</Badge>
                    ))}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground mb-3">
                  {sk.steps.length} steps · used {sk.use_count} times
                </div>
                <div className="mt-auto flex items-center gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => sk.required_inputs?.length
                      ? toast.info(`Use AI Chat and provide: ${sk.required_inputs.join(', ')}`)
                      : runSkill(sk.id)}
                    disabled={running === sk.id || !sk.enabled}
                  >
                    {running === sk.id
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <><Play className="w-3.5 h-3.5 mr-1" /> {sk.required_inputs?.length ? 'Use in Chat' : 'Test'}</>}
                  </Button>
                  <Switch checked={sk.enabled} onCheckedChange={(v) => toggleEnabled(sk.id, v)} />
                  <Button size="icon" variant="ghost" onClick={() => remove(sk.id)}>
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={memoryOpen} onOpenChange={setMemoryOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>New Persistent Memory</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">Title</label>
              <Input value={memoryDraft.title} onChange={(e) => setMemoryDraft({ ...memoryDraft, title: e.target.value })} placeholder="e.g. Preferred landing page style" />
            </div>
            <div>
              <label className="text-xs font-medium">Memory type</label>
              <select
                value={memoryDraft.memory_type}
                onChange={(e) => setMemoryDraft({ ...memoryDraft, memory_type: e.target.value })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="fact">Fact</option>
                <option value="workflow">Workflow</option>
                <option value="preference">Preference</option>
                <option value="subtask">Subtask</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium">Content</label>
              <Textarea value={memoryDraft.content} onChange={(e) => setMemoryDraft({ ...memoryDraft, content: e.target.value })} rows={4} placeholder="Store durable context the agent should be able to reuse later." />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
              <div>
                <label className="text-xs font-medium">Tags (comma-separated)</label>
                <Input value={memoryDraft.tags} onChange={(e) => setMemoryDraft({ ...memoryDraft, tags: e.target.value })} placeholder="design, portfolio, automation" />
              </div>
              <div>
                <label className="text-xs font-medium">Importance</label>
                <Input
                  type="number"
                  min={MIN_MEMORY_IMPORTANCE}
                  max={MAX_MEMORY_IMPORTANCE}
                  value={memoryDraft.importance}
                  onChange={(e) => setMemoryDraft({ ...memoryDraft, importance: Number(e.target.value) || DEFAULT_MEMORY_IMPORTANCE })}
                  className="sm:w-24"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMemoryOpen(false)}>Cancel</Button>
            <Button onClick={createMemory} disabled={!memoryDraft.title.trim() || !memoryDraft.content.trim()}>Save Memory</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>New Skill</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">Name</label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Daily LinkedIn digest" />
            </div>
            <div>
              <label className="text-xs font-medium">Description</label>
              <Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} />
            </div>
            <div>
              <label className="text-xs font-medium">Trigger phrases (comma-separated)</label>
              <Input value={draft.triggers} onChange={(e) => setDraft({ ...draft, triggers: e.target.value })} placeholder="linkedin digest, daily summary" />
            </div>
            <div>
              <label className="text-xs font-medium">System instructions</label>
              <Textarea value={draft.system_prompt} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} rows={3} placeholder="Extra context for the agent when running this skill." />
            </div>
            <div>
              <label className="text-xs font-medium">Steps (one per line)</label>
              <Textarea value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} rows={4} placeholder="Research today's top AI news&#10;Generate a hero image&#10;Compose a LinkedIn post" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createManual} disabled={!draft.name.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
