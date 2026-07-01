const mineflayer = require('mineflayer');
const http = require('http');
const config = require('./config.json');

// Validate config on startup
if (!config.serverHost || config.serverHost === 'example.aternos.me') {
  console.error('⚠️  Set a valid serverHost in config.json before running.');
  process.exit(1);
}

const RECONNECT_DELAY = 20000;

// Health-check server so the deployment platform can verify the process is alive
const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});
healthServer.listen(8080, () => {
  console.log('🌐 Health server listening on port 8080');
});

function createBot() {
  const bot = mineflayer.createBot({
    host: config.serverHost,
    port: config.serverPort,
    username: config.botUsername,
    auth: 'offline',
    version: false,
    viewDistance: config.botChunk
  });

  bot.once('spawn', () => {
    setTimeout(() => {
      bot.chat(`/login ${config.pass}`);
      console.log(`✅ ${config.botUsername} is Ready!`);
    }, 3000);
  });

  bot.on('error', (err) => {
    // Log a clean one-line message — no stack trace for known network errors
    console.error(`⚠️  Error: ${err.message || err}`);
  });

  bot.on('end', (reason) => {
    console.log(`⛔️ Bot Disconnected (${reason}). Reconnecting in ${RECONNECT_DELAY / 1000}s…`);
    setTimeout(createBot, RECONNECT_DELAY);
  });
}

createBot();

