import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Plus, Trash2, Star, Pencil, X, Check, Eye, EyeOff, Monitor } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { type SocialAccount, saveSocialAccount, deleteSocialAccount, setDefaultSocialAccount } from '@/lib/socialPosts';
import { openLocalBrowserProfileSession } from '@/lib/localBrowserProfiles';

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <button type="button" onClick={() => setShow(!show)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

const PLATFORM_META: Record<string, { title: string; desc: string; urlPlaceholder: string }> = {
  x: { title: 'X (Twitter)', desc: 'X.com login — browser opens x.com/compose', urlPlaceholder: 'https://x.com/yourhandle' },
  linkedin: { title: 'LinkedIn', desc: 'LinkedIn.com login — browser opens linkedin.com/feed', urlPlaceholder: 'https://www.linkedin.com/company/your-page/admin/' },
  facebook: { title: 'Facebook', desc: 'Facebook.com login — browser opens facebook.com', urlPlaceholder: 'https://www.facebook.com/YourPageName' },
};

export default function SocialAccountCard({
  platform,
  accounts,
  onRefresh,
  localMode,
}: {
  platform: string;
  accounts: SocialAccount[];
  onRefresh: () => void;
  localMode: boolean;
}) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ label: '', email: '', password: '', target_url: '' });
  const [saving, setSaving] = useState(false);
  const [preparingId, setPreparingId] = useState<string | null>(null);

  const platformAccounts = accounts.filter((a) => a.platform === platform);
  const meta = PLATFORM_META[platform] || { title: platform, desc: '', urlPlaceholder: 'https://...' };

  const resetForm = () => { setForm({ label: '', email: '', password: '', target_url: '' }); setAdding(false); setEditingId(null); };

  const handleSave = async () => {
    if (!form.email.trim()) { toast({ title: 'Email/username is required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const payload: any = {
        platform,
        label: form.label.trim() || form.email.split('@')[0],
        email: form.email.trim(),
        password: form.password,
        target_url: form.target_url.trim() || null,
        enabled: true,
      };
      if (editingId) payload.id = editingId;
      else if (platformAccounts.length === 0) payload.is_default = true;
      await saveSocialAccount(payload);
      toast({ title: editingId ? 'Account updated' : 'Account added' });
      resetForm();
      onRefresh();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    try { await deleteSocialAccount(id); toast({ title: 'Account removed' }); onRefresh(); }
    catch (e: any) { toast({ title: 'Error', description: e.message, variant: 'destructive' }); }
  };

  const handleSetDefault = async (id: string) => {
    try { await setDefaultSocialAccount(id, platform); toast({ title: 'Default updated' }); onRefresh(); }
    catch (e: any) { toast({ title: 'Error', description: e.message, variant: 'destructive' }); }
  };

  const handleToggleEnabled = async (a: SocialAccount) => {
    try { await saveSocialAccount({ id: a.id, platform, enabled: !a.enabled }); onRefresh(); }
    catch (e: any) { toast({ title: 'Error', description: e.message, variant: 'destructive' }); }
  };

  const startEdit = (a: SocialAccount) => {
    setEditingId(a.id);
    setForm({ label: a.label, email: a.email, password: a.password, target_url: (a as any).target_url || '' });
    setAdding(true);
  };

  const handlePrepare = async (a: SocialAccount) => {
    setPreparingId(a.id);
    try {
      const res = await openLocalBrowserProfileSession({
        platform: `social-${platform}`,
        accountId: a.id,
        label: a.label || a.email,
      });
      toast({
        title: 'Browser profile opened',
        description: res.linkedAccountIds.length > 1
          ? `Log in once. Profile shared with ${res.linkedAccountIds.length} matching accounts.`
          : 'Log in once in the opened browser. This profile will be reused.',
      });
    } catch (e: any) {
      toast({ title: 'Could not open browser', description: e.message || 'Make sure local server is running on port 3001.', variant: 'destructive' });
    } finally { setPreparingId(null); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">{meta.title}</CardTitle>
            <CardDescription>{meta.desc}</CardDescription>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={() => { resetForm(); setAdding(true); }}>
            <Plus className="w-3.5 h-3.5" /> Add
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {platformAccounts.length === 0 && !adding && (
          <p className="text-sm text-muted-foreground text-center py-3">
            No accounts configured. Add one to enable {meta.title} posts.
          </p>
        )}
        {platformAccounts.map((a) => (
          <div key={a.id} className={`flex items-center gap-3 rounded-lg border p-3 ${a.enabled ? '' : 'opacity-60'}`}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{a.label || a.email}</span>
                {a.is_default && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 shrink-0">
                    <Star className="w-2.5 h-2.5 fill-current" /> Default
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">{a.email}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Switch checked={a.enabled} onCheckedChange={() => handleToggleEnabled(a)} className="scale-75" />
              {localMode && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground hover:text-foreground" onClick={() => handlePrepare(a)} disabled={preparingId === a.id}>
                  <Monitor className="w-3.5 h-3.5 mr-1" />
                  {preparingId === a.id ? 'Opening…' : 'Prepare'}
                </Button>
              )}
              {!a.is_default && platformAccounts.length > 1 && (
                <Button variant="ghost" size="sm" className="h-7 px-1.5" title="Set default" onClick={() => handleSetDefault(a.id)}>
                  <Star className="w-3.5 h-3.5" />
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={() => startEdit(a)}>
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 px-1.5 hover:text-destructive">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove account?</AlertDialogTitle>
                    <AlertDialogDescription>This removes {meta.title} account "{a.label || a.email}".</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleDelete(a.id)} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Remove</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ))}
        {adding && (
          <div className="rounded-lg border-2 border-dashed border-primary/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{editingId ? 'Edit Account' : 'New Account'}</p>
              <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={resetForm}><X className="w-3.5 h-3.5" /></Button>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Label (optional)</Label>
              <Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Brand, Personal" className="h-9" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Email / Username</Label>
              <Input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder={`${platform}@example.com`} className="h-9" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Password</Label>
              <PasswordInput value={form.password} onChange={(v) => setForm((f) => ({ ...f, password: v }))} placeholder="••••••••" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Post to URL (optional)</Label>
              <Input value={form.target_url} onChange={(e) => setForm((f) => ({ ...f, target_url: e.target.value }))} placeholder={meta.urlPlaceholder} className="h-9" />
              <p className="text-[11px] text-muted-foreground">Leave empty to post on the account's own profile. Set to a Page / Company URL to post there instead.</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
                <Check className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : editingId ? 'Update' : 'Add Account'}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
            </div>
            <p className="text-xs text-muted-foreground bg-secondary p-2.5 rounded-lg">
              💡 Use Prepare once per account to open its browser profile and save the login. Future posts reuse that saved profile.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
