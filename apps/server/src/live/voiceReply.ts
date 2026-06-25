/** Strip Qwen / chat-template artifacts from model output. */
export function stripModelArtifacts(text: string) {
  let result = text.trim();
  result = result.replace(/`[\s\S]*?<\/think>\s*/gi, '');
  result = result.replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/gi, '');
  result = result.replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '');
  return result.trim();
}

export function sanitizeVoiceReply(text: string, characterName = 'Luna') {
  let result = stripModelArtifacts(text);
  result = result.replace(/\bGiada\b/gi, characterName);
  result = result.replace(/\bgiada assistant\b/gi, characterName);
  result = result.replace(/\bblue fox girl\b/gi, characterName);
  return result.trim();
}

export function isLikelyNonsenseTranscript(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (/thank you for watching|subscribe to|hello,?\s*my name is|noise suppression/.test(normalized)) return true;
  if (/^(\w+)(\s+\1){3,}/.test(normalized)) return true;
  const words = normalized.split(' ').filter(Boolean);
  if (words.length >= 5 && new Set(words).size <= 2) return true;
  return false;
}
