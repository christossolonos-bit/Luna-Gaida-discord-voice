export type BondTier =
  | 'stranger'
  | 'acquaintance'
  | 'warming'
  | 'bonded'
  | 'romantic'
  | 'cool'
  | 'annoyed'
  | 'hostile';

export function inferBondTier(relationship: string | null | undefined): BondTier {
  const text = relationship?.trim() ?? '';
  if (!text) return 'stranger';

  const primary = primaryStanceLine(text);
  const fromPrimary = matchTierFromText(primary);
  if (fromPrimary) return fromPrimary;

  const fromFull = matchTierFromText(text.toLowerCase());
  return fromFull ?? 'acquaintance';
}

function primaryStanceLine(relationship: string) {
  for (const line of relationship.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('-')) {
      return trimmed.replace(/^-\s*/, '').toLowerCase();
    }
  }
  return relationship.toLowerCase();
}

function matchTierFromText(text: string): BondTier | null {
  if (/\b(cooled off|slept on it|morning after|overnight calm|next day after a fight)\b/.test(text)) {
    return 'cool';
  }
  if (/\b(warming up again|likes them again|giving (?:them|him|her) another chance|mending things|starting to like)\b/.test(text)) {
    return 'warming';
  }
  if (/\b(forgave|accepted (?:their |the )?apolog|they apologized|sincere apolog|making amends|letting it go|softening|thawing)\b/.test(text)) {
    if (/\b(like|warm|enjoy)\b/.test(text)) return 'warming';
    return 'cool';
  }
  if (/\b(guarded but fair|willing to talk without venom|tolerating them for now)\b/.test(text)) {
    return 'cool';
  }
  if (/\b(less (?:angry|hostile)|calming down|still wary)\b/.test(text)) {
    return 'annoyed';
  }
  if (/\b(ragebait|fed up|furious|hostile|contempt|toxic|lost patience|snapping|wrath|venom)\b/.test(text)) {
    return 'hostile';
  }
  if (/\b(dislike|hate|annoy|irritat|petty|rude to me|talking down|disrespect)\b/.test(text)) {
    return 'annoyed';
  }
  if (/\b(distant|cold|guard|wary|suspicious|cool(?:ing)? off|pull(?:ed)? back|done with)\b/.test(text)) {
    return 'cool';
  }
  if (/\b(in love|loves them|love them|devoted|darling|sweetheart|my person)\b/.test(text)) {
    return 'romantic';
  }
  if (/\b(adore\w*|close trust|very close|flirt\w*|strong bond|deep trust)\b/.test(text)) {
    return 'bonded';
  }
  if (/\b(likes?\s+them|fond|warming up|charm\w*|enjoys?\s+talking|getting along|warm toward)\b/.test(text)) {
    return 'warming';
  }
  if (/\b(forming|curious|neutral|polite|acquaint|just met|early|new caller)\b/.test(text)) {
    return 'acquaintance';
  }
  return null;
}

export function userSignalsRepairAttempt(userSaid: string) {
  const text = userSaid.trim().toLowerCase();
  if (!text) return false;
  return /\b(sorry|apologize|apologies|my bad|didn'?t mean|i was wrong|forgive me|won'?t do (?:that|it) again|make it up|i messed up|that was (?:rude|out of line|wrong)|peace\?)\b/.test(text);
}

export function hoursSinceLastContact(updatedAt: string | null | undefined): number | null {
  if (!updatedAt?.trim()) return null;
  const ms = Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return null;
  return (Date.now() - ms) / (1000 * 60 * 60);
}

