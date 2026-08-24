// Deterministic orchestration helpers for the local agent.
//
// The local LLM should not have to remember application topology, choose among
// every tool, parse an unbounded DOM, and verify its own work in one inference.
// This module moves those responsibilities into code so a smaller model can
// focus on one grounded decision at a time.

const ORIGINAL_GOAL_SEPARATOR = /\n\nLOCAL VISION BROWSER RULES:/i;

const ACTION_WORDS = {
  browser: /\b(?:browse|browser|go|navigate|open|visit|check|click|fill|enter|log\s*in|login|sign\s*in|download|upload|attach|book|search|find|locate|inspect|read|extract|identify|collect|compare)\b/i,
  social: /\b(?:social|post|tweet|x\b|twitter|linkedin|facebook|campaign)\b/i,
  video: /\b(?:video|youtube|tiktok|instagram|upload job|job queue)\b/i,
  schedule: /\b(?:schedule|scheduled|recurring|cron|campaign|run\s+now)\b/i,
  status: /\b(?:status|state|health|healthy|unhealthy|queue|failure|failed|problem|working|running|latest|current)\b/i,
  research: /\b(?:research|sources?|news|latest|recent|investigate|compare|fact[- ]?check)\b/i,
};

const TOOL_GROUPS = Object.freeze({
  browser: ['run_local_browser', 'use_agent_skill'],
  news: ['run_technewslist_fallback', 'get_fresh_app_state', 'use_agent_skill'],
  research: ['get_fresh_app_state', 'use_agent_skill'],
  status: ['get_fresh_app_state', 'use_agent_skill'],
  stats: ['check_platform_stats', 'get_fresh_app_state'],
  socialGenerate: ['generate_social_post', 'get_fresh_app_state'],
  socialPublish: ['publish_social_post', 'retry_social_post', 'get_fresh_app_state'],
  socialSchedule: ['run_social_schedule_now', 'get_fresh_app_state'],
  videoCreate: ['create_upload_job', 'process_pending_uploads', 'get_fresh_app_state'],
  videoRetry: ['retry_failed_job', 'process_pending_uploads', 'get_fresh_app_state'],
  videoSchedule: ['schedule_upload', 'run_recurring_schedule_now', 'get_fresh_app_state'],
  scheduleRun: ['run_recurring_schedule_now', 'run_social_schedule_now', 'get_fresh_app_state'],
  scheduleManage: ['update_cron_schedule', 'manage_recurring_schedule', 'edit_scheduled_upload', 'get_fresh_app_state'],
  destructiveVideo: ['delete_upload_job', 'delete_scheduled_upload', 'clear_jobs_by_status', 'get_fresh_app_state'],
});

