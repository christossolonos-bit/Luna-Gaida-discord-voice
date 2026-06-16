# Platform Limitations

## Tauri Windowing

Transparent frameless always-on-top avatar windows are configured. Behavior varies by compositor/window manager, especially on Linux Wayland.

Click-through is not implemented as a guaranteed cross-platform feature in this foundation. The fallback is a draggable frameless avatar window with minimal privileges. The old implementation used `setIgnoreCursorEvents`; this repo keeps avatar permission for it but avoids claiming reliable platform behavior until tested per OS.

## Microphone

Uses browser/WebView `navigator.mediaDevices.getUserMedia`. macOS requires microphone permission for the app bundle. If denied, the user must re-enable it in System Settings.

## Screen And Window Sharing

Uses `navigator.mediaDevices.getDisplayMedia`, which can share a screen/window/tab depending on platform WebView support.

- macOS: requires Screen Recording permission. Users may need to restart the app after granting it.
- Windows: system audio sharing support depends on WebView and capture source.
- Linux: Wayland support depends on desktop portal availability; multi-monitor selection is portal-dependent.

Simultaneous true multi-monitor streaming is not implemented. The realistic fallback is user-selected source capture at low FPS.

## PC/System Audio

The screen-share request asks for audio when enabled. Whether a system-audio track is returned is platform/WebView-dependent.

## Native Screenshot

The command is permission-gated but returns unsupported in this foundation. Use browser screen sharing for realtime visual context. A production native implementation should be added per OS with explicit permission UX and tests.

## Linux Tauri Build Dependencies

This environment needs the normal Tauri Linux development packages before `cargo test` can compile the desktop shell.

Observed missing pkg-config libraries during verification:

- `dbus-1`, provided by `libdbus-1-dev`
- `glib-2.0`, `gobject-2.0`, `gio-2.0`, provided by `libglib2.0-dev`
- `gdk-pixbuf-2.0`, provided by `libgdk-pixbuf-2.0-dev`
- `gdk-3.0`, provided by `libgtk-3-dev`

On Ubuntu/Debian, install the broader Tauri prerequisite set:

```bash
sudo apt install pkg-config build-essential libdbus-1-dev libglib2.0-dev libgdk-pixbuf-2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

Some distributions use `webkit2gtk-4.0` package names instead of `4.1`; use the package name available for your distro/Tauri version.
