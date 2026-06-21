CREATE TABLE IF NOT EXISTS voice_changer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name text NOT NULL,
  ffmpeg_filter text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_changer_profiles_guild_name_idx
  ON voice_changer_profiles(guild_id, name);
