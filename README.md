# Giada Companion

Production-oriented foundation for a Tauri v2 desktop AI companion with a VRM avatar, realtime Gemini Live API bridge, shared memory/personality, Discord addon module, and a narrow native command surface.

## What Is Implemented

- Tauri v2 desktop shell with two windows:
  - `main`: full control panel, permissions, transcript, avatar preview.
  - `avatar`: transparent always-on-top floating avatar window with fewer Tauri permissions.
- React + TypeScript frontend with:
  - VRM loading from reused legacy models.
  - Mixamo animation mapping for `idle`, `listening`, `thinking`, `speaking`, `reacting`.
  - analyser-driven lip sync for Gemini PCM audio.
  - blink and expression state updates.
  - microphone, text chat, passive mode, interrupt, and browser/WebView screen sharing controls.
- Node/TypeScript backend with:
  - Gemini Live API server-to-server session manager.
  - WebSocket bridge at `ws://127.0.0.1:8787/realtime`.
  - SQLite-backed memory store.
  - persisted bounded personality profile.
  - public/private/secret policy layer and Discord redaction.
  - modular plugin manager and Discord text/voice presence plugin.
- Rust/Tauri security commands:
  - read/write/list files only under app data/config/cache/assets.
  - allowlisted URL opening.
  - desktop notification request bridge.
  - clipboard and screenshot gates.
  - explicit denial for privileged commands from the floating avatar window.

## Setup

1. Install Node 22+, Rust, and Tauri v2 Linux/macOS/Windows prerequisites.
2. Copy `.env.example` to `.env` and fill backend-only secrets.
3. Install dependencies:

```bash
npm install
```

4. Start the backend:

```bash
npm run dev --workspace @giada/server
```

5. Start Tauri:

```bash
npm run tauri:dev --workspace @giada/desktop
```

## Docker Compose

The Docker setup runs the backend, PostgreSQL, the web dashboard, and a private SearXNG instance for the `searchWeb` tool. PostgreSQL is authoritative for guild settings, plans, encrypted credentials, subscriptions, scoped memory, and usage. The legacy SQLite file remains only for local desktop compatibility during migration.

Before starting, set `GIADA_MASTER_KEY`, Discord OAuth values, `GIADA_OWNER_DISCORD_USER_ID`, Stripe values, and a non-default `POSTGRES_PASSWORD` in `.env.docker`. Generate the master key with `openssl rand -base64 32`. Configure the Discord OAuth callback as `https://YOUR_HOST/api/auth/discord/callback` and the Stripe webhook as `https://YOUR_HOST/api/billing/webhook`.

The dashboard is served at the backend origin. Free guilds can manage settings, paid guilds can additionally use browser chat, and only `GIADA_OWNER_DISCORD_USER_ID` can manage plans, shared provider keys, usage, and Private guild assignments.

LLM API keys are never loaded from environment variables. After the first owner login, open **Administration → Shared provider keys** and add one or more Groq keys, Gemini Live paid/private keys, and an NVIDIA NIM key. They are encrypted before being stored in PostgreSQL. Guild BYOK credentials are managed separately under each guild's **Providers** page.

After configuring PostgreSQL, copy existing SQLite memories into the isolated owner scope once with:

```bash
npm run migrate:legacy --workspace @giada/server
```

The migration is idempotent by legacy memory ID. Existing Discord memories are deliberately not assigned to any guild because the old schema did not reliably record guild ownership.

Build the backend image:

```bash
docker compose build giada
```

Run the backend and SearXNG:

```bash
docker compose up -d
```

Follow logs:

```bash
docker compose logs -f giada
```

The backend is exposed on `http://localhost:8787`, and SQLite data is stored in `./data` through a bind mount. To build the image without Compose:

```bash
docker build -t giada-assistant:latest .
```

## Gemini Live API

The backend uses the official server-to-server Live API pattern so the Gemini API key never enters frontend code. The current default model is `gemini-live-2.5-flash-native-audio`; set `GEMINI_MODEL` to a different officially supported Live model if needed.

