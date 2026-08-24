const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const { __test: linkedIn } = require('../uploaders/linkedin');
const { __test: x } = require('../uploaders/x');
const { __test: facebook } = require('../uploaders/facebook');
const { __test: tiktok } = require('../uploaders/tiktok');
const { __test: instagram } = require('../uploaders/instagram');
const { attemptUploadArbiter, __test: arbiter } = require('../uploaders/upload-arbiter');
const { extractPageContext, executeAgentAction, validateAgentCompletion } = require('../uploaders/smart-agent');
const { __test: modelManager } = require('../lm-studio-model-manager');
const { tools: aiTools, __test: aiHandler } = require('../ai-handler');

const browserCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

let browser;

test.before(async () => {
  const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(executablePath, 'A Chromium browser is required for composer regression tests.');
  browser = await chromium.launch({ headless: true, executablePath });
});

test.after(async () => {
  await browser?.close();
});

test('browser agent produces a unique selector for the intended Sign In link', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <base href="https://example.test/">
    <header>
      <a href="/">Logo</a>
      <nav><a href="/sign-in">Sign In</a></nav>
    </header>
    <input name="email" value="already-filled">
    <input name="fullName" value="">
    <script>
      document.querySelector('a[href="/sign-in"]').addEventListener('click', (event) => {
        event.preventDefault();
        document.body.dataset.clicked = 'sign-in';
      });
    </script>
  `);
  const context = await extractPageContext(page);
  const signIn = context.interactive.find((item) => item.text === 'Sign In');
  const email = context.interactive.find((item) => item.selector === 'input[name="email"]');
  const fullName = context.interactive.find((item) => item.selector === 'input[name="fullName"]');
  assert.ok(signIn?.selector);
  assert.equal(signIn?.href, 'https://example.test/sign-in');
  assert.equal(email?.filled, true);
  assert.equal(fullName?.filled, false);
  assert.equal((await page.locator(signIn.selector).innerText()).trim(), 'Sign In');
  assert.equal(await executeAgentAction(page, {
    action: 'click',
    selector: signIn.selector,
    reason: 'Click Sign In',
  }), true);
  assert.equal(await page.evaluate(() => document.body.dataset.clicked), 'sign-in');
  await page.close();
});

test('browser agent exposes only viewport links that are actually visible at a hit-test point', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`
    <a id="live" href="https://example.test/article/live" style="display:block;width:300px;height:80px">Live article</a>
    <a id="offscreen" href="https://example.test/article/offscreen" style="position:absolute;top:1200px">Offscreen article</a>
    <a id="covered" href="https://example.test/article/covered" style="position:absolute;top:120px;left:0;width:300px;height:80px">Covered article</a>
    <div style="position:absolute;z-index:10;top:120px;left:0;width:300px;height:80px;background:white">overlay</div>
  `);
  const context = await extractPageContext(page);
  assert.equal(context.interactive.find((item) => item.selector === '#live')?.href, 'https://example.test/article/live');
  assert.equal(context.interactive.some((item) => item.selector === '#offscreen'), false);
  assert.equal(context.interactive.some((item) => item.selector === '#covered'), false);
  await page.close();
});

test('browser agent rejects invented links and accepts only an exact live DOM href', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent('<a href="https://example.test/article/live" style="display:block;width:300px;height:80px">Live article</a>');
  const invented = await validateAgentCompletion(page, 'Send me the first article link.', {
    action: 'done',
    reason: 'The link is https://example.test/article/invented',
  });
  assert.equal(invented.allowed, false);
  const exact = await validateAgentCompletion(page, 'Send me the first article link.', {
    action: 'done',
    reason: 'The link is https://example.test/article/live',
  });
  assert.equal(exact.allowed, true);
  assert.deepEqual(exact.verifiedLinks, [{ url: 'https://example.test/article/live', text: 'Live article' }]);

  await page.setContent('<a href="https://example.test/article/next" style="display:block;width:300px;height:80px">Next article</a>');
  const animatedSnapshot = await validateAgentCompletion(page, 'Send me the first article link.', {
    action: 'done',
    reason: 'The link is https://example.test/article/live',
    _groundingContext: {
      url: 'about:blank',
      title: 'Animated carousel',
      interactive: [{ href: 'https://example.test/article/live', text: 'Live article' }],
    },
  });
  assert.equal(animatedSnapshot.allowed, true);
  assert.deepEqual(animatedSnapshot.verifiedLinks, [{ url: 'https://example.test/article/live', text: 'Live article' }]);
  await page.close();
});

test('LinkedIn clicks the Start a post row when it is a tabindex div', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div role="dialog" id="create-dialog">
      <div tabindex="0" id="start-row"><span>Start a post</span></div>
    </div>
    <script>
      document.querySelector('#start-row').addEventListener('click', () => {
        document.querySelector('#create-dialog').innerHTML = '<div contenteditable="true" role="textbox"></div>';
      });
    </script>
  `);

  assert.equal(await linkedIn.clickLinkedInStartPostCandidate(page), true);
  assert.equal(await linkedIn.isDialogOpen(page), true);
  await page.close();
});

