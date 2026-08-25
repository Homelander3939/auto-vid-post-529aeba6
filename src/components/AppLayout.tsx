import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Settings, LayoutDashboard, Upload, Clock, BookOpen, MessageSquare, Wifi, WifiOff, Cloud, Monitor, Globe, Menu, X, Sparkles, Brain, Activity, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getSettings, saveSettings } from '@/lib/storage';
import { formatBuildLabel } from '@/lib/buildInfo';
import ThemeToggle from '@/components/ThemeToggle';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/queue', icon: Upload, label: 'Job Queue' },
  { to: '/schedule', icon: Clock, label: 'Schedule' },
  { to: '/chat', icon: MessageSquare, label: 'AI Chat' },
  { to: '/browser', icon: Globe, label: 'Browser' },
  { to: '/social', icon: Sparkles, label: 'Social Posts' },
  { to: '/skills', icon: Brain, label: 'Agent Skills' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/setup', icon: BookOpen, label: 'Setup Guide' },
];

type ServerStatus = 'connected' | 'disconnected' | 'checking';
type OptionalAIStatus = 'ready' | 'standby' | 'offline' | 'degraded' | 'checking';

function useLocalServerStatus() {
  const isLocalhost = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  );
  const [status, setStatus] = useState<ServerStatus>(isLocalhost ? 'checking' : 'disconnected');
  const [aiStatus, setAIStatus] = useState<OptionalAIStatus>('checking');
  const [aiMessage, setAIMessage] = useState('Checking the optional local AI arbiter.');

  useEffect(() => {
    // Skip health checks when running in the cloud preview — localhost:3001 is unreachable
    if (!isLocalhost) return;

    let mounted = true;
    const check = async () => {
      try {
        const resp = await fetch('http://localhost:3001/api/health', { signal: AbortSignal.timeout(3000) });
        const health = resp.ok ? await resp.json().catch(() => null) : null;
        if (mounted) {
          setStatus(resp.ok && health?.core?.status !== 'down' ? 'connected' : 'disconnected');
          setAIStatus((health?.ai?.status || 'offline') as OptionalAIStatus);
          setAIMessage(health?.ai?.message || 'AI is optional and will load only when requested.');
        }
      } catch {
        if (mounted) {
          setStatus('disconnected');
          setAIStatus('offline');
          setAIMessage('The core local server is offline.');
        }
      }
    };
    check();
    const interval = setInterval(check, 10000);
    return () => { mounted = false; clearInterval(interval); };
  }, [isLocalhost]);

  return { serverStatus: status, aiStatus, aiMessage };
}

type DiagnosticsSnapshot = {
  overall: 'healthy' | 'degraded' | 'down';
  issues: string[];
  gateway: { ok: boolean; latencyMs: number; error?: string };
  local_worker: { alive: boolean; last_seen_at: string | null };
  providers: Record<string, { status: string; optional?: boolean }>;
  runs_24h: { total: number; completed: number; failed: number; running: number };
};

function useAgentDiagnostics(serverStatus: ServerStatus, aiStatus: OptionalAIStatus, aiMessage: string) {
  const [data, setData] = useState<DiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    const isLocalhost = typeof window !== 'undefined' && (
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    );
    const localAlive = serverStatus === 'connected';
    const previewMode = !isLocalhost;
    const aiReady = aiStatus === 'ready';

    setData({
      overall: previewMode || aiReady ? 'healthy' : localAlive ? 'degraded' : 'down',
      issues: previewMode
        ? ['Live edge diagnostics disabled to prevent transient 503 cold-starts from blanking the app.']
        : localAlive && !aiReady
          ? [aiMessage, 'Core uploads, schedules, accounts, and social workers remain operational without AI.']
          : localAlive
            ? ['Optional AI arbiter is ready. Core automation remains independent.']
          : ['Local server is not responding on localhost:3001.'],
      gateway: { ok: aiReady, latencyMs: 0, error: aiReady ? undefined : aiMessage },
      local_worker: { alive: localAlive, last_seen_at: localAlive ? new Date().toISOString() : null },
      providers: { lmstudio: { status: aiStatus, optional: true } },
      runs_24h: { total: 0, completed: 0, failed: 0, running: 0 },
    });
    setLoading(false);
  }, [serverStatus, aiStatus, aiMessage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, refresh };
}

