import * as PIXI from 'pixi.js';
import { install } from '@pixi/unsafe-eval';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import type { CompanionState } from './realtime';
import { createLive2dFaceController, LIP_SYNC_PARAM } from './live2dFaceExpressions';

install(PIXI);
// pixi-live2d-display expects a global PIXI on window
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

const MOUTH_OPEN_PARAM = LIP_SYNC_PARAM;

const motionCandidates: Record<CompanionState, string[]> = {
  idle: ['Idle', 'idle', 'benghuaiyanzhu', 'waiting'],
  listening: ['listening', 'Listening', 'Idle', 'idle'],
  thinking: ['thinking', 'Think', 'Idle', 'idle'],
  speaking: ['talk', 'Speak', 'Idle', 'idle'],
  reacting: ['Tears', 'Blood', 'Outfit', 'tap', 'TapBody', 'Tap', 'idle']
};

export function resolveLive2dModelUrl() {
  const fromEnv = import.meta.env.VITE_LIVE2D_MODEL_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = localStorage.getItem('luna.live2d.modelUrl')?.trim();
    if (saved) return saved;
  } catch { /* ignore */ }
  return '';
}

export function saveLive2dModelUrl(url: string) {
  try {
    localStorage.setItem('luna.live2d.modelUrl', url);
  } catch { /* ignore */ }
}

function isAbsoluteFilesystemPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export function toLoadableModelUrl(modelPath: string) {
  const trimmed = modelPath.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') && !isAbsoluteFilesystemPath(trimmed)) return trimmed;
  if (isAbsoluteFilesystemPath(trimmed)) {
    if ('__TAURI_INTERNALS__' in window) {
      return convertFileSrc(trimmed);
    }
    throw new Error('Local Live2D model paths require the Luna desktop app (Tauri).');
  }
  return trimmed;
}

export class Live2DAvatarRuntime {
  private app: PIXI.Application | null = null;
  private model: Live2DModel | null = null;
  private speakingTimer: ReturnType<typeof setInterval> | null = null;
  private currentState: CompanionState = 'idle';
  private readonly face = createLive2dFaceController(() => this.model);

  constructor(private readonly mount: HTMLElement) {}

  async start() {
    if (this.app) return;
    this.app = new PIXI.Application({
      backgroundAlpha: 0,
      resizeTo: this.mount,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1
    });
    this.mount.appendChild(this.app.view as HTMLCanvasElement);

    const modelUrl = resolveLive2dModelUrl();
    if (modelUrl) {
      await this.loadModel(modelUrl);
    }
  }

  async loadModel(modelUrl: string) {
    if (typeof Live2DCubismCore === 'undefined') {
      throw new Error('Live2D Cubism Core missing — run npm run setup:live2d from GiadaAssistant root');
    }
    if (!this.app) await this.start();

    if (this.model) {
      this.app!.stage.removeChild(this.model);
      this.model.destroy();
      this.model = null;
    }

    const model = await Live2DModel.from(toLoadableModelUrl(modelUrl), { autoInteract: false });
    this.model = model;
    this.app!.stage.addChild(model);
    this.scaleModelToFit(model);
    model.position.set(this.app!.screen.width / 2, this.app!.screen.height * 0.58);
    this.playMotionForState(this.currentState);
    saveLive2dModelUrl(modelUrl);
  }

  setState(state: CompanionState) {
    this.currentState = state;
    if (!this.model) return;
    this.playMotionForState(state);
    if (state === 'speaking') {
      this.startSpeakingAnimation();
    } else {
      this.stopSpeakingAnimation();
    }
  }

  setExpression(expression: string, intensity = 1) {
    if (!expression) return;
    this.face.setExpression(expression, intensity);
  }

  setWardrobe(payload: { outfit: 'light' | 'dark'; accessories: string[]; motion?: string | null }) {
    this.face.setWardrobe(payload);
  }

  dispose() {
    this.stopSpeakingAnimation();
    this.face.dispose();
    if (this.model) {
      this.model.destroy();
      this.model = null;
    }
    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
  }

  private scaleModelToFit(model: Live2DModel) {
    if (!this.app) return;
    const internal = model.internalModel;
    const rawW = internal?.width ?? model.getLocalBounds().width ?? 512;
    const rawH = internal?.height ?? model.getLocalBounds().height ?? 512;
    const modelW = Math.max(rawW, 64);
    const modelH = Math.max(rawH, 64);
    const margin = 0.34;
    const scale = Math.min(this.app.screen.width / modelW, this.app.screen.height / modelH) * margin;
    model.scale.set(Math.min(Math.max(scale, 0.1), 0.85));
    model.anchor.set(0.5, 0.5);
  }

  private playMotionForState(state: CompanionState) {
    if (!this.model) return;
    const groups = this.model.internalModel?.motionManager?.groups ?? {};
    const names = Object.keys(groups);
    for (const candidate of motionCandidates[state]) {
      const match = names.find((name) => name.toLowerCase() === candidate.toLowerCase())
        ?? names.find((name) => name.toLowerCase().includes(candidate.toLowerCase()));
      if (match && this.model.internalModel?.motionManager?.definitions?.[match]?.length) {
        this.model.motion(match);
        return;
      }
    }
    const idle = names.find((name) => name.toLowerCase() === 'idle');
    if (idle) this.model.motion(idle);
  }

  private setModelParameter(ids: string[], value: number) {
    const core = this.model?.internalModel?.coreModel as {
      getParameterIndex?: (id: string) => number;
      setParameterValueByIndex?: (index: number, value: number) => void;
    } | undefined;
    if (!core) return;
    for (const id of ids) {
      const index = core.getParameterIndex?.(id);
      if (index != null && index >= 0) {
        core.setParameterValueByIndex?.(index, value);
        return;
      }
    }
  }

  private startSpeakingAnimation() {
    if (!this.model) return;
    if (this.speakingTimer) clearInterval(this.speakingTimer);
    let t = 0;
    this.speakingTimer = setInterval(() => {
      t += 0.25;
      const open = (Math.sin(t * 8) + 1) * 0.35;
      this.setModelParameter([MOUTH_OPEN_PARAM], open);
    }, 50);
  }

  private stopSpeakingAnimation() {
    if (this.speakingTimer) {
      clearInterval(this.speakingTimer);
      this.speakingTimer = null;
    }
    this.setModelParameter([MOUTH_OPEN_PARAM], 0);
  }
}

declare global {
  const Live2DCubismCore: unknown;
}
