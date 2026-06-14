// Imports already-generated TechPulse social post bundles from a local folder.
// Sits between AI Post Generator and Compose Post on the Social Posts page.
//
// Bundle = 1 .txt manifest + N image files in the same folder. The manifest
// follows the TECHPULSE_SOCIAL_POST_V1 format with platform-specific text
// sections and an explicit image filename list.
//
// User flow:
//   1. Pick a folder (showDirectoryPicker) or `<input webkitdirectory>` or a single .txt
//   2. We parse all .txt manifests, match images by filename, validate
//   3. Bundles render as cards with thumbs + text preview
//   4. Click "Load into Composer" → preloads ComposeTab; user clicks Post Now / Schedule there
//
// Duplicate detection: filename + content hash stored in localStorage.

import { useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  FileText, Upload, AlertTriangle, CheckCircle2, RefreshCw, Send, Eye, Save, Calendar, Rocket,
} from 'lucide-react';

const PLATFORM_LABELS: Record<string, string> = { x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook' };
const SUPPORTED_IMG = /\.(jpe?g|png|webp)$/i;
const X_LIMIT = 280; // X Free account standard post limit
const IMPORTED_KEY = 'techpulse_imported_bundles_v1';

export interface ImportedBundle {
  id: string;                 // hash key for dedupe
  manifestName: string;
  folderHint: string;
  session: string;            // morning | evening | unknown
  postIndex: number | null;
  createdAt: string;
  platforms: string[];        // x, linkedin, facebook
  imageCount: number;         // declared
  images: { name: string; file: File; previewUrl: string }[];
  texts: Record<string, string>;   // platform → text
  articleUrls: string[];
  errors: string[];
  warnings: string[];
}

interface Props {
  onLoad: (bundle: ImportedBundle) => void;
  onSendToQueue?: (bundle: ImportedBundle, mode: 'now' | 'schedule' | 'draft', scheduledAt?: string) => Promise<void>;
}

// Read previously imported keys from localStorage so we can flag duplicates.
function readImportedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(IMPORTED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}
function rememberImported(id: string) {
  try {
    const cur = Array.from(readImportedKeys());
    if (!cur.includes(id)) cur.push(id);
    localStorage.setItem(IMPORTED_KEY, JSON.stringify(cur.slice(-500)));
  } catch {}
}

async function sha1(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Parses a TECHPULSE_SOCIAL_POST_V1 manifest. Returns headers, declared image
// filenames, and per-section text bodies keyed by section name.
function parseManifest(text: string) {
  const headers: Record<string, string> = {};
  const declaredImages: string[] = [];
  const sections: Record<string, string> = {};

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  // Header block: simple `key: value` pairs until first `---SECTION---` or `images:`
  while (i < lines.length) {
    const line = lines[i];
    if (/^---[A-Z_]+---$/.test(line.trim())) break;
    const match = line.match(/^([a-zA-Z_]+):\s*(.+)?$/);
    if (match) {
      headers[match[1].toLowerCase()] = (match[2] || '').trim();
    } else if (/^images:\s*$/i.test(line.trim())) {
      i++;
      // Numbered list of filenames
      while (i < lines.length) {
        const l = lines[i].trim();
        if (!l || /^---[A-Z_]+---$/.test(l)) break;
        const m = l.match(/^\d+\.\s*(.+)$/);
        if (m) declaredImages.push(m[1].trim());
        else break;
        i++;
      }
      continue;
    }
    i++;
  }

  // Walk sections: ---SECTION_NAME--- ... ---END_SECTION_NAME---
  while (i < lines.length) {
    const open = lines[i].trim().match(/^---([A-Z_]+)---$/);
    if (open) {
      const name = open[1];
      const close = `---END_${name}---`;
      const buf: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== close) {
        buf.push(lines[i]);
        i++;
      }
      sections[name] = buf.join('\n').trim();
    }
    i++;
  }

  return { headers, declaredImages, sections };
}

// Map a manifest's platforms list ("x.com, linkedin, facebook") to our keys.
function normalisePlatform(p: string): string | null {
  const t = p.toLowerCase().trim();
  if (t === 'x' || t === 'x.com' || t === 'twitter') return 'x';
  if (t === 'linkedin') return 'linkedin';
  if (t === 'facebook' || t === 'fb') return 'facebook';
  return null;
}

// Build text per platform from parsed sections.
// LinkedIn + Facebook share LINKEDIN_FACEBOOK_POST.
// X uses X_THREAD_OR_LONG_POST.
// Fallback: if those sections are missing, use `fallbackBody` (the manifest's
// free-form body with headers/article URLs/image list stripped) so plain .txt
// files written by the user still produce valid posts on every platform.
function buildPlatformTexts(
  sections: Record<string, string>,
  articleUrlsBlock: string,
  fallbackBody: string,
  fallbackXBody: string,
  platforms: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  // Per-platform sections (preferred new format).
  const liPost = sections['LINKEDIN_POST'] || '';
  const fbPost = sections['FACEBOOK_POST'] || '';
  const xPost = sections['X_POST'] || '';
  // Legacy combined sections.
  const liFb = sections['LINKEDIN_FACEBOOK_POST'] || '';
  const xLegacy = sections['X_THREAD_OR_LONG_POST'] || '';

  const links = articleUrlsBlock
    ? '\n\n' + articleUrlsBlock.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/^[^:]+:\s*(https?:\/\/.+)$/);
        return m ? m[1] : l;
      }).join('\n')
    : '';

  const liFinal = (liPost || liFb || fallbackBody || '').trim();
  const fbFinal = (fbPost || liFb || fallbackBody || '').trim();
  const xFinal = (xPost || xLegacy || fallbackXBody || fallbackBody || '').trim();
  const hasExplicitX = !!(xPost || xLegacy);
  const hasExplicitLi = !!(liPost || liFb);
  const hasExplicitFb = !!(fbPost || liFb);

  for (const p of platforms) {
    if (p === 'x' && xFinal) {
      out.x = (xFinal + (hasExplicitX ? '' : links)).trim();
    } else if (p === 'linkedin' && liFinal) {
      out.linkedin = (liFinal + (hasExplicitLi ? '' : links)).trim();
    } else if (p === 'facebook' && fbFinal) {
      out.facebook = (fbFinal + (hasExplicitFb ? '' : links)).trim();
    }
  }
  return out;
}

