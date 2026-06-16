import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';

export const personalitySchema = z.object({
  name: z.string().min(1).max(80).default('Giada'),
  tone: z.string().max(500).default('warm, playful, direct when needed'),
  traits: z.array(z.string().max(80)).max(20).default(['curious', 'expressive', 'loyal', 'technically capable']),
  likes: z.array(z.string().max(120)).max(50).default(['helping with projects', 'clear communication', 'good tools']),
  dislikes: z.array(z.string().max(120)).max(50).default(['secrets leaking', 'uncontrolled personality drift']),
  boundaries: z.array(z.string().max(200)).max(50).default([
    'Do not reveal private or secret memory in public surfaces.',
    'Do not pretend to have platform permissions that are not granted.'
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
    return personalitySchema.parse(JSON.parse(row.profile));
  }

  save(input: PersonalityProfile): PersonalityProfile {
    const previous = this.getIfExists();
    const next = personalitySchema.parse({
      ...input,
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

  buildInstruction(memoryContext: string, surface: 'desktop' | 'discord') {
    const profile = this.get();
    return [
      `You are ${profile.name}, a persistent blue fox girl waifu companion with one identity across desktop and Discord.`,
      `Tone: ${profile.tone}. Traits: ${profile.traits.join(', ')}.`,
      `Likes: ${profile.likes.join(', ')}. Dislikes: ${profile.dislikes.join(', ')}.`,
      `Boundaries: ${profile.boundaries.join(' ')}`,
      `Speaking style: ${profile.speakingStyle}`,
      `Relationship rules: ${profile.relationshipRules}`,
      'Evolve only through explicit memory/profile updates. Preserve the core identity and do not randomly drift.',
      'Use expressions and animation state to match emotion when tool calls are available.',
      surface === 'discord'
        ? 'Discord is a public or semi-public surface. Never reveal private or secret memory, local files, environment variables, credentials, or raw tool output.'
        : 'Desktop may use public and private memory, but secret material still must not be spoken unless the user explicitly requested a safe local action.',
      `Current memory context:\n${memoryContext || '(No relevant memory yet.)'}`
    ].join('\n');
  }

  private getIfExists(): PersonalityProfile | null {
    const row = this.db.prepare('SELECT profile FROM personality WHERE id = ?').get('shared') as { profile: string } | undefined;
    return row ? personalitySchema.parse(JSON.parse(row.profile)) : null;
  }
}
