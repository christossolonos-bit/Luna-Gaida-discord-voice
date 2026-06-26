mod commands;
mod security;

use commands::{
    capture_screenshot, list_allowed_files, open_allowed_url, read_allowed_file, read_clipboard_text,
    set_clipboard_permission, set_screenshot_permission, show_desktop_notification, write_allowed_file,
    write_clipboard_text, PermissionState,
};
use std::sync::Mutex;
use tauri::{Manager, PhysicalPosition};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PermissionState {
            clipboard_enabled: Mutex::new(false),
            screenshot_enabled: Mutex::new(false),
        })
        .setup(|app| {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.hide();
            }
            if let Some(avatar) = app.get_webview_window("avatar") {
                if let Ok(Some(monitor)) = avatar.current_monitor() {
                    if let Ok(size) = avatar.outer_size() {
                        let work_area = monitor.work_area();
                        let margin = 12;
                        let x = work_area.position.x
                            + work_area.size.width as i32
                            - size.width as i32
                            - margin;
                        let y = work_area.position.y
                            + work_area.size.height as i32
                            - size.height as i32;
                        let _ = avatar.set_position(PhysicalPosition::new(x.max(work_area.position.x), y));
                    }
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            read_allowed_file,
            write_allowed_file,
            list_allowed_files,
            open_allowed_url,
            show_desktop_notification,
            set_clipboard_permission,
            read_clipboard_text,
            write_clipboard_text,
            set_screenshot_permission,
            capture_screenshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running Luna desktop companion");
}
