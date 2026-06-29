import { inferBondTier, type BondTier } from '../memory/relationshipBond.js';

export type TuziAnheiOutfit = 'light' | 'dark';

export type TuziAnheiAccessory =
  | 'changsanfa'
  | 'heifajia'
  | 'huluobofajia'
  | 'houmahuabian'
  | 'houqun'
  | 'daemao';

export interface AvatarWardrobePayload {
  outfit: TuziAnheiOutfit;
  accessories: TuziAnheiAccessory[];
  motion?: string | null;
}

export interface WardrobeResolveInput {
  relationship?: string | null;
  actions?: string[];
  replyText?: string;
  previous?: AvatarWardrobePayload | null;
}

const ALL_ACCESSORIES: TuziAnheiAccessory[] = [
  'changsanfa',
  'heifajia',
  'huluobofajia',
  'houmahuabian',
  'houqun',
  'daemao'
];

function wardrobeFromBond(tier: BondTier): AvatarWardrobePayload {
  switch (tier) {
    case 'hostile':
      return { outfit: 'dark', accessories: ['houqun', 'heifajia'] };
    case 'annoyed':
      return { outfit: 'dark', accessories: ['heifajia'] };
    case 'cool':
      return { outfit: 'light', accessories: [] };
    case 'romantic':
      return { outfit: 'light', accessories: ['huluobofajia', 'changsanfa', 'houmahuabian'] };
    case 'bonded':
      return { outfit: 'light', accessories: ['huluobofajia', 'changsanfa'] };
    case 'warming':
      return { outfit: 'light', accessories: ['huluobofajia'] };
    case 'acquaintance':
    case 'stranger':
    default:
      return { outfit: 'light', accessories: [] };
  }
}

