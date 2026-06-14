import { getSettings, saveSettings, type AppSettings, getPlatformAccounts, savePlatformAccount, deletePlatformAccount, setDefaultAccount, type PlatformAccount } from '@/lib/storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect } from 'react';
import { FolderOpen, Eye, EyeOff, Send, Info, Cloud, Monitor, Plus, Trash2, Star, Pencil, X, Check, Wand2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { openLocalBrowserProfileSession } from '@/lib/localBrowserProfiles';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import SocialAccountCard from '@/components/SocialAccountCard';
import ImageFallbackKeyRow from '@/components/ImageFallbackKeyRow';
import { getSocialAccounts, getAISettings, saveAISettings, listAIModels, testAIConnection, testAgentConnection, listImageModels, SOCIAL_PLATFORMS, getAgentSettings, saveAgentSettings, detectProviderFromKey, type AISettings, type AIModel, type ConnectionTestResult, type AgentSettings, type ImageModelOption, type ImageKeyEntry } from '@/lib/socialPosts';
import { Search as SearchIcon, Image as ImageIcon, Bot, Loader2, CheckCircle2, XCircle, ExternalLink } from 'lucide-react';

function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

interface AccountFormData {
  label: string;
  email: string;
  password: string;
  recoveryPhone: string;
  targetUrl: string;
}

function PlatformAccountCard({
  platform,
  accounts,
  onRefresh,
  localMode,
}: {
  platform: string;
  accounts: PlatformAccount[];
  onRefresh: () => void;
  localMode: boolean;
}) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AccountFormData>({ label: '', email: '', password: '', recoveryPhone: '', targetUrl: '' });
  const [saving, setSaving] = useState(false);
  const [preparingId, setPreparingId] = useState<string | null>(null);

  const platformAccounts = accounts.filter((a) => a.platform === platform);
  const hasAccounts = platformAccounts.length > 0;

  const descriptions: Record<string, string> = {
    youtube: 'YouTube Studio login — browser opens studio.youtube.com',
    tiktok: 'TikTok Creator login — browser opens tiktok.com/creator',
    instagram: 'Instagram login — browser opens instagram.com',
  };

  const resetForm = () => {
    setForm({ label: '', email: '', password: '', recoveryPhone: '', targetUrl: '' });
    setAdding(false);
    setEditingId(null);
  };

  const handleSave = async () => {
    if (!form.email.trim()) {
      toast({ title: 'Email is required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        platform,
        label: form.label.trim() || form.email.split('@')[0],
        email: form.email.trim(),
        password: form.password,
        target_url: form.targetUrl.trim() || null,
        enabled: true,
      };
      if (platform === 'youtube') {
        payload.recovery_phone = form.recoveryPhone.replace(/\D/g, '') || null;
      }

      if (editingId) {
        payload.id = editingId;
      } else if (!hasAccounts) {
        payload.is_default = true;
      }

      await savePlatformAccount(payload);
      toast({ title: editingId ? 'Account updated' : 'Account added' });
      resetForm();
      onRefresh();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePlatformAccount(id);
      toast({ title: 'Account removed' });
      onRefresh();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await setDefaultAccount(id, platform);
      toast({ title: 'Default account updated' });
      onRefresh();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const handleToggleEnabled = async (account: PlatformAccount) => {
    try {
      await savePlatformAccount({ id: account.id, platform, enabled: !account.enabled });
      onRefresh();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const startEdit = (account: PlatformAccount) => {
    setEditingId(account.id);
    setForm({ label: account.label, email: account.email, password: account.password, recoveryPhone: (account as any).recovery_phone || '', targetUrl: (account as any).target_url || '' });
    setAdding(true);
  };

  const handlePrepareProfile = async (account: PlatformAccount) => {
    setPreparingId(account.id);
    try {
      const result = await openLocalBrowserProfileSession({
        platform,
        accountId: account.id,
        label: account.label || account.email,
      });
      const linkedCount = result.linkedAccountIds.length;
      toast({
        title: 'Browser profile opened',
        description: linkedCount > 1
          ? `Log in once in the opened browser. This profile is now shared with ${linkedCount} matching accounts.`
          : 'Log in once in the opened browser. This profile will now be reused for future uploads.',
      });
    } catch (err: any) {
      toast({
        title: 'Could not open local browser profile',
        description: err.message || 'Make sure your local server is running on port 3001.',
        variant: 'destructive',
      });
    } finally {
      setPreparingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base capitalize">{platform}</CardTitle>
            <CardDescription>{descriptions[platform]}</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={() => {
              resetForm();
              setAdding(true);
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasAccounts && !adding && (
          <p className="text-sm text-muted-foreground text-center py-3">
            No accounts configured. Add one to enable {platform} uploads.
          </p>
        )}

        {/* Account list */}
        {platformAccounts.map((account) => (
          <div
            key={account.id}
            className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
              account.enabled ? 'border-border' : 'border-border/50 opacity-60'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{account.label || account.email}</span>
                {account.is_default && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 shrink-0">
                    <Star className="w-2.5 h-2.5 fill-current" />
                    Default
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">{account.email}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Switch
                checked={account.enabled}
                onCheckedChange={() => handleToggleEnabled(account)}
                className="scale-75"
              />
              {localMode && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => handlePrepareProfile(account)}
                  disabled={preparingId === account.id}
                >
                  <Monitor className="w-3.5 h-3.5 mr-1" />
                  {preparingId === account.id ? 'Opening…' : 'Prepare'}
                </Button>
              )}
              {!account.is_default && platformAccounts.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-muted-foreground hover:text-amber-600"
                  title="Set as default"
                  onClick={() => handleSetDefault(account.id)}
                >
                  <Star className="w-3.5 h-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => startEdit(account)}
              >
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove account?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove the {platform} account "{account.label || account.email}".
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => handleDelete(account.id)}
                      className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                    >
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ))}

        {/* Add/Edit form */}
        {adding && (
          <div className="rounded-lg border-2 border-dashed border-primary/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{editingId ? 'Edit Account' : 'New Account'}</p>
              <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={resetForm}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Label (optional)</Label>
              <Input
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Main Channel, Gaming, Personal"
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Email / Username</Label>
              <Input
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder={`${platform}@example.com`}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Password</Label>
              <PasswordInput
                value={form.password}
                onChange={(v) => setForm((f) => ({ ...f, password: v }))}
                placeholder="••••••••"
              />
            </div>
            {platform === 'youtube' && (
              <div className="space-y-2">
                <Label className="text-xs">Recovery phone (digits only)</Label>
                <Input
                  value={form.recoveryPhone}
                  onChange={(e) => setForm((f) => ({ ...f, recoveryPhone: e.target.value }))}
                  placeholder="e.g. 598574742"
                  className="h-9"
                />
                <p className="text-[11px] text-muted-foreground">
                  Used when Google asks to confirm the phone ending in the last 2 digits of this number.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label className="text-xs">Post to URL (optional)</Label>
              <Input
                value={form.targetUrl}
                onChange={(e) => setForm((f) => ({ ...f, targetUrl: e.target.value }))}
                placeholder={
                  platform === 'youtube' ? 'https://studio.youtube.com/channel/UCxxxx'
                  : platform === 'tiktok' ? 'https://www.tiktok.com/@yourhandle'
                  : platform === 'instagram' ? 'https://www.instagram.com/yourhandle'
                  : 'https://...'
                }
                className="h-9 font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Optional. Leave empty to upload on the account's default profile/channel. Set this if you need to upload to a specific channel/page under this account.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
                <Check className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : editingId ? 'Update' : 'Add Account'}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground bg-secondary p-2.5 rounded-lg">
              💡 Use Prepare once per account to open its Chrome profile and save the login. Future uploads will reuse that same saved profile.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const defaultSettings: AppSettings = {
  folderPath: '',
  uploadMode: 'local',
  deleteAfterUpload: true,
  youtube: { email: '', password: '', enabled: false },
  tiktok: { email: '', password: '', enabled: false },
  instagram: { email: '', password: '', enabled: false },
  telegram: { botToken: '', chatId: '', enabled: false },
};

export default function SettingsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: savedSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ['platform_accounts'],
    queryFn: getPlatformAccounts,
  });

  const { data: socialAccounts = [] } = useQuery({
    queryKey: ['social_accounts'],
    queryFn: getSocialAccounts,
  });

  const { data: savedAi } = useQuery({
    queryKey: ['ai_settings'],
    queryFn: getAISettings,
  });

  const { data: savedAgent } = useQuery({
    queryKey: ['agent_settings'],
    queryFn: getAgentSettings,
  });

  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);
  const [aiSettings, setAiSettings] = useState<AISettings>({ provider: 'lovable', apiKey: '', model: 'google/gemini-3-flash-preview' });
  const [savingAI, setSavingAI] = useState(false);
  const [aiModels, setAiModels] = useState<AIModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>({
    researchProvider: 'auto', researchApiKey: '', imageProvider: 'auto', imageApiKey: '', imageModel: '',
    imageKeys: [],
    researchDepth: 'standard', localAgentUrl: 'http://localhost:3001',
    taskMode: 'standard', automationMode: 'safe', memoryEnabled: true, memoryMaxItems: 8,
    shellEnabled: false, workspacePath: '',
  });
  const [savingAgent, setSavingAgent] = useState(false);
  const [testingResearch, setTestingResearch] = useState(false);
  const [researchTest, setResearchTest] = useState<ConnectionTestResult | null>(null);
  const [testingImage, setTestingImage] = useState(false);
  const [imageTest, setImageTest] = useState<ConnectionTestResult | null>(null);
  const [imageModels, setImageModels] = useState<ImageModelOption[]>([]);
  const [loadingImageModels, setLoadingImageModels] = useState(false);
  const [autoDetectedHint, setAutoDetectedHint] = useState<string>('');

  const handleTestResearch = async () => {
    setTestingResearch(true); setResearchTest(null);
    try {
      // For 'auto', if a key is set assume Brave (best free tier); else local
      const provider = agentSettings.researchProvider === 'auto'
        ? (agentSettings.researchApiKey ? 'brave' : 'local')
        : agentSettings.researchProvider;
      const r = await testAgentConnection('research', provider, agentSettings.researchApiKey, agentSettings.localAgentUrl);
      setResearchTest(r);
      if (r.ok) toast({ title: '✅ Research provider connected', description: `${provider} · ${r.latency}ms${r.sample ? ` · ${r.sample.slice(0, 60)}` : ''}` });
      else toast({ title: 'Research test failed', description: r.error, variant: 'destructive' });
    } catch (e: any) {
      setResearchTest({ ok: false, error: e.message });
      toast({ title: 'Test failed', description: e.message, variant: 'destructive' });
    } finally { setTestingResearch(false); }
  };

  const handleTestImage = async () => {
    setTestingImage(true); setImageTest(null);
    try {
      const provider = agentSettings.imageProvider === 'auto'
        ? (agentSettings.imageApiKey ? 'unsplash' : 'lovable')
        : agentSettings.imageProvider;
      // Pass the chosen image model so the backend really invokes it (not a generic probe).
      const r = await testAgentConnection('image', provider, agentSettings.imageApiKey, undefined, agentSettings.imageModel);
      setImageTest(r);
      if (r.ok) toast({ title: '✅ Image provider connected', description: `${provider}${r.model ? ` · ${r.model.split('/').pop()}` : ''} · ${r.latency}ms${r.sample ? ` · ${r.sample.slice(0, 80)}` : ''}` });
      else toast({ title: 'Image test failed', description: r.error, variant: 'destructive' });
    } catch (e: any) {
      setImageTest({ ok: false, error: e.message });
      toast({ title: 'Test failed', description: e.message, variant: 'destructive' });
    } finally { setTestingImage(false); }
  };

  const handleLoadImageModels = async () => {
    setLoadingImageModels(true);
    try {
      const provider = agentSettings.imageProvider === 'auto' ? 'lovable' : agentSettings.imageProvider;
      const { models, error } = await listImageModels(provider, agentSettings.imageApiKey);
      if (error) {
        toast({ title: 'Could not list models', description: error, variant: 'destructive' });
        setImageModels([]);
      } else {
        setImageModels(models);
        const recommended = models.find((m) => m.recommended) || models[0];
        if (recommended && !agentSettings.imageModel) {
          setAgentSettings((s) => ({ ...s, imageModel: recommended.id }));
        }
        toast({ title: '✅ Models loaded', description: `${models.length} image model${models.length === 1 ? '' : 's'} available` });
      }
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
    } finally { setLoadingImageModels(false); }
  };

  const loadModels = async (provider: string, apiKey: string, baseUrl?: string) => {
    setLoadingModels(true);
    setModelsError(null);
    try {
      const models = await listAIModels(provider, apiKey, baseUrl);
      setAiModels(models);
      if (provider === 'lmstudio' && models.length > 0) {
        setAiSettings((s) => models.some((m) => m.id === s.model) ? s : { ...s, model: models[0].id });
      }
    } catch (e: any) {
      setModelsError(e.message || 'Failed to load models');
      setAiModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testAIConnection(aiSettings.provider, aiSettings.apiKey, aiSettings.model, aiSettings.baseUrl);
      setTestResult(r);
      if (r.ok) toast({ title: '✅ Connected', description: `${r.model} responded in ${r.latency}ms` });
      else toast({ title: 'Connection failed', description: r.error, variant: 'destructive' });
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message });
      toast({ title: 'Test failed', description: e.message, variant: 'destructive' });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (savedSettings) setSettings(savedSettings);
  }, [savedSettings]);

  useEffect(() => {
    if (savedAi) setAiSettings(savedAi);
  }, [savedAi]);

  useEffect(() => {
    if (savedAgent) setAgentSettings(savedAgent);
  }, [savedAgent]);

  const handleSaveAgent = async () => {
    setSavingAgent(true);
    try {
      await saveAgentSettings(agentSettings);
      queryClient.invalidateQueries({ queryKey: ['agent_settings'] });
      toast({ title: 'Agent settings saved' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSavingAgent(false);
    }
  };

  // Auto-load models when provider changes (or when LM Studio baseUrl/key updates)
  useEffect(() => {
    if (aiSettings.provider === 'lovable') {
      loadModels('lovable', '');
    } else if (aiSettings.provider === 'lmstudio') {
      // LM Studio: try with baseUrl + (any) key — backend returns hint list if unreachable
      loadModels('lmstudio', aiSettings.apiKey || 'lm-studio', aiSettings.baseUrl);
    } else if (aiSettings.apiKey) {
      loadModels(aiSettings.provider, aiSettings.apiKey);
    } else {
      setAiModels([]);
      setModelsError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSettings.provider, aiSettings.baseUrl]);

  const refreshAccounts = () => {
    queryClient.invalidateQueries({ queryKey: ['platform_accounts'] });
  };

  const refreshSocialAccounts = () => {
    queryClient.invalidateQueries({ queryKey: ['social_accounts'] });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveSettings(settings);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast({ title: 'Settings saved' });
    } catch (err: any) {
      toast({ title: 'Error saving', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAI = async () => {
    setSavingAI(true);
    try {
      await saveAISettings(aiSettings);
      queryClient.invalidateQueries({ queryKey: ['ai_settings'] });
      toast({ title: 'AI settings saved' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSavingAI(false);
    }
  };

  const isCloud = settings.uploadMode === 'cloud';

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure platform accounts, upload mode, and notifications
        </p>
      </div>

      {/* Upload Mode Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload Mode</CardTitle>
          <CardDescription>
            Choose how videos are uploaded to platforms
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setSettings((p) => ({ ...p, uploadMode: 'local' }))}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-all ${
                !isCloud
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/40'
              }`}
            >
              <Monitor className={`w-6 h-6 ${!isCloud ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className={`font-medium text-sm ${!isCloud ? 'text-primary' : 'text-muted-foreground'}`}>Local Mode</span>
              <span className="text-xs text-muted-foreground text-center">
                Uses Playwright on your PC. Requires local server running.
              </span>
            </button>
            <button
              type="button"
              onClick={() => setSettings((p) => ({ ...p, uploadMode: 'cloud' }))}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-all ${
                isCloud
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/40'
              }`}
            >
              <Cloud className={`w-6 h-6 ${isCloud ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className={`font-medium text-sm ${isCloud ? 'text-primary' : 'text-muted-foreground'}`}>Cloud Mode</span>
              <span className="text-xs text-muted-foreground text-center">
                Uses Browserbase remote browser. No local server needed.
              </span>
            </button>
          </div>
          {isCloud && (
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
              <Cloud className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
              <div className="text-green-800">
                <p className="font-medium">Cloud mode active</p>
                <p className="text-green-700 mt-0.5">
                  Browserbase credentials are configured. Uploads will run in a remote browser — no local server needed.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* How it works */}
      <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm">
        <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
        <div className="text-blue-800">
          <p className="font-medium">How uploads work</p>
          <p className="text-blue-700 mt-0.5">
            {isCloud
              ? 'Cloud mode uses a remote Browserbase browser to log into each platform and upload videos automatically. Sessions persist so you only log in once.'
              : 'Your local server uses Playwright to open a real browser, log into each platform with your credentials below, and upload videos automatically. You only need to log in manually the first time — sessions are saved.'}
          </p>
        </div>
      </div>

      {/* Folder Path — local mode only */}
      {!isCloud && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FolderOpen className="w-4 h-4" />
              Video Watch Folder
            </CardTitle>
            <CardDescription>
              Drop .mp4 + .txt pairs here — the local server picks them up automatically
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              value={settings.folderPath}
              onChange={(e) => setSettings((p) => ({ ...p, folderPath: e.target.value }))}
              placeholder="C:\Users\You\Videos\uploads"
              className="font-mono"
            />
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-secondary/40 p-3">
              <div className="space-y-0.5">
                <Label htmlFor="delete-after-upload" className="text-sm font-medium">
                  Delete source files after successful upload
                </Label>
                <p className="text-xs text-muted-foreground">
                  When every selected platform succeeds, the video and its matching .txt are removed from the folder. Failed or partial uploads are kept for retry.
                </p>
              </div>
              <Switch
                id="delete-after-upload"
                checked={settings.deleteAfterUpload}
                onCheckedChange={(v) => setSettings((p) => ({ ...p, deleteAfterUpload: v }))}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Platform Accounts */}
      {(['youtube', 'tiktok', 'instagram'] as const).map((platform) => (
        <PlatformAccountCard
          key={platform}
          platform={platform}
          accounts={accounts}
          onRefresh={refreshAccounts}
          localMode={!isCloud}
        />
      ))}

      {/* Social Post Accounts */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 pt-2">
          <Wand2 className="w-4 h-4 text-primary" />
          <h2 className="text-lg font-semibold">Social Post Accounts</h2>
          <Badge variant="secondary" className="text-[10px]">For text/image posts</Badge>
        </div>
        <p className="text-sm text-muted-foreground -mt-2">
          Configure X, LinkedIn, and Facebook accounts for the AI-powered post manager. Each account uses its own saved Chrome profile.
        </p>
        {SOCIAL_PLATFORMS.map((p) => (
          <SocialAccountCard
            key={p}
            platform={p}
            accounts={socialAccounts}
            onRefresh={refreshSocialAccounts}
            localMode={!isCloud}
          />
        ))}
      </div>

      {/* AI Provider */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-primary" />
            LLM Provider
          </CardTitle>
          <CardDescription>
            Single LLM used for AI Post Generator, AI Chat, and agentic flows. Point at <span className="font-mono">LM Studio</span> running on your PC to use your real locally loaded models.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-xs">Provider</Label>
              <Select value={aiSettings.provider} onValueChange={(v) => setAiSettings((s) => ({ ...s, provider: v, model: '' }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lovable">Lovable AI (default)</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="google">Google (Gemini)</SelectItem>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                  <SelectItem value="xai">xAI (Grok)</SelectItem>
                  <SelectItem value="nvidia">NVIDIA</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                  <SelectItem value="lmstudio">LM Studio (local PC)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs flex items-center justify-between">
                <span>Model</span>
                {(aiSettings.provider === 'lmstudio' || (aiSettings.provider !== 'lovable' && aiSettings.apiKey)) && (
                  <button
                    type="button"
                    onClick={() => loadModels(aiSettings.provider, aiSettings.apiKey || 'lm-studio', aiSettings.baseUrl)}
                    className="text-[10px] text-primary hover:underline"
                    disabled={loadingModels}
                  >
                    {loadingModels ? 'Loading…' : 'Refresh models'}
                  </button>
                )}
              </Label>
              {aiModels.length > 0 ? (
                <Select value={aiSettings.model} onValueChange={(v) => setAiSettings((s) => ({ ...s, model: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select a model" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {aiModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.label || m.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={aiSettings.model}
                  onChange={(e) => setAiSettings((s) => ({ ...s, model: e.target.value }))}
                  placeholder={aiSettings.provider === 'lovable' ? 'google/gemini-3-flash-preview' : aiSettings.provider === 'lmstudio' ? 'e.g. google/gemma-3-27b' : 'Enter API key to load models'}
                  disabled={loadingModels}
                />
              )}
              {modelsError && (
                <p className="text-[11px] text-destructive">{modelsError}</p>
              )}
            </div>
          </div>

          {aiSettings.provider === 'lmstudio' && (
            <div className="space-y-2">
              <Label className="text-xs">LM Studio Base URL</Label>
              <Input
                value={aiSettings.baseUrl || ''}
                onChange={(e) => setAiSettings((s) => ({ ...s, baseUrl: e.target.value }))}
                placeholder="http://192.168.50.33:1234"
              />
              <p className="text-[11px] text-muted-foreground">
                URL of LM Studio's OpenAI-compatible server (don't include <span className="font-mono">/v1</span>). Models are loaded through your local worker, so this must match the server shown in LM Studio.
              </p>
            </div>
          )}

          {aiSettings.provider !== 'lovable' && (
            <div className="space-y-2">
              <Label className="text-xs">{aiSettings.provider === 'lmstudio' ? 'API Key (optional — any value)' : 'API Key'}</Label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <PasswordInput
                    value={aiSettings.apiKey}
                    onChange={(v) => setAiSettings((s) => ({ ...s, apiKey: v }))}
                    placeholder={
                      aiSettings.provider === 'google' ? 'AIza...' :
                      aiSettings.provider === 'nvidia' ? 'nvapi-...' :
                      aiSettings.provider === 'anthropic' ? 'sk-ant-...' :
                      aiSettings.provider === 'xai' ? 'xai-...' :
                      aiSettings.provider === 'lmstudio' ? 'lm-studio' :
                      'sk-...'
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => loadModels(aiSettings.provider, aiSettings.apiKey || 'lm-studio', aiSettings.baseUrl)}
                  disabled={(aiSettings.provider !== 'lmstudio' && !aiSettings.apiKey) || loadingModels}
                >
                  {loadingModels ? 'Checking…' : 'Load models'}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {aiSettings.provider === 'google' && 'Get a key at aistudio.google.com/app/apikey'}
                {aiSettings.provider === 'nvidia' && 'Get a key at build.nvidia.com (API Catalog)'}
                {aiSettings.provider === 'openai' && 'Get a key at platform.openai.com/api-keys'}
                {aiSettings.provider === 'anthropic' && 'Get a key at console.anthropic.com'}
                {aiSettings.provider === 'openrouter' && 'Get a key at openrouter.ai/keys'}
                {aiSettings.provider === 'xai' && 'Get a key at console.x.ai (xAI/Grok API)'}
                {aiSettings.provider === 'lmstudio' && 'LM Studio doesn\'t require auth — leave blank or use any placeholder.'}
              </p>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" onClick={handleSaveAI} disabled={savingAI} className="gap-1.5">
              <Check className="w-3.5 h-3.5" />
              {savingAI ? 'Saving…' : 'Save AI Settings'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !aiSettings.model || (aiSettings.provider !== 'lovable' && aiSettings.provider !== 'lmstudio' && !aiSettings.apiKey)}
              className="gap-1.5"
            >
              {testing ? '⏳ Testing…' : '🔌 Test connection'}
            </Button>
            {testResult && (
              testResult.ok ? (
                <Badge className="gap-1 bg-emerald-500/15 text-emerald-700 border-emerald-500/30 hover:bg-emerald-500/15">
                  ✅ Connected · {testResult.latency}ms
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">❌ {testResult.error?.slice(0, 60)}</Badge>
              )
            )}
          </div>
          <div className="text-xs text-muted-foreground border-t pt-3 mt-1">
            <span className="font-medium">Active LLM (used everywhere):</span>{' '}
            <span className="font-mono text-foreground">{savedAi?.provider || 'lovable'} · {savedAi?.model || 'default'}</span>
          </div>
        </CardContent>
      </Card>

      {/* Agent (Research + Image) Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            Research & Image Agent
          </CardTitle>
          <CardDescription>
            Powers the deep research loop. With API keys the agent uses fast hosted providers; without keys it falls back to your local browser (DuckDuckGo → Google) for scraping.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Research provider */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <SearchIcon className="w-3.5 h-3.5" /> Research provider
              </Label>
              {researchTest && (
                researchTest.ok
                  ? <Badge className="gap-1 bg-emerald-500/15 text-emerald-700 border-emerald-500/30 hover:bg-emerald-500/15">
                      <CheckCircle2 className="w-3 h-3" /> Connected · {researchTest.latency}ms
                    </Badge>
                  : <Badge variant="destructive" className="gap-1"><XCircle className="w-3 h-3" /> {researchTest.error?.slice(0, 50)}</Badge>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select value={agentSettings.researchProvider} onValueChange={(v) => { setAgentSettings((s) => ({ ...s, researchProvider: v })); setResearchTest(null); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">⚡ Auto — key if set, else local browser</SelectItem>
                  <SelectItem value="brave">🦁 Brave Search API (2k free / month)</SelectItem>
                  <SelectItem value="tavily">🌊 Tavily — best for AI agents (1k free)</SelectItem>
                  <SelectItem value="serper">🔍 Serper (Google, 2.5k free)</SelectItem>
                  <SelectItem value="firecrawl">🔥 Firecrawl Search</SelectItem>
                  <SelectItem value="local">💻 Local browser only (DuckDuckGo + Google)</SelectItem>
                </SelectContent>
              </Select>
              {agentSettings.researchProvider !== 'local' && (
                <PasswordInput
                  value={agentSettings.researchApiKey}
                  onChange={(v) => {
                    setAgentSettings((s) => {
                      const next = { ...s, researchApiKey: v };
                      // Auto-detect provider from key prefix when on Auto.
                      if (s.researchProvider === 'auto' && v) {
                        const det = detectProviderFromKey(v);
                        if (det.research) {
                          next.researchProvider = det.research;
                          setAutoDetectedHint(`Auto-detected research provider: ${det.research}`);
                          setTimeout(() => setAutoDetectedHint(''), 4000);
                        }
                      }
                      return next;
                    });
                    setResearchTest(null);
                  }}
                  placeholder={
                    agentSettings.researchProvider === 'auto' ? 'Paste any key — provider auto-detected' :
                    agentSettings.researchProvider === 'brave' ? 'BSA...' :
                    agentSettings.researchProvider === 'tavily' ? 'tvly-...' :
                    agentSettings.researchProvider === 'serper' ? 'serper key (64 hex chars)' :
                    'fc-...'
                  }
                />
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                type="button" size="sm" variant="outline"
                onClick={handleTestResearch}
                disabled={testingResearch || (agentSettings.researchProvider !== 'local' && agentSettings.researchProvider !== 'auto' && !agentSettings.researchApiKey)}
                className="gap-1.5 h-8"
              >
                {testingResearch ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '🔌'} Test connection
              </Button>
              {researchTest?.ok && researchTest.sample && (
                <span className="text-[11px] text-muted-foreground italic truncate max-w-[280px]">
                  → "{researchTest.sample}"
                </span>
              )}
              {agentSettings.researchProvider !== 'local' && agentSettings.researchProvider !== 'auto' && (
                <a href={
                  agentSettings.researchProvider === 'brave' ? 'https://api.search.brave.com/app/keys' :
                  agentSettings.researchProvider === 'tavily' ? 'https://app.tavily.com/' :
                  agentSettings.researchProvider === 'serper' ? 'https://serper.dev/' :
                  'https://www.firecrawl.dev/app/api-keys'
                } target="_blank" rel="noreferrer" className="text-[11px] text-primary hover:underline inline-flex items-center gap-1 ml-auto">
                  Get key <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {agentSettings.researchProvider === 'brave' && 'Brave Search API — fast, privacy-focused, generous free tier.'}
              {agentSettings.researchProvider === 'tavily' && 'Tavily is purpose-built for AI agents — returns clean, ranked results.'}
              {agentSettings.researchProvider === 'serper' && 'Serper returns real Google results, including news + images.'}
              {agentSettings.researchProvider === 'firecrawl' && 'Firecrawl combines search + scrape in one call.'}
              {agentSettings.researchProvider === 'local' && 'Uses your local Playwright browser to scrape DuckDuckGo (Google fallback). Requires the local server running.'}
              {agentSettings.researchProvider === 'auto' && 'Smart default — uses your search API key if provided, otherwise falls back to the local browser.'}
            </p>
          </div>

          {/* Image provider */}
          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5" /> Image provider
              </Label>
              {imageTest && (
                imageTest.ok
                  ? <Badge className="gap-1 bg-emerald-500/15 text-emerald-700 border-emerald-500/30 hover:bg-emerald-500/15">
                      <CheckCircle2 className="w-3 h-3" /> Connected · {imageTest.latency}ms
                    </Badge>
                  : <Badge variant="destructive" className="gap-1"><XCircle className="w-3 h-3" /> {imageTest.error?.slice(0, 50)}</Badge>
              )}
              {autoDetectedHint && (
                <Badge variant="secondary" className="text-[10px]">{autoDetectedHint}</Badge>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select value={agentSettings.imageProvider} onValueChange={(v) => { setAgentSettings((s) => ({ ...s, imageProvider: v, imageModel: '' })); setImageTest(null); setImageModels([]); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">⚡ Auto — agent picks photo vs generated</SelectItem>
                  <SelectItem value="unsplash">📷 Unsplash (real photos, free)</SelectItem>
                  <SelectItem value="pexels">🎞️ Pexels (real photos, free)</SelectItem>
                  <SelectItem value="google">🍌 Google Gemini (Nano Banana)</SelectItem>
                  <SelectItem value="openai">🎨 OpenAI DALL-E / gpt-image</SelectItem>
                  <SelectItem value="nvidia">🟢 NVIDIA NIM (FLUX, SDXL, SD3)</SelectItem>
                  <SelectItem value="xai">⚡ xAI Grok (Grok 2 Image)</SelectItem>
                  <SelectItem value="lovable">✨ Lovable AI (Nano Banana, included)</SelectItem>
                </SelectContent>
              </Select>
              {agentSettings.imageProvider !== 'lovable' && (
                <PasswordInput
                  value={agentSettings.imageApiKey}
                  onChange={(v) => {
                    setAgentSettings((s) => {
                      const next = { ...s, imageApiKey: v, imageModel: '' };
                      // Auto-detect image provider from key prefix when on Auto.
                      if (s.imageProvider === 'auto' && v) {
                        const det = detectProviderFromKey(v);
                        if (det.image) {
                          next.imageProvider = det.image;
                          setAutoDetectedHint(`Auto-detected image provider: ${det.image}`);
                          setTimeout(() => setAutoDetectedHint(''), 4000);
                        }
                      }
                      return next;
                    });
                    setImageTest(null);
                    setImageModels([]);
                  }}
                  placeholder={
                    agentSettings.imageProvider === 'auto' ? 'Optional: paste any key — provider auto-detected' :
                    agentSettings.imageProvider === 'unsplash' ? 'Unsplash Access Key' :
                    agentSettings.imageProvider === 'pexels' ? 'Pexels API Key' :
                    agentSettings.imageProvider === 'google' ? 'Google AI Studio API key (AIza…)' :
                    agentSettings.imageProvider === 'nvidia' ? 'NVIDIA API key (nvapi-…)' :
                    agentSettings.imageProvider === 'xai' ? 'xAI API key (xai-…)' :
                    'sk-...'
                  }
                />
              )}
            </div>

            {/* Image model selector — appears after "Show models" succeeds */}
            {imageModels.length > 0 && ['google', 'openai', 'lovable', 'nvidia', 'xai'].includes(agentSettings.imageProvider) && (
              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5" /> Image model
                </Label>
                <Select value={agentSettings.imageModel} onValueChange={(v) => { setAgentSettings((s) => ({ ...s, imageModel: v })); setImageTest(null); }}>
                  <SelectTrigger><SelectValue placeholder="Pick a model" /></SelectTrigger>
                  <SelectContent>
                    {imageModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.recommended ? '⭐ ' : ''}{m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <Button
                type="button" size="sm" variant="outline"
                onClick={handleTestImage}
                disabled={testingImage || (agentSettings.imageProvider !== 'lovable' && agentSettings.imageProvider !== 'auto' && !agentSettings.imageApiKey)}
                className="gap-1.5 h-8"
              >
                {testingImage ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '🔌'} Test connection
              </Button>
              <Button
                type="button" size="sm" variant="outline"
                onClick={handleLoadImageModels}
                disabled={loadingImageModels || (agentSettings.imageProvider !== 'lovable' && !agentSettings.imageApiKey)}
                className="gap-1.5 h-8"
              >
                {loadingImageModels ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
                Show models
              </Button>
              {imageTest?.ok && imageTest.sample && (
                <span className="text-[11px] text-muted-foreground italic truncate max-w-[280px]">
                  → {imageTest.sample}
                </span>
              )}
              {agentSettings.imageProvider !== 'lovable' && agentSettings.imageProvider !== 'auto' && (
                <a href={
                  agentSettings.imageProvider === 'unsplash' ? 'https://unsplash.com/oauth/applications' :
                  agentSettings.imageProvider === 'pexels' ? 'https://www.pexels.com/api/' :
                  agentSettings.imageProvider === 'google' ? 'https://aistudio.google.com/app/apikey' :
                  agentSettings.imageProvider === 'nvidia' ? 'https://build.nvidia.com/explore/discover' :
                  agentSettings.imageProvider === 'xai' ? 'https://console.x.ai/' :
                  'https://platform.openai.com/api-keys'
                } target="_blank" rel="noreferrer" className="text-[11px] text-primary hover:underline inline-flex items-center gap-1 ml-auto">
                  Get key <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              In Auto mode the agent picks real photos for news/events and generated images for abstract/conceptual prompts. Use <strong>Google</strong>, <strong>NVIDIA</strong>, or <strong>xAI</strong> with your key, or <strong>Lovable AI</strong> for built-in Nano Banana (no key required).
            </p>
          </div>

          {/* Multi-key fallback chain editor */}
          <div className="space-y-2 border-t pt-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5" /> Image generation fallback chain
              </Label>
              <Badge variant="secondary" className="text-[10px]">{agentSettings.imageKeys.length}/10 keys</Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Add up to 10 image-gen API keys (any mix of providers/models). When the agent generates an image, it tries them <strong>in order</strong> — if one is rate-limited or out of quota, it automatically falls back to the next. Lovable AI is always tried last as a safety net.
            </p>
            <div className="space-y-2">
              {agentSettings.imageKeys.map((k, idx) => (
                <ImageFallbackKeyRow
                  key={k.id}
                  index={idx}
                  entry={k}
                  onChange={(next) => setAgentSettings((s) => ({
                    ...s,
                    imageKeys: s.imageKeys.map((x, i) => i === idx ? next : x),
                  }))}
                  onRemove={() => setAgentSettings((s) => ({
                    ...s,
                    imageKeys: s.imageKeys.filter((_, i) => i !== idx),
                  }))}
                />
              ))}
              {agentSettings.imageKeys.length < 10 && (
                <Button
                  type="button" variant="outline" size="sm" className="w-full gap-1.5"
                  onClick={() => setAgentSettings((s) => ({
                    ...s,
                    imageKeys: [...s.imageKeys, {
                      id: crypto.randomUUID(),
                      provider: 'lovable',
                      apiKey: '',
                      model: '',
                      label: '',
                      enabled: true,
                    }],
                  }))}
                >
                  <Plus className="w-3.5 h-3.5" /> Add fallback key ({agentSettings.imageKeys.length}/10)
                </Button>
              )}
            </div>
          </div>

          {/* Depth + local URL */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t pt-4">
            <div className="space-y-2">
              <Label className="text-xs">Research depth</Label>
              <Select value={agentSettings.researchDepth} onValueChange={(v) => setAgentSettings((s) => ({ ...s, researchDepth: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light — 1 search, fast</SelectItem>
                  <SelectItem value="standard">Standard — 2-3 searches</SelectItem>
                  <SelectItem value="deep">Deep — plan → search → re-plan → search</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Local agent URL</Label>
              <Input
                value={agentSettings.localAgentUrl}
                onChange={(e) => setAgentSettings((s) => ({ ...s, localAgentUrl: e.target.value }))}
                placeholder="http://localhost:3001"
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t pt-4">
            <div className="space-y-2">
              <Label className="text-xs">Task orchestration mode</Label>
              <Select value={agentSettings.taskMode} onValueChange={(v) => setAgentSettings((s) => ({ ...s, taskMode: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard — single-agent loop</SelectItem>
                  <SelectItem value="multi-agent">Multi-agent — planner → executor → reviewer</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Multi-agent mode adds a reviewer pass after execution steps so the app can refine plans and improve saved skills more consistently.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Automation mode</Label>
              <Select value={agentSettings.automationMode} onValueChange={(v) => setAgentSettings((s) => ({ ...s, automationMode: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="safe">Safe — read-only research and website parsing</SelectItem>
                  <SelectItem value="extended">Extended — broader local automation</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Safe mode is best for scraping, parsing, analysis, and drafting. It blocks risky browser actions like trading, purchases, or account-changing flows.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t pt-4">
            <div className="space-y-2">
              <Label className="text-xs">Persistent agent memory</Label>
              <div className="rounded-lg border p-3 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Allow reusable memory across tasks</p>
                    <p className="text-[11px] text-muted-foreground">
                      Lets the agent remember durable facts, successful workflows, and recurring context like Hermes/OpenClaw-style memory.
                    </p>
                  </div>
                  <Switch
                    checked={agentSettings.memoryEnabled}
                    onCheckedChange={(v) => setAgentSettings((s) => ({ ...s, memoryEnabled: v }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-[11px] text-muted-foreground">Memories injected per run</Label>
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={agentSettings.memoryMaxItems}
                    onChange={(e) => setAgentSettings((s) => ({ ...s, memoryMaxItems: Math.min(Math.max(Number(e.target.value) || 1, 1), 20) }))}
                    className="w-28 h-8 text-xs"
                    disabled={!agentSettings.memoryEnabled}
                  />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Skill chaining behavior</Label>
              <div className="rounded-lg border p-3 space-y-2">
                <p className="text-sm font-medium">Use saved skills as subtask building blocks</p>
                <p className="text-[11px] text-muted-foreground">
                  In multi-agent mode the planner can pull in saved skills during a task, reuse them as subtasks, and write back improvements after successful runs.
                </p>
                <Badge variant="outline" className="text-[10px]">Requires enabled saved skills</Badge>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t pt-4">
            <div className="space-y-2">
              <Label className="text-xs">Agent workspace root (optional)</Label>
              <Input
                value={agentSettings.workspacePath}
                onChange={(e) => setAgentSettings((s) => ({ ...s, workspacePath: e.target.value }))}
                placeholder="C:\\Users\\You\\agent-workspace"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Leave blank to use the app&apos;s default local workspace folder. Set this to keep Claude-Code-style agent projects in a dedicated folder on your local computer.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Local shell access</Label>
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Allow agent to run local build/dev commands</p>
                    <p className="text-[11px] text-muted-foreground">
                      Needed for npm install, previews, local code generation, and other Claude Code style workflows on your PC.
                    </p>
                  </div>
                  <Switch
                    checked={agentSettings.shellEnabled}
                    onCheckedChange={(v) => setAgentSettings((s) => ({ ...s, shellEnabled: v }))}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Allowlisted commands only: npm, npx, node, python/python3/py, pip/pip3, git, ls/dir, echo, cat/type.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap pt-1">
            <Button size="sm" onClick={handleSaveAgent} disabled={savingAgent} className="gap-1.5">
              <Check className="w-3.5 h-3.5" />
              {savingAgent ? 'Saving…' : 'Save Agent Settings'}
            </Button>
            <Badge variant="outline" className="text-[11px] font-mono gap-1">
              <SearchIcon className="w-3 h-3" /> {savedAgent?.researchProvider || 'auto'}
            </Badge>
            <Badge variant="outline" className="text-[11px] font-mono gap-1">
              <ImageIcon className="w-3 h-3" /> {savedAgent?.imageProvider || 'auto'}
              {savedAgent?.imageModel && <span className="text-muted-foreground">· {savedAgent.imageModel.split('/').pop()}</span>}
            </Badge>
            <Badge variant="outline" className="text-[11px] font-mono">depth: {savedAgent?.researchDepth || 'standard'}</Badge>
            <Badge variant="outline" className="text-[11px] font-mono">mode: {savedAgent?.taskMode || 'standard'}</Badge>
            <Badge variant="outline" className="text-[11px] font-mono">automation: {savedAgent?.automationMode || 'safe'}</Badge>
            <Badge variant="outline" className="text-[11px] font-mono">{savedAgent?.memoryEnabled === false ? 'memory: off' : `memory: ${savedAgent?.memoryMaxItems || 8}`}</Badge>
            <Badge variant="outline" className="text-[11px] font-mono">{savedAgent?.shellEnabled ? 'shell: on' : 'shell: off'}</Badge>
            {(savedAgent?.imageKeys?.length || 0) > 0 && (
              <Badge variant="outline" className="text-[11px] font-mono">↪️ {savedAgent.imageKeys.length} fallback{savedAgent.imageKeys.length === 1 ? '' : 's'}</Badge>
            )}
          </div>
        </CardContent>
      </Card>


      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Telegram Notifications</CardTitle>
              <CardDescription>Get alerts when uploads succeed or fail + chat with AI</CardDescription>
            </div>
            <Switch
              checked={settings.telegram.enabled}
              onCheckedChange={(v) =>
                setSettings((p) => ({ ...p, telegram: { ...p.telegram, enabled: v } }))
              }
            />
          </div>
        </CardHeader>
        {settings.telegram.enabled && (
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Bot Token</Label>
              <PasswordInput
                value={settings.telegram.botToken}
                onChange={(v) =>
                  setSettings((p) => ({
                    ...p,
                    telegram: { ...p.telegram, botToken: v },
                  }))
                }
                placeholder="Paste your Telegram bot token from BotFather"
              />
              <p className="text-xs text-muted-foreground">
                Saved for the local worker, so Telegram sends directly from your PC instead of the cloud connector.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Chat ID</Label>
              <div className="flex gap-2">
                <Input
                  value={settings.telegram.chatId}
                  onChange={(e) =>
                    setSettings((p) => ({
                      ...p,
                      telegram: { ...p.telegram, chatId: e.target.value },
                    }))
                  }
                  placeholder="Your numeric chat ID (e.g. 848868115)"
                />
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={async () => {
                    try {
                      const { data, error } = await supabase
                        .from('telegram_messages')
                        .select('chat_id')
                        .eq('is_bot', false)
                        .order('created_at', { ascending: false })
                        .limit(1);
                      if (error) throw error;
                      if (data && data.length > 0) {
                        const detectedId = String(data[0].chat_id);
                        setSettings((p) => ({
                          ...p,
                          telegram: { ...p.telegram, chatId: detectedId },
                        }));
                        toast({ title: `Chat ID detected: ${detectedId}` });
                      } else {
                        toast({ title: 'No messages found', description: 'Send a message to your bot first, then try again.', variant: 'destructive' });
                      }
                    } catch (err: any) {
                      toast({ title: 'Detection failed', description: err.message, variant: 'destructive' });
                    }
                  }}
                >
                  Auto-detect
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Enter your <b>numeric</b> chat ID (not bot username). Send any message to your bot, then click "Auto-detect", or message @userinfobot on Telegram to find it.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={!settings.telegram.chatId}
              onClick={async () => {
                try {
                  const response = await fetch('http://localhost:3001/api/telegram/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      chat_id: Number(settings.telegram.chatId),
                      text: '✅ <b>Video Uploader</b> — Telegram notifications are working locally!',
                    }),
                    signal: AbortSignal.timeout(10000),
                  });
                  const data = await response.json().catch(() => ({}));
                  if (!response.ok) throw new Error(data?.error || 'Local Telegram send failed');
                  if (data?.success) {
                    toast({ title: 'Test message sent to Telegram!' });
                  } else {
                    toast({ title: 'Telegram error', description: data?.error || 'Unknown error', variant: 'destructive' });
                  }
                } catch (err: any) {
                  toast({ title: 'Failed to send', description: err.message, variant: 'destructive' });
                }
              }}
            >
              <Send className="w-3.5 h-3.5" />
              Send Test Message
            </Button>
          </CardContent>
        )}
      </Card>

      <Button onClick={handleSave} disabled={saving} size="lg">
        {saving ? 'Saving…' : 'Save All Settings'}
      </Button>
    </div>
  );
}
