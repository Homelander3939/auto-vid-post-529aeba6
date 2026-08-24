const fetch = require('node-fetch');
const { responseToValidatedImage } = require('./visualMedia');

const STATE_TABLE = 'telegram_bot_state';
const STATE_ID = 'local-ai-poller';
const DEFAULT_INTERVAL_MS = 3000;

function inboundMessageId(updateId) {
  return `telegram-in-${Number(updateId)}`;
}

function commandId(updateId) {
  return `telegram-ai-${Number(updateId)}`;
}

function telegramImageCandidates(message) {
  const candidates = [];
  const photos = Array.isArray(message?.photo) ? message.photo.filter((item) => item?.file_id) : [];
  if (photos.length > 0) {
    const photo = [...photos].sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0))[0];
    candidates.push({
      fileId: photo.file_id,
      uniqueId: photo.file_unique_id || null,
      name: `telegram-photo-${message.message_id || Date.now()}.jpg`,
      type: 'image/jpeg',
      size: Number(photo.file_size || 0),
    });
  }
  const document = message?.document;
  if (document?.file_id && String(document.mime_type || '').startsWith('image/')) {
    candidates.push({
      fileId: document.file_id,
      uniqueId: document.file_unique_id || null,
      name: document.file_name || `telegram-image-${message.message_id || Date.now()}`,
      type: document.mime_type,
      size: Number(document.file_size || 0),
    });
  }
  return candidates;
}

function extractTelegramMessage(update) {
  const message = update?.message || update?.edited_message;
  if (!message || message?.from?.is_bot) return null;
  const text = String(message.text || message.caption || '').trim();
  const imageCandidates = telegramImageCandidates(message);
  if (!text && imageCandidates.length === 0) return null;
  return {
    updateId: Number(update.update_id),
    chatId: message.chat?.id,
    messageId: message.message_id,
    messageDate: message.date,
    text,
    edited: Boolean(update.edited_message),
    hasAttachments: Boolean(message.photo || message.document || message.video || message.audio || message.voice),
    imageCandidates,
  };
}

function sameChat(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return String(left).trim() === String(right).trim();
}

