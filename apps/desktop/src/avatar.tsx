import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { AvatarStage } from './components/AvatarStage';
import { RealtimeClient, type CompanionState, type RealtimeEvent } from './lib/realtime';
import './styles/app.css';

function FloatingAvatar() {
  const client = useMemo(() => new RealtimeClient({ audioEnabled: false }), []);
  const [state, setState] = useState<CompanionState>('idle');
  const [expression, setExpression] = useState('neutral');
  const [modelName, setModelName] = useState('AI_Maid');

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<RealtimeEvent>).detail;
      if (detail.type === 'avatar.state') setState(detail.payload.state);
      if (detail.type === 'avatar.expression') setExpression(detail.payload.expression);
      if (detail.type === 'avatar.model.change') setModelName(detail.payload.modelName);
    };
    client.addEventListener('event', handler);
    void client.connect().catch(() => undefined);
    return () => client.removeEventListener('event', handler);
  }, [client]);

  return (
    <div
      className="floating-shell"
      onPointerDown={() => void getCurrentWebviewWindow().startDragging()}
    >
      <AvatarStage state={state} expression={expression} modelName={modelName} floating />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<FloatingAvatar />);
