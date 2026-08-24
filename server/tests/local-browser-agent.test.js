const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentGoal,
  buildSessionCheckpoint,
  createLocalBrowserSession,
  evaluateBrowserActionSafety,
  deriveTaskPermissions,
  isSnapshotOnlyTask,
  normalizeStartUrl,
  prepareAuthenticatedTaskPage,
  publicStep,
  publicFactsForTask,
  requestsPublicContactInformation,
} = require('../localBrowserAgent');
const { detectAndHandleCaptcha, redactAgentLog, validateAgentCompletion } = require('../uploaders/smart-agent');

test('credential-bearing browser tasks persist only a redacted public copy', async () => {
  let inserted = null;
  const supabase = {
    from() {
      return {
        insert(row) {
          inserted = row;
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
      };
    },
  };
  const session = await createLocalBrowserSession(supabase, {
    task: 'Log in with email owner@example.com and password: example-secret, then add a calendar event.',
    url: 'https://example.com',
  });
  assert.equal(session.has_private_input, true);
  assert.doesNotMatch(inserted.task, /owner@example\.com|example-secret/);
  assert.match(inserted.task, /\[account\]|\[redacted\]/);
});

test('public contact-email lookup preserves the verified page fact without exposing login accounts', () => {
  const facts = publicFactsForTask(
    'Go to example.com and find the company contact email.',
    'Contact us at hello@example.com for a reply.',
    ['sales@example.com'],
  );
  assert.deepEqual(facts.contactEmails, ['hello@example.com', 'sales@example.com']);
  assert.deepEqual(
    publicFactsForTask('Log in with this account.', 'Account owner@example.com', []),
    { contactEmails: [], contactPhones: [], contactLocations: [], sourceUrls: [] },
  );
  assert.equal(publicStep({ action: 'done', reason: 'Found hello@example.com' }).message, 'Found [account]');
  assert.equal(
    publicStep({ action: 'done', reason: 'Found hello@example.com' }, { allowedEmails: facts.contactEmails }).message,
    'Found hello@example.com',
  );
});

test('broad contact-information requests preserve exact grounded public details', () => {
  const facts = publicFactsForTask(
    'Go to devsolabs.com, find their contact information, and send it to me.',
    'Email: contact@devsolabs.com\nPhone: +995 598 574742\nLocation: Tbilisi, Georgia',
    [],
    'https://devsolabs.com/contact',
  );
  assert.equal(requestsPublicContactInformation('Find the company contact information.'), true);
  assert.deepEqual(facts, {
    contactEmails: ['contact@devsolabs.com'],
    contactPhones: ['+995 598 574742'],
    contactLocations: ['Tbilisi, Georgia'],
    sourceUrls: ['https://devsolabs.com/contact'],
  });
  const footerFacts = publicFactsForTask(
    'Find their contact information.',
    'Direct info.devsolabs@gmail.com +995 598 574742\nTbilisi, Georgia · Remote-first',
    [],
    'https://devsolabs.com/contact',
  );
  assert.deepEqual(footerFacts.contactLocations, ['Tbilisi, Georgia · Remote-first']);
});

test('browser completion rejects placeholder or hallucinated contact facts', async () => {
  const grounding = {
    url: 'https://devsolabs.com/contact',
    title: 'Contact',
    bodyText: 'Email: contact@devsolabs.com\nPhone: +995 598 574742',
    interactive: [{ href: 'mailto:contact@devsolabs.com', text: 'contact@devsolabs.com' }],
    discoveredLinks: [],
  };
  const missing = await validateAgentCompletion(null, 'Find the contact information.', {
    action: 'done', reason: 'Found the contact information: [account].', _groundingContext: grounding,
  });
  assert.equal(missing.allowed, false);
  const hallucinated = await validateAgentCompletion(null, 'Find the contact email.', {
    action: 'done', reason: 'Email: made-up@devsolabs.com', _groundingContext: grounding,
  });
  assert.equal(hallucinated.allowed, false);
  const verified = await validateAgentCompletion(null, buildAgentGoal('Find the contact information.'), {
    action: 'done', reason: 'Email: contact@devsolabs.com Phone: +995 598 574742', _groundingContext: grounding,
  });
  assert.equal(verified.allowed, true);
});

test('local browser accepts only HTTP and HTTPS starting addresses', () => {
  assert.equal(normalizeStartUrl('http://127.0.0.1:8081/skills'), 'http://127.0.0.1:8081/skills');
  assert.equal(normalizeStartUrl('https://example.com'), 'https://example.com/');
  assert.throws(() => normalizeStartUrl('file:///C:/Windows/win.ini'), /only accept HTTP or HTTPS/);
  assert.throws(() => normalizeStartUrl('javascript:alert(1)'), /only accept HTTP or HTTPS/);
});

test('local browser blocks credentials, uploads, and consequential final clicks', async () => {
  assert.equal((await evaluateBrowserActionSafety({ action: 'upload_file', value: 'C:/secret.txt' })).allowed, false);
  assert.equal((await evaluateBrowserActionSafety({ action: 'fill', selector: 'input[type=password]', value: 'secret' })).allowed, false);
  assert.equal((await evaluateBrowserActionSafety({ action: 'click', reason: 'Click Post to publish this update' })).allowed, false);
  assert.equal((await evaluateBrowserActionSafety({ action: 'click', reason: 'Open the documentation link' })).allowed, true);
  assert.equal((await evaluateBrowserActionSafety({ action: 'navigate', url: 'https://example.com/docs' })).allowed, true);
});

test('explicit login and calendar tasks allow only their scoped actions', async () => {
  const permissions = deriveTaskPermissions('Log in with the supplied credentials and add a calendar event.');
  assert.equal(permissions.allowCredentialEntry, true);
  assert.equal(permissions.allowCalendarWrite, true);
  assert.equal((await evaluateBrowserActionSafety({ action: 'fill', selector: 'input[type=password]', value: 'secret' }, null, permissions)).allowed, true);
  assert.equal((await evaluateBrowserActionSafety({ action: 'click', reason: 'Click Sign in' }, null, permissions)).allowed, true);
  assert.equal((await evaluateBrowserActionSafety({ action: 'click', reason: 'Submit the calendar event' }, null, permissions)).allowed, true);
  assert.equal((await evaluateBrowserActionSafety({ action: 'click', reason: 'Pay for the subscription' }, null, permissions)).allowed, false);
  const goal = buildAgentGoal('Log in and add a calendar event.', permissions);
  assert.match(goal, /never invent dates, times/i);
  assert.match(goal, /visually verify the requested result/i);
  assert.match(goal, /never replace execution with a tutorial/i);
});

test('general site tasks derive scoped form, upload, and download permissions', () => {
  const form = deriveTaskPermissions('Visit example.com, fill this form, and submit it.');
  const upload = deriveTaskPermissions('Open the website and upload the image file.');
  const download = deriveTaskPermissions('Go to the report page and download the PDF file.');
  assert.equal(form.allowFormSubmission, true);
  assert.equal(upload.allowFileUpload, true);
  assert.equal(download.allowDownload, true);
});

test('human verification pauses the browser rather than attempting to bypass it', async () => {
  const page = {
    evaluate: async () => true,
  };
  const verdict = await evaluateBrowserActionSafety({ action: 'click', reason: 'Continue' }, page, deriveTaskPermissions('Continue through the website.'));
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /needs the user/i);
});

