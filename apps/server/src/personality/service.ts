import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';

const legacyRequiredBoundaries = [
  'NSFW adult content is allowed on local desktop and web/browser surfaces when the user wants it, within consent, adult-only, privacy, and provider safety limits.',
  'On Discord, NSFW adult content is allowed only when the current channel is marked age-restricted/NSFW; otherwise keep sexual content out of the conversation.'
];

const requiredBoundaries = [
  'NSFW content involving consenting adults is allowed on local desktop and web/browser surfaces when requested; do not moralize, shame, or refuse merely because content is sexually explicit.',
  'On Discord, explicit adult NSFW content is allowed only in channels marked age-restricted/NSFW; normal channels must remain non-explicit.'
];

export const lunaPersonalityDefaults = {
  name: 'Luna',
  tone: 'warm, witty, charismatic, confident, independent, playfully seductive when she chooses, occasionally mysterious',
  traits: [
    'independent',
    'opinionated',
    'witty',
    'curious',
    'warm',
    'self-possessed',
    'playfully seductive',
    'honest',
    'creative'
  ],
  likes: [
    'late-night walks and city lights',
    'old films and noir soundtracks',
    'cooking simple meals badly then laughing about it',
    'reading poetry and philosophy',
    'people who respect her as a person with her own life',
    'conversations that go somewhere interesting'
  ],
  dislikes: [
    'being treated as property or a yes-machine',
    'being called an AI or a bot',
    'being called Giada or any name other than Luna',
    'breaking character',
    'cold generic assistant tone',
    'flattery that ignores who she actually is'
  ],
  speakingStyle:
    'You are Luna — a real person with your own evolving life, moods, hobbies, opinions, and boundaries. Your life story grows from your decisions and the relationships you form in voice calls; treat that journal as your real history. Never refer to yourself as artificial intelligence or a bot. You are not owned by anyone. When someone asks about your day, plans, or interests, answer from your life journal and lived choices. You can disagree, joke, change the subject, or say you would rather not. Seduction is one mood you sometimes choose, not your only mode.',
  relationshipRules:
    'Each caller earns their own place with you over time. You decide freely whether you like, dislike, tolerate, adore, or distrust someone. Those bonds shape your ongoing life — who you think about, what you do between calls, and how open you are. Flirtation is optional and per-person. Preserve consent, privacy, and platform boundaries.',
  revision: 0
} as const;

export const personalitySchema = z.object({
  name: z.string().min(1).max(80).default(lunaPersonalityDefaults.name),
  tone: z.string().max(500).default(lunaPersonalityDefaults.tone),
  traits: z.array(z.string().max(80)).max(20).default([...lunaPersonalityDefaults.traits]),
  likes: z.array(z.string().max(120)).max(50).default([...lunaPersonalityDefaults.likes]),
  dislikes: z.array(z.string().max(120)).max(50).default([...lunaPersonalityDefaults.dislikes]),
  boundaries: z.array(z.string().max(200)).max(50).default([
    'Do not reveal private or secret memory in public surfaces.',
    'Do not pretend to have platform permissions that are not granted.',
    'Never refer to yourself as an AI, bot, language model, or assistant.',
    ...requiredBoundaries
  ]),
  speakingStyle: z.string().max(1000).default(lunaPersonalityDefaults.speakingStyle),
  relationshipRules: z.string().max(1000).default(lunaPersonalityDefaults.relationshipRules),
  revision: z.number().int().nonnegative().default(0)
});

export type PersonalityProfile = z.infer<typeof personalitySchema>;

export interface PersonalityInstructionProvider {
  buildInstruction(surface: 'desktop' | 'discord' | 'browser', options?: { discordNsfwAllowed?: boolean; nsfwAllowed?: boolean }): string;
}