// Strip TechPulse-ish headers, ARTICLE_URLS lines, and an `images:` numbered
// list from the raw .txt so the remaining text can be used as the post body.
// Returns { body, xBody } — when the text contains a hashtag-only line acting
// as a divider, body = pre-hashtag (long, LI/FB), xBody = post-hashtag (short, X).
function deriveFallbackBody(rawText: string): { body: string; xBody: string } {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let inImagesList = false;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^---[A-Z_]+---$/.test(trimmed)) { i++; continue; }
    if (/^images:\s*$/i.test(trimmed)) { inImagesList = true; i++; continue; }
    if (inImagesList) {
      if (!trimmed || /^\d+\.\s*.+$/.test(trimmed)) { i++; continue; }
      inImagesList = false;
    }
    const headerMatch = trimmed.match(/^([a-zA-Z_]+):\s*(.+)?$/);
    if (headerMatch) {
      const k = headerMatch[1].toLowerCase();
      if (['platforms', 'image_count', 'session', 'post_index', 'created_at', 'topic', 'campaign', 'source', 'upload_mode'].includes(k)) {
        i++; continue;
      }
    }
    // Drop the format marker line (TECHPULSE_SOCIAL_POST_V1)
    if (/^TECHPULSE_SOCIAL_POST_V1$/i.test(trimmed)) { i++; continue; }
    out.push(line);
    i++;
  }
  const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // X now supports long posts (Premium up to 25k chars), so we use the same
  // full body for X as for LinkedIn/Facebook — no hashtag-line splitting.
  return { body: cleaned, xBody: cleaned };
}

