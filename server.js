/**
 * server.js
 * Express + WebSocket dashboard server for the WhatsApp Tuition Bot.
 * Run with: node server.js
 *
 * Security: set DASHBOARD_USER and DASHBOARD_PASS environment variables.
 * Default (dev only): admin / admin
 */

// Load .env file if present (optional — fine to skip in production with real env vars)
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { state, emitter, setStatus } = require('./botState');

// ── Credentials (from env vars) ───────────────────────────────────────────────
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'admin';

if (!process.env.DASHBOARD_PASS) {
  console.warn('[Security] WARNING: DASHBOARD_PASS not set. Using default password "admin". Set it before deploying!');
}

// Constant-time comparison to prevent timing attacks
function safeCompare(a, b) {
  const bA = Buffer.from(a);
  const bB = Buffer.from(b);
  if (bA.length !== bB.length) return false;
  return crypto.timingSafeEqual(bA, bB);
}

// ── Basic Auth middleware ─────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Tuition Bot Dashboard"');
    return res.status(401).send('Authentication required.');
  }
  const [user, pass] = Buffer.from(authHeader.slice(6), 'base64').toString().split(':');
  if (safeCompare(user || '', DASHBOARD_USER) && safeCompare(pass || '', DASHBOARD_PASS)) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Tuition Bot Dashboard"');
  return res.status(401).send('Invalid credentials.');
}

// ── Simple in-memory rate limiter (no extra packages) ────────────────────────
const rateLimitMap = new Map();
function rateLimit(maxPerMinute = 60) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const window = 60_000;
    const entry = rateLimitMap.get(ip) || { count: 0, start: now };
    if (now - entry.start > window) { entry.count = 0; entry.start = now; }
    entry.count++;
    rateLimitMap.set(ip, entry);
    if (entry.count > maxPerMinute) return res.status(429).json({ ok: false, error: 'Too many requests' });
    next();
  };
}
// Clean up rate limit map every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, entry] of rateLimitMap) if (entry.start < cutoff) rateLimitMap.delete(ip);
}, 5 * 60_000);

// ── Config path ──────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.js');

// ── App setup ────────────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

// Body size limit (prevent large payload attacks)
app.use(express.json({ limit: '50kb' }));

// Serve static files (login page doesn't require auth — browser handles Basic Auth prompt)
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, verifyClient: verifyWsClient });

// ── WebSocket auth: verify Basic Auth header on upgrade ──────────────────────
function verifyWsClient(info) {
  const authHeader = info.req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(authHeader.slice(6), 'base64').toString().split(':');
  return safeCompare(user || '', DASHBOARD_USER) && safeCompare(pass || '', DASHBOARD_PASS);
}

// ── WebSocket broadcast helpers ───────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// Forward bot events to all connected browsers
emitter.on('status', (s) => broadcast('status', s));
emitter.on('qr', (q) => broadcast('qr', q));
emitter.on('log', (l) => broadcast('log', l));
emitter.on('info', (i) => broadcast('info', i));

async function disconnectWhatsAppClient() {
  const client = global.whatsappClient;
  if (!client) return false;

  await client.destroy();
  if (client.authStrategy?.retryPendingCleanup) {
    await client.authStrategy.retryPendingCleanup();
  }
  setStatus('disconnected');
  return true;
}

async function reconnectWhatsAppClient() {
  const client = global.whatsappClient;
  if (!client) return { ok: false, message: 'No client instance' };

  if (state.status !== 'disconnected') {
    return { ok: true, message: 'Already connected or connecting' };
  }

  if (client.pupBrowser?.isConnected?.()) {
    await client.destroy();
  }

  if (client.authStrategy?.retryPendingCleanup) {
    const cleaned = await client.authStrategy.retryPendingCleanup();
    if (!cleaned) {
      throw new Error('WhatsApp session files are still locked. Close other bot or Chromium processes, then retry.');
    }
  }

  setStatus('initializing');
  await client.initialize();
  return { ok: true, message: 'Reconnecting...' };
}

// ── WebSocket connection: send current state snapshot ────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'snapshot',
    data: {
      status: state.status,
      qr: state.qr,
      logs: state.logs,
      info: state.info,
      startedAt: state.startedAt,
    },
  }));

  // Handle disconnect command from browser
  ws.on('message', async (raw) => {
    try {
      const { action } = JSON.parse(raw);
      if (action === 'disconnect') {
        await disconnectWhatsAppClient();
      }
      if (action === 'reconnect') {
        await reconnectWhatsAppClient();
      }
    } catch (e) {
      console.error('WS message error:', e.message);
    }
  });
});

// ── REST API (all routes require auth + rate limiting) ──────────────────────
app.use('/api', requireAuth, rateLimit(120));

// ── REST: Get current config ─────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  try {
    // Delete cached require so we always read fresh
    delete require.cache[require.resolve('./config')];
    const cfg = require('./config');
    res.json({ ok: true, config: cfg });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── REST: Save config ─────────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  try {
    const cfg = req.body;
    // Validate essential fields
    if (!Array.isArray(cfg.GROUP_IDS)) return res.status(400).json({ ok: false, error: 'GROUP_IDS must be an array' });
    if (!['dm', 'group', 'both'].includes(cfg.REPLY_MODE)) return res.status(400).json({ ok: false, error: 'Invalid REPLY_MODE' });

    const content = `// ====== EDIT THIS FILE ======\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`;
    fs.writeFileSync(CONFIG_PATH, content, 'utf8');

    // Reload into memory
    delete require.cache[require.resolve('./config')];

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── REST: Bot status ─────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    status: state.status,
    info: state.info,
    startedAt: state.startedAt,
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
  });
});

// ── REST: Logs ───────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  res.json({ logs: state.logs });
});

// ── REST: Disconnect ─────────────────────────────────────────────────────────
app.post('/api/disconnect', async (req, res) => {
  try {
    if (await disconnectWhatsAppClient()) {
      res.json({ ok: true, message: 'Disconnected' });
    } else {
      res.json({ ok: false, message: 'No active client' });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── REST: Reconnect ───────────────────────────────────────────────────────────
app.post('/api/reconnect', async (req, res) => {
  try {
    const result = await reconnectWhatsAppClient();
    res.json(result);
  } catch (e) {
    setStatus('disconnected');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`[Dashboard] http://localhost:${PORT}`);
  console.log(`[Security]  Basic Auth enabled — user: ${DASHBOARD_USER}`);
});

module.exports = { server };
