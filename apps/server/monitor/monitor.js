const feed = document.getElementById('feed');
const memoryPanel = document.getElementById('memory-panel');
const lifePanel = document.getElementById('life-panel');
const connection = document.getElementById('connection');
const pttBtn = document.getElementById('ptt-btn');
const events = new Map();
let pttAvailable = false;
let voiceAttached = false;
let recording = false;

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString();
}

function renderEvent(event) {
  events.set(event.id, event);
  const sorted = [...events.values()].sort((a, b) => b.id - a.id).slice(0, 80);
  feed.innerHTML = sorted.map((item) => `
    <article class="event ${item.level}">
      <time>${formatTime(item.time)}</time>
      <div class="title">${escapeHtml(item.title)}</div>
      ${item.detail ? `<div class="detail">${escapeHtml(item.detail)}</div>` : ''}
    </article>
  `).join('');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function setRecording(active) {
  recording = active;
  pttBtn.classList.toggle('recording', active);
  pttBtn.textContent = active ? 'Recording… release to send' : 'Hold to Talk';
}

async function pttRequest(path) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  return response.json();
}

async function startPtt() {
  if (!pttAvailable || !voiceAttached || recording) return;
  const result = await pttRequest('/monitor/ptt/start');
  if (result.ok) {
    setRecording(true);
  } else if (result.message) {
    pttBtn.textContent = result.message;
    setTimeout(() => {
      if (!recording) pttBtn.textContent = 'Hold to Talk';
    }, 2000);
  }
}

async function stopPtt() {
  if (!recording) return;
  setRecording(false);
  const result = await pttRequest('/monitor/ptt/stop');
  if (!result.ok && result.message) {
    pttBtn.textContent = result.message;
    setTimeout(() => {
      pttBtn.textContent = 'Hold to Talk';
    }, 2000);
  }
}

function bindPttButton() {
  const begin = (event) => {
    event.preventDefault();
    void startPtt();
  };
  const end = (event) => {
    event.preventDefault();
    void stopPtt();
  };

  pttBtn.addEventListener('mousedown', begin);
  pttBtn.addEventListener('mouseup', end);
  pttBtn.addEventListener('mouseleave', end);
  pttBtn.addEventListener('touchstart', begin, { passive: false });
  pttBtn.addEventListener('touchend', end);
  pttBtn.addEventListener('touchcancel', end);
  pttBtn.addEventListener('keydown', (event) => {
    if (event.code === 'Space' || event.code === 'Enter') begin(event);
  });
  pttBtn.addEventListener('keyup', (event) => {
    if (event.code === 'Space' || event.code === 'Enter') end(event);
  });
}

function renderLife(records) {
  const record = records?.[0];
  if (!record?.narrative?.trim()) {
    lifePanel.innerHTML = '<div class="empty">Her story is just beginning…</div>';
    return;
  }
  lifePanel.innerHTML = `
    <time>Updated ${formatTime(record.updatedAt)}</time>
    <pre>${escapeHtml(record.narrative)}</pre>
  `;
}

function renderMemory(users) {
  if (!users?.length) {
    memoryPanel.innerHTML = '<div class="empty">No saved caller notes yet.</div>';
    return;
  }
  memoryPanel.innerHTML = users.map((user) => `
    <article class="memory-user">
      <h3>${escapeHtml(user.displayName ?? user.userId)}</h3>
      <time>Updated ${formatTime(user.updatedAt)}</time>
      ${user.relationship?.trim() ? `<div class="memory-relationship"><strong>How Luna feels</strong><pre>${escapeHtml(user.relationship)}</pre></div>` : ''}
      ${user.summary?.trim() ? `<div class="memory-facts"><strong>Facts</strong><pre>${escapeHtml(user.summary)}</pre></div>` : ''}
    </article>
  `).join('');
}

async function refreshStatus() {
  try {
    const payload = await fetch('/monitor/status').then((r) => r.json());
    renderMemory(payload.voiceMemory);
    renderLife(payload.lunaLife);
    const discord = payload.discord ?? {};
    const bot = discord.user?.tag ?? 'offline';
    document.getElementById('bot-name').innerHTML = `<strong>Bot:</strong> ${escapeHtml(bot)}`;
    connection.textContent = discord.connected ? 'Online' : 'Offline';
    connection.className = `status-pill ${discord.connected ? 'online' : 'offline'}`;

    pttAvailable = Boolean(payload.pttAvailable);
    const bridge = discord.voiceBridges?.[0];
    voiceAttached = Boolean(bridge?.attached);
    pttBtn.disabled = !(pttAvailable && voiceAttached);

    if (bridge?.attached) {
      document.getElementById('voice-state').innerHTML = `<strong>Voice:</strong> in channel (${escapeHtml(bridge.connectionStatus ?? 'unknown')})`;
      document.getElementById('voice-mode').innerHTML = `<strong>Mode:</strong> ${escapeHtml(bridge.voiceInputMode ?? 'auto')}${bridge.pttRecording ? ' · recording' : ''}`;
      document.getElementById('voice-diag').innerHTML = `<strong>Last heard:</strong> ${bridge.lastSpeakingAt ? formatTime(bridge.lastSpeakingAt) : '—'} (${bridge.speakingStarts ?? 0} turns)`;
      document.getElementById('voice-out').innerHTML = `<strong>Last spoke:</strong> ${bridge.lastDiscordWriteAt ? formatTime(bridge.lastDiscordWriteAt) : '—'}`;
      document.getElementById('last-error').innerHTML = `<strong>Last error:</strong> ${bridge.lastError ? escapeHtml(bridge.lastError) : 'none'}`;
    } else {
      document.getElementById('voice-state').innerHTML = '<strong>Voice:</strong> not in channel';
      document.getElementById('voice-mode').innerHTML = '<strong>Mode:</strong> —';
      document.getElementById('voice-diag').innerHTML = '<strong>Last heard:</strong> —';
      document.getElementById('voice-out').innerHTML = '<strong>Last spoke:</strong> —';
      document.getElementById('last-error').innerHTML = '<strong>Last error:</strong> none';
      if (recording) void stopPtt();
    }
  } catch {
    connection.textContent = 'Offline';
    connection.className = 'status-pill offline';
    pttBtn.disabled = true;
  }
}

const source = new EventSource('/monitor/events');
source.onopen = () => {
  connection.textContent = 'Live';
  connection.className = 'status-pill online';
};
source.onmessage = (message) => {
  const payload = JSON.parse(message.data);
  if (payload.type === 'snapshot') {
    feed.innerHTML = '';
    events.clear();
    for (const event of payload.events) renderEvent(event);
    return;
  }
  if (payload.type === 'event') renderEvent(payload.event);
};
source.onerror = () => {
  connection.textContent = 'Reconnecting…';
  connection.className = 'status-pill offline';
};

bindPttButton();
refreshStatus();
setInterval(refreshStatus, 3000);
