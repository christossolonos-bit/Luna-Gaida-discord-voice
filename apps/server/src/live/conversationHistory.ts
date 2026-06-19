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
  const next = incoming.trim();
  if (!next) {
    return previous;
  }
  if (!previous || next.startsWith(previous)) {
    return next;
  }
  if (previous.endsWith(next)) {
    return previous;
  }

  const needsSpace =
    !previous.endsWith(' ') &&
    (/^\s/.test(incoming) || (
      /[\p{L}\p{N}"']$/u.test(previous) &&
      /^[\p{L}\p{N}"']/u.test(next)
    ));
  return `${previous}${needsSpace ? ' ' : ''}${next}`;
}
