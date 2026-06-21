import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import rawBody from 'fastify-raw-body';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { loadConfig, type AppConfig } from './config/env.js';
import { MemoryRepository } from './memory/repository.js';
import { buildPersonalityInstruction, PersonalityService, type PersonalityInstructionProvider } from './personality/service.js';
import { LiveSessionManager } from './live/liveSession.js';
import { attachRealtimeServer } from './ws/realtimeServer.js';
import { DiscordPlugin, isUsableDiscordToken } from './plugins/discord/discordPlugin.js';
import { DiscordShardManagerPlugin } from './plugins/discord/discordShardManager.js';
import { PluginManager } from './plugins/plugin.js';
import { logger } from './logging/logger.js';
import { createPlatform } from './platform/bootstrap.js';
import { registerWebRoutes } from './web/routes.js';
import { personalityProfileForRuntime } from './platform/store.js';
import { LiveUsageMeter } from './platform/liveUsageMeter.js';
import { BrowserRealtimeSession } from './ws/browserSession.js';
import { ZodError } from 'zod';

const config = loadConfig();
const ignoredProviderEnvironmentKeys = ['GEMINI_API_KEY', 'GROQ_API_KEYS', 'NVIDIA_API_KEY'].filter((name) => Boolean(process.env[name]));
if (ignoredProviderEnvironmentKeys.length) {
  logger.warn('Legacy provider API key environment variables are ignored; remove them and configure encrypted database keys in the owner dashboard', {
    names: ignoredProviderEnvironmentKeys
  });
}
const app = Fastify({ logger: false });
const platform = await createPlatform(config);
await app.register(cookie, { secret: config.GIADA_MASTER_KEY ?? 'development-only-cookie-secret-change-me' });
await app.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true });
await app.register(multipart, { limits: { files: 1, fileSize: 8 * 1024 * 1024 } });
app.addHook('onSend', async (_request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  reply.header('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://discord.com"
  ].join('; '));
  if (config.GIADA_PUBLIC_URL.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});
app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid_request', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  const message = error instanceof Error ? error.message : String(error);
  const denied = message.endsWith('_not_enabled') || message.startsWith('byok_') || message === 'custom_personality_not_enabled' || message === 'custom_identity_not_enabled';
  if (denied) return reply.code(403).send({ error: message });
  if (message.endsWith('_too_long_for_plan')) return reply.code(400).send({ error: message });
  if (message.endsWith('_not_found')) return reply.code(404).send({ error: message });
  logger.error('HTTP request failed', { method: request.method, url: request.url, error: message });
  return reply.code(500).send({ error: 'internal_server_error' });
});
const memory = new MemoryRepository(config.databasePath);
const personality = new PersonalityService(config.databasePath);
const plugins = new PluginManager();
const discord = config.DISCORD_SHARDING_ENABLED
  ? new DiscordShardManagerPlugin(config)
  : new DiscordPlugin(config, memory, personality, platform?.store);

plugins.register(discord);

app.get('/health', async () => {
  const keys = platform ? await platform.store.listAdminProviderKeys() : [];
  return {
    ok: true,
    providerKeys: {
      geminiPaid: keys.some((key) => key.provider === 'gemini_paid' && key.enabled),
      geminiPrivate: keys.some((key) => key.provider === 'gemini_private' && key.enabled),
      groq: keys.some((key) => key.provider === 'groq' && key.enabled),
      nvidia: keys.some((key) => key.provider === 'nvidia' && key.enabled)
    },
    discordConfigured: isUsableDiscordToken(config.DISCORD_BOT_TOKEN),
    platformConfigured: Boolean(platform)
  };
});

if (platform) {
  await registerWebRoutes(app, config, platform.store);
}

if (existsSync(config.webDistPath)) {
  await app.register(fastifyStatic, { root: config.webDistPath, prefix: '/' });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
}

