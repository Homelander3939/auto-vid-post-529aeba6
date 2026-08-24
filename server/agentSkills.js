const { randomUUID } = require('crypto');

const MAX_SKILL_TEXT = 60_000;
const MAX_BUNDLE_FILES = 120;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

const DEFAULT_LOCAL_AGENT_SKILLS = [
  {
    id: 'local-skill-technewslist-fallback-v1',
    name: 'TechNewsList Publisher Fallback',
    slug: 'technewslist-local-publisher-fallback',
    description: 'Audit or recover one exact morning/night TechNewsList publishing session through the separate local Plan B. It no-ops when all required proof exists and defers while the primary Codex publisher owns the shared lock.',
    source: 'built-in-local',
    triggers: ['check news publisher fallback', 'recover technewslist publishing', 'run local news fallback', 'codex credits fallback', 'missing news articles'],
    steps: [
      { tool: 'run_technewslist_fallback', description: 'Audit the requested morning/night session first.' },
      { tool: 'run_technewslist_fallback', description: 'Start guarded recovery only when the user requests recovery; the worker rechecks exact proof and the shared primary lock.' },
    ],
    system_prompt: 'Require mode=morning or mode=night. Use action=audit for checks and action=recover only when recovery is requested. This skill never modifies Codex jobs. The separate worker refuses duplicate work, preserves exact session identity, uses the local LM Studio model for missing English categories, publishes website locales, and exports the D:\\news posts bundle.',
    tags: ['local', 'technewslist', 'publisher', 'fallback', 'recovery', 'idempotent'],
    enabled: true,
    use_count: 0,
    risk_level: 'guarded-write',
    required_inputs: ['mode'],
    execution: { tool: 'run_technewslist_fallback', input_map: { mode: 'mode', action: 'action', session: 'session' } },
    local_skill_version: 1,
  },
  {
    id: 'local-skill-uploader-health-check-v1',
    name: 'Uploader Health Check',
    slug: 'uploader-health-check',
    description: 'Read the fresh local uploader state and report unhealthy queues, schedules, accounts, and workers without changing anything.',
    source: 'built-in-local',
    triggers: ['uploader health', 'check uploader', 'what is unhealthy', 'queue health'],
    steps: [{ tool: 'get_fresh_app_state', description: 'Read the current SQLite-backed application snapshot.' }],
    system_prompt: 'Inspect the fresh local application state. Report concrete problems and exact IDs. Do not change, retry, publish, or delete anything.',
    tags: ['local', 'read-only', 'health'],
    enabled: true,
    use_count: 0,
    risk_level: 'read-only',
    required_inputs: [],
    execution: { tool: 'get_fresh_app_state', input_map: {} },
    local_skill_version: 1,
  },
  {
    id: 'local-skill-browser-operator-v1',
    name: 'Human Browser Operator (Vision)',
    slug: 'local-browser-operator',
    description: 'Operate simple or complex websites in visible local Chromium with a deterministic task contract: code tracks milestones, ranks a compact grounded DOM, resolves E#/L# references, verifies evidence and state changes, and lets the local vision model choose only one next action.',
    source: 'built-in-local',
    triggers: ['use local browser', 'open local browser', 'browse this website', 'inspect this page', 'browser task', 'visible browser', 'go to website', 'visit website', 'click on site', 'fill this form', 'download from website', 'screenshot this url'],
    steps: [
      { tool: 'run_local_browser', description: 'Open the persistent headful Chromium profile and record the starting page.' },
      { tool: 'run_local_browser', description: 'For every step, capture a screenshot plus DOM controls, call one native browser_action tool, execute it, and verify the page changed.' },
      { tool: 'run_local_browser', description: 'Use exact discovered hrefs and page landmarks, retain verified evidence across pages, and recover from stale selectors, popups, redirects, new tabs, lazy content, and filled fields.' },
      { tool: 'run_local_browser', description: 'Verify every requested sub-goal and return exact public facts without placeholders before completion.' },
    ],
    system_prompt: 'Require an exact web goal and use run_local_browser. Never replace browser execution with instructions or a text-only answer. The framework compiles the request into code-owned milestones and required evidence, ranks a compact grounded page view, gives the model only fresh E#/L# targets, executes one browser action, and verifies the result before continuing. Preserve login state, use exact discovered hrefs, handle popups/new tabs/lazy content, and change strategy after a stalled action. Report only observed exact results and never output placeholders such as [account]. Pause for human verification, payments, transfers, purchases, or account-security changes.',
    tags: ['local', 'browser', 'chromium', 'vision', 'tool-calling', 'agentic', 'persistent-profile'],
    enabled: true,
    use_count: 0,
    risk_level: 'guided',
    required_inputs: ['task'],
    execution: { tool: 'run_local_browser', input_map: { task: 'task', url: 'url' } },
    local_skill_version: 4,
  },
  {
    id: 'local-skill-retry-partial-video-v1',
    name: 'Retry Partial Video Upload',
    slug: 'retry-partial-video-upload',
    description: 'Retry only the failed platforms for one existing partial or failed video job while preserving successful platform results.',
    source: 'built-in-local',
    triggers: ['retry video upload', 'retry failed video platforms', 'resume partial video'],
    steps: [{ tool: 'retry_failed_job', description: 'Retry only failed platforms for the exact existing job ID.' }],
    system_prompt: 'Require an exact job_id. Preserve platforms that already succeeded and never create a duplicate job.',
    tags: ['local', 'video', 'recovery'],
    enabled: true,
    use_count: 0,
    risk_level: 'guarded-write',
    required_inputs: ['job_id'],
    execution: { tool: 'retry_failed_job', input_map: { job_id: 'job_id' } },
    local_skill_version: 1,
  },
  {
    id: 'local-skill-retry-partial-social-v1',
    name: 'Retry Partial Social Post',
    slug: 'retry-partial-social-post',
    description: 'Retry only failed X, LinkedIn, or Facebook platforms for one existing social-post row.',
    source: 'built-in-local',
    triggers: ['retry social post', 'retry failed social platforms', 'resume partial social post'],
    steps: [{ tool: 'retry_social_post', description: 'Retry only failed platforms for the exact existing post ID.' }],
    system_prompt: 'Require an exact post_id. Preserve confirmed platform links and never repost a platform that already succeeded.',
    tags: ['local', 'social', 'recovery'],
    enabled: true,
    use_count: 0,
    risk_level: 'guarded-write',
    required_inputs: ['post_id'],
    execution: { tool: 'retry_social_post', input_map: { post_id: 'post_id' } },
    local_skill_version: 1,
  },
  {
    id: 'local-skill-run-video-schedule-v1',
    name: 'Run Video Schedule Now',
    slug: 'run-video-schedule-now',
    description: 'Run one existing recurring video schedule by exact ID through the normal idempotent scheduler path.',
    source: 'built-in-local',
    triggers: ['run video schedule', 'start upload schedule', 'run recurring upload'],
    steps: [{ tool: 'run_recurring_schedule_now', description: 'Run the exact recurring video schedule through the existing scheduler.' }],
    system_prompt: 'Require an exact schedule_id. Use the existing schedule and its account selections; do not invent or edit settings.',
    tags: ['local', 'video', 'schedule'],
    enabled: true,
    use_count: 0,
    risk_level: 'guarded-write',
    required_inputs: ['schedule_id'],
    execution: { tool: 'run_recurring_schedule_now', input_map: { schedule_id: 'schedule_id' } },
    local_skill_version: 1,
  },
  {
    id: 'local-skill-run-social-campaign-v1',
    name: 'Run Social Campaign Now',
    slug: 'run-social-campaign-now',
    description: 'Run one existing social campaign by exact ID through its normal local folder or AI schedule path.',
    source: 'built-in-local',
    triggers: ['run social campaign', 'start social schedule', 'run post campaign'],
    steps: [{ tool: 'run_social_schedule_now', description: 'Run the exact existing social campaign.' }],
    system_prompt: 'Require an exact schedule_id. Preserve the configured folder filter, targets, and account selections.',
    tags: ['local', 'social', 'schedule'],
    enabled: true,
    use_count: 0,
    risk_level: 'guarded-write',
    required_inputs: ['schedule_id'],
    execution: { tool: 'run_social_schedule_now', input_map: { schedule_id: 'schedule_id' } },
    local_skill_version: 1,
  },
];