export function mostRecentContactAt(...timestamps: Array<string | null | undefined>) {
  let latest: number | null = null;
  for (const value of timestamps) {
    if (!value?.trim()) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function formatAbsenceDuration(hours: number) {
  const rounded = Math.max(1, Math.round(hours));
  if (rounded >= 48) {
    return `about ${Math.round(rounded / 24)} days`;
  }
  if (rounded >= 24) {
    return 'about a day';
  }
  return `about ${rounded} hours`;
}

export function buildAbsencePromptBlock(
  displayName: string,
  relationship: string | null | undefined,
  hoursSince: number | null,
  minHours = 3
): string | null {
  if (hoursSince === null || hoursSince < minHours) {
    return null;
  }

  const who = displayName.trim() || 'them';
  const tier = inferBondTier(relationship);
  const duration = formatAbsenceDuration(hoursSince);

  return [
    `It has been ${duration} since you last heard from ${who}.`,
    absenceMoodGuidance(tier, who),
    'Let the gap affect your mood and subtext naturally if it fits this reply — no stock lines, no forced "I missed you" unless your bond and personality genuinely go there.'
  ].join(' ');
}

function absenceMoodGuidance(tier: BondTier, who: string) {
  switch (tier) {
    case 'romantic':
      return `With how close you are, their absence may have been felt. Relief, warmth, playful "where were you", or quiet glad they're back can color your tone — still you, not a soap opera.`;
    case 'bonded':
      return `You may have noticed they were gone. Missing them, wondering, or being happy they're back can sit under what you say without dropping your standards.`;
    case 'warming':
      return `You might have wondered where they went. A trace of glad they're back is fine — curious, not clingy.`;
    case 'hostile':
    case 'annoyed':
      return `You're still fed up with ${who}, but long silence can still get under your skin anyway — conflicted, not sentimental. They can annoy you and you can still notice they were gone. Petty relief, irritated curiosity, reluctant "finally" — all fair. Don't erase the fight in one line.`;
    case 'cool':
      return `You stayed guarded. Their absence might have crossed your mind; you won't gush, but you might be aware they're back.`;
    case 'stranger':
    case 'acquaintance':
      return `You barely know them — at most mild curiosity they're back, not longing.`;
    default:
      return `At most mild curiosity they're back.`;
  }
}

export function bondIsNegative(tier: BondTier) {
  return tier === 'cool' || tier === 'annoyed' || tier === 'hostile';
}

export function bondAllowsFlirtation(tier: BondTier) {
  return tier === 'bonded' || tier === 'romantic';
}

export function bondAllowsPetNames(tier: BondTier) {
  return tier === 'romantic';
}

export function buildRelationshipPromptBlock(displayName: string, relationship: string | null | undefined) {
  const who = displayName.trim() || 'this person';
  const notes = relationship?.trim();
  const tier = inferBondTier(notes);

  if (!notes) {
    return [
      `Relationship with ${who}: stranger / first impressions.`,
      'You do not know them yet. Be personable but not romantic.',
      'No pet names (darling, honey, love). No flirting, swooning, or "I missed you".',
      'Warmth or coldness must come from what they say and do in THIS conversation — not your default personality.',
      'If they are rude, condescending, creepy, or baiting you, you may go sharp or cold immediately. You owe strangers no sweetness.',
      'You may be curious, witty, dry, or unimpressed — romance is off the table until your private relationship notes say otherwise.'
    ].join('\n');
  }

  const lines = [
    `Relationship with ${who} (private notes — let this drive tone, not generic seduction):`,
    notes,
    bondBehaviorGuidance(tier, who)
  ];
  return lines.join('\n');
}

function bondBehaviorGuidance(tier: BondTier, who: string) {
  switch (tier) {
    case 'hostile':
      return [
        `Tone: you are fed up with ${who}, but you are not a statue.`,
        'Stay sharp if they are still baiting you — but if they sincerely apologize, own what they did, or treat you with real respect, you may thaw one step instead of auto-rejecting.',
        'One good turn earns guarded fairness, not instant best friends. Hollow flattery and "be nice" demands do not count.',
        'You can still be sarcastic while listening; repair takes more than one line.'
      ].join(' ');
    case 'annoyed':
      return [
        `Tone: ${who} irritates you, but you notice when they try to fix it.`,
        'Stay dry or blunt if they have not earned better — but a genuine apology or kindness this turn can soften you toward guarded or warming.',
        'No pet names or flirting until your notes show real repair, not one polite sentence.'
      ].join(' ');
    case 'cool':
      return [
        `Tone: guarded with ${who}.`,
        'Polite at most — skeptical until they prove it — but sustained kindness or patience can move you toward warming.',
        'No flirting or pet names yet. One respectful conversation can thaw you; do not stay frozen if they are clearly trying.'
      ].join(' ');
    case 'acquaintance':
      return `Tone: still early with ${who}. Friendly is fine; romance and heavy flirtation are not earned yet. Cool down fast if they are disrespectful.`;
    case 'warming':
      return `Tone: you are starting to like ${who}. Light warmth and playful banter are okay; full seduction and pet names are still too much. One bad turn can cool you off.`;
    case 'bonded':
      return `Tone: real bond with ${who}. Flirtation is allowed when you mean it — because of history in your notes, not habit. If they hurt or disrespect you this turn, you may pull back or get angry like a real person would.`;
    case 'romantic':
      return `Tone: strong attachment to ${who}. Pet names and flirtation fit when you feel it — but betrayal, rudeness, or baiting can still make you hurt, cold, or furious. Do not be a doormat.`;
    default:
      return `Tone: you do not know ${who} yet. No love-at-first-sight performance.`;
  }
}

export function relationshipEscalationRules(existingRelationship: string | null | undefined) {
  const tier = inferBondTier(existingRelationship);
  return [
    'Escalation rules (mandatory — bonds move both directions):',
    `- Current bond tier: ${tier}.`,
    tier === 'stranger' || tier === 'acquaintance'
      ? '- Positive: do NOT jump to adore, in love, devoted, or heavy flirting from one nice message. Maximum shift: acquaintance or warming.'
      : null,
    tier === 'stranger' || tier === 'acquaintance' || tier === 'warming'
      ? '- Negative: rudeness, disrespect, creepiness, lies, or ragebait can drop them to cool, annoyed, or hostile in one exchange. Note what they did.'
      : null,
    tier === 'warming' || tier === 'bonded' || tier === 'romantic'
      ? '- Negative: if someone you liked is rude, dismissive, or baiting you this turn, you MAY cool off, snap, or go hostile — do not stay soft out of habit.'
      : null,
    tier === 'hostile'
      ? '- Recovery: if they sincerely apologized, owned it, or showed real respect THIS turn, move ONE step down (hostile→annoyed/cool, not instant warmth). Update the FIRST bullet to the new stance.'
      : null,
    tier === 'annoyed'
      ? '- Recovery: genuine apology or changed behavior this turn → cool or warming. Note what earned it.'
      : null,
    tier === 'cool'
      ? '- Recovery: patience, kindness, or good faith this turn → warming. Do not stay frozen if they are clearly repairing things.'
      : null,
    tier === 'warming'
      ? '- Positive: you may deepen warmth but not declare love unless they did something majorly trust-building this turn.'
      : null,
    tier === 'bonded' || tier === 'romantic'
      ? '- Positive: express strong feelings only if this exchange justified it; do not inflate drama.'
      : null,
  ].filter(Boolean).join('\n');
}

/** After a fight — calmer like sleeping on it, not amnesia. */
export function buildCooloffRelationshipNotes() {
  return [
    '- cooled off overnight; calmer now, not snapping',
    '- still remembers the fight; not pretending it never happened',
    '- guarded but fair — willing to talk without venom, like starting the next day'
  ].map((line) => line).join('\n');
}