export default function AppLayout() {
  const { serverStatus, aiStatus, aiMessage } = useLocalServerStatus();
  const { data: diagnostics, refresh: refreshDiagnostics } = useAgentDiagnostics(serverStatus, aiStatus, aiMessage);
  const queryClient = useQueryClient();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isChatRoute = location.pathname === '/chat';

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const uploadMode = settings?.uploadMode || 'local';
  const isCloud = uploadMode === 'cloud';
  const buildLabel = formatBuildLabel(__BUILD_NAME__, __BUILD_NUMBER__, __PR_NUMBER__);
  const versionLabel = __APP_VERSION__ ? `v${__APP_VERSION__}` : '';
  const commitLabel = __BUILD_COMMIT__ ? `Commit ${__BUILD_COMMIT__}` : '';
  const primaryBuildLabel = buildLabel !== 'dev' ? buildLabel : (commitLabel || 'dev');
  const buildMetaLabel = [primaryBuildLabel, versionLabel].filter(Boolean).join(' · ');

  // Close mobile nav on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const toggleMode = async () => {
    if (!settings) return;
    const newMode = isCloud ? 'local' : 'cloud';
    const updated = { ...settings, uploadMode: newMode as 'local' | 'cloud' };
    await saveSettings(updated);
    queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 shrink-0 border-r bg-card flex flex-col transition-transform duration-200 ease-out',
          'md:static md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="p-6 pb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Video Uploader
          </h1>
          <button
            onClick={() => setMobileOpen(false)}
            className="md:hidden p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground px-6 -mt-2 mb-2">
          YouTube · TikTok · Instagram
        </p>

        <nav className="flex-1 px-3 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                )
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t space-y-3">
          <ThemeToggle />
          {/* Mode toggle button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggleMode}
                className={cn(
                  'flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-xs font-medium transition-all border',
                  isCloud
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100'
                    : 'bg-secondary border-border text-muted-foreground hover:bg-secondary/80'
                )}
              >
                {isCloud ? (
                  <>
                    <Cloud className="w-4 h-4 text-emerald-600" />
                    <span>Cloud Mode</span>
                    <span className="ml-auto relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                  </>
                ) : (
                  <>
                    <Monitor className="w-4 h-4" />
                    <span>Local Mode</span>
                  </>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[220px]">
              {isCloud
                ? 'Cloud mode active — uploads via Browserbase remote browser. Click to switch to local.'
                : 'Local mode — uploads via your PC server. Click to switch to cloud.'}
            </TooltipContent>
          </Tooltip>

          {/* Connection status */}
          {isCloud ? (
            <div className="flex items-center gap-2 px-1">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
              </span>
              <span className="text-xs text-emerald-600 font-medium">Browserbase connected</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-1">
              {serverStatus === 'connected' ? (
                <>
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                  </span>
                  <span className="text-xs text-emerald-600 font-medium">Local server connected</span>
                </>
              ) : serverStatus === 'checking' ? (
                <>
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse" />
                  <span className="text-xs text-muted-foreground">Checking server…</span>
                </>
              ) : (
                <>
                  <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
                  <span className="text-xs text-muted-foreground">
                    {typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'
                      ? 'Preview mode — use localhost:8081'
                      : 'Local server offline'}
                  </span>
                </>
              )}
            </div>
          )}

          {/* AI / Agent diagnostics badge */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={refreshDiagnostics}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs w-full border border-border bg-secondary/40 hover:bg-secondary text-left"
              >
                {!diagnostics ? (
                  <>
                    <Activity className="w-3.5 h-3.5 text-muted-foreground animate-pulse" />
                    <span className="text-muted-foreground">Diagnostics…</span>
                  </>
                ) : diagnostics.overall === 'healthy' ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-700 dark:text-emerald-400 font-medium">AI ready · optional</span>
                  </>
                ) : diagnostics.overall === 'degraded' ? (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                    <span className="text-amber-700 dark:text-amber-400 font-medium">AI standby · core ready</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                    <span className="text-destructive font-medium">Core server offline</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{diagnostics.issues.length}</span>
                  </>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-[300px] space-y-1">
              {diagnostics ? (
                <>
                  <div className="text-xs font-medium">Agent diagnostics</div>
                  <div className="text-[11px] text-muted-foreground">
                    Gateway: {diagnostics.gateway.ok ? `${diagnostics.gateway.latencyMs}ms` : (diagnostics.gateway.error || 'down')}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Worker: {diagnostics.local_worker.alive ? 'alive' : (diagnostics.local_worker.last_seen_at ? `seen ${new Date(diagnostics.local_worker.last_seen_at).toLocaleTimeString()}` : 'never')}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    24h runs: {diagnostics.runs_24h.completed}✓ / {diagnostics.runs_24h.failed}✗ / {diagnostics.runs_24h.running}⏳
                  </div>
                  {diagnostics.issues.length > 0 && (
                    <ul className="text-[11px] text-amber-600 dark:text-amber-400 list-disc pl-3 mt-1">
                      {diagnostics.issues.slice(0, 4).map((i, k) => <li key={k}>{i}</li>)}
                    </ul>
                  )}
                  <div className="text-[10px] text-muted-foreground pt-1">Click to refresh</div>
                </>
              ) : 'Loading diagnostics…'}
            </TooltipContent>
          </Tooltip>

          <p className="text-xs px-1">
            <span className="block font-medium text-foreground/85">{buildMetaLabel}</span>
            <span className="block text-[10px] text-muted-foreground mt-0.5">
              {[isCloud ? 'Cloud Mode' : 'Local Mode', isCloud ? 'Cloud DB · Cloud uploads' : 'Local SQLite DB · Local uploads'].join(' · ')}
            </span>
          </p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto min-w-0">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b bg-card/95 backdrop-blur px-4 py-3 md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-sm font-semibold text-foreground truncate">Video Uploader</span>
          <div className="ml-auto">
            {isCloud ? (
              <span className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                Cloud
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn(
                  'h-2 w-2 rounded-full',
                  serverStatus === 'connected' ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                )} />
                Local
              </span>
            )}
          </div>
        </div>

        <div className={cn(
          isChatRoute ? 'h-[calc(100dvh-3.5rem)] md:h-[100dvh]' : 'max-w-5xl mx-auto p-4 sm:p-6 md:p-8'
        )}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
