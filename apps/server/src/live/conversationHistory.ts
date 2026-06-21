export type ConversationRole = 'user' | 'model';

export interface ConversationTurn {
  role: ConversationRole;
  text: string;
}

export class ConversationHistory {
  private turns: ConversationTurn[] = [];

  constructor(private readonly limit = 20) {}

  add(role: ConversationRole, text: string) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return;
    }
    this.turns.push({ role, text: normalized });
    this.turns = this.turns.slice(-this.limit);
  }

  toPromptText(): string {
    return this.turns
      .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
      .join('\n');
  }

  toPromptParts(): Array<{ text: string }> {
    return this.turns.map((turn) => ({
      text: `Previous ${turn.role === 'user' ? 'user' : 'assistant'} message: ${turn.text}`
    }));
  }

  snapshot(): ConversationTurn[] {
    return this.turns.map((turn) => ({ ...turn }));
  }
}

export function appendTurnText(previous: string, incoming: string) {
  const current = previous.replace(/\s+/g, ' ').trim();
  const next = incoming.replace(/\s+/g, ' ').trim();
  if (!next) {
    return current;
  }
  if (!current || next.startsWith(current)) {
    return next;
  }
  if (current.endsWith(next)) {
    return current;
  }

  const overlap = longestTextOverlap(current, next);
  if (overlap > 0) return `${current}${next.slice(overlap)}`;

  const needsSpace =
    !current.endsWith(' ') &&
    !/^[,.;:!?)]/.test(next) &&
    (/^\s/.test(incoming) || (
      /[\p{L}\p{N}"']$/u.test(current) &&
      /^[\p{L}\p{N}"']/u.test(next)
    ));
  return `${current}${needsSpace ? ' ' : ''}${next}`;
}

function longestTextOverlap(previous: string, incoming: string) {
  const maximum = Math.min(previous.length, incoming.length);
  for (let length = maximum; length >= 3; length -= 1) {
    if (previous.slice(-length) !== incoming.slice(0, length)) continue;
    const startsAtBoundary = length === previous.length || /[^\p{L}\p{N}]/u.test(previous.at(-length - 1) ?? ' ');
    const endsAtBoundary = length === incoming.length || /[^\p{L}\p{N}]/u.test(incoming.at(length) ?? ' ');
    if (startsAtBoundary || endsAtBoundary) return length;
  }
  return 0;
}
