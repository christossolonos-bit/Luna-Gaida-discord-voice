import type { MemoryRecord, PrivacyClass } from '../memory/types.js';

const secretPatterns = [
  /GEMINI_API_KEY\s*=\s*\S+/gi,
  /DISCORD_(BOT_TOKEN|PUBLIC_KEY|APPLICATION_ID)\s*=\s*\S+/gi,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi
];

export function classifyText(text: string): PrivacyClass {
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    return 'secret';
  }
  if (/\b(address|phone|email|medical|bank|private|home directory|local file)\b/i.test(text)) {
    return 'private';
  }
  return 'public';
}

export function redactSecrets(text: string): string {
  return secretPatterns.reduce((value, pattern) => value.replace(pattern, '[REDACTED_SECRET]'), text);
}

export function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .trim();
}

export function sanitizeForDiscord(text: string): string {
  return redactSecrets(stripThinkBlocks(text))
    .replace(/\b(?:\/[A-Za-z0-9._ -]+){2,}\b/g, '[LOCAL_PATH]')
    .replace(/\b[A-Z]:\\(?:[^\\\r\n]+\\)+[^\r\n]*/g, '[LOCAL_PATH]');
}

export function memoriesForSurface(records: MemoryRecord[], surface: 'desktop' | 'discord'): MemoryRecord[] {
  if (surface === 'discord') {
    return records.filter((record) => record.privacy === 'public');
  }
  return records.filter((record) => record.privacy !== 'secret');
}

export function assertDiscordSafe(text: string): { ok: true; text: string } | { ok: false; reason: string; text: string } {
  const sanitized = sanitizeForDiscord(text);
  if (classifyText(sanitized) === 'secret') {
    return { ok: false, reason: 'secret_detected', text: '[Blocked by privacy policy]' };
  }
  return { ok: true, text: sanitized };
}
