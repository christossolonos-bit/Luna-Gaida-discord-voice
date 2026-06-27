/** Drive tuzi mian face parameters when the model has no .exp3.json presets. */

const EXPRESSION_PARAMS = [
  'ParamEyeLSmile',
  'ParamEyeRSmile',
  'ParamMouthForm',
  'ParamBrowLY',
  'ParamBrowRY',
  'ParamBrowLForm',
  'ParamBrowRForm',
  'ParamCheek'
] as const;

const EYE_OPEN_PARAMS = ['ParamEyeLOpen', 'ParamEyeROpen'] as const;
const EYE_OPEN_BASELINE = 1;

const MANAGED_PARAMS = [...EXPRESSION_PARAMS, ...EYE_OPEN_PARAMS] as const;

export const LIP_SYNC_PARAM = 'ParamMouthOpenY';

const PRESETS: Record<string, Partial<Record<(typeof MANAGED_PARAMS)[number], number>>> = {
  neutral: {},
  happy: {
    ParamMouthForm: 0.85,
    ParamEyeLSmile: 1,
    ParamEyeRSmile: 1,
    ParamBrowLY: 0.3,
    ParamBrowRY: 0.3
  },
  sad: {
    ParamMouthForm: -0.55,
    ParamBrowLY: -0.5,
    ParamBrowRY: -0.5,
    ParamBrowLForm: -0.35,
    ParamBrowRForm: -0.35
  },
  angry: {
    ParamMouthForm: -0.35,
    ParamBrowLY: -0.7,
    ParamBrowRY: -0.7,
    ParamBrowLForm: -1,
    ParamBrowRForm: -1
  },
  surprised: {
    ParamEyeLOpen: 1.2,
    ParamEyeROpen: 1.2,
    ParamBrowLY: 0.8,
    ParamBrowRY: 0.8,
    ParamMouthForm: 0.15
  },
  shy: {
    ParamCheek: 1,
    ParamMouthForm: 0.3,
    ParamEyeLSmile: 0.45,
    ParamEyeRSmile: 0.45,
    ParamBrowLY: -0.1,
    ParamBrowRY: -0.1
  },
  relaxed: {
    ParamMouthForm: 0.2,
    ParamEyeLSmile: 0.15,
    ParamEyeRSmile: 0.15
  }
};

const ALIASES: Record<string, string> = {
  smile: 'happy',
  grin: 'happy',
  laugh: 'happy',
  frown: 'sad',
  cry: 'sad',
  mad: 'angry',
  shock: 'surprised',
  blush: 'shy',
  embarrassed: 'shy'
};

type ParamValues = Record<(typeof MANAGED_PARAMS)[number], number>;

function baselineValues(): ParamValues {
  const values = Object.fromEntries(EXPRESSION_PARAMS.map((id) => [id, 0])) as ParamValues;
  for (const id of EYE_OPEN_PARAMS) {
    values[id] = EYE_OPEN_BASELINE;
  }
  return values;
}

function defaultForParam(id: (typeof MANAGED_PARAMS)[number]) {
  return EYE_OPEN_PARAMS.includes(id as (typeof EYE_OPEN_PARAMS)[number]) ? EYE_OPEN_BASELINE : 0;
}

function resolvePreset(name: string) {
  const key = String(name || 'neutral').toLowerCase();
  const resolved = ALIASES[key] ?? key;
  return PRESETS[resolved] ? resolved : 'neutral';
}

function buildTarget(presetName: string, intensity: number): ParamValues {
  const preset = PRESETS[presetName] ?? PRESETS.neutral;
  const clamped = Math.min(1, Math.max(0, intensity));
  const target = baselineValues();
  for (const [id, value] of Object.entries(preset ?? {})) {
    const paramId = id as (typeof MANAGED_PARAMS)[number];
    if (EYE_OPEN_PARAMS.includes(paramId as (typeof EYE_OPEN_PARAMS)[number])) {
      target[paramId] = EYE_OPEN_BASELINE + (value - EYE_OPEN_BASELINE) * clamped;
    } else {
      target[paramId] = value * clamped;
    }
  }
  return target;
}

function getCoreModel(model: { internalModel?: { coreModel?: CubismCore } } | null) {
  return model?.internalModel?.coreModel ?? null;
}

interface CubismCore {
  getParameterIndex?: (id: string) => number;
  setParameterValueByIndex?: (index: number, value: number) => void;
}

export function createLive2dFaceController(getModel: () => { internalModel?: { coreModel?: CubismCore } } | null) {
  let activeValues = baselineValues();
  let fadeTimer: ReturnType<typeof setInterval> | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  function writeAll(values: ParamValues) {
    const core = getCoreModel(getModel());
    if (!core) return;
    for (const [id, value] of Object.entries(values)) {
      const index = core.getParameterIndex?.(id);
      if (index != null && index >= 0) {
        core.setParameterValueByIndex?.(index, value);
      }
    }
  }

  function clearTimers() {
    if (fadeTimer) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function applyBaseline() {
    clearTimers();
    activeValues = baselineValues();
    writeAll(activeValues);
  }

  function animateTo(targetValues: ParamValues, durationMs: number, onDone?: () => void) {
    const startValues = { ...activeValues };
    const start = performance.now();
    clearTimers();
    fadeTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / durationMs);
      const eased = t * (2 - t);
      for (const id of MANAGED_PARAMS) {
        const from = startValues[id] ?? defaultForParam(id);
        const to = targetValues[id] ?? defaultForParam(id);
        activeValues[id] = from + (to - from) * eased;
      }
      writeAll(activeValues);
      if (t >= 1) {
        clearInterval(fadeTimer!);
        fadeTimer = null;
        onDone?.();
      }
    }, 16);
  }

  function setExpression(name: string, intensity = 1) {
    const presetName = resolvePreset(name);
    if (presetName === 'neutral' || intensity <= 0) {
      animateTo(baselineValues(), 280);
      return;
    }

    const target = buildTarget(presetName, intensity);
    animateTo(target, 220, () => {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        animateTo(baselineValues(), 650);
      }, 4200);
    });
  }

  function reset() {
    applyBaseline();
  }

  function dispose() {
    clearTimers();
    activeValues = baselineValues();
  }

  return { setExpression, reset, dispose, applyBaseline };
}