test('X reads the visible modal composer instead of the hidden background composer', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div role="textbox" data-testid="tweetTextarea_0" contenteditable="true" style="display:none">wrong draft</div>
    </main>
    <div role="dialog">
      <div role="textbox" data-testid="tweetTextarea_1" contenteditable="true">Correct visible post text</div>
      <button data-testid="tweetButton" aria-label="Post">Post</button>
    </div>
  `);

  const editor = await x.getActiveXComposerTextArea(page);
  assert.equal((await editor.innerText()).trim(), 'Correct visible post text');
  assert.equal(await x.verifyXComposerHasText(page, 'Correct visible post text', 1000), true);
  await page.close();
});

test('X commits text to editor state that survives a media-style remount', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div role="dialog">
      <div id="composer" role="textbox" aria-label="Post text" data-testid="tweetTextarea_0" contenteditable="true"></div>
      <button id="attach" type="button">Attach media</button>
      <button data-testid="tweetButton" aria-label="Post">Post</button>
    </div>
    <script>
      let editorState = '';
      const bindEditor = () => {
        const editor = document.querySelector('#composer');
        editor.addEventListener('input', (event) => {
          if (event.isTrusted) editorState = editor.innerText;
        });
      };
      bindEditor();
      document.querySelector('#attach').addEventListener('click', () => {
        const replacement = document.querySelector('#composer').cloneNode(false);
        replacement.innerText = editorState;
        document.querySelector('#composer').replaceWith(replacement);
        bindEditor();
      });
    </script>
  `);

  const intended = 'Xbox\u2019s late-August update\u2014text must survive media attachment.';
  const editor = await x.getActiveXComposerTextArea(page);
  await x.insertXText(page, editor, intended);
  await page.locator('#attach').click();

  const remounted = await x.getActiveXComposerTextArea(page);
  assert.equal((await remounted.innerText()).trim(), intended);
  await page.close();
});

