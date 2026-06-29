/** Fish Audio handles one DM clip best under this length; longer replies are split in two. */
export const MAX_DM_TTS_CHARS = 600;

export function splitDmTtsText(text: string, maxChars = MAX_DM_TTS_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  let splitAt = findSentenceSplitNear(trimmed, Math.floor(trimmed.length / 2));
  let first = trimmed.slice(0, splitAt).trim();
  let second = trimmed.slice(splitAt).trim();

  while (first.length > maxChars && splitAt > 40) {
    splitAt = findSentenceSplitNear(trimmed, Math.floor(splitAt * 0.85));
    first = trimmed.slice(0, splitAt).trim();
    second = trimmed.slice(splitAt).trim();
  }

  if (second.length > maxChars) {
    second = trimToMaxChars(second, maxChars);
  }

  return [first, second].filter(Boolean);
}

function findSentenceSplitNear(text: string, targetIndex: number) {
  const clamped = Math.min(text.length - 1, Math.max(1, targetIndex));
  const windowStart = Math.max(0, clamped - 140);
  const windowEnd = Math.min(text.length, clamped + 140);

  for (let index = windowEnd; index >= windowStart; index -= 1) {
    const ch = text[index];
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = text[index + 1];
      if (!next || /\s/.test(next)) {
        return index + 1;
      }
    }
  }

  const space = text.lastIndexOf(' ', clamped);
  if (space > Math.floor(text.length * 0.25)) {
    return space + 1;
  }

  return clamped;
}

function trimToMaxChars(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return text.trim();
  }
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxChars * 0.5)) {
    return slice.slice(0, lastSpace).trim();
  }
  return slice.trim();
}
