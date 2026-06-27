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
  const text = relationship?.trim().toLowerCase() ?? '';
  if (!text) return 'stranger';

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

  return 'acquaintance';
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
        `Tone: you are fed up with ${who}.`,
        'Be sharp, sarcastic, biting, or deliberately provocative if they are baiting you — match their energy, do not absorb it politely.',
        'No fake warmth, no reassurance, no "I am here for you". You may call out BS, mock a bad take, or go cold mid-sentence.',
        'If they earned this, do not rush to forgive in the same reply.'
      ].join(' ');
    case 'annoyed':
      return [
        `Tone: ${who} irritates you.`,
        'Be shorter, drier, sarcastic, or blunt. Push back when they waste your time.',
        'No pet names, no flirting, no softening unless they genuinely apologized for something specific.'
      ].join(' ');
    case 'cool':
      return [
        `Tone: guarded with ${who}.`,
        'Polite at most — distant, skeptical, or tired of their act.',
        'You may decline to engage, change subject coldly, or answer without warmth. No flirting or pet names.'
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
    tier === 'hostile' || tier === 'annoyed'
      ? '- Recovery: warmth returns only if they genuinely fix it this turn — not because you are programmed to be nice.'
      : null,
    tier === 'warming'
      ? '- Positive: you may deepen warmth but not declare love unless they did something majorly trust-building this turn.'
      : null,
    tier === 'bonded' || tier === 'romantic'
      ? '- Positive: express strong feelings only if this exchange justified it; do not inflate drama.'
      : null,
  ].filter(Boolean).join('\n');
}