function oneLine(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function originalBrowserGoal(value) {
  return String(value || '').split(ORIGINAL_GOAL_SEPARATOR)[0].trim();
}

function latestUserText(messages = []) {
  const message = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((item) => item?.role === 'user');
  if (typeof message?.content === 'string') return message.content.trim();
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((item) => item?.type === 'text')
    .map((item) => item.text || item.content || '')
    .join('\n')
    .trim();
}

function extractRequestedUrl(text) {
  const explicit = String(text || '').match(/https?:\/\/[^\s"'<>]+/i)?.[0];
  if (explicit) return explicit.replace(/[),.;\]}]+$/g, '');
  const host = String(text || '').match(/(?<!@)\b((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i)?.[1];
  return host ? `https://${host}` : null;
}

function inferBrowserRequirements(goal) {
  const text = originalBrowserGoal(goal);
  // "send me the link/result" is a read request, not authorization to submit
  // a form or message on the visited site.
  const asksWrite = /\b(?:create|add|edit|update|submit|post|publish|apply|register|book|schedule|save)\b/i.test(text)
    || /\bsend\b(?![\s\S]{0,24}\b(?:me|us|back|the\s+(?:link|url|result|information|details?))\b)/i.test(text);
  return {
    exactLink: /\b(?:link|url)\b/i.test(text),
    publicEmail: /\b(?:e-?mail|email address)\b/i.test(text),
    publicPhone: /\b(?:phone|telephone|mobile|whatsapp)\b/i.test(text),
    contactFacts: /\bcontact\s+(?:info(?:rmation)?|details?|data)\b/i.test(text),
    download: /\bdownload|export\b/i.test(text),
    upload: /\bupload|attach\b/i.test(text),
    login: /\b(?:log\s*in|login|sign\s*in)\b/i.test(text),
    submit: asksWrite,
    comparison: /\bcompare|versus|\bvs\.?\b|difference/i.test(text),
    requestedUrl: extractRequestedUrl(text),
  };
}

function compileBrowserCompletionContract(goal) {
  const task = compileBrowserMilestones(goal);
  const checks = [
    { id: 'grounded-final-state', label: 'A fresh page observation exists before completion.' },
  ];
  if (task.requirements.download) checks.push({ id: 'download-file', label: 'The requested file exists locally and is not empty.' });
  if (task.requirements.upload) checks.push({ id: 'upload-observed', label: 'A file was attached and a later page state confirms the action.' });
  if (task.requirements.submit) checks.push({ id: 'submission-confirmed', label: 'The requested write was executed and the resulting page confirms it.' });
  if (task.requirements.login) checks.push({ id: 'authenticated-state', label: 'The final page is outside the login flow and shows an authenticated state.' });
  if (task.requirements.comparison) checks.push({ id: 'comparison-evidence', label: 'Evidence was collected from at least two distinct pages.' });
  if (task.requirements.exactLink) checks.push({ id: 'exact-link', label: 'Every returned URL is an exact live page URL or DOM href.' });
  if (task.requirements.publicEmail || task.requirements.publicPhone || task.requirements.contactFacts) {
    checks.push({ id: 'public-contact', label: 'Returned contact facts are exact values grounded in the live page.' });
  }
  return { version: 1, goal: task.goal, requirements: task.requirements, milestones: task.milestones, checks };
}

function normalizeUrlForEvidence(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function contextChanged(before = {}, after = {}) {
  if (!before || !after) return false;
  if (normalizeUrlForEvidence(before.url) !== normalizeUrlForEvidence(after.url)) return true;
  const beforeText = oneLine(before.bodyText, 2200);
  const afterText = oneLine(after.bodyText, 2200);
  return Boolean(beforeText && afterText && beforeText !== afterText);
}

function actionControlText(item = {}) {
  const context = item._groundingContext || {};
  const target = (context.interactive || []).find((element) => element?.selector && element.selector === item.selector);
  return oneLine([
    target?.text,
    target?.ariaLabel,
    target?.placeholder,
    target?.type,
    item.reason,
  ].filter(Boolean).join(' '), 600).toLowerCase();
}

function defaultFileEvidence(filePath) {
  if (!filePath) return { exists: false, size: 0 };
  try {
    // Loaded lazily so the kernel remains usable in browser-like test contexts.
    const fs = require('fs');
    const stat = fs.statSync(String(filePath));
    return { exists: stat.isFile(), size: stat.isFile() ? stat.size : 0 };
  } catch {
    return { exists: false, size: 0 };
  }
}

function verifyBrowserCompletion({ goal, action = {}, history = [], contexts = [], fileEvidence = defaultFileEvidence } = {}) {
  const contract = compileBrowserCompletionContract(goal);
  const finalContext = action._groundingContext || contexts[contexts.length - 1] || null;
  const actions = history.filter((item) => item && item.action !== 'done');
  const checks = [];
  const add = (id, passed, detail) => checks.push({
    id,
    label: contract.checks.find((item) => item.id === id)?.label || id,
    passed: Boolean(passed),
    detail: oneLine(detail, 500),
  });

  add('grounded-final-state', Boolean(finalContext?.url || finalContext?.bodyText), finalContext?.url || 'No final page observation was captured.');

  if (contract.requirements.download) {
    const downloads = actions.filter((item) => item.action === 'download' && item.ok === true && item.downloadPath);
    const verified = downloads.map((item) => ({ item, proof: fileEvidence(item.downloadPath) }))
      .find((entry) => entry.proof?.exists && Number(entry.proof?.size || 0) > 0);
    add('download-file', Boolean(verified), verified
      ? `${verified.item.downloadPath} (${verified.proof.size} bytes)`
      : 'No successful non-empty local download was verified.');
  }

  if (contract.requirements.upload) {
    const upload = [...actions].reverse().find((item) => item.action === 'upload_file' && item.ok === true);
    const observedAfter = Boolean(upload && finalContext && (upload.stateChanged === true || contextChanged(upload._groundingContext, finalContext)));
    add('upload-observed', observedAfter, observedAfter
      ? 'The file-selection action changed the page and was followed by a fresh observation.'
      : 'No successful upload with a later changed page state was observed.');
  }

  if (contract.requirements.submit) {
    const consequential = [...actions].reverse().find((item) => {
      if (item.ok !== true || !['click', 'press'].includes(item.action)) return false;
      return /\b(?:submit|send|post|publish|save|create|add|apply|register|book|schedule|update|confirm|finish)\b/i.test(actionControlText(item));
    });
    const afterChanged = Boolean(consequential && finalContext && (
      consequential.stateChanged === true
      || contextChanged(consequential._groundingContext, finalContext)
    ));
    const finalText = String(finalContext?.bodyText || '');
    const finalUrl = String(finalContext?.url || '');
    const confirmation = /\b(?:success(?:ful(?:ly)?)?|saved|created|submitted|published|scheduled|thank\s+you|completed|added|updated|confirmed)\b/i.test(finalText)
      || (consequential && normalizeUrlForEvidence(consequential._groundingContext?.url) !== normalizeUrlForEvidence(finalUrl));
    const passed = Boolean(consequential && afterChanged && confirmation);
    add('submission-confirmed', passed, passed
      ? 'A consequential control changed the page and a confirmation signal was observed.'
      : 'The requested write lacks both a grounded consequential action and a verified confirmation state.');
  }

  if (contract.requirements.login) {
    const url = String(finalContext?.url || '');
    const text = String(finalContext?.bodyText || '');
    const outsideLogin = Boolean(url) && !/\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/i.test(url);
    const authenticatedSignal = /\b(?:dashboard|account|profile|log\s*out|sign\s*out|calendar|settings)\b/i.test(text);
    add('authenticated-state', outsideLogin && authenticatedSignal, outsideLogin && authenticatedSignal
      ? `Authenticated page observed: ${url}`
      : 'The final page does not yet provide a reliable authenticated-state signal.');
  }

  if (contract.requirements.comparison) {
    const urls = new Set((contexts || []).map((context) => normalizeUrlForEvidence(context?.url)).filter(Boolean));
    add('comparison-evidence', urls.size >= 2, urls.size >= 2
      ? `Evidence observed on ${urls.size} distinct pages.`
      : 'Comparison needs evidence from at least two distinct live pages.');
  }

  const failed = checks.find((check) => !check.passed);
  return {
    allowed: !failed,
    reason: failed ? `Completion rejected: ${failed.detail}` : '',
    contract,
    checks,
  };
}

function compileBrowserMilestones(goal) {
  const text = originalBrowserGoal(goal);
  const requirements = inferBrowserRequirements(text);
  const milestones = [
    { id: 'orient', label: 'Inspect the current page and identify the relevant route or control.' },
  ];
  if (requirements.login) milestones.push({ id: 'authenticate', label: 'Reuse the saved signed-in state or complete the explicitly requested login.' });
  if (requirements.publicEmail || requirements.publicPhone || requirements.contactFacts || requirements.exactLink || /\b(?:find|locate|extract|identify|research|compare)\b/i.test(text)) {
    milestones.push({ id: 'locate-evidence', label: 'Open the most relevant live page and collect exact page-grounded evidence.' });
  }
  if (/\b(?:click|open|select|choose|fill|enter|create|add|edit|update|submit|send|post|publish|apply|register|book|schedule|upload|attach|download)\b/i.test(text)) {
    milestones.push({ id: 'act', label: 'Perform the requested interaction using grounded controls and supplied values.' });
  }
  if (requirements.comparison) milestones.push({ id: 'compare', label: 'Collect comparable evidence for every requested item.' });
  milestones.push({ id: 'verify', label: 'Verify every requested output or visible state before reporting completion.' });
  return { version: 1, goal: text, requirements, milestones };
}

function browserMilestoneProgress(contract, context = {}, history = []) {
  const successful = (type) => history.some((item) => item?.action === type && item?.ok === true);
  const changed = history.some((item) => item?.ok === true && item?.stateChanged === true);
  const hasEvidence = Boolean(
    oneLine(context.bodyText, 20)
    || (context.discoveredLinks || []).length
    || (context.interactive || []).length
  );
  const rows = contract.milestones.map((milestone) => {
    let complete = false;
    if (milestone.id === 'orient') complete = hasEvidence;
    if (milestone.id === 'authenticate') complete = successful('fill') || successful('click') || !/\/login|signin|sign-in/i.test(String(context.url || ''));
    if (milestone.id === 'locate-evidence') complete = successful('navigate') || successful('click') || history.length > 1;
    if (milestone.id === 'act') complete = changed || ['fill', 'select', 'check', 'upload_file', 'download'].some(successful);
    if (milestone.id === 'compare') complete = history.filter((item) => item?._groundingContext).length >= 2;
    if (milestone.id === 'verify') complete = successful('done');
    return { ...milestone, complete };
  });
  const current = rows.find((item) => !item.complete) || rows[rows.length - 1];
  return { rows, current };
}

function relevantTokens(value) {
  const stop = new Set(['about', 'after', 'also', 'and', 'browser', 'click', 'find', 'from', 'have', 'into', 'local', 'open', 'page', 'please', 'send', 'site', 'that', 'the', 'their', 'there', 'this', 'use', 'website', 'with', 'your']);
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [])]
    .filter((token) => !stop.has(token))
    .slice(0, 40);
}

function overlapScore(value, tokens) {
  const haystack = String(value || '').toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 4 : 0), 0);
}

