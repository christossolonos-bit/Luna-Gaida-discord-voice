import { GoogleGenAI, HarmBlockThreshold, HarmCategory, type Part } from '@google/genai';
import type { AppConfig } from '../../config/env.js';
import type { MemoryRepository } from '../../memory/repository.js';
import type { PersonalityService } from '../../personality/service.js';
import { assertDiscordSafe, sanitizeForDiscord } from '../../policy/privacy.js';

export interface DiscordContextMessage {
  authorName: string;
  content: string;
  timestamp?: string;
  attachments?: DiscordAttachmentSummary[];
}

export interface DiscordAttachmentSummary {
  name: string;
  contentType: string | null;
  size: number;
  imageIncluded?: boolean;
  skippedReason?: string;
}

export interface DiscordImageAttachment {
  label: string;
  mimeType: string;
  data: string;
}

interface DiscordReplyInput {
  guildId: string;
  channelId: string;
  authorName: string;
  text: string;
  replyTo?: DiscordContextMessage | null;
  recentMessages?: DiscordContextMessage[];
  images?: DiscordImageAttachment[];
}

export class DiscordTextResponder {
  private readonly ai: GoogleGenAI | null;

  constructor(
    private readonly config: AppConfig,
    private readonly memory: MemoryRepository,
    private readonly personality: PersonalityService
  ) {
    this.ai = config.GEMINI_API_KEY
      ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY, httpOptions: { apiVersion: config.GEMINI_API_VERSION } })
      : null;
  }

  async reply(input: DiscordReplyInput) {
    if (!this.ai) {
      return 'GEMINI_API_KEY is not configured on the backend.';
    }

    const memoryContext = this.memory
      .listForContext('discord', 16)
      .map((record) => `- [${record.privacy}/${record.source}] ${record.summary ?? record.content}`)
      .join('\n');

    const systemInstruction = [
      this.personality.buildInstruction(memoryContext, 'discord'),
      'You are replying in Discord text chat. Keep replies concise, natural, and in character.',
      'Use recent channel context and reply-target context to understand what the user means, but answer the current message.',
      'When image attachments are provided, inspect them directly and use their labels to connect each image to the current message or replied-to message.',
      'Do not mention private memory, secret memory, local file paths, environment variables, API keys, or credentials.',
      'Do not ping @everyone, @here, roles, or users unless the user explicitly asked and it is safe.',
      'If the message does not need a long answer, reply in one short paragraph.'
    ].join('\n');

    const parts: Part[] = [{
      text: [
        `Guild: ${input.guildId}`,
        `Channel: ${input.channelId}`,
        input.recentMessages?.length
          ? `Recent channel messages (oldest first):\n${input.recentMessages.map(formatContextMessage).join('\n')}`
          : null,
        input.replyTo
          ? `Message being replied to:\n${formatContextMessage(input.replyTo)}`
          : null,
        `Author: ${input.authorName}`,
        `Message: ${input.text}`
      ].filter(Boolean).join('\n\n')
    }];
    for (const image of input.images ?? []) {
      parts.push({ text: `Image attachment: ${image.label}` });
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }

    const response = await this.ai.models.generateContent({
      model: this.config.DISCORD_GEMINI_MODEL,
      contents: [{
        role: 'user',
        parts
      }],
      config: {
        systemInstruction,
        maxOutputTokens: 700,
        temperature: 0.8,
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.OFF },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.OFF },
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.OFF },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.OFF },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.OFF }
        ]
      }
    });

    const text = extractText(response) || 'I heard you, but I could not form a text reply.';
    const safe = assertDiscordSafe(sanitizeForDiscord(text));
    return safe.ok ? clampDiscordMessage(safe.text) : safe.text;
  }
}

function formatContextMessage(message: DiscordContextMessage) {
  const timestamp = message.timestamp ? `${message.timestamp} ` : '';
  const attachments = message.attachments?.length
    ? ` ${message.attachments.map(formatAttachmentSummary).join(' ')}`
    : '';
  return `- ${timestamp}${message.authorName}: ${message.content}${attachments}`;
}

function formatAttachmentSummary(attachment: DiscordAttachmentSummary) {
  const status = attachment.imageIncluded
    ? 'image included for inspection'
    : attachment.skippedReason
      ? attachment.skippedReason
      : 'metadata only';
  return `[attachment: ${attachment.name}, type: ${attachment.contentType ?? 'unknown'}, size: ${attachment.size} bytes, ${status}]`;
}

function extractText(response: unknown) {
  const candidates = (response as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  }).candidates ?? [];
  return candidates
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

function clampDiscordMessage(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 1900 ? `${normalized.slice(0, 1897)}...` : normalized;
}
