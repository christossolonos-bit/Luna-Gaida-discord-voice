import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import type { PlatformStore } from '../platform/store.js';
import type { CredentialProvider } from '../platform/types.js';
import { logger } from '../logging/logger.js';

const DISCORD_API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 0x8n;
const DISCORD_GUILD_CACHE_MS = 60_000;
const discordGuildCache = new Map<string, { expiresAt: number; promise: Promise<DiscordGuild[]> }>();
const discordTokenRefreshes = new Map<string, Promise<string>>();

interface DiscordUser { id: string; username: string; avatar?: string | null }
interface DiscordGuild { id: string; name: string; icon?: string | null; owner?: boolean; permissions: string }
interface DiscordChannel { id: string; name?: string; type: number; nsfw?: boolean; parent_id?: string | null }

export async function registerWebRoutes(app: FastifyInstance, config: AppConfig, store: PlatformStore) {
  const stripe = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null;

  app.get('/api/auth/discord', async (_request, reply) => {
    requireOAuthConfig(config);
    const state = randomBytes(24).toString('base64url');
    reply.setCookie('giada_oauth_state', state, cookieOptions(config, 10 * 60));
    const query = new URLSearchParams({
      client_id: config.DISCORD_APPLICATION_ID!,
      redirect_uri: `${config.GIADA_PUBLIC_URL}/api/auth/discord/callback`,
      response_type: 'code',
      scope: 'identify guilds',
      state,
      prompt: 'none'
    });
    return reply.redirect(`https://discord.com/oauth2/authorize?${query}`);
  });

  app.get('/api/auth/discord/callback', async (request, reply) => {
    requireOAuthConfig(config);
    const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query);
    if (!request.cookies.giada_oauth_state || request.cookies.giada_oauth_state !== query.state) return reply.code(400).send({ error: 'invalid_oauth_state' });
    const body = new URLSearchParams({
      client_id: config.DISCORD_APPLICATION_ID!,
      client_secret: config.DISCORD_CLIENT_SECRET!,
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: `${config.GIADA_PUBLIC_URL}/api/auth/discord/callback`
    });
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!tokenResponse.ok) return reply.code(502).send({ error: 'discord_token_exchange_failed' });
    const tokens = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number() }).parse(await tokenResponse.json());
    const user = await discordFetch<DiscordUser>('/users/@me', tokens.access_token);
    const csrfToken = randomBytes(24).toString('base64url');
    const session = await store.createSession(user, {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000)
    }, csrfToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    reply.clearCookie('giada_oauth_state', { path: '/' });
    reply.setCookie('giada_session', session.id, cookieOptions(config, 7 * 24 * 60 * 60));
    return reply.redirect('/');
  });

  app.get('/api/me', async (request, reply) => {
    const auth = await authenticate(request, reply, store, config);
    if (!auth) return;
    return { user: publicUser(auth.user), csrfToken: auth.session.csrfToken, owner: isOwner(config, auth.user.id) };
  });

  app.post('/api/logout', async (request, reply) => {
    const auth = await authenticate(request, reply, store, config, true);
    if (!auth) return;
    await store.deleteSession(auth.session.id);
    reply.clearCookie('giada_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/guilds', async (request, reply) => {
    const auth = await authenticate(request, reply, store, config);
    if (!auth) return;
    const managed = (await getDiscordGuilds(auth, store, config)).filter(canManageGuild);
    return { guilds: managed.map(({ permissions: _permissions, ...guild }) => guild) };
  });

  app.get('/api/plans', async () => ({ plans: await store.listPlans(false) }));

  app.get('/api/guilds/:guildId/settings', async (request, reply) => {
    const context = await authorizeGuild(request, reply, store, config);
    if (!context) return;
    const runtime = await store.getGuildRuntime(context.guild.id);
    return { runtime, credentials: await store.listCredentials(context.guild.id), voiceProfiles: await store.listVoiceChangerProfiles(context.guild.id), usage: await store.getUsage(context.guild.id), subscription: await store.getSubscription(context.guild.id) };
  });

  app.put('/api/guilds/:guildId/settings', async (request, reply) => {
    const context = await authorizeGuild(request, reply, store, config, true);
    if (!context) return;
    const body = z.object({ settings: z.unknown().optional(), personality: z.unknown().optional() }).parse(request.body);
    return { runtime: await store.updateGuildConfig(context.guild.id, body, context.auth.user.id) };
  });

  app.get('/api/guilds/:guildId/channels', async (request, reply) => {
    const context = await authorizeGuild(request, reply, store, config);
    if (!context) return;
    if (!config.DISCORD_BOT_TOKEN) return reply.code(503).send({ error: 'discord_bot_not_configured' });
    const runtime = await store.getGuildRuntime(context.guild.id);
    let rawChannels: unknown;
    try {
      rawChannels = await discordApiFetch<unknown>(`/guilds/${context.guild.id}/channels`, `Bot ${config.DISCORD_BOT_TOKEN}`);
    } catch {
      return reply.code(502).send({ error: 'discord_channels_fetch_failed' });
    }
    const channels = z.array(z.object({
      id: z.string(), name: z.string().optional(), type: z.number(), nsfw: z.boolean().optional(), parent_id: z.string().nullable().optional()
    })).parse(rawChannels) as DiscordChannel[];
    return {
      channels: channels.filter((channel) => [0, 2, 5, 13, 15].includes(channel.type)).map((channel) => ({
        id: channel.id,
        name: channel.name ?? channel.id,
        type: channel.type,
        kind: [2, 13].includes(channel.type) ? 'voice' : 'text',
        nsfw: Boolean(channel.nsfw),
        parentId: channel.parent_id ?? null
      })),
      textModels: [
        { id: 'auto', name: 'Automatic' },
        ...(runtime.features.groqText || runtime.features.byokGroq ? [{ id: 'groq', name: `Groq · ${config.GROQ_MODEL}` }] : []),
        ...(runtime.features.geminiText ? [{ id: 'gemini', name: `Gemini Live · ${config.GEMINI_MODEL}` }] : [])
      ],
      voiceModels: runtime.features.geminiVoice ? [
        { id: 'auto', name: 'Automatic' },
        { id: 'gemini', name: `Gemini Live · ${config.GEMINI_MODEL}` }
      ] : []
    };
  });

  app.post('/api/guilds/:guildId/voice-profiles', async (request, reply) => {
    const context = await authorizeGuild(request, reply, store, config, true);
    if (!context) return;
    const body = z.object({
      name: z.string().trim().min(1).max(80),
      ffmpegFilter: z.string().trim().min(1).max(2000)
    }).parse(request.body);
    try {
      return { profile: await store.createVoiceChangerProfile(context.guild.id, body, context.auth.user.id) };
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'voice_profile_name_exists' });
      throw error;
    }
  });

  app.delete('/api/guilds/:guildId/voice-profiles/:profileId', async (request, reply) => {
    const context = await authorizeGuild(request, reply, store, config, true);
    if (!context) return;
    const profileId = z.string().uuid().parse((request.params as { profileId: string }).profileId);
    if (!await store.deleteVoiceChangerProfile(context.guild.id, profileId)) return reply.code(404).send({ error: 'voice_profile_not_found' });
    return { ok: true };
  });

  app.post('/api/guilds/:guildId/avatar', async (request, reply) => {
    const context = await authorizeGuild(request, reply, store, config, true);
    if (!context) return;
    const file = await request.file();
    if (!file || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype)) return reply.code(400).send({ error: 'invalid_avatar_file' });
    const data = await file.toBuffer();
    if (!data.length || data.length > 8 * 1024 * 1024) return reply.code(400).send({ error: 'invalid_avatar_size' });
    await mkdir(config.uploadDir, { recursive: true });
    await writeFile(join(config.uploadDir, `${context.guild.id}.avatar`), data, { mode: 0o600 });
    await writeFile(join(config.uploadDir, `${context.guild.id}.mime`), file.mimetype, { mode: 0o600 });
    const current = await store.getGuildRuntime(context.guild.id);
    const avatarUrl = `${config.GIADA_PUBLIC_URL}/api/guilds/${context.guild.id}/avatar-image?v=${Date.now()}`;
    return { runtime: await store.updateGuildConfig(context.guild.id, { settings: { ...current.settings, avatarUrl } }, context.auth.user.id), avatarUrl };
  });

  app.get('/api/guilds/:guildId/avatar-image', async (request, reply) => {
    const guildId = z.string().regex(/^\d+$/).parse((request.params as { guildId: string }).guildId);
    try {
      const [data, mime] = await Promise.all([
        readFile(join(config.uploadDir, `${guildId}.avatar`)),
        readFile(join(config.uploadDir, `${guildId}.mime`), 'utf8')
      ]);
      return reply.header('Cache-Control', 'public, max-age=86400').type(mime).send(data);
    } catch {
      return reply.code(404).send({ error: 'avatar_not_found' });
    }
  });

  app.put('/api/guilds/:guildId/credentials/:provider', async (request, reply) => {
    const context = await authorizeGuild(request, reply, store, config, true);
    if (!context) return;
    const provider = z.enum(['gemini', 'groq', 'nvidia']).parse((request.params as { provider: string }).provider);
    const body = z.object({ value: z.string().trim().min(8).max(500) }).parse(request.body);
    if (!await validateCredential(config, provider, body.value)) return reply.code(400).send({ error: 'provider_key_validation_failed' });
    return store.putCredential(context.guild.id, provider, body.value);
  });

  app.delete('/api/guilds/:guildId/credentials/:provider', async (request, reply) => {
    const context = await authorizeGuild(request, reply, store, config, true);
    if (!context) return;
    const provider = z.enum(['gemini', 'groq', 'nvidia']).parse((request.params as { provider: string }).provider);
    await store.deleteCredential(context.guild.id, provider);
    return { ok: true };
  });

  app.post('/api/billing/checkout', async (request, reply) => {
    if (!stripe) return reply.code(503).send({ error: 'stripe_not_configured' });
    const context = await authorizeGuild(request, reply, store, config, true);
    if (!context) return;
    const activeSubscription = await store.getSubscription(context.guild.id);
    if (activeSubscription && ['active', 'trialing', 'past_due'].includes(activeSubscription.status)) {
      return reply.code(409).send({ error: 'guild_already_subscribed' });
    }
    const { planId } = z.object({ planId: z.string().uuid() }).parse(request.body);
    const plan = (await store.listPlans(false)).find((candidate) => candidate.id === planId && candidate.kind === 'paid');
    if (!plan?.stripePriceId) return reply.code(400).send({ error: 'plan_not_purchasable' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      client_reference_id: context.guild.id,
      metadata: { guildId: context.guild.id, planId: plan.id },
      subscription_data: { metadata: { guildId: context.guild.id, planId: plan.id } },
      success_url: `${config.GIADA_PUBLIC_URL}/guilds/${context.guild.id}?billing=success`,
      cancel_url: `${config.GIADA_PUBLIC_URL}/guilds/${context.guild.id}?billing=cancelled`
    });
    return { url: session.url };
  });

  app.post('/api/billing/portal', async (request, reply) => {
    if (!stripe) return reply.code(503).send({ error: 'stripe_not_configured' });
    const context = await authorizeGuild(request, reply, store, config, true);
    if (!context) return;
    const subscription = await store.getSubscription(context.guild.id);
    if (!subscription) return reply.code(404).send({ error: 'subscription_not_found' });
    const portal = await stripe.billingPortal.sessions.create({ customer: subscription.stripeCustomerId, return_url: `${config.GIADA_PUBLIC_URL}/guilds/${context.guild.id}` });
    return { url: portal.url };
  });

  app.post('/api/billing/webhook', { config: { rawBody: true } }, async (request, reply) => {
    if (!stripe || !config.STRIPE_WEBHOOK_SECRET || !request.rawBody) return reply.code(503).send({ error: 'stripe_webhook_not_configured' });
    const signature = request.headers['stripe-signature'];
    if (!signature) return reply.code(400).send({ error: 'missing_signature' });
    let event: Stripe.Event;
    try { event = stripe.webhooks.constructEvent(request.rawBody, signature, config.STRIPE_WEBHOOK_SECRET); }
    catch { return reply.code(400).send({ error: 'invalid_signature' }); }
    if (event.type.startsWith('customer.subscription.')) {
      const subscription = event.data.object as Stripe.Subscription;
      const guildId = subscription.metadata.guildId;
      const planId = subscription.metadata.planId;
      const item = subscription.items.data[0];
      if (guildId && planId && item) {
        await store.syncStripeSubscription({
          eventId: event.id,
          eventType: event.type,
          guildId,
          planId,
          customerId: String(subscription.customer),
          subscriptionId: subscription.id,
          status: subscription.status,
          currentPeriodStart: new Date(item.current_period_start * 1000),
          currentPeriodEnd: new Date(item.current_period_end * 1000),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          eventCreated: event.created
        });
      }
    }
    return { received: true };
  });

  app.get('/api/admin/plans', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config);
    if (!auth) return;
    return { plans: await store.listPlans(true) };
  });

  app.put('/api/admin/plans', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config, true);
    if (!auth) return;
    const body = z.object({
      id: z.string().uuid().optional(),
      slug: z.string().regex(/^[a-z0-9-]+$/).min(2).max(50),
      name: z.string().min(1).max(80),
      kind: z.enum(['free', 'paid', 'private']),
      description: z.string().max(500).optional(),
      features: z.record(z.unknown()),
      priceAmount: z.number().int().positive().nullable().optional(),
      priceCurrency: z.string().regex(/^[a-z]{3}$/).optional(),
      published: z.boolean().optional(),
      archived: z.boolean().optional(),
      sortOrder: z.number().int().optional()
    }).parse(request.body);
    const existing = body.id ? (await store.listPlans(true)).find((plan) => plan.id === body.id) : null;
    let stripeProductId = existing?.stripeProductId ?? null;
    let stripePriceId = existing?.stripePriceId ?? null;
    let stripeWarning: string | null = null;
    const priceChanged = !existing || existing.priceAmount !== body.priceAmount || existing.priceCurrency !== (body.priceCurrency ?? 'eur');
    if (body.kind === 'paid' && body.priceAmount) {
      if (stripe) {
        try {
          if (!stripeProductId) stripeProductId = (await stripe.products.create({ name: body.name, metadata: { planSlug: body.slug } })).id;
          if (priceChanged) stripePriceId = (await stripe.prices.create({
            product: stripeProductId,
            unit_amount: body.priceAmount,
            currency: body.priceCurrency ?? 'eur',
            recurring: { interval: 'month' },
            metadata: { planSlug: body.slug }
          })).id;
        } catch (error) {
          if (priceChanged) stripePriceId = null;
          stripeWarning = 'stripe_price_sync_failed';
          logger.warn('Plan saved without a purchasable Stripe Price', { slug: body.slug, error: error instanceof Error ? error.message : String(error) });
        }
      } else {
        if (priceChanged) stripePriceId = null;
        stripeWarning = 'stripe_not_configured';
      }
    }
    const plan = await store.upsertPlan({
      slug: body.slug,
      name: body.name,
      kind: body.kind,
      features: body.features,
      stripeProductId,
      stripePriceId,
      ...(body.id ? { id: body.id } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.priceAmount !== undefined ? { priceAmount: body.priceAmount } : {}),
      ...(body.priceCurrency !== undefined ? { priceCurrency: body.priceCurrency } : {}),
      ...(body.published !== undefined ? { published: body.published } : {}),
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {})
    });
    return { plan, stripeWarning };
  });

  app.get('/api/admin/provider-keys', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config);
    if (!auth) return;
    return { keys: await store.listAdminProviderKeys() };
  });

  app.post('/api/admin/provider-keys', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config, true);
    if (!auth) return;
    const body = z.object({ provider: z.enum(['gemini_paid', 'gemini_private', 'groq', 'nvidia']), label: z.string().min(1).max(80), value: z.string().min(8).max(500) }).parse(request.body);
    const validationProvider: CredentialProvider = body.provider === 'gemini_paid' || body.provider === 'gemini_private'
      ? 'gemini'
      : body.provider;
    if (!await validateCredential(config, validationProvider, body.value)) return reply.code(400).send({ error: 'provider_key_validation_failed' });
    return { key: await store.addProviderKey(body.provider, body.label, body.value) };
  });

  app.delete('/api/admin/provider-keys/:id', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config, true);
    if (!auth) return;
    await store.deleteProviderKey(z.string().uuid().parse((request.params as { id: string }).id));
    return { ok: true };
  });

  app.patch('/api/admin/provider-keys/:id', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config, true);
    if (!auth) return;
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const body = z.object({
      provider: z.enum(['gemini_paid', 'gemini_private', 'groq', 'nvidia']).optional(),
      label: z.string().trim().min(1).max(80).optional(),
      enabled: z.boolean().optional(),
      value: z.string().trim().min(8).max(500).optional()
    }).refine((value) => Object.keys(value).length > 0, 'At least one field is required').parse(request.body);
    const existing = (await store.listAdminProviderKeys()).find((key) => key.id === id);
    if (!existing) return reply.code(404).send({ error: 'provider_key_not_found' });
    if (body.provider && body.provider !== existing.provider && !body.value) {
      return reply.code(400).send({ error: 'new_key_required_when_changing_provider' });
    }
    if (body.value) {
      const provider = body.provider ?? existing.provider;
      const validationProvider: CredentialProvider = provider === 'gemini_paid' || provider === 'gemini_private' ? 'gemini' : provider;
      if (!await validateCredential(config, validationProvider, body.value)) return reply.code(400).send({ error: 'provider_key_validation_failed' });
    }
    return { key: await store.updateProviderKey(id, {
      ...(body.provider !== undefined ? { provider: body.provider } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.value !== undefined ? { value: body.value } : {})
    }) };
  });

  app.put('/api/admin/private-guilds/:guildId', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config, true);
    if (!auth) return;
    const guildId = z.string().regex(/^\d+$/).parse((request.params as { guildId: string }).guildId);
    const { assigned } = z.object({ assigned: z.boolean() }).parse(request.body);
    const discordGuild = (await getDiscordGuilds(auth, store, config)).find((guild) => guild.id === guildId);
    if (discordGuild) await store.ensureGuild(discordGuild);
    const assignment = await store.assignPrivate(guildId, assigned);
    return { ok: true, assignment, runtime: await store.getGuildRuntime(guildId) };
  });

  app.get('/api/admin/guilds', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config);
    if (!auth) return;
    return { guilds: await store.listPrivateGuilds() };
  });

  app.post('/api/admin/usage-adjustments', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config, true);
    if (!auth) return;
    const body = z.object({
      guildId: z.string().regex(/^\d+$/),
      creditDelta: z.number().int().optional(),
      messageDelta: z.number().int().optional(),
      reason: z.string().trim().min(3).max(300)
    }).refine((value) => Boolean(value.creditDelta || value.messageDelta), 'An adjustment is required').parse(request.body);
    return { usage: await store.adjustUsage(body.guildId, {
      reason: body.reason,
      actorId: auth.user.id,
      ...(body.creditDelta !== undefined ? { creditDelta: body.creditDelta } : {}),
      ...(body.messageDelta !== undefined ? { messageDelta: body.messageDelta } : {})
    }) };
  });

  app.get('/api/admin/usage', async (request, reply) => {
    const auth = await authorizeOwner(request, reply, store, config);
    if (!auth) return;
    return { usage: await store.listUsageReport() };
  });
}

