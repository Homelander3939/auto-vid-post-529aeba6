// Agent Runner — multi-step autonomous agent (like Claude Code / Codex)
// - Uses the user-configured AI provider (ai_provider/ai_api_key/ai_model from app_settings)
//   for the planning/reasoning loop. Falls back to Lovable AI Gateway if no key.
// - Streams every step (plan, tool_call, tool_result, thought, file_write, done) into
//   agent_runs.events so the web UI and Telegram can render a live activity feed.
// - Tools that need the local Windows PC (write_file, read_file, run_shell, open_in_browser,
//   serve_preview, browser_task) are queued for the local worker through pending_commands; the worker
//   appends results back into agent_runs.events.
//
// Two entry modes:
//   POST { prompt, source: 'web', telegram_chat_id? }      → creates a run, returns { runId } immediately.
//   POST { runId, action: 'cancel' }                       → cancels a running agent.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DEFAULT_LOVABLE_MODEL, LOVABLE_GATEWAY, LOVABLE_MODELS, normalizeLovableModel, resolveChatProviderConfig } from "../_shared/ai-provider.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';
const MAX_STEPS = 12;

function getMissingColumnName(error: { message?: string; details?: string } | null | undefined): string | null {
  const text = [error?.message, error?.details].filter(Boolean).join(' ');
  const quoted = text.match(/Could not find the '([^']+)' column/i);
  if (quoted?.[1]) return quoted[1];
  const doubleQuoted = text.match(/column "([^"]+)"/i);
  if (doubleQuoted?.[1]) return doubleQuoted[1];
  return null;
}

async function insertAgentRunCompat(supabase: any, payload: Record<string, unknown>) {
  const nextPayload = { ...payload };
  const removedColumns = new Set<string>();
  const maxRetries = Math.min(Math.max(Object.keys(nextPayload).length, 1), 6);
  let attempts = 0;

  while (Object.keys(nextPayload).length > 0 && attempts < maxRetries) {
    attempts += 1;
    const result = await supabase.from('agent_runs').insert(nextPayload).select('id').single();
    if (!result.error) return result;

    const missingColumn = getMissingColumnName(result.error);
    if (!missingColumn || !(missingColumn in nextPayload) || removedColumns.has(missingColumn)) {
      throw new Error(result.error.message);
    }

    removedColumns.add(missingColumn);
    delete nextPayload[missingColumn];
  }

  throw new Error('Could not create agent run: all retryable columns were rejected');
}

/* ── Tool catalog exposed to the planner LLM ─────────────────────────── */
const tools = [
  {
    type: 'function',
    function: {
      name: 'plan',
      description: 'Emit / update the high-level numbered plan. Call this FIRST before any other tool. You may call again to revise the plan as you learn more.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered list of short step descriptions (3-7 steps).',
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'research_deep',
      description: 'Run deep web research using the user\'s configured research provider (Perplexity/Firecrawl/Tavily) or local browser fallback. Returns synthesized findings + source URLs INLINE for you to use.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          depth: { type: 'string', enum: ['light', 'standard', 'deep'], default: 'standard' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image with the user\'s configured image model (Gemini Nano Banana / OpenAI / Stability) and return its public URL.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:5'], default: '16:9' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file inside this run\'s workspace folder on the user\'s LOCAL PC. Path is relative (e.g. "index.html" or "src/App.tsx"). Overwrites if exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace folder.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all files in the workspace folder (recursive).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a shell command in the workspace folder (allowed commands: npm, npx, node, python/python3/py, pip/pip3, git, dir, ls). Requires user to have enabled shell access in Settings.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'e.g. "npm install" or "node build.js"' },
          timeout_seconds: { type: 'number', default: 60 },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_in_browser',
      description: 'Open a URL or local file in the user\'s default browser on their PC.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'Full URL or workspace-relative path' } },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'serve_preview',
      description: 'Start a static preview server for the workspace folder. Returns a URL the user can open. Best for HTML/JS apps.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_task',
      description: 'Run a natural-language browser automation task on the user\'s local PC using the existing browser agent. Best for website research, parsing, scraping, or form workflows that need a real browser.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Natural-language browser task to perform.' },
          url: { type: 'string', description: 'Optional starting URL.' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Store an important durable memory so future tasks can reuse it. Use for stable facts, preferences, workflows, accounts, constraints, or repeated context worth remembering.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          memory_type: { type: 'string', enum: ['fact', 'workflow', 'preference', 'subtask'] },
          importance: { type: 'number', minimum: 1, maximum: 100, default: 60 },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'chain_skill',
      description: 'Load a saved skill into the current task as a reusable subtask building block. Use when an existing skill can help complete part of the task.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Skill name, trigger, or short description of what skill to reuse.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'improve_skill',
      description: 'Persist an improvement back into an existing saved skill after learning a better workflow, subtask sequence, or durable instruction.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Skill name or trigger to improve.' },
          note: { type: 'string', description: 'What changed or improved.' },
          append_step: { type: 'string', description: 'Optional new reusable step to append.' },
          tags: { type: 'array', items: { type: 'string' } },
          triggers: { type: 'array', items: { type: 'string' } },
        },
        required: ['query', 'note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_skill',
      description: 'Propose saving the routine you just executed as a reusable Skill (like OpenClaw/Hermes skills). The user will review and approve from the Skills page. Use this when the task represents a repeatable workflow worth memorizing.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short skill name, e.g. "Daily LinkedIn digest"' },
          description: { type: 'string' },
          triggers: { type: 'array', items: { type: 'string' }, description: 'Phrases that should auto-suggest this skill in future' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                note: { type: 'string' },
                args: { type: 'object', additionalProperties: true },
              },
              required: ['note'],
            },
          },
          system_prompt: { type: 'string', description: 'Extra instructions to load when re-running this skill' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Mark the agent task as complete. Call this LAST with a short summary of what was accomplished and any links/paths the user should know about.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['file', 'url', 'image', 'preview'] },
                label: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['kind', 'label', 'value'],
            },
          },
        },
        required: ['summary'],
      },
    },
  },
];

/* ── Helpers ──────────────────────────────────────────────────────────── */

