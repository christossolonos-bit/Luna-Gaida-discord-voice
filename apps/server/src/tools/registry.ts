import { z } from 'zod';
import type { MemoryRepository } from '../memory/repository.js';
import { classifyText } from '../policy/privacy.js';

export interface ToolContext {
  surface: 'desktop' | 'discord';
  memory: MemoryRepository;
  emitClientEvent?: (event: unknown) => void;
}

export interface RegisteredTool {
  declaration: Record<string, unknown>;
  run(args: unknown, context: ToolContext): Promise<Record<string, unknown>>;
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

const availableModels = ['AI_Maid', 'AI_Casual', 'AI_Future', 'AI_Military', 'AI_Party'];

export function createToolRegistry(): RegisteredTool[] {
  return [
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
          source: context.surface
        };
        const record = context.memory.write(parsed.tags ? { ...writeInput, tags: parsed.tags } : writeInput);
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
        const records = context.memory.search(query, { allowPrivate: context.surface === 'desktop' });
        return { memories: records.map(({ id, content, tags, source, privacy }) => ({ id, content, tags, source, privacy })) };
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
    }
  ];
}
