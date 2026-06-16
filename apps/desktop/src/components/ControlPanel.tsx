import { Bell, Clipboard, Globe, Mic, MicOff, MonitorUp, Pause, Play, Shield, VolumeX } from 'lucide-react';
import type { FormEvent } from 'react';
import type { CompanionState, RealtimeClient, TranscriptLine } from '../lib/realtime';
import { openAllowedUrl, setClipboardEnabled, setScreenshotEnabled, showNotification } from '../lib/permissions';

interface ControlPanelProps {
  client: RealtimeClient;
  status: string;
  state: CompanionState;
  transcripts: TranscriptLine[];
  mic: boolean;
  setMic: (value: boolean) => void;
  screen: boolean;
  setScreen: (value: boolean) => void;
  passive: boolean;
  setPassive: (value: boolean) => void;
}

export function ControlPanel(props: ControlPanelProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = String(form.get('text') ?? '').trim();
    if (text) {
      props.client.sendText(text);
      event.currentTarget.reset();
    }
  };

  return (
    <aside className="control-panel">
      <header>
        <div>
          <h1>Giada</h1>
          <p>{props.status} · {props.state}</p>
        </div>
        <button title="Open Gemini Live API docs" onClick={() => void openAllowedUrl('https://ai.google.dev/gemini-api/docs/live-api')}>
          <Globe size={18} />
        </button>
      </header>

      <section className="toolbar">
        <button title="Connect live session" onClick={() => props.client.connect()}><Play size={18} /></button>
        <button title="Interrupt response" onClick={() => props.client.interrupt()}><VolumeX size={18} /></button>
        <button
          title="Toggle microphone"
          className={props.mic ? 'active' : ''}
          onClick={() => {
            const next = !props.mic;
            props.setMic(next);
            if (next) void props.client.startMicrophone();
            else props.client.stopMicrophone();
          }}
        >
          {props.mic ? <Mic size={18} /> : <MicOff size={18} />}
        </button>
        <button
          title="Toggle screen sharing"
          className={props.screen ? 'active' : ''}
          onClick={() => {
            const next = !props.screen;
            props.setScreen(next);
            if (next) void props.client.startScreenShare({ fps: 1, systemAudio: true });
            else props.client.stopScreenShare();
          }}
        >
          <MonitorUp size={18} />
        </button>
        <button
          title="Passive listening"
          className={props.passive ? 'active' : ''}
          onClick={() => {
            const next = !props.passive;
            props.setPassive(next);
            props.client.setPassive(next);
          }}
        >
          <Pause size={18} />
        </button>
      </section>

      <section className="permissions">
        <h2>Permissions</h2>
        <label><input type="checkbox" onChange={(event) => void setClipboardEnabled(event.currentTarget.checked)} /> Clipboard</label>
        <label><input type="checkbox" onChange={(event) => void setScreenshotEnabled(event.currentTarget.checked)} /> Native screenshot</label>
        <button onClick={() => void showNotification('Giada', 'Desktop notifications are enabled.')}><Bell size={16} /> Test notification</button>
        <p><Shield size={14} /> File access is scoped to app data/config/cache/assets. Shell execution is not exposed.</p>
      </section>

      <section className="transcript">
        {props.transcripts.map((line) => (
          <article key={line.id} className={line.speaker}>
            <strong>{line.speaker === 'assistant' ? 'Giada' : 'You'}</strong>
            <span>{line.text}</span>
          </article>
        ))}
      </section>

      <form className="composer" onSubmit={submit}>
        <input name="text" placeholder="Type to Giada" autoComplete="off" />
        <button title="Send text"><Clipboard size={18} /></button>
      </form>
    </aside>
  );
}