function slugify(s: string): string {
  return (s || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

async function appendEvent(supabase: any, runId: string, event: any) {
  const { data: row } = await supabase.from('agent_runs').select('events').eq('id', runId).single();
  const events = Array.isArray(row?.events) ? row.events : [];
  events.push({ ...event, ts: Date.now() });
  await supabase.from('agent_runs').update({ events }).eq('id', runId);
  return events;
}

async function setStatus(supabase: any, runId: string, patch: any) {
  await supabase.from('agent_runs').update(patch).eq('id', runId);
}

async function getRun(supabase: any, runId: string) {
  const { data } = await supabase.from('agent_runs').select('*').eq('id', runId).single();
  return data;
}

function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function keywordOverlapScore(query: string, haystack: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const targetTokens = new Set(tokenize(haystack));
  return queryTokens.reduce((score, token) => score + (targetTokens.has(token) ? 1 : 0), 0);
}

async function loadRelevantMemories(supabase: any, prompt: string, limit: number) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const { data } = await supabase
    .from('agent_memories')
    .select('*')
    .eq('enabled', true)
    .order('importance', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(80);
  const scored = (data || [])
    .map((memory: any) => ({
      memory,
      score: keywordOverlapScore(prompt, `${memory.title}\n${memory.content}\n${(memory.tags || []).join(' ')}`) + (Number(memory.importance) || 0) / 25,
    }))
    .filter((entry: any) => entry.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, cappedLimit)
    .map((entry: any) => entry.memory);
  for (const memory of scored) {
    await supabase.from('agent_memories').update({
      use_count: (memory.use_count || 0) + 1,
      last_used_at: new Date().toISOString(),
    }).eq('id', memory.id);
  }
  return scored;
}

async function rememberFact(supabase: any, runId: string, args: any) {
  const payload = {
    title: String(args.title || '').trim(),
    content: String(args.content || '').trim(),
    memory_type: String(args.memory_type || 'fact'),
    tags: Array.isArray(args.tags) ? args.tags.map((tag: any) => String(tag).trim()).filter(Boolean) : [],
    importance: Math.min(Math.max(Number(args.importance) || 60, 1), 100),
    source_run_id: runId,
  };
  if (!payload.title || !payload.content) {
    return { ok: false, summary: 'Memory title and content are required.' };
  }
  const { data, error } = await supabase.from('agent_memories').insert(payload).select().single();
  if (error) return { ok: false, summary: error.message };
  return { ok: true, summary: `Memory saved: ${data.title}`, data };
}

async function findSkillForQuery(supabase: any, query: string) {
  const { data } = await supabase.from('agent_skills').select('*').eq('enabled', true).limit(100);
  const scored = (data || [])
    .map((skill: any) => ({
      skill,
      score: keywordOverlapScore(query, [
        skill.name,
        skill.description,
        skill.system_prompt,
        ...(skill.triggers || []),
        ...(skill.tags || []),
      ].join('\n')),
    }))
    .filter((entry: any) => entry.score > 0)
    .sort((a: any, b: any) => b.score - a.score);
  return scored[0]?.skill || null;
}

async function chainSkill(supabase: any, args: any) {
  const skill = await findSkillForQuery(supabase, String(args.query || ''));
  if (!skill) return { ok: false, summary: `No saved skill matched "${args.query || ''}".` };
  return {
    ok: true,
    summary: `Loaded skill "${skill.name}".`,
    data: {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      system_prompt: skill.system_prompt,
      triggers: skill.triggers || [],
      tags: skill.tags || [],
      steps: skill.steps || [],
    },
  };
}

async function improveSkill(supabase: any, args: any) {
  const skill = await findSkillForQuery(supabase, String(args.query || ''));
  if (!skill) return { ok: false, summary: `No saved skill matched "${args.query || ''}".` };

  const nextSteps = Array.isArray(skill.steps) ? [...skill.steps] : [];
  if (args.append_step) {
    const note = String(args.append_step).trim();
    if (note && !nextSteps.some((step: any) => String(step?.note || '').trim() === note)) {
      nextSteps.push({ note });
    }
  }

  const appendedNote = String(args.note || '').trim();
  const existingPrompt = String(skill.system_prompt || '').trim();
  const improvedPrompt = appendedNote
    ? [existingPrompt, 'Improvement notes:', `- ${appendedNote}`].filter(Boolean).join('\n\n')
    : existingPrompt;

  const mergedTags = [...new Set([...(skill.tags || []), ...((Array.isArray(args.tags) ? args.tags : []).map((tag: any) => String(tag).trim()).filter(Boolean))])];
  const mergedTriggers = [...new Set([...(skill.triggers || []), ...((Array.isArray(args.triggers) ? args.triggers : []).map((tag: any) => String(tag).trim()).filter(Boolean))])];

  const { data, error } = await supabase.from('agent_skills').update({
    steps: nextSteps,
    system_prompt: improvedPrompt,
    tags: mergedTags,
    triggers: mergedTriggers,
  }).eq('id', skill.id).select().single();
  if (error) return { ok: false, summary: error.message };
  return { ok: true, summary: `Improved skill "${data.name}".`, data };
}

function getAutomationBlockReason(automationMode: string, toolName: string, args: any): string | null {
  if (automationMode !== 'safe') return null;
  if (toolName !== 'browser_task') return null;
  const task = String(args.task || '');
  if (!task) return null;
  if (/\b(parse|scrape|extract|research|inspect|review|summarize|compare|collect|crawl|analyze)\b/i.test(task)) return null;
  if (/\b(trade|buy|sell|order|checkout|payment|wallet|bank|transfer|publish|post|submit|send message|log in|login|sign in)\b/i.test(task)) {
    return 'Safe automation mode only allows read-only browser research/parsing workflows. Switch Settings → Research & Image Agent → Automation mode to Extended for higher-risk actions.';
  }
  return null;
}

/* ── Telegram live-status (edits a single message in place) ──────────── */

async function tgSend(chatId: string, text: string, lovKey: string, tgKey: string): Promise<number | null> {
  try {
    const r = await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovKey}`,
        'X-Connection-Api-Key': tgKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900) }),
    });
    const d = await r.json();
    return d?.result?.message_id ?? null;
  } catch (e) {
    console.error('tgSend failed:', e);
    return null;
  }
}

async function tgEdit(chatId: string, messageId: number, text: string, lovKey: string, tgKey: string) {
  try {
    await fetch(`${TELEGRAM_GATEWAY}/editMessageText`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovKey}`,
        'X-Connection-Api-Key': tgKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text.slice(0, 3900) }),
    });
  } catch (e) {
    console.error('tgEdit failed:', e);
  }
}

function renderTelegramStatus(prompt: string, events: any[], status: string): string {
  const planEvent = [...events].reverse().find((e) => e.type === 'plan');
  const plan = planEvent?.steps as string[] | undefined;
  const recent = events.filter((e) => ['tool_call', 'tool_result', 'thought', 'finish', 'review', 'memory_saved'].includes(e.type)).slice(-6);

  let txt = `🤖 Agent — ${status === 'running' ? '⏳ working' : status === 'completed' ? '✅ done' : '⚠️ ' + status}\n\n`;
  txt += `📝 ${prompt.slice(0, 140)}${prompt.length > 140 ? '…' : ''}\n\n`;
  if (plan && plan.length) {
    txt += `🧭 Plan:\n${plan.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\n`;
  }
  if (recent.length) {
    txt += `▶ Activity:\n`;
    for (const e of recent) {
      if (e.type === 'tool_call') txt += `  🔧 ${e.name}${e.label ? ` — ${e.label}` : ''}\n`;
      else if (e.type === 'tool_result') txt += `  ${e.ok ? '✓' : '✗'} ${e.name}: ${(e.summary || '').slice(0, 100)}\n`;
      else if (e.type === 'review') txt += `  🧐 ${(e.text || '').slice(0, 100)}\n`;
      else if (e.type === 'memory_saved') txt += `  🧠 memory saved: ${e.title || 'untitled'}\n`;
      else if (e.type === 'finish') txt += `\n${e.summary || 'Done.'}\n`;
    }
  }
  return txt.trim();
}

/* ── Provider map: read user's configured keys ───────────────────────── */

