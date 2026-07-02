# Mineflayer Dashboard

A self-healing Minecraft AFK bot (built on [mineflayer](https://github.com/PrismarineJS/mineflayer)) with a real-time web dashboard for monitoring and remote control.

## Setup

```bash
npm install
```

Edit `config.json`:

```json
{
  "serverHost": "example.aternos.me",
  "serverPort": 25565,
  "botUsername": "AFKBot",
  "pass": "password",
  "botChunk": 4
}
```

`pass` is only used for online-mode authentication and is never written to logs, the dashboard, or the `/api/state` endpoint.

Run it:

```bash
npm start
```

Then open `http://localhost:8080` (or `PORT=xxxx npm start` to pick a different port).

## Reconnect behavior

The bot reconnects indefinitely by default, following this loop after any disconnect or failed connection attempt:

1. Wait 10 seconds.
2. Ping the server every 20 seconds until it responds.
3. As soon as a ping succeeds, attempt to reconnect the bot.
4. Repeat forever, unless **Stop** is pressed on the dashboard.

The **Reconnect** button skips the wait/ping loop and retries immediately. **Stop** cancels all pending timers and disables auto-reconnect until **Start** is pressed again — none of these controls require restarting the Node process.

## Dashboard features

- Live status (stopped / connecting / waiting for server / online), with connection uptime
- Players online, bot ping, memory usage, reconnect attempt count, and server MOTD
- Console, Chat, and Errors tabs with filtering, timestamps, and auto-scroll
- Connection history timeline (connects, disconnects, kicks, manual actions)
- Chat box to send messages to the server as the bot
- Responsive layout for desktop and mobile

## Notes

- State is kept in memory (last 500 log/chat/history entries) and reset on process restart.
- `GET /api/state` returns the same data the dashboard shows, for scripting or external monitoring.
