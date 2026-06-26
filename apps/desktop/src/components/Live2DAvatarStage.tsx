import { useEffect, useRef, useState } from 'react';
import { LUNA_NAME } from '../lib/lunaBrand';
import type { CompanionState } from '../lib/realtime';
import { Live2DAvatarRuntime, resolveLive2dModelUrl } from '../lib/live2dRuntime';

interface Live2DAvatarStageProps {
  state: CompanionState;
  expression: string;
  floating?: boolean;
}

export function Live2DAvatarStage({ state, expression, floating = false }: Live2DAvatarStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<Live2DAvatarRuntime | null>(null);
  const [hint, setHint] = useState(() => resolveLive2dModelUrl() ? '' : 'Set VITE_LIVE2D_MODEL_URL to your .model3.json path');

  useEffect(() => {
    if (!containerRef.current || runtimeRef.current) return;
    const runtime = new Live2DAvatarRuntime(containerRef.current);
    runtimeRef.current = runtime;
    void runtime.start().then(() => {
      if (resolveLive2dModelUrl()) setHint('');
    }).catch((error) => {
      setHint(error instanceof Error ? error.message : String(error));
    });
    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    runtimeRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    runtimeRef.current?.setExpression(expression);
  }, [expression]);

  return (
    <div className={floating ? 'avatar-stage floating live2d-stage' : 'avatar-stage live2d-stage'}>
      <div ref={containerRef} className="live2d-canvas-host" />
      {floating ? <div className="luna-name-tag">{LUNA_NAME}</div> : null}
      {hint ? <div className="live2d-hint">{hint}</div> : null}
    </div>
  );
}
