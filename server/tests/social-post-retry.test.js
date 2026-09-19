const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareMissingPlatformRetry } = require('../socialPostProcessor');

test('social retry preserves successful URLs and retries only missing platforms', () => {
  const retry = prepareMissingPlatformRetry({
    status: 'partial',
    target_platforms: ['x', 'linkedin', 'facebook'],
    updated_at: '2026-09-19T10:00:00.000Z',
    platform_results: [
      { name: 'x', status: 'error', error: 'composer failed' },
      { name: 'linkedin', status: 'success', url: 'https://linkedin.example/post' },
      { name: 'facebook', status: 'success', url: 'https://facebook.example/post' },
    ],
  }, Date.parse('2026-09-19T12:00:00.000Z'));

  assert.equal(retry.canRetry, true);
  assert.deepEqual(retry.retryPlatforms, ['x']);
  assert.deepEqual(retry.results[0], { name: 'x', status: 'pending' });
  assert.equal(retry.results[1].url, 'https://linkedin.example/post');
  assert.equal(retry.results[2].url, 'https://facebook.example/post');
});

test('social retry does not take over a recently active processing row', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z');
  const retry = prepareMissingPlatformRetry({
    status: 'processing',
    updated_at: '2026-09-19T11:50:00.000Z',
    target_platforms: ['x'],
  }, now);

  assert.equal(retry.canRetry, false);
  assert.equal(retry.recentlyProcessing, true);
});