if (!platform && isLoopbackHost(config.GIADA_SERVER_HOST)) {
  app.get('/discord/status', async () => discord.getStatus());
  app.post('/discord/register-commands', async () => discord.refreshCommands());
  app.get('/personality', async () => personality.get());
  app.put('/personality', async (request) => personality.save(request.body as ReturnType<typeof personality.get>));
  app.get('/memory', async (request) => memory.search((request.query as { query?: string }).query ?? '', { allowPrivate: true }));
  app.post('/memory', async (request) => memory.write(request.body as Parameters<typeof memory.write>[0]));
}

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
const desktopGeminiKey = platform ? (await platform.store.pickProviderKey('gemini_private'))?.value : undefined;
attachRealtimeServer(server, () => new LiveSessionManager(config, memory, personality, {
  ...(desktopGeminiKey ? { geminiApiKey: desktopGeminiKey } : {})
}), {
  createBrowserLive: platform ? async (request, guildId) => {
    const sessionId = parseCookie(request.headers.cookie ?? '').giada_session;
    if (!sessionId) return null;
    const auth = await platform.store.getSession(sessionId);
    if (!auth) return null;
    const token = platform.store.decryptSessionAccessToken(auth.session.encryptedAccessToken);
    const guildResponse = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (!guildResponse.ok) return null;
    const managed = (await guildResponse.json()) as Array<{ id: string; name: string; icon?: string | null; owner?: boolean; permissions: string }>;
    const guild = managed.find((item) => item.id === guildId && (item.owner || (BigInt(item.permissions) & 8n) === 8n));
    if (!guild) return null;
    await platform.store.ensureGuild(guild);
    const runtime = await platform.store.getGuildRuntime(guildId);
    if (!runtime.features.browserChat || !runtime.settings.browserTextEnabled) return null;
    const effectivePersonality = personalityProfileForRuntime(runtime);
    const byok = runtime.features.byokGemini ? await platform.store.getCredential(guildId, 'gemini') : null;
    let apiKey = byok;
    let metered = false;
    if (!apiKey && runtime.planKind === 'private') apiKey = (await platform.store.pickProviderKey('gemini_private'))?.value ?? null;
    if (!apiKey && runtime.planKind === 'paid') {
      const usage = await platform.store.getUsage(guildId);
      if (usage.unlimited || usage.creditsUsed < usage.creditLimit) {
        apiKey = (await platform.store.pickProviderKey('gemini_paid'))?.value ?? null;
        metered = Boolean(apiKey);
      }
    }
    const personalityProvider: PersonalityInstructionProvider = {
      buildInstruction: (surface, options) => buildPersonalityInstruction(
        effectivePersonality.profile,
        surface,
        {
          ...options,
          nsfwAllowed: runtime.features.nsfw && runtime.settings.nsfwEnabled,
          customInstructions: effectivePersonality.customInstructions
        }
      )
    };
    const meter = metered ? new LiveUsageMeter(platform.store, guildId, runtime.features, runtime.settings) : null;
    const gemini = apiKey ? new LiveSessionManager({
      ...config,
      guildVoiceChanger: {
        ...runtime.settings.voiceChanger,
        enabled: runtime.features.voiceChanger && runtime.settings.voiceChanger.enabled
      }
    } as AppConfig, platform.store.guildMemory(guildId), personalityProvider, {
      memoryTags: ['guild', guildId, 'browser'],
      geminiApiKey: apiKey,
      toolEnabled: (name) => name !== 'searchWeb' || runtime.features.webSearch,
      ...(meter ? { beforeInput: meter.beforeInput, onEvent: meter.onEvent } : {})
    }) : null;
    return new BrowserRealtimeSession(config, platform.store, guildId, personalityProvider, gemini);
  } : undefined
});

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
  platform?.store.close();
  await platform?.database.close();
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

function parseCookie(value: string) {
  return Object.fromEntries(value.split(';').map((part) => {
    const [key, ...rest] = part.trim().split('=');
    return [key, decodeURIComponent(rest.join('='))];
  }).filter(([key]) => Boolean(key)));
}

function isLoopbackHost(host: string) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
