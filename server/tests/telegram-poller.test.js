const test = require('node:test');
const assert = require('node:assert/strict');

const {
  commandId,
  extractTelegramMessage,
  hydrateTelegramImages,
  inboundMessageId,
} = require('../telegramPoller');
const {
  assertSafeImageUrl,
  extractMarkdownImageUrls,
  materializeVisionMessages,
  validateImageBuffer,
} = require('../visualMedia');
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
    imageCandidates: [],
  });
  assert.equal(extractTelegramMessage({
    update_id: 78,
    message: { from: { is_bot: true }, chat: { id: 9001 }, text: 'ignore me' },
  }), null);
});

test('Telegram photo-only updates are retained as local visual context using the largest photo', () => {
  const incoming = extractTelegramMessage({
    update_id: 88,
    message: {
      message_id: 9,
      date: 123457,
      from: { is_bot: false },
      chat: { id: 9001 },
      photo: [
        { file_id: 'small', file_unique_id: 's', file_size: 500 },
        { file_id: 'large', file_unique_id: 'l', file_size: 5000 },
      ],
    },
  });
  assert.equal(incoming.text, '');
  assert.equal(incoming.imageCandidates.length, 1);
  assert.equal(incoming.imageCandidates[0].fileId, 'large');
});

test('Telegram images are validated, stored locally, and exposed without persisting the bot token', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const uploads = [];
  const supabase = {
    storage: {
      from() {
        return {
          async upload(storagePath, buffer) { uploads.push({ storagePath, buffer }); return { error: null }; },
          getPublicUrl(storagePath) { return { data: { publicUrl: `http://localhost:3001/api/local-storage/videos/${storagePath}` } }; },
        };
      },
    },
  };
  const incoming = {
    updateId: 90,
    chatId: 9001,
    imageCandidates: [{ fileId: 'photo-id', uniqueId: 'unique', name: 'photo.jpg', type: 'image/png', size: png.length }],
  };
  const images = await hydrateTelegramImages('secret-bot-token', incoming, supabase, {
    telegramApiImpl: async () => ({ file_path: 'photos/file.png' }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'image/png' : String(png.length) },
      arrayBuffer: async () => png,
    }),
  });
  assert.equal(images.length, 1);
  assert.match(images[0].url, /^http:\/\/localhost:3001\/api\/local-storage\/videos\//);
  assert.equal(uploads.length, 1);
  assert.doesNotMatch(JSON.stringify(images), /secret-bot-token/);
});

test('vision messages include real image bytes and preserve a photo for a later follow-up', async () => {
  const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
  const result = await materializeVisionMessages([
    { role: 'user', content: '', images: [{ url: pngDataUrl }] },
    { role: 'user', content: 'What is visible in the image?' },
  ]);
  assert.equal(result.imageCount, 1);
  assert.equal(result.messages[0].content[0].type, 'image_url');
  assert.match(result.messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(result.messages[1].content, 'What is visible in the image?');
  assert.throws(() => validateImageBuffer(Buffer.from('<html>not an image</html>'), 'image/png'), /invalid image bytes/i);
});

test('assistant markdown images are discovered once for real Telegram photo delivery', () => {
  assert.deepEqual(
    extractMarkdownImageUrls('![one](https://example.com/a.jpg) and ![duplicate](https://example.com/a.jpg)'),
    ['https://example.com/a.jpg'],
  );
  assert.doesNotThrow(() => assertSafeImageUrl(new URL('http://127.0.0.1:3001/image.jpg')));
  assert.throws(() => assertSafeImageUrl(new URL('http://192.168.1.10/private.jpg')), /Remote image URLs must use HTTPS|Private-network/);
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