async function getProviderMap(supabase: any) {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  const s = data || {};
  // Pick best image key: prefer image_keys[] entries with apiKey, else image_api_key
  let imageKey = '';
  let imageProvider = s.image_provider || 'auto';
  let imageModel = s.image_model || '';
  try {
    const keys = Array.isArray(s.image_keys) ? s.image_keys : [];
    const usable = keys.find((k: any) => k && k.apiKey && k.enabled !== false);
    if (usable) { imageKey = usable.apiKey; imageProvider = usable.provider || imageProvider; imageModel = usable.model || imageModel; }
  } catch { /* ignore */ }
  if (!imageKey) imageKey = s.image_api_key || '';

  const rawProvider = (s.ai_provider || 'lovable') as string;
  const rawApiKey = (s.ai_api_key || '') as string;
  const rawModel = (s.ai_model || DEFAULT_LOVABLE_MODEL) as string;
  // For the lovable provider (or when no custom API key is available), ensure the model is
  // always a valid Lovable Gateway model. This prevents raw user-entered models like
  // a local LM Studio model ID from being sent to the Lovable Gateway and rejected.
  const chatModel = (!rawApiKey || rawProvider === 'lovable')
    ? normalizeLovableModel(rawModel)
    : rawModel;

  return {
    chat: {
      provider: rawProvider,
      apiKey: rawApiKey,
      model: chatModel,
      baseUrl: s.ai_base_url || '',
    },
    research: {
      provider: s.research_provider || 'auto',
      apiKey: s.research_api_key || '',
    },
    image: {
      provider: imageProvider,
      apiKey: imageKey,
      model: imageModel,
      imageKeys: (Array.isArray(s.image_keys) ? s.image_keys : []).filter((k: any) => k && k.enabled !== false),
    },
    taskMode: s.agent_task_mode || 'standard',
    automationMode: s.agent_automation_mode || 'safe',
    memoryEnabled: s.agent_memory_enabled !== false,
    memoryMaxItems: Math.min(Math.max(Number(s.agent_memory_max_items) || 8, 1), 20),
    shellEnabled: !!s.agent_shell_enabled,
    workspaceRoot: s.agent_workspace_path || '',
  };
}

/* ── LLM call helpers ────────────────────────────────────────────────── */

/** Returns true when the gateway response indicates a model-name rejection that
 *  can be resolved by retrying with a different model. Fail-fast on auth/rate
 *  errors so we don't needlessly burn through the fallback chain. */
function isInvalidModelError(status: number, body: string): boolean {
  return status === 400 && (body.includes('invalid model') || body.includes('model_not_found'));
}

/** Builds a deduplicated ordered list of Lovable Gateway model IDs to try as
 *  fallbacks. Always starts with DEFAULT_LOVABLE_MODEL, then the rest of
 *  LOVABLE_MODELS, skipping any model that was already tried as the primary. */
function buildLovableFallbackChain(primaryProvider: string, primaryModel: string): string[] {
  const seen = new Set<string>();
  if (primaryProvider === 'lovable') seen.add(primaryModel);
  const chain: string[] = [];
  for (const id of [DEFAULT_LOVABLE_MODEL, ...LOVABLE_MODELS.map((m) => m.id)]) {
    if (!seen.has(id)) {
      seen.add(id);
      chain.push(id);
    }
  }
  return chain;
}

/* ── Call planner LLM (user's provider, fallback Lovable) ────────────── */

async function callPlanner(messages: any[], chat: any, lovableKey: string): Promise<any> {
  const config = resolveChatProviderConfig(chat, lovableKey);
  if (config.fallbackReason) {
    console.warn('callPlanner provider fallback:', config.fallbackReason);
  }

  const makeRequest = (url: string, key: string, model: string) => fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
  });

  const primary = await makeRequest(config.url, config.key, config.model);
  if (primary.ok) return await primary.json();

  const primaryText = await primary.text();
  const primaryContext = `${config.provider}/${config.model} (${primary.status})`;
  // Any provider failure → cycle through all valid Lovable Gateway models until one succeeds.
  // This handles: invalid/unsupported models (e.g. qwen), models that don't support
  // tool_choice:'auto', expired custom API keys, provider outages, and cases where
  // DEFAULT_LOVABLE_MODEL itself has become invalid in the deployed function.
  const fallbackChain = buildLovableFallbackChain(config.provider, config.model);

  let lastStatus = primary.status;
  let lastText = primaryText;
  for (const fallbackModel of fallbackChain) {
    console.warn(`callPlanner: primary ${primaryContext} failed, retrying with Lovable/${fallbackModel}`);
    const fb = await makeRequest(LOVABLE_GATEWAY, lovableKey, fallbackModel);
    if (fb.ok) return await fb.json();
    lastStatus = fb.status;
    lastText = await fb.text();
    // Only continue to the next model for "invalid model" 400 rejections.
    // Fail fast on auth errors (401), rate limits (429), etc.
    if (!isInvalidModelError(lastStatus, lastText)) {
      break;
    }
  }

  throw new Error(`Planner LLM failed after trying ${fallbackChain.length + 1} model(s). Last error (${lastStatus}): ${lastText.slice(0, 200)}. Primary: ${primaryContext}`);
}

async function callReviewer(messages: any[], chat: any, lovableKey: string): Promise<string> {
  const config = resolveChatProviderConfig(chat, lovableKey);
  if (config.fallbackReason) {
    console.warn('callReviewer provider fallback:', config.fallbackReason);
  }

  const makeRequest = (url: string, key: string, model: string) => fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
  });

  const primary = await makeRequest(config.url, config.key, config.model);
  if (primary.ok) {
    const data = await primary.json();
    return data?.choices?.[0]?.message?.content || '';
  }

  // Primary failed → cycle through valid Lovable Gateway models until one succeeds.
  const fallbackChain = buildLovableFallbackChain(config.provider, config.model);

  for (const id of fallbackChain) {
    console.warn(`callReviewer: primary ${config.provider}/${config.model} failed, retrying with Lovable/${id}`);
    const fb = await makeRequest(LOVABLE_GATEWAY, lovableKey, id);
    if (fb.ok) {
      const data = await fb.json();
      return data?.choices?.[0]?.message?.content || '';
    }
    const fbText = await fb.text();
    if (!isInvalidModelError(fb.status, fbText)) {
      throw new Error(`Reviewer LLM failed (${fb.status}): ${fbText.slice(0, 300)}`);
    }
  }

  throw new Error('Reviewer LLM failed: no working Lovable model found');
}

/* ── Cloud-side tool executors (research + image — done in edge fn) ──── */

type ResearchSource = { title: string; url: string; snippet?: string };

function inferResearchProvider(provider: string, apiKey: string): string {
  if (provider && provider !== 'auto') return provider;
  // Heuristic only for auto mode. Only trust UNAMBIGUOUS prefix patterns —
  // never guess between providers that share the same key shape (e.g. 64-char hex
  // could be Serper or many others). Anything ambiguous → 'local' so the user
  // explicitly picks a provider in Settings instead of being silently routed wrong.
  const key = String(apiKey || '').trim();
  if (/^BSA[A-Za-z0-9_-]{10,}$/.test(key)) return 'brave';
  if (/^tvly-[A-Za-z0-9]{10,}$/i.test(key)) return 'tavily';
  if (/^fc-[A-Za-z0-9]{10,}$/i.test(key)) return 'firecrawl';
  // Serper: 64-char hex — only assume Serper if the user explicitly chose 'serper',
  // otherwise treat as ambiguous and fall back to local.
  return 'local';
}

