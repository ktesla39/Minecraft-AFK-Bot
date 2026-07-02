// Mineflayer Dashboard — server
//
// Runs a mineflayer bot with a resilient, indefinite reconnect strategy and
// exposes a real-time web dashboard (status, stats, chat, logs, history)
// over Socket.IO, plus start/stop/reconnect controls that never require
// restarting the Node process.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const mcProtocol = require('minecraft-protocol');
const path = require('path');

const config = require('./config.json');

// ---------------------------------------------------------------------------
// Config / constants
// ---------------------------------------------------------------------------

const RETRY_WAIT_MS = 10_000;      // wait after any connection failure
const PING_INTERVAL_MS = 20_000;   // how often to probe the server while it's down
const PING_TIMEOUT_MS = 5_000;     // give up on a single ping probe after this long
const STATS_INTERVAL_MS = 3_000;   // how often to push live stats to clients
const MAX_LOG_ENTRIES = 500;       // cap in-memory log buffers so memory stays bounded
const MAX_CHAT_ENTRIES = 500;
const MAX_HISTORY_ENTRIES = 200;

// Fields from config.json that are safe to expose to the dashboard/client.
// Anything not in this list (passwords, tokens, etc.) is never sent or logged.
const SAFE_CONFIG_FIELDS = ['serverHost', 'serverPort', 'botUsername', 'botChunk'];

function safeConfig() {
  const out = {};
  for (const field of SAFE_CONFIG_FIELDS) out[field] = config[field];
  return out;
}

// ---------------------------------------------------------------------------
// App / server setup
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const state = {
  status: 'stopped',        // stopped | connecting | pinging | online | waiting
  autoReconnect: false,     // whether the reconnect loop should keep running
  reconnectAttempts: 0,     // attempts since the last successful spawn
  lastError: null,
  connectedAt: null,        // Date.now() of last successful spawn
  motd: null,
  players: [],              // usernames currently visible to the bot
  ping: null,                // bot's latency to the server, ms
};

let bot = null;
let retryTimer = null;
let pingTimer = null;
let statsTimer = null;
let pingProbeInFlight = false;

const logs = [];      // general console/event log
const chat = [];       // server chat messages
const errors = [];     // error-level events
const history = [];    // connection lifecycle + reconnect attempt history

