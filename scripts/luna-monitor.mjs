#!/usr/bin/env node

const base = process.env.GIADA_MONITOR_URL ?? 'http://127.0.0.1:8787';

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
  const code = colors[level] ?? colors.info;
  return `${code}${text}${colors.reset}`;
}

function printEvent(event) {
  const time = new Date(event.time).toLocaleTimeString();
  const head = paint(event.level, `[${time}] ${event.title}`);
  console.log(head);
  if (event.detail) console.log(paint('dim', `  ${event.detail}`));
}

async function main() {
  console.log(paint('info', `Luna monitor → ${base}/monitor/events`));
  console.log(paint('dim', 'Press Ctrl+C to stop\n'));

  const snapshot = await fetch(`${base}/monitor/status`).then((r) => r.json()).catch(() => null);
  if (snapshot?.discord?.user?.tag) {
    console.log(paint('success', `Bot: ${snapshot.discord.user.tag} (${snapshot.discord.connected ? 'online' : 'offline'})`));
  }
  for (const event of snapshot?.recent ?? []) printEvent(event);

  const response = await fetch(`${base}/monitor/events`, {
    headers: { Accept: 'text/event-stream' }
  });
  if (!response.ok || !response.body) {
    console.error(paint('error', `Could not connect (${response.status}). Is the server running?`));
    process.exit(1);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((row) => row.startsWith('data: '));
      if (!line) continue;
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.type === 'event') printEvent(payload.event);
      } catch { /* ignore */ }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