async function searchBrave(apiKey: string, query: string, count = 6): Promise<ResearchSource[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Brave ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d?.web?.results || []).map((item: any) => ({ title: item.title, url: item.url, snippet: item.description || '' }));
}

async function searchTavily(apiKey: string, query: string, count = 6): Promise<ResearchSource[]> {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: 'advanced' }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d?.results || []).map((item: any) => ({ title: item.title, url: item.url, snippet: item.content || '' }));
}

async function searchSerper(apiKey: string, query: string, count = 6): Promise<ResearchSource[]> {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: count }),
  });
  if (!r.ok) throw new Error(`Serper ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d?.organic || []).map((item: any) => ({ title: item.title, url: item.link, snippet: item.snippet || '' }));
}

async function searchFirecrawl(apiKey: string, query: string, count = 6): Promise<ResearchSource[]> {
  const r = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: count }),
  });
  if (!r.ok) throw new Error(`Firecrawl ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d?.data || []).map((item: any) => ({ title: item.title || item.metadata?.title || item.url, url: item.url, snippet: item.description || item.markdown || '' }));
}

async function searchLocalViaCommand(supabase: any, query: string, count = 6): Promise<ResearchSource[]> {
  const queued = await queueLocalCommand(supabase, 'research_search', { query, count });
  if (!queued.ok) throw new Error(typeof queued.result === 'string' ? queued.result : 'Local research worker failed');
  const normalizedResult = Array.isArray(queued.result?.results)
    ? queued.result.results
    : Array.isArray(queued.result?.result?.results)
      ? queued.result.result.results
      : [];
  const result = normalizedResult;
  return (Array.isArray(result) ? result : []).map((item: any) => ({
    title: item.title || item.url || 'Untitled result',
    url: item.url,
    snippet: item.snippet || '',
  })).filter((item: ResearchSource) => !!item.url);
}

async function runResearchSearch(supabase: any, provider: string, apiKey: string, query: string, count = 6): Promise<{ provider: string; sources: ResearchSource[] }> {
  const chosen = inferResearchProvider(provider, apiKey);
  const order = chosen === 'local' ? ['local'] : [chosen, 'local'];
  let lastError: Error | null = null;
  const failures: string[] = [];
  for (const candidate of order) {
    try {
      let sources: ResearchSource[] = [];
      if (candidate === 'brave' && apiKey) sources = await searchBrave(apiKey, query, count);
      else if (candidate === 'tavily' && apiKey) sources = await searchTavily(apiKey, query, count);
      else if (candidate === 'serper' && apiKey) sources = await searchSerper(apiKey, query, count);
      else if (candidate === 'firecrawl' && apiKey) sources = await searchFirecrawl(apiKey, query, count);
      else if (candidate === 'local') sources = await searchLocalViaCommand(supabase, query, count);
      if (sources.length > 0) return { provider: candidate, sources };
    } catch (error) {
      lastError = error as Error;
      failures.push(`${candidate}: ${(error as Error).message}`);
    }
  }
  if (lastError) throw new Error(`Research failed after trying ${order.join(', ')}. ${failures.join(' | ')}`);
  return { provider: chosen, sources: [] };
}

