import Fastify from 'fastify';
import { createServer, type IncomingMessage } from 'node:http';
import { loadConfig } from './config/env.js';
import { MemoryRepository } from './memory/repository.js';
import { PersonalityService } from './personality/service.js';
import { LiveSessionManager } from './live/liveSession.js';
import { attachRealtimeServer } from './ws/realtimeServer.js';
import { DiscordPlugin, isUsableDiscordToken } from './plugins/discord/discordPlugin.js';
import { DiscordShardManagerPlugin } from './plugins/discord/discordShardManager.js';
import { PluginManager } from './plugins/plugin.js';
import { logger } from './logging/logger.js';

const config = loadConfig();
const app = Fastify({ logger: false });
const memory = new MemoryRepository(config.databasePath);
const personality = new PersonalityService(config.databasePath);
const plugins = new PluginManager();
const discord = config.DISCORD_SHARDING_ENABLED
  ? new DiscordShardManagerPlugin(config)
  : new DiscordPlugin(config, memory, personality);

plugins.register(discord);

app.get('/health', async () => ({
  ok: true,
  geminiConfigured: Boolean(config.GEMINI_API_KEY),
  discordConfigured: isUsableDiscordToken(config.DISCORD_BOT_TOKEN)
}));

app.get('/discord/status', async () => discord.getStatus());

app.post('/discord/register-commands', async () => discord.refreshCommands());

app.get('/personality', async () => personality.get());

app.put('/personality', async (request) => personality.save(request.body as ReturnType<typeof personality.get>));

app.get('/memory', async (request) => {
  const query = (request.query as { query?: string }).query ?? '';
  return memory.search(query, { allowPrivate: true });
});

app.post('/memory', async (request) => {
  return memory.write(request.body as Parameters<typeof memory.write>[0]);
});

const server = createServer((req, res) => {
  if (isDiscordInteractionRequest(req)) {
    if (discord instanceof DiscordPlugin) {
      void discord.handleHttpInteraction(req, res);
      return;
    }
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'discord_http_interactions_unavailable_with_process_sharding',
      message: 'Disable the Discord Developer Portal Interactions Endpoint URL and use gateway slash commands when DISCORD_SHARDING_ENABLED=true.'
    }));
    return;
  }
  void app.routing(req, res);
});
attachRealtimeServer(server, () => new LiveSessionManager(config, memory, personality));

await app.ready();

server.listen(config.GIADA_SERVER_PORT, config.GIADA_SERVER_HOST, async () => {
  await plugins.startAll();
  logger.info('Giada backend listening', {
    host: config.GIADA_SERVER_HOST,
    port: config.GIADA_SERVER_PORT
  });
});

process.on('SIGINT', async () => {
  await plugins.stopAll();
  server.close();
  process.exit(0);
});

function isDiscordInteractionRequest(req: IncomingMessage) {
  if (req.method !== 'POST' || !req.url) {
    return false;
  }
  const pathname = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname;
  return pathname === '/interactions' || pathname === '/discord/interactions';
}
