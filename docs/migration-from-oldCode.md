# Migration And Reuse Notes

The previous implementation lives in `oldCode/` in this repository.

Reused:

- `.env` key names: `GEMINI_API_KEY`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`.
- VRM models except the old nude model, which is excluded from the default new asset set.
- Mixamo animations: `Idle`, `Angry`, `Listening To Music`, `Sitting Idle`, `Spin In Place`.
- Mixamo-to-VRM rig mapping.
- Lip-sync approach based on analysing PCM output.
- Gemini Live settings patterns: `v1alpha`, audio output, affective dialog, proactive audio, Google Search, manual tool calling, transcription.
- Discord attachment/image handling concepts.

Changed:

- API keys are no longer exposed to the renderer through Tauri IPC.
- Memory is no longer a single text file; it is structured SQLite with source and privacy class.
- Personality is persisted separately and bounded by schema.
- Tool calls are executed in the backend with policy checks.
- Tauri commands validate paths/URLs/window roles and do not expose broad filesystem or shell access.

Not copied:

- `get_environment_variable` command from old Rust code.
- frontend-owned Gemini client.
- broad transparent always-on-top single-window-only UI shape.
- old generated/mobile artifacts and build output.
