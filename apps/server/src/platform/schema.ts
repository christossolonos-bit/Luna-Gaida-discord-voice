import { bigint, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { GuildPersonality, GuildSettings } from './types.js';
import type { PlanFeatures } from './features.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
};

export const users = pgTable('app_users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  avatar: text('avatar'),
  ...timestamps
});

export const sessions = pgTable('web_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  csrfToken: text('csrf_token').notNull(),
  encryptedAccessToken: text('encrypted_access_token').notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [index('web_sessions_user_idx').on(table.userId)]);

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['free', 'paid', 'private'] }).notNull(),
  description: text('description').notNull().default(''),
  features: jsonb('features').$type<PlanFeatures>().notNull(),
  stripeProductId: text('stripe_product_id'),
  stripePriceId: text('stripe_price_id'),
  priceAmount: integer('price_amount'),
  priceCurrency: text('price_currency').notNull().default('eur'),
  sortOrder: integer('sort_order').notNull().default(0),
  published: boolean('published').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  ...timestamps
});

export const guilds = pgTable('guilds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  icon: text('icon'),
  planId: uuid('plan_id').references(() => plans.id),
  privateAssigned: boolean('private_assigned').notNull().default(false),
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestamps
});

export const guildSettings = pgTable('guild_settings_v2', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<GuildSettings>().notNull(),
  personality: jsonb('personality').$type<GuildPersonality>().notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const voiceChangerProfiles = pgTable('voice_changer_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  ffmpegFilter: text('ffmpeg_filter').notNull(),
  createdBy: text('created_by'),
  ...timestamps
}, (table) => [uniqueIndex('voice_changer_profiles_guild_name_idx').on(table.guildId, table.name)]);

export const guildCredentials = pgTable('guild_credentials', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  provider: text('provider', { enum: ['gemini', 'groq', 'nvidia'] }).notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  fingerprint: text('fingerprint').notNull(),
  validatedAt: timestamp('validated_at', { withTimezone: true }),
  ...timestamps
}, (table) => [primaryKey({ columns: [table.guildId, table.provider] })]);

export const providerKeys = pgTable('provider_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider', { enum: ['gemini_paid', 'gemini_private', 'groq', 'nvidia'] }).notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  fingerprint: text('fingerprint').notNull(),
  label: text('label').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  ...timestamps
}, (table) => [index('provider_keys_pick_idx').on(table.provider, table.enabled, table.cooldownUntil, table.lastUsedAt)]);

export const subscriptions = pgTable('subscriptions', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id').notNull().references(() => plans.id),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  status: text('status').notNull(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  lastEventCreated: bigint('last_event_created', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const usageCycles = pgTable('usage_cycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  messageLimit: integer('message_limit').notNull(),
  creditLimit: bigint('credit_limit', { mode: 'number' }).notNull(),
  messagesUsed: integer('messages_used').notNull().default(0),
  creditsUsed: bigint('credits_used', { mode: 'number' }).notNull().default(0),
  ...timestamps
}, (table) => [uniqueIndex('usage_cycles_guild_start_idx').on(table.guildId, table.startsAt)]);

export const usageLedger = pgTable('usage_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  cycleId: uuid('cycle_id').notNull().references(() => usageCycles.id, { onDelete: 'cascade' }),
  requestId: text('request_id').notNull(),
  kind: text('kind', { enum: ['message', 'text_credit', 'voice_credit', 'adjustment'] }).notNull(),
  state: text('state', { enum: ['reserved', 'committed', 'released'] }).notNull(),
  units: bigint('units', { mode: 'number' }).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp('committed_at', { withTimezone: true })
}, (table) => [
  uniqueIndex('usage_ledger_request_kind_idx').on(table.requestId, table.kind),
  index('usage_ledger_guild_idx').on(table.guildId, table.createdAt)
]);

export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow()
});

export const memoriesV2 = pgTable('memories_v2', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type', { enum: ['owner', 'guild'] }).notNull(),
  scopeId: text('scope_id').notNull(),
  content: text('content').notNull(),
  summary: text('summary'),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  source: text('source').notNull(),
  privacy: text('privacy').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  ...timestamps
}, (table) => [index('memories_v2_scope_idx').on(table.scopeType, table.scopeId, table.updatedAt)]);
