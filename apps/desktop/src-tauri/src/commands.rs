use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::security::{
    list_scoped_files, read_scoped_file, require_main_window, validate_external_url, write_scoped_file,
    ListedFile, ScopedPath, SecurityError,
};

const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_WRITE_BYTES: u64 = 2 * 1024 * 1024;

pub struct PermissionState {
    pub clipboard_enabled: Mutex<bool>,
    pub screenshot_enabled: Mutex<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadRequest {
    #[serde(flatten)]
    path: ScopedPath,
    max_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteRequest {
    #[serde(flatten)]
    path: ScopedPath,
    contents: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRequest {
    title: String,
    body: String,
}

#[tauri::command]
pub fn read_allowed_file<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    request: FileReadRequest,
) -> Result<String, SecurityError> {
    require_main_window(window.label())?;
    read_scoped_file(&app, &request.path, request.max_bytes.unwrap_or(MAX_READ_BYTES).min(MAX_READ_BYTES))
}

#[tauri::command]
pub fn write_allowed_file<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    request: FileWriteRequest,
) -> Result<(), SecurityError> {
    require_main_window(window.label())?;
    write_scoped_file(&app, &request.path, &request.contents, MAX_WRITE_BYTES)
}

#[tauri::command]
pub fn list_allowed_files<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    request: ScopedPath,
) -> Result<Vec<ListedFile>, SecurityError> {
    require_main_window(window.label())?;
    list_scoped_files(&app, &request)
}

#[tauri::command]
pub fn open_allowed_url<R: Runtime>(window: WebviewWindow<R>, url: String) -> Result<(), SecurityError> {
    require_main_window(window.label())?;
    let parsed = validate_external_url(&url)?;
    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>).map_err(|error| SecurityError::Io(error.to_string()))
}

#[tauri::command]
pub fn show_desktop_notification<R: Runtime>(
    window: WebviewWindow<R>,
    request: NotificationRequest,
) -> Result<(), SecurityError> {
    require_main_window(window.label())?;
    window
        .emit(
            "native-notification-request",
            NotificationRequest {
                title: request.title.chars().take(80).collect::<String>(),
                body: request.body.chars().take(500).collect::<String>(),
            },
        )
        .map_err(|error| SecurityError::Io(error.to_string()))
}

#[tauri::command]
pub fn set_clipboard_permission<R: Runtime>(
    state: tauri::State<'_, PermissionState>,
    window: WebviewWindow<R>,
    enabled: bool,
) -> Result<(), SecurityError> {
    require_main_window(window.label())?;
    *state.clipboard_enabled.lock().map_err(|error| SecurityError::Io(error.to_string()))? = enabled;
    Ok(())
}

#[tauri::command]
pub fn read_clipboard_text<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, PermissionState>,
    window: WebviewWindow<R>,
) -> Result<String, SecurityError> {
    require_main_window(window.label())?;
    if !*state.clipboard_enabled.lock().map_err(|error| SecurityError::Io(error.to_string()))? {
        return Err(SecurityError::ClipboardDisabled);
    }
    app.clipboard().read_text().map_err(|error| SecurityError::Io(error.to_string()))
}

#[tauri::command]
pub fn write_clipboard_text<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, PermissionState>,
    window: WebviewWindow<R>,
    text: String,
) -> Result<(), SecurityError> {
    require_main_window(window.label())?;
    if !*state.clipboard_enabled.lock().map_err(|error| SecurityError::Io(error.to_string()))? {
        return Err(SecurityError::ClipboardDisabled);
    }
    app.clipboard()
        .write_text(text.chars().take(20_000).collect::<String>())
        .map_err(|error| SecurityError::Io(error.to_string()))
}

#[tauri::command]
pub fn set_screenshot_permission<R: Runtime>(
    state: tauri::State<'_, PermissionState>,
    window: WebviewWindow<R>,
    enabled: bool,
) -> Result<(), SecurityError> {
    require_main_window(window.label())?;
    *state.screenshot_enabled.lock().map_err(|error| SecurityError::Io(error.to_string()))? = enabled;
    Ok(())
}

#[tauri::command]
pub fn capture_screenshot<R: Runtime>(
    state: tauri::State<'_, PermissionState>,
    window: WebviewWindow<R>,
) -> Result<String, SecurityError> {
    require_main_window(window.label())?;
    let enabled = *state.screenshot_enabled.lock().map_err(|error| SecurityError::Io(error.to_string()))?;
    if !enabled {
        return Err(SecurityError::Io("screenshot permission is disabled".to_string()));
    }
    Err(SecurityError::Io(
        "native screenshot capture is platform-specific and not enabled in this foundation; use browser getDisplayMedia screen sharing where available".to_string(),
    ))
}
