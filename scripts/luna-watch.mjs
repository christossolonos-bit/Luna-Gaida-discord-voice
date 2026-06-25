#!/usr/bin/env node
/** Poll Luna /monitor/status and print new activity + flag errors. */

const base = process.env.GIADA_MONITOR_URL ?? 'http://127.0.0.1:8787';
const intervalMs = Number(process.env.LUNA_WATCH_MS ?? 2000);
let lastId = 0;

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  user: '\x1b[36m',
  assistant: '\x1b[35m',
  success: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  info: '\x1b[34m'
};

function paint(level, text) {
  return `${colors[level] ?? colors.info}${text}${colors.reset}`;
}

function printEvent(event) {
  const time = new Date(event.time).toLocaleTimeString();
  console.log(paint(event.level, `[${time}] ${event.title}`));
  if (event.detail) console.log(paint('dim', `  ${event.detail}`));
  if (event.level === 'error' || event.level === 'warn') {
    console.log(paint('warn', '  ^ needs attention'));
  }
}

async function tick() {
  try {
    const snapshot = await fetch(`${base}/monitor/status`).then((r) => r.json());
    const events = snapshot?.recent ?? [];
    for (const event of events) {
      if (event.id <= lastId) continue;
      lastId = Math.max(lastId, event.id);
      printEvent(event);
    }
    const voice = snapshot?.discord?.voiceBridges?.[0];
    if (voice?.lastError) {
      console.log(paint('error', `[voice error] ${voice.lastError}`));
    }
  } catch (error) {
    console.log(paint('error', `Watch failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

console.log(paint('info', `Luna watch → ${base}/monitor/status every ${intervalMs}ms`));
console.log(paint('dim', 'Speak in Discord voice to see live events\n'));

const snapshot = await fetch(`${base}/monitor/status`).then((r) => r.json()).catch(() => null);
if (snapshot?.discord?.user?.tag) {
  console.log(paint('success', `Bot: ${snapshot.discord.user.tag}`));
  console.log(paint('dim', `wakeRequired should be false in server log\n`));
}
for (const event of snapshot?.recent ?? []) {
  lastId = Math.max(lastId, event.id);
  printEvent(event);
}

setInterval(tick, intervalMs);