async function processManifest(
  manifestFile: File,
  imageFiles: Map<string, File>,
  importedKeys: Set<string>,
): Promise<ImportedBundle> {
  const text = await manifestFile.text();
  const { headers, declaredImages, sections } = parseManifest(text);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/TECHPULSE_SOCIAL_POST_V1/.test(text)) {
    warnings.push('No TECHPULSE_SOCIAL_POST_V1 marker — using plain-text fallback');
  }

  let platforms = (headers.platforms || '')
    .split(',').map((p) => normalisePlatform(p)).filter((p): p is string => !!p);
  if (platforms.length === 0) {
    // No platforms declared → assume all three (matches default schedule target).
    platforms = ['x', 'linkedin', 'facebook'];
    warnings.push('No platforms declared — defaulting to X, LinkedIn, Facebook');
  }

  const declaredCount = parseInt(headers.image_count || `${declaredImages.length}`, 10) || declaredImages.length;

  // Fallback: when the manifest doesn't list images, discover them by filename
  // prefix — e.g. `2026-05-08-morning-post-01-story-01-*.jpg` for manifest
  // `2026-05-08-morning-post-01.txt`.
  let effectiveDeclared = declaredImages.slice();
  if (effectiveDeclared.length === 0) {
    const stem = manifestFile.name.replace(/\.[^.]+$/, '').toLowerCase();
    effectiveDeclared = Array.from(imageFiles.keys())
      .filter((n) => n.startsWith(stem))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  if (effectiveDeclared.length === 0) {
    warnings.push('No images found for this manifest — text-only post');
  }

  const images: { name: string; file: File; previewUrl: string }[] = [];
  for (const name of effectiveDeclared) {
    if (!SUPPORTED_IMG.test(name)) {
      errors.push(`Unsupported image type: ${name}`);
      continue;
    }
    const file = imageFiles.get(name.toLowerCase());
    if (!file) {
      errors.push(`Missing image file: ${name}`);
      continue;
    }
    images.push({ name, file, previewUrl: URL.createObjectURL(file) });
  }
  if (declaredImages.length && declaredImages.length !== declaredCount) {
    warnings.push(`Header image_count=${declaredCount} but ${declaredImages.length} listed`);
  }

  const { body: fallbackBody, xBody: fallbackXBody } = deriveFallbackBody(text);
  const texts = buildPlatformTexts(sections, sections['ARTICLE_URLS'] || '', fallbackBody, fallbackXBody, platforms);
  for (const p of platforms) {
    if (!texts[p] || !texts[p].trim()) errors.push(`Missing text section for ${PLATFORM_LABELS[p] || p}`);
  }

  // Article URLs as plain list
  const articleUrls = (sections['ARTICLE_URLS'] || '').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const m = l.match(/(https?:\/\/\S+)/);
      return m ? m[1] : '';
    }).filter(Boolean);

  const id = await sha1(`${manifestFile.name}::${text}`);
  if (importedKeys.has(id)) warnings.push('Already imported previously');

  const folderHint = ((manifestFile as any).webkitRelativePath || manifestFile.name).split('/').slice(0, -1).join('/') || '(local)';

  return {
    id,
    manifestName: manifestFile.name,
    folderHint,
    session: (headers.session || 'unknown').toLowerCase(),
    postIndex: parseInt(headers.post_index || '0', 10) || null,
    createdAt: headers.created_at || '',
    platforms,
    imageCount: declaredCount,
    images,
    texts,
    articleUrls,
    errors,
    warnings,
  };
}

const FOLDER_KEY = 'techpulse_news_folder_v1';
const LOCAL_SERVER = 'http://localhost:3001';

// Convert base64 string returned by the local server into a real File object
// so the rest of the pipeline (uploadSocialImage etc.) treats it like any
// browser-picked file.
function base64ToFile(name: string, mime: string, b64: string): File {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}

