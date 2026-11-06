/**
 * botState.js
 * Shared state module that bridges index.js (WhatsApp bot) and server.js (Express dashboard).
 */

const EventEmitter = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(30);

const state = {
  status: 'initializing', // 'initializing' | 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'auth_failure'
  qr: null,               // base64 data-URL of the QR image
  qrRaw: null,            // raw qr string from whatsapp-web.js
  logs: [],               // rolling log buffer (max 200 entries)
  info: null,             // client.info once ready
  startedAt: Date.now(),
};

const MAX_LOGS = 200;

function pushLog(level, message) {
  const entry = { level, message, ts: new Date().toISOString() };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) state.logs.shift();
  emitter.emit('log', entry);
}

function setStatus(newStatus) {
  state.status = newStatus;
  emitter.emit('status', newStatus);
}

function setQr(qrRaw, qrDataUrl) {
  state.qr = qrDataUrl;
  state.qrRaw = qrRaw;
  emitter.emit('qr', { raw: qrRaw, dataUrl: qrDataUrl });
}

function setInfo(info) {
  state.info = info;
  emitter.emit('info', info);
}

module.exports = { state, emitter, pushLog, setStatus, setQr, setInfo };
