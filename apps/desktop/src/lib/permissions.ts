import { invoke } from '@tauri-apps/api/core';

export async function showNotification(title: string, body: string) {
  return invoke('show_desktop_notification', { request: { title, body } });
}

export async function setClipboardEnabled(enabled: boolean) {
  return invoke('set_clipboard_permission', { enabled });
}

export async function setScreenshotEnabled(enabled: boolean) {
  return invoke('set_screenshot_permission', { enabled });
}

export async function openAllowedUrl(url: string) {
  return invoke('open_allowed_url', { url });
}