test('Facebook keeps correct composer text after media changes and ignores comment boxes', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div role="dialog">
      <div role="textbox" contenteditable="true" aria-label="What's on your mind?"></div>
      <div role="textbox" contenteditable="true" aria-label="Write a comment"></div>
    </div>
  `);

  const fullText = 'This text must remain attached to the Facebook image.';
  let editor = await facebook.insertFacebookTextIntoActiveComposer(page, fullText, { required: true });
  await page.evaluate(() => {
    const image = document.createElement('img');
    image.src = 'data:image/png;base64,iVBORw0KGgo=';
    document.querySelector('[role="dialog"]').appendChild(image);
  });
  editor = await facebook.insertFacebookTextIntoActiveComposer(page, fullText, { required: true, textbox: editor });

  assert.equal(facebook.normalizeFacebookComposerText(await editor.innerText()), fullText);
  assert.equal((await page.locator('[aria-label="Write a comment"]').innerText()).trim(), '');
  await page.close();
});

test('TikTok recognizes an upload redirect to login as recoverable authentication', () => {
  assert.equal(tiktok.isTikTokAuthUrl('https://www.tiktok.com/login?redirect_url=%2Ftiktokstudio%2Fupload'), true);
  assert.equal(tiktok.isTikTokAuthUrl('https://passport.tiktok.com/login/'), true);
  assert.equal(tiktok.isTikTokAuthUrl('https://www.tiktok.com/tiktokstudio/upload'), false);
});

test('Instagram distinguishes verification and throttling from a generic login failure', () => {
  assert.deepEqual(
    instagram.classifyInstagramAuthSnapshot({ url: 'https://www.instagram.com/challenge/123', text: '', hasCode: false }),
    { blockedReason: '', needsVerification: true },
  );
  assert.deepEqual(
    instagram.classifyInstagramAuthSnapshot({ url: 'https://www.instagram.com/accounts/login/', text: 'Please wait a few minutes', hasCode: false }),
    { blockedReason: 'Instagram temporarily limited login attempts.', needsVerification: false },
  );
});

test('Upload arbiter denies final submission actions but permits an explicit safe entry action', () => {
  assert.equal(arbiter.isSafeArbiterClickDescriptor({ text: 'Post', type: 'button' }, ['start a post']), false);
  assert.equal(arbiter.isSafeArbiterClickDescriptor({ text: 'Publish now', type: 'button' }, []), false);
  assert.equal(arbiter.isSafeArbiterClickDescriptor({ text: 'Start a post', type: 'button' }, ['start a post']), true);
  assert.equal(arbiter.isSafeArbiterClickDescriptor({ text: 'Log in', type: 'button' }, ['log in']), false);
  assert.equal(arbiter.isSafeArbiterClickDescriptor({ text: 'Retry', type: 'button' }, [], true), false);
  assert.equal(arbiter.isSafeArbiterClickDescriptor({ text: 'Got it', type: 'button' }, [], true), true);
});

test('Upload arbiter reuses a loaded compatible LLM and otherwise prefers Qwen 3.8', () => {
  const inventory = [
    { key: 'text-embedding-nomic-embed-text-v1.5', type: 'embedding', loaded: false },
    { key: 'qwen3.8-27b-uncensored-aggressive', type: 'llm', vision: true, loaded: false },
    { key: 'qwen/qwen3.6-35b-a3b', type: 'llm', vision: true, loaded: true, loadedId: 'qwen/qwen3.6-35b-a3b' },
  ];

  assert.equal(
    arbiter.selectArbiterModel(inventory, 'qwen3.8-27b-uncensored-aggressive').key,
    'qwen/qwen3.6-35b-a3b',
  );
  assert.equal(
    arbiter.selectArbiterModel(inventory.map((model) => ({ ...model, loaded: false })), 'qwen3.8-27b-uncensored-aggressive').key,
    'qwen3.8-27b-uncensored-aggressive',
  );
  assert.equal(arbiter.selectArbiterModel([inventory[0]], 'text-embedding-nomic-embed-text-v1.5'), null);
});

test('LM Studio guard always ejects other LLMs before selecting Qwen 3.8', () => {
  const bothLoaded = [
    { key: 'qwen3.8-27b-uncensored-aggressive', type: 'llm', vision: true, loadedInstances: [{ id: 'qwen38-live' }] },
    { key: 'qwen/qwen3.6-35b-a3b', type: 'llm', vision: true, loadedInstances: [{ id: 'qwen36-live' }] },
    { key: 'text-embedding-nomic-embed-text-v1.5', type: 'embedding', loadedInstances: [{ id: 'embedding-live' }] },
  ];
  const keepPreferred = modelManager.planSingleModelTransition(bothLoaded, 'qwen3.8-27b-uncensored-aggressive', true);
  assert.equal(keepPreferred.keep.id, 'qwen38-live');
  assert.deepEqual(keepPreferred.unload.map((item) => item.id), ['qwen36-live']);
  assert.equal(keepPreferred.loadModel, null);

  const switchToPreferred = modelManager.planSingleModelTransition([
    { ...bothLoaded[0], loadedInstances: [] },
    bothLoaded[1],
    bothLoaded[2],
  ], 'qwen3.8-27b-uncensored-aggressive', true);
  assert.equal(switchToPreferred.keep, null);
  assert.deepEqual(switchToPreferred.unload.map((item) => item.id), ['qwen36-live']);
  assert.equal(switchToPreferred.loadModel, 'qwen3.8-27b-uncensored-aggressive');

  const reloadForLargerContext = modelManager.planSingleModelTransition([
    { ...bothLoaded[0], loadedInstances: [{ id: 'qwen38-live', contextLength: 8192 }] },
    bothLoaded[2],
  ], 'qwen3.8-27b-uncensored-aggressive', true, 10240);
  assert.equal(reloadForLargerContext.keep, null);
  assert.deepEqual(reloadForLargerContext.unload.map((item) => item.id), ['qwen38-live']);
  assert.equal(reloadForLargerContext.loadModel, 'qwen3.8-27b-uncensored-aggressive');
});

test('AI requests stay within the local model prompt budget while preserving fresh skills', () => {
  const longSnapshot = `Generated: now\nSettings: local\n${Array.from({ length: 30 }, (_, index) => `VIDEO JOB QUEUE (${index})\n  job-${index} | partial | ${'changed '.repeat(100)}`).join('\n')}\nLOCAL AGENT KNOWLEDGE\n  PixelRAG [pixelrag]; triggers=screenshot this URL; purpose=visual search\n  Human Browser Operator (Vision) [local-browser-operator]; use=run_local_browser`;
  const compact = aiHandler.compactContextForTool(longSnapshot);
  assert.ok(compact.length <= 9200);
  assert.match(compact, /PixelRAG|Human Browser Operator/);

  const bounded = aiHandler.boundInitialModelMessages([
    { role: 'system', content: 'S'.repeat(13000) },
    ...Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `message-${index} ${'x'.repeat(3000)}` })),
  ]);
  assert.ok(JSON.stringify(bounded).length <= 15300);
  assert.ok(bounded.length <= 9);
  assert.equal(aiHandler.isSimpleGreeting([{ role: 'user', content: 'hello' }]), true);
});

test('AI Chat context includes fresh operational state without account secrets', () => {
  const context = aiHandler.formatAppContextSnapshot({
    settings: { upload_mode: 'local', telegram_enabled: true, ai_provider: 'lmstudio', ai_model: 'qwen3.8-27b-uncensored-aggressive' },
    videoAccounts: [{ id: 'video-account-1', platform: 'youtube', label: 'Main Channel', enabled: true, browser_profile_id: 'profile-1', email: 'secret@example.com', password: 'never-show' }],
    socialAccounts: [{ id: 'social-account-1', platform: 'x', label: 'Tech News', enabled: true, browser_profile_id: 'profile-2' }],
    jobs: [{ id: 'job-1', title: 'Morning recap', target_platforms: ['youtube', 'tiktok'], status: 'partial', platform_results: [{ name: 'youtube', status: 'success' }, { name: 'tiktok', status: 'error', error: 'login changed' }] }],
    scheduled: [],
    videoSchedules: [{ id: 'schedule-video-1', name: 'Morning Video', enabled: true, cron_expression: '5 11 * * *', platforms: ['youtube'], folder_path: 'D:\\news posts\\Videos' }],
    socialSchedules: [{ id: 'schedule-social-1', name: 'Evening Social', enabled: true, source_type: 'folder', cron_expression: '20 21 * * *', target_platforms: ['x', 'linkedin', 'facebook'], folder_path: 'D:\\news posts', auto_publish: true }],
    socialPosts: [{ id: 'post-1', description: 'Evening summary', target_platforms: ['x'], status: 'pending', platform_results: [] }],
    generationJobs: [], agentRuns: [], commands: [], skills: [], memories: [],
    browserSessions: [{
      id: 'browser-1', task: 'Find the company contact email.', status: 'completed',
      current_url: 'https://example.com/contact',
      result: { summary: 'Found the requested contact.', public_contact_emails: ['hello@example.com'] },
    }],
  }, new Date('2026-08-24T12:00:00Z'));

  assert.match(context, /Main Channel/);
  assert.match(context, /schedule-video-1/);
  assert.match(context, /schedule-social-1/);
  assert.match(context, /public-contact=hello@example\.com/);
  assert.match(context, /youtube:success/);
  assert.match(context, /tiktok:error/);
  assert.doesNotMatch(context, /secret@example\.com|never-show/);
});

test('AI Chat exposes safe video, social, schedule, and refresh operations', () => {
  const definitions = new Map(aiTools.map((tool) => [tool.function.name, tool.function]));
  for (const name of [
    'create_upload_job', 'process_pending_uploads', 'retry_failed_job',
    'generate_social_post', 'publish_social_post', 'retry_social_post',
    'run_recurring_schedule_now', 'run_social_schedule_now', 'get_fresh_app_state',
  ]) {
    assert.ok(definitions.has(name), `Missing AI operation: ${name}`);
  }
  assert.equal(definitions.get('manage_recurring_schedule').parameters.properties.schedule_id.type, 'string');
  assert.equal(definitions.get('update_cron_schedule').parameters.properties.schedule_id.type, 'string');
});

test('Upload arbiter rejects an unsafe AI click and safely clears an allowlisted blocker', async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <button id="final">Post</button>
    <div id="blocker" role="dialog">
      <button id="got-it">Got it</button>
    </div>
    <script>
      document.querySelector('#got-it').addEventListener('click', () => {
        document.querySelector('#blocker').remove();
        document.body.dataset.ready = 'true';
      });
    </script>
  `);

  const trace = [];
  const result = await attemptUploadArbiter(page, {
    platform: 'test',
    checkpoint: 'safe recovery',
    originalError: 'blocked',
    modelId: 'qwen-test-vision',
    useVision: true,
    saveArtifacts: false,
    reporter: async (phase, details) => { trace.push({ phase, details }); },
    planner: async () => ({ action: 'click', selector: '#final', reason: 'unsafe suggestion' }),
    verify: () => page.evaluate(() => document.body.dataset.ready === 'true'),
  });

  assert.equal(result.recovered, true);
  assert.equal(await page.locator('#final').count(), 1);
  assert.equal(await page.locator('#blocker').count(), 0);
  assert.deepEqual(trace.map((item) => item.phase), ['received', 'answer', 'resolved']);
  assert.equal(trace[1].details.executed, false);
  assert.equal(trace[1].details.denialReason, 'AI click was outside the checkpoint allowlist.');
  assert.equal(trace[2].details.action, 'safe fallback click');
  await page.close();
});