function trimText(value: string, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function execResearchDeep(args: any, providers: any, lovableKey: string, supabase: any): Promise<{ ok: boolean; summary: string; data?: any }> {
  try {
    const count = args.depth === 'deep' ? 8 : args.depth === 'light' ? 4 : 6;
    const { provider, sources } = await runResearchSearch(
      supabase,
      providers.research.provider,
      providers.research.apiKey,
      args.query,
      count,
    );
    if (sources.length === 0) {
      return { ok: false, summary: 'Research returned no sources.' };
    }

    const sourceSummary = sources.slice(0, 6)
      .map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${trimText(item.snippet || '', 300)}`)
      .join('\n\n');

    const llmResp = await fetch(LOVABLE_GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lovableKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: 'You are a research assistant. Synthesize the supplied search results into a concise, useful summary with concrete facts. Do not invent facts or URLs.',
          },
          {
            role: 'user',
            content: `Research query: ${args.query}\nProvider: ${provider}\n\nSearch results:\n${sourceSummary}`,
          },
        ],
      }),
    });
    const llmData = await llmResp.json().catch(() => ({}));
    const findings = llmData?.choices?.[0]?.message?.content
      || sources.slice(0, 4).map((item) => `• ${item.title} — ${trimText(item.snippet || '', 180)}`).join('\n');

    return {
      ok: true,
      summary: `Found ${sources.length} sources via ${provider}.`,
      data: { findings, sources, provider },
    };
  } catch (e) {
    return { ok: false, summary: `Research failed: ${(e as Error).message}` };
  }
}

function inferImageProvider(provider: string, apiKey: string): string {
  if (provider && provider !== 'auto') return provider;
  // Heuristic only for auto mode. Only trust UNAMBIGUOUS prefix patterns.
  // Generic "long alphanumeric" shapes (Pexels/Unsplash) are removed because they
  // false-matched almost every modern API key — pick those explicitly in Settings.
  const key = String(apiKey || '').trim();
  if (/^xai-[A-Za-z0-9_-]{20,}$/i.test(key)) return 'xai';
  if (/^nvapi-[A-Za-z0-9_-]{20,}$/i.test(key)) return 'nvidia';
  if (/^AIza[A-Za-z0-9_-]{20,}$/.test(key)) return 'google';
  if (/^sk-(proj-)?[A-Za-z0-9_-]{20,}$/.test(key)) return 'openai';
  return 'lovable';
}

async function findUnsplashImage(key: string, query: string): Promise<{ url: string; credit: string } | null> {
  const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=squarish`, {
    headers: { Authorization: `Client-ID ${key}` },
  });
  if (!r.ok) throw new Error(`Unsplash ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const img = d?.results?.[0];
  return img ? { url: img.urls?.regular || img.urls?.full, credit: `Photo by ${img.user?.name || 'Unsplash'}` } : null;
}

async function findPexelsImage(key: string, query: string): Promise<{ url: string; credit: string } | null> {
  const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`, {
    headers: { Authorization: key },
  });
  if (!r.ok) throw new Error(`Pexels ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const img = d?.photos?.[0];
  return img ? { url: img.src?.large || img.src?.original, credit: `Photo by ${img.photographer || 'Pexels'}` } : null;
}

async function generateAIImage(provider: string, key: string, prompt: string, model: string, lovableKey: string): Promise<{ dataUrl: string | null; remoteUrl?: string | null; credit?: string | null; error?: string }> {
  try {
    if (provider === 'unsplash' && key) {
      const found = await findUnsplashImage(key, prompt);
      return { dataUrl: null, remoteUrl: found?.url || null, credit: found?.credit || null };
    }
    if (provider === 'pexels' && key) {
      const found = await findPexelsImage(key, prompt);
      return { dataUrl: null, remoteUrl: found?.url || null, credit: found?.credit || null };
    }
    if (provider === 'openai' && key) {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
      });
      if (!r.ok) return { dataUrl: null, error: `OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}` };
      const d = await r.json();
      const b64 = d?.data?.[0]?.b64_json;
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : null, remoteUrl: d?.data?.[0]?.url || null };
    }
    if (provider === 'google' && key) {
      const imageModel = model || 'gemini-2.5-flash-image';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(imageModel)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt.slice(0, 1500) }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        }),
      });
      if (!r.ok) return { dataUrl: null, error: `Google ${r.status}: ${(await r.text()).slice(0, 200)}` };
      const d = await r.json();
      const part = (d?.candidates?.[0]?.content?.parts || []).find((item: any) => item?.inlineData?.data || item?.inline_data?.data);
      const b64 = part?.inlineData?.data || part?.inline_data?.data;
      const mime = part?.inlineData?.mimeType || part?.inline_data?.mime_type || 'image/png';
      return { dataUrl: b64 ? `data:${mime};base64,${b64}` : null };
    }
    if (provider === 'nvidia' && key) {
      const r = await fetch(`https://ai.api.nvidia.com/v1/genai/${model || 'black-forest-labs/flux.1-schnell'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prompt: prompt.slice(0, 1500), width: 1024, height: 1024, samples: 1, steps: 4, cfg_scale: 3.5 }),
      });
      if (!r.ok) return { dataUrl: null, error: `NVIDIA ${r.status}: ${(await r.text()).slice(0, 200)}` };
      const d = await r.json();
      const b64 = d?.image || d?.artifacts?.[0]?.base64 || d?.data?.[0]?.b64_json;
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : null, remoteUrl: d?.data?.[0]?.url || null };
    }
    if (provider === 'xai' && key) {
      const r = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'grok-2-image-1212', prompt: prompt.slice(0, 1500), n: 1, response_format: 'b64_json' }),
      });
      if (!r.ok) return { dataUrl: null, error: `xAI ${r.status}: ${(await r.text()).slice(0, 200)}` };
      const d = await r.json();
      const b64 = d?.data?.[0]?.b64_json;
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : null, remoteUrl: d?.data?.[0]?.url || null };
    }

    const r = await fetch(LOVABLE_GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lovableKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'google/gemini-2.5-flash-image',
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image', 'text'],
      }),
    });
    if (!r.ok) return { dataUrl: null, error: `Lovable ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const d = await r.json();
    return { dataUrl: d?.choices?.[0]?.message?.images?.[0]?.image_url?.url || null };
  } catch (e) {
    return { dataUrl: null, error: (e as Error).message };
  }
}

async function uploadAgentImage(supabase: any, dataUrlOrRemoteUrl: string): Promise<{ url: string; path: string } | null> {
  try {
    if (/^https?:\/\//i.test(dataUrlOrRemoteUrl)) {
      const r = await fetch(dataUrlOrRemoteUrl);
      if (!r.ok) return null;
      const mime = r.headers.get('content-type') || 'image/jpeg';
      const ext = mime.split('/')[1]?.split(';')[0] || 'jpg';
      const bytes = new Uint8Array(await r.arrayBuffer());
      const path = `agent/${Date.now()}-${crypto.randomUUID().slice(0, 6)}.${ext}`;
      const { error } = await supabase.storage.from('social-media').upload(path, bytes, { contentType: mime });
      if (error) return null;
      const { data } = supabase.storage.from('social-media').getPublicUrl(path);
      return { url: data.publicUrl, path };
    }

    const match = dataUrlOrRemoteUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    if (!match) return null;
    const mime = match[1];
    const b64 = match[2];
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ext = mime.split('/')[1] || 'png';
    const path = `agent/${Date.now()}-${crypto.randomUUID().slice(0, 6)}.${ext}`;
    const { error } = await supabase.storage.from('social-media').upload(path, bytes, { contentType: mime });
    if (error) return null;
    const { data } = supabase.storage.from('social-media').getPublicUrl(path);
    return { url: data.publicUrl, path };
  } catch {
    return null;
  }
}

async function execGenerateImage(args: any, providers: any, lovableKey: string, supabase: any): Promise<{ ok: boolean; summary: string; data?: any }> {
  const configuredChain = Array.isArray(providers.image.imageKeys) ? providers.image.imageKeys : [];
  const chain = configuredChain.length > 0
    ? configuredChain.map((entry: any) => ({
      provider: inferImageProvider(entry.provider || 'auto', entry.apiKey || ''),
      apiKey: entry.apiKey || '',
      model: entry.model || '',
      label: entry.label || '',
    }))
    : [{
      provider: inferImageProvider(providers.image.provider, providers.image.apiKey),
      apiKey: providers.image.apiKey || '',
      model: providers.image.model || '',
      label: providers.image.provider || 'primary',
    }];

  if (!chain.some((entry: any) => entry.provider === 'lovable')) {
    chain.push({ provider: 'lovable', apiKey: '', model: 'google/gemini-2.5-flash-image', label: 'lovable fallback' });
  }

  for (const entry of chain) {
    const generated = await generateAIImage(entry.provider, entry.apiKey || '', args.prompt, entry.model || '', lovableKey);
    const source = generated.dataUrl || generated.remoteUrl || '';
    if (!source) continue;
    const uploaded = await uploadAgentImage(supabase, source);
    if (!uploaded) continue;
    return {
      ok: true,
      summary: `Image generated via ${entry.provider}.`,
      data: { url: uploaded.url, path: uploaded.path, prompt: args.prompt, provider: entry.provider, credit: generated.credit || null },
    };
  }

  return { ok: false, summary: 'Image generation failed for every configured provider.' };
}

/* ── Wait helper for local-side tools (poll pending_commands) ────────── */

async function waitForLocalCommand(supabase: any, commandId: string, timeoutMs = 90_000): Promise<{ ok: boolean; result: any }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const { data } = await supabase.from('pending_commands').select('status,result').eq('id', commandId).single();
    if (!data) continue;
    if (data.status === 'completed' || data.status === 'failed') {
      let parsed: any = data.result;
      try { parsed = JSON.parse(data.result); } catch { /* keep string */ }
      return { ok: data.status === 'completed', result: parsed };
    }
  }
  return { ok: false, result: 'Local worker timed out (is your local server running?)' };
}

async function queueLocalCommand(supabase: any, command: string, args: any): Promise<{ ok: boolean; result: any }> {
  const { data, error } = await supabase
    .from('pending_commands')
    .insert({ command, args, status: 'pending' })
    .select('id')
    .single();
  if (error) return { ok: false, result: `Could not queue: ${error.message}` };
  return await waitForLocalCommand(supabase, data.id);
}

/**
 * Preflight: detect whether the local worker is alive by inspecting recent
 * pending_commands activity. The cloud edge function cannot reach localhost
 * directly, so we infer health from the queue being drained. Returns a
 * human-readable warning string when the worker appears offline.
 */
async function checkLocalWorkerHealth(supabase: any): Promise<{ alive: boolean; lastSeenAt: string | null; note: string }> {
  // 1) Any command completed in the last 90 seconds → worker is alive.
  const ninetySecAgo = new Date(Date.now() - 90_000).toISOString();
  const { data: recent } = await supabase
    .from('pending_commands')
    .select('completed_at')
    .gte('completed_at', ninetySecAgo)
    .order('completed_at', { ascending: false })
    .limit(1);
  if (recent && recent.length > 0) {
    return { alive: true, lastSeenAt: recent[0].completed_at, note: 'Local worker is responding.' };
  }
  // 2) Otherwise look at last-ever completion to give a useful timestamp.
  const { data: lastEver } = await supabase
    .from('pending_commands')
    .select('completed_at')
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(1);
  const lastSeen = lastEver?.[0]?.completed_at || null;
  return {
    alive: false,
    lastSeenAt: lastSeen,
    note: lastSeen
      ? `Local worker last active ${lastSeen}. It may be offline — start smart-launcher.bat.`
      : 'Local worker has never connected. Start smart-launcher.bat on your PC.',
  };
}

function validatePlannedToolCall(hasPlan: boolean, callIndex: number, name: string): string | null {
  if (!hasPlan && name !== 'plan') {
    return 'You must call plan first before any other tool. Re-issue your next response as a single plan tool call.';
  }
  if (callIndex > 0 && name !== 'plan') {
    return 'Only one non-plan tool call is allowed per turn. Wait for this result, then decide the next tool.';
  }
  return null;
}

/* ── Main agent loop ─────────────────────────────────────────────────── */

async function runAgent(supabase: any, runId: string, lovableKey: string, telegramKey: string | null) {
  const run = await getRun(supabase, runId);
  if (!run) return;
  const providers = await getProviderMap(supabase);
  const workspaceSlug = slugify(run.prompt);
  const multiAgentEnabled = providers.taskMode === 'multi-agent';
  const relevantMemories = providers.memoryEnabled ? await loadRelevantMemories(supabase, run.prompt, providers.memoryMaxItems) : [];

  await setStatus(supabase, runId, {
    task_mode: providers.taskMode,
    automation_mode: providers.automationMode,
    memory_snapshot: relevantMemories.map((memory: any) => ({
      id: memory.id,
      title: memory.title,
      memory_type: memory.memory_type,
      tags: memory.tags || [],
    })),
  });
  if (relevantMemories.length > 0) {
    await appendEvent(supabase, runId, {
      type: 'memory_context',
      count: relevantMemories.length,
      titles: relevantMemories.map((memory: any) => memory.title),
    });
  }

  // Preflight: local-worker health (cloud edge function can't reach localhost,
  // so we infer health from pending_commands queue activity). Surface a clear
  // event up front so users immediately see "worker offline" instead of waiting
  // 90s for the first shell/file/browser tool to time out.
  const localHealth = await checkLocalWorkerHealth(supabase);
  await appendEvent(supabase, runId, {
    type: localHealth.alive ? 'preflight_ok' : 'preflight_warning',
    component: 'local_worker',
    alive: localHealth.alive,
    last_seen_at: localHealth.lastSeenAt,
    message: localHealth.note,
  });

  const systemPrompt = `You are an elite autonomous local-PC agent inspired by Claude Code, OpenClaw, and Hermes.

# Your environment
- Workspace folder on the user's local Windows PC (slug: "${workspaceSlug}")${providers.workspaceRoot ? ` rooted at "${providers.workspaceRoot}"` : ''}.
- Tools to: research the web, generate images, read/write/list files in the workspace, run allowlisted shell commands (${providers.shellEnabled ? 'ENABLED' : 'DISABLED — do not call run_shell'}), open URLs/files in the user's default browser, start a static preview server, and run deep browser automation tasks on the PC.
- Configured providers: chat=${providers.chat.provider}/${providers.chat.model}, research=${providers.research.provider}, image=${providers.image.provider}.
- Local machine capabilities available through tools: Node.js, npm/npx, Python, git, browser sessions, workspace files, and local previews.
- Runtime modes: task_mode=${providers.taskMode}, automation_mode=${providers.automationMode}, persistent_memory=${providers.memoryEnabled ? `enabled (${providers.memoryMaxItems} recalled)` : 'disabled'}.

# Core operating rules (MUST follow)
1. FIRST response MUST be a single \`plan\` tool call with 3-7 concise steps. No other tool calls in that first response.
2. After planning, use at most ONE non-\`plan\` tool call per assistant turn. Observe the result before choosing the next action.
3. Think like a senior operator: inspect, verify, act, check results, then continue.
4. Prefer reading/listing existing files before rewriting them when the task touches an existing project.
5. Use \`research_deep\` for time-sensitive facts and \`browser_task\` when the task needs a real browser session, website parsing, scraping, or interactive navigation.
6. For "build me an app/page/tool" requests: create or inspect files, write production-ready code, run shell commands when needed, then \`serve_preview\` and \`open_in_browser\`.
7. For local coding/data automation, use Node.js or Python via \`run_shell\` when that is the most reliable path.
8. Do not stop early. Continue until the task is actually complete, blocked by disabled permissions, or you have a concrete artifact to hand off.
9. ALWAYS end with \`finish\` including a short summary and useful artifacts (files, URLs, previews, images).
10. When you learn a durable fact or stable workflow, call \`remember_fact\`.
11. When a saved skill can solve part of the task, call \`chain_skill\` to reuse it as a subtask.
12. After discovering a better repeatable workflow, call \`improve_skill\` and/or \`save_skill\`.

# Quality bar
- Output is shown live to the user step-by-step. Be concise in tool args.
- For HTML apps: include Tailwind via CDN, proper meta tags, responsive layout.
- Image prompts: be specific about style, lighting, composition.
- When using shell tools, prefer deterministic commands and verify outputs.
- If shell access is disabled, adapt with file writes, previews, browser tools, and research rather than failing immediately.
- In safe automation mode, keep browser automation read-only: research, parse, inspect, extract, summarize, compare, and draft. Do not execute trades, purchases, payments, or account-changing actions.

# Task styles to emulate
- Claude-Code style: inspect workspace, plan, edit carefully, run validation, summarize artifacts.
- OpenClaw/Hermes style: chain research, browser work, file generation, and reusable skill extraction for complex multi-step workflows.
- For broad automation ideas like website parsing, ad research, or market-data tooling, build reusable local scripts/workflows — do not place trades or take irreversible external actions on the user's behalf unless the user explicitly asks and the tool exists.
- In multi-agent mode, separate responsibilities mentally: Planner designs the approach, Executor performs tools, Reviewer critiques results and suggests course corrections.

User request: ${run.prompt}`;

  // Extra scaffolding for smaller / local models (Qwen3, Gemma, GLM, Mistral,
  // Llama 3.x running through LM Studio). They benefit from very explicit,
  // example-driven instructions and stricter format reminders, otherwise they
  // tend to produce free-form prose instead of tool calls.
  const isLocalOrSmallModel =
    providers.chat.provider === 'lmstudio' ||
    /qwen|gemma|glm|mistral|llama-?3|phi-?3/i.test(providers.chat.model || '');
  const smallModelGuide = isLocalOrSmallModel ? `

# Small / local model protocol (Qwen / Gemma / GLM / Llama)
You are running on a smaller local model. Follow these strict rules so you stay reliable:
- ALWAYS respond with a tool call. Never reply with prose only — wrap every action inside one of the available tools.
- ONE tool call per turn. Wait for the result, then issue the next one.
- Keep tool arguments minimal and concrete. No long explanations inside arguments.
- For research tasks: \`plan\` → \`research_deep\` (1-3 focused queries) → \`write_file\` (save findings as markdown) → \`finish\`.
- For build tasks: \`plan\` → \`write_file\` (one file at a time) → \`serve_preview\` → \`open_in_browser\` → \`finish\`.
- For local-PC automation: \`plan\` → \`run_shell\` (single command) → observe → next \`run_shell\` → \`finish\`.
- For browser automation: \`plan\` → \`browser_task\` with a clear task string → \`finish\`.
- If you don't know something, use \`research_deep\` instead of guessing.
- If a tool fails twice in a row with the same error, switch strategy (different tool or simpler approach) instead of retrying identically.
- ALWAYS finish with the \`finish\` tool. Don't trail off.
` : '';

  // Find matching skills (simple keyword overlap on triggers + name)
  const promptLow = run.prompt.toLowerCase();
  const { data: allSkills } = await supabase.from('agent_skills').select('*').eq('enabled', true);
  const matched = (allSkills || []).filter((sk: any) => {
    const trigs = [sk.name, ...(sk.triggers || [])].filter(Boolean).map((t: string) => t.toLowerCase());
    return trigs.some((t: string) => t && promptLow.includes(t));
  }).slice(0, 3);

  let skillContext = '';
  if (matched.length > 0) {
    skillContext = `\n\n# Relevant saved skills (use them if applicable)
${matched.map((sk: any, i: number) => `## Skill ${i + 1}: ${sk.name}
Description: ${sk.description}
${sk.system_prompt ? `Instructions: ${sk.system_prompt}\n` : ''}Steps:
${(sk.steps || []).map((s: any, j: number) => `  ${j + 1}. ${s.note || s.tool}`).join('\n')}`).join('\n\n')}`;
    // Mark first match as the primary skill
    await setStatus(supabase, runId, { skill_id: matched[0].id });
    await appendEvent(supabase, runId, { type: 'skill_matched', name: matched[0].name, id: matched[0].id });
  }

  const memoryContext = relevantMemories.length > 0
    ? `\n\n# Relevant persistent memory\n${relevantMemories.map((memory: any, index: number) => `## Memory ${index + 1}: ${memory.title}\nType: ${memory.memory_type}\nTags: ${(memory.tags || []).join(', ') || 'none'}\n${memory.content}`).join('\n\n')}`
    : '';

  const systemPromptFull = systemPrompt + smallModelGuide + skillContext + memoryContext + `\n\n# Skills system
You can also call \`save_skill\` after a successful novel routine — it proposes saving the workflow so the user can approve and reuse it later. Only propose when the task is genuinely repeatable.`;

  const messages: any[] = [
    { role: 'system', content: systemPromptFull },
    { role: 'user', content: run.prompt },
  ];
  let hasPlan = false;
  if (multiAgentEnabled) {
    await appendEvent(supabase, runId, { type: 'phase', name: 'planner' });
  }

  let telegramMsgId: number | null = run.telegram_status_message_id ?? null;
  const updateTelegram = async () => {
    if (!run.telegram_chat_id || !telegramKey) return;
    const fresh = await getRun(supabase, runId);
    if (!fresh) return;
    const txt = renderTelegramStatus(fresh.prompt, fresh.events || [], fresh.status);
    if (telegramMsgId) {
      await tgEdit(run.telegram_chat_id, telegramMsgId, txt, lovableKey, telegramKey);
    } else {
      telegramMsgId = await tgSend(run.telegram_chat_id, txt, lovableKey, telegramKey);
      if (telegramMsgId) await setStatus(supabase, runId, { telegram_status_message_id: telegramMsgId });
    }
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Cancellation check
      const live = await getRun(supabase, runId);
      if (live?.status === 'cancelled') {
        await appendEvent(supabase, runId, { type: 'cancelled' });
        await updateTelegram();
        return;
      }

      const data = await callPlanner(messages, providers.chat, lovableKey);
      const choice = data?.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        await appendEvent(supabase, runId, { type: 'error', message: 'Empty response from planner.' });
        break;
      }
      messages.push(msg);

      if (msg.content && msg.content.trim()) {
        await appendEvent(supabase, runId, { type: 'thought', text: msg.content.slice(0, 600) });
      }

      const calls = msg.tool_calls || [];
      if (calls.length === 0) {
        // No tool calls and no finish — wrap up
        await appendEvent(supabase, runId, { type: 'finish', summary: msg.content || 'Done.' });
        await setStatus(supabase, runId, { status: 'completed', completed_at: new Date().toISOString() });
        await updateTelegram();
        return;
      }

      let finished = false;
      for (let callIndex = 0; callIndex < calls.length; callIndex++) {
        const tc = calls[callIndex];
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* */ }
        const name = tc.function.name;

        await appendEvent(supabase, runId, {
          type: 'tool_call',
          name,
          label: name === 'plan' ? `${(args.steps || []).length} steps`
            : name === 'research_deep' ? args.query?.slice(0, 80)
            : name === 'generate_image' ? args.prompt?.slice(0, 80)
            : name === 'write_file' ? args.path
            : name === 'read_file' ? args.path
            : name === 'run_shell' ? args.command?.slice(0, 80)
            : name === 'open_in_browser' ? args.target
            : name === 'serve_preview' ? 'workspace'
            : name === 'browser_task' ? args.task?.slice(0, 80)
            : name === 'remember_fact' ? args.title
            : name === 'chain_skill' ? args.query
            : name === 'improve_skill' ? args.query
            : name === 'save_skill' ? args.name
            : name === 'finish' ? 'summary'
            : '',
        });
        await updateTelegram();

        let toolResultText = '';
        let toolResultData: any = null;
        let ok = true;

        const plannerViolation = validatePlannedToolCall(hasPlan, callIndex, name);
        if (plannerViolation) {
          ok = false;
          toolResultText = plannerViolation;
        } else if (name === 'plan') {
          if (multiAgentEnabled) {
            await appendEvent(supabase, runId, { type: 'phase', name: 'executor' });
          }
          hasPlan = Array.isArray(args.steps) && args.steps.length > 0;
          await appendEvent(supabase, runId, { type: 'plan', steps: args.steps || [] });
          toolResultText = `Plan recorded: ${(args.steps || []).length} steps.`;
        } else if (name === 'research_deep') {
          const r = await execResearchDeep(args, providers, lovableKey, supabase);
          ok = r.ok;
          toolResultText = ok ? r.data?.findings || r.summary : r.summary;
          toolResultData = r.data;
        } else if (name === 'generate_image') {
          const r = await execGenerateImage(args, providers, lovableKey, supabase);
          ok = r.ok;
          toolResultText = ok ? `Image URL: ${r.data.url}` : r.summary;
          toolResultData = r.data;
        } else if (name === 'write_file' || name === 'read_file' || name === 'list_files' || name === 'run_shell' || name === 'open_in_browser' || name === 'serve_preview') {
          if (name === 'run_shell' && !providers.shellEnabled) {
            ok = false;
            toolResultText = 'Shell access is disabled in Settings → Agent Workspace. Ask the user to enable it.';
          } else {
            const r = await queueLocalCommand(supabase, `agent_${name}`, {
              ...args,
              runId,
              projectSlug: workspaceSlug,
              workspaceRoot: providers.workspaceRoot || '',
            });
            ok = r.ok;
            toolResultText = typeof r.result === 'string' ? r.result : JSON.stringify(r.result).slice(0, 1500);
            toolResultData = typeof r.result === 'object' ? r.result : null;
          }
        } else if (name === 'browser_task') {
          const blockReason = getAutomationBlockReason(providers.automationMode, name, args);
          if (blockReason) {
            ok = false;
            toolResultText = blockReason;
          } else {
            const r = await queueLocalCommand(supabase, 'open_browser', {
              task: args.task,
              url: args.url || null,
              silent: true,
            });
            ok = r.ok;
            toolResultText = typeof r.result === 'string' ? r.result : JSON.stringify(r.result).slice(0, 1500);
            toolResultData = typeof r.result === 'object' ? r.result : null;
          }
        } else if (name === 'remember_fact') {
          if (!providers.memoryEnabled) {
            ok = false;
            toolResultText = 'Persistent memory is disabled in Settings → Research & Image Agent.';
          } else {
            const r = await rememberFact(supabase, runId, args);
            ok = r.ok;
            toolResultText = r.summary;
            toolResultData = r.data || null;
            if (ok) await appendEvent(supabase, runId, { type: 'memory_saved', title: args.title });
          }
        } else if (name === 'chain_skill') {
          const r = await chainSkill(supabase, args);
          ok = r.ok;
          toolResultText = ok && r.data
            ? `Loaded skill "${r.data.name}".\nDescription: ${r.data.description || 'n/a'}\nSteps:\n${(r.data.steps || []).map((step: any, index: number) => `${index + 1}. ${step.note || step.tool || JSON.stringify(step)}`).join('\n')}\n\nInstructions:\n${r.data.system_prompt || ''}`.slice(0, 6000)
            : r.summary;
          toolResultData = r.data || null;
          if (ok && r.data) await appendEvent(supabase, runId, { type: 'skill_chained', name: r.data.name, id: r.data.id });
        } else if (name === 'improve_skill') {
          const r = await improveSkill(supabase, args);
          ok = r.ok;
          toolResultText = r.summary;
          toolResultData = r.data || null;
          if (ok && r.data) await appendEvent(supabase, runId, { type: 'skill_improved', name: r.data.name, id: r.data.id });
        } else if (name === 'save_skill') {
          await setStatus(supabase, runId, {
            pending_skill: {
              name: args.name,
              description: args.description,
              triggers: args.triggers || [],
              steps: args.steps || [],
              system_prompt: args.system_prompt || '',
              tags: args.tags || [],
            },
          });
          await appendEvent(supabase, runId, { type: 'skill_proposed', name: args.name });
          toolResultText = `Skill "${args.name}" proposed. The user can approve it from the Skills page to reuse it later.`;
        } else if (name === 'finish') {
          await appendEvent(supabase, runId, { type: 'finish', summary: args.summary || 'Done.', artifacts: args.artifacts || [] });
          await setStatus(supabase, runId, {
            status: 'completed',
            completed_at: new Date().toISOString(),
            result: { summary: args.summary, artifacts: args.artifacts || [] },
          });
          finished = true;
          toolResultText = 'finished';
        } else {
          ok = false;
          toolResultText = `Unknown tool: ${name}`;
        }

        await appendEvent(supabase, runId, {
          type: 'tool_result',
          name,
          ok,
          summary: toolResultText.slice(0, 200),
          data: toolResultData,
        });
        await updateTelegram();

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResultText.slice(0, 6000),
        });

        if (multiAgentEnabled && name !== 'plan' && name !== 'finish') {
          try {
            await appendEvent(supabase, runId, { type: 'phase', name: 'reviewer' });
            const reviewText = await callReviewer([
              {
                role: 'system',
                content: 'You are the Reviewer agent in a planner/executor/reviewer workflow. Briefly assess the latest executor step. Reply in 2-4 short bullet-style lines covering: what happened, any risk, next best step, and whether memory or skill improvement should be stored.',
              },
              {
                role: 'user',
                content: `User request: ${run.prompt}\nTool: ${name}\nSuccess: ${ok}\nResult summary: ${toolResultText.slice(0, 1200)}`,
              },
            ], providers.chat, lovableKey);
            if (reviewText.trim()) {
              await appendEvent(supabase, runId, { type: 'review', text: reviewText.slice(0, 600) });
              messages.push({ role: 'system', content: `Reviewer notes:\n${reviewText.slice(0, 600)}` });
              await appendEvent(supabase, runId, { type: 'phase', name: 'executor' });
              await updateTelegram();
            }
          } catch (reviewError) {
            console.warn('Reviewer step failed:', reviewError);
          }
        }
      }

      if (finished) {
        await updateTelegram();
        return;
      }
    }

    // Max steps reached
    await appendEvent(supabase, runId, { type: 'error', message: `Reached max ${MAX_STEPS} steps.` });
    await setStatus(supabase, runId, { status: 'completed', completed_at: new Date().toISOString() });
    await updateTelegram();
  } catch (e) {
    console.error('Agent loop crashed:', e);
    await appendEvent(supabase, runId, { type: 'error', message: (e as Error).message });
    await setStatus(supabase, runId, { status: 'failed', error: (e as Error).message, completed_at: new Date().toISOString() });
    await updateTelegram();
  }
}

