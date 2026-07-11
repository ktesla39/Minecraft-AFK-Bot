const socket = io();

// ---------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------
const el = (id) => document.getElementById(id);

const signal = el("signal");
const statusPill = el("statusPill");
const uptimeEl = el("uptime");
const serverLabel = el("serverLabel");

const statPlayers = el("statPlayers");
const statPing = el("statPing");
const statUptime = el("statUptime");
const statMemory = el("statMemory");
const statReconnects = el("statReconnects");
const statMotd = el("statMotd");

const btnStart = el("btnStart");
const btnStop = el("btnStop");
const btnReconnect = el("btnReconnect");
const btnSwitchAccount = el("btnSwitchAccount");
const accountSelect = el("accountSelect");
const accountForm = el("accountForm");
const accountDisplayNameInput = el("accountDisplayNameInput");
const accountUsernameInput = el("accountUsernameInput");
const accountPasswordInput = el("accountPasswordInput");
const accountList = el("accountList");

const tabs = Array.from(document.querySelectorAll(".tab"));
const views = {
  console: el("consoleView"),
  chat: el("chatView"),
  errors: el("errorsView"),
  history: el("historyView"),
};
const errorBadge = el("errorBadge");

const filterInput = el("filterInput");
const autoscrollToggle = el("autoscrollToggle");

const chatForm = el("chatForm");
const chatInput = el("chatInput");

// ---------------------------------------------------------------------
// Local buffers (mirrors of server-side arrays, used for re-filtering)
// ---------------------------------------------------------------------
const buffers = { console: [], chat: [], errors: [], history: [] };
let activeTab = "console";
let errorCount = 0;
let accountState = { accounts: [], selectedAccount: null };

// ---------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function isNearBottom(view) {
  return view.scrollHeight - view.scrollTop - view.clientHeight < 60;
}

function renderLine(kind, entry) {
  const line = document.createElement("div");
  line.className = "log-line";

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = formatTime(entry.time);
  line.appendChild(time);

  const body = document.createElement("span");
  body.className = "log-msg";

  if (kind === "console") {
    line.classList.add(
      `log-line--${entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info"}`,
    );
    body.textContent = entry.message;
  } else if (kind === "chat") {
    line.classList.add("log-line--chat");
    if (entry.username) {
      const user = document.createElement("span");
      user.className = "log-user";
      user.textContent = `<${entry.username}>`;
      line.appendChild(user);
      if (entry.username === currentBotUsername)
        line.classList.add("log-line--chat-self");
    }
    body.textContent = entry.message;
  } else if (kind === "errors") {
    line.classList.add("log-line--error");
    body.textContent = entry.detail
      ? `${entry.message}: ${entry.detail}`
      : entry.message;
  } else if (kind === "history") {
    line.classList.add("log-line--history");
    const eventEl = document.createElement("span");
    eventEl.className = "log-event";
    eventEl.textContent = entry.event;
    line.appendChild(eventEl);
    if (entry.detail) {
      const detailEl = document.createElement("span");
      detailEl.className = "log-detail";
      detailEl.textContent = entry.detail;
      body.appendChild(detailEl);
    }
  }

  line.appendChild(body);
  return line;
}

function matchesFilter(kind, entry, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [entry.message, entry.detail, entry.username, entry.event]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function renderView(kind) {
  const view = views[kind];
  if (!view) return;
  const query = filterInput.value.trim();
  const wasNearBottom = isNearBottom(view);
  view.innerHTML = "";
  const items = buffers[kind].filter((e) => matchesFilter(kind, e, query));
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = query
      ? "No entries match your filter."
      : "Nothing here yet.";
    view.appendChild(empty);
  } else {
    for (const entry of items) view.appendChild(renderLine(kind, entry));
  }
  if (autoscrollToggle.checked && (wasNearBottom || query)) {
    view.scrollTop = view.scrollHeight;
  }
}