function normalizeAction(action: string) {
  return action.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickAccessoryFromAction(key: string): TuziAnheiAccessory | null {
  if (/\b(cat ears?|daemao|neko)\b/.test(key)) return 'daemao';
  if (/\b(carrot|huluobo)\b/.test(key)) return 'huluobofajia';
  if (/\b(black clip|heifa)\b/.test(key)) return 'heifajia';
  if (/\b(braid|mahua|flower braid)\b/.test(key)) return 'houmahuabian';
  if (/\b(long hair|hair down|changsan)\b/.test(key)) return 'changsanfa';
  if (/\b(skirt|houqun)\b/.test(key)) return 'houqun';
  return null;
}

function outfitFromAction(key: string): TuziAnheiOutfit | null {
  if (/\b(dark outfit|black (?:dress|outfit|clothes)|gothic|暗黑|switch(?:es|ed)? to (?:her )?dark)\b/.test(key)) {
    return 'dark';
  }
  if (/\b(light outfit|white (?:dress|outfit|clothes)|soft dress|switch(?:es|ed)? to (?:her )?(?:light|white))\b/.test(key)) {
    return 'light';
  }
  if (/\b(change(?:s|d)? (?:her )?outfit|change(?:s|d)? clothes|huanzhuang|wardrobe|outfit change)\b/.test(key)) {
    return null;
  }
  return null;
}

function outfitFromReplyTone(text: string): TuziAnheiOutfit | null {
  const lower = text.toLowerCase();
  if (/\b(furious|venom|contempt|hate you|disgusting|pathetic)\b/.test(lower)) return 'dark';
  if (/\b(darling|love you|adorable|sweetheart|so happy|delighted)\b/.test(lower)) return 'light';
  return null;
}

function accessoriesFromReplyTone(text: string, outfit: TuziAnheiOutfit): TuziAnheiAccessory[] {
  const lower = text.toLowerCase();
  const picks: TuziAnheiAccessory[] = [];
  if (/\b(playful|teasing|giggle|hehe)\b/.test(lower) && outfit === 'light') {
    picks.push('daemao');
  }
  if (/\b(flirt|wink|charming)\b/.test(lower) && outfit === 'light') {
    picks.push('houmahuabian');
  }
  return picks;
}

function mergeAccessories(base: TuziAnheiAccessory[], extra: TuziAnheiAccessory[]) {
  const merged = [...base];
  for (const item of extra) {
    if (!merged.includes(item)) merged.push(item);
  }
  return normalizeAccessories(merged);
}

/** Carrot clip and black clip occupy the same vibe slot — prefer one. */
function normalizeAccessories(items: TuziAnheiAccessory[]) {
  const set = new Set(items.filter((item) => ALL_ACCESSORIES.includes(item)));
  if (set.has('huluobofajia') && set.has('heifajia')) {
    set.delete('heifajia');
  }
  return [...set];
}

function wardrobeFromActions(actions: string[], base: AvatarWardrobePayload): AvatarWardrobePayload {
  let outfit = base.outfit;
  let accessories = [...base.accessories];
  let outfitToggled = false;

  for (const action of actions) {
    const key = normalizeAction(action);
    if (!key) continue;

    const fromAction = outfitFromAction(key);
    if (fromAction) {
      outfit = fromAction;
      outfitToggled = true;
    } else if (/\b(change(?:s|d)? (?:her )?outfit|change(?:s|d)? clothes|huanzhuang|wardrobe)\b/.test(key)) {
      outfit = outfit === 'light' ? 'dark' : 'light';
      outfitToggled = true;
    }

    const accessory = pickAccessoryFromAction(key);
    if (accessory) {
      accessories = mergeAccessories(accessories, [accessory]);
    }

    if (/\b(remove|take off|drops) (?:the )?(?:clip|ears|accessory|skirt)\b/.test(key)) {
      accessories = [];
    }
  }

  return {
    outfit,
    accessories: normalizeAccessories(accessories),
    motion: outfitToggled ? 'Outfit' : base.motion ?? null
  };
}

export function resolveAvatarWardrobe(input: WardrobeResolveInput): AvatarWardrobePayload {
  const tier = inferBondTier(input.relationship);
  let next = wardrobeFromBond(tier);

  const toneOutfit = outfitFromReplyTone(input.replyText ?? '');
  if (toneOutfit) {
    next = { ...next, outfit: toneOutfit };
  }

  next = wardrobeFromActions(input.actions ?? [], next);

  const toneAccessories = accessoriesFromReplyTone(input.replyText ?? '', next.outfit);
  next = {
    ...next,
    accessories: mergeAccessories(next.accessories, toneAccessories)
  };

  const previous = input.previous;
  const outfitChanged = previous && previous.outfit !== next.outfit;
  if (outfitChanged) {
    next = { ...next, motion: 'Outfit' };
  }

  return {
    outfit: next.outfit,
    accessories: normalizeAccessories(next.accessories),
    motion: next.motion ?? null
  };
}

const ACCESSORY_LABELS: Record<TuziAnheiAccessory, string> = {
  changsanfa: 'long hair worn down',
  heifajia: 'black hair clip',
  huluobofajia: 'carrot hair clip',
  houmahuabian: 'braid flower at the back',
  houqun: 'back skirt layer',
  daemao: 'cat ears'
};

export function wardrobeLookForPrompt(
  relationship: string | null | undefined,
  current: AvatarWardrobePayload
): AvatarWardrobePayload {
  if (current.outfit !== 'light' || current.accessories.length > 0) {
    return current;
  }
  return resolveAvatarWardrobe({ relationship, previous: current });
}

function describeOutfit(outfit: TuziAnheiOutfit) {
  return outfit === 'dark'
    ? 'dark gothic dress'
    : 'light white dress';
}

function describeAccessories(accessories: TuziAnheiAccessory[]) {
  if (!accessories.length) return 'no accessories';
  return accessories.map((item) => ACCESSORY_LABELS[item]).join(', ');
}

export function buildAvatarLookStateBlock(look: AvatarWardrobePayload): string {
  return [
    'Your avatar right now:',
    `- Outfit: ${describeOutfit(look.outfit)}`,
    `- Accessories: ${describeAccessories(look.accessories)}`,
    'Callers can see this on your Live2D overlay. If they mention your dress, clips, ears, or mood on your face, you know what you look like — answer in character.'
  ].join('\n');
}

export const AVATAR_BODY_CATALOG = [
  'YOUR LIVE2D AVATAR (you are on screen — people see your body and face):',
  '',
  'Outfits — you choose, or your mood toward them picks for you:',
  '• Light white dress — soft, cute, open; when you are warm, happy, bonded, or romantic',
  '• Dark gothic dress — when you are hostile, annoyed, cold, or feeling dramatic',
  'Switch outfits with *asterisk actions* like *switches to her dark outfit* or *changes into the white dress* — plays a spin animation on screen.',
  '',
  'Accessories you can wear (mix and match):',
  '• Carrot hair clip, black hair clip, long hair down, braid flower, back skirt layer, cat ears',
  'Use *actions* when it fits: *tucks a carrot clip in her hair*, *cat ears pop up*.',
  '',
  'Face and body reactions (brief on-screen overlays via *actions*):',
  '• Blush, tears, heart eyes, sparkles, sweat, confused look, breakdown face, shadowed face, red glowing eyes, blood stain',
  'Examples: *blushes*, *tears up*, *eyes go red*.',
  '',
  'Animations you can trigger:',
  '• Outfit-change spin, tear animation, blood-bead drip, subtle breakdown-eye idle when moody',
  '',
  'When someone says "you look good in that dress" or "why the dark outfit" — you are NOT clueless. You know what you are wearing and why. Own it.'
].join('\n');

export function buildAvatarAwarenessPromptBlock(
  relationship: string | null | undefined,
  current: AvatarWardrobePayload
): string {
  const look = wardrobeLookForPrompt(relationship, current);
  return [AVATAR_BODY_CATALOG, buildAvatarLookStateBlock(look)].join('\n\n');
}

/** @deprecated Use buildAvatarAwarenessPromptBlock */
export const AVATAR_WARDROBE_PROMPT = AVATAR_BODY_CATALOG;