async function authenticate(request: FastifyRequest, reply: FastifyReply, store: PlatformStore, config: AppConfig, requireCsrf = false) {
  const id = request.cookies.giada_session;
  if (!id) { reply.code(401).send({ error: 'authentication_required' }); return null; }
  const auth = await store.getSession(id);
  if (!auth) { reply.code(401).send({ error: 'session_expired' }); return null; }
  if (requireCsrf && request.headers['x-csrf-token'] !== auth.session.csrfToken) { reply.code(403).send({ error: 'invalid_csrf_token' }); return null; }
  const origin = request.headers.origin;
  if (requireCsrf && origin && origin !== new URL(config.GIADA_PUBLIC_URL).origin) { reply.code(403).send({ error: 'invalid_origin' }); return null; }
  return auth;
}

async function authorizeGuild(request: FastifyRequest, reply: FastifyReply, store: PlatformStore, config: AppConfig, requireCsrf = false) {
  const auth = await authenticate(request, reply, store, config, requireCsrf);
  if (!auth) return null;
  const guildId = (request.params as { guildId?: string }).guildId
    ?? (request.body && typeof request.body === 'object' && 'guildId' in request.body ? String((request.body as { guildId?: unknown }).guildId ?? '') : undefined);
  const guild = (await getDiscordGuilds(auth, store, config)).find((candidate) => candidate.id === guildId && canManageGuild(candidate));
  if (!guild) { reply.code(403).send({ error: 'guild_admin_required' }); return null; }
  await store.ensureGuild(guild);
  return { auth, guild };
}

