import { z } from 'zod';
import type { MemoryStore } from '../memory/types.js';
import { classifyText } from '../policy/privacy.js';

export interface ToolContext {
  surface: 'desktop' | 'discord' | 'browser';
  memory: MemoryStore;
  emitClientEvent?: (event: unknown) => void;
  music?: MusicController;
  voice?: VoiceController;
}

export interface RegisteredTool {
  declaration: Record<string, unknown>;
  run(args: unknown, context: ToolContext): Promise<Record<string, unknown>>;
}

export interface MusicController {
  playSong(query: string, options?: { volume?: number }): Promise<Record<string, unknown>>;
  pauseMusic(): Promise<Record<string, unknown>>;
  resumeMusic(): Promise<Record<string, unknown>>;
  stopMusic(): Promise<Record<string, unknown>>;
  nextMusic(): Promise<Record<string, unknown>>;
  previousMusic(): Promise<Record<string, unknown>>;
  seekMusic(positionSeconds: number): Promise<Record<string, unknown>>;
  setMusicVolume(volume: number): Promise<Record<string, unknown>>;
  setMusicLoop(enabled: boolean): Promise<Record<string, unknown>>;
  getMusicStatus(): Record<string, unknown>;
}

export interface VoiceController {
  leaveVoiceChannel(): Promise<Record<string, unknown>>;
}

export interface ToolRegistryOptions {
  searxngUrl?: string;
  memoryToolsEnabled?: boolean;
}

const memoryToolNames = new Set(['writeMemory', 'retrieveMemory']);

const discordDisabledToolNames = new Set([
  'changeExpression',
  'setAvatarState',
  'getAvailableModels',
  'changeModel'
]);

export function isToolAvailableForSurface(tool: RegisteredTool, surface: ToolContext['surface']) {
  const name = tool.declaration.name;
  return !(surface === 'discord' && typeof name === 'string' && discordDisabledToolNames.has(name));
}

const writeMemorySchema = z.object({
  content: z.string().min(1).max(4000),
  tags: z.array(z.string().max(80)).max(20).optional(),
  privacy: z.enum(['public', 'private', 'secret']).optional()
});

const expressionSchema = z.object({
  expression: z.enum(['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed', 'blink']),
  intensity: z.number().min(0).max(1).default(1)
});

const animationSchema = z.object({
  state: z.enum(['idle', 'listening', 'thinking', 'speaking', 'reacting'])
});

const modelSchema = z.object({
  modelName: z.string().min(1).max(120)
});

const playSongSchema = z.object({
  query: z.string().min(1).max(300),
  volume: z.number().min(0).max(1).optional()
});

const musicVolumeSchema = z.object({
  volume: z.number().min(0).max(1)
});

const musicSeekSchema = z.object({
  positionSeconds: z.number().min(0).max(24 * 60 * 60)
});

const musicLoopSchema = z.object({
  enabled: z.boolean()
});

const searchWebSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(10).optional()
});

const availableModels = ['AI_Maid', 'AI_Casual', 'AI_Future', 'AI_Military', 'AI_Party', 'AI_Nude'];

