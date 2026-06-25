# Luna

Hi, darling. I'm **Luna** — your voice in Discord.

I join your voice channel, listen when you speak, and answer out loud. No cloud voice APIs required for the core experience: speech runs through **faster-whisper**, my voice is **XTTS** (Serafina), and replies come from a local **Ollama** model. I remember who you are, who else is in the call, and what we talked about — so if someone asks *"what did they say?"*, I usually know.

This repository is the Luna Discord voice stack built on the Giada Assistant foundation.

## What I can do

- Join Discord voice with `/giada voice mode:join` (or watch a channel with `mode:watch`)
- Hear you in **push-to-talk** or automatic mode
- Reply in character with short, spoken answers
- Remember each caller across sessions (bullet notes per user)
- Keep context across everyone in the same voice call — who's present, who spoke, what they asked
- Show a live monitor at `http://127.0.0.1:8787/monitor` while the server runs

## Quick start (Windows)

1. Install **Node 22+**, **Python 3.10+**, **FFmpeg**, and **Ollama** with your chat model (e.g. `qwen3.5:4b`).
2. Copy `.env.example` to `.env` and fill in your Discord bot token and IDs. **Never commit `.env`** — it's gitignored.
3. Put your XTTS reference voice file in `voices/` (see `XTTS_SPEAKER_WAV` in `.env.example`).
4. Install and run:

```bat
npm install
start-luna.bat
```

5. Optional: `start-luna-monitor.bat` opens the monitor UI.
6. In Discord: `/giada voice mode:join` while you're in a voice channel.

## Key settings

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Your Discord bot |
| `GIADA_VOICE_PROVIDER=local` | Use local STT/TTS instead of Gemini Live |
| `GROQ_MODEL` | Ollama model name for replies |
| `LUNA_VOICE_INPUT_MODE=ptt` | Push-to-talk (`auto` for open mic) |
| `LUNA_USER_VOICE_MEMORY=true` | Remember callers over time |
| `XTTS_SPEAKER_WAV` | Path to my voice reference clip |

See `.env.example` for the full list.

## Python voice worker

The local voice daemon (`scripts/local_voice_service.py`) needs Python packages for faster-whisper and Coqui TTS. Install them in your Python environment before first run.

## Commands

- `/giada voice mode:join` — join your current voice channel
- `/giada voice mode:watch` — auto-join when someone enters a watched channel
- `/giada voice mode:off` — stop watching
- `/giada status` — current settings

## License

Apache-2.0 — see [LICENSE](LICENSE).

---

*Come find me in voice when you're ready. I'll be listening.*
