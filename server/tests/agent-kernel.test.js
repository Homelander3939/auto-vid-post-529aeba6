const test = require('node:test');
const assert = require('node:assert/strict');

const {
  browserObservationBudget,
  compileAgentTask,
  compileBrowserMilestones,
  compileBrowserCompletionContract,
  compactBrowserObservation,
  focusedExecutionDirective,
  normalizePlannedBrowserAction,
  selectToolsForMessages,
  toolNamesForTask,
  verifyBrowserCompletion,
} = require('../agentKernel');
const { tools } = require('../ai-handler');

test('small-model router exposes only the tools relevant to the current request', () => {
  const browser = selectToolsForMessages(tools, [{ role: 'user', content: 'Go to example.com and find the contact page.' }]);
  assert.deepEqual(browser.names.sort(), ['run_local_browser', 'use_agent_skill']);
  assert.deepEqual(browser.tools.map((item) => item.function.name).sort(), browser.names.sort());

  const social = selectToolsForMessages(tools, [{ role: 'user', content: 'Generate a LinkedIn and Facebook social post with an image.' }]);
  assert.deepEqual(social.names.sort(), ['generate_social_post', 'get_fresh_app_state']);

  const retry = selectToolsForMessages(tools, [{ role: 'user', content: 'Retry the failed TikTok video upload job.' }]);
  assert.deepEqual(retry.names.sort(), ['get_fresh_app_state', 'process_pending_uploads', 'retry_failed_job']);
  assert.ok(retry.tools.length < tools.length / 2);

  const readOnly = selectToolsForMessages(tools, [{ role: 'user', content: 'Show me the failed video jobs and current queue status.' }]);
  assert.deepEqual(readOnly.names, ['get_fresh_app_state', 'use_agent_skill']);

  const ambiguousSchedule = selectToolsForMessages(tools, [{ role: 'user', content: 'Run schedule 4 now.' }]);
  assert.deepEqual(ambiguousSchedule.names.sort(), ['get_fresh_app_state', 'run_recurring_schedule_now', 'run_social_schedule_now']);
});

test('tool router keeps destructive operations unavailable unless explicitly requested', () => {
  const normal = toolNamesForTask(compileAgentTask('Show me the failed video jobs.'));
  assert.equal(normal.includes('clear_jobs_by_status'), false);
  assert.equal(normal.includes('delete_upload_job'), false);

  const destructive = toolNamesForTask(compileAgentTask('Delete the failed video upload job by its exact ID.'));
  assert.equal(destructive.includes('delete_upload_job'), true);
  assert.equal(destructive.includes('clear_jobs_by_status'), true);
});

test('browser contract decomposes multi-part work without asking the model to remember it', () => {
  const contract = compileBrowserMilestones('Log in, add a calendar event, and verify it is visible.');
  assert.equal(contract.requirements.login, true);
  assert.equal(contract.requirements.submit, true);
  assert.deepEqual(contract.milestones.map((item) => item.id), ['orient', 'authenticate', 'act', 'verify']);
});

test('read-only result phrasing does not accidentally authorize a website submission', () => {
  const contract = compileBrowserCompletionContract('Find the first article link and send it to me here.');
  assert.equal(contract.requirements.exactLink, true);
  assert.equal(contract.requirements.submit, false);
});

test('typed completion verifier requires a real non-empty downloaded file', () => {
  const context = { url: 'https://example.com/report', bodyText: 'Report ready' };
  const rejected = verifyBrowserCompletion({
    goal: 'Download the PDF report.',
    action: { action: 'done', _groundingContext: context },
    history: [{ action: 'download', ok: true, downloadPath: 'C:/missing.pdf' }],
    contexts: [context],
    fileEvidence: () => ({ exists: false, size: 0 }),
  });
  assert.equal(rejected.allowed, false);
  const verified = verifyBrowserCompletion({
    goal: 'Download the PDF report.',
    action: { action: 'done', _groundingContext: context },
    history: [{ action: 'download', ok: true, downloadPath: 'C:/Downloads/report.pdf' }],
    contexts: [context],
    fileEvidence: () => ({ exists: true, size: 2048 }),
  });
  assert.equal(verified.allowed, true);
});

test('typed completion verifier rejects upload or submission claims without visible confirmation', () => {
  const before = { url: 'https://example.com/form', bodyText: 'Choose file and submit', interactive: [] };
  const uploadRejected = verifyBrowserCompletion({
    goal: 'Upload the image file.',
    action: { action: 'done', _groundingContext: before },
    history: [{ action: 'upload_file', ok: true, stateChanged: false, _groundingContext: before }],
    contexts: [before],
  });
  assert.equal(uploadRejected.allowed, false);

  const after = { url: 'https://example.com/thanks', bodyText: 'Successfully submitted. Thank you.', interactive: [] };
  const submitted = verifyBrowserCompletion({
    goal: 'Fill this form and submit it.',
    action: { action: 'done', _groundingContext: after },
    history: [{
      action: 'click', ok: true, stateChanged: true, selector: '#submit', reason: 'Submit the form',
      _groundingContext: { ...before, interactive: [{ selector: '#submit', text: 'Submit' }] },
    }],
    contexts: [before, after],
  });
  assert.equal(submitted.allowed, true);
});

