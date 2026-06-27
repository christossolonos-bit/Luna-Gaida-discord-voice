import type { AppConfig } from '../config/env.js';
import {
  runLunaResearch,
  type LunaResearchFinding
} from './lunaResearchRunner.js';
import { buildVoiceConversationStarterQuery } from './interestBrowse.js';

export interface ConversationTopicContext {
  recentExchanges: string[];
  participantNames: string[];
  trigger: 'join' | 'vibe_check';
}

export function buildConversationSearchQuery(context: ConversationTopicContext) {
  const recentText = context.recentExchanges.join(' ').toLowerCase();

  if (context.trigger === 'vibe_check' && recentText.length > 60) {
    const year = new Date().getFullYear();
    return `fresh conversation topics to change the subject ${year} gaming ai vtubers fun`;
  }

  return buildVoiceConversationStarterQuery(context.recentExchanges, context.participantNames);
}

export async function fetchConversationTopic(
  config: AppConfig,
  context: ConversationTopicContext
): Promise<LunaResearchFinding | null> {
  const query = buildConversationSearchQuery(context);
  return runLunaResearch(
    config,
    { mode: 'search', query },
    { purpose: 'conversation' }
  );
}

export function formatConversationTopicBlock(finding: LunaResearchFinding) {
  return [
    'Fresh topic you could bring up in voice (use naturally — do not read URLs aloud):',
    `- ${finding.title}`,
    finding.summary.slice(0, 500)
  ].join('\n');
}