function pushCapped(arr, entry, max) {
  arr.push(entry);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function nowIso() {
  return new Date().toISOString();
}

function log(message, level = 'info') {
  const entry = { time: nowIso(), level, message };
  pushCapped(logs, entry, MAX_LOG_ENTRIES);
  io.emit('log', entry);
  // Mirror to the real console too, still without ever including secrets.
  const line = `[${entry.time}] [${level}] ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function logError(message, err) {
  const detail = err && err.message ? err.message : String(err || '');
  const entry = { time: nowIso(), message, detail };
  pushCapped(errors, entry, MAX_LOG_ENTRIES);
  state.lastError = entry;
  io.emit('error-log', entry);
  log(`${message}${detail ? ': ' + detail : ''}`, 'error');
}

function logChat(username, message) {
  const entry = { time: nowIso(), username: username || null, message };
  pushCapped(chat, entry, MAX_CHAT_ENTRIES);
  io.emit('chat', entry);
}

function logHistory(event, detail) {
  const entry = { time: nowIso(), event, detail: detail || null };
  pushCapped(history, entry, MAX_HISTORY_ENTRIES);
  io.emit('history', entry);
}

function setStatus(next) {
  state.status = next;
  io.emit('status', publicState());
}

function publicState() {
  return {
    status: state.status,
    autoReconnect: state.autoReconnect,
    reconnectAttempts: state.reconnectAttempts,
    lastError: state.lastError,
    connectedAt: state.connectedAt,
    uptimeMs: state.connectedAt ? Date.now() - state.connectedAt : 0,
    motd: state.motd,
    players: state.players,
    playerCount: state.players.length,
    ping: state.ping,
    config: safeConfig(),
  };
}

// ---------------------------------------------------------------------------
// Timer bookkeeping — always clear before rescheduling so we never end up
// with duplicate loops running after start/stop/reconnect churn.
// ---------------------------------------------------------------------------

function clearAllTimers() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
}

// ---------------------------------------------------------------------------
// Server availability probe (used while the bot is disconnected)
// ---------------------------------------------------------------------------

function probeServer() {
  if (pingProbeInFlight) return Promise.resolve(null);
  pingProbeInFlight = true;
  return Promise.race([
    mcProtocol.ping({ host: config.serverHost, port: config.serverPort }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ping timed out')), PING_TIMEOUT_MS)
    ),
  ])
    .finally(() => { pingProbeInFlight = false; });
}

// ---------------------------------------------------------------------------
// Reconnect state machine
//
// On any disconnect/failure:
//   1. wait RETRY_WAIT_MS
//   2. ping the server every PING_INTERVAL_MS until it responds
//   3. once it responds, attempt to reconnect the bot
//   4. repeat indefinitely (unless the user pressed Stop)
// ---------------------------------------------------------------------------

function scheduleReconnect(reason) {
  if (!state.autoReconnect) return;
  clearAllTimers();
  setStatus('waiting');
  log(`Disconnected (${reason}). Waiting ${RETRY_WAIT_MS / 1000}s before checking server availability...`);
  retryTimer = setTimeout(() => {
    startPingLoop();
  }, RETRY_WAIT_MS);
}

function startPingLoop() {
  if (!state.autoReconnect) return;
  setStatus('pinging');
  const attemptPing = () => {
    if (!state.autoReconnect) return;
    probeServer()
      .then((res) => {
        if (!state.autoReconnect) return;
        if (res && res.description !== undefined) {
          state.motd = motdToString(res.description);
        }
        log('Server responded to ping. Attempting to reconnect...');
        logHistory('server-online', 'Ping succeeded, reconnecting');
        connectBot();
      })
      .catch(() => {
        if (!state.autoReconnect) return;
        log(`Server still unreachable, retrying ping in ${PING_INTERVAL_MS / 1000}s...`);
        pingTimer = setTimeout(attemptPing, PING_INTERVAL_MS);
      });
  };
  attemptPing();
}

function motdToString(description) {
  if (typeof description === 'string') return description;
  if (description && typeof description.text === 'string') {
    let text = description.text;
    if (Array.isArray(description.extra)) {
      text += description.extra.map((e) => e.text || '').join('');
    }
    return text;
  }
  try { return JSON.stringify(description); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Bot lifecycle
// ---------------------------------------------------------------------------

function connectBot() {
  if (bot) return; // already connecting/connected
  clearAllTimers();
  setStatus('connecting');
  state.reconnectAttempts += 1;
  logHistory('connect-attempt', `Attempt #${state.reconnectAttempts}`);
  log(`Connecting to ${config.serverHost}:${config.serverPort} as ${config.botUsername}...`);

  try {
    bot = mineflayer.createBot({
      host: config.serverHost,
      port: config.serverPort,
      username: config.botUsername,
      // NOTE: password intentionally omitted from every log line/emit above.
      password: config.pass || undefined,
      auth: 'offline',
      version: false,
      viewDistance: config.botChunk,
      // We do our own structured logging (with password redaction) below,
      // so silence mineflayer's built-in console output to avoid duplicate/
      // unstructured noise and any chance of it dumping raw connection
      // details into the terminal.
      hideErrors: true,
      logErrors: false,
    });
  } catch (err) {
    bot = null;
    logError('Failed to create bot', err);
    scheduleReconnect('create-bot-failed');
    return;
  }

  bot.on('spawn', () => {
    state.connectedAt = Date.now();
    state.reconnectAttempts = 0;
    state.players = Object.keys(bot.players).filter((p) => p !== bot.username);
    setStatus('online');
    log('Bot spawned and is now online.');
    logHistory('online', `Connected as ${config.botUsername}`);
  });

  bot.on('messagestr', (message) => {
    logChat(null, message);
  });

  bot.on('playerJoined', (player) => {
    if (bot) state.players = Object.keys(bot.players).filter((p) => p !== bot.username);
  });

  bot.on('playerLeft', () => {
    if (bot) state.players = Object.keys(bot.players).filter((p) => p !== bot.username);
  });

  bot.on('kicked', (reason) => {
    let reasonText;
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      reasonText = motdToString(parsed) || String(reason);
    } catch {
      reasonText = String(reason);
    }
    logError('Bot was kicked from the server', new Error(reasonText));
    logHistory('kicked', reasonText);
  });

  bot.on('error', (err) => {
    logError('Bot connection error', err);
  });

  bot.on('end', (reason) => {
    const wasOnline = state.status === 'online';
    bot = null;
    state.connectedAt = null;
    state.players = [];
    state.ping = null;
    logHistory('disconnected', reason || (wasOnline ? 'connection ended' : 'connection failed'));
    if (state.autoReconnect) {
      scheduleReconnect(reason || 'connection ended');
    } else {
      setStatus('stopped');
      log('Bot stopped.');
    }
  });
}

