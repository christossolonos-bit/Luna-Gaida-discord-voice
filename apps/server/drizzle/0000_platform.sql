CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY, username text NOT NULL, avatar text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS web_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL, encrypted_access_token text NOT NULL, encrypted_refresh_token text,
  token_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_sessions_user_idx ON web_sessions(user_id);

CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('free','paid','private')), description text NOT NULL DEFAULT '',
  features jsonb NOT NULL, stripe_product_id text, stripe_price_id text, price_amount integer,
  price_currency text NOT NULL DEFAULT 'eur', sort_order integer NOT NULL DEFAULT 0,
  published boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guilds (
  id text PRIMARY KEY, name text NOT NULL, icon text, plan_id uuid REFERENCES plans(id),
  private_assigned boolean NOT NULL DEFAULT false, activated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_settings_v2 (
  guild_id text PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE, settings jsonb NOT NULL,
  personality jsonb NOT NULL, updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_credentials (
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gemini','groq','nvidia')),
  encrypted_value text NOT NULL, fingerprint text NOT NULL, validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, provider)
);
CREATE TABLE IF NOT EXISTS provider_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('gemini_paid','gemini_private','groq','nvidia')),
  encrypted_value text NOT NULL, fingerprint text NOT NULL, label text NOT NULL,
  enabled boolean NOT NULL DEFAULT true, cooldown_until timestamptz, last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_keys_pick_idx ON provider_keys(provider, enabled, cooldown_until, last_used_at);
CREATE TABLE IF NOT EXISTS subscriptions (
  guild_id text PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE, plan_id uuid NOT NULL REFERENCES plans(id),
  stripe_customer_id text NOT NULL, stripe_subscription_id text NOT NULL UNIQUE, status text NOT NULL,
  current_period_start timestamptz NOT NULL, current_period_end timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false, last_event_created bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, message_limit integer NOT NULL,
  credit_limit bigint NOT NULL, messages_used integer NOT NULL DEFAULT 0, credits_used bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, starts_at)
);
CREATE TABLE IF NOT EXISTS usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  cycle_id uuid NOT NULL REFERENCES usage_cycles(id) ON DELETE CASCADE, request_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('message','text_credit','voice_credit','adjustment')),
  state text NOT NULL CHECK (state IN ('reserved','committed','released')), units bigint NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz,
  UNIQUE (request_id, kind)
);
CREATE INDEX IF NOT EXISTS usage_ledger_guild_idx ON usage_ledger(guild_id, created_at);
CREATE TABLE IF NOT EXISTS stripe_events (
  id text PRIMARY KEY, type text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memories_v2 (
  id text PRIMARY KEY, scope_type text NOT NULL CHECK (scope_type IN ('owner','guild')), scope_id text NOT NULL,
  content text NOT NULL, summary text, tags jsonb NOT NULL DEFAULT '[]', source text NOT NULL,
  privacy text NOT NULL, expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_v2_scope_idx ON memories_v2(scope_type, scope_id, updated_at);
