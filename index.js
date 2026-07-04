// Mineflayer Dashboard — server
//
// Runs a mineflayer bot with a resilient, indefinite reconnect strategy and
// exposes a real-time web dashboard (status, stats, chat, logs, history)
// over Socket.IO, plus start/stop/reconnect controls that never require
// restarting the Node process.

const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const mcProtocol = require('minecraft-protocol');
const path = require('path');

const config = require('./config.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

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
const SAFE_CONFIG_FIELDS = ['serverHost', 'serverPort', 'botChunk', 'selectedAccount'];

function ensureConfigShape() {
  if (!Array.isArray(config.accounts)) config.accounts = [];
  config.accounts = config.accounts
    .filter(Boolean)
    .map((account) => {
      const username = String(account.username || account.name || '').trim();
      const displayName = String(account.displayName || account.name || username).trim();
      const password = String(account.password || account.pass || '').trim();
      return { username, password, displayName: displayName || username };
    })
    .filter((account) => account.username);

  if (!config.selectedAccount && config.accounts[0]) {
    config.selectedAccount = config.accounts[0].username;
  }

  if (!config.accounts.length) {
    const fallback = { username: 'DontCare', password: '', displayName: 'Default' };
    config.accounts.push(fallback);
    config.selectedAccount = fallback.username;
  }
}

function persistConfig() {
  ensureConfigShape();
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function getAccountSummaries() {
  ensureConfigShape();
  return config.accounts.map((account) => ({
    username: account.username,
    displayName: account.displayName || account.username,
    isActive: account.username === config.selectedAccount,
  }));
}

function findAccount(username) {
  ensureConfigShape();
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) return null;
  return config.accounts.find((account) => String(account.username || '').trim().toLowerCase() === normalized) || null;
}

function resolveActiveAccount(requestedUsername) {
  ensureConfigShape();
  const explicit = requestedUsername ? findAccount(requestedUsername) : null;
  if (explicit) {
    config.selectedAccount = explicit.username;
    persistConfig();
    return explicit;
  }

  const selected = findAccount(config.selectedAccount) || config.accounts[0] || null;
  if (selected) {
    config.selectedAccount = selected.username;
    persistConfig();
  }
  return selected;
}

function setSelectedAccount(username) {
  ensureConfigShape();
  const account = findAccount(username);
  if (!account) return null;
  config.selectedAccount = account.username;
  persistConfig();
  return account;
}

function safeConfig() {
  ensureConfigShape();
  const out = {};
  for (const field of SAFE_CONFIG_FIELDS) out[field] = config[field];
  out.accounts = getAccountSummaries();
  return out;
}

function parseCliArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--user' || arg === '--username') {
      result.username = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--user=')) {
      result.username = arg.split('=').slice(1).join('=');
    } else if (arg.startsWith('--username=')) {
      result.username = arg.split('=').slice(1).join('=');
    }
  }
  return result;
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
let activeAccount = null;

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

function normalizeUsername(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') {
    return value.username || value.name || value.displayName || value.nick || value.text || null;
  }
  const text = String(value).trim();
  return text || null;
}

function looksLikeUuid(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/-/g, '');
  return /^[0-9a-f]{32}$/i.test(normalized);
}

function resolveUsername(sender, fallbackMessage) {
  const direct = normalizeUsername(sender);
  if (direct && !looksLikeUuid(direct)) return direct;

  if (sender && typeof sender === 'object' && bot) {
    const uuid = sender.uuid || sender.id || sender.playerUUID;
    if (uuid) {
      const match = Object.values(bot.players || {}).find((player) => {
        const playerUuid = player && (player.uuid || player.id || player.uuidRaw);
        if (!playerUuid) return false;
        return String(playerUuid).replace(/-/g, '') === String(uuid).replace(/-/g, '');
      });
      if (match && match.username) return match.username;
    }
  }

  if (bot && looksLikeUuid(direct)) {
    const match = Object.values(bot.players || {}).find((player) => {
      const playerUuid = player && (player.uuid || player.id || player.uuidRaw);
      if (!playerUuid) return false;
      return String(playerUuid).replace(/-/g, '') === direct.replace(/-/g, '');
    });
    if (match && match.username) return match.username;
  }

  if (typeof fallbackMessage === 'string') {
    const match = fallbackMessage.match(/^(?:<([^>]+)>|(?:\[(.*?)\]\s*)?([A-Za-z0-9_]{1,16})\s?[>:\-»\]\)~]+\s)(.*)$/);
    if (match && (match[1] || match[3])) return match[1] || match[3];
  }

  return direct;
}