const DEFAULT_LOCAL_AGENT_MEMORIES = [
  {
    id: 'local-memory-skill-method-v1',
    title: 'skill-method',
    content: 'For every non-trivial task, inspect the enabled saved skills in the fresh local snapshot and reuse the closest matching skill. Built-in skills with an execution tool perform real actions. Imported skills provide reusable method and context, but must be mapped to an allowed application tool before claiming execution. Use Human Browser Operator for interactive websites, exact IDs for schedules/jobs/posts, and verify the final state before reporting success.',
    memory_type: 'workflow',
    tags: ['skills', 'agentic', 'tool-use', 'verification'],
    importance: 10,
    enabled: true,
    local_memory_version: 1,
  },
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [value];
}

function slugify(value) {
  return String(value || 'local-skill')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'local-skill';
}

function normalizeSteps(value) {
  return asArray(value).map((step) => {
    if (step && typeof step === 'object') {
      return {
        note: step.note ? String(step.note).slice(0, 1000) : undefined,
        tool: step.tool ? String(step.tool).slice(0, 100) : undefined,
        description: step.description ? String(step.description).slice(0, 1000) : undefined,
        task: step.task ? String(step.task).slice(0, 1000) : undefined,
        command: step.command ? String(step.command).slice(0, 1000) : undefined,
      };
    }
    return { note: String(step).slice(0, 1000) };
  });
}

