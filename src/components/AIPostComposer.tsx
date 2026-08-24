import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sparkles, RefreshCw, Wand2, ExternalLink, CheckCircle2, AlertTriangle, Loader2, Cpu, Search, Image as ImageIcon, Wrench, Globe, Monitor } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQuery } from '@tanstack/react-query';
import {
  generatePostStream,
  getAISettings,
  getAgentSettings,
  type AIGenerateOutput,
  type AgentSource,
  type AgentTool,
  type AIStreamEvent,
  type PlatformVariant,
} from '@/lib/socialPosts';

const PLATFORM_LABELS: Record<string, string> = { x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook' };
const PLATFORM_LIMITS: Record<string, number> = { x: 280, linkedin: 3000, facebook: 2200 };

interface Step { id: string; emoji: string; label: string; status: 'active' | 'done' | 'error' }
interface Plan { queries: string[]; imageStrategy: string; angle: string }

interface Props {
  platforms: string[];
  onUse: (output: AIGenerateOutput, prompt: string) => void;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

const ACTIVE_JOB_KEY = 'ai_active_generation_job';

export default function AIPostComposer({ platforms, onUse }: Props) {
  const { toast } = useToast();
  const [prompt, setPrompt] = useState('');
  const [includeImage, setIncludeImage] = useState(true);
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [liveSources, setLiveSources] = useState<AgentSource[]>([]);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [variants, setVariants] = useState<Record<string, PlatformVariant>>({});
  const [sources, setSources] = useState<AgentSource[]>([]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [imageCredit, setImageCredit] = useState<string>('');
  const [imageSourceUrl, setImageSourceUrl] = useState<string>('');
  const [quality, setQuality] = useState<AIGenerateOutput['quality']>(undefined);
  const [activeTab, setActiveTab] = useState<string>('');
  const [meta, setMeta] = useState<{ provider?: string; model?: string }>({});
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const { data: aiSettings } = useQuery({ queryKey: ['ai_settings'], queryFn: getAISettings });
  const { data: agentSettings } = useQuery({ queryKey: ['agent_settings'], queryFn: getAgentSettings });

  useEffect(() => {
    if (platforms.length && !platforms.includes(activeTab)) setActiveTab(platforms[0]);
  }, [platforms, activeTab]);

  const upsertStep = (s: Step) => {
    setSteps((prev) => {
      const idx = prev.findIndex((x) => x.id === s.id);
      if (idx === -1) return [...prev, s];
      const copy = [...prev]; copy[idx] = s; return copy;
    });
  };

  const resetState = () => {
    setSteps([]); setPlan(null); setLiveSources([]); setTools([]); setVariants({});
    setSources([]); setImageUrl(null); setImagePath(null); setImageCredit(''); setImageSourceUrl(''); setQuality(undefined); setMeta({});
  };

  // Consume a single AIStreamEvent — used both for live SSE and replay from generation_jobs.events
  const consumeEvent = (e: AIStreamEvent) => {
    if (e.type === 'job') { setActiveJobId(e.id); try { localStorage.setItem(ACTIVE_JOB_KEY, e.id); } catch {} }
    else if (e.type === 'step') upsertStep({ id: e.id, emoji: e.emoji, label: e.label, status: e.status });
    else if (e.type === 'plan') setPlan({ queries: e.queries, imageStrategy: e.imageStrategy, angle: e.angle });
    else if (e.type === 'source') setLiveSources((s) => {
      if (s.find((x) => x.url === (e as any).url)) return s;
      return [...s, { title: (e as any).title, url: (e as any).url, snippet: (e as any).snippet, favicon: (e as any).favicon, publishedAt: (e as any).publishedAt }];
    });
    else if (e.type === 'tool') setTools((t) => {
      const key = `${e.kind}:${e.name}:${e.detail || ''}`;
      if (t.find((x) => `${x.kind}:${x.name}:${x.detail || ''}` === key)) return t;
      return [...t, { kind: e.kind, name: e.name, detail: e.detail }];
    });
    else if (e.type === 'variant') setVariants((v) => ({ ...v, [e.platform]: { description: e.description, hashtags: e.hashtags } }));
    else if (e.type === 'sources') setSources(e.sources);
    else if (e.type === 'image') { setImageUrl(e.imageUrl); setImagePath(e.imagePath); setImageCredit(e.credit || ''); setImageSourceUrl(e.sourceUrl || ''); }
    else if (e.type === 'done') {
      setVariants(e.variants); setSources(e.sources);
      if (e.imageUrl) { setImageUrl(e.imageUrl); setImagePath(e.imagePath); setImageCredit(e.imageCredit || ''); setImageSourceUrl(e.imageSourceUrl || ''); }
      setQuality(e.quality);
      setMeta({ provider: e.provider, model: e.model });
    }
    else if (e.type === 'error') {
      toast({ title: 'AI generation failed', description: e.error, variant: 'destructive' });
    }
  };

  // Resume an in-progress / recently completed generation when returning to this page.
  // Reads localStorage for the active job id, replays events, and polls until status is final.
  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | null = null;

    const resume = async () => {
      let jobId: string | null = null;
      try { jobId = localStorage.getItem(ACTIVE_JOB_KEY); } catch {}
      if (!jobId) return;
      const { getGenerationJob } = await import('@/lib/socialPosts');
      const replay = async () => {
        const job = await getGenerationJob(jobId!);
        if (!job || cancelled) return;
        setPrompt(job.prompt || '');
        setIncludeImage(job.include_image);
        setActiveJobId(job.id);
        resetState();
        for (const ev of job.events || []) consumeEvent(ev as AIStreamEvent);
        if (job.status === 'running') {
          setLoading(true);
          pollTimer = window.setTimeout(replay, 1500);
        } else {
          setLoading(false);
          if (job.status === 'completed') {
            try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
          } else if (job.status === 'failed' && job.error) {
            toast({ title: 'Previous generation failed', description: job.error, variant: 'destructive' });
            try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
          }
        }
      };
      await replay();
    };
    resume();
    return () => { cancelled = true; if (pollTimer) window.clearTimeout(pollTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGenerate = async () => {
    if (!prompt.trim()) { toast({ title: 'Enter a prompt first', variant: 'destructive' }); return; }
    if (platforms.length === 0) { toast({ title: 'Select at least one platform', variant: 'destructive' }); return; }

    setLoading(true);
    resetState();
    try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
    setActiveJobId(null);

    try {
      await generatePostStream({ prompt, platforms, includeImage }, consumeEvent);
    } catch (e: any) {
      toast({ title: 'AI generation failed', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
      // Final sweep — clear active job marker once stream ends cleanly.
      try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
    }
  };

  const useVariant = (platform: string) => {
    const v = variants[platform]; if (!v) return;
    onUse({ description: v.description, hashtags: v.hashtags, variants, imageUrl, imagePath, sources, provider: meta.provider, model: meta.model }, prompt);
    toast({ title: `Loaded ${PLATFORM_LABELS[platform] || platform} variant` });
  };

  const useAll = () => {
    if (!Object.keys(variants).length) return;
    const primary = variants[platforms[0]] || Object.values(variants)[0];
    onUse({ description: primary.description, hashtags: primary.hashtags, variants, imageUrl, imagePath, sources, provider: meta.provider, model: meta.model }, prompt);
    toast({ title: 'All variants loaded' });
  };

  const currentAi = meta.model || aiSettings?.model || 'google/gemini-3-flash-preview';
  const currentProvider = meta.provider || aiSettings?.provider || 'lovable';
  const finalSources = sources.length ? sources : liveSources;

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-primary" /> AI Post Generator
            </CardTitle>
            <CardDescription className="mt-1">
              Real research agent: plans → searches the web → reads sources → finds/generates an image → writes platform-tailored posts.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-1.5 justify-end">
            <Badge variant="outline" className="gap-1.5 text-[11px] font-mono" title="LLM (writes the post)">
              <Cpu className="w-3 h-3 text-primary" />
              {currentProvider} · {currentAi.split('/').pop()}
            </Badge>
            <Badge variant="outline" className="gap-1.5 text-[11px] font-mono" title="Research provider (finds sources)">
              <Search className="w-3 h-3 text-primary" />
              {agentSettings?.researchProvider || 'auto'}
            </Badge>
            <Badge variant="outline" className="gap-1.5 text-[11px] font-mono" title="Image provider/model (visual)">
              <ImageIcon className="w-3 h-3 text-primary" />
              {agentSettings?.imageProvider || 'auto'}
              {agentSettings?.imageModel && <span className="text-muted-foreground">· {agentSettings.imageModel.split('/').pop()}</span>}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">Prompt</Label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Latest Web3 news from the past 24h — research real sources, find a fitting image, casual tone"
            rows={3}
          />
        </div>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Label className="text-sm flex items-center gap-2 cursor-pointer">
            <Switch checked={includeImage} onCheckedChange={setIncludeImage} disabled={loading} />
            Include image
          </Label>
          <Button onClick={handleGenerate} disabled={loading} className="gap-2">
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {loading ? 'Agent working…' : 'Generate'}
          </Button>
        </div>

        {/* Plan strip */}
        {plan && (
          <div className="rounded-lg border bg-card/60 backdrop-blur p-3 space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Agent plan</div>
            <p className="text-sm font-medium leading-snug">{plan.angle}</p>
            <div className="flex flex-wrap gap-1.5">
              {plan.queries.map((q, i) => (
                <Badge key={i} variant="secondary" className="text-[11px] gap-1 font-normal">
                  <Search className="w-3 h-3" /> {q}
                </Badge>
              ))}
              <Badge variant="outline" className="text-[11px] gap-1 font-normal">
                <ImageIcon className="w-3 h-3" /> {plan.imageStrategy === 'real_photo' ? 'real photo' : plan.imageStrategy === 'generated' ? 'AI generated' : 'no image'}
              </Badge>
            </div>
          </div>
        )}

        {/* Tools used (live) */}
        {tools.length > 0 && (
          <div className="rounded-lg border bg-card/60 backdrop-blur p-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-300">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5">
              <Wrench className="w-3 h-3" /> Tools the agent is using ({tools.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tools.map((t, i) => {
                const Icon = t.kind === 'research' ? Search : t.kind === 'scrape' ? Globe : t.kind === 'image' ? ImageIcon : Cpu;
                const isLocal = t.name === 'local' || t.name === 'duckduckgo' || t.name === 'google-local';
                return (
                  <Badge key={i} variant="outline" className="text-[11px] gap-1 font-normal animate-in fade-in zoom-in-95 duration-300">
                    <Icon className="w-3 h-3 text-primary" />
                    <span className="font-medium">{t.kind}</span>
                    <span className="text-muted-foreground">·</span>
                    <span>{t.name}</span>
                    {isLocal && <Monitor className="w-3 h-3 ml-0.5 text-amber-500" />}
                    {t.detail && <span className="text-muted-foreground truncate max-w-[160px]">— {t.detail}</span>}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}


        {(loading || steps.length > 0) && (
          <div className="rounded-xl border bg-gradient-to-br from-card to-card/40 backdrop-blur p-4 animate-in fade-in slide-in-from-top-2 duration-500">
            <div className="flex items-center gap-2 mb-3">
              <div className="relative flex h-2.5 w-2.5">
                {loading && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />}
                <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${loading ? 'bg-primary' : 'bg-emerald-500'}`} />
              </div>
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground/80">
                {loading ? 'Agent at work' : 'Agent finished'}
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground font-mono">
                {steps.filter((s) => s.status === 'done').length} / {steps.length}
              </span>
            </div>
            <ol className="relative space-y-2.5">
              <div className="absolute left-[15px] top-2 bottom-2 w-px bg-gradient-to-b from-primary/40 via-border to-border" aria-hidden />
              {steps.map((s, i) => (
                <li key={s.id + '-' + i} className="relative flex items-start gap-3 animate-in fade-in slide-in-from-left-2 duration-300">
                  <div className={`relative z-10 flex items-center justify-center w-8 h-8 rounded-full border-2 text-base shrink-0 transition-all ${
                    s.status === 'active' ? 'border-primary bg-primary/10 shadow-[0_0_0_4px_hsl(var(--primary)/0.12)]' :
                    s.status === 'done' ? 'border-emerald-500/50 bg-emerald-500/10' :
                    s.status === 'error' ? 'border-destructive/50 bg-destructive/10' :
                    'border-border bg-card'
                  }`}>
                    <span className={s.status === 'active' ? 'animate-pulse' : ''}>{s.emoji}</span>
                  </div>
                  <div className="flex-1 min-w-0 pt-1">
                    <div className={`text-sm leading-snug ${
                      s.status === 'done' ? 'text-foreground/70' :
                      s.status === 'error' ? 'text-destructive font-medium' :
                      s.status === 'active' ? 'text-foreground font-medium' :
                      'text-muted-foreground'
                    }`}>{s.label}</div>
                    {s.status === 'active' && (
                      <div className="mt-1.5 h-0.5 w-full bg-muted rounded-full overflow-hidden">
                        <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent animate-shimmer" />
                      </div>
                    )}
                  </div>
                  <div className="pt-1.5 shrink-0">
                    {s.status === 'active' && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
                    {s.status === 'done' && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                    {s.status === 'error' && <AlertTriangle className="w-4 h-4 text-destructive" />}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Live sources (cards) */}
        {liveSources.length > 0 && finalSources === liveSources && (
          <div className="rounded-lg border bg-card p-3 space-y-2 animate-in fade-in duration-300">
            <Label className="text-[11px] uppercase text-muted-foreground tracking-wider">Sources discovered live ({liveSources.length})</Label>
            <div className="grid sm:grid-cols-2 gap-2">
              {liveSources.map((s, i) => (
                <a key={i} href={s.url} target="_blank" rel="noreferrer"
                  className="group flex items-start gap-2.5 rounded-md border bg-background/60 p-2.5 hover:bg-accent transition-colors animate-in fade-in slide-in-from-bottom-1 duration-300">
                  {s.favicon
                    ? <img src={s.favicon} alt="" className="w-4 h-4 mt-0.5 rounded shrink-0" />
                    : <div className="w-4 h-4 mt-0.5 rounded bg-muted shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate group-hover:text-primary">{s.title || hostOf(s.url)}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{hostOf(s.url)}{s.publishedAt ? ` · ${s.publishedAt}` : ''}</div>
                    {s.snippet && <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{s.snippet}</div>}
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Per-platform variants */}
        {Object.keys(variants).length > 0 && (
          <div className="space-y-3 rounded-lg border bg-card p-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <Label className="text-xs uppercase text-muted-foreground">Tailored variants</Label>
              <Button size="sm" variant="secondary" onClick={useAll} className="gap-1.5 h-7 text-xs">
                <Sparkles className="w-3 h-3" /> Use all (per platform)
              </Button>
            </div>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="h-8">
                {platforms.map((p) => (
                  <TabsTrigger key={p} value={p} className="text-xs h-6 px-2.5">
                    {PLATFORM_LABELS[p] || p}
                    {variants[p] && <CheckCircle2 className="w-3 h-3 ml-1 text-emerald-500" />}
                  </TabsTrigger>
                ))}
              </TabsList>
              {platforms.map((p) => {
                const v = variants[p];
                if (!v) return (
                  <TabsContent key={p} value={p} className="mt-3 text-sm text-muted-foreground">
                    Waiting for {PLATFORM_LABELS[p] || p} variant…
                  </TabsContent>
                );
                const charCount = v.description.length + (v.hashtags.length ? v.hashtags.reduce((a, h) => a + h.length + 2, 0) : 0);
                const limit = PLATFORM_LIMITS[p] || 2200;
                const overLimit = charCount > limit;
                return (
                  <TabsContent key={p} value={p} className="mt-3 space-y-2.5">
                    <p className="text-sm whitespace-pre-wrap leading-relaxed">{v.description}</p>
                    {v.hashtags.length > 0 && (
                      <p className="text-sm text-primary leading-relaxed">{v.hashtags.map((h) => `#${h}`).join(' ')}</p>
                    )}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className={`text-[11px] ${overLimit ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                        {charCount} / {limit} chars
                      </span>
                      <Button size="sm" onClick={() => useVariant(p)} className="gap-1.5 h-7 text-xs">
                        Use this for {PLATFORM_LABELS[p] || p}
                      </Button>
                    </div>
                  </TabsContent>
                );
              })}
            </Tabs>
          </div>
        )}

        {imageUrl && (
          <div className="rounded-lg border bg-card p-4 space-y-2 animate-in fade-in duration-500">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs uppercase text-muted-foreground">Image{imageCredit ? ` · ${imageCredit}` : ''}</Label>
              {imageSourceUrl && <a href={imageSourceUrl} target="_blank" rel="noreferrer" className="text-[11px] text-primary hover:underline inline-flex items-center gap-1">Source <ExternalLink className="w-3 h-3" /></a>}
            </div>
            <img src={imageUrl} alt="" className="rounded-lg max-h-72 object-contain bg-muted w-full" />
            {quality && <div className="text-[11px] text-muted-foreground">Quality proof: {quality.reachableSources} readable sources · {quality.independentDomains} domains · {quality.groundedFacts} grounded facts · image validated</div>}
          </div>
        )}

        {/* Final sources panel — richer than the live one */}
        {sources.length > 0 && (
          <div className="rounded-lg border bg-card p-4 space-y-2 animate-in fade-in duration-500">
            <Label className="text-xs uppercase text-muted-foreground flex items-center gap-1.5">
              📚 Research sources ({sources.length})
              <span className="font-normal normal-case text-muted-foreground/70">— for your reference, not in post</span>
            </Label>
            <div className="grid sm:grid-cols-2 gap-2 mt-1">
              {sources.map((s, i) => (
                <a key={i} href={s.url} target="_blank" rel="noreferrer"
                  className="group flex items-start gap-2.5 rounded-md border bg-background/60 p-2.5 hover:bg-accent transition-colors">
                  {s.favicon
                    ? <img src={s.favicon} alt="" className="w-4 h-4 mt-0.5 rounded shrink-0" />
                    : <div className="w-4 h-4 mt-0.5 rounded bg-muted shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate group-hover:text-primary inline-flex items-center gap-1">
                      {s.title || hostOf(s.url)} <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">{hostOf(s.url)}{s.publishedAt ? ` · ${s.publishedAt}` : ''}</div>
                    {(s.snippet || s.note) && <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{s.snippet || s.note}</div>}
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        {Object.keys(variants).length > 0 && !loading && (
          <Button size="sm" variant="outline" onClick={handleGenerate} className="w-full">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Regenerate
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
