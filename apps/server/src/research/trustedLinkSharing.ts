import type { AppConfig } from '../config/env.js';
import type { LunaResearchStore } from '../memory/lunaResearchStore.js';
import { formatResearchFindingBlock, runLunaResearch } from './lunaResearchRunner.js';
import { logger } from '../logging/logger.js';

export interface LinkSenderIdentity {
  userId: string;
  username?: string | null;
  displayName?: string | null;
}

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export function extractUrls(text: string, limit = 2) {
  const matches = text.match(URL_RE) ?? [];
  const cleaned = matches.map((url) => url.replace(/[.,;!?]+$/g, '').trim());
  return [...new Set(cleaned)].slice(0, limit);
}

export function isTrustedLinkSender(config: AppConfig, sender: LinkSenderIdentity) {
  if (config.GIADA_OWNER_DISCORD_USER_ID && sender.userId === config.GIADA_OWNER_DISCORD_USER_ID) {
    return true;
  }

  const trusted = config.lunaLinkTrustedSenders ?? [];
  const identities = [sender.username, sender.displayName]
    .filter(Boolean)
    .map((value) => value!.toLowerCase());

  return trusted.some((name) => {
    const needle = name.toLowerCase();
    return identities.some((identity) => identity === needle || identity.includes(needle));
  });
}

export async function readTrustedUserLinks(
  config: AppConfig,
  userText: string,
  researchStore: LunaResearchStore | null | undefined,
  sender: LinkSenderIdentity,
  senderLabel?: string
): Promise<string | null> {
  if (!config.lunaResearchEnabled || !isTrustedLinkSender(config, sender)) {
    return null;
  }

  const urls = extractUrls(userText);
  if (!urls.length) {
    return null;
  }

  const who = senderLabel ?? sender.displayName ?? sender.username ?? 'them';
  const blocks: string[] = [];

  for (const url of urls) {
    try {
      const finding = await runLunaResearch(config, { mode: 'read', url });
      if (!finding) continue;

      researchStore?.record({
        source: 'trusted_link',
        mode: 'read',
        query: null,
        url: finding.url,
        title: finding.title,
        summary: finding.summary
      });

      blocks.push([
        `${who} shared a link with you (read it and give your real reaction — what stood out, your take, or a question it raised):`,
        formatResearchFindingBlock(finding)
      ].join('\n'));
    } catch (error) {
      logger.warn('Trusted link read failed', {
        url,
        userId: sender.userId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return blocks.length ? blocks.join('\n\n') : null;
}

const VOICE_TEXT_CHAT_PREFIX = 'Discord voice channel text chat messages sent while you were connected to voice:';

export async function readTrustedLinksFromVoiceTextChat(
  config: AppConfig,
  userText: string,
  researchStore: LunaResearchStore | null | undefined
) {
  if (!userText.includes(VOICE_TEXT_CHAT_PREFIX)) {
    return null;
  }

  const blocks: string[] = [];
  for (const line of userText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const match = trimmed.match(/^- ([^:]+):\s*(.+)$/);
    if (!match?.[1] || !match[2]) continue;

    const authorName = match[1].trim();
    const body = match[2].trim();
    if (!extractUrls(body).length) continue;

    const sender: LinkSenderIdentity = {
      userId: '',
      displayName: authorName,
      username: authorName
    };
    const block = await readTrustedUserLinks(config, body, researchStore, sender, authorName);
    if (block) blocks.push(block);
  }

  return blocks.length ? blocks.join('\n\n') : null;
}