function appendEntry(kind, entry) {
  buffers[kind].push(entry);
  if (buffers[kind].length > 500) buffers[kind].shift();
  if (kind === activeTab || kind === "history") {
    renderView(kind);
  }
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
function setActiveTab(tabName) {
  activeTab = tabName;
  for (const t of tabs) {
    const isActive = t.dataset.tab === tabName;
    t.classList.toggle("active", isActive);
    t.setAttribute("aria-selected", String(isActive));
  }
  views.console.hidden = tabName !== "console";
  views.chat.hidden = tabName !== "chat";
  views.errors.hidden = tabName !== "errors";
  chatForm.hidden = tabName !== "chat";
  renderView(tabName);
  if (tabName === "chat") chatInput.focus();
}
tabs.forEach((t) =>
  t.addEventListener("click", () => setActiveTab(t.dataset.tab)),
);

filterInput.addEventListener("input", () => renderView(activeTab));

// ---------------------------------------------------------------------
// Status / stats
// ---------------------------------------------------------------------
let currentBotUsername = null;

const STATUS_LABELS = {
  stopped: "Stopped",
  connecting: "Connecting",
  pinging: "Waiting for server",
  waiting: "Retrying soon",
  online: "Online",
};

function formatUptime(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function applyState(state) {
  const activeUsername =
    state.config && state.config.selectedAccount
      ? state.config.selectedAccount
      : currentBotUsername;
  currentBotUsername = activeUsername;

  const activeBotName = activeUsername || "Mineflayer Bot";
  document.title = `${activeBotName} | Mineflayer Dashboard`;

  signal.dataset.state = state.status;
  statusPill.dataset.state = state.status;
  statusPill.textContent = STATUS_LABELS[state.status] || state.status;
  document.getElementById("sessionCount").textContent =
    `${state.sessions ? state.sessions.length : 0} bot${state.sessions && state.sessions.length === 1 ? "" : "s"}`;

  uptimeEl.textContent =
    state.status === "online" ? formatUptime(state.uptimeMs) : "";

  if (state.config) {
    const selectedAccount =
      state.config.selectedAccount ||
      (state.config.accounts &&
        state.config.accounts[0] &&
        state.config.accounts[0].username) ||
      "unknown";
    serverLabel.textContent = `${state.config.serverHost}:${state.config.serverPort}  ·  ${selectedAccount}`;
  }

  statPlayers.textContent = state.playerCount ?? 0;
  statPing.textContent =
    state.status === "online" && state.ping != null ? `${state.ping} ms` : "—";
  statUptime.textContent =
    state.status === "online" ? formatUptime(state.uptimeMs) : "—";
  statReconnects.textContent = state.reconnectAttempts ?? 0;
  statMotd.textContent = state.motd || "—";

  btnStart.disabled = state.status !== "stopped";
  btnStop.disabled = state.status === "stopped";
}

function renderAccounts() {
  accountSelect.innerHTML = "";
  accountList.innerHTML = "";

  if (!accountState.accounts.length) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "No accounts stored yet.";
    accountList.appendChild(empty);
    return;
  }

  accountState.accounts.forEach((account) => {
    const option = document.createElement("option");
    option.value = account.username;
    option.textContent = account.displayName || account.username;
    option.selected = account.username === accountState.selectedAccount;
    accountSelect.appendChild(option);

    const item = document.createElement("div");
    item.className = `account-item${account.username === accountState.selectedAccount ? " active" : ""}`;
    item.innerHTML = `
      <div class="account-item__meta">
        <span class="account-item__name">${account.displayName || account.username}</span>
        <span class="account-item__user">${account.username}</span>
      </div>
      <div class="account-item__buttons">
        <button class="btn" data-action="select" data-username="${account.username}" type="button">Use</button>
        <button class="btn" data-action="delete" data-username="${account.username}" type="button">Delete</button>
      </div>
    `;
    accountList.appendChild(item);
  });
}

function updateAccountState(payload) {
  accountState = payload || { accounts: [], selectedAccount: null };
  renderAccounts();
}

// ---------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------
socket.on("init", (payload) => {
  buffers.console = payload.logs || [];
  buffers.chat = payload.chat || [];
  buffers.errors = payload.errors || [];
  buffers.history = payload.history || [];
  errorCount = buffers.errors.length;
  errorBadge.hidden = errorCount === 0;
  errorBadge.textContent = errorCount;
  if (payload.accounts) updateAccountState(payload.accounts);
  applyState(payload.state);
  renderView("console");
  renderView("chat");
  renderView("errors");
  renderView("history");
});

socket.on("status", (state) => applyState(state));
socket.on("accounts", (payload) => updateAccountState(payload));
socket.on("stats", (payload) => {
  applyState(payload);
  statMemory.textContent = payload.memory
    ? formatBytes(payload.memory.rss)
    : "—";
});

socket.on("log", (entry) => appendEntry("console", entry));
socket.on("chat", (entry) => appendEntry("chat", entry));
socket.on("error-log", (entry) => {
  appendEntry("errors", entry);
  errorCount += 1;
  errorBadge.hidden = false;
  errorBadge.textContent = errorCount;
});
socket.on("history", (entry) => appendEntry("history", entry));

socket.on("connect", () => {
  serverLabel.textContent = serverLabel.textContent || "connected to dashboard";
});
socket.on("disconnect", () => {
  statusPill.textContent = "Dashboard disconnected";
  statusPill.dataset.state = "stopped";
});

// ---------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------
btnStart.addEventListener("click", () => socket.emit("start"));
btnStop.addEventListener("click", () => socket.emit("stop"));
btnReconnect.addEventListener("click", () => socket.emit("reconnect"));
btnSwitchAccount.addEventListener("click", () => {
  if (!accountSelect.value) return;
  socket.emit("account:select", accountSelect.value);
});

accountForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const payload = {
    displayName: accountDisplayNameInput.value.trim(),
    username: accountUsernameInput.value.trim(),
    password: accountPasswordInput.value.trim(),
  };
  if (!payload.username) return;
  socket.emit("account:save", payload);
  accountForm.reset();
});

accountList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const username = button.dataset.username;
  if (!username) return;
  if (action === "select") {
    socket.emit("account:select", username);
  } else if (action === "delete") {
    socket.emit("account:delete", username);
  }
});

accountSelect.addEventListener("change", () => {
  if (accountSelect.value) socket.emit("account:select", accountSelect.value);
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit("chat", msg);
  chatInput.value = "";
});

// Reset error badge when the errors tab is viewed
document
  .querySelector('.tab[data-tab="errors"]')
  .addEventListener("click", () => {
    errorCount = 0;
    errorBadge.hidden = true;
  });
