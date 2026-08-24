const fetch = require('node-fetch');

function normalizeChatId(chatId) {
  if (chatId === null || chatId === undefined) return null;
  const raw = String(chatId).trim();
  if (!raw) return null;
  const asNum = Number(raw);
  return Number.isFinite(asNum) ? asNum : raw;
}

async function sendViaBotToken(botToken, chatId, payload) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = { chat_id: chatId, ...payload };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(`Telegram error [${res.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendChatActionViaBotToken(botToken, chatId, action = 'typing') {
  if (!botToken) throw new Error('Telegram bot token is required');
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(`Telegram action error [${res.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendPhotoViaBotToken(botToken, chatId, photoBuffer, caption = '', options = {}) {
  if (!botToken) throw new Error('Telegram bot token is required');
  if (typeof globalThis.fetch !== 'function' || typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('Direct photo upload requires Node 18+ fetch/FormData support');
  }
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  const mimeType = /^image\/(?:jpeg|jpg|png|webp)$/i.test(String(options.mimeType || ''))
    ? String(options.mimeType).toLowerCase().replace('image/jpg', 'image/jpeg')
    : 'image/jpeg';
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const fileName = String(options.fileName || `photo.${extension}`).replace(/[^a-zA-Z0-9._-]/g, '-');
  form.append('photo', new Blob([photoBuffer], { type: mimeType }), fileName);
  const res = await globalThis.fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(`Telegram photo error [${res.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendViaEdgeFunction(payload, backend) {
  if (!backend?.supabaseUrl || !backend?.supabaseKey) {
    throw new Error('Edge function fallback unavailable (missing backend credentials)');
  }

  const response = await fetch(`${backend.supabaseUrl}/functions/v1/send-telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${backend.supabaseKey}`,
      apikey: backend.supabaseKey,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.success) {
    throw new Error(`send-telegram failed [${response.status}]: ${data?.error || JSON.stringify(data)}`);
  }
  return data;
}

async function sendTelegram(botToken, chatId, message, backend) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    console.log('[Telegram] Skipped — no chat ID configured');
    return null;
  }

  if (!botToken) {
    console.log('[Telegram] Skipped — no local bot token configured');
    return null;
  }
  return sendViaBotToken(botToken, normalizedChatId, {
    text: message,
    disable_web_page_preview: true,
    link_preview_options: { is_disabled: true },
  });
}

async function sendTelegramPhoto(botToken, chatId, photoBuffer, caption = '', backend, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId || !photoBuffer) return null;

  if (botToken) {
    try {
      const result = await sendPhotoViaBotToken(botToken, normalizedChatId, photoBuffer, caption, options);
      return { ...result, deliveryKind: 'photo', photoSent: true };
    } catch (e) {
      console.warn('[Telegram] Direct bot photo send failed, trying edge-function fallback...');
    }
  }

  if (backend?.supabaseUrl && backend?.supabaseKey) {
    const result = await sendViaEdgeFunction({
      chat_id: normalizedChatId,
      text: caption,
      photo_base64: Buffer.from(photoBuffer).toString('base64'),
      photo_mime_type: options.mimeType || 'image/jpeg',
    }, backend);
    return { ...result, deliveryKind: 'photo', photoSent: true };
  }

  // A text notice is useful, but it must never be reported as a successful
  // photo delivery. Callers can now fail or retry the image contract honestly.
  const result = await sendTelegram(botToken, normalizedChatId, `${caption}\n\n(Preview image unavailable in current local setup)`, backend);
  return { ...(result || {}), deliveryKind: 'text', photoSent: false };
}

module.exports = { sendTelegram, sendTelegramPhoto, sendChatActionViaBotToken };
