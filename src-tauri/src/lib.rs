use std::process::Command;

#[tauri::command]
fn launch_app(path: String) -> Result<(), String> {
    let exe = std::path::Path::new(&path);
    let mut cmd = Command::new(&path);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn is_app_running(path: String) -> bool {
    // Windows paths are case-insensitive, but PathBuf equality isn't, so compare lowercased.
    let target = path.to_lowercase();
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system.processes().values().any(|process| {
        process
            .exe()
            .is_some_and(|exe| exe.to_string_lossy().to_lowercase() == target)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![launch_app, is_app_running])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
