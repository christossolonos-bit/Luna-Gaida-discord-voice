export function isLikelyEchoTranscript(text: string, recentAssistantText = '') {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (/^(wig|wake)\s+phrase/.test(normalized)) return true;
  if (/luna is speaking|listening for \d+s?$/.test(normalized)) return true;
  if (/krisp noise suppression|my name is krisp/.test(normalized)) return true;
  if (recentAssistantText) {
    const recent = recentAssistantText.toLowerCase().replace(/\s+/g, ' ').trim();
    if (recent.includes(normalized) || normalized.includes(recent.slice(0, Math.min(40, recent.length)))) return true;
    const words = normalized.split(' ').filter((word) => word.length > 2);
    const recentWords = new Set(recent.split(' '));
    const overlap = words.filter((word) => recentWords.has(word)).length;
    if (words.length >= 3 && overlap / words.length >= 0.75) return true;
  }
  return false;
}

export function parseWakePhrases(value: string) {
  return value.split(',').map((phrase) => phrase.trim()).filter(Boolean);
}

function normalizeSpeech(text: string) {
  return text.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
}

const FUZZY_WAKE_PREFIX = /\b(hey|hi|hello|hay|you|a)\s+luna\b/;

export function containsWakePhrase(text: string, phrases: string[]) {
  const normalized = normalizeSpeech(text);
  if (phrases.some((phrase) => normalized.includes(normalizeSpeech(phrase)))) {
    return true;
  }
  if (FUZZY_WAKE_PREFIX.test(normalized)) return true;
  if (/^luna\b/.test(normalized)) return true;
  return false;
}

export function stripWakePhrases(text: string, phrases: string[]) {
  let result = text.trim();
  for (const phrase of phrases) {
    const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    result = result.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '').trim();
  }
  result = result.replace(/^\s*(hey|hi|hello|hay|you|a)\s+luna\b[,.]?\s*/i, '').trim();
  result = result.replace(/^\s*luna\b[,.]?\s*/i, '').trim();
  return result.replace(/^[,.\s]+/, '').trim();
}

export function evaluateWakePhrase(input: {
  text: string;
  phrases: string[];
  required: boolean;
}) {
  const trimmed = input.text.trim();
  if (!trimmed) return { accepted: false as const, text: '' };
  if (!input.required) return { accepted: true as const, text: trimmed };

  if (!containsWakePhrase(trimmed, input.phrases)) {
    return { accepted: false as const, text: trimmed };
  }

  const stripped = stripWakePhrases(trimmed, input.phrases);
  return {
    accepted: true as const,
    text: stripped || 'Hello!',
    wakeOnly: !stripped
  };
}
