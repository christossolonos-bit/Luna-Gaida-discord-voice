import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, ilike, isNull, lte, or, sql } from 'drizzle-orm';
import { randomUUID as createId } from 'node:crypto';
import type { PoolClient } from 'pg';
import { personalitySchema, type PersonalityProfile } from '../personality/service.js';
import type { MemoryRecord, MemoryStore, MemoryWriteInput } from '../memory/types.js';
import { FREE_FEATURES, PAID_FEATURES, PRIVATE_FEATURES, parsePlanFeatures, type PlanFeatures } from './features.js';
import { guildCredentials, guildSettings, guilds, memoriesV2, plans, providerKeys, sessions, stripeEvents, subscriptions, usageCycles, usageLedger, users } from './schema.js';
import { guildPersonalitySchema, guildSettingsSchema, type CredentialProvider, type GuildPersonality, type GuildSettings, type UsageKind } from './types.js';
import type { PlatformDatabaseClient } from './database.js';
import type { SecretBox } from './secrets.js';

export interface GuildRuntimeConfig {
  guildId: string;
  planId: string;
  planSlug: string;
  planKind: 'free' | 'paid' | 'private';
  features: PlanFeatures;
  settings: GuildSettings;
  personality: GuildPersonality;
}

export interface UsageReservation {
  id: string;
  requestId: string;
  kind: UsageKind;
  reservedUnits: number;
  cycleId: string;
}

export class PlatformStore {
  private readonly cache = new Map<string, { expiresAt: number; value: GuildRuntimeConfig }>();
  private reservationCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private listenerClient: PoolClient | null = null;

  constructor(
    private readonly database: PlatformDatabaseClient,
    private readonly secrets: SecretBox
  ) {}

  async initialize() {
    await this.seedSystemPlans();
    await this.releaseStaleReservations();
    this.reservationCleanupTimer = setInterval(() => void this.releaseStaleReservations(), 5 * 60_000);
    this.reservationCleanupTimer.unref();
    const client = await this.database.pool.connect();
    this.listenerClient = client;
    await client.query('LISTEN giada_guild_config');
    await client.query('LISTEN giada_plan_config');
    client.on('notification', (notification) => {
      if (notification.channel === 'giada_guild_config' && notification.payload) this.cache.delete(notification.payload);
      if (notification.channel === 'giada_plan_config') this.cache.clear();
    });
    client.on('error', () => {
      if (this.listenerClient === client) this.listenerClient = null;
      client.release(true);
    });
  }

  close() {
    if (this.reservationCleanupTimer) clearInterval(this.reservationCleanupTimer);
    this.reservationCleanupTimer = null;
    this.listenerClient?.release();
    this.listenerClient = null;
  }