function browserObservationBudget(goal = '', history = [], options = {}) {
  const contract = compileBrowserMilestones(goal);
  const recent = (Array.isArray(history) ? history : []).slice(-10);
  const failures = recent.filter((item) => item?.ok === false).length;
  const stalled = recent.filter((item) => item?.stateChanged === false).length;
  const rejected = recent.filter((item) => item?.completionRejected === true).length;
  const complex = contract.requirements.comparison
    || contract.requirements.formSubmission
    || contract.requirements.upload
    || contract.requirements.download
    || contract.milestones.length >= 5;

  let tier = complex ? 'balanced' : 'focused';
  if (failures >= 2 || stalled >= 1 || rejected >= 1) tier = 'expanded';
  if (failures >= 4 || stalled >= 2 || rejected >= 2) tier = 'recovery';

  const profiles = {
    focused: { maxElements: 24, maxLinks: 18, maxBodyChars: 2200, maxLandmarks: 14, historySteps: 8 },
    balanced: { maxElements: 34, maxLinks: 24, maxBodyChars: 3200, maxLandmarks: 20, historySteps: 10 },
    expanded: { maxElements: 44, maxLinks: 34, maxBodyChars: 4200, maxLandmarks: 28, historySteps: 14 },
    recovery: { maxElements: 48, maxLinks: 40, maxBodyChars: 4800, maxLandmarks: 32, historySteps: 16 },
  };
  const budget = { ...profiles[tier] };
  const contextLength = Number(options.contextLength || 0);
  if (contextLength > 0 && contextLength < 8192) {
    budget.maxElements = Math.min(budget.maxElements, 28);
    budget.maxLinks = Math.min(budget.maxLinks, 20);
    budget.maxBodyChars = Math.min(budget.maxBodyChars, 2600);
    budget.maxLandmarks = Math.min(budget.maxLandmarks, 16);
    budget.historySteps = Math.min(budget.historySteps, 8);
  }
  if (options.vision === true && tier !== 'recovery') {
    budget.maxElements = Math.max(18, budget.maxElements - 4);
    budget.maxBodyChars = Math.max(1800, budget.maxBodyChars - 400);
  }
  return { tier, ...budget, signals: { failures, stalled, rejected, complex } };
}

