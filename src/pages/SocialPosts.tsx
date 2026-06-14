import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Send, Calendar, Trash2, RefreshCw, Image as ImageIcon, X, Clock, CheckCircle2, AlertCircle, Loader2, Sparkles } from 'lucide-react';
import {
  getSocialAccounts,
  listSocialPosts,
  createSocialPost,
  deleteSocialPost,
  retrySocialPost,
  uploadSocialImage,
  getSocialImageUrl,
  SOCIAL_PLATFORMS,
  type SocialAccount,
  type SocialPost,
  type SourceMeta,
  type AIGenerateOutput,
} from '@/lib/socialPosts';
import AIPostComposer from '@/components/AIPostComposer';
import UploadPostImporter, { type ImportedBundle } from '@/components/UploadPostImporter';
import FolderPostScheduler from '@/components/FolderPostScheduler';
import GenerationScheduler from '@/components/GenerationScheduler';
import { saveLocalJobAccountSelections } from '@/lib/localBrowserProfiles';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';

const PLATFORM_LABELS: Record<string, string> = { x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook' };

function ComposeTab({ accounts, onCreated }: { accounts: SocialAccount[]; onCreated: () => void }) {
  const { toast } = useToast();
  const [description, setDescription] = useState('');
  const [hashtagsRaw, setHashtagsRaw] = useState('');
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(['x']);
  const [accountSelections, setAccountSelections] = useState<Record<string, string>>({});
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [aiImagePath, setAiImagePath] = useState<string | null>(null);
  // Extra images attached on top of the primary one — populated by Upload Post imports.
  // Pre-uploaded paths (from importer) bypass the File reupload and ride along in image_paths.
  const [extraImageFiles, setExtraImageFiles] = useState<File[]>([]);
  const [extraImagePreviews, setExtraImagePreviews] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [aiPrompt, setAiPrompt] = useState<string | null>(null);
  const [aiSources, setAiSources] = useState<any[]>([]);
  const [platformVariants, setPlatformVariants] = useState<Record<string, { description: string; hashtags: string[] }>>({});
  const [sourceMeta, setSourceMeta] = useState<SourceMeta | null>(null);
  // Which platform's variant is currently shown in the preview switcher.
  const [previewPlatform, setPreviewPlatform] = useState<string>('x');

  const accountsByPlatform = useMemo(() => {
    const map: Record<string, SocialAccount[]> = {};
    for (const p of SOCIAL_PLATFORMS) map[p] = accounts.filter((a) => a.platform === p && a.enabled);
    return map;
  }, [accounts]);

  const togglePlatform = (p: string) => {
    setSelectedPlatforms((prev) => {
      const next = prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p];
      // Auto-pick default account
      if (!prev.includes(p)) {
        const list = accountsByPlatform[p] || [];
        const def = list.find((a) => a.is_default) || list[0];
        if (def) setAccountSelections((s) => ({ ...s, [p]: def.id }));
      }
      return next;
    });
  };

  const handleImageChange = (file: File | null) => {
    setImageFile(file);
    setAiImagePath(null);
    setSourceMeta(null);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(file ? URL.createObjectURL(file) : null);
    // Clear bundle extras whenever the user picks a manual single image.
    extraImagePreviews.forEach((u) => URL.revokeObjectURL(u));
    setExtraImageFiles([]);
    setExtraImagePreviews([]);
  };

  // Loads a parsed TechPulse bundle into the composer form (no upload yet — user clicks Post Now).
  const handleImportedBundle = (b: ImportedBundle) => {
    // Pick primary text from the first available platform variant.
    const variants: Record<string, { description: string; hashtags: string[] }> = {};
    for (const p of b.platforms) {
      if (b.texts[p]) variants[p] = { description: b.texts[p], hashtags: [] };
    }
    setSelectedPlatforms(b.platforms);
    setPlatformVariants(variants);
    setPreviewPlatform(b.platforms[0] || 'x');
    setDescription(b.texts[b.platforms[0]] || '');
    setHashtagsRaw('');
    setAiPrompt(null);
    setAiSources([]);

    // Image: first one is "primary", rest go in extras.
    const [first, ...rest] = b.images;
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    extraImagePreviews.forEach((u) => URL.revokeObjectURL(u));
    setAiImagePath(null);
    setSourceMeta(null);
    setImageFile(first ? first.file : null);
    setImagePreview(first ? URL.createObjectURL(first.file) : null);
    setExtraImageFiles(rest.map((r) => r.file));
    setExtraImagePreviews(rest.map((r) => URL.createObjectURL(r.file)));
    setSourceMeta(b.sourceMeta || null);

    // Auto-pick default accounts for each platform when available.
    setAccountSelections((prev) => {
      const next = { ...prev };
      for (const p of b.platforms) {
        if (next[p]) continue;
        const list = accountsByPlatform[p] || [];
        const def = list.find((a) => a.is_default) || list[0];
        if (def) next[p] = def.id;
      }
      return next;
    });
  };

  const handleAIUse = (out: AIGenerateOutput, prompt: string) => {
    setDescription(out.description);
    setHashtagsRaw(out.hashtags.join(' '));
    setAiPrompt(prompt);
    setAiSources(out.sources || []);
    setPlatformVariants(out.variants || {});
    setSourceMeta(null);
    if (out.imagePath && out.imageUrl) {
      setAiImagePath(out.imagePath);
      setImageFile(null);
      if (imagePreview) URL.revokeObjectURL(imagePreview);
      setImagePreview(out.imageUrl);
    }
    // Auto-select all platforms with a generated variant so the user can flip through them.
    const variantPlatforms = Object.keys(out.variants || {});
    if (variantPlatforms.length) {
      setSelectedPlatforms(variantPlatforms);
      setPreviewPlatform(variantPlatforms[0]);
    }
    toast({ title: 'AI content loaded', description: 'Switch tabs below to preview each platform — click "Post this one" to publish.' });
  };

  // Switch the preview to a different platform — also flips the main description/hashtags
  // to that variant so editing + Post Now will use the right text.
  const switchPreview = (p: string) => {
    setPreviewPlatform(p);
    const v = platformVariants[p];
    if (v) {
      setDescription(v.description);
      setHashtagsRaw(v.hashtags.join(' '));
    }
  };

  // Returns true when every selected platform has at least one enabled account.
  const allPlatformsHaveAccounts = () =>
    selectedPlatforms.every((p) => (accountsByPlatform[p] || []).length > 0);

  const [missingAccountsOpen, setMissingAccountsOpen] = useState(false);
  const missingPlatforms = selectedPlatforms.filter((p) => (accountsByPlatform[p] || []).length === 0);

  const persistPost = async (mode: 'now' | 'schedule' | 'draft') => {
    let imagePath: string | null = aiImagePath;
    if (imageFile) imagePath = await uploadSocialImage(imageFile);

    // Upload any extra bundle images alongside the primary one.
    const extraPaths: string[] = [];
    for (const f of extraImageFiles) extraPaths.push(await uploadSocialImage(f));
    const allPaths = [imagePath, ...extraPaths].filter((p): p is string => !!p);

    const hashtags = hashtagsRaw
      .split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);

    const post = await createSocialPost({
      description,
      imagePath,
      imagePaths: allPaths,
      hashtags,
      platforms: selectedPlatforms,
      accountSelections: mode === 'draft' ? {} : accountSelections,
      scheduledAt: mode === 'schedule' ? new Date(scheduledAt).toISOString() : null,
      aiPrompt,
      aiSources,
      platformVariants: Object.keys(platformVariants).length ? platformVariants : undefined,
      sourceMeta,
    });

    // Force draft status when saving without accounts
    if (mode === 'draft') {
      try { await (await import('@/integrations/supabase/client')).supabase
        .from('social_posts').update({ status: 'draft' } as any).eq('id', post.id); } catch {}
    } else {
      // Persist selections to local server too (matches video upload pattern)
      try { await saveLocalJobAccountSelections(post.id, accountSelections); } catch {}
    }

    // Trigger immediate processing for "now"
    if (mode === 'now') {
      try {
        await fetch(`http://localhost:3001/api/social-posts/process/${post.id}`, { method: 'POST' });
      } catch {}
    }
    return post;
  };

  // Direct path from the importer to the queue — bypasses the form so the user can
  // ship one bundle without scrolling down. Mirrors persistPost but takes the bundle.
  const sendBundleToQueue = async (b: ImportedBundle, mode: 'now' | 'schedule' | 'draft', scheduledIso?: string) => {
    const paths: string[] = [];
    for (const img of b.images) paths.push(await uploadSocialImage(img.file));
    const accountsForBundle: Record<string, string> = {};
    if (mode !== 'draft') {
      for (const p of b.platforms) {
        const list = accountsByPlatform[p] || [];
        const def = list.find((a) => a.is_default) || list[0];
        if (def) accountsForBundle[p] = def.id;
      }
    }
    const variants: Record<string, { description: string; hashtags: string[] }> = {};
    for (const p of b.platforms) if (b.texts[p]) variants[p] = { description: b.texts[p], hashtags: [] };

    const post = await createSocialPost({
      description: b.texts[b.platforms[0]] || '',
      imagePath: paths[0] || null,
      imagePaths: paths,
      hashtags: [],
      platforms: b.platforms,
      accountSelections: accountsForBundle,
      scheduledAt: mode === 'schedule' ? (scheduledIso || null) : null,
      platformVariants: variants,
      sourceMeta: b.sourceMeta,
    });
    if (mode === 'draft') {
      try { await (await import('@/integrations/supabase/client')).supabase
        .from('social_posts').update({ status: 'draft' } as any).eq('id', post.id); } catch {}
    } else {
      try { await saveLocalJobAccountSelections(post.id, accountsForBundle); } catch {}
    }
    if (mode === 'now') {
      try { await fetch(`http://localhost:3001/api/social-posts/process/${post.id}`, { method: 'POST' }); } catch {}
    }
    onCreated();
  };

  const handleSubmit = async (mode: 'now' | 'schedule' | 'draft') => {
    if (!description.trim()) { toast({ title: 'Description is required', variant: 'destructive' }); return; }
    if (selectedPlatforms.length === 0) { toast({ title: 'Pick at least one platform', variant: 'destructive' }); return; }
    if (mode === 'schedule' && !scheduledAt) { toast({ title: 'Pick a scheduled time', variant: 'destructive' }); return; }

    // For "now"/"schedule", require accounts. If missing, surface the add-accounts dialog.
    if (mode !== 'draft') {
      if (!allPlatformsHaveAccounts()) { setMissingAccountsOpen(true); return; }
      // Default-pick accounts when not yet chosen
      for (const p of selectedPlatforms) {
        if (!accountSelections[p]) {
          const list = accountsByPlatform[p] || [];
          accountSelections[p] = (list.find((a) => a.is_default) || list[0]).id;
        }
      }
    }

    setSubmitting(true);
    try {
      await persistPost(mode);
      toast({ title: mode === 'now' ? 'Post queued' : mode === 'schedule' ? 'Post scheduled' : 'Saved as draft' });
      // Reset
      setDescription(''); setHashtagsRaw(''); setImageFile(null); setAiImagePath(null);
      if (imagePreview) URL.revokeObjectURL(imagePreview);
      setImagePreview(null);
      extraImagePreviews.forEach((u) => URL.revokeObjectURL(u));
      setExtraImageFiles([]); setExtraImagePreviews([]);
      setScheduledAt(''); setAiPrompt(null); setAiSources([]);
      setPlatformVariants({});
      setSourceMeta(null);
      onCreated();
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
    } finally { setSubmitting(false); }
  };

  return (
    <div className="space-y-6">
      <AIPostComposer platforms={[...SOCIAL_PLATFORMS]} onUse={handleAIUse} />

      <Tabs defaultValue="single" className="w-full">
        <TabsList>
          <TabsTrigger value="single">Single upload</TabsTrigger>
          <TabsTrigger value="schedule">Schedule recurring</TabsTrigger>
        </TabsList>
        <TabsContent value="single" className="mt-3">
          <UploadPostImporter onLoad={handleImportedBundle} onSendToQueue={sendBundleToQueue} />
        </TabsContent>
        <TabsContent value="schedule" className="mt-3">
          <FolderPostScheduler />
        </TabsContent>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compose Post</CardTitle>
          <CardDescription>Manual or AI-assisted. Select platforms, account, image, then post or schedule.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Platforms</Label>
            <div className="flex flex-wrap gap-2">
              {SOCIAL_PLATFORMS.map((p) => {
                const active = selectedPlatforms.includes(p);
                const hasAccounts = (accountsByPlatform[p] || []).length > 0;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePlatform(p)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      active ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-secondary text-foreground hover:bg-secondary/80 border-border'
                    }`}
                    title={!hasAccounts ? 'Preview only — add an account in Settings to post' : ''}
                  >
                    {PLATFORM_LABELS[p]}{!hasAccounts && ' (preview only)'}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Per-platform preview switcher — appears once AI variants are loaded.
              Lets the user flip through X / LinkedIn / Facebook captions, see the same image,
              and post just that one platform with a single click. */}
          {Object.keys(platformVariants).length > 0 && (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-primary" /> Per-platform preview
                  </Label>
                </div>
                <Tabs value={previewPlatform} onValueChange={switchPreview}>
                  <TabsList className="h-8">
                    {SOCIAL_PLATFORMS.map((p) => (
                      <TabsTrigger key={p} value={p} className="text-xs h-6 px-2.5">
                        {PLATFORM_LABELS[p]}
                        {platformVariants[p] && <CheckCircle2 className="w-3 h-3 ml-1 text-emerald-500" />}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {SOCIAL_PLATFORMS.map((p) => {
                    const v = platformVariants[p];
                    const hasAccounts = (accountsByPlatform[p] || []).length > 0;
                    return (
                      <TabsContent key={p} value={p} className="mt-3 space-y-3">
                        {!v ? (
                          <p className="text-sm text-muted-foreground">No variant generated for {PLATFORM_LABELS[p]}.</p>
                        ) : (
                          <>
                            <div className="rounded-lg border bg-card p-3 space-y-2">
                              {imagePreview && (
                                <img src={imagePreview} alt="" className="rounded max-h-48 object-cover w-full" />
                              )}
                              <p className="text-sm whitespace-pre-wrap leading-relaxed">{v.description}</p>
                              {v.hashtags.length > 0 && (
                                <p className="text-sm text-primary">{v.hashtags.map((h) => `#${h}`).join(' ')}</p>
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <span className="text-[11px] text-muted-foreground">
                                {v.description.length} chars · loaded into editor below
                              </span>
                              <Button
                                size="sm"
                                onClick={async () => {
                                  switchPreview(p);
                                  setSelectedPlatforms([p]);
                                  if (!hasAccounts) { setMissingAccountsOpen(true); return; }
                                  setTimeout(() => handleSubmit('now'), 50);
                                }}
                                disabled={submitting}
                                className="gap-1.5 h-8 text-xs"
                              >
                                <Send className="w-3.5 h-3.5" /> Post this {PLATFORM_LABELS[p]} version
                              </Button>
                            </div>
                          </>
                        )}
                      </TabsContent>
                    );
                  })}
                </Tabs>
              </CardContent>
            </Card>
          )}

          {selectedPlatforms.map((p) => {
            const list = accountsByPlatform[p] || [];
            if (list.length <= 1) return null;
            return (
              <div key={p} className="space-y-1.5">
                <Label className="text-xs capitalize">{PLATFORM_LABELS[p]} Account</Label>
                <Select value={accountSelections[p] || ''} onValueChange={(v) => setAccountSelections((s) => ({ ...s, [p]: v }))}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Select account" /></SelectTrigger>
                  <SelectContent>
                    {list.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.label || a.email}{a.is_default ? ' ★' : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5}
              placeholder="What's on your mind? You can include #hashtags inline." />
            <p className="text-xs text-muted-foreground">{description.length} chars · X limit ≈ 280</p>
          </div>

          <div className="space-y-2">
            <Label>Extra Hashtags (optional)</Label>
            <Input value={hashtagsRaw} onChange={(e) => setHashtagsRaw(e.target.value)}
              placeholder="summer, beach, sale (or #summer #beach)" />
          </div>

          <div className="space-y-2">
            <Label>Image{extraImagePreviews.length > 0 && ` (1 + ${extraImagePreviews.length} extra)`}</Label>
            {imagePreview ? (
              <div className="space-y-2">
                <div className="relative inline-block">
                  <img src={imagePreview} alt="" className="max-h-60 rounded-lg border" />
                  <button type="button" onClick={() => handleImageChange(null)}
                    className="absolute top-2 right-2 bg-background/90 rounded-full p-1 hover:bg-destructive hover:text-destructive-foreground">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {extraImagePreviews.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {extraImagePreviews.map((u, i) => (
                      <div key={i} className="relative">
                        <img src={u} alt="" className="w-20 h-20 object-cover rounded border" />
                        <button
                          type="button"
                          onClick={() => {
                            URL.revokeObjectURL(u);
                            setExtraImagePreviews((prev) => prev.filter((_, idx) => idx !== i));
                            setExtraImageFiles((prev) => prev.filter((_, idx) => idx !== i));
                          }}
                          className="absolute -top-1 -right-1 bg-background/90 rounded-full p-0.5 hover:bg-destructive hover:text-destructive-foreground"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <label className="flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg p-6 cursor-pointer hover:border-primary/50 transition-colors">
                <ImageIcon className="w-5 h-5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Click to upload image</span>
                <input type="file" accept="image/*" className="hidden"
                  onChange={(e) => handleImageChange(e.target.files?.[0] || null)} />
              </label>
            )}
          </div>

          <div className="space-y-2">
            <Label>Schedule (optional)</Label>
            <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </div>

          <div className="flex gap-2 pt-2 flex-wrap">
            <Button onClick={() => handleSubmit('now')} disabled={submitting} className="gap-2">
              <Send className="w-4 h-4" /> Post Now
            </Button>
            <Button variant="outline" onClick={() => handleSubmit('schedule')} disabled={submitting || !scheduledAt} className="gap-2">
              <Calendar className="w-4 h-4" /> Schedule
            </Button>
            <Button variant="secondary" onClick={() => handleSubmit('draft')} disabled={submitting} className="gap-2">
              💾 Save as Draft
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Missing-accounts dialog: prompts user to add accounts before posting (or save as draft instead) */}
      <AlertDialog open={missingAccountsOpen} onOpenChange={setMissingAccountsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>No accounts for {missingPlatforms.map((p) => PLATFORM_LABELS[p]).join(', ')}</AlertDialogTitle>
            <AlertDialogDescription>
              You need to add at least one account per platform before posting. You can save this post as a draft now and add accounts later, or jump to Settings to add them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <Button variant="secondary" onClick={async () => { setMissingAccountsOpen(false); await handleSubmit('draft'); }}>
              Save as draft
            </Button>
            <AlertDialogAction onClick={() => { setMissingAccountsOpen(false); window.location.href = '/settings'; }}>
              Add accounts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'success' || status === 'completed') return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
  if (status === 'error' || status === 'failed') return <AlertCircle className="w-4 h-4 text-destructive" />;
  if (status === 'uploading' || status === 'processing') return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
  return <Clock className="w-4 h-4 text-muted-foreground" />;
}

function QueueTab({ posts, accounts, onChange }: { posts: SocialPost[]; accounts: SocialAccount[]; onChange: () => void }) {
  const { toast } = useToast();

  const accountsByPlatform = useMemo(() => {
    const m: Record<string, SocialAccount[]> = {};
    for (const p of SOCIAL_PLATFORMS) m[p] = accounts.filter((a) => a.platform === p && a.enabled);
    return m;
  }, [accounts]);

  const handleDelete = async (id: string) => {
    try { await deleteSocialPost(id); toast({ title: 'Removed' }); onChange(); }
    catch (e: any) { toast({ title: 'Error', description: e.message, variant: 'destructive' }); }
  };

  const handleRetry = async (id: string) => {
    try {
      await retrySocialPost(id);
      try { await fetch(`http://localhost:3001/api/social-posts/process/${id}`, { method: 'POST' }); } catch {}
      toast({ title: 'Retrying' });
      onChange();
    } catch (e: any) { toast({ title: 'Error', description: e.message, variant: 'destructive' }); }
  };

  // 1-click publish for drafts: auto-pick the default (or first enabled) account per
  // selected platform, flip status to pending, and kick the local processor.
  const handlePostNow = async (post: SocialPost) => {
    const selections: Record<string, string> = { ...(post.account_selections || {}) };
    const missing: string[] = [];
    for (const p of post.target_platforms) {
      if (selections[p]) continue;
      const list = accountsByPlatform[p] || [];
      const def = list.find((a) => a.is_default) || list[0];
      if (def) selections[p] = def.id; else missing.push(p);
    }
    if (missing.length) {
      toast({
        title: `No account for ${missing.map((p) => PLATFORM_LABELS[p] || p).join(', ')}`,
        description: 'Add an account in Settings before posting.',
        variant: 'destructive',
      });
      return;
    }
    try {
      const platformResults = post.target_platforms.map((name) => ({ name, status: 'pending' as const }));
      await (await import('@/integrations/supabase/client')).supabase
        .from('social_posts').update({
          status: 'pending',
          account_selections: selections,
          platform_results: platformResults,
        } as any).eq('id', post.id);
      try { await saveLocalJobAccountSelections(post.id, selections); } catch {}
      try { await fetch(`http://localhost:3001/api/social-posts/process/${post.id}`, { method: 'POST' }); } catch {}
      toast({ title: 'Posting now', description: `Sending to ${post.target_platforms.map((p) => PLATFORM_LABELS[p] || p).join(', ')}` });
      onChange();
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
    }
  };

  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('post');
  useEffect(() => {
    if (!highlightId) return;
    const el = document.getElementById(`post-${highlightId}`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }, [highlightId, posts.length]);

  if (posts.length === 0) {
    return <div className="text-center text-muted-foreground py-12">No posts yet. Compose one above.</div>;
  }

  return (
    <div className="space-y-3">
      {posts.map((post) => {
        const imageUrl = getSocialImageUrl(post.image_path);
        const isHighlighted = post.id === highlightId;
        return (
          <Card key={post.id} id={`post-${post.id}`} className={isHighlighted ? 'ring-2 ring-primary' : ''}>
            <CardContent className="p-4 flex gap-4">
              {imageUrl && (
                <img src={imageUrl} alt="" className="w-20 h-20 object-cover rounded-md border shrink-0" />
              )}
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusIcon status={post.status} />
                  <Badge variant="outline" className="capitalize">{post.status}</Badge>
                  {post.target_platforms.map((p) => (
                    <Badge key={p} variant="secondary" className="text-[10px]">{PLATFORM_LABELS[p] || p}</Badge>
                  ))}
                  {post.scheduled_at && (
                    <span className="text-xs text-muted-foreground">
                      <Clock className="w-3 h-3 inline mr-0.5" />
                      {new Date(post.scheduled_at).toLocaleString()}
                    </span>
                  )}
                </div>
                <p className="text-sm whitespace-pre-wrap line-clamp-3">{post.description}</p>
                {post.platform_results.length > 0 && (
                  <div className="space-y-0.5">
                    {post.platform_results.map((r) => (
                      <div key={r.name} className="text-xs flex items-center gap-1.5">
                        <StatusIcon status={r.status} />
                        <span className="capitalize font-medium">{PLATFORM_LABELS[r.name] || r.name}:</span>
                        {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate">{r.url}</a>}
                        {r.error && <span className="text-destructive truncate">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                {post.status === 'draft' && (
                  <Button size="sm" onClick={() => handlePostNow(post)} className="gap-1.5">
                    <Send className="w-3.5 h-3.5" /> Post Now
                  </Button>
                )}
                {(post.status === 'failed' || post.platform_results.some((r) => r.status === 'error')) && (
                  <Button size="sm" variant="outline" onClick={() => handleRetry(post.id)}>
                    <RefreshCw className="w-3.5 h-3.5" />
                  </Button>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" className="hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete post?</AlertDialogTitle>
                      <AlertDialogDescription>This permanently removes the post from the queue.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleDelete(post.id)} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default function SocialPostsPage() {
  const queryClient = useQueryClient();
  const { data: accounts = [] } = useQuery({ queryKey: ['social_accounts'], queryFn: getSocialAccounts });
  const { data: posts = [] } = useQuery({ queryKey: ['social_posts'], queryFn: listSocialPosts, refetchInterval: 5000 });
  const [searchParams] = useSearchParams();
  // When arriving via "View draft" link (?post=<id>), jump straight to the Queue tab
  // where the draft is highlighted and the one-click "Post Now" button is visible.
  const initialTab = searchParams.get('post') ? 'queue' : 'compose';
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    if (searchParams.get('post')) setTab('queue');
  }, [searchParams]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['social_posts'] });
    queryClient.invalidateQueries({ queryKey: ['social_accounts'] });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Social Posts</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Compose, schedule, and AI-generate posts for X, LinkedIn, and Facebook.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="compose">Compose</TabsTrigger>
          <TabsTrigger value="queue">Queue ({posts.length})</TabsTrigger>
          <TabsTrigger value="schedules">Campaigns</TabsTrigger>
        </TabsList>
        <TabsContent value="compose" className="mt-6">
          <ComposeTab accounts={accounts} onCreated={refresh} />
        </TabsContent>
        <TabsContent value="queue" className="mt-6">
          <QueueTab posts={posts} accounts={accounts} onChange={refresh} />
        </TabsContent>
        <TabsContent value="schedules" className="mt-6">
          <GenerationScheduler />
        </TabsContent>
      </Tabs>
    </div>
  );
}