async function authorizeOwner(request: FastifyRequest, reply: FastifyReply, store: PlatformStore, config: AppConfig, requireCsrf = false) {
  const auth = await authenticate(request, reply, store, config, requireCsrf);
  if (!auth) return null;
  if (!isOwner(config, auth.user.id)) { reply.code(403).send({ error: 'owner_required' }); return null; }
  return auth;
}

async function getDiscordGuilds(auth: NonNullable<Awaited<ReturnType<typeof authenticate>>>, store: PlatformStore, config: AppConfig) {
  const token = await getDiscordAccessToken(auth, store, config);
  const cached = discordGuildCache.get(auth.session.id);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = discordFetch<DiscordGuild[]>('/users/@me/guilds', token).catch((error) => {
    if (discordGuildCache.get(auth.session.id)?.promise === promise) discordGuildCache.delete(auth.session.id);
    throw error;
  });
  discordGuildCache.set(auth.session.id, { expiresAt: Date.now() + DISCORD_GUILD_CACHE_MS, promise });
  const expiry = setTimeout(() => {
    if (discordGuildCache.get(auth.session.id)?.promise === promise) discordGuildCache.delete(auth.session.id);
  }, DISCORD_GUILD_CACHE_MS);
  expiry.unref();
  return promise;
}

async function getDiscordAccessToken(auth: NonNullable<Awaited<ReturnType<typeof authenticate>>>, store: PlatformStore, config: AppConfig) {
  if (auth.session.tokenExpiresAt.getTime() > Date.now() + 60_000) return store.decryptSessionAccessToken(auth.session.encryptedAccessToken);
  const existing = discordTokenRefreshes.get(auth.session.id);
  if (existing) return existing;
  discordGuildCache.delete(auth.session.id);
  const refresh = (async () => {
    const refreshToken = store.decryptSessionRefreshToken(auth.session.encryptedRefreshToken);
    if (!refreshToken || !config.DISCORD_APPLICATION_ID || !config.DISCORD_CLIENT_SECRET) throw new Error('discord_oauth_session_expired');
    const body = new URLSearchParams({ client_id: config.DISCORD_APPLICATION_ID, client_secret: config.DISCORD_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refreshToken });
    const response = await fetch(`${DISCORD_API}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('discord_oauth_refresh_failed');
    const next = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number() }).parse(await response.json());
    await store.updateSessionTokens(auth.session.id, {
      accessToken: next.access_token,
      ...(next.refresh_token ? { refreshToken: next.refresh_token } : {}),
      tokenExpiresAt: new Date(Date.now() + next.expires_in * 1000)
    });
    return next.access_token;
  })().finally(() => discordTokenRefreshes.delete(auth.session.id));
  discordTokenRefreshes.set(auth.session.id, refresh);
  return refresh;
}

async function discordFetch<T>(path: string, accessToken: string): Promise<T> {
  return discordApiFetch<T>(path, `Bearer ${accessToken}`);
}

async function discordApiFetch<T>(path: string, authorization: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${DISCORD_API}${path}`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(15_000) });
    if (response.ok) return response.json() as Promise<T>;
    if (response.status !== 429 || attempt > 0) throw new Error(`Discord API HTTP ${response.status}`);
    const payload = await response.json().catch(() => ({})) as { retry_after?: number };
    const headerSeconds = Number(response.headers.get('retry-after') ?? 0);
    const retrySeconds = Number.isFinite(payload.retry_after) ? payload.retry_after! : headerSeconds;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retrySeconds * 1_000, 250), 10_000)));
  }
  throw new Error('Discord API retry exhausted');
}

function canManageGuild(guild: DiscordGuild) {
  return Boolean(guild.owner) || (BigInt(guild.permissions) & ADMINISTRATOR) === ADMINISTRATOR;
}

function cookieOptions(config: AppConfig, maxAge: number) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: config.GIADA_PUBLIC_URL.startsWith('https://'), maxAge };
}

function isOwner(config: AppConfig, userId: string) {
  return Boolean(config.GIADA_OWNER_DISCORD_USER_ID && config.GIADA_OWNER_DISCORD_USER_ID === userId);
}

function requireOAuthConfig(config: AppConfig) {
  if (!config.DISCORD_APPLICATION_ID || !config.DISCORD_CLIENT_SECRET) throw new Error('Discord OAuth is not configured');
}

function publicUser(user: DiscordUser) {
  return { id: user.id, username: user.username, avatar: user.avatar ?? null };
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

async function validateCredential(config: AppConfig, provider: CredentialProvider, value: string) {
  const request = provider === 'gemini'
    ? { url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`, headers: {} }
    : provider === 'groq'
      ? { url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: `Bearer ${value}` } }
      : { url: new URL('/v1/models', config.NVIDIA_NIM_URL).toString(), headers: { Authorization: `Bearer ${value}` } };
  try {
    const response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