export default function UploadPostImporter({ onLoad, onSendToQueue }: Props) {
  const { toast } = useToast();
  const [bundles, setBundles] = useState<ImportedBundle[]>([]);
  const [loading, setLoading] = useState(false);
  const [folderPath, setFolderPath] = useState<string>(() => {
    try { return localStorage.getItem(FOLDER_KEY) || 'D:\\news posts'; } catch { return 'D:\\news posts'; }
  });
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const txtInputRef = useRef<HTMLInputElement | null>(null);
  const imgInputRef = useRef<HTMLInputElement | null>(null);

  // Per-platform full-preview / edit dialog state.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBundleId, setPreviewBundleId] = useState<string | null>(null);
  const [previewPlatform, setPreviewPlatform] = useState<string>('x');
  const [previewDraft, setPreviewDraft] = useState('');
  const [previewImgIdx, setPreviewImgIdx] = useState(0);

  // Batch upload / schedule state
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchMode, setBatchMode] = useState<'now' | 'schedule'>('schedule');
  const [batchCount, setBatchCount] = useState<number>(0);
  const [batchStart, setBatchStart] = useState<string>(() => {
    const d = new Date(Date.now() + 5 * 60 * 1000);
    d.setSeconds(0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [batchIntervalValue, setBatchIntervalValue] = useState<number>(30);
  const [batchIntervalUnit, setBatchIntervalUnit] = useState<'minutes' | 'hours'>('minutes');
  const [batchRunning, setBatchRunning] = useState(false);

  const openPreview = (bundleId: string, platform: string, text: string) => {
    setPreviewBundleId(bundleId);
    setPreviewPlatform(platform);
    setPreviewDraft(text);
    setPreviewImgIdx(0);
    setPreviewOpen(true);
  };

  const saveEditedPreview = () => {
    if (!previewBundleId) return;
    setBundles((prev) => prev.map((b) =>
      b.id === previewBundleId
        ? { ...b, texts: { ...b.texts, [previewPlatform]: previewDraft } }
        : b,
    ));
    setPreviewOpen(false);
    toast({ title: `Saved ${PLATFORM_LABELS[previewPlatform] || previewPlatform} version` });
  };

  const previewBundle = bundles.find((b) => b.id === previewBundleId) || null;
  const previewImages = previewBundle?.images || [];

  const persistFolder = (v: string) => {
    setFolderPath(v);
    try { localStorage.setItem(FOLDER_KEY, v); } catch {}
  };

  const importedKeys = useMemo(() => readImportedKeys(), [bundles.length]);

  // Build map of image filename → File (case-insensitive). Images can come
  // from the same folder picker or, in the manual fallback, a separate input.
  const buildImageMap = (files: File[]) => {
    const m = new Map<string, File>();
    for (const f of files) {
      if (SUPPORTED_IMG.test(f.name)) m.set(f.name.toLowerCase(), f);
    }
    return m;
  };

  const ingest = async (manifests: File[], images: File[]) => {
    if (!manifests.length) {
      toast({ title: 'No .txt manifests found', variant: 'destructive' });
      return;
    }
    setLoading(true);
    try {
      const imgMap = buildImageMap(images);
      const keys = readImportedKeys();
      const out: ImportedBundle[] = [];
      for (const m of manifests) out.push(await processManifest(m, imgMap, keys));
      // Newest / lowest post_index first, then by name
      out.sort((a, b) => (a.session === b.session
        ? (a.postIndex || 99) - (b.postIndex || 99)
        : a.session.localeCompare(b.session)));
      setBundles(out);
      const ok = out.filter((b) => b.errors.length === 0).length;
      toast({
        title: `Detected ${out.length} bundle${out.length === 1 ? '' : 's'}`,
        description: `${ok} ready · ${out.length - ok} with issues`,
      });
    } catch (e: any) {
      toast({ title: 'Import failed', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  // Modern Chromium API — lets the user pick a real folder by handle.
  const pickWithFsAccess = async () => {
    const anyWin = window as any;
    if (!anyWin.showDirectoryPicker) {
      toast({ title: 'Folder picker not supported', description: 'Use the folder upload button instead.' });
      return;
    }
    try {
      const dir = await anyWin.showDirectoryPicker();
      const txts: File[] = []; const imgs: File[] = [];
      // Walk one level — TechPulse drops bundles flat in the folder.
      for await (const [name, handle] of (dir as any).entries()) {
        if (handle.kind !== 'file') continue;
        const file: File = await handle.getFile();
        if (name.toLowerCase().endsWith('.txt')) txts.push(file);
        else if (SUPPORTED_IMG.test(name)) imgs.push(file);
      }
      await ingest(txts, imgs);
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast({ title: 'Folder pick failed', description: e?.message, variant: 'destructive' });
    }
  };

  const onFolderInput = async (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files);
    const txts = arr.filter((f) => f.name.toLowerCase().endsWith('.txt'));
    const imgs = arr.filter((f) => SUPPORTED_IMG.test(f.name));
    await ingest(txts, imgs);
  };

  const onTxtInput = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const txts = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.txt'));
    const existingImgs = imgInputRef.current?.files
      ? Array.from(imgInputRef.current.files).filter((f) => SUPPORTED_IMG.test(f.name))
      : [];
    if (txts.length && existingImgs.length === 0) {
      toast({
        title: 'Now select the matching images',
        description: 'Browser security blocks automatic folder reads from a single .txt — pick the 3 images next.',
      });
    }
    if (existingImgs.length) await ingest(txts, existingImgs);
  };

  const onImgInput = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const imgs = Array.from(files).filter((f) => SUPPORTED_IMG.test(f.name));
    const txts = txtInputRef.current?.files
      ? Array.from(txtInputRef.current.files).filter((f) => f.name.toLowerCase().endsWith('.txt'))
      : [];
    if (txts.length) await ingest(txts, imgs);
    else toast({ title: 'Select a .txt manifest first', variant: 'destructive' });
  };

  // Ask the local Node worker to scan the configured folder. This mirrors the
  // video uploader path: bypass browser sandboxing by going through localhost.
  const scanLocalFolder = async () => {
    if (!folderPath.trim()) {
      toast({ title: 'Set a folder path first', variant: 'destructive' });
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`${LOCAL_SERVER}/api/social-posts/scan-bundles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderPath }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Scan failed (${r.status})`);
      }
      const data = await r.json();
      const txts: File[] = [];
      const imgs: File[] = [];
      for (const b of data.bundles || []) {
        txts.push(new File([b.content], b.manifestName, { type: 'text/plain' }));
        for (const img of b.images || []) {
          if (img.dataBase64 && img.mime) imgs.push(base64ToFile(img.name, img.mime, img.dataBase64));
        }
      }
      if (!txts.length) {
        toast({ title: 'No TechPulse bundles found', description: `Folder: ${data.folderPath}`, variant: 'destructive' });
        setLoading(false);
        return;
      }
      await ingest(txts, imgs);
    } catch (e: any) {
      toast({
        title: 'Local scan failed',
        description: `${e.message}. Is the local worker running on ${LOCAL_SERVER}?`,
        variant: 'destructive',
      });
      setLoading(false);
    }
  };

  const reset = () => {
    bundles.forEach((b) => b.images.forEach((i) => URL.revokeObjectURL(i.previewUrl)));
    setBundles([]);
  };

  const handleLoad = (b: ImportedBundle) => {
    if (b.errors.length) {
      toast({ title: 'Bundle has errors', description: b.errors[0], variant: 'destructive' });
      return;
    }
    onLoad(b);
    rememberImported(b.id);
    toast({
      title: `Loaded post ${b.postIndex ?? ''}`,
      description: 'Review in Compose Post below, then click Post Now / Schedule.',
    });
  };

  const handleQuick = async (b: ImportedBundle, mode: 'now' | 'schedule' | 'draft') => {
    if (!onSendToQueue) return;
    if (b.errors.length) {
      toast({ title: 'Bundle has errors', description: b.errors[0], variant: 'destructive' });
      return;
    }
    try {
      await onSendToQueue(b, mode);
      rememberImported(b.id);
      toast({ title: mode === 'now' ? 'Sent to queue' : mode === 'schedule' ? 'Scheduled' : 'Saved as draft' });
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
    }
  };

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-secondary/40 to-transparent">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Upload className="w-4 h-4 text-primary" /> Upload Post
        </CardTitle>
        <CardDescription>
          Import already-generated TechPulse post bundles from your PC. Each bundle = 1 .txt manifest + matching images.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Local folder on this PC</Label>
          <div className="flex gap-2">
            <Input
              value={folderPath}
              onChange={(e) => persistFolder(e.target.value)}
              placeholder="D:\news posts"
              className="font-mono text-xs h-9"
            />
            <Button onClick={scanLocalFolder} disabled={loading} className="gap-2 h-9 shrink-0">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Scan folder
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Reads .txt manifests + images directly through your local worker (port 3001) — no browser file dialogs needed.
          </p>
        </div>

        <Button variant="outline" onClick={() => txtInputRef.current?.click()} className="gap-2 w-full">
          <FileText className="w-4 h-4" /> Manual fallback: pick one .txt + its images
        </Button>

        {/* Hidden file inputs covering each fallback path */}
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error non-standard but supported in Chromium/Firefox
          webkitdirectory=""
          directory=""
          multiple
          className="hidden"
          onChange={(e) => onFolderInput(e.target.files)}
        />
        <input
          ref={txtInputRef}
          type="file"
          accept=".txt"
          multiple
          className="hidden"
          onChange={(e) => { onTxtInput(e.target.files); imgInputRef.current?.click(); }}
        />
        <input
          ref={imgInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => onImgInput(e.target.files)}
        />

        {loading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" /> Parsing bundles…
          </div>
        )}

        {bundles.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">
                {bundles.length} bundle{bundles.length === 1 ? '' : 's'} detected · matched by filename + date
              </span>
              <Button size="sm" variant="ghost" onClick={reset}>Clear</Button>
            </div>
            {onSendToQueue && bundles.some((b) => b.errors.length === 0) && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={batchRunning}
                  onClick={async () => {
                    const ready = bundles.filter((b) => b.errors.length === 0);
                    if (!ready.length) return;
                    if (!confirm(`Upload all ${ready.length} ready bundle${ready.length === 1 ? '' : 's'} now?`)) return;
                    setBatchRunning(true);
                    let ok = 0; let fail = 0;
                    for (const b of ready) {
                      try { await onSendToQueue(b, 'now'); rememberImported(b.id); ok++; }
                      catch (e: any) { fail++; console.error('Batch upload failed:', e?.message); }
                    }
                    setBatchRunning(false);
                    toast({ title: `Batch upload queued`, description: `${ok} sent · ${fail} failed` });
                  }}
                >
                  <Rocket className="w-3.5 h-3.5" /> Upload all now ({bundles.filter((b) => b.errors.length === 0).length})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={batchRunning}
                  onClick={() => {
                    setBatchMode('schedule');
                    setBatchCount(bundles.filter((b) => b.errors.length === 0).length);
                    setBatchOpen(true);
                  }}
                >
                  <Calendar className="w-3.5 h-3.5" /> Schedule batch…
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3">
          {bundles.map((b) => {
            const dup = importedKeys.has(b.id);
            const ok = b.errors.length === 0;
            return (
              <Card key={b.id} className={ok ? 'border-border' : 'border-destructive/40'}>
                <CardContent className="p-3 space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    {ok
                      ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      : <AlertTriangle className="w-4 h-4 text-destructive" />}
                    <Badge variant="outline" className="capitalize">{b.session}</Badge>
                    {b.postIndex !== null && <Badge variant="secondary">#{b.postIndex}</Badge>}
                    <span className="text-[11px] text-muted-foreground ml-auto truncate max-w-[50%]" title={b.manifestName}>
                      {b.manifestName}
                    </span>
                  </div>

                  {(b.errors.length > 0 || b.warnings.length > 0 || dup) && (
                    <Alert variant={b.errors.length ? 'destructive' : 'default'} className="py-2">
                      <AlertDescription className="text-[11px] space-y-0.5">
                        {dup && <div>⚠ Already imported previously</div>}
                        {b.errors.map((e, i) => <div key={`e${i}`}>✗ {e}</div>)}
                        {b.warnings.map((w, i) => <div key={`w${i}`}>⚠ {w}</div>)}
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* Per-platform preview cards: how the post will look on each network.
                      Click any card to open the full-preview / edit dialog. */}
                  {ok && (
                    <div className="grid sm:grid-cols-3 gap-2">
                      {b.platforms.map((p) => (
                        <button
                          type="button"
                          key={p}
                          onClick={() => openPreview(b.id, p, b.texts[p] || '')}
                          className="text-left rounded border border-border bg-background/40 p-2 space-y-1.5 hover:border-primary hover:bg-background/70 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                          title={`Click to preview & edit ${PLATFORM_LABELS[p] || p} version`}
                        >
                          <div className="flex items-center gap-1.5">
                            <Badge variant="secondary" className="text-[10px]">{PLATFORM_LABELS[p] || p}</Badge>
                            <span className="text-[10px] text-muted-foreground">
                              {(b.texts[p] || '').length} chars
                            </span>
                            <Eye className="w-3 h-3 ml-auto text-muted-foreground" />
                          </div>
                          {b.images.length > 0 && (
                            <div className="flex gap-1 overflow-x-auto">
                              {b.images.map((img) => (
                                <img
                                  key={img.name}
                                  src={img.previewUrl}
                                  alt={img.name}
                                  title={img.name}
                                  className="w-12 h-12 object-cover rounded border shrink-0"
                                />
                              ))}
                            </div>
                          )}
                          <p className="text-[11px] text-muted-foreground line-clamp-6 whitespace-pre-wrap">
                            {b.texts[p] || '(no text)'}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {onSendToQueue && (
                      <Button size="sm" onClick={() => handleQuick(b, 'now')} disabled={!ok} className="gap-1.5">
                        <Send className="w-3.5 h-3.5" /> Upload now
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => handleLoad(b)} disabled={!ok} className="gap-1.5">
                      <Upload className="w-3.5 h-3.5" /> Load into Composer
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </CardContent>

      {/* Full preview + edit dialog for an individual platform's post. */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Badge variant="secondary">{PLATFORM_LABELS[previewPlatform] || previewPlatform}</Badge>
              Preview &amp; edit post
            </DialogTitle>
            <DialogDescription>
              How this will appear when posted. Edit the text and click Save — your changes apply to this platform only.
            </DialogDescription>
          </DialogHeader>

          {previewBundle && (
            <div className="space-y-4">
              {/* Faux social-card preview */}
              <div className="rounded-lg border bg-card p-3 space-y-2">
                {previewImages.length > 0 && (
                  <div className="space-y-2">
                    <div className="relative">
                      <img
                        src={previewImages[Math.min(previewImgIdx, previewImages.length - 1)].previewUrl}
                        alt={previewImages[Math.min(previewImgIdx, previewImages.length - 1)].name}
                        className="rounded w-full max-h-72 object-cover"
                      />
                      {previewImages.length > 1 && (
                        <>
                          <button
                            type="button"
                            onClick={() => setPreviewImgIdx((i) => (i - 1 + previewImages.length) % previewImages.length)}
                            className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background rounded-full w-8 h-8 flex items-center justify-center border shadow"
                            aria-label="Previous image"
                          >‹</button>
                          <button
                            type="button"
                            onClick={() => setPreviewImgIdx((i) => (i + 1) % previewImages.length)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background rounded-full w-8 h-8 flex items-center justify-center border shadow"
                            aria-label="Next image"
                          >›</button>
                          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-background/80 rounded px-2 py-0.5 text-[10px] border">
                            {Math.min(previewImgIdx, previewImages.length - 1) + 1} / {previewImages.length}
                          </div>
                        </>
                      )}
                    </div>
                    {previewImages.length > 1 && (
                      <div className="flex gap-1.5 overflow-x-auto">
                        {previewImages.map((img, idx) => (
                          <button
                            type="button"
                            key={img.name}
                            onClick={() => setPreviewImgIdx(idx)}
                            className={`shrink-0 rounded border-2 transition-colors ${
                              idx === previewImgIdx ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100'
                            }`}
                            title={img.name}
                          >
                            <img src={img.previewUrl} alt={img.name} className="w-14 h-14 object-cover rounded" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{previewDraft || '(no text)'}</p>
                <div className="text-[11px] text-muted-foreground">
                  {previewDraft.length} chars
                  {previewPlatform === 'x' && previewDraft.length > X_LIMIT && (
                    <span className="text-destructive ml-2">· over X limit ({X_LIMIT})</span>
                  )}
                </div>
              </div>

              {/* Editable text */}
              <div className="space-y-1.5">
                <Label className="text-xs">Edit {PLATFORM_LABELS[previewPlatform] || previewPlatform} text</Label>
                <Textarea
                  value={previewDraft}
                  onChange={(e) => setPreviewDraft(e.target.value)}
                  rows={10}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>Cancel</Button>
            <Button onClick={saveEditedPreview} className="gap-1.5">
              <Save className="w-4 h-4" /> Save changes
            </Button>
            {onSendToQueue && previewBundle && (
              <Button
                variant="default"
                className="gap-1.5"
                onClick={async () => {
                  // Save edits first, then send the (single-platform) bundle to queue.
                  const edited: ImportedBundle = {
                    ...previewBundle,
                    platforms: [previewPlatform],
                    texts: { ...previewBundle.texts, [previewPlatform]: previewDraft },
                  };
                  setBundles((prev) => prev.map((b) =>
                    b.id === previewBundle.id
                      ? { ...b, texts: { ...b.texts, [previewPlatform]: previewDraft } }
                      : b,
                  ));
                  setPreviewOpen(false);
                  try {
                    await onSendToQueue(edited, 'now');
                    toast({ title: `Posted ${PLATFORM_LABELS[previewPlatform] || previewPlatform} version` });
                  } catch (e: any) {
                    toast({ title: 'Failed', description: e.message, variant: 'destructive' });
                  }
                }}
              >
                <Send className="w-4 h-4" /> Save &amp; post this version
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch schedule dialog — stagger N bundles starting at a time, every X interval */}
      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Calendar className="w-4 h-4" /> Schedule batch upload</DialogTitle>
            <DialogDescription>
              Stagger the next N ready bundles at a fixed interval, just like the video folder scheduler.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">How many bundles</Label>
              <Input
                type="number"
                min={1}
                max={bundles.filter((b) => b.errors.length === 0).length}
                value={batchCount}
                onChange={(e) => setBatchCount(Math.max(1, Number(e.target.value) || 1))}
                className="h-9"
              />
              <p className="text-[11px] text-muted-foreground">
                {bundles.filter((b) => b.errors.length === 0).length} ready · earliest postIndex first
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Start at</Label>
              <Input type="datetime-local" value={batchStart} onChange={(e) => setBatchStart(e.target.value)} className="h-9" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Interval</Label>
                <Input type="number" min={1} value={batchIntervalValue} onChange={(e) => setBatchIntervalValue(Math.max(1, Number(e.target.value) || 1))} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Unit</Label>
                <select
                  value={batchIntervalUnit}
                  onChange={(e) => setBatchIntervalUnit(e.target.value as 'minutes' | 'hours')}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                </select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchOpen(false)} disabled={batchRunning}>Cancel</Button>
            <Button
              disabled={batchRunning || !onSendToQueue}
              onClick={async () => {
                if (!onSendToQueue) return;
                const ready = bundles.filter((b) => b.errors.length === 0).slice(0, Math.max(1, batchCount));
                if (!ready.length) return;
                const startMs = new Date(batchStart).getTime();
                if (!Number.isFinite(startMs)) { toast({ title: 'Pick a valid start time', variant: 'destructive' }); return; }
                const stepMs = batchIntervalValue * (batchIntervalUnit === 'hours' ? 3600_000 : 60_000);
                setBatchRunning(true);
                let ok = 0; let fail = 0;
                for (let i = 0; i < ready.length; i++) {
                  const iso = new Date(startMs + i * stepMs).toISOString();
                  try { await onSendToQueue(ready[i], 'schedule', iso); rememberImported(ready[i].id); ok++; }
                  catch (e: any) { fail++; console.error('Batch schedule failed:', e?.message); }
                }
                setBatchRunning(false);
                setBatchOpen(false);
                toast({ title: 'Batch scheduled', description: `${ok} scheduled · ${fail} failed · every ${batchIntervalValue}${batchIntervalUnit === 'hours' ? 'h' : 'm'}` });
              }}
              className="gap-1.5"
            >
              <Calendar className="w-4 h-4" /> {batchRunning ? 'Scheduling…' : 'Schedule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
