// Minimal Telegram Bot API client. Reads TG_BOT_TOKEN + TG_CHAT_ID from env.
// Outbound notify (sendMessage) no-ops gracefully if token/chat missing.
// The inbound control bot (lib/telegram-bot.js) uses getUpdates /
// answerCallbackQuery / editMessageText via the shared callApi helper.

const https = require('https');

function tgEnabled() {
  return Boolean(process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID);
}

// Generic Bot API call. Resolves parsed JSON; on any error resolves
// { ok:false, ... } and never rejects — callers can fire-and-forget safely.
function callApi(method, params = {}, { timeoutMs = 15000 } = {}) {
  if (!process.env.TG_BOT_TOKEN) {
    return Promise.resolve({ ok: false, skipped: true });
  }
  return new Promise((resolve) => {
    const payload = JSON.stringify(params);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${process.env.TG_BOT_TOKEN}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: false, raw: data.slice(0, 200) }); }
        });
      }
    );
    req.on('error', (e) => { console.warn(`[telegram] ${method} error:`, e.message); resolve({ ok: false, error: e.message }); });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function sendMessage(text, opts = {}) {
  if (!tgEnabled()) {
    console.log('[telegram] skipped (TG_BOT_TOKEN or TG_CHAT_ID not set)');
    return Promise.resolve({ ok: false, skipped: true });
  }
  const params = {
    chat_id: opts.chatId || process.env.TG_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };
  if (!opts.plain) params.parse_mode = opts.parseMode || 'Markdown';
  if (opts.replyMarkup) params.reply_markup = opts.replyMarkup;
  return callApi('sendMessage', params);
}

// Long-poll. offset = last seen update_id + 1; timeoutSec = server-side hold.
function getUpdates(offset, timeoutSec = 25) {
  return callApi(
    'getUpdates',
    { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
    { timeoutMs: (timeoutSec + 10) * 1000 }
  );
}

function answerCallbackQuery(id, text) {
  return callApi('answerCallbackQuery', { callback_query_id: id, text: text || '' });
}

// 下載 Telegram 檔（photo/doc）去本地 destPath。先 getFile 攞 file_path,再由 file API 下載。
function downloadFile(fileId, destPath) {
  if (!process.env.TG_BOT_TOKEN) return Promise.resolve(false);
  return callApi('getFile', { file_id: fileId }).then((r) => {
    const fp = r && r.ok && r.result && r.result.file_path;
    if (!fp) return false;
    return new Promise((resolve) => {
      const fs = require('fs');
      const file = fs.createWriteStream(destPath);
      const req = https.get(`https://api.telegram.org/file/bot${process.env.TG_BOT_TOKEN}/${fp}`, (res) => {
        if (res.statusCode !== 200) { try { file.close(); } catch (_) {} resolve(false); return; }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(true)));
      });
      req.on('error', () => { try { file.close(); } catch (_) {} resolve(false); });
      req.setTimeout(30000, () => { try { req.destroy(); file.close(); } catch (_) {} resolve(false); }); // 防卡死 queue
    });
  }).catch(() => false);
}

function editMessageText(chatId, messageId, text, opts = {}) {
  const params = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: opts.parseMode || 'Markdown',
    disable_web_page_preview: true,
  };
  if (opts.replyMarkup) params.reply_markup = opts.replyMarkup;
  return callApi('editMessageText', params);
}

module.exports = { sendMessage, tgEnabled, getUpdates, answerCallbackQuery, editMessageText, callApi, downloadFile };