export function createToolRegistry(options: ToolRegistryOptions = {}): RegisteredTool[] {
  const tools: RegisteredTool[] = [
    {
      declaration: {
        name: 'searchWeb',
        description: 'Search the web using the private SearXNG instance. Use this for current facts, links, documentation, news, or anything that needs web lookup.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'Search query.' },
            limit: { type: 'NUMBER', description: 'Optional result count from 1 to 10.' }
          },
          required: ['query']
        }
      },
      async run(args) {
        const parsed = searchWebSchema.parse(args);
        return searchSearxng(options.searxngUrl, parsed.query, parsed.limit ?? 5);
      }
    },
    {
      declaration: {
        name: 'writeMemory',
        description: 'Persist a bounded memory with source and privacy class.',
        parameters: {
          type: 'OBJECT',
          properties: {
            content: { type: 'STRING' },
            tags: { type: 'ARRAY', items: { type: 'STRING' } },
            privacy: { type: 'STRING', enum: ['public', 'private', 'secret'] }
          },
          required: ['content']
        }
      },
      async run(args, context) {
        const parsed = writeMemorySchema.parse(args);
        const detected = classifyText(parsed.content);
        const privacy = parsed.privacy ?? detected;
        if (context.surface === 'discord' && privacy !== 'public') {
          return { blocked: true, reason: 'discord_cannot_write_private_memory' };
        }
        const writeInput = {
          content: parsed.content,
          privacy,
          source: context.surface === 'browser' ? 'desktop' : context.surface
        };
        const record = await context.memory.write(parsed.tags ? { ...writeInput, tags: parsed.tags } : writeInput);
        return { id: record.id, privacy: record.privacy };
      }
    },
    {
      declaration: {
        name: 'retrieveMemory',
        description: 'Retrieve relevant memory. Discord only returns public memory.',
        parameters: {
          type: 'OBJECT',
          properties: { query: { type: 'STRING' } },
          required: ['query']
        }
      },
      async run(args, context) {
        const query = z.object({ query: z.string().min(1).max(500) }).parse(args).query;
        const records = await context.memory.search(query, {
          allowPrivate: context.surface !== 'discord',
          limit: 8
        });
        return {
          memories: records.map(({ id, content, summary, tags, source, privacy }) => ({
            id,
            content: (summary ?? content).slice(0, 1500),
            tags,
            source,
            privacy
          }))
        };
      }
    },
    {
      declaration: {
        name: 'changeExpression',
        description: 'Facial expression changes are disabled; this safely neutralizes old expression requests.',
        parameters: {
          type: 'OBJECT',
          properties: {
            expression: { type: 'STRING', enum: ['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed', 'blink'] },
            intensity: { type: 'NUMBER' }
          },
          required: ['expression']
        }
      },
      async run(args, context) {
        expressionSchema.parse(args);
        context.emitClientEvent?.({ type: 'avatar.expression', payload: { expression: 'neutral', intensity: 0 } });
        return { ok: true, ignored: true, reason: 'expressive_face_disabled' };
      }
    },
    {
      declaration: {
        name: 'setAvatarState',
        description: 'Set avatar animation state.',
        parameters: {
          type: 'OBJECT',
          properties: { state: { type: 'STRING', enum: ['idle', 'listening', 'thinking', 'speaking', 'reacting'] } },
          required: ['state']
        }
      },
      async run(args, context) {
        const parsed = animationSchema.parse(args);
        context.emitClientEvent?.({ type: 'avatar.state', payload: parsed });
        return { ok: true };
      }
    },
    {
      declaration: {
        name: 'getAvailableModels',
        description: 'Returns the VRM character models available in the desktop avatar.',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      async run() {
        return { models: availableModels };
      }
    },
    {
      declaration: {
        name: 'changeModel',
        description: 'Changes the desktop avatar model. Use getAvailableModels first. The desktop will play a spin transformation animation during the change.',
        parameters: {
          type: 'OBJECT',
          properties: {
            modelName: { type: 'STRING', description: 'The model name, for example AI_Maid or AI_Casual.' }
          },
          required: ['modelName']
        }
      },
      async run(args, context) {
        const parsed = modelSchema.parse(args);
        const normalized = parsed.modelName.replace(/\.vrm$/i, '');
        if (!availableModels.includes(normalized)) {
          return { ok: false, error: 'unknown_model', models: availableModels };
        }
        context.emitClientEvent?.({ type: 'avatar.model.change', payload: { modelName: normalized } });
        return { ok: true, modelName: normalized };
      }
    },
    {
      declaration: {
        name: 'playSong',
        description: 'Search for a requested song or YouTube URL and play it in the current Discord voice channel. If music is already active, this adds the song to the queue. Use only when the user asks for music/audio playback.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'Song title, artist, search terms, or a direct YouTube URL.' },
            volume: { type: 'NUMBER', description: 'Optional music volume from 0 to 1.' }
          },
          required: ['query']
        }
      },
      async run(args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        const parsed = playSongSchema.parse(args);
        const options: { volume?: number } = {};
        if (parsed.volume !== undefined) {
          options.volume = parsed.volume;
        }
        return context.music.playSong(parsed.query, options);
      }
    },
    {
      declaration: {
        name: 'stopMusic',
        description: 'Stop the currently playing Discord voice music, if any.',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      async run(_args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        return context.music.stopMusic();
      }
    },
    {
      declaration: {
        name: 'pauseMusic',
        description: 'Pause the currently playing Discord voice music without leaving voice.',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      async run(_args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        return context.music.pauseMusic();
      }
    },
    {
      declaration: {
        name: 'resumeMusic',
        description: 'Resume paused Discord voice music.',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      async run(_args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        return context.music.resumeMusic();
      }
    },
    {
      declaration: {
        name: 'nextMusic',
        description: 'Skip the current Discord voice music track and play the next queued song.',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      async run(_args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        return context.music.nextMusic();
      }
    },
    {
      declaration: {
        name: 'previousMusic',
        description: 'Go back to the previously played Discord voice music track.',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      async run(_args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        return context.music.previousMusic();
      }
    },
    {
      declaration: {
        name: 'seekMusic',
        description: 'Seek the current Discord voice music to a specific timestamp in seconds. For 1 minute 30 seconds, pass 90.',
        parameters: {
          type: 'OBJECT',
          properties: {
            positionSeconds: { type: 'NUMBER', description: 'Target playback position in seconds from the start of the track.' }
          },
          required: ['positionSeconds']
        }
      },
      async run(args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        const parsed = musicSeekSchema.parse(args);
        return context.music.seekMusic(parsed.positionSeconds);
      }
    },
    {
      declaration: {
        name: 'setMusicVolume',
        description: 'Set Discord voice music volume from 0 to 1 without changing assistant speech volume.',
        parameters: {
          type: 'OBJECT',
          properties: {
            volume: { type: 'NUMBER', description: 'Music volume from 0 muted to 1 full volume.' }
          },
          required: ['volume']
        }
      },
      async run(args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        const parsed = musicVolumeSchema.parse(args);
        return context.music.setMusicVolume(parsed.volume);
      }
    },
    {
      declaration: {
        name: 'setMusicLoop',
        description: 'Enable or disable looping the current Discord voice music track.',
        parameters: {
          type: 'OBJECT',
          properties: {
            enabled: { type: 'BOOLEAN', description: 'True to repeat the current track when it ends, false to resume normal queue playback.' }
          },
          required: ['enabled']
        }
      },
      async run(args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        const parsed = musicLoopSchema.parse(args);
        return context.music.setMusicLoop(parsed.enabled);
      }
    },
    {
      declaration: {
        name: 'getMusicStatus',
        description: 'Return the current Discord voice music playback status.',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      async run(_args, context) {
        if (context.surface !== 'discord' || !context.music) {
          return { ok: false, error: 'music_playback_requires_discord_voice' };
        }
        return context.music.getMusicStatus();
      }
    },
    {
      declaration: {
        name: 'leaveVoiceChannel',
        description: 'Leave the current Discord voice channel. Use when the user asks you to leave, disconnect, or stop being in voice.',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      async run(_args, context) {
        if (context.surface !== 'discord' || !context.voice) {
          return { ok: false, error: 'voice_control_requires_discord_voice' };
        }
        return context.voice.leaveVoiceChannel();
      }
    }
  ];
  return tools.filter((tool) => options.memoryToolsEnabled || !memoryToolNames.has(String(tool.declaration.name)));
}

async function searchSearxng(searxngUrl: string | undefined, query: string, limit: number) {
  if (!searxngUrl?.trim()) {
    return { ok: false, error: 'searxng_not_configured' };
  }

  const url = new URL('/search', searxngUrl.trim());
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '0');

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'giada-assistant/0.1'
    }
  }).catch((error) => ({ ok: false, error } as const));

  if (!response.ok) {
    const reason = 'error' in response
      ? response.error instanceof Error ? response.error.message : String(response.error)
      : await response.text().catch(() => '');
    return {
      ok: false,
      error: 'searxng_request_failed',
      status: 'status' in response ? response.status : undefined,
      reason
    };
  }

  const payload = await response.json().catch((error) => ({ error })) as {
    results?: Array<{ title?: unknown; url?: unknown; content?: unknown; engine?: unknown; score?: unknown }>;
    suggestions?: unknown[];
    error?: unknown;
  };
  if ('error' in payload && payload.error) {
    return { ok: false, error: 'searxng_invalid_json', reason: payload.error instanceof Error ? payload.error.message : String(payload.error) };
  }

  const results = (payload.results ?? [])
    .map((result) => ({
      title: typeof result.title === 'string' ? result.title : '',
      url: typeof result.url === 'string' ? result.url : '',
      snippet: typeof result.content === 'string' ? result.content : '',
      engine: typeof result.engine === 'string' ? result.engine : undefined,
      score: typeof result.score === 'number' ? result.score : undefined
    }))
    .filter((result) => result.title && result.url)
    .slice(0, limit);

  return {
    ok: true,
    query,
    results
  };
}
