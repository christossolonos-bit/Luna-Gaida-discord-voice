# Architecture

## Process Split

Desktop frontend:

- renders UI and VRM avatar
- captures microphone through `getUserMedia`
- captures screen/window through `getDisplayMedia`
- plays PCM audio returned by the backend
- invokes narrow Tauri commands only

Tauri Rust core:

- owns native window configuration
- validates privileged IPC payloads
- restricts file access to app data/config/cache/assets
- denies privileged commands from the floating avatar window

Backend:

- owns `.env` secrets
- connects to Gemini Live API
- executes tool calls manually
- stores memory/personality in SQLite
- enforces privacy classes
- hosts plugin modules such as Discord
- serves the authenticated React management dashboard
- keeps PostgreSQL as the authority for guild configuration, plans, subscriptions, encrypted BYOK credentials, scoped memory, and usage ledgers

## Module Map

- `apps/server/src/live`: Gemini Live session manager.
- `apps/server/src/memory`: SQLite memory repository.
- `apps/server/src/personality`: bounded persisted profile.
- `apps/server/src/policy`: privacy classification and redaction.
- `apps/server/src/tools`: Live API tool declarations and handlers.
- `apps/server/src/plugins`: addon/plugin interface.
- `apps/server/src/plugins/discord`: Discord text/voice foundation.
- `apps/server/src/platform`: PostgreSQL schema, plan entitlements, encryption, subscriptions, and transactional usage accounting.
- `apps/server/src/providers`: per-guild provider routing and Groq key rotation.
- `apps/server/src/web`: Discord OAuth, Stripe, guild, and owner administration APIs.
- `apps/web`: browser dashboard and paid browser chat surface.
- `apps/server/src/ws`: desktop realtime bridge.
- `apps/desktop/src/components`: React UI and VRM stage.
- `apps/desktop/src/lib`: realtime, audio, permissions, VRM helpers.
- `apps/desktop/src-tauri/src`: validated native commands.

## Realtime Event Flow

1. Desktop sends text/audio/video events to `/realtime`.
2. Backend forwards them to Gemini Live API.
3. Gemini messages are transformed into audio/transcript/avatar events.
4. Tool calls run through the backend registry.
5. Memory/personality/policy are shared by desktop and Discord surfaces.

## Why Server-To-Server

Google documents client-to-server Live API with ephemeral tokens as lower-latency, but this project requires strict secret isolation, shared memory, Discord, policy, and tool orchestration. Server-to-server keeps all keys and tool execution behind the backend.
