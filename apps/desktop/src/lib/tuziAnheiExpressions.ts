/** Native .exp3.json presets for tuzi anhei (dark rabbit) full model. */

export const TUZI_ANHEI_EXPRESSIONS = {
  aixin: 'heart overlay',
  benghuai: 'breakdown / meltdown face',
  changsanfa: 'long hair down',
  daemao: 'big cat ears accessory',
  hanzhu: 'sweat drop',
  heifajia: 'black hair clip',
  heihua: 'dark outfit variant',
  heilian: 'darkened / shadow face',
  hongguang: 'red glow eyes',
  houmahuabian: 'back braid flower',
  houqun: 'back skirt layer',
  huluobofajia: 'carrot hair clip',
  lianhong: 'blush',
  liulei: 'tears',
  xingxing: 'sparkle eyes',
  xueji: 'blood stain',
  yihuo: 'confused / puzzled'
} as const;

export type TuziAnheiExpression = keyof typeof TUZI_ANHEI_EXPRESSIONS;

const MOOD_TO_NATIVE: Record<string, TuziAnheiExpression[]> = {
  happy: ['lianhong', 'aixin'],
  sad: ['liulei'],
  angry: ['heilian', 'hongguang'],
  surprised: ['yihuo', 'xingxing'],
  shy: ['lianhong', 'hanzhu'],
  relaxed: ['lianhong']
};

const ALIASES: Record<string, TuziAnheiExpression> = {
  smile: 'lianhong',
  grin: 'aixin',
  laugh: 'aixin',
  heart: 'aixin',
  love: 'aixin',
  blush: 'lianhong',
  embarrassed: 'lianhong',
  frown: 'liulei',
  cry: 'liulei',
  sob: 'liulei',
  tears: 'liulei',
  mad: 'heilian',
  glare: 'hongguang',
  scowl: 'heilian',
  shock: 'yihuo',
  confused: 'yihuo',
  sweat: 'hanzhu',
  nervous: 'hanzhu',
  stars: 'xingxing',
  sparkle: 'xingxing',
  breakdown: 'benghuai',
  meltdown: 'benghuai',
  blood: 'xueji',
  dark: 'heilian',
  menace: 'hongguang'
};

export function resolveTuziAnheiExpressions(name: string): TuziAnheiExpression[] {
  const key = String(name || '').toLowerCase().trim();
  if (!key || key === 'neutral') return [];

  const alias = ALIASES[key];
  if (alias) return [alias];

  if (key in TUZI_ANHEI_EXPRESSIONS) {
    return [key as TuziAnheiExpression];
  }

  const mood = MOOD_TO_NATIVE[key];
  if (mood?.length) return mood;

  return [];
}

export function mapActionToTuziAnheiExpressions(action: string): TuziAnheiExpression[] {
  const key = action.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key) return [];

  if (/\blaugh|\bgiggle|\bchuckle|\bsmile|\bgrin/.test(key)) return ['lianhong', 'aixin'];
  if (/\bsigh|\bsad|\bcry|\bsob|\bfrown|\btear/.test(key)) return ['liulei'];
  if (/\bangry|\bglare|\bscowl|\bfurious/.test(key)) return ['heilian', 'hongguang'];
  if (/\bsurprise|\bgasp|\bshock/.test(key)) return ['yihuo', 'xingxing'];
  if (/\bblush|\bshy|\bembarrass/.test(key)) return ['lianhong'];
  if (/\bconfus|\bpuzzle|\bhuh/.test(key)) return ['yihuo'];
  if (/\bsweat|\bnervous|\banxious/.test(key)) return ['hanzhu'];
  if (/\bbreak|\bmeltdown|\bsnap/.test(key)) return ['benghuai'];
  if (/\bheart|\blove|\badore/.test(key)) return ['aixin'];
  if (/\bstar|\bsparkle|\bshine/.test(key)) return ['xingxing'];
  if (/\bblood|\bcreepy|\bscary/.test(key)) return ['xueji', 'hongguang'];
  if (/\bear|\btail|\bperk|\bbounce/.test(key)) return ['xingxing'];

  return [];
}