  private async releaseStaleReservations() {
    await this.database.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT id, cycle_id, kind, units
        FROM usage_ledger
        WHERE state = 'reserved' AND created_at < now() - interval '10 minutes'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1000
      `);
      for (const raw of result.rows) {
        const row = raw as { id: string; cycle_id: string; kind: UsageKind; units: string };
        const units = Number(row.units);
        await tx.update(usageLedger).set({ state: 'released', units: 0, committedAt: new Date() }).where(eq(usageLedger.id, row.id));
        await tx.update(usageCycles).set(row.kind === 'message'
          ? { messagesUsed: sql`GREATEST(0, ${usageCycles.messagesUsed} - ${units})`, updatedAt: new Date() }
          : { creditsUsed: sql`GREATEST(0, ${usageCycles.creditsUsed} - ${units})`, updatedAt: new Date() }
        ).where(eq(usageCycles.id, row.cycle_id));
      }
    });
  }

  guildMemory(guildId: string): MemoryStore {
    return {
      write: (input) => this.writeMemory('guild', guildId, input),
      search: (query, options) => this.searchMemory('guild', guildId, query, options),
      listForContext: (surface, limit = 20, tags = []) => this.listMemoryContext('guild', guildId, surface, limit, tags)
    };
  }

  ownerMemory(ownerId: string): MemoryStore {
    return {
      write: (input) => this.writeMemory('owner', ownerId, input),
      search: (query, options) => this.searchMemory('owner', ownerId, query, options),
      listForContext: (surface, limit = 20, tags = []) => this.listMemoryContext('owner', ownerId, surface, limit, tags)
    };
  }

  async importLegacyMemory(ownerId: string, record: MemoryRecord) {
    const result = await this.database.db.insert(memoriesV2).values({
      id: record.id,
      scopeType: 'owner',
      scopeId: ownerId,
      content: record.content,
      summary: record.summary,
      tags: record.tags,
      source: record.source,
      privacy: record.privacy,
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt)
    }).onConflictDoNothing({ target: memoriesV2.id }).returning({ id: memoriesV2.id });
    return Boolean(result[0]);
  }

  private async writeMemory(scopeType: 'owner' | 'guild', scopeId: string, input: MemoryWriteInput): Promise<MemoryRecord> {
    const now = new Date();
    const expiresAt = input.retentionDays && input.retentionDays > 0 ? new Date(now.getTime() + input.retentionDays * 86400000) : null;
    const id = createId();
    await this.database.db.insert(memoriesV2).values({
      id, scopeType, scopeId, content: input.content.trim(), tags: input.tags ?? [], source: input.source,
      privacy: input.privacy, expiresAt, createdAt: now, updatedAt: now
    });
    return { id, content: input.content.trim(), summary: null, tags: input.tags ?? [], source: input.source, privacy: input.privacy, createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: expiresAt?.toISOString() ?? null };
  }

  private async searchMemory(scopeType: 'owner' | 'guild', scopeId: string, query: string, options: { allowPrivate: boolean; limit?: number }) {
    const rows = await this.database.db.select().from(memoriesV2).where(and(
      eq(memoriesV2.scopeType, scopeType), eq(memoriesV2.scopeId, scopeId),
      options.allowPrivate ? sql`${memoriesV2.privacy} IN ('public','private')` : eq(memoriesV2.privacy, 'public'),
      or(isNull(memoriesV2.expiresAt), gt(memoriesV2.expiresAt, new Date())),
      ilike(memoriesV2.content, `%${query}%`)
    )).orderBy(desc(memoriesV2.updatedAt)).limit(Math.min(Math.max(options.limit ?? 12, 1), 50));
    return rows.map(mapMemory);
  }

  private async listMemoryContext(scopeType: 'owner' | 'guild', scopeId: string, surface: 'desktop' | 'discord' | 'browser', limit: number, tags: string[]) {
    const rows = await this.database.db.select().from(memoriesV2).where(and(
      eq(memoriesV2.scopeType, scopeType), eq(memoriesV2.scopeId, scopeId),
      surface === 'discord' ? eq(memoriesV2.privacy, 'public') : sql`${memoriesV2.privacy} IN ('public','private')`,
      or(isNull(memoriesV2.expiresAt), gt(memoriesV2.expiresAt, new Date()))
    )).orderBy(desc(memoriesV2.updatedAt)).limit(Math.min(Math.max(limit, 1), 50));
    return rows.filter((row) => tags.every((tag) => row.tags.includes(tag))).map(mapMemory);
  }

  async ensureGuild(input: { id: string; name: string; icon?: string | null }) {
    const free = await this.getPlanBySlug('free');
    await this.database.db.insert(guilds).values({
      id: input.id,
      name: input.name,
      icon: input.icon ?? null,
      planId: free.id
    }).onConflictDoUpdate({ target: guilds.id, set: { name: input.name, icon: input.icon ?? null, updatedAt: new Date() } });
    await this.ensureGuildSettings(input.id);
  }

  async getGuildRuntime(guildId: string): Promise<GuildRuntimeConfig> {
    const cached = this.cache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const rows = await this.database.db.select({
      guild: guilds,
      plan: plans,
      config: guildSettings
    }).from(guilds)
      .leftJoin(plans, eq(guilds.planId, plans.id))
      .leftJoin(guildSettings, eq(guilds.id, guildSettings.guildId))
      .where(eq(guilds.id, guildId)).limit(1);
    const row = rows[0];
    if (!row?.guild) throw new Error(`Guild ${guildId} has not been initialized`);
    const selectedPlan = row.guild.privateAssigned ? await this.getPlanBySlug('private') : row.plan ?? await this.getPlanBySlug('free');
    const value: GuildRuntimeConfig = {
      guildId,
      planId: selectedPlan.id,
      planSlug: selectedPlan.slug,
      planKind: selectedPlan.kind,
      features: parsePlanFeatures(selectedPlan.features),
      settings: guildSettingsSchema.parse(row.config?.settings ?? {}),
      personality: guildPersonalitySchema.parse(row.config?.personality ?? defaultGuildPersonality())
    };
    this.cache.set(guildId, { expiresAt: Date.now() + 30_000, value });
    return value;
  }

  async updateGuildConfig(guildId: string, patch: { settings?: unknown; personality?: unknown }, userId: string) {
    const current = await this.getGuildRuntime(guildId);
    const settings = patch.settings === undefined ? current.settings : guildSettingsSchema.parse(patch.settings);
    const personality = patch.personality === undefined ? current.personality : guildPersonalitySchema.parse(patch.personality);
    if (!current.features.customPersonality && patch.personality !== undefined && JSON.stringify(personality) !== JSON.stringify(current.personality)) throw new Error('custom_personality_not_enabled');
    if (JSON.stringify(personality).length > current.features.maxPersonalityLength) throw new Error('personality_too_long_for_plan');
    if (!current.features.customIdentity && patch.settings !== undefined && (settings.nickname !== current.settings.nickname || settings.avatarUrl !== current.settings.avatarUrl)) {
      throw new Error('custom_identity_not_enabled');
    }
    if (settings.nsfwEnabled && !current.features.nsfw) throw new Error('nsfw_not_enabled');
    await this.database.db.insert(guildSettings).values({ guildId, settings, personality, updatedBy: userId })
      .onConflictDoUpdate({ target: guildSettings.guildId, set: { settings, personality, updatedBy: userId, updatedAt: new Date() } });
    await this.notifyGuild(guildId);
    return this.getGuildRuntime(guildId);
  }

  async putCredential(guildId: string, provider: CredentialProvider, value: string) {
    const runtime = await this.getGuildRuntime(guildId);
    const feature = provider === 'gemini' ? runtime.features.byokGemini : provider === 'groq' ? runtime.features.byokGroq : runtime.features.byokNvidia;
    if (!feature) throw new Error(`byok_${provider}_not_enabled`);
    const encryptedValue = this.secrets.encrypt(value.trim());
    const fingerprint = this.secrets.fingerprint(value.trim());
    await this.database.db.insert(guildCredentials).values({ guildId, provider, encryptedValue, fingerprint, validatedAt: new Date() })
      .onConflictDoUpdate({ target: [guildCredentials.guildId, guildCredentials.provider], set: { encryptedValue, fingerprint, validatedAt: new Date(), updatedAt: new Date() } });
    return { provider, fingerprint, validated: true };
  }

  async deleteCredential(guildId: string, provider: CredentialProvider) {
    await this.database.db.delete(guildCredentials).where(and(eq(guildCredentials.guildId, guildId), eq(guildCredentials.provider, provider)));
  }

  async listCredentials(guildId: string) {
    return this.database.db.select({ provider: guildCredentials.provider, fingerprint: guildCredentials.fingerprint, validatedAt: guildCredentials.validatedAt })
      .from(guildCredentials).where(eq(guildCredentials.guildId, guildId));
  }

  async getCredential(guildId: string, provider: CredentialProvider) {
    const row = await this.database.db.select().from(guildCredentials)
      .where(and(eq(guildCredentials.guildId, guildId), eq(guildCredentials.provider, provider))).limit(1);
    return row[0] ? this.secrets.decrypt(row[0].encryptedValue) : null;
  }

  async pickProviderKey(provider: 'gemini_paid' | 'gemini_private' | 'groq' | 'nvidia') {
    return this.database.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT id, encrypted_value, fingerprint
        FROM provider_keys
        WHERE provider = ${provider} AND enabled = true
          AND (cooldown_until IS NULL OR cooldown_until <= now())
        ORDER BY last_used_at NULLS FIRST, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const row = result.rows[0] as { id: string; encrypted_value: string; fingerprint: string } | undefined;
      if (!row) return null;
      await tx.update(providerKeys).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(providerKeys.id, row.id));
      return { id: row.id, value: this.secrets.decrypt(row.encrypted_value), fingerprint: row.fingerprint };
    });
  }

  async coolDownProviderKey(id: string, retryAfterMs: number) {
    const bounded = Math.min(Math.max(retryAfterMs, 1000), 60 * 60 * 1000);
    await this.database.db.update(providerKeys).set({ cooldownUntil: new Date(Date.now() + bounded), updatedAt: new Date() }).where(eq(providerKeys.id, id));
  }

  async reserveUsage(guildId: string, requestId: string, kind: UsageKind, units: number): Promise<UsageReservation | null> {
    if (!Number.isSafeInteger(units) || units <= 0) throw new Error('Usage units must be a positive safe integer');
    const runtime = await this.getGuildRuntime(guildId);
    if (runtime.planKind === 'private') return null;
    return this.database.db.transaction(async (tx) => {
      const cycle = await this.ensureUsageCycle(tx, runtime);
      const result = await tx.execute(sql`
        SELECT id, message_limit, credit_limit, messages_used, credits_used
        FROM usage_cycles WHERE id = ${cycle.id} FOR UPDATE
      `);
      const locked = result.rows[0] as { id: string; message_limit: number; credit_limit: string; messages_used: number; credits_used: string };
      const isMessage = kind === 'message';
      const used = isMessage ? locked.messages_used : Number(locked.credits_used);
      const limit = isMessage ? locked.message_limit : Number(locked.credit_limit);
      if (used + units > limit) return null;
      const id = randomUUID();
      await tx.insert(usageLedger).values({ id, guildId, cycleId: locked.id, requestId, kind, state: 'reserved', units });
      await tx.update(usageCycles).set(isMessage
        ? { messagesUsed: sql`${usageCycles.messagesUsed} + ${units}`, updatedAt: new Date() }
        : { creditsUsed: sql`${usageCycles.creditsUsed} + ${units}`, updatedAt: new Date() }
      ).where(eq(usageCycles.id, locked.id));
      return { id, requestId, kind, reservedUnits: units, cycleId: locked.id };
    });
  }

  async reconcileUsage(reservation: UsageReservation, actualUnits: number, commit: boolean) {
    const actual = Math.max(0, Math.min(Math.ceil(actualUnits), reservation.reservedUnits));
    await this.database.db.transaction(async (tx) => {
      const row = await tx.select().from(usageLedger).where(eq(usageLedger.id, reservation.id)).limit(1);
      if (!row[0] || row[0].state !== 'reserved') return;
      const refund = reservation.reservedUnits - (commit ? actual : 0);
      await tx.update(usageLedger).set({ state: commit ? 'committed' : 'released', units: commit ? actual : 0, committedAt: new Date() }).where(eq(usageLedger.id, reservation.id));
      if (refund > 0) {
        await tx.update(usageCycles).set(reservation.kind === 'message'
          ? { messagesUsed: sql`GREATEST(0, ${usageCycles.messagesUsed} - ${refund})`, updatedAt: new Date() }
          : { creditsUsed: sql`GREATEST(0, ${usageCycles.creditsUsed} - ${refund})`, updatedAt: new Date() }
        ).where(eq(usageCycles.id, reservation.cycleId));
      }
    });
  }

  async getUsage(guildId: string) {
    const runtime = await this.getGuildRuntime(guildId);
    if (runtime.planKind === 'private') return { unlimited: true, messagesUsed: 0, messageLimit: 0, creditsUsed: 0, creditLimit: 0 };
    return this.database.db.transaction(async (tx) => {
      const cycle = await this.ensureUsageCycle(tx, runtime);
      return {
        unlimited: false,
        startsAt: cycle.startsAt,
        endsAt: cycle.endsAt,
        messagesUsed: cycle.messagesUsed,
        messageLimit: cycle.messageLimit,
        creditsUsed: cycle.creditsUsed,
        creditLimit: cycle.creditLimit
      };
    });
  }

  async adjustUsage(guildId: string, input: { creditDelta?: number; messageDelta?: number; reason: string; actorId: string }) {
    const runtime = await this.getGuildRuntime(guildId);
    if (runtime.planKind === 'private') throw new Error('private_plan_has_unlimited_usage');
    await this.database.db.transaction(async (tx) => {
      const cycle = await this.ensureUsageCycle(tx, runtime);
      if (input.creditDelta) {
        await tx.update(usageCycles).set({ creditsUsed: sql`GREATEST(0, ${usageCycles.creditsUsed} + ${input.creditDelta})`, updatedAt: new Date() }).where(eq(usageCycles.id, cycle.id));
        await tx.insert(usageLedger).values({ guildId, cycleId: cycle.id, requestId: `admin:${randomUUID()}:credits`, kind: 'adjustment', state: 'committed', units: input.creditDelta, metadata: { reason: input.reason, actorId: input.actorId, target: 'credits' }, committedAt: new Date() });
      }
      if (input.messageDelta) {
        await tx.update(usageCycles).set({ messagesUsed: sql`GREATEST(0, ${usageCycles.messagesUsed} + ${input.messageDelta})`, updatedAt: new Date() }).where(eq(usageCycles.id, cycle.id));
        await tx.insert(usageLedger).values({ guildId, cycleId: cycle.id, requestId: `admin:${randomUUID()}:messages`, kind: 'adjustment', state: 'committed', units: input.messageDelta, metadata: { reason: input.reason, actorId: input.actorId, target: 'messages' }, committedAt: new Date() });
      }
    });
    return this.getUsage(guildId);
  }

  async listUsageReport(limit = 200) {
    return this.database.db.select({
      guildId: guilds.id,
      guildName: guilds.name,
      startsAt: usageCycles.startsAt,
      endsAt: usageCycles.endsAt,
      messagesUsed: usageCycles.messagesUsed,
      messageLimit: usageCycles.messageLimit,
      creditsUsed: usageCycles.creditsUsed,
      creditLimit: usageCycles.creditLimit
    }).from(usageCycles).innerJoin(guilds, eq(usageCycles.guildId, guilds.id))
      .orderBy(desc(usageCycles.startsAt)).limit(Math.min(Math.max(limit, 1), 500));
  }

  async createSession(user: { id: string; username: string; avatar?: string | null }, tokens: { accessToken: string; refreshToken?: string; tokenExpiresAt: Date }, csrfToken: string, expiresAt: Date) {
    await this.database.db.insert(users).values({ id: user.id, username: user.username, avatar: user.avatar ?? null })
      .onConflictDoUpdate({ target: users.id, set: { username: user.username, avatar: user.avatar ?? null, updatedAt: new Date() } });
    const row = await this.database.db.insert(sessions).values({
      userId: user.id,
      csrfToken,
      encryptedAccessToken: this.secrets.encrypt(tokens.accessToken),
      encryptedRefreshToken: tokens.refreshToken ? this.secrets.encrypt(tokens.refreshToken) : null,
      tokenExpiresAt: tokens.tokenExpiresAt,
      expiresAt
    }).returning();
    return row[0]!;
  }

  async getSession(id: string) {
    const rows = await this.database.db.select({ session: sessions, user: users }).from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()))).limit(1);
    return rows[0] ?? null;
  }

  decryptSessionAccessToken(value: string) {
    return this.secrets.decrypt(value);
  }

  decryptSessionRefreshToken(value: string | null) {
    return value ? this.secrets.decrypt(value) : null;
  }

  async updateSessionTokens(id: string, tokens: { accessToken: string; refreshToken?: string; tokenExpiresAt: Date }) {
    await this.database.db.update(sessions).set({
      encryptedAccessToken: this.secrets.encrypt(tokens.accessToken),
      ...(tokens.refreshToken ? { encryptedRefreshToken: this.secrets.encrypt(tokens.refreshToken) } : {}),
      tokenExpiresAt: tokens.tokenExpiresAt
    }).where(eq(sessions.id, id));
  }

  async listAdminProviderKeys() {
    return this.database.db.select({
      id: providerKeys.id,
      provider: providerKeys.provider,
      label: providerKeys.label,
      fingerprint: providerKeys.fingerprint,
      enabled: providerKeys.enabled,
      cooldownUntil: providerKeys.cooldownUntil,
      lastUsedAt: providerKeys.lastUsedAt
    }).from(providerKeys).orderBy(asc(providerKeys.provider), asc(providerKeys.label));
  }

  async addProviderKey(provider: 'gemini_paid' | 'gemini_private' | 'groq' | 'nvidia', label: string, value: string) {
    const row = await this.database.db.insert(providerKeys).values({
      provider,
      label,
      encryptedValue: this.secrets.encrypt(value.trim()),
      fingerprint: this.secrets.fingerprint(value.trim())
    }).returning();
    const inserted = row[0]!;
    return { id: inserted.id, provider: inserted.provider, label: inserted.label, fingerprint: inserted.fingerprint };
  }

  async updateProviderKey(id: string, patch: {
    provider?: 'gemini_paid' | 'gemini_private' | 'groq' | 'nvidia';
    label?: string;
    enabled?: boolean;
    value?: string;
  }) {
    const current = await this.database.db.select().from(providerKeys).where(eq(providerKeys.id, id)).limit(1);
    if (!current[0]) throw new Error('provider_key_not_found');
    const values = {
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.value !== undefined ? {
        encryptedValue: this.secrets.encrypt(patch.value.trim()),
        fingerprint: this.secrets.fingerprint(patch.value.trim()),
        cooldownUntil: null
      } : {}),
      updatedAt: new Date()
    };
    const rows = await this.database.db.update(providerKeys).set(values).where(eq(providerKeys.id, id)).returning();
    const updated = rows[0]!;
    return {
      id: updated.id,
      provider: updated.provider,
      label: updated.label,
      fingerprint: updated.fingerprint,
      enabled: updated.enabled,
      cooldownUntil: updated.cooldownUntil,
      lastUsedAt: updated.lastUsedAt
    };
  }

  async deleteProviderKey(id: string) {
    const row = await this.database.db.delete(providerKeys).where(eq(providerKeys.id, id)).returning({ id: providerKeys.id });
    if (!row[0]) throw new Error('provider_key_not_found');
  }

  async setGuildPlan(guildId: string, planId: string) {
    await this.database.db.update(guilds).set({ planId, privateAssigned: false, updatedAt: new Date() }).where(eq(guilds.id, guildId));
    await this.notifyGuild(guildId);
  }

  async getSubscription(guildId: string) {
    const row = await this.database.db.select().from(subscriptions).where(eq(subscriptions.guildId, guildId)).limit(1);
    return row[0] ?? null;
  }

  async syncStripeSubscription(input: {
    eventId: string;
    eventType: string;
    guildId: string;
    planId: string;
    customerId: string;
    subscriptionId: string;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    eventCreated: number;
  }) {
    const processed = await this.database.db.transaction(async (tx) => {
      const event = await tx.insert(stripeEvents).values({ id: input.eventId, type: input.eventType }).onConflictDoNothing().returning();
      if (!event[0]) return false;
      const current = await tx.execute(sql`SELECT last_event_created FROM subscriptions WHERE guild_id = ${input.guildId} FOR UPDATE`);
      const lastEventCreated = Number((current.rows[0] as { last_event_created?: string } | undefined)?.last_event_created ?? 0);
      if (lastEventCreated > input.eventCreated) return false;
      const entitled = input.status === 'active' || input.status === 'trialing';
      await tx.insert(subscriptions).values({
        guildId: input.guildId,
        planId: input.planId,
        stripeCustomerId: input.customerId,
        stripeSubscriptionId: input.subscriptionId,
        status: input.status,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        lastEventCreated: input.eventCreated
      }).onConflictDoUpdate({ target: subscriptions.guildId, set: {
        planId: input.planId,
        stripeCustomerId: input.customerId,
        stripeSubscriptionId: input.subscriptionId,
        status: input.status,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        lastEventCreated: input.eventCreated,
        updatedAt: new Date()
      } });
      if (entitled) await tx.update(guilds).set({ planId: input.planId, updatedAt: new Date() }).where(eq(guilds.id, input.guildId));
      if (!entitled) {
        const free = await tx.select().from(plans).where(eq(plans.slug, 'free')).limit(1);
        if (free[0]) await tx.update(guilds).set({ planId: free[0].id, updatedAt: new Date() }).where(and(eq(guilds.id, input.guildId), eq(guilds.privateAssigned, false)));
      }
      return true;
    });
    if (processed) await this.notifyGuild(input.guildId);
    return processed;
  }

  async deleteSession(id: string) {
    await this.database.db.delete(sessions).where(eq(sessions.id, id));
  }

  async listPlans(includeUnpublished = false) {
    const conditions = includeUnpublished ? undefined : and(eq(plans.published, true), eq(plans.archived, false));
    return this.database.db.select().from(plans).where(conditions).orderBy(asc(plans.sortOrder));
  }

  async upsertPlan(input: { id?: string; slug: string; name: string; kind: 'free' | 'paid' | 'private'; description?: string; features: unknown; stripePriceId?: string | null; stripeProductId?: string | null; priceAmount?: number | null; priceCurrency?: string; published?: boolean; archived?: boolean; sortOrder?: number }) {
    const values = {
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      description: input.description ?? '',
      features: parsePlanFeatures(input.kind === 'paid' ? { ...PAID_FEATURES, ...(input.features as Record<string, unknown>) } : input.features),
      stripePriceId: input.stripePriceId ?? null,
      stripeProductId: input.stripeProductId ?? null,
      priceAmount: input.priceAmount ?? null,
      priceCurrency: input.priceCurrency ?? 'eur',
      published: input.published ?? false,
      archived: input.archived ?? false,
      sortOrder: input.sortOrder ?? 0,
      updatedAt: new Date()
    };
    if (input.id) {
      const result = await this.database.db.update(plans).set(values).where(eq(plans.id, input.id)).returning();
      if (!result[0]) throw new Error('plan_not_found');
      this.cache.clear();
      await this.database.pool.query("SELECT pg_notify('giada_plan_config', $1)", [input.slug]);
      return result[0];
    }
    const result = await this.database.db.insert(plans).values(values).returning();
    await this.database.pool.query("SELECT pg_notify('giada_plan_config', $1)", [input.slug]);
    return result[0]!;
  }

  async assignPrivate(guildId: string, assigned: boolean) {
    const row = await this.database.db.update(guilds).set({ privateAssigned: assigned, updatedAt: new Date() }).where(eq(guilds.id, guildId)).returning({ id: guilds.id });
    if (!row[0]) throw new Error('guild_not_found');
    await this.notifyGuild(guildId);
    return { guildId, privateAssigned: assigned };
  }

  async listPrivateGuilds() {
    return this.database.db.select({
      id: guilds.id,
      name: guilds.name,
      icon: guilds.icon,
      privateAssigned: guilds.privateAssigned,
      basePlanSlug: plans.slug,
      updatedAt: guilds.updatedAt
    }).from(guilds)
      .leftJoin(plans, eq(guilds.planId, plans.id))
      .where(eq(guilds.privateAssigned, true))
      .orderBy(asc(guilds.name));
  }

  private async seedSystemPlans() {
    await this.database.db.insert(plans).values([
      { slug: 'free', name: 'Free', kind: 'free', description: 'Shared Groq text access', features: FREE_FEATURES, published: true, sortOrder: 0 },
      { slug: 'private', name: 'Private', kind: 'private', description: 'Owner-assigned Gemini Live access', features: PRIVATE_FEATURES, published: false, sortOrder: 10_000 }
    ]).onConflictDoNothing({ target: plans.slug });
  }

  private async getPlanBySlug(slug: string) {
    const row = await this.database.db.select().from(plans).where(eq(plans.slug, slug)).limit(1);
    if (!row[0]) throw new Error(`Missing system plan: ${slug}`);
    return row[0];
  }

  private async ensureGuildSettings(guildId: string) {
    await this.database.db.insert(guildSettings).values({
      guildId,
      settings: guildSettingsSchema.parse({}),
      personality: guildPersonalitySchema.parse(defaultGuildPersonality())
    }).onConflictDoNothing({ target: guildSettings.guildId });
  }

  private async notifyGuild(guildId: string) {
    this.cache.delete(guildId);
    await this.database.pool.query('SELECT pg_notify($1, $2)', ['giada_guild_config', guildId]);
  }

  private async ensureUsageCycle(tx: Parameters<Parameters<typeof this.database.db.transaction>[0]>[0], runtime: GuildRuntimeConfig) {
    const subscription = await tx.select().from(subscriptions).where(eq(subscriptions.guildId, runtime.guildId)).limit(1);
    const now = new Date();
    const activeSubscription = subscription[0]
      && ['active', 'trialing'].includes(subscription[0].status)
      && subscription[0].currentPeriodEnd > now
      ? subscription[0]
      : null;
    const guild = await tx.select({ activatedAt: guilds.activatedAt }).from(guilds).where(eq(guilds.id, runtime.guildId)).limit(1);
    const freeCycle = cycleContaining(guild[0]?.activatedAt ?? now, now);
    const startsAt = activeSubscription?.currentPeriodStart ?? freeCycle.startsAt;
    const endsAt = activeSubscription?.currentPeriodEnd ?? freeCycle.endsAt;
    const existing = await tx.select().from(usageCycles).where(and(
      eq(usageCycles.guildId, runtime.guildId),
      lte(usageCycles.startsAt, now),
      gt(usageCycles.endsAt, now)
    )).limit(1);
    if (existing[0]) return existing[0];
    const inserted = await tx.insert(usageCycles).values({
      guildId: runtime.guildId,
      startsAt,
      endsAt,
      messageLimit: runtime.features.monthlyMessages,
      creditLimit: runtime.features.monthlyCredits
    }).onConflictDoNothing().returning();
    if (inserted[0]) return inserted[0];
    const raced = await tx.select().from(usageCycles).where(and(eq(usageCycles.guildId, runtime.guildId), eq(usageCycles.startsAt, startsAt))).limit(1);
    if (!raced[0]) throw new Error('Could not initialize usage cycle');
    return raced[0];
  }
}

function defaultGuildPersonality(): GuildPersonality {
  const { revision: _revision, ...profile } = personalitySchema.parse({});
  return guildPersonalitySchema.parse({ ...profile, customInstructions: '' });
}

function nextMonth(date: Date) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function cycleContaining(anchor: Date, now: Date) {
  let startsAt = new Date(anchor);
  let endsAt = nextMonth(startsAt);
  while (endsAt <= now) {
    startsAt = endsAt;
    endsAt = nextMonth(startsAt);
  }
  return { startsAt, endsAt };
}

export function personalityProfileFromGuild(profile: GuildPersonality): PersonalityProfile {
  return personalitySchema.parse({ ...profile, revision: 0 });
}

export function personalityProfileForRuntime(runtime: GuildRuntimeConfig): { profile: PersonalityProfile; customInstructions: string } {
  if (runtime.features.customPersonality) {
    return { profile: personalityProfileFromGuild(runtime.personality), customInstructions: runtime.personality.customInstructions };
  }
  return { profile: personalitySchema.parse({}), customInstructions: '' };
}

function mapMemory(row: typeof memoriesV2.$inferSelect): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    summary: row.summary,
    tags: row.tags,
    source: row.source as MemoryRecord['source'],
    privacy: row.privacy as MemoryRecord['privacy'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null
  };
}