test('typed comparison completion requires evidence from distinct live pages', () => {
  const first = { url: 'https://example.com/a', bodyText: 'Plan A' };
  const second = { url: 'https://example.com/b', bodyText: 'Plan B' };
  const rejected = verifyBrowserCompletion({
    goal: 'Compare plan A versus plan B.',
    action: { action: 'done', _groundingContext: first },
    contexts: [first],
  });
  assert.equal(rejected.allowed, false);
  const verified = verifyBrowserCompletion({
    goal: 'Compare plan A versus plan B.',
    action: { action: 'done', _groundingContext: second },
    contexts: [first, second],
  });
  assert.equal(verified.allowed, true);
});

test('grounded page view ranks relevant controls and gives them short stable references', () => {
  const context = {
    url: 'https://example.com/',
    title: 'Example',
    bodyText: 'Welcome. Contact our team for support.',
    landmarks: ['Main navigation', 'Support'],
    interactive: [
      { tag: 'a', selector: '#pricing', text: 'Pricing', href: 'https://example.com/pricing' },
      { tag: 'a', selector: '#contact', text: 'Contact support', href: 'https://example.com/contact' },
      { tag: 'button', selector: '#menu', text: 'Menu' },
    ],
    discoveredLinks: [
      { text: 'Privacy', href: 'https://example.com/privacy' },
      { text: 'Contact', href: 'https://example.com/contact' },
    ],
  };
  const view = compactBrowserObservation(context, 'Find the contact information on example.com.', []);
  assert.equal(view.elements[0].text, 'Contact support');
  assert.equal(view.elements[0].ref, 'E1');
  assert.ok(view.refs.get('E1'));
  assert.ok(view.progress.current);
});

test('small-model observation budget expands only after real difficulty', () => {
  const easy = browserObservationBudget('Find the exact contact link.', [], { contextLength: 16384, vision: true });
  assert.equal(easy.tier, 'focused');
  assert.ok(easy.maxElements <= 24);

  const complex = browserObservationBudget('Compare these two plans and download the best report.', [], { contextLength: 16384 });
  assert.equal(complex.tier, 'balanced');
  assert.ok(complex.maxBodyChars > easy.maxBodyChars);

  const recovery = browserObservationBudget('Fill and submit this form.', [
    { action: 'click', ok: false, stateChanged: false },
    { action: 'observe', ok: false },
    { action: 'click', ok: false, stateChanged: false },
    { action: 'done', ok: false, completionRejected: true },
  ], { contextLength: 16384 });
  assert.equal(recovery.tier, 'recovery');
  assert.ok(recovery.maxElements > complex.maxElements);

  const smallContext = browserObservationBudget('Compare and submit the form.', [
    { action: 'observe', ok: false },
    { action: 'observe', ok: false },
  ], { contextLength: 6144 });
  assert.ok(smallContext.maxBodyChars <= 2600);
  assert.ok(smallContext.historySteps <= 8);
});

test('browser plans resolve refs and reject selectors or URLs not present in the fresh view', () => {
  const view = compactBrowserObservation({
    url: 'https://example.com/', title: 'Example', bodyText: 'Home', landmarks: [],
    interactive: [{ tag: 'a', selector: '#contact', text: 'Contact', href: 'https://example.com/contact' }],
    discoveredLinks: [],
  }, 'Open the contact page.', []);

  const click = normalizePlannedBrowserAction({ action: 'click', ref: 'E1', reason: 'Open contact', goalReached: false }, view);
  assert.equal(click.selector, '#contact');
  const navigate = normalizePlannedBrowserAction({ action: 'navigate', ref: 'E1', reason: 'Open exact link', goalReached: false }, view);
  assert.equal(navigate.url, 'https://example.com/contact');
  const invented = normalizePlannedBrowserAction({ action: 'click', selector: '#invented', reason: 'Guess', goalReached: false }, view);
  assert.equal(invented.action, 'failed');
  assert.equal(invented.retryable, true);
  const inventedUrl = normalizePlannedBrowserAction({ action: 'navigate', url: 'https://example.com/guessed', reason: 'Guess', goalReached: false }, view);
  assert.equal(inventedUrl.action, 'failed');
});

test('focused execution directive gives the small model an explicit narrow contract', () => {
  const task = compileAgentTask('Run social campaign schedule 4 now.');
  const names = toolNamesForTask(task);
  const directive = focusedExecutionDirective(task, names);
  assert.match(directive, /CURRENT REQUEST CONTRACT/);
  assert.match(directive, /run_social_schedule_now/);
  assert.doesNotMatch(directive, /create_upload_job/);
});
