import type { Client } from 'discord.js';
import type { AppConfig } from '../config/env.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import { LunaDmStore } from '../memory/lunaDmStore.js';
import type { UserVoiceMemoryStore } from '../memory/userVoiceMemory.js';
import type { LunaLifeStore } from '../memory/lunaLifeStore.js';
import { OllamaTextClient } from '../providers/ollamaText.js';
import { publishActivity } from '../monitor/activityFeed.js';
import { logger } from '../logging/logger.js';
import { assertDiscordSafe } from '../policy/privacy.js';
import { stripRoleplayMarkupForSpeech } from './voiceActions.js';
import {
  buildLunaDmPrompt,
  LUNA_DM_JSON_SCHEMA,
  parseLunaDmReply,
  type LunaDmCandidate
} from './lunaDmInitiative.js';

export class LunaDmInitiativeService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private closed = false;
  private readonly ollama: OllamaTextClient;
  private readonly dmStore: LunaDmStore;

  constructor(
    private readonly config: AppConfig,
    private readonly personality: PersonalityInstructionProvider,
    private readonly userVoiceMemory: UserVoiceMemoryStore,
    private readonly lunaLife: LunaLifeStore,
    private readonly getClient: () => Client | null,
    private readonly getUsersInActiveVoice: () => Set<string>
  ) {
    this.ollama = new OllamaTextClient(config);
    this.dmStore = new LunaDmStore(config.databasePath);
  }

  start() {
    if (!this.config.lunaAutonomousDm || this.closed) return;
    this.schedule();
  }

  stop() {
    this.closed = true;
    this.generation += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule() {
    if (this.closed || !this.config.lunaAutonomousDm) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const minMs = this.config.lunaDmMinSec * 1000;
    const maxMs = this.config.lunaDmMaxSec * 1000;
    const delay = minMs + Math.random() * Math.max(0, maxMs - minMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.offerDm();
    }, delay);
    this.timer.unref?.();
  }

  private async offerDm() {
    const generation = this.generation;
    try {
      if (!this.canRun()) {
        return;
      }

      const client = this.getClient();
      if (!client?.isReady()) {
        return;
      }

      const candidates = await this.collectCandidates(client);
      if (!candidates.length) {
        logger.debug('Luna DM initiative: no eligible candidates');
        return;
      }

      const guildIds = [...new Set(candidates.map((person) => person.guildId))];
      const lifeByGuild = this.config.LUNA_LIFE_MEMORY
        ? guildIds.map((guildId) => ({
          guildId,
          narrative: this.lunaLife.getNarrative(guildId)
        }))
        : [];

      const recentDmLines = this.dmStore.recent(8).map((entry) => {
        const name = entry.displayName ?? entry.userId;
        return `- To ${name}: ${entry.message.slice(0, 120)}`;
      });

      const { system, userPrompt } = buildLunaDmPrompt({
        personalityInstruction: this.personality.buildInstruction('discord', { nsfwAllowed: true }),
        candidates,
        lifeByGuild,
        recentDmLines
      });

      const raw = await this.ollama.generateJson({
        system,
        userText: userPrompt,
        format: LUNA_DM_JSON_SCHEMA,
        maxCompletionTokens: 220,
        temperature: 0.7
      });

      if (generation !== this.generation || !this.canRun()) {
        return;
      }

      const decision = parseLunaDmReply(raw);
      if (!decision?.send || !decision.userId || !decision.message) {
        publishActivity({
          level: 'info',
          title: 'Luna skipped DM',
          detail: decision?.reason ?? 'Nothing genuine to say'
        });
        return;
      }

      const target = candidates.find((person) => person.userId === decision.userId);
      if (!target) {
        logger.warn('Luna DM initiative picked unknown userId', { userId: decision.userId });
        return;
      }

      const cleaned = stripRoleplayMarkupForSpeech(decision.message).slice(0, 400).trim();
      const safe = assertDiscordSafe(cleaned);
      if (!safe.ok || !safe.text.trim()) {
        logger.warn('Luna DM blocked by safety policy', { reason: safe.ok ? 'empty' : safe.reason });
        return;
      }

      await this.sendDm(client, target, safe.text, decision.reason);
    } catch (error) {
      logger.warn('Luna DM initiative failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (generation === this.generation && !this.closed) {
        this.schedule();
      }
    }
  }

  private canRun() {
    if (this.closed || !this.config.lunaAutonomousDm) {
      return false;
    }
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    if (this.dmStore.countSince(dayStart.toISOString()) >= this.config.lunaDmMaxPerDay) {
      return false;
    }
    return true;
  }

  private async collectCandidates(client: Client): Promise<LunaDmCandidate[]> {
    const inVoice = this.getUsersInActiveVoice();
    const botId = client.user?.id;
    const cooldownMs = this.config.lunaDmCooldownHours * 60 * 60 * 1000;
    const now = Date.now();
    const candidates: LunaDmCandidate[] = [];

    for (const record of this.userVoiceMemory.listAll(80)) {
      if (!record.summary.trim() && !record.relationship.trim()) {
        continue;
      }
      if (botId && record.userId === botId) {
        continue;
      }
      if (!client.guilds.cache.has(record.guildId)) {
        continue;
      }

      const lastDm = this.dmStore.lastDmAt(record.userId);
      if (lastDm) {
        const elapsed = now - new Date(lastDm).getTime();
        if (elapsed < cooldownMs) {
          continue;
        }
      }

      const guild = client.guilds.cache.get(record.guildId);
      if (!guild) continue;
      const member = await guild.members.fetch(record.userId).catch(() => null);
      if (!member || member.user.bot) {
        continue;
      }

      candidates.push({
        userId: record.userId,
        displayName: record.displayName ?? member.displayName ?? record.userId,
        guildId: record.guildId,
        summary: record.summary,
        relationship: record.relationship,
        hoursSinceLastDm: lastDm ? (now - new Date(lastDm).getTime()) / 3_600_000 : null,
        inVoiceWithLuna: inVoice.has(record.userId)
      });
    }

    const byUser = new Map<string, LunaDmCandidate>();
    for (const person of candidates) {
      const existing = byUser.get(person.userId);
      if (!existing || person.summary.length + person.relationship.length > existing.summary.length + existing.relationship.length) {
        byUser.set(person.userId, person);
      }
    }

    return [...byUser.values()].slice(0, 12);
  }

  private async sendDm(
    client: Client,
    target: LunaDmCandidate,
    message: string,
    reason: string | null
  ) {
    const user = await client.users.fetch(target.userId).catch(() => null);
    if (!user) {
      logger.warn('Luna DM: could not fetch user', { userId: target.userId });
      return;
    }

    const dm = await user.createDM().catch(() => null);
    if (!dm) {
      logger.warn('Luna DM: could not open DM channel', { userId: target.userId });
      return;
    }

    try {
      await dm.send(message);
    } catch (error) {
      const code = (error as { code?: number })?.code;
      logger.warn('Luna DM send failed', {
        userId: target.userId,
        code,
        error: error instanceof Error ? error.message : String(error)
      });
      publishActivity({
        level: 'warn',
        title: `Could not DM ${target.displayName}`,
        detail: code === 50007 ? 'Their privacy settings block DMs from server members' : 'Send failed'
      });
      return;
    }

    this.dmStore.record({
      guildId: target.guildId,
      userId: target.userId,
      displayName: target.displayName,
      message,
      reason
    });

    publishActivity({
      level: 'assistant',
      title: `Luna DM → ${target.displayName}`,
      detail: message,
      meta: { userId: target.userId, guildId: target.guildId, initiative: true, reason: reason ?? undefined }
    });
    logger.info('Luna sent autonomous DM', {
      userId: target.userId,
      displayName: target.displayName,
      guildId: target.guildId
    });
  }
}