function logChat(username, message) {
  const entry = { time: nowIso(), username: resolveUsername(username, message), message };
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

function disconnectBot(reason = 'disconnect') {
  if (!bot) return;

  const currentBot = bot;
  bot = null;

  try {
    if (typeof currentBot.end === 'function') {
      currentBot.end(reason);
    } else if (typeof currentBot.quit === 'function') {
      currentBot.quit(reason);
    } else if (currentBot._client && typeof currentBot._client.end === 'function') {
      currentBot._client.end(reason);
    } else {
      throw new Error('No disconnect method available for this bot instance.');
    }
  } catch (err) {
    logError('Error while stopping bot', err);
  }
}

function connectBot() {
  if (bot) return; // already connecting/connected
  clearAllTimers();
  setStatus('connecting');
  state.reconnectAttempts += 1;

  activeAccount = resolveActiveAccount();
  if (!activeAccount) {
    logError('No bot account is configured. Add one from the dashboard or config.json.', new Error('missing-account'));
    state.autoReconnect = false;
    setStatus('stopped');
    return;
  }

  logHistory('connect-attempt', `Attempt #${state.reconnectAttempts} for ${activeAccount.username}`);
  log(`Connecting to ${config.serverHost}:${config.serverPort} as ${activeAccount.username}...`);

  try {
    const createdBot = mineflayer.createBot({
      host: config.serverHost,
      port: config.serverPort,
      username: activeAccount.username,
      password: activeAccount.password || undefined,
      auth: 'offline',
      version: false,
      viewDistance: config.botChunk,
      hideErrors: true,
      logErrors: false,
    });
    bot = createdBot;
  } catch (err) {
    bot = null;
    logError('Failed to create bot', err);
    scheduleReconnect('create-bot-failed');
    return;
  }

  const currentBot = bot;

  currentBot.on('spawn', () => {
    state.connectedAt = Date.now();
    state.reconnectAttempts = 0;
    state.players = Object.keys(currentBot.players).filter((p) => p !== currentBot.username);
    setStatus('online');
    log('Bot spawned and is now online.');
    logHistory('online', `Connected as ${activeAccount.displayName || activeAccount.username}`);

    const account = activeAccount;
    const loginDelayMs = 1_200;
    const sitDelayMs = 1_000;

    setTimeout(() => {
      if (!bot || bot !== currentBot) return;

      if (account && account.password) {
        currentBot.chat(`/login ${account.password}`);
        log(`Sent /login for ${account.username}.`);
      }

      setTimeout(() => {
        if (!bot || bot !== currentBot) return;
        currentBot.chat('/sit');
        log(`Sent /sit for ${account.username}.`);

        setTimeout(() => {
          if (!bot || bot !== currentBot) return;
          currentBot.chat('/afk');
          log(`Sent /afk for ${account.username}.`);
        }, sitDelayMs);
      }, loginDelayMs);
    }, 800);
  });

  currentBot.on('messagestr', (message, position, _jsonMsg, sender) => {
    if (!message) return;
    if (position === 'chat' || sender) {
      logChat(sender, message);
    }
  });

  currentBot.on('playerJoined', () => {
    if (bot === currentBot) state.players = Object.keys(currentBot.players).filter((p) => p !== currentBot.username);
  });

  currentBot.on('playerLeft', () => {
    if (bot === currentBot) state.players = Object.keys(currentBot.players).filter((p) => p !== currentBot.username);
  });

  currentBot.on('kicked', (reason) => {
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

  currentBot.on('error', (err) => {
    logError('Bot connection error', err);
  });

  currentBot.on('end', (reason) => {
    if (bot !== currentBot) return;
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
    disconnectBot('stop requested');
  } else {
    setStatus('stopped');
  }
  state.connectedAt = null;
  state.players = [];
  state.ping = null;
}

function switchAccount(username) {
  const account = setSelectedAccount(username);
  if (!account) {
    logError('Unable to switch account', new Error(`Unknown account: ${username}`));
    return null;
  }

  logHistory('account-switch', `Selected account ${account.username}`);
  if (bot) {
    const shouldAutoReconnect = state.autoReconnect;
    stopBot();
    state.autoReconnect = shouldAutoReconnect;
    connectBot();
  } else {
    state.autoReconnect = true;
    connectBot();
  }

  return account;
}

function reconnectBot() {
  logHistory('manual-reconnect', 'Reconnect requested by user');
  clearAllTimers();
  state.autoReconnect = true;
  if (bot) {
    disconnectBot('reconnect requested');
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
    accounts: {
      accounts: getAccountSummaries(),
      selectedAccount: config.selectedAccount,
    },
  });

  socket.emit('accounts', {
    accounts: getAccountSummaries(),
    selectedAccount: config.selectedAccount,
  });

  socket.on('chat', (msg) => {
    if (typeof msg !== 'string' || !msg.trim()) return;
    if (bot && state.status === 'online') {
      const text = msg.slice(0, 256);
      bot.chat(text);
      log('Sent chat message to the server.', 'info');
    } else {
      log('Chat message dropped: bot is not currently online.', 'warn');
    }
  });

  socket.on('start', () => startBot());
  socket.on('stop', () => stopBot());
  socket.on('reconnect', () => reconnectBot());

  socket.on('account:save', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const username = String(payload.username || '').trim();
    const displayName = String(payload.displayName || '').trim();
    const password = String(payload.password || '').trim();
    if (!username) return;

    ensureConfigShape();
    const existing = findAccount(username);
    if (existing) {
      existing.displayName = displayName || existing.displayName || username;
      if (password) existing.password = password;
    } else {
      config.accounts.push({ username, password, displayName: displayName || username });
    }

    if (!config.selectedAccount) config.selectedAccount = username;
    persistConfig();
    io.emit('accounts', {
      accounts: getAccountSummaries(),
      selectedAccount: config.selectedAccount,
    });
    log(`Saved account ${username}.`);
  });

  socket.on('account:select', (payload) => {
    const username = typeof payload === 'string' ? payload : payload && payload.username;
    if (!username) return;
    switchAccount(username);
    io.emit('accounts', {
      accounts: getAccountSummaries(),
      selectedAccount: config.selectedAccount,
    });
  });

  socket.on('account:delete', (payload) => {
    const username = typeof payload === 'string' ? payload : payload && payload.username;
    if (!username) return;

    ensureConfigShape();
    const normalized = String(username).trim().toLowerCase();
    config.accounts = config.accounts.filter((account) => String(account.username || '').trim().toLowerCase() !== normalized);

    if (!config.accounts.length) {
      config.selectedAccount = null;
    } else if (!findAccount(config.selectedAccount)) {
      config.selectedAccount = config.accounts[0].username;
    }

    persistConfig();
    io.emit('accounts', {
      accounts: getAccountSummaries(),
      selectedAccount: config.selectedAccount,
    });
    log(`Removed account ${username}.`);
  });
});

// REST fallback, handy for scripts/monitoring tools that aren't using sockets.
app.get('/api/state', (req, res) => {
  res.json({ state: publicState(), logs, chat, errors, history });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const cliArgs = parseCliArgs(process.argv.slice(2));
activeAccount = resolveActiveAccount(cliArgs.username);
if (activeAccount) {
  log(`Active account resolved to ${activeAccount.username}.`);
}

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