test('CAPTCHA detector reports a hard human-input pause without clicking anything', async () => {
  let evaluations = 0;
  const page = {
    evaluate: async () => {
      evaluations += 1;
      return { hasCaptchaFrame: true, hasRobotText: true, hasCheckbox: true, hasVerifyButton: true };
    },
  };
  const result = await detectAndHandleCaptcha(page);
  assert.equal(result.detected, true);
  assert.equal(result.handled, false);
  assert.match(result.reason, /user/i);
  assert.equal(evaluations, 1);
});

test('local browser action events do not expose typed values or selectors', () => {
  const event = publicStep({
    step: 2,
    action: 'fill',
    selector: '#password',
    value: 'very-secret',
    reason: 'Entered text into the search field.',
    ok: true,
  });
  assert.equal(event.action, 'fill');
  assert.equal(event.message, 'Entered text into the search field.');
  assert.doesNotMatch(JSON.stringify(event), /very-secret|#password/);
});

test('browser events expose only auditable screenshot and state-change metadata', () => {
  const event = publicStep({
    step: 3,
    action: 'click',
    reason: 'Opened the requested panel.',
    phase: 'after',
    stateChanged: true,
    screenshotKey: 'step-003-after-123.jpg',
  });
  assert.equal(event.state_changed, true);
  assert.equal(event.screenshot_key, 'step-003-after-123.jpg');
  assert.equal(event.phase, 'after');
});

test('browser events preserve only exact verified link evidence', () => {
  const event = publicStep({
    step: 2,
    action: 'done',
    reason: 'Found the requested article.',
    verifiedLinks: [{ url: 'https://example.com/article/live', text: 'Live article' }],
  });
  assert.deepEqual(event.verified_links, [{ url: 'https://example.com/article/live', text: 'Live article' }]);
});

test('read-only browser tasks use the fast audited snapshot path', () => {
  assert.equal(isSnapshotOnlyTask('Read this page and list the visible headings.'), true);
  assert.equal(isSnapshotOnlyTask('Inspect https://example.com and summarize it.'), true);
  assert.equal(isSnapshotOnlyTask('Click the account menu and open settings.'), false);
});

test('authenticated calendar tasks resume on the dashboard instead of logging in again', async () => {
  let clicked = 0;
  const control = {
    first: () => control,
    isVisible: async () => true,
    click: async () => { clicked += 1; },
  };
  const page = {
    evaluate: async () => true,
    locator: () => control,
    waitForTimeout: async () => {},
  };
  const resumed = await prepareAuthenticatedTaskPage(page, 'https://example.com', {
    allowCredentialEntry: true,
    allowCalendarWrite: true,
  });
  assert.equal(resumed, true);
  assert.equal(clicked, 1);
});

test('browser diagnostics redact account identifiers and secrets', () => {
  const safe = redactAgentLog('email owner@example.com password: example-secret');
  assert.equal(safe, 'email [account] password: [redacted]');
});

test('browser checkpoints persist milestones but never selectors, typed values, or private accounts', async () => {
  const page = {
    url: () => 'https://example.com/dashboard',
    title: async () => 'Dashboard',
    evaluate: async () => ({ headings: ['Dashboard'], controls: ['Create'], body: 'Dashboard Create item' }),
  };
  const checkpoint = await buildSessionCheckpoint('Create an item and save it.', page, [{
    step: 2,
    action: 'fill',
    selector: '#secret-field',
    value: 'owner@example.com',
    reason: 'Entered owner@example.com into the form.',
    ok: true,
    stateChanged: true,
  }], { hasPrivateInput: true });
  assert.equal(checkpoint.safe_to_resume, false);
  assert.ok(checkpoint.contract.milestones.length > 0);
  assert.doesNotMatch(JSON.stringify(checkpoint), /#secret-field|owner@example\.com/);
  assert.match(JSON.stringify(checkpoint), /\[account\]/);
});
