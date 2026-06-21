import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { AvatarStage } from './components/AvatarStage';
import { ControlPanel } from './components/ControlPanel';
import { RealtimeClient, type CompanionState, type RealtimeEvent, type TranscriptLine } from './lib/realtime';
import './styles/app.css';

function App() {
  const client = useMemo(() => new RealtimeClient({ audioEnabled: true }), []);
  const [status, setStatus] = useState('offline');
  const [state, setState] = useState<CompanionState>('idle');
  const [expression, setExpression] = useState('neutral');
  const [modelName, setModelName] = useState('AI_Maid');
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([]);
  const [mic, setMic] = useState(false);
  const [screen, setScreen] = useState(false);
  const [passive, setPassive] = useState(false);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<RealtimeEvent>).detail;
      if (detail.type === 'status') {
        setStatus(detail.reason ? `${detail.status}: ${detail.reason}` : detail.status);
      } else if (detail.type === 'input.ack') {
        setStatus('connected · message accepted');
        setState('thinking');
      } else if (detail.type === 'response.empty') {
        setStatus(`error: ${detail.reason}`);
      } else if (detail.type === 'screen.status') {
        setScreen(detail.status === 'sharing');
        if (detail.status === 'error') {
          setStatus(`screen error: ${detail.reason ?? 'unknown error'}`);
        }
      } else if (detail.type === 'avatar.state') {
        setState(detail.payload.state);
        if (detail.payload.state === 'speaking') {
          setStatus('connected');
        }
      } else if (detail.type === 'avatar.expression') {
        setExpression(detail.payload.expression);
      } else if (detail.type === 'avatar.model.change') {
        setModelName(detail.payload.modelName);
      } else if (detail.type === 'transcript') {
        setTranscripts((current) => mergeTranscript(current, detail));
      }
    };
    client.addEventListener('event', handler);
    void client.connect().catch(() => undefined);
    return () => client.removeEventListener('event', handler);
  }, [client]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ title: string; body: string }>('native-notification-request', async (event) => {
      if (!('Notification' in window)) {
        return;
      }
      const permission = Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission === 'granted') {
        new Notification(event.payload.title, { body: event.payload.body });
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  return (
    <main className="app-shell">
      <section className="avatar-pane">
        <AvatarStage state={state} expression={expression} modelName={modelName} analyser={client.player.getAnalyser()} />
      </section>
      <ControlPanel
        client={client}
        status={status}
        state={state}
        transcripts={transcripts}
        mic={mic}
        setMic={setMic}
        screen={screen}
        setScreen={setScreen}
        passive={passive}
        setPassive={setPassive}
      />
    </main>
  );
}

function mergeTranscript(current: TranscriptLine[], detail: Extract<RealtimeEvent, { type: 'transcript' }>) {
  const normalized = detail.text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return current;
  }

  const next = [...current];
  const last = next[next.length - 1];

  if (last && last.speaker === detail.speaker && last.final && normalized === last.text) {
    return current;
  }

  if (last && last.speaker === detail.speaker && !last.final) {
    const text = detail.final ? normalized : appendTranscriptText(last.text, normalized);
    next[next.length - 1] = { ...last, text, final: detail.final };
    return next.slice(-80);
  }

  next.push({
    id: crypto.randomUUID(),
    speaker: detail.speaker,
    text: normalized,
    final: detail.final
  });
  return next.slice(-80);
}

function appendTranscriptText(previous: string, incoming: string) {
  if (incoming.startsWith(previous)) {
    return incoming;
  }
  if (previous.endsWith(incoming)) {
    return previous;
  }
  for (let length = Math.min(previous.length, incoming.length); length >= 3; length -= 1) {
    if (previous.slice(-length) === incoming.slice(0, length)) return `${previous}${incoming.slice(length)}`;
  }

  const previousLast = previous.at(-1) ?? '';
  const incomingFirst = incoming.at(0) ?? '';
  const noSpaceBeforeIncoming = /^[,.;:!?)]$/.test(incomingFirst);
  const noSpaceAfterPrevious = previousLast === '(';
  const wordBoundary = /[\p{L}\p{N}"']$/u.test(previousLast) && /^[\p{L}\p{N}"'(]$/u.test(incomingFirst);
  const sentenceBoundary = /[.!?]$/.test(previousLast) && /^[\p{L}\p{N}"'(]$/u.test(incomingFirst);
  const needsSpace =
    !previous.endsWith(' ') &&
    !incoming.startsWith(' ') &&
    !noSpaceBeforeIncoming &&
    !noSpaceAfterPrevious &&
    (wordBoundary || sentenceBoundary);

  return `${previous}${needsSpace ? ' ' : ''}${incoming}`;
}

createRoot(document.getElementById('root')!).render(<App />);