Implemented config:

- audio output via `responseModalities: [AUDIO]`
- raw PCM mic input forwarding
- JPEG screen frame forwarding
- text input
- tool declarations and manual tool responses
- input/output transcription hooks
- affective dialog
- proactive audio
- safety thresholds set to `OFF` where the SDK/provider allows it

Provider-enforced limits still apply. As of Google’s Live API docs, Live API is preview, uses 16-bit PCM 16 kHz input, 24 kHz PCM output, JPEG images up to 1 FPS, and provider safety/rate/model availability constraints cannot be bypassed by application code.

Official docs:

- https://ai.google.dev/gemini-api/docs/live-api
- https://ai.google.dev/gemini-api/docs/live-api/tools

## Discord

The Discord plugin uses the shared personality, public Discord-safe memory, and policy redaction. Discord text and voice requests are handled through separate Live request paths so channel chat and voice chat do not share a request queue.

Slash commands:

- `/giada help` - show Discord commands.
- `/giada listen mode:here` - set the current text channel as the observed channel; Giada decides when a reply is useful.
- `/giada listen mode:off` - disable always-listen mode; other channels require her name or a bot mention.
- `/giada voice mode:watch` - watch your current voice channel, join when someone enters, and leave after everyone leaves.
- `/giada voice mode:off` - disable voice watching.
- `/giada voice mode:join` - join your current voice channel now.
- `/giada status` - show current Discord settings.
- `/giada authorize user:@user` - allow a user to run Giada commands. Discord Administrator or owner only.
- `/giada deauthorize user:@user` - remove a user's Giada command authorization. Discord Administrator or owner only.

Running slash commands requires Discord Administrator permission, explicit authorization through `/giada authorize`, or the built-in owner bypass.

When Giada is connected and ready in a voice channel, she also watches that voice channel's built-in text chat. Messages there, and direct pings while she is connected to voice, are answered through the active voice connection instead of Discord text replies.

When asked in Discord voice, Giada can search for and play music through the Live API tools `playSong`, `pauseMusic`, `resumeMusic`, `stopMusic`, `seekMusic`, `setMusicVolume`, and `getMusicStatus`. Playback uses local `yt-dlp` to resolve YouTube results and local `ffmpeg` to decode audio into the existing Discord PCM voice path, so install both commands on the backend host. Music is mixed with assistant speech and automatically ducked while Giada talks. Optional `.env` tuning:

```bash
YTDLP_BINARY=yt-dlp
YTDLP_PLAYER_CLIENTS=default
YTDLP_JS_RUNTIME=deno
YTDLP_REMOTE_COMPONENTS=ejs:github
YTDLP_POT_PROVIDER_URL=http://127.0.0.1:4416
# Optional, useful when YouTube blocks anonymous media downloads:
YTDLP_COOKIES_PATH=/path/to/youtube-cookies.txt
# or:
YTDLP_COOKIES_FROM_BROWSER=firefox
FFMPEG_BINARY=ffmpeg
DISCORD_MUSIC_VOLUME=0.35
DISCORD_MUSIC_DUCK_VOLUME=0.12
DISCORD_VOICE_CHANGER_CONFIG=./config/voice-changer.json
```

Discord, browser, and desktop-app voice output pass Giada's generated speech (not music) through the FFmpeg filter in `config/voice-changer.json`. The default enabled `anime-girl` preset raises pitch, brightens the voice, and applies light compression while preserving approximate speaking speed. Set `enabled` to `false` for bypass mode, or replace `ffmpegFilter` with any filter chain supported by the installed FFmpeg build. The file is polled once per second and hot reloaded without reconnecting. If the file or filter is invalid, Giada logs the error and falls back to unmodified speech.

For Docker/server deployments, export YouTube cookies in Netscape `cookies.txt` format on a machine where YouTube works, then copy them to:

```text
./secrets/youtube-cookies.txt
```