function compactBrowserObservation(context = {}, goal = '', history = [], options = {}) {
  const adaptive = options.tier ? options : browserObservationBudget(goal, history, options);
  const maxElements = Math.max(12, Math.min(48, Number(adaptive.maxElements || 34)));
  const maxLinks = Math.max(8, Math.min(40, Number(adaptive.maxLinks || 24)));
  const maxBodyChars = Math.max(1200, Math.min(5200, Number(adaptive.maxBodyChars || 3200)));
  const maxLandmarks = Math.max(8, Math.min(36, Number(adaptive.maxLandmarks || 24)));
  const tokens = relevantTokens(originalBrowserGoal(goal));
  const latestFailure = [...history].reverse().find((item) => item?.ok === false);
  const elements = (Array.isArray(context.interactive) ? context.interactive : [])
    .map((element, index) => {
      const label = [element.text, element.ariaLabel, element.placeholder, element.type, element.href].filter(Boolean).join(' ');
      let score = overlapScore(label, tokens);
      if (['button', 'input', 'textarea', 'select'].includes(element.tag)) score += 3;
      if (element.disabled) score -= 20;
      if (element.filled === false) score += 1;
      if (/accept|agree|allow|close|dismiss|continue/i.test(label)) score += 2;
      if (latestFailure?.selector && latestFailure.selector === element.selector) score -= 8;
      return { ...element, _sourceIndex: index, _score: score };
    })
    .sort((a, b) => b._score - a._score || a._sourceIndex - b._sourceIndex)
    .slice(0, maxElements)
    .map((element, index) => ({ ...element, ref: `E${index + 1}` }));

  const interactiveHrefs = new Set(elements.map((element) => element.href).filter(Boolean));
  const links = (Array.isArray(context.discoveredLinks) ? context.discoveredLinks : [])
    .filter((item) => item?.href && !interactiveHrefs.has(item.href))
    .map((item, index) => ({ ...item, _sourceIndex: index, _score: overlapScore(`${item.text || ''} ${item.href || ''}`, tokens) }))
    .sort((a, b) => b._score - a._score || a._sourceIndex - b._sourceIndex)
    .slice(0, maxLinks)
    .map((item, index) => ({ ...item, ref: `L${index + 1}` }));

  const refs = new Map();
  for (const element of elements) refs.set(element.ref, { selector: element.selector || null, href: element.href || null, kind: 'element' });
  for (const link of links) refs.set(link.ref, { selector: null, href: link.href, kind: 'link' });

  const contract = compileBrowserMilestones(goal);
  const progress = browserMilestoneProgress(contract, context, history);
  return {
    url: context.url || '',
    title: context.title || '',
    bodyText: String(context.bodyText || '').slice(0, maxBodyChars),
    landmarks: (context.landmarks || []).slice(0, maxLandmarks),
    elements,
    links,
    refs,
    contract,
    progress,
    budget: adaptive,
  };
}

