function recoverInterruptedJobRow(job, finishedAt = new Date().toISOString()) {
  const results = Array.isArray(job?.platform_results)
    ? job.platform_results.map((item) => ({ ...item }))
    : [];
  let changed = false;
  for (const platform of results) {
    if (platform.status === 'uploading' || platform.status === 'pending') {
      const wasUploading = platform.status === 'uploading';
      platform.status = 'error';
      platform.error = wasUploading
        ? 'Uploader worker stopped before this platform confirmed completion. Source files were kept for a safe retry.'
        : 'Uploader worker stopped before this platform started. Source files were kept for a safe retry.';
      changed = true;
    }
  }
  if (!changed && job?.status !== 'uploading') return null;

  const successCount = results.filter((item) => item.status === 'success').length;
  return {
    platform_results: results,
    status: successCount > 0 ? 'partial' : 'failed',
    completed_at: finishedAt,
    recovery_reason: 'interrupted_uploader_worker',
  };
}

function scheduledStatusAfterInterruption(jobStatus) {
  return jobStatus === 'completed' ? 'completed' : 'error';
}

module.exports = { recoverInterruptedJobRow, scheduledStatusAfterInterruption };
