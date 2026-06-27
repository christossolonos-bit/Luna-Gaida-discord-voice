import type { AppConfig } from '../config/env.js';
import type { PersonalityInstructionProvider } from '../personality/service.js';
import type { UserVoiceMemoryStore } from '../memory/userVoiceMemory.js';
import { LunaDmStore } from '../memory/lunaDmStore.js';
import { LunaResearchStore } from '../memory/lunaResearchStore.js';
import { OllamaTextClient } from '../providers/ollamaText.js';
import { publishActivity } from '../monitor/activityFeed.js';
import { logger } from '../logging/logger.js';
import {
  formatConversationContextForCuriosity,
  getRecentlyCoveredKeywords,
  queryIsOffConversationTopic,
  queryOverlapsRecentResearch
} from '../research/conversationResearch.js';
import { formatInterestBrowseHint, planInterestBrowse } from '../research/interestBrowse.js';
import { runLunaResearch } from '../research/lunaResearchRunner.js';
import {
  buildLunaCuriosityPrompt,
  LUNA_CURIOSITY_JSON_SCHEMA,
  parseLunaCuriosityReply
} from './lunaCuriosity.js';

export class LunaCuriosityService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private closed = false;
  private readonly ollama: OllamaTextClient;
  private readonly researchStore: LunaResearchStore;
  private readonly dmStore: LunaDmStore;

  constructor(
    private readonly config: AppConfig,
    private readonly personality: PersonalityInstructionProvider,
    private readonly userVoiceMemory?: UserVoiceMemoryStore
  ) {
    this.ollama = new OllamaTextClient(config);
    this.researchStore = new LunaResearchStore(config.databasePath);
    this.dmStore = new LunaDmStore(config.databasePath);
  }

  getResearchStore() {
    return this.researchStore;
  }

  start() {
    if (!this.config.lunaResearchEnabled || this.closed) return;
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
    if (this.closed || !this.config.lunaResearchEnabled) return;
    if (this.timer) clearTimeout(this.timer);
    const minMs = this.config.lunaCuriosityMinSec * 1000;
    const maxMs = this.config.lunaCuriosityMaxSec * 1000;
    const delay = minMs + Math.random() * Math.max(0, maxMs - minMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.offerCuriosity();
    }, delay);
    this.timer.unref?.();
  }

  private canRun() {
    if (this.closed || !this.config.lunaResearchEnabled) return false;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    return this.researchStore.countSince(dayStart.toISOString()) < this.config.lunaResearchMaxPerDay;
  }

  private gatherConversationContext() {
    const dmLines = this.dmStore.recentDialogue(14);
    const voiceSnippets = (this.userVoiceMemory?.listAll(8) ?? [])
      .filter((record) => record.summary.trim())
      .map((record) => `${record.displayName ?? 'Someone'}: ${record.summary.replace(/\n/g, '; ')}`);
    return { dmLines, voiceSnippets };
  }

  private async offerCuriosity() {
    const generation = this.generation;
    try {
      if (!this.canRun()) return;

      const { dmLines, voiceSnippets } = this.gatherConversationContext();
      const recentConversationLines = formatConversationContextForCuriosity(dmLines, voiceSnippets);
      const recentResearchLines = this.researchStore.recent(6).map((record) => `- ${record.title}`);
      const browsePlan = planInterestBrowse(dmLines, voiceSnippets, this.researchStore);
      const plannedBrowse = formatInterestBrowseHint(browsePlan);

      const { system, userPrompt } = buildLunaCuriosityPrompt({
        personalityInstruction: this.personality.buildInstruction('discord', { nsfwAllowed: true }),
        recentResearchLines,
        recentConversationLines,
        plannedBrowse,
        rssFeedCount: this.config.lunaRssFeeds.length
      });

      const raw = await this.ollama.generateJson({
        system,
        userText: userPrompt,
        format: LUNA_CURIOSITY_JSON_SCHEMA,
        maxCompletionTokens: 180,
        temperature: 0.78
      });

      if (generation !== this.generation || !this.canRun()) return;

      const decision = parseLunaCuriosityReply(raw);
      if (!decision?.explore) {
        publishActivity({
          level: 'info',
          title: 'Luna skipped browsing',
          detail: decision?.reason ?? 'Not curious right now'
        });
        return;
      }

      let mode = browsePlan.mode;
      let query = browsePlan.query;
      let preferDigest = browsePlan.category === 'world';

      if (decision.url?.trim()) {
        mode = 'read';
        query = decision.url.trim();
        preferDigest = false;
      } else if (decision.query?.trim()
        && !queryOverlapsRecentResearch(decision.query, this.researchStore)
        && !queryIsOffConversationTopic(decision.query, dmLines, voiceSnippets)) {
        mode = decision.mode ?? browsePlan.mode;
        query = decision.query.trim();
        preferDigest = false;
      }

      const excludeKeywords = getRecentlyCoveredKeywords(this.researchStore);

      const finding = await runLunaResearch(this.config, {
        mode,
        ...(query ? { query } : {}),
        ...(mode === 'read' && decision.url ? { url: decision.url } : {})
      }, {
        purpose: 'conversation',
        excludeKeywords,
        excludeUrls: this.researchStore.recent(8).map((record) => record.url).filter(Boolean) as string[],
        preferDigest
      });

      if (!finding) {
        logger.debug('Luna curiosity found nothing', { mode: decision.mode, query: decision.query });
        return;
      }

      this.researchStore.record({
        source: 'curiosity',
        mode: finding.mode,
        query: finding.query,
        url: finding.url,
        title: finding.title,
        summary: finding.summary
      });

      publishActivity({
        level: 'assistant',
        title: `Luna read: ${finding.title}`,
        detail: finding.summary.slice(0, 280),
        meta: { mode: finding.mode, url: finding.url ?? undefined, query: finding.query ?? undefined }
      });
      logger.info('Luna autonomous research', {
        mode: finding.mode,
        title: finding.title,
        query: finding.query,
        category: browsePlan.category
      });
    } catch (error) {
      logger.warn('Luna curiosity failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (generation === this.generation && !this.closed) {
        this.schedule();
      }
    }
  }
}
