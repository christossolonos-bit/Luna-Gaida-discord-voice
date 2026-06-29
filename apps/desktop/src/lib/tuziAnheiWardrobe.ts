export type TuziAnheiOutfit = 'light' | 'dark';

export interface AvatarWardrobePayload {
  outfit: TuziAnheiOutfit;
  accessories: string[];
  motion?: string | null;
}

/** Live2D parameter toggles for persistent wardrobe layers (tuzi anhei). */
export const WARDROBE_LAYERS: Record<string, { param: string; value: number }> = {
  heihua: { param: 'Param61', value: 1 },
  changsanfa: { param: 'Param58', value: 1 },
  heifajia: { param: 'Param57', value: 1 },
  huluobofajia: { param: 'Param52', value: 1 },
  houmahuabian: { param: 'Param59', value: 1 },
  houqun: { param: 'Param62', value: 1 },
  daemao: { param: 'Param72', value: 1 }
};

export const WARDROBE_PARAM_IDS = [...new Set(Object.values(WARDROBE_LAYERS).map((layer) => layer.param))];

/** Face-only overlays — wardrobe resets must not clear these while held. */
export const FACE_OVERLAY_LAYERS: Record<string, { param: string; value: number }> = {
  aixin: { param: 'Param63', value: 1 },
  benghuai: { param: 'Param68', value: 1 },
  hanzhu: { param: 'Param67', value: 1 },
  heilian: { param: 'Param56', value: 1 },
  hongguang: { param: 'Param69', value: 1 },
  lianhong: { param: 'Param55', value: 1 },
  liulei: { param: 'Param54', value: 1 },
  xingxing: { param: 'Param53', value: 1 },
  xueji: { param: 'Param60', value: 1 },
  yihuo: { param: 'Param66', value: 1 }
};

export const FACE_OVERLAY_PARAM_IDS = [...new Set(Object.values(FACE_OVERLAY_LAYERS).map((layer) => layer.param))];

export function buildWardrobeParamValues(payload: AvatarWardrobePayload) {
  const values: Record<string, number> = {};
  for (const paramId of WARDROBE_PARAM_IDS) {
    values[paramId] = 0;
  }
  if (payload.outfit === 'dark') {
    values.Param61 = 1;
  }
  for (const accessory of payload.accessories) {
    const layer = WARDROBE_LAYERS[accessory.toLowerCase()];
    if (layer) values[layer.param] = layer.value;
  }
  return values;
}