function normalizeAgentSkillRecord(row = {}) {
  const name = String(row.name || row.title || row.slug || 'Untitled local skill').slice(0, 160);
  return {
    ...row,
    id: String(row.id || randomUUID()),
    name,
    slug: slugify(row.slug || name),
    description: String(row.description || '').slice(0, 2000),
    source: String(row.source || 'manual').slice(0, 80),
    source_url: row.source_url ? String(row.source_url).slice(0, 2000) : null,
    triggers: asArray(row.triggers).map((item) => String(item).slice(0, 160)).filter(Boolean),
    steps: normalizeSteps(row.steps),
    system_prompt: String(row.system_prompt || row.instructions || row.content || '').slice(0, MAX_SKILL_TEXT),
    tags: asArray(row.tags).map((item) => String(item).slice(0, 80)).filter(Boolean),
    enabled: row.enabled !== false,
    use_count: Number(row.use_count || 0),
    last_used_at: row.last_used_at || null,
    risk_level: ['read-only', 'guarded-write'].includes(row.risk_level) ? row.risk_level : 'guided',
    required_inputs: asArray(row.required_inputs).map((item) => String(item)).filter(Boolean),
    execution: row.execution && typeof row.execution === 'object' ? row.execution : null,
  };
}

async function seedDefaultAgentSkills(supabase) {
  const installed = [];
  for (const raw of DEFAULT_LOCAL_AGENT_SKILLS) {
    const skill = normalizeAgentSkillRecord(raw);
    const { data: existing } = await supabase.from('agent_skills').select('*').eq('slug', skill.slug).maybeSingle();
    if (existing?.id) {
      const existingVersion = Number(existing.local_skill_version || 0);
      const incomingVersion = Number(skill.local_skill_version || 0);
      if (String(existing.source || '').startsWith('built-in') && incomingVersion > existingVersion) {
        const { data, error } = await supabase.from('agent_skills').update({
          name: skill.name,
          description: skill.description,
          source: skill.source,
          triggers: skill.triggers,
          steps: skill.steps,
          system_prompt: skill.system_prompt,
          tags: skill.tags,
          risk_level: skill.risk_level,
          required_inputs: skill.required_inputs,
          execution: skill.execution,
          local_skill_version: incomingVersion,
        }).eq('id', existing.id).select('*').single();
        if (error) throw new Error(error.message || String(error));
        installed.push(data);
      }
      continue;
    }
    const { data, error } = await supabase.from('agent_skills').insert(skill).select('*').single();
    if (error) throw new Error(error.message || String(error));
    installed.push(data);
  }
  return installed;
}

async function seedDefaultAgentMemories(supabase) {
  const installed = [];
  for (const memory of DEFAULT_LOCAL_AGENT_MEMORIES) {
    const { data: existing } = await supabase.from('agent_memories').select('*').eq('id', memory.id).maybeSingle();
    const existingVersion = Number(existing?.local_memory_version || 0);
    if (existing?.id && existingVersion >= Number(memory.local_memory_version || 0)) continue;
    const query = existing?.id
      ? supabase.from('agent_memories').update(memory).eq('id', memory.id)
      : supabase.from('agent_memories').insert(memory);
    const { data, error } = await query.select('*').single();
    if (error) throw new Error(error.message || String(error));
    installed.push(data);
  }
  return installed;
}

async function getAgentSkill(supabase, { skillId, skillSlug } = {}) {
  let query = supabase.from('agent_skills').select('*');
  if (skillId) query = query.eq('id', skillId);
  else if (skillSlug) query = query.eq('slug', slugify(skillSlug));
  else return null;
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message || String(error));
  return data ? normalizeAgentSkillRecord(data) : null;
}

function scoreSkill(skill, text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return 0;
  let score = haystack.includes(skill.slug) ? 20 : 0;
  if (haystack.includes(skill.name.toLowerCase())) score += 20;
  for (const trigger of skill.triggers) if (trigger && haystack.includes(trigger.toLowerCase())) score += 10;
  const words = `${skill.name} ${skill.description}`.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
  score += words.filter((word) => haystack.includes(word)).length;
  return score;
}

