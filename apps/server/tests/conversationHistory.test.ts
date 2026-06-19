import { describe, expect, it } from 'vitest';
import { appendTurnText, ConversationHistory } from '../src/live/conversationHistory.js';

describe('conversation history', () => {
  it('keeps only the latest configured number of user and model turns', () => {
    const history = new ConversationHistory(4);
    history.add('user', 'one');
    history.add('model', 'two');
    history.add('user', 'three');
    history.add('model', 'four');
    history.add('user', 'five');

    expect(history.snapshot()).toEqual([
      { role: 'model', text: 'two' },
      { role: 'user', text: 'three' },
      { role: 'model', text: 'four' },
      { role: 'user', text: 'five' }
    ]);
  });

  it('formats both user and assistant turns as replay context', () => {
    const history = new ConversationHistory();
    history.add('user', 'Hello');
    history.add('model', 'Hi');

    expect(history.toPromptText()).toBe('User: Hello\nAssistant: Hi');
  });

  it('combines incremental and cumulative assistant transcripts', () => {
    expect(appendTurnText('Hello', ' there')).toBe('Hello there');
    expect(appendTurnText('Hello', 'Hello there')).toBe('Hello there');
    expect(appendTurnText('Hello there', 'there')).toBe('Hello there');
  });
});
