const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEvidencePacket,
  groundFactsToSources,
  extractPageMetadata,
  fitVariantToLimit,
  scoreImageCandidate,
  selectDiverseSources,
  sourceQualityGate,
  validateImageBytes,
  validateResearchReport,
  validateVariant,
} = require('../researchQuality');

function fakePng(width, height, size = 30_000) {
  const buffer = Buffer.alloc(size, 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('research ranking removes tracking duplicates and preserves independent domains', () => {
  const sources = selectDiverseSources([
    { title: 'Official protocol update', url: 'https://project.example/newsroom/update?utm_source=test', snippet: 'Official release with dates and numbers.' },
    { title: 'Duplicate', url: 'https://project.example/newsroom/update#share', snippet: 'Same page.' },
    { title: 'Independent report', url: 'https://reuters.com/technology/report', snippet: 'Independent reporting about the protocol update and its market impact.' },
    { title: 'Forum reaction', url: 'https://reddit.com/r/test/123', snippet: 'Reaction.' },
  ], { query: 'protocol update market impact', max: 4, maxPerHost: 2 });

  assert.equal(sources.filter((source) => source.url.includes('project.example/newsroom/update')).length, 1);
  assert.equal(new Set(sources.map((source) => new URL(source.url).hostname)).size >= 2, true);
  assert.equal(sources[0].url.includes('reddit.com'), false);
});

test('page extraction keeps article text, publication metadata, and contextual images', () => {
  const metadata = extractPageMetadata(`
    <html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="Verified launch details">
      <meta property="article:published_time" content="2026-08-24T10:00:00Z">
      <meta property="og:image" content="/media/launch-hero.jpg">
    </head><body><article><h1>Verified launch details</h1><p>${'Concrete evidence and useful context. '.repeat(30)}</p>
      <img src="/media/product-photo.jpg" width="1200" height="675" alt="Product at launch">
      <img src="/logo.svg" width="100" height="100" alt="logo">
    </article></body></html>
  `, 'https://company.example/news/launch');

  assert.equal(metadata.title, 'Verified launch details');
  assert.equal(metadata.publishedAt, '2026-08-24T10:00:00Z');
  assert.ok(metadata.content.length > 400);
  assert.deepEqual(metadata.images.map((image) => image.url), [
    'https://company.example/media/launch-hero.jpg',
    'https://company.example/media/product-photo.jpg',
  ]);
});

test('source quality gate requires two readable independent sources', () => {
  const good = sourceQualityGate([
    { url: 'https://official.example/news', reachable: true, content: 'a'.repeat(600) },
    { url: 'https://reuters.com/report', reachable: true, content: 'b'.repeat(600) },
  ]);
  assert.equal(good.ok, true);

  const duplicateDomain = sourceQualityGate([
    { url: 'https://official.example/news', reachable: true, content: 'a'.repeat(600) },
    { url: 'https://official.example/blog', reachable: true, content: 'b'.repeat(600) },
  ]);
  assert.equal(duplicateDomain.ok, false);
  assert.ok(duplicateDomain.errors.includes('fewer_than_two_independent_domains'));
});

test('evidence packets retain exact source spans and reject unsupported model claims', () => {
  const sources = [
    {
      url: 'https://company.example/newsroom/launch', reachable: true, title: 'Company launch',
      content: 'Company Example launched the Atlas service on August 24, 2026, after a six-month pilot with 40 customers. '.repeat(6),
    },
    {
      url: 'https://reuters.com/technology/atlas', reachable: true, title: 'Independent Atlas report',
      content: 'Reuters reported that the Atlas service entered public availability and quoted two customers discussing lower processing time. '.repeat(6),
    },
  ];
  const facts = groundFactsToSources([
    { claim: 'Company Example launched the Atlas service on August 24, 2026 after a six-month pilot.', sourceIds: [1], confidence: 'high' },
    { claim: 'Atlas entered public availability according to independent reporting.', sourceIds: [2], confidence: 'high' },
    { claim: 'Two customers discussed lower processing time in the independent report.', sourceIds: [2], confidence: 'medium' },
    { claim: 'The product earned one billion dollars overnight.', sourceIds: [1], confidence: 'high' },
    { claim: 'Company Example launched Atlas for 900 customers.', sourceIds: [1], confidence: 'high' },
  ], sources);
  assert.equal(facts.length, 3);
  assert.match(facts[0].supportingSpans[0].span, /launched the Atlas service/i);

  const packet = buildEvidencePacket({
    query: 'Atlas service launch', sources, facts,
    images: [{ url: 'https://company.example/media/atlas.jpg', sourceUrl: sources[0].url, contentType: 'image/jpeg', width: 1200, height: 675, bytes: 100000, validated: true }],
    requireImage: true,
  });
  assert.equal(packet.quality.passed, true);
  assert.equal(packet.quality.independent_domains, 2);
  assert.equal(packet.quality.grounded_facts, 3);
  assert.ok(packet.topic_id.length >= 16);
});

test('Telegram text fallback is never reported as a delivered photo', async () => {
  const { sendTelegramPhoto } = require('../telegram');
  const result = await sendTelegramPhoto('', '123', fakePng(1200, 675), 'Verified image');
  assert.equal(result.deliveryKind, 'text');
  assert.equal(result.photoSent, false);
});

test('image validation rejects tiny/logo assets and accepts a large editorial PNG', () => {
  assert.ok(scoreImageCandidate({ url: 'https://example.com/favicon-logo.png', source: 'source-page-meta' }, 'product launch') < 0);
  assert.ok(scoreImageCandidate({ url: 'https://example.com/social-media-card-press-release.png', source: 'source-page-meta' }, 'product launch') < 0);
  assert.equal(validateImageBytes(fakePng(120, 120), { contentType: 'image/png' }).ok, false);
  const accepted = validateImageBytes(fakePng(1200, 675), { contentType: 'image/png' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.width, 1200);
  assert.equal(accepted.height, 675);
});

test('research report gate requires verified citations and rejects invented numbers', () => {
  const packet = {
    sources: [
      { readable_text: 'Atlas launched in 2026 after a pilot with 40 customers.' },
      { readable_text: 'Independent reporting confirmed public availability in August 2026.' },
    ],
    facts: [
      { claim: 'Atlas launched in 2026 after a pilot with 40 customers.' },
      { claim: 'Public availability was independently confirmed in August 2026.' },
    ],
  };
  const valid = validateResearchReport(
    `${'Atlas reached public availability after its documented pilot. '.repeat(10)} The launch involved 40 customers in 2026 [1], and independent reporting confirmed the August release [2].`,
    packet,
    { minChars: 300 },
  );
  assert.equal(valid.ok, true);

  const invented = validateResearchReport(
    `${'Atlas reached public availability after its documented pilot. '.repeat(10)} The company claimed 900 customers in 2026 [1] and cited the independent report [2].`,
    packet,
    { minChars: 300 },
  );
  assert.equal(invented.ok, false);
  assert.ok(invented.errors.some((error) => error.includes('unsupported_numbers:900')));
});

test('variant gate catches placeholders and counts hashtags inside the X limit', () => {
  const placeholder = validateVariant('linkedin', {
    description: '[account] launched something important. '.repeat(5),
    hashtags: ['technology'],
  });
  assert.equal(placeholder.ok, false);
  assert.ok(placeholder.errors.includes('placeholder'));

  const tooLong = validateVariant('x', {
    description: 'A'.repeat(255),
    hashtags: ['technology', 'innovation'],
  });
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.errors.includes('too_long_with_hashtags'));
  const fitted = fitVariantToLimit('x', tooLong.variant);
  const fittedCheck = validateVariant('x', fitted);
  assert.equal(fittedCheck.ok, true);
  assert.ok(fittedCheck.renderedLength <= 278);

  const normalized = fitVariantToLimit('linkedin', {
    description: '- Verified fact from the report.\n- The second finding matters.\nSource: https://example.com/report\nThis conclusion remains supported by the cited evidence.',
    hashtags: ['Research', 'Technology'],
  });
  assert.doesNotMatch(normalized.description, /https?:\/\/|^\s*-/m);

  const valid = validateVariant('x', {
    description: 'Verified reporting shows the project reached its first public milestone, giving builders a concrete signal about what comes next.',
    hashtags: ['Web3', 'Technology'],
  });
  assert.equal(valid.ok, true);
});
