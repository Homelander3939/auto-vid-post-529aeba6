const test = require('node:test');
const assert = require('node:assert/strict');

const {
  commandId,
  extractTelegramMessage,
  inboundMessageId,
} = require('../telegramPoller');
const { __test: aiTest } = require('../ai-handler');

test('Telegram updates map to deterministic local message and command IDs', () => {
  assert.equal(inboundMessageId(123), 'telegram-in-123');
  assert.equal(commandId(123), 'telegram-ai-123');
});

test('Telegram message extraction accepts human text without retaining the full raw update', () => {
  const incoming = extractTelegramMessage({
    update_id: 77,
    message: {
      message_id: 4,
      date: 123456,
      from: { is_bot: false },
      chat: { id: 9001 },
      text: 'Please show the current upload queue.',
    },
  });
  assert.deepEqual(incoming, {
    updateId: 77,
    chatId: 9001,
    messageId: 4,
    messageDate: 123456,
    text: 'Please show the current upload queue.',
    edited: false,
    hasAttachments: false,
  });
  assert.equal(extractTelegramMessage({
    update_id: 78,
    message: { from: { is_bot: true }, chat: { id: 9001 }, text: 'ignore me' },
  }), null);
});

test('plaintext credentials are detected and redacted before logs or replies', () => {
  assert.equal(aiTest.containsPlaintextCredentials('login with password: example-secret'), true);
  assert.equal(aiTest.containsPlaintextCredentials('open the upload schedule page'), false);
  const redacted = aiTest.redactSensitiveText({
    task: 'login with email: owner@example.com password: example-secret and token=another-secret',
  });
  assert.doesNotMatch(redacted, /owner@example\.com|example-secret|another-secret/);
  assert.match(redacted, /\[redacted\]/);
  assert.match(redacted, /\[account\]/);
});

test('verified public browser contact emails survive reply redaction and resolve follow-ups', async () => {
  const row = {
    task: 'Find the company contact email.',
    current_url: 'https://example.com/contact',
    result: {
      public_contact_emails: ['hello@example.com'],
      page_text_excerpt: 'Contact hello@example.com',
    },
  };
  assert.equal(
    aiTest.redactSensitiveText('Public contact: hello@example.com; password: hidden', { allowedEmails: ['hello@example.com'] }),
    'Public contact: hello@example.com; password: [redacted]',
  );
  const chain = {
    select() { return this; },
    eq() { return this; },
    order() { return this; },
    async limit() { return { data: [row], error: null }; },
  };
  const reply = await aiTest.replyFromRecentBrowserResult('No, send me that email here.', {
    from() { return chain; },
  });
  assert.match(reply, /hello@example\.com/);
  assert.match(reply, /https:\/\/example\.com\/contact/);
});
