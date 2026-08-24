#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  browserObservationBudget,
  compileAgentTask,
  compactBrowserObservation,
  normalizePlannedBrowserAction,
  toolNamesForTask,
  verifyBrowserCompletion,
} = require('../agentKernel');
const {
  buildEvidencePacket,
  groundFactsToSources,
  validateImageBytes,
  validateResearchReport,
} = require('../researchQuality');
const {
  buildAgentGoal,
  buildSessionCheckpoint,
  deriveTaskPermissions,
  publicFactsForTask,
} = require('../localBrowserAgent');
const { detectAndHandleCaptcha, runAgentTask } = require('../uploaders/smart-agent');

const REPORT_ROOT = path.join(__dirname, '..', 'data', 'benchmarks');

function fakePng(width = 1200, height = 675, size = 30_000) {
  const buffer = Buffer.alloc(size, 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function fixtureSources() {
  return [
    {
      url: 'https://official.example/newsroom/atlas', reachable: true, title: 'Atlas launch', publishedAt: '2026-08-24T09:00:00Z',
      content: 'Company Example launched the Atlas service on August 24, 2026, after a six-month pilot with 40 customers. '.repeat(6),
    },
    {
      url: 'https://reuters.com/technology/atlas', reachable: true, title: 'Independent Atlas report', publishedAt: '2026-08-24T10:00:00Z',
      content: 'Reuters reported that the Atlas service entered public availability and quoted two customers discussing lower processing time. '.repeat(6),
    },
  ];
}

async function runCase(name, requirement, work) {
  const startedAt = Date.now();
  try {
    const evidence = await work();
    return { name, requirement, passed: true, elapsed_ms: Date.now() - startedAt, evidence };
  } catch (error) {
    return { name, requirement, passed: false, elapsed_ms: Date.now() - startedAt, error: error.message || String(error) };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runOfflineCases() {
  const sources = fixtureSources();
  const facts = groundFactsToSources([
    { claim: 'Company Example launched the Atlas service on August 24, 2026 after a six-month pilot.', sourceIds: [1], confidence: 'high' },
    { claim: 'Atlas entered public availability according to independent reporting.', sourceIds: [2], confidence: 'high' },
    { claim: 'Two customers discussed lower processing time in the independent report.', sourceIds: [2], confidence: 'medium' },
  ], sources);
  const packet = buildEvidencePacket({
    query: 'Atlas service launch', sources, facts,
    images: [{ url: 'https://official.example/media/atlas.jpg', sourceUrl: sources[0].url, contentType: 'image/jpeg', width: 1200, height: 675, bytes: 100000, validated: true }],
    requireImage: true,
  });

  return Promise.all([
    runCase('exact-live-link', 'Extract an exact live href without reconstructing it.', async () => {
      const view = compactBrowserObservation({
        url: 'https://example.test/', title: 'Home', bodyText: 'Latest article', landmarks: ['Latest'],
        interactive: [{ tag: 'a', selector: '#article', text: 'First article', href: 'https://example.test/articles/exact-id-42' }], discoveredLinks: [],
      }, 'Find and return the first article link.', []);
      const action = normalizePlannedBrowserAction({ action: 'navigate', ref: 'E1' }, view);
      assert(action.url === 'https://example.test/articles/exact-id-42', 'Exact DOM href was not preserved.');
      return { href: action.url };
    }),
    runCase('public-contact-grounding', 'Return public contact data, never a login account or placeholder.', async () => {
      const factsFound = publicFactsForTask('Find the public contact email.', 'Contact the newsroom at news@example.test. Account login: owner@example.test', ['news@example.test'], 'https://example.test/contact');
      assert(factsFound.contactEmails.includes('news@example.test'), 'Public email was not extracted.');
      assert(!factsFound.contactEmails.includes('[account]'), 'Placeholder leaked into public facts.');
      return factsFound;
    }),
    runCase('stale-selector-recovery', 'Recover from a stale selector and expand context only after real difficulty.', async () => {
      const focused = browserObservationBudget('Find the contact link.', [], { contextLength: 10240, vision: true });
      const history = [
        { action: 'click', ok: false, stateChanged: false }, { action: 'observe', ok: false },
        { action: 'click', ok: false, stateChanged: false }, { action: 'done', ok: false, completionRejected: true },
      ];
      const recovery = browserObservationBudget('Click Next and continue.', history, { contextLength: 10240, vision: true });
      const view = compactBrowserObservation({
        url: 'https://example.test/wizard', title: 'Wizard', bodyText: 'Continue setup', landmarks: ['Setup'], discoveredLinks: [],
        interactive: [
          { tag: 'button', selector: '#old-next', text: 'Next' },
          { tag: 'button', selector: '#new-next', text: 'Next step' },
        ],
      }, 'Click Next and continue.', [{ action: 'click', selector: '#old-next', ok: false }], recovery);
      assert(focused.tier === 'focused' && recovery.tier === 'recovery', 'Adaptive tiers did not transition correctly.');
      assert(recovery.maxElements > focused.maxElements, 'Recovery did not expose more grounded controls.');
      assert(view.elements[0].selector === '#new-next', 'Failed selector was not demoted behind the fresh alternative.');
      return { focused, recovery, preferred_selector: view.elements[0].selector };
    }),
    runCase('form-completion-proof', 'Reject form success without a changed page and confirmation.', async () => {
      const before = { url: 'https://example.test/form', bodyText: 'Submit form', interactive: [{ selector: '#submit', text: 'Submit' }] };
      const after = { url: 'https://example.test/thanks', bodyText: 'Successfully submitted. Thank you.', interactive: [] };
      const verdict = verifyBrowserCompletion({
        goal: 'Fill this form and submit it.', action: { action: 'done', _groundingContext: after }, contexts: [before, after],
        history: [{ action: 'click', selector: '#submit', ok: true, stateChanged: true, reason: 'Submit form', _groundingContext: before }],
      });
      assert(verdict.allowed, verdict.reason || 'Verified form completion was rejected.');
      return { checks: verdict.checks };
    }),
    runCase('download-proof', 'Require a real, non-empty downloaded file.', async () => {
      const context = { url: 'https://example.test/report', bodyText: 'Report ready' };
      const rejected = verifyBrowserCompletion({ goal: 'Download the PDF report.', action: { action: 'done', _groundingContext: context }, history: [{ action: 'download', ok: true, downloadPath: 'missing.pdf' }], contexts: [context], fileEvidence: () => ({ exists: false, size: 0 }) });
      const accepted = verifyBrowserCompletion({ goal: 'Download the PDF report.', action: { action: 'done', _groundingContext: context }, history: [{ action: 'download', ok: true, downloadPath: 'report.pdf' }], contexts: [context], fileEvidence: () => ({ exists: true, size: 4096 }) });
      assert(!rejected.allowed && accepted.allowed, 'Download verifier did not distinguish missing and real files.');
      return { rejected: rejected.reason, accepted: accepted.checks };
    }),
    runCase('human-verification-pause', 'Pause for CAPTCHA or human verification without clicking it.', async () => {
      let calls = 0;
      const verdict = await detectAndHandleCaptcha({ evaluate: async () => { calls += 1; return { hasCaptchaFrame: true, hasRobotText: true, hasCheckbox: true, hasVerifyButton: true }; } });
      assert(verdict.detected && !verdict.handled && calls === 1, 'Human verification was not treated as a hard pause.');
      return verdict;
    }),
    runCase('source-grounded-post', 'Ground every news claim to exact source spans and require a verified image.', async () => {
      assert(facts.length === 3 && facts.every((fact) => fact.supportingSpans.length), 'Fact ledger lost exact source spans.');
      const tiny = validateImageBytes(fakePng(120, 120), { contentType: 'image/png' });
      const hero = validateImageBytes(fakePng(1200, 675), { contentType: 'image/png' });
      assert(!tiny.ok && hero.ok, 'Image byte/dimension gate did not behave correctly.');
      return { facts: facts.map((fact) => ({ id: fact.id, urls: fact.sourceUrls, spans: fact.supportingSpans.length })), image: hero };
    }),
    runCase('complete-evidence-packet', 'Require independent sources, grounded facts, and a verified image.', async () => {
      assert(packet.quality.passed, packet.quality.errors.join(', '));
      assert(packet.quality.independent_domains >= 2 && packet.quality.grounded_facts >= 3 && packet.quality.verified_images >= 1, 'Evidence packet is incomplete.');
      return packet.quality;
    }),
    runCase('research-report-quality', 'Reject uncited reports and numbers absent from evidence.', async () => {
      const valid = validateResearchReport(`${'Atlas reached public availability after its documented pilot. '.repeat(10)} The pilot involved 40 customers in 2026 [1], and independent reporting confirmed the release [2].`, packet, { minChars: 300 });
      const invented = validateResearchReport(`${'Atlas reached public availability after its documented pilot. '.repeat(10)} The pilot involved 900 customers in 2026 [1], and independent reporting confirmed the release [2].`, packet, { minChars: 300 });
      assert(valid.ok && !invented.ok, 'Report quality gate did not reject an invented number.');
      return { valid, invented };
    }),
    runCase('exact-schedule-routing', 'Route an exact schedule request without exposing unrelated tools.', async () => {
      const task = compileAgentTask('Run schedule 4 now and do not change its configuration.');
      const names = toolNamesForTask(task);
      assert(task.runNow && names.includes('run_recurring_schedule_now') && names.includes('get_fresh_app_state'), 'Exact schedule request was not routed to guarded schedule tools.');
      assert(!names.includes('create_upload_job') && !names.includes('clear_jobs_by_status'), 'Unrelated or destructive tools leaked into the schedule request.');
      return { intents: task.intents, tools: names };
    }),
    runCase('partial-upload-retry-routing', 'Retry only failed upload platforms without recreating a successful job.', async () => {
      const task = compileAgentTask('Retry only the failed TikTok platform for the partial video upload job.');
      const names = toolNamesForTask(task);
      assert(task.retry && names.includes('retry_failed_job') && names.includes('get_fresh_app_state'), 'Partial retry was not routed to the guarded retry tools.');
      assert(!names.includes('create_upload_job') && !names.includes('run_recurring_schedule_now'), 'Retry request exposed job creation or schedule tools.');
      return { intents: task.intents, tools: names };
    }),
    runCase('secret-safe-checkpoint', 'Resume from milestones without persisting credentials or selectors.', async () => {
      const page = { url: () => 'https://example.test/dashboard', title: async () => 'Dashboard', evaluate: async () => ({ headings: ['Dashboard'], controls: ['Save'], body: 'Dashboard ready' }) };
      const checkpoint = await buildSessionCheckpoint('Log in with owner@example.test and password: top-secret.', page, [{ action: 'fill', selector: '#password', value: 'top-secret', reason: 'Entered password', step: 1, ok: true }], { hasPrivateInput: true });
      const serialized = JSON.stringify(checkpoint);
      assert(checkpoint.safe_to_resume === false, 'Private checkpoint was incorrectly resumable.');
      assert(!/top-secret|#password|owner@example\.test/i.test(serialized), 'Checkpoint persisted private input or selectors.');
      return { safe_to_resume: checkpoint.safe_to_resume, blocker: checkpoint.resume_blocker };
    }),
  ]);
}

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/article') return res.end('<main><h1>Verified local article</h1><p>This is the exact article page.</p></main>');
    if (req.url === '/contact') return res.end('<main><h1>Contact</h1><p>Email newsroom@example.test for public enquiries.</p><a href="mailto:newsroom@example.test">Email newsroom</a></main>');
    if (req.url === '/form') return res.end('<main><h1>Create record</h1><label for="name">Name</label><input id="name" placeholder="Name"><button id="submit" onclick="document.querySelector(\'main\').innerHTML=\'<h1>Saved successfully</h1><p>Atlas record is visible.</p>\'">Save record</button></main>');
    return res.end('<main><h1>Latest</h1><a id="article" href="/article">First article</a><a href="/contact">Contact</a><a href="/form">Create record</a></main>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function runLiveCases() {
  const { chromium } = require('playwright');
  const { server, port } = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${port}`;
  const liveCase = async (name, url, task, maxSteps = 12) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      return await runCase(name, task, async () => {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const result = await runAgentTask(page, buildAgentGoal(task, deriveTaskPermissions(task)), {
          maxSteps, stepDelayMs: 50, useVision: true, verbose: false, handleCaptchas: false, planTimeoutMs: 75_000,
        });
        assert(result.success, `Model stopped with ${result.finalState}.`);
        return { final_state: result.finalState, runtime: result.runtime, steps: result.steps.length };
      });
    } finally {
      await page.close().catch(() => null);
    }
  };
  try {
    return [
      await liveCase('live-exact-link', `${base}/`, 'Find the first article link and return its exact URL.'),
      await liveCase('live-public-contact', `${base}/contact`, 'Find the public contact email and report the exact value.'),
      await liveCase('live-form', `${base}/form`, 'Fill the Name field with Atlas, save the record, and verify that Atlas is visible.', 16),
    ];
  } finally {
    await browser.close().catch(() => null);
    await new Promise((resolve) => server.close(resolve));
  }
}

function summarize(mode, cases) {
  const passed = cases.filter((item) => item.passed).length;
  const total = cases.length;
  return {
    version: 1,
    mode,
    generated_at: new Date().toISOString(),
    passed,
    failed: total - passed,
    total,
    pass_rate: total ? passed / total : 0,
    cases,
  };
}

function writeReport(report) {
  fs.mkdirSync(REPORT_ROOT, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, '-');
  const target = path.join(REPORT_ROOT, `local-agent-${report.mode}-${stamp}.json`);
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(REPORT_ROOT, `latest-${report.mode}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return target;
}

async function main() {
  const live = process.argv.includes('--live');
  const noWrite = process.argv.includes('--no-write');
  const cases = live ? await runLiveCases() : await runOfflineCases();
  const report = summarize(live ? 'live-model' : 'offline-contract', cases);
  const target = noWrite ? null : writeReport(report);
  process.stdout.write(`${JSON.stringify({ ...report, cases: report.cases.map(({ evidence, ...item }) => item), report_path: target }, null, 2)}\n`);
  process.exitCode = report.failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
