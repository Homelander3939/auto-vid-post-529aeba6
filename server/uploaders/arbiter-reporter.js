// Persists every upload-arbiter escalation into the local AI Chat history and
// mirrors the same text to the configured Telegram chat. Reporting is best
// effort: a Telegram outage must never stop or fail an upload recovery.

const { randomUUID } = require('crypto');
const { listRows, saveRow } = require('../localDatabase');
const { sendTelegram } = require('../telegram');

const TRACE_SOURCE = 'local-upload-arbiter';

function clean(value, max = 900) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function formatAction(details = {}) {
  const action = clean(details.action || 'none', 80);
  const target = clean(details.target || '', 180);
  return target ? `${action} — ${target}` : action;
}

function formatArbiterTrace(phase, details = {}) {
  const platform = clean(details.platform || 'Unknown platform', 100);
  const checkpoint = clean(details.checkpoint || 'Unknown checkpoint', 140);
  const model = clean(details.model || 'safe DOM fallback', 180);

  if (phase === 'received') {
    return [
      '🧠 Local upload arbiter received a stuck workflow',
      `Platform: ${platform}`,
      `Checkpoint: ${checkpoint}`,
      `Problem received: ${clean(details.problem || 'Uploader checkpoint stalled.', 1200)}`,
      `Local model: ${model}`,
      'Safety lock: credentials, verification codes, file selection, navigation, and final Post/Publish/Share actions are forbidden.',
    ].join('\n');
  }

  if (phase === 'answer') {
    return [
      '🤖 Local AI arbiter answer',
      `Platform: ${platform}`,
      `Model: ${model}`,
      `Diagnosis: ${clean(details.answer || 'No explanation returned.', 1200)}`,
      `Proposed action: ${formatAction(details)}`,
      `Safety decision: ${details.executed ? 'allowed and executed' : `not executed${details.denialReason ? ` — ${clean(details.denialReason, 500)}` : ''}`}`,
    ].join('\n');
  }

  const recovered = phase === 'resolved';
  return [
    recovered ? '✅ Local upload arbiter solved the obstacle' : '⚠️ Local upload arbiter could not safely solve the obstacle',
    `Platform: ${platform}`,
    `Checkpoint: ${checkpoint}`,
    `Result: ${clean(details.result || (recovered ? 'Checkpoint verified; normal uploader resumed.' : 'No permitted action produced a verified recovery.'), 1200)}`,
    details.action ? `Safe action: ${formatAction(details)}` : '',
    details.artifactPath ? `Local diagnostic: ${clean(details.artifactPath, 500)}` : '',
    recovered
      ? 'The existing uploader continued from the recovered checkpoint.'
      : 'The existing retry or human-assistance path remains active; the arbiter did not force submission.',
  ].filter(Boolean).join('\n');
}

function getTelegramSettings() {
  const row = listRows('app_settings').find((item) => String(item.id) === '1') || {};
  return {
    enabled: row.telegram_enabled === true,
    botToken: String(row.telegram_bot_token || '').trim(),
    chatId: String(row.telegram_chat_id || '').trim(),
  };
}

async function reportArbiterEvent(phase, details = {}) {
  const text = formatArbiterTrace(phase, details).slice(0, 3800);
  const settings = getTelegramSettings();
  let telegramSent = false;
  let telegramMessageId = null;
  let telegramError = '';

  if (settings.enabled && settings.botToken && settings.chatId) {
    try {
      const telegramResponse = await sendTelegram(settings.botToken, settings.chatId, text, null);
      telegramSent = true;
      telegramMessageId = telegramResponse?.result?.message_id ?? null;
    } catch (error) {
      telegramError = clean(error?.message || error, 500);
      console.warn(`[UploadArbiter] Telegram trace delivery failed: ${telegramError}`);
    }
  }

  try {
    const numericChatId = Number(settings.chatId);
    saveRow('telegram_messages', {
      id: randomUUID(),
      update_id: -Math.floor(Date.now() + Math.random() * 1000),
      chat_id: Number.isFinite(numericChatId) ? numericChatId : 0,
      text,
      is_bot: true,
      raw_update: {
        source: TRACE_SOURCE,
        arbiter: {
          phase,
          platform: clean(details.platform, 100),
          checkpoint: clean(details.checkpoint, 140),
          model: clean(details.model, 180),
          artifactPath: clean(details.artifactPath, 500),
        },
        delivery: { telegramSent, telegramMessageId, telegramError },
      },
    });
  } catch (error) {
    console.warn(`[UploadArbiter] AI Chat trace persistence failed: ${error.message}`);
  }

  return { text, telegramSent, telegramMessageId, telegramError };
}

module.exports = {
  reportArbiterEvent,
  __test: { formatArbiterTrace },
};