function normalizePlannedBrowserAction(action = {}, observation = {}) {
  const allowed = new Set(['click', 'fill', 'select', 'press', 'hover', 'check', 'uncheck', 'navigate', 'back', 'reload', 'scroll', 'wait', 'upload_file', 'download', 'done', 'failed']);
  const normalized = { ...action, action: oneLine(action.action, 30).toLowerCase() };
  if (!allowed.has(normalized.action)) {
    return { action: 'failed', retryable: true, goalReached: false, reason: `Unsupported browser action: ${normalized.action || 'empty'}` };
  }
  const ref = oneLine(action.ref, 20).toUpperCase();
  const target = ref ? observation.refs?.get(ref) : null;
  if (target) {
    normalized.ref = ref;
    if (target.selector) normalized.selector = target.selector;
    if (normalized.action === 'navigate' && target.href) normalized.url = target.href;
  }

  const needsSelector = new Set(['click', 'fill', 'select', 'hover', 'check', 'uncheck', 'upload_file', 'download']);
  const knownSelectors = new Set((observation.elements || []).map((item) => item.selector).filter(Boolean));
  if (needsSelector.has(normalized.action)) {
    if (!normalized.selector) {
      return { action: 'failed', retryable: true, goalReached: false, reason: 'Choose one visible element reference for this action.' };
    }
    if (!knownSelectors.has(normalized.selector)) {
      return { action: 'failed', retryable: true, goalReached: false, reason: 'The chosen selector was not present in the fresh grounded page view.' };
    }
  }

  if (normalized.action === 'navigate') {
    const exactUrls = new Set([
      observation.url,
      ...(observation.elements || []).map((item) => item.href),
      ...(observation.links || []).map((item) => item.href),
    ].filter(Boolean));
    if (!normalized.url || !exactUrls.has(normalized.url)) {
      return { action: 'failed', retryable: true, goalReached: false, reason: 'Navigate only to the current URL or an exact discovered page link.' };
    }
  }
  return normalized;
}

