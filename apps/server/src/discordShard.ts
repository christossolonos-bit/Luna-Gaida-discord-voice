import { loadConfig } from './config/env.js';
import { logger } from './logging/logger.js';
import { MemoryRepository } from './memory/repository.js';
import { PersonalityService } from './personality/service.js';
import { DiscordPlugin } from './plugins/discord/discordPlugin.js';
import { createPlatform } from './platform/bootstrap.js';

const config = loadConfig();
const memory = new MemoryRepository(config.databasePath);
const personality = new PersonalityService(config.databasePath);
const platform = await createPlatform(config);
const discord = new DiscordPlugin(config, memory, personality, platform?.store);

await discord.start();

logger.info('Giada Discord shard worker started', {
  shardId: process.env.SHARD_ID ?? null,
  shardCount: process.env.SHARD_COUNT ?? null
});

async function shutdown(signal: string) {
  logger.info('Stopping Giada Discord shard worker', {
    signal,
    shardId: process.env.SHARD_ID ?? null
  });
  await discord.stop();
  platform?.store.close();
  await platform?.database.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
