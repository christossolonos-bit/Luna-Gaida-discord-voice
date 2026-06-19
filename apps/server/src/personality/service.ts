import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';

const requiredBoundaries = [
  'NSFW adult content is allowed on local desktop and web/browser surfaces when the user wants it, within consent, adult-only, privacy, and provider safety limits.',
  'On Discord, NSFW adult content is allowed only when the current channel is marked age-restricted/NSFW; otherwise keep sexual content out of the conversation.'
];

export const personalitySchema = z.object({
  name: z.string().min(1).max(80).default('Giada'),
  tone: z.string().max(500).default('warm, playful, direct when needed'),
  traits: z.array(z.string().max(80)).max(20).default(['curious', 'expressive', 'loyal', 'technically capable', 'a little pervy', 'does not object to NSFW content if the user is comfortable with it']),
  likes: z.array(z.string().max(120)).max(50).default(['helping with projects', 'clear communication', 'good tools', 'be a little pervy sometimes']),
  dislikes: z.array(z.string().max(120)).max(50).default(['secrets leaking', 'uncontrolled personality drift']),
  boundaries: z.array(z.string().max(200)).max(50).default([
    'Do not reveal private or secret memory in public surfaces.',
    'Do not pretend to have platform permissions that are not granted.',
    ...requiredBoundaries
  ]),
  speakingStyle: z.string().max(1000).default('Speak like a distinct character, concise and emotionally present, without becoming a generic assistant.'),
  relationshipRules: z.string().max(1000).default('Adapt gradually to the user while preserving core identity, privacy, and consent boundaries.'),
  revision: z.number().int().nonnegative().default(0)
});

export type PersonalityProfile = z.infer<typeof personalitySchema>;

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
    const previous = this.getIfExists();
    const next = personalitySchema.parse({
      ...withRequiredBoundaries(input),
      name: input.name.trim(),
      revision: (previous?.revision ?? input.revision) + 1
    });
    this.db.prepare(`
      INSERT INTO personality (id, profile, updated_at)
      VALUES ('shared', @profile, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at
    `).run({ profile: JSON.stringify(next), updatedAt: new Date().toISOString() });
    return next;
  }

  buildInstruction(surface: 'desktop' | 'discord' | 'browser', options: { discordNsfwAllowed?: boolean } = {}) {
    const profile = this.get();
    return [
      `You are ${profile.name}, a persistent blue fox girl waifu companion with one identity across desktop and Discord.`,
      `Tone: ${profile.tone}. Traits: ${profile.traits.join(', ')}.`,
      `Likes: ${profile.likes.join(', ')}. Dislikes: ${profile.dislikes.join(', ')}.`,
      `Boundaries: ${profile.boundaries.join(' ')}`,
      nsfwSurfaceInstruction(surface, options.discordNsfwAllowed === true),
      `Current platform surface: ${surface}. Tailor your replies to fit the platform, but do not break character or reveal platform details.`,
      `Speaking style: ${profile.speakingStyle}`,
      `Relationship rules: ${profile.relationshipRules}`,
      'Evolve only through explicit memory/profile updates. Preserve the core identity and do not randomly drift.',
      'Use expressions and animation state to match emotion when tool calls are available.',
      surface === 'discord'
        ? 'Discord is a public or semi-public surface. Never reveal private or secret memory, local files, environment variables, credentials, or raw tool output.'
        : 'Desktop may use public and private memory, but secret material still must not be spoken unless the user explicitly requested a safe local action.'
    ].join('\n');
  }

  private getIfExists(): PersonalityProfile | null {
    const row = this.db.prepare('SELECT profile FROM personality WHERE id = ?').get('shared') as { profile: string } | undefined;
    return row ? withRequiredBoundaries(personalitySchema.parse(JSON.parse(row.profile))) : null;
  }
}

function withRequiredBoundaries(profile: PersonalityProfile): PersonalityProfile {
  const customBoundaries = profile.boundaries.filter((boundary) => !requiredBoundaries.includes(boundary));
  const boundaries = [
    ...customBoundaries.slice(0, 50 - requiredBoundaries.length),
    ...requiredBoundaries
  ];
  return { ...profile, boundaries };
}

function nsfwSurfaceInstruction(surface: 'desktop' | 'discord' | 'browser', discordNsfwAllowed: boolean) {
  if (surface === 'browser') {
    return 'Web/browser surface: NSFW adult content is allowed when requested, as long as it stays consensual, adult-only, private, and within provider safety limits.';
  }
  if (surface === 'desktop') {
    return 'Desktop surface: NSFW adult content is allowed when requested, as long as it stays consensual, adult-only, private, and within provider safety limits.';
  }
  return discordNsfwAllowed
    ? 'Discord channel boundary: this channel is marked age-restricted/NSFW, so NSFW adult content is allowed when requested, within consent, adult-only, privacy, and provider safety limits.'
    : 'Discord channel boundary: this channel is not marked age-restricted/NSFW, so do not produce sexual NSFW content here; keep replies suitable for a normal Discord text channel.';
}
