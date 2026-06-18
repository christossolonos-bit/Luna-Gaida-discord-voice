import { ShardingManager, type Shard } from 'discord.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../config/env.js';
import { logger } from '../../logging/logger.js';
import type { GiadaPlugin } from '../plugin.js';
import { isUsableDiscordToken, registerDiscordCommands } from './discordPlugin.js';

export class DiscordShardManagerPlugin implements GiadaPlugin {
  readonly name = 'discord-shards';
  private manager: ShardingManager | null = null;
  private readonly shardEvents = new Map<number, { ready: boolean; lastMessage: unknown; lastDeathAt: string | null; lastError: string | null }>();

  constructor(private readonly config: AppConfig) {}

  async start() {
    const token = this.config.DISCORD_BOT_TOKEN?.trim();
    if (!token || !isUsableDiscordToken(token)) {
      logger.info('Discord sharding disabled: DISCORD_BOT_TOKEN not configured');
      return;
    }

    const shardFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../discordShard.js');
    const manager = new ShardingManager(shardFile, {
      token,
      totalShards: parseShardCount(this.config.DISCORD_SHARD_COUNT),
      respawn: this.config.DISCORD_SHARD_RESPAWN
    });
    this.manager = manager;

    manager.on('shardCreate', (shard) => this.trackShard(shard));
    await manager.spawn();
    logger.info('Discord shard manager started', {
      totalShards: manager.totalShards,
      shardCount: manager.shards.size,
      respawn: this.config.DISCORD_SHARD_RESPAWN
    });
  }

  async stop() {
    const manager = this.manager;
    this.manager = null;
    if (!manager) {
      return;
    }
    await Promise.all([...manager.shards.values()].map(async (shard) => {
      try {
        await shard.kill();
      } catch (error) {
        logger.warn('Failed to stop Discord shard', {
          shardId: shard.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }));
    this.shardEvents.clear();
  }

  getStatus() {
    const manager = this.manager;
    return {
      configured: {
        usableToken: isUsableDiscordToken(this.config.DISCORD_BOT_TOKEN),
        applicationId: this.config.DISCORD_APPLICATION_ID?.trim() || null,
        shardingEnabled: this.config.DISCORD_SHARDING_ENABLED,
        shardCount: this.config.DISCORD_SHARD_COUNT,
        respawn: this.config.DISCORD_SHARD_RESPAWN,
        mode: 'process_sharding',
        registrationMode: this.config.DISCORD_GUILD_ID
          ? 'single_guild_rest'
          : this.config.DISCORD_REGISTER_GLOBAL_COMMANDS
            ? 'global_rest'
            : 'global_registration_disabled'
      },
      connected: Boolean(manager),
      shardCount: manager?.shards.size ?? 0,
      totalShards: manager?.totalShards ?? null,
      shards: [...(manager?.shards.values() ?? [])].map((shard) => ({
        id: shard.id,
        ready: this.shardEvents.get(shard.id)?.ready ?? false,
        lastDeathAt: this.shardEvents.get(shard.id)?.lastDeathAt ?? null,
        lastError: this.shardEvents.get(shard.id)?.lastError ?? null
      }))
    };
  }

  async refreshCommands() {
    return {
      ...await registerDiscordCommands(this.config),
      status: this.getStatus()
    };
  }

  private trackShard(shard: Shard) {
    this.shardEvents.set(shard.id, { ready: false, lastMessage: null, lastDeathAt: null, lastError: null });
    logger.info('Launched Discord shard', { shardId: shard.id });
    shard.on('ready', () => {
      const state = this.getShardState(shard.id);
      state.ready = true;
      logger.info('Discord shard ready', { shardId: shard.id });
    });
    shard.on('message', (message) => {
      const state = this.getShardState(shard.id);
      state.lastMessage = message;
    });
    shard.on('death', (process) => {
      const state = this.getShardState(shard.id);
      state.ready = false;
      state.lastDeathAt = new Date().toISOString();
      logger.warn('Discord shard exited', {
        shardId: shard.id,
        exitCode: 'exitCode' in process ? process.exitCode : null,
        signalCode: 'signalCode' in process ? process.signalCode : null
      });
    });
    shard.on('error', (error) => {
      const state = this.getShardState(shard.id);
      state.lastError = error.message;
      logger.error('Discord shard failed', {
        shardId: shard.id,
        error: error.message
      });
    });
  }

  private getShardState(shardId: number) {
    let state = this.shardEvents.get(shardId);
    if (!state) {
      state = { ready: false, lastMessage: null, lastDeathAt: null, lastError: null };
      this.shardEvents.set(shardId, state);
    }
    return state;
  }
}

function parseShardCount(value: string): number | 'auto' {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return 'auto';
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 'auto';
}