function startBot() {
  if (state.autoReconnect && bot) {
    log('Start requested, but the bot is already running.');
    return;
  }
  state.autoReconnect = true;
  state.reconnectAttempts = 0;
  logHistory('start', 'Start requested by user');
  connectBot();
}

function stopBot() {
  state.autoReconnect = false;
  clearAllTimers();
  logHistory('stop', 'Stop requested by user');
  if (bot) {
    log('Stopping bot...');
    try { bot.quit(); } catch (err) { logError('Error while stopping bot', err); }
    bot = null;
  } else {
    setStatus('stopped');
  }
  state.connectedAt = null;
  state.players = [];
  state.ping = null;
}

function reconnectBot() {
  logHistory('manual-reconnect', 'Reconnect requested by user');
  clearAllTimers();
  state.autoReconnect = true;
  if (bot) {
    const oldBot = bot;
    bot = null;
    try { oldBot.quit(); } catch (err) { /* already closing */ }
  }
  log('Manual reconnect requested. Reconnecting now...');
  connectBot();
}

// ---------------------------------------------------------------------------
// Live stats broadcast (ping, memory, uptime)
// ---------------------------------------------------------------------------

function broadcastStats() {
  if (bot && bot._client && typeof bot._client.latency === 'number') {
    state.ping = bot._client.latency;
  }
  const mem = process.memoryUsage();
  io.emit('stats', {
    ...publicState(),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    serverUptimeMs: process.uptime() * 1000,
  });
}
statsTimer = setInterval(broadcastStats, STATS_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Socket.IO wiring
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  // Send full current state so a freshly-opened dashboard isn't blank.
  socket.emit('init', {
    state: publicState(),
    logs,
    chat,
    errors,
    history,
  });

  socket.on('chat', (msg) => {
    if (typeof msg !== 'string' || !msg.trim()) return;
    if (bot && state.status === 'online') {
      bot.chat(msg.slice(0, 256));
      logChat(config.botUsername, msg.slice(0, 256));
    } else {
      log('Chat message dropped: bot is not currently online.', 'warn');
    }
  });

  socket.on('start', () => startBot());
  socket.on('stop', () => stopBot());
  socket.on('reconnect', () => reconnectBot());
});

// REST fallback, handy for scripts/monitoring tools that aren't using sockets.
app.get('/api/state', (req, res) => {
  res.json({ state: publicState(), logs, chat, errors, history });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  log(`Dashboard listening on port ${PORT}`);
  startBot();
});

process.on('SIGINT', () => {
  log('Shutting down...');
  stopBot();
  clearInterval(statsTimer);
  server.close(() => process.exit(0));
});
