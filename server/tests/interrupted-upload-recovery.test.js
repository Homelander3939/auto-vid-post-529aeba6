const test = require('node:test');
const assert = require('node:assert/strict');

const { recoverInterruptedJobRow, scheduledStatusAfterInterruption } = require('../interrupted-upload-recovery');

test('an interrupted upload becomes retryable terminal state without losing successes', () => {
  const recovered = recoverInterruptedJobRow({
    status: 'uploading',
    platform_results: [
      { name: 'youtube', status: 'success', url: 'https://example.test/video' },
      { name: 'tiktok', status: 'uploading' },
      { name: 'instagram', status: 'pending' },
    ],
  }, '2026-08-25T00:00:00.000Z');

  assert.equal(recovered.status, 'partial');
  assert.equal(recovered.platform_results[0].status, 'success');
  assert.equal(recovered.platform_results[1].status, 'error');
  assert.equal(recovered.platform_results[2].status, 'error');
  assert.match(recovered.platform_results[1].error, /safe retry/i);
  assert.equal(recovered.recovery_reason, 'interrupted_uploader_worker');
});

test('processing schedule never remains locked after a server interruption', () => {
  assert.equal(scheduledStatusAfterInterruption('completed'), 'completed');
  assert.equal(scheduledStatusAfterInterruption('partial'), 'error');
  assert.equal(scheduledStatusAfterInterruption('failed'), 'error');
  assert.equal(scheduledStatusAfterInterruption(undefined), 'error');
});
