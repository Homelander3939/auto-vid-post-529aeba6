// Polled by pg_cron every minute. Finds enabled social_post_schedules whose
// cron expression is due and invokes generate-social-post (which already saves
// a draft AND pushes a Telegram preview). Updates last_run_at on success.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Tiny cron matcher: supports M H D M DOW with *, */N, and comma lists.
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (!step || step <= 0) return false;
    return (value - min) % step === 0;
  }
  return field.split(',').map((p) => parseInt(p, 10)).filter((n) => !isNaN(n)).includes(value);
}

// All cron expressions are interpreted in **Asia/Tbilisi (UTC+4, no DST)** —
// the user's local timezone. We shift `now` by +4h before extracting fields so
// `0 9 * * *` means "09:00 Tbilisi" not 09:00 UTC.
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
function isDue(cron: string, now: Date): boolean {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  const local = new Date(now.getTime() + TBILISI_OFFSET_MS);
  const minute = local.getUTCMinutes();
  const hour   = local.getUTCHours();
  const day    = local.getUTCDate();
  const month  = local.getUTCMonth() + 1;
  const wday   = local.getUTCDay();
  return fieldMatches(m, minute, 0, 59)
    && fieldMatches(h, hour, 0, 23)
    && fieldMatches(dom, day, 1, 31)
    && fieldMatches(mon, month, 1, 12)
    && fieldMatches(dow, wday, 0, 6);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let body: any = {};
  try { body = await req.json(); } catch {}
  const forceId: number | null = body?.scheduleId ?? null;
  const force: boolean = !!body?.force;

  const now = new Date();
  const { data: schedules, error } = await supabase
    .from('social_post_schedules')
    .select('*')
    .eq('enabled', true);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const triggered: any[] = [];
  const skipped: any[] = [];

  for (const s of (schedules || [])) {
    if (forceId && s.id !== forceId) continue;
    // Folder-source schedules are owned by the local worker (it reads .txt + images
    // from disk and publishes via the same pipeline as "Publish now"). Skip here so
    // we don't double-fire.
    if ((s as any).source_type === 'folder') {
      skipped.push({ id: s.id, reason: 'folder-source-handled-by-local-worker' });
      continue;
    }
    if (s.end_at && new Date(s.end_at).getTime() < now.getTime()) {
      skipped.push({ id: s.id, reason: 'expired' });
      continue;
    }

    // Skip if already ran in the same minute (cron resolution).
    const lastRun = s.last_run_at ? new Date(s.last_run_at) : null;
    if (!force && lastRun) {
      const sameMinute = lastRun.getUTCFullYear() === now.getUTCFullYear()
        && lastRun.getUTCMonth() === now.getUTCMonth()
        && lastRun.getUTCDate() === now.getUTCDate()
        && lastRun.getUTCHours() === now.getUTCHours()
        && lastRun.getUTCMinutes() === now.getUTCMinutes();
      if (sameMinute) { skipped.push({ id: s.id, reason: 'already-ran-this-minute' }); continue; }
    }

    if (!force && !isDue(s.cron_expression, now)) {
      skipped.push({ id: s.id, reason: 'not-due' });
      continue;
    }

    const platforms: string[] = (s.target_platforms || []).filter(
      (p: string) => ['x', 'linkedin', 'facebook'].includes(p),
    );
    if (platforms.length === 0 || !s.ai_prompt) {
      skipped.push({ id: s.id, reason: 'missing-prompt-or-platforms' });
      continue;
    }

    // Mark last_run_at FIRST + bump run_count to avoid double-fire if pg_cron retries.
    const nextRunCount = (s.run_count || 0) + 1;
    await supabase.from('social_post_schedules')
      .update({ last_run_at: now.toISOString(), updated_at: now.toISOString(), run_count: nextRunCount } as any)
      .eq('id', s.id);

    // ── Topic Campaign Mode ─────────────────────────────────────────────
    // When topic_mode is on, treat ai_prompt as an evergreen TOPIC and wrap
    // it with creative SMM-manager-style instructions that rotate each run
    // so consecutive posts feel fresh — just like a human social manager
    // would post about the same brand week after week.
    let finalPrompt: string = s.ai_prompt;
    if (s.topic_mode) {
      const defaultHints = [
        'an unexpected contrarian take',
        'a story-driven micro-narrative with a hook',
        'a data-driven insight with a surprising stat',
        'a practical actionable tip framed as a checklist',
        'a behind-the-scenes / how-it-works angle',
        'a question that invites engagement and replies',
        'a bold prediction about where this is heading',
        'a teardown of a common myth or misconception',
        'a list of 3 quick wins',
        'a personal lesson learned framed authentically',
      ];
      const hints: string[] = (Array.isArray(s.variation_hints) && s.variation_hints.length)
        ? s.variation_hints
        : defaultHints;
      const angle = hints[(nextRunCount - 1) % hints.length];
      finalPrompt =
        `You are a seasoned social media manager running an ongoing content campaign on the topic: "${s.ai_prompt}".\n\n` +
        `For TODAY'S post (run #${nextRunCount}), use this angle: ${angle}.\n` +
        `Be creative, innovative, and write like a real human SMM manager — not a generic AI. ` +
        `Avoid repeating phrases or hooks you would have used on previous runs of this campaign. ` +
        `Tailor the tone per platform (X = punchy & witty, LinkedIn = professional & insightful, Facebook = warm & conversational). ` +
        `Hashtags must feel native, not stuffed.`;
    }

    // Fire generate-social-post. For auto_publish we MUST use stream:true (the
    // edge function only persists+returns the savedPostId via SSE) and parse
    // the stream for the `saved` event so we can flip the new draft to pending.
    const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-social-post`;
    const postsPerRun = Math.max(1, Math.min(20, Number((s as any).posts_per_run) || 1));

    for (let i = 0; i < postsPerRun; i++) {
      if (s.auto_publish) {
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            },
            body: JSON.stringify({
              prompt: finalPrompt, platforms,
              includeImage: s.include_image !== false, stream: true,
            }),
          });

          let savedPostId: string | null = null;
          if (resp.ok && resp.body) {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let currentEvent = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let nl: number;
              while ((nl = buffer.indexOf('\n')) !== -1) {
                let line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (line.endsWith('\r')) line = line.slice(0, -1);
                if (!line) { currentEvent = ''; continue; }
                if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue; }
                if (line.startsWith('data: ') && currentEvent === 'saved') {
                  try {
                    const parsed = JSON.parse(line.slice(6));
                    if (parsed?.id) savedPostId = parsed.id;
                  } catch { /* ignore */ }
                }
              }
            }
          }

          if (savedPostId) {
            const selections: Record<string, string> = { ...(s.account_selections || {}) };
            const missing = platforms.filter((p) => !selections[p]);
            if (missing.length) {
              const { data: accts } = await supabase
                .from('social_post_accounts')
                .select('id, platform, is_default, enabled')
                .in('platform', missing)
                .eq('enabled', true);
              for (const p of missing) {
                const list = (accts || []).filter((a: any) => a.platform === p);
                const def = list.find((a: any) => a.is_default) || list[0];
                if (def) selections[p] = def.id;
              }
            }

            const platformResults = platforms.map((name) => ({ name, status: 'pending' }));
            await supabase.from('social_posts').update({
              status: 'pending',
              account_selections: selections,
              platform_results: platformResults,
            } as any).eq('id', savedPostId);

            triggered.push({ id: s.id, name: s.name, platforms, savedPostId, mode: 'auto-publish', batchIndex: i });
          } else {
            triggered.push({ id: s.id, name: s.name, platforms, mode: 'auto-publish-no-save', batchIndex: i });
          }
        } catch (e: any) {
          console.error('[run-due-generations] auto-publish failed', s.id, e?.message);
          skipped.push({ id: s.id, reason: 'auto-publish-error', error: e?.message, batchIndex: i });
        }
      } else {
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          },
          body: JSON.stringify({
            prompt: finalPrompt, platforms,
            includeImage: s.include_image !== false, stream: true,
          }),
        }).catch((e) => console.error('[run-due-generations] invoke failed', s.id, e?.message));

        triggered.push({ id: s.id, name: s.name, platforms, mode: 'draft', batchIndex: i });
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, triggered, skipped, now: now.toISOString() }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
