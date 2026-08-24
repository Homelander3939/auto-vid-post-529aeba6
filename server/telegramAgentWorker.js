// Lightweight, local-only Telegram AI worker.
//
// The full uploader server is intentionally stopped while the video factory is
// producing assets. This process keeps Telegram chat and vision available
// without starting upload, schedule, folder-watch, or browser-publishing loops.

const fs = require('fs');
const net = require('net');
const path = require('path');

function loadLocalEnv() {
  const dotenvPath = path.join(__dirname, '.env');
  if (!fs.existsSync(dotenvPath)) return;
  for (const line of fs.readFileSync(dotenvPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();
// Reuse the one model already loaded by the generation factory. This worker
// must not eject it just to honor the uploader UI preference.
process.env.LM_STUDIO_PRESERVE_LOADED_MODEL = '1';

const { createLocalSupabaseClient } = require('./localDatabase');
const { processTelegramAIResponse, redactSensitiveText } = require('./ai-handler');
const { sendTelegram, sendTelegramPhoto } = require('./telegram');
const { startLocalTelegramPoller } = require('./telegramPoller');

const FULL_SERVER_PORT = Number(process.env.PORT || 3001);
const COMMAND_INTERVAL_MS = 3_000;
const SERVER_CHECK_INTERVAL_MS = 5_000;

function fullServerIsListening(port = FULL_SERVER_PORT) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return typeof value === 'string' ? redactSensitiveText(value) : value;
}

async function createSettingsReader(supabase) {
  return async function getSettings() {
    const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
    if (!data) throw new Error('No local uploader settings found.');

    let chatId = data.telegram_chat_id ? String(data.telegram_chat_id).trim() : '';
    if (data.telegram_enabled && !chatId) {
      const { data: messages } = await supabase
        .from('telegram_messages')
        .select('chat_id')
        .eq('is_bot', false)
        .order('created_at', { ascending: false })
        .limit(1);
      const recovered = messages?.[0]?.chat_id;
      if (recovered !== null && recovered !== undefined && String(recovered).trim()) {
        chatId = String(recovered).trim();
        await supabase.from('app_settings').update({ telegram_chat_id: chatId }).eq('id', 1);
      }
    }

    return {
      telegram: {
        botToken: data.telegram_bot_token,
        chatId,
        enabled: data.telegram_enabled === true,
      },
      local_agent_url: data.local_agent_url || 'http://localhost:3001',
      backend: null,
    };
  };
}

async function run() {
  if (await fullServerIsListening()) {
    console.log(`[TelegramAgentWorker] Full uploader already owns port ${FULL_SERVER_PORT}; nothing to do.`);
    return;
  }

  const supabase = createLocalSupabaseClient();
  const getSettings = await createSettingsReader(supabase);
  const runningCommands = new Set();
  let stopped = false;
  let commandTimer = null;
  let serverTimer = null;

  const telegramPoller = startLocalTelegramPoller({ supabase, getSettings });

  async function processPendingAICommands() {
    if (stopped) return;
    try {
      const { data: commands } = await supabase
        .from('pending_commands')
        .select('*')
        .eq('status', 'pending')
        .eq('command', 'ai_response')
        .order('created_at', { ascending: true })
        .limit(3);

      for (const command of commands || []) {
        if (runningCommands.has(command.id)) continue;
        runningCommands.add(command.id);
        await supabase.from('pending_commands').update({ status: 'processing' }).eq('id', command.id);

        (async () => {
          try {
            const settings = await getSettings();
            const chatId = command.args?.chat_id ? String(command.args.chat_id) : settings.telegram.chatId;
            await processTelegramAIResponse(
              supabase,
              { ...(command.args || {}), chat_id: chatId },
              (_token, targetChatId, message) => sendTelegram(settings.telegram.botToken, targetChatId, message, null),
              null,
              (_token, targetChatId, buffer, caption, _backend, options) => sendTelegramPhoto(
                settings.telegram.botToken,
                targetChatId,
                buffer,
                caption,
                null,
                options,
              ),
            );
            await supabase.from('pending_commands').update({
              status: 'completed',
              result: 'ai_reply_sent',
              args: redactValue(command.args || {}),
              completed_at: new Date().toISOString(),
            }).eq('id', command.id);
            console.log(`[TelegramAgentWorker] Completed ${command.id}.`);
          } catch (error) {
            const attempts = Number(command.attempts || 0) + 1;
            const retry = attempts < 5;
            const publicError = redactSensitiveText(error?.message || String(error));
            await supabase.from('pending_commands').update({
              status: retry ? 'pending' : 'failed',
              attempts,
              result: publicError,
              completed_at: retry ? null : new Date().toISOString(),
            }).eq('id', command.id).catch(() => {});
            console.warn(`[TelegramAgentWorker] ${command.id} ${retry ? 'will retry' : 'failed'}: ${publicError}`);
          } finally {
            runningCommands.delete(command.id);
          }
        })();
      }
    } catch (error) {
      console.warn('[TelegramAgentWorker] Command poll failed:', redactSensitiveText(error?.message || String(error)));
    }
  }

  async function stop(reason) {
    if (stopped) return;
    stopped = true;
    telegramPoller.stop();
    if (commandTimer) clearInterval(commandTimer);
    if (serverTimer) clearInterval(serverTimer);
    console.log(`[TelegramAgentWorker] Stopping: ${reason}`);
    const deadline = Date.now() + 30_000;
    while (runningCommands.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.exit(runningCommands.size === 0 ? 0 : 2);
  }

  commandTimer = setInterval(() => processPendingAICommands(), COMMAND_INTERVAL_MS);
  serverTimer = setInterval(async () => {
    if (await fullServerIsListening()) await stop('full uploader server is healthy');
  }, SERVER_CHECK_INTERVAL_MS);
  processPendingAICommands();
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  console.log('[TelegramAgentWorker] Active: Telegram text and vision only; uploader/schedule loops remain off.');
}

if (require.main === module) {
  run().catch((error) => {
    console.error('[TelegramAgentWorker] Fatal:', redactSensitiveText(error?.message || String(error)));
    process.exit(1);
  });
}

module.exports = { createSettingsReader, fullServerIsListening, redactValue, run };
