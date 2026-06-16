import { GoogleGenAI, HarmBlockThreshold, HarmCategory, Modality, Type, type FunctionCall, type LiveConnectConfig, type LiveServerMessage, type Part, type Session } from '@google/genai';
import type { AppConfig } from '../../config/env.js';
import type { MemoryRepository } from '../../memory/repository.js';
import type { PersonalityService } from '../../personality/service.js';
import { assertDiscordSafe, sanitizeForDiscord } from '../../policy/privacy.js';

export interface DiscordContextMessage {
  messageId: string;
  authorName: string;
  authorId?: string;
  content: string;
  timestamp?: string;
  attachments?: DiscordAttachmentSummary[];
  reactions?: DiscordReactionSummary[];
}

export interface DiscordReactionSummary {
  emoji: string;
  count: number;
  reactedByBot?: boolean;
}

export interface DiscordKnownUser {
  userId: string;
  username: string;
  displayName: string;
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
  authorId: string;
  text: string;
  replyTo?: DiscordContextMessage | null;
  recentMessages?: DiscordContextMessage[];
  images?: DiscordImageAttachment[];
  knownUsers?: DiscordKnownUser[];
  mayStaySilent?: boolean;
  reactionTargetMessageIds?: string[];
  addReaction?: (messageId: string, emoji: string) => Promise<Record<string, unknown>>;
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
      'You are replying in Discord text chat. Keep replies concise, coherent, natural, and in character.',
      'Use recent channel context and reply-target context to understand whether the current message is actually asking for, inviting, or needing your response.',
      input.mayStaySilent
        ? 'You are in an always-listen channel, but that does not mean you should answer every message. If the current message is not directed at you and does not benefit from your input, reply with exactly [[GIADA_NO_REPLY]].'
        : 'The current message addressed you directly, so provide a useful reply.',
      'When image attachments are provided, inspect them directly and use their labels to connect each image to the current message or replied-to message.',
      'You can see reaction summaries on recent messages. Use them as conversation context.',
      input.addReaction
        ? 'You have a tool named addDiscordReaction. Use it when adding an emoji reaction is more appropriate than, or useful in addition to, a text reply. Only react to message IDs shown in the current context. If a reaction is enough, use the tool and then reply with exactly [[GIADA_NO_REPLY]].'
        : null,
      'You can ping a Discord user only when the user explicitly asks you to notify, tag, mention, or ping them.',
      'To ping a known user, write their mention exactly as <@USER_ID> using the user ID from Current known Discord users. Do not invent user IDs.',
      'Do not mention private memory, secret memory, local file paths, environment variables, API keys, or credentials.',
      'Never ping @everyone, @here, or roles. If you do not know the intended user ID, ask who to ping instead of guessing.',
      'If the message does not need a long answer, reply in one short paragraph.'
    ].join('\n');

    const parts: Part[] = [{
      text: [
        `Guild: ${input.guildId}`,
        `Channel: ${input.channelId}`,
        input.knownUsers?.length
          ? `Current known Discord users:\n${input.knownUsers.map(formatKnownUser).join('\n')}`
          : null,
        input.recentMessages?.length
          ? `Recent channel messages (oldest first):\n${input.recentMessages.map(formatContextMessage).join('\n')}`
          : null,
        input.replyTo
          ? `Message being replied to:\n${formatContextMessage(input.replyTo)}`
          : null,
        `Author: ${input.authorName}`,
        `Author user ID: ${input.authorId}`,
        `Message: ${input.text}`
      ].filter(Boolean).join('\n\n')
    }];
    for (const image of input.images ?? []) {
      parts.push({ text: `Image attachment: ${image.label}` });
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }

    const text = await this.generateLiveTextReply(systemInstruction, parts, input) || 'I heard you, but I could not form a text reply.';
    if (shouldStaySilent(text)) {
      return null;
    }
    const safe = assertDiscordSafe(sanitizeForDiscord(text));
    return safe.ok ? clampDiscordMessage(safe.text) : safe.text;
  }

  private async generateLiveTextReply(systemInstruction: string, parts: Part[], input: DiscordReplyInput) {
    let session: Session | null = null;
    let settled = false;
    let transcriptText = '';
    let finish: (value: string) => void = () => {};
    let fail: (error: unknown) => void = () => {};

    try {
      const response = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('Discord Live text response timed out'));
          }
        }, 25_000);

        finish = (value: string) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        };

        fail = (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          reject(error);
        };
      });

      const config: LiveConnectConfig = {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        systemInstruction,
        temperature: 0.8,
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.OFF },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.OFF },
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.OFF },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.OFF },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.OFF }
        ]
      };
      if (input.addReaction) {
        config.tools = [{
          functionDeclarations: [{
            name: 'addDiscordReaction',
            description: 'Add one emoji reaction to a Discord message from the current context.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                messageId: {
                  type: Type.STRING,
                  description: 'The target Discord message ID. Must be one of the message IDs shown in the current context.'
                },
                emoji: {
                  type: Type.STRING,
                  description: 'A Unicode emoji or custom emoji mention to react with, for example 👍 or <:name:id>.'
                }
              },
              required: ['messageId', 'emoji']
            }
          }]
        }];
      }

      session = await this.ai!.live.connect({
        model: this.config.GEMINI_MODEL,
        config,
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (message.toolCall?.functionCalls?.length && session) {
              void this.handleToolCalls(message.toolCall.functionCalls, session, input);
            }
            const text = extractLiveText(message);
            if (text) {
              transcriptText = appendTranscriptText(transcriptText, text);
            }
            if (message.serverContent?.turnComplete) {
              finish(transcriptText.trim());
            }
          },
          onerror: (error) => fail(error),
          onclose: (event) => {
            if (!settled) {
              fail(new Error(`Discord Live text session closed before completion: ${event.reason}`));
            }
          }
        }
      });

      session.sendClientContent({
        turns: [{ role: 'user', parts }],
        turnComplete: true
      });

      return await response;
    } finally {
      session?.close();
    }
  }

  private async handleToolCalls(functionCalls: FunctionCall[], session: Session, input: DiscordReplyInput) {
    const functionResponses: Record<string, unknown>[] = [];
    for (const call of functionCalls) {
      const id = call.id ?? `${call.name ?? 'tool'}-${functionResponses.length}`;
      const name = call.name ?? 'unknown';
      if (name !== 'addDiscordReaction' || !input.addReaction) {
        functionResponses.push({ id, name, response: { ok: false, error: 'unknown_tool' } });
        continue;
      }

      const args = parseReactionArgs(call.args);
      if (!args) {
        functionResponses.push({ id, name, response: { ok: false, error: 'invalid_arguments' } });
        continue;
      }

      if (!input.reactionTargetMessageIds?.includes(args.messageId)) {
        functionResponses.push({ id, name, response: { ok: false, error: 'message_not_in_context' } });
        continue;
      }

      try {
        const response = await input.addReaction(args.messageId, args.emoji);
        functionResponses.push({ id, name, response });
      } catch (error) {
        functionResponses.push({
          id,
          name,
          response: { ok: false, error: error instanceof Error ? error.message : String(error) }
        });
      }
    }
    session.sendToolResponse({ functionResponses: functionResponses as never });
  }
}