async function telegramApi(botToken, method, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(`Telegram ${method} failed with status ${response.status}`);
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function hydrateTelegramImages(botToken, incoming, supabase, options = {}) {
  const images = [];
  for (const [index, candidate] of (incoming.imageCandidates || []).entries()) {
    if (candidate.size > 10 * 1024 * 1024) throw new Error('Telegram image exceeds the 10 MB local vision limit');
    const file = await (options.telegramApiImpl || telegramApi)(botToken, 'getFile', { file_id: candidate.fileId });
    if (!file?.file_path) throw new Error('Telegram did not return an image file path');
    const response = await (options.fetchImpl || fetch)(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    const validated = await responseToValidatedImage(response, { declaredType: candidate.type });
    const extension = validated.mimeType === 'image/png' ? 'png'
      : validated.mimeType === 'image/webp' ? 'webp'
        : validated.mimeType === 'image/gif' ? 'gif' : 'jpg';
    const safeBase = String(candidate.name || `telegram-image-${index + 1}`)
      .replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || `telegram-image-${index + 1}`;
    const storagePath = `telegram/${incoming.chatId}/${incoming.updateId}-${index}-${safeBase}.${extension}`;
    const { error } = await supabase.storage.from('videos').upload(storagePath, validated.buffer, {
      contentType: validated.mimeType,
      upsert: true,
    });
    if (error) throw new Error(error.message || String(error));
    const { data } = supabase.storage.from('videos').getPublicUrl(storagePath);
    images.push({
      name: `${safeBase}.${extension}`,
      type: validated.mimeType,
      size: validated.byteLength,
      url: data.publicUrl,
      storage_path: storagePath,
      telegram_file_unique_id: candidate.uniqueId,
    });
  }
  return images;
}

async function readOne(supabase, table, column, value) {
  const { data, error } = await supabase.from(table).select('*').eq(column, value).maybeSingle();
  if (error) throw new Error(error.message || String(error));
  return data;
}

async function saveState(supabase, values) {
  const existing = await readOne(supabase, STATE_TABLE, 'id', STATE_ID);
  const { error } = await supabase.from(STATE_TABLE).upsert({
    ...(existing || {}),
    id: STATE_ID,
    ...values,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message || String(error));
}

async function persistInboundUpdate(supabase, incoming) {
  const existingMessage = await readOne(supabase, 'telegram_messages', 'update_id', incoming.updateId);
  if (!existingMessage) {
    const { error } = await supabase.from('telegram_messages').insert({
      id: inboundMessageId(incoming.updateId),
      update_id: incoming.updateId,
      chat_id: incoming.chatId,
      text: incoming.text,
      is_bot: false,
      raw_update: {
        source: 'local-telegram-poller',
        message_id: incoming.messageId,
        message_date: incoming.messageDate,
        edited: incoming.edited,
        has_attachments: incoming.hasAttachments,
        media: {
          images: Array.isArray(incoming.images) ? incoming.images : [],
          files: [],
        },
        visual_error: incoming.visualError || null,
      },
    });
    if (error) throw new Error(error.message || String(error));
  }

  const existingCommand = await readOne(supabase, 'pending_commands', 'id', commandId(incoming.updateId));
  if (incoming.text && !existingCommand) {
    const { error } = await supabase.from('pending_commands').insert({
      id: commandId(incoming.updateId),
      command: 'ai_response',
      args: {
        update_id: incoming.updateId,
        chat_id: incoming.chatId,
        user_text: incoming.text,
        images: Array.isArray(incoming.images) ? incoming.images : [],
        files: [],
        source: 'local-telegram-poller',
      },
      status: 'pending',
      attempts: 0,
      source: 'local-telegram-poller',
    });
    if (error) throw new Error(error.message || String(error));
  }
}

async function recoverInterruptedCommands(supabase) {
  const { data: commands, error } = await supabase.from('pending_commands')
    .select('*').eq('command', 'ai_response').order('created_at', { ascending: true });
  if (error) throw new Error(error.message || String(error));
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const command of commands || []) {
    if (command?.args?.source !== 'local-telegram-poller') continue;
    const replyUpdateId = Number(command.args?.update_id) + 1_000_000_000;
    const reply = await readOne(supabase, 'telegram_messages', 'update_id', replyUpdateId);
    const isStaleProcessing = command.status === 'processing'
      && new Date(command.updated_at || command.created_at || 0).getTime() < cutoff;
    const needsTelegramRetry = command.status === 'failed' && reply && reply.raw_update?.telegram_sent !== true
      && Number(command.attempts || 0) < 5;
    if (reply?.raw_update?.telegram_sent === true && command.status !== 'completed') {
      await supabase.from('pending_commands').update({
        status: 'completed', result: 'ai_reply_sent', completed_at: new Date().toISOString(),
      }).eq('id', command.id);
    } else if (isStaleProcessing || needsTelegramRetry) {
      await supabase.from('pending_commands').update({
        status: 'pending',
        attempts: Number(command.attempts || 0) + 1,
        completed_at: null,
      }).eq('id', command.id);
    }
  }
}

function startLocalTelegramPoller({ supabase, getSettings, intervalMs = DEFAULT_INTERVAL_MS }) {
  let timer = null;
  let polling = false;
  let stopped = false;
  let webhookCheckedForToken = null;

  async function pollOnce() {
    if (polling || stopped) return;
    polling = true;
    try {
      const settings = await getSettings();
      const telegram = settings?.telegram || {};
      if (!telegram.enabled || !telegram.botToken) return;

      if (webhookCheckedForToken !== telegram.botToken) {
        const webhook = await telegramApi(telegram.botToken, 'getWebhookInfo');
        if (webhook?.url) {
          await telegramApi(telegram.botToken, 'deleteWebhook', { drop_pending_updates: false });
          console.log('[TelegramPoller] Removed webhook so the configured bot remains local-only.');
        }
        webhookCheckedForToken = telegram.botToken;
        await recoverInterruptedCommands(supabase);
      }

      const state = await readOne(supabase, STATE_TABLE, 'id', STATE_ID);
      const offset = Number(state?.next_offset || 0);
      const updates = await telegramApi(telegram.botToken, 'getUpdates', {
        offset,
        limit: 25,
        timeout: 0,
        allowed_updates: ['message', 'edited_message'],
      });

      for (const update of Array.isArray(updates) ? updates : []) {
        const updateId = Number(update?.update_id);
        if (!Number.isFinite(updateId)) continue;
        const incoming = extractTelegramMessage(update);
        if (incoming && (!telegram.chatId || sameChat(incoming.chatId, telegram.chatId))) {
          try {
            incoming.images = await hydrateTelegramImages(telegram.botToken, incoming, supabase);
          } catch (error) {
            incoming.images = [];
            incoming.visualError = String(error.message || error).slice(0, 300);
            if (!incoming.text) incoming.text = `The attached image could not be imported for local vision: ${incoming.visualError}`;
          }
          await persistInboundUpdate(supabase, incoming);
          console.log(`[TelegramPoller] Stored inbound update ${incoming.updateId}${incoming.text ? ' and queued one local AI response' : ' with local visual context'}.`);
        } else if (incoming && telegram.chatId && !sameChat(incoming.chatId, telegram.chatId)) {
          console.warn(`[TelegramPoller] Ignored update ${updateId} from an unconfigured chat.`);
        }
        await saveState(supabase, {
          next_offset: updateId + 1,
          last_update_id: updateId,
          last_poll_at: new Date().toISOString(),
          last_error: null,
        });
      }

      if (!Array.isArray(updates) || updates.length === 0) {
        await saveState(supabase, { last_poll_at: new Date().toISOString(), last_error: null });
      }
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'Telegram polling timed out' : (error.message || String(error));
      console.warn('[TelegramPoller] Poll failed:', message);
      await saveState(supabase, { last_poll_at: new Date().toISOString(), last_error: message.slice(0, 500) }).catch(() => {});
    } finally {
      polling = false;
    }
  }

  pollOnce();
  timer = setInterval(pollOnce, Math.max(1000, Number(intervalMs) || DEFAULT_INTERVAL_MS));
  console.log(`[TelegramPoller] Active: local Telegram inbound messages every ${Math.max(1000, Number(intervalMs) || DEFAULT_INTERVAL_MS)}ms.`);
  return {
    pollOnce,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = {
  commandId,
  extractTelegramMessage,
  hydrateTelegramImages,
  inboundMessageId,
  persistInboundUpdate,
  recoverInterruptedCommands,
  startLocalTelegramPoller,
  telegramImageCandidates,
};