`compose.yml` mounts that directory read-only and sets `YTDLP_COOKIES_PATH=/run/secrets/youtube-cookies.txt` inside the container. Giada copies it to private writable runtime storage because yt-dlp rewrites its cookie jar after use; the host secret remains read-only. Create the file before starting the container, restrict its host permissions (for example `chmod 600 secrets/youtube-cookies.txt`), and never commit it. Do not use `YTDLP_COOKIES_FROM_BROWSER` in Docker unless that browser profile is deliberately mounted into the container. YouTube cookies expire or may be invalidated, so repeat the export when anti-bot errors return.

Compose also runs an internal `bgutil-provider` service and installs its yt-dlp plugin to generate the per-video GVS PO tokens increasingly required by YouTube. The provider is exposed only to the internal Compose network; no host port is published. Native deployments can run the provider separately and set `YTDLP_POT_PROVIDER_URL` to its base URL.

To verify the provider from inside Compose, include its internal URL explicitly:

```bash
docker compose exec giada yt-dlp -v --simulate \
  --extractor-args "youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416" \
  "https://www.youtube.com/watch?v=ayVuQLT00v0"
```

Discord bot voice video or Go Live stream viewing is not implemented because the official discord.js/@discordjs/voice bot stack used here exposes voice audio receive/send, not supported video stream capture for bots.

Slash command delivery is supported in two modes:

- Gateway mode: leave the Discord Developer Portal Interactions Endpoint URL empty and keep the backend bot process running.
- HTTP endpoint mode: set the Developer Portal Interactions Endpoint URL to a public tunnel for `POST /interactions` or `POST /discord/interactions`, and set `DISCORD_PUBLIC_KEY` in `.env`.

Command definitions use discord.js `SlashCommandBuilder`, and deployment uses discord.js `REST`/`Routes` on backend startup or through the local registration endpoint.

Discord process sharding is opt-in. Enable it when the bot is large enough to need gateway sharding:

```bash
DISCORD_SHARDING_ENABLED=true
# auto asks Discord for the recommended shard count.
DISCORD_SHARD_COUNT=auto
DISCORD_SHARD_RESPAWN=true
```

When sharding is enabled, the HTTP server runs as the parent process and spawns Discord gateway shard workers. Use gateway slash-command delivery in this mode: leave the Discord Developer Portal Interactions Endpoint URL empty. HTTP interaction endpoint mode is intentionally unavailable with process sharding because the parent process does not own a guild-cached Discord client.

Local diagnostics:

```bash
curl http://127.0.0.1:8787/discord/status
curl -X POST http://127.0.0.1:8787/discord/register-commands
```

Discord GIF replies use a configured GIF API instead of model-selected Google Search results. Set one or both of these optional `.env` values:

```bash
GIF_PROVIDER=auto # auto, giphy, or tenor
GIPHY_API_KEY=your_giphy_key
TENOR_API_KEY=your_tenor_key
TENOR_CLIENT_KEY=giada-assistant
```

If `/giada` times out and neither `Received Discord slash command` nor `Received Discord HTTP interaction` appears in the backend logs, Discord is not sending interactions to this process. Check that the bot token belongs to the same Discord application whose `/giada` command you are using, and either clear the Developer Portal Interactions Endpoint URL for gateway mode or point it at a public tunnel for this backend.

## Development Checks

```bash
npm run typecheck --workspace @giada/server
npm run typecheck --workspace @giada/desktop
npm run test --workspace @giada/server
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

On this machine, Rust/Tauri verification is blocked until Linux Tauri system packages are installed, starting with `libdbus-1-dev` and `pkg-config`.

## Security Posture

Secrets live in the backend process only. The frontend talks to the backend over localhost WebSocket/HTTP and invokes only narrow Tauri commands.

No arbitrary shell command exists. File commands reject absolute paths, parent traversal, and non-approved roots. The avatar window is intentionally lower privilege and runtime-denied from admin/native commands.

See [Threat Model](docs/threat-model.md) for details.