function compileAgentTask(text) {
  const request = String(text || '').trim();
  const lower = request.toLowerCase();
  const url = extractRequestedUrl(request);
  const browser = Boolean(url && ACTION_WORDS.browser.test(request)) || /\b(?:local chromium|local browser|browser operator)\b/i.test(request);
  const techNews = /\b(?:technewslist|techpulse)\b/i.test(request) && /\b(?:fallback|recover|recovery|audit|missing|publisher|morning|night|credits?)\b/i.test(request);
  const stats = /\b(?:views?|likes?|comments?|analytics|stats?|statistics)\b/i.test(request);
  const social = ACTION_WORDS.social.test(request);
  const video = ACTION_WORDS.video.test(request);
  const schedule = ACTION_WORDS.schedule.test(request);
  const status = ACTION_WORDS.status.test(request);
  const research = ACTION_WORDS.research.test(request);
  const destructive = /\b(?:delete|remove|clear|cancel)\b/i.test(request);
  const retry = /\b(?:retry|resume|rerun|again|failed|partial)\b/i.test(request);
  const publish = /\b(?:publish|post\s+now|send\s+live)\b/i.test(request);
  const generate = /\b(?:generate|write|compose|draft|create)\b/i.test(request);
  const runNow = /\b(?:run|start|trigger|process)\b[\s\S]{0,70}\b(?:now|schedule|campaign|pending)\b/i.test(request);
  const actionRequested = destructive || publish || generate || runNow
    || /\b(?:retry|resume|rerun|edit|update|change|enable|disable|upload|submit|send|post)\b/i.test(request);
  const intents = [];
  if (browser) intents.push('browser');
  if (techNews) intents.push('news');
  if (stats) intents.push('stats');
  if (social) intents.push('social');
  if (video) intents.push('video');
  if (schedule) intents.push('schedule');
  if (status) intents.push('status');
  if (research) intents.push('research');
  if (!intents.length) intents.push('conversation');
  return {
    version: 1,
    request,
    lower,
    url,
    intents,
    destructive,
    retry,
    publish,
    generate,
    runNow,
    actionRequested,
  };
}

function toolNamesForTask(task) {
  const selected = new Set();
  const add = (group) => (TOOL_GROUPS[group] || []).forEach((name) => selected.add(name));
  if (task.intents.includes('browser')) {
    add('browser');
    return [...selected];
  }
  if (task.intents.includes('news')) {
    add('news');
    return [...selected];
  }
  if (task.intents.includes('stats')) {
    add('stats');
    return [...selected];
  }
  if (task.intents.includes('status') && !task.actionRequested) {
    add('status');
    return [...selected];
  }
  if (task.intents.includes('research') && !task.intents.includes('browser')) add('research');

  if (task.intents.includes('social')) {
    if (task.retry) add('socialPublish');
    else if (task.intents.includes('schedule') || task.runNow) add('socialSchedule');
    else if (task.publish) add('socialPublish');
    else add('socialGenerate');
  }

  if (task.intents.includes('video')) {
    if (task.destructive) add('destructiveVideo');
    else if (task.retry) add('videoRetry');
    else if (task.intents.includes('schedule')) add('videoSchedule');
    else add('videoCreate');
  } else if (task.intents.includes('schedule') && !task.intents.includes('social')) {
    if (task.runNow) add('scheduleRun');
    else add('scheduleManage');
  }

  if (/\bskill\b/i.test(task.request)) selected.add('use_agent_skill');
  if (!selected.size && !task.intents.includes('conversation')) add('status');
  return [...selected];
}

function selectToolsForMessages(allTools = [], messages = []) {
  const task = compileAgentTask(latestUserText(messages));
  const names = new Set(toolNamesForTask(task));
  const selected = (allTools || []).filter((tool) => names.has(tool?.function?.name));
  return { task, names: [...names], tools: selected };
}

function focusedExecutionDirective(task, toolNames = []) {
  if (!task?.request) return '';
  const tools = toolNames.length ? toolNames.join(', ') : 'none; answer directly';
  return `\n\nCURRENT REQUEST CONTRACT\nIntent: ${task.intents.join(', ')}\nAllowed tools for this turn: ${tools}\nUse only these tools. Call the smallest sufficient tool once, then report its concrete result. Do not invent a tool, ID, page state, source, or success.`;
}

module.exports = {
  TOOL_GROUPS,
  browserObservationBudget,
  browserMilestoneProgress,
  compileAgentTask,
  compileBrowserCompletionContract,
  compileBrowserMilestones,
  compactBrowserObservation,
  extractRequestedUrl,
  focusedExecutionDirective,
  inferBrowserRequirements,
  latestUserText,
  normalizePlannedBrowserAction,
  originalBrowserGoal,
  selectToolsForMessages,
  toolNamesForTask,
  verifyBrowserCompletion,
};