function formatContextMessage(message: DiscordContextMessage) {
  const timestamp = message.timestamp ? `${message.timestamp} ` : '';
  const messageId = ` [messageId: ${message.messageId}]`;
  const authorId = message.authorId ? ` (${message.authorId})` : '';
  const attachments = message.attachments?.length
    ? ` ${message.attachments.map(formatAttachmentSummary).join(' ')}`
    : '';
  const reactions = message.reactions?.length
    ? ` Reactions: ${message.reactions.map(formatReactionSummary).join(', ')}.`
    : '';
  return `- ${timestamp}${message.authorName}${authorId}${messageId}: ${message.content}${attachments}${reactions}`;
}

function formatKnownUser(user: DiscordKnownUser) {
  const username = user.username === user.displayName ? user.username : `${user.displayName} / ${user.username}`;
  return `- ${username}: <@${user.userId}>`;
}

function formatAttachmentSummary(attachment: DiscordAttachmentSummary) {
  const status = attachment.imageIncluded
    ? 'image included for inspection'
    : attachment.skippedReason
      ? attachment.skippedReason
      : 'metadata only';
  return `[attachment: ${attachment.name}, type: ${attachment.contentType ?? 'unknown'}, size: ${attachment.size} bytes, ${status}]`;
}

function formatReactionSummary(reaction: DiscordReactionSummary) {
  return `${reaction.emoji} x${reaction.count}${reaction.reactedByBot ? ' (Giada reacted)' : ''}`;
}

function parseReactionArgs(args: unknown) {
  const candidate = args as { messageId?: unknown; emoji?: unknown };
  if (typeof candidate.messageId !== 'string' || typeof candidate.emoji !== 'string') {
    return null;
  }
  const messageId = candidate.messageId.trim();
  const emoji = candidate.emoji.trim();
  if (!/^\d{5,25}$/.test(messageId) || !emoji || emoji.length > 120) {
    return null;
  }
  return { messageId, emoji };
}

function extractLiveText(message: LiveServerMessage) {
  const transcript = message.serverContent?.outputTranscription?.text;
  if (transcript) {
    return transcript;
  }
  return (message.serverContent?.modelTurn?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function appendTranscriptText(previous: string, incoming: string) {
  const normalizedIncoming = incoming.replace(/\s+/g, ' ');
  if (!normalizedIncoming.trim()) {
    return previous;
  }
  if (!previous) {
    return normalizedIncoming;
  }
  if (normalizedIncoming.startsWith(previous)) {
    return normalizedIncoming;
  }

  const trimmedIncoming = normalizedIncoming.trim();
  if (previous.endsWith(trimmedIncoming)) {
    return previous;
  }
  if (previous.endsWith(' ') || normalizedIncoming.startsWith(' ')) {
    return `${previous}${normalizedIncoming}`;
  }

  const previousLast = previous.at(-1) ?? '';
  const incomingFirst = trimmedIncoming.at(0) ?? '';
  const noSpaceBeforeIncoming = /^[,.;:!?)]$/.test(incomingFirst);
  const noSpaceAfterPrevious = previousLast === '(' || (/[\p{L}\p{N}]$/u.test(previousLast) && incomingFirst === "'");
  const wordBoundary = /[\p{L}\p{N}"']$/u.test(previousLast) && /^[\p{L}\p{N}"(]$/u.test(incomingFirst);
  const sentenceBoundary = /[.!?]$/.test(previousLast) && /^[\p{L}\p{N}"'(]$/u.test(incomingFirst);
  const needsSpace = !noSpaceBeforeIncoming && !noSpaceAfterPrevious && (wordBoundary || sentenceBoundary);

  return `${previous}${needsSpace ? ' ' : ''}${trimmedIncoming}`;
}

function clampDiscordMessage(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 1900 ? `${normalized.slice(0, 1897)}...` : normalized;
}

function shouldStaySilent(text: string) {
  return text.replace(/\s+/g, ' ').trim() === '[[GIADA_NO_REPLY]]';
}