async function findMatchingAgentSkill(supabase, text) {
  const { data, error } = await supabase.from('agent_skills').select('*').eq('enabled', true).limit(100);
  if (error) throw new Error(error.message || String(error));
  const ranked = (data || []).map(normalizeAgentSkillRecord).map((skill) => ({ skill, score: scoreSkill(skill, text) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 10 ? ranked[0].skill : null;
}

function extractFrontmatter(text) {
  const value = String(text || '').slice(0, MAX_SKILL_TEXT);
  const match = value.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return { meta: {}, body: value };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    let val = line.slice(separator + 1).trim();
    const wrappingQuote = val.match(/^(['"])([\s\S]*)\1$/);
    if (wrappingQuote) val = wrappingQuote[2];
    if (/^\[.*\]$/.test(val)) val = val.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
    meta[key] = val;
  }
  return { meta, body: value.slice(match[0].length) };
}

function parseTextSkill(pathName, content, sourceName) {
  const { meta, body } = extractFrontmatter(content);
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fallbackName = String(pathName || sourceName || 'Imported skill').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  const name = meta.name || meta.title || heading || fallbackName;
  const description = meta.description || body.replace(/^#.*$/m, '').trim().split(/\r?\n\r?\n/)[0]?.slice(0, 1000) || '';
  const describedTriggers = String(description).match(/triggers?\s+on\s*:\s*(.+)$/i)?.[1]
    ?.match(/["“]([^"”]+)["”]/g)
    ?.map((item) => item.replace(/^["“]|["”]$/g, '').trim())
    .filter(Boolean) || [];
  const stepLines = body.split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean)
    .slice(0, 30);
  return normalizeAgentSkillRecord({
    name,
    slug: meta.slug || name,
    description,
    source: 'imported-local',
    source_url: sourceName || null,
    triggers: meta.triggers || meta.trigger || describedTriggers,
    tags: meta.tags || [],
    steps: stepLines,
    system_prompt: body,
    risk_level: 'guided',
    execution: null,
  });
}

function parseSkillFiles(files, sourceName = 'local-files') {
  const parsed = [];
  for (const file of asArray(files).slice(0, MAX_BUNDLE_FILES)) {
    const pathName = String(file?.path || file?.name || 'skill.txt');
    const content = String(file?.content || '');
    if (!content.trim()) continue;
    if (Buffer.byteLength(content, 'utf8') > MAX_BUNDLE_BYTES) throw new Error(`Skill file is too large: ${pathName}`);
    if (/\.json$/i.test(pathName)) {
      try {
        const json = JSON.parse(content);
        const rows = Array.isArray(json) ? json : Array.isArray(json.skills) ? json.skills : [json];
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          parsed.push(normalizeAgentSkillRecord({
            ...row,
            source: 'imported-local',
            source_url: sourceName,
            risk_level: 'guided',
            execution: null,
          }));
        }
        continue;
      } catch {
        // A mislabeled JSON skill is still useful as prompt text.
      }
    }
    parsed.push(parseTextSkill(pathName, content, sourceName));
  }
  return parsed.filter((skill) => skill.name && (skill.system_prompt || skill.steps.length || skill.description));
}

async function installParsedAgentSkills(supabase, rows) {
  const installed = [];
  for (const raw of rows) {
    const skill = normalizeAgentSkillRecord(raw);
    const { data: sameSlug } = await supabase.from('agent_skills').select('*').eq('slug', skill.slug).maybeSingle();
    if (sameSlug?.id
      && skill.source === 'imported-local'
      && sameSlug.source === 'imported-local'
      && skill.source_url
      && sameSlug.source_url === skill.source_url) {
      const { data, error } = await supabase.from('agent_skills').update({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        source_url: skill.source_url,
        triggers: skill.triggers,
        steps: skill.steps,
        system_prompt: skill.system_prompt,
        tags: skill.tags,
        risk_level: skill.risk_level,
        required_inputs: skill.required_inputs,
        execution: null,
      }).eq('id', sameSlug.id).select('*').single();
      if (error) throw new Error(error.message || String(error));
      installed.push(data);
      continue;
    }
    let slug = skill.slug;
    let suffix = 2;
    while (true) {
      const { data: existing } = await supabase.from('agent_skills').select('id').eq('slug', slug).maybeSingle();
      if (!existing?.id) break;
      slug = `${skill.slug}-${suffix}`.slice(0, 70);
      suffix += 1;
    }
    const { data, error } = await supabase.from('agent_skills').insert({ ...skill, id: randomUUID(), slug }).select('*').single();
    if (error) throw new Error(error.message || String(error));
    installed.push(data);
  }
  return installed;
}

module.exports = {
  DEFAULT_LOCAL_AGENT_MEMORIES,
  DEFAULT_LOCAL_AGENT_SKILLS,
  findMatchingAgentSkill,
  getAgentSkill,
  installParsedAgentSkills,
  normalizeAgentSkillRecord,
  parseSkillFiles,
  seedDefaultAgentMemories,
  seedDefaultAgentSkills,
  __test: { asArray, extractFrontmatter, normalizeSteps, scoreSkill, slugify },
};