/* ── HTTP entry ──────────────────────────────────────────────────────── */

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');
    const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY') || null;
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();

    // Cancel
    if (body.action === 'cancel' && body.runId) {
      await setStatus(supabase, body.runId, { status: 'cancelled', completed_at: new Date().toISOString() });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Wait for an existing run (used by ai-chat to block until plan emitted)
    if (body.action === 'await_plan' && body.runId) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const r = await getRun(supabase, body.runId);
        const hasPlan = (r?.events || []).some((e: any) => e.type === 'plan');
        if (hasPlan || r?.status !== 'running') {
          return new Response(JSON.stringify({ ok: true, run: r }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify({ ok: true, run: await getRun(supabase, body.runId) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { prompt, source, telegram_chat_id } = body;
    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'prompt is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const providers = await getProviderMap(supabase);
    const slug = slugify(prompt);
    const { data: row } = await insertAgentRunCompat(supabase, {
      prompt,
      status: 'running',
      events: [{ type: 'started', ts: Date.now() }],
      model: providers.chat.model,
      task_mode: providers.taskMode,
      automation_mode: providers.automationMode,
      memory_snapshot: [],
      workspace_path: slug,
      source: source || 'web',
      telegram_chat_id: telegram_chat_id || null,
    });

    // Fire-and-forget the loop so the HTTP response returns immediately
    EdgeRuntime.waitUntil(runAgent(supabase, row.id, LOVABLE_API_KEY, TELEGRAM_API_KEY));

    return new Response(JSON.stringify({ ok: true, runId: row.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('agent-run handler error:', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// EdgeRuntime is provided by Supabase
declare const EdgeRuntime: { waitUntil: (p: Promise<any>) => void };
