# Privacy And Threat Model

## Assets

- Gemini API key.
- Discord bot token and application credentials.
- User memory and personality profile.
- Local files selected or created by the app.
- Microphone, screen, clipboard, and notification permissions.

## Boundaries

- Frontend is untrusted relative to Rust and backend.
- Discord is public/semi-public.
- Backend is trusted to hold secrets.
- Tauri Rust core is trusted to validate native IPC.

## Mitigations

- No provider key in frontend code.
- No arbitrary shell command.
- File IPC accepts only scoped base directories and relative paths.
- Path traversal and absolute paths are rejected.
- Avatar window has fewer capabilities and runtime command denial.
- Memory has `public`, `private`, `secret` privacy classes.
- Discord receives only public memory by default.
- Secret-like values are redacted before Discord output.
- Tests cover privacy redaction and path validation.

## Residual Risks

- A compromised backend can access secrets.
- Incorrect future plugin code can bypass policy if it posts directly to Discord.
- WebView/browser screen capture permission behavior varies by OS.
- Native screenshot and accessibility-like automation require platform-specific implementations and explicit consent.
- Provider-side safety/rate/model constraints may block or alter responses even when app safety thresholds are set to the least restrictive supported values.