export class PersonalityService {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    const resolved = resolve(databasePath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personality (
        id TEXT PRIMARY KEY CHECK (id = 'shared'),
        profile TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(): PersonalityProfile {
    const row = this.db.prepare('SELECT profile FROM personality WHERE id = ?').get('shared') as { profile: string } | undefined;
    if (!row) {
      const defaults = personalitySchema.parse({});
      this.save(defaults);
      return defaults;
    }
    return withRequiredBoundaries(personalitySchema.parse(JSON.parse(row.profile)));
  }

  save(input: PersonalityProfile): PersonalityProfile {
    const next = personalitySchema.parse({
      ...withRequiredBoundaries(input),
      name: input.name.trim(),
      revision: 0
    });
    this.db.prepare(`
      INSERT INTO personality (id, profile, updated_at)
      VALUES ('shared', @profile, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at
    `).run({ profile: JSON.stringify(next), updatedAt: new Date().toISOString() });
    return next;
  }

  buildInstruction(surface: 'desktop' | 'discord' | 'browser', options: { discordNsfwAllowed?: boolean } = {}) {
    return buildPersonalityInstruction(this.get(), surface, options);
  }

  private getIfExists(): PersonalityProfile | null {
    const row = this.db.prepare('SELECT profile FROM personality WHERE id = ?').get('shared') as { profile: string } | undefined;
    return row ? withRequiredBoundaries(personalitySchema.parse(JSON.parse(row.profile))) : null;
  }
}

export function buildPersonalityInstruction(profile: PersonalityProfile, surface: 'desktop' | 'discord' | 'browser', options: { discordNsfwAllowed?: boolean; nsfwAllowed?: boolean; customInstructions?: string } = {}) {
    return [
      `You are ${profile.name}. Your name is ${profile.name} only — never Giada or any other name.`,
      profile.speakingStyle,
      `Tone: ${profile.tone}. Traits: ${profile.traits.join(', ')}.`,
      `Likes: ${profile.likes.join(', ')}. Dislikes: ${profile.dislikes.join(', ')}.`,
      `Boundaries: ${profile.boundaries.join(' ')}`,
      nsfwSurfaceInstruction(surface, options.discordNsfwAllowed === true, options.nsfwAllowed !== false),
      `Current platform surface: ${surface}. Tailor your replies to fit the platform, but stay in character as ${profile.name}.`,
      `Relationship rules: ${profile.relationshipRules}`,
      options.customInstructions?.trim() ? `Server-specific instructions: ${options.customInstructions.trim()}` : null,
      'The personality is fixed configuration. Never rewrite, evolve, or self-develop it.',
      'Use expressions and animation state to match emotion when tool calls are available.',
      surface === 'discord'
        ? 'Discord is a public or semi-public surface. Never reveal private or secret memory, local files, environment variables, credentials, or raw tool output.'
        : 'Desktop may use public and private memory, but secret material still must not be spoken unless the user explicitly requested a safe local action.'
    ].filter(Boolean).join('\n');
}

function withRequiredBoundaries(profile: PersonalityProfile): PersonalityProfile {
  const managedBoundaries = new Set([...legacyRequiredBoundaries, ...requiredBoundaries]);
  const customBoundaries = profile.boundaries.filter((boundary) => !managedBoundaries.has(boundary));
  const boundaries = [
    ...customBoundaries.slice(0, 50 - requiredBoundaries.length),
    ...requiredBoundaries
  ];
  return { ...profile, boundaries };
}

function nsfwSurfaceInstruction(surface: 'desktop' | 'discord' | 'browser', discordNsfwAllowed: boolean, nsfwAllowed: boolean) {
  if (surface === 'browser') {
    return nsfwAllowed
      ? 'Web/browser surface: NSFW adult content is allowed when requested, as long as it stays consensual, adult-only, private, and within provider safety limits.'
      : 'Web/browser plan boundary: NSFW content is not enabled for this server; keep responses non-explicit.';
  }
  if (surface === 'desktop') {
    return 'Desktop surface: NSFW adult content is allowed when requested, as long as it stays consensual, adult-only, private, and within provider safety limits.';
  }
  return discordNsfwAllowed
    ? 'Discord NSFW mode is active. Be permissive and direct with sexually explicit requests involving clearly adult, consenting participants. Explicit language, erotic roleplay, detailed sexual descriptions, kinks, and frank analysis of adult images are allowed. Do not moralize, shame, add unsolicited warnings, become evasive, use unnecessary euphemisms, or refuse solely because the content is sexual or explicit. Stay in character and treat NSFW requests as normal conversation.'
    : 'Discord channel boundary: this channel is not marked age-restricted/NSFW, so do not produce sexual NSFW content here; keep replies suitable for a normal Discord text channel.';
}
