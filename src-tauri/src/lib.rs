mod proc;

use std::collections::HashMap;
use std::process::Command;

use proc::paths::matches_app_path;
use proc::ProcState;

/// Launch an application by path.
///
/// Returns the spawned child's PID where one is meaningful. On macOS a `.app` is a
/// *directory*, so `Command::new(bundle)` fails with EACCES — the bundle has to go
/// through LaunchServices instead. That hands off and exits, so there's no useful
/// PID to report; process attribution for scheduled closing is handled separately
/// by snapshot diffing rather than by tracking what we spawned.
#[tauri::command]
fn launch_app(path: String) -> Result<Option<u32>, String> {
    #[cfg(target_os = "macos")]
    if path.trim_end_matches('/').ends_with(".app") {
        // Waited on, not just spawned: `open` hands off to LaunchServices and exits
        // immediately, so leaving it unreaped would leak a zombie per launch for the
        // lifetime of the app. It returns in milliseconds, so this does not block.
        let status = Command::new("/usr/bin/open")
            .arg("-a")
            .arg(&path)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("`open -a` failed for {path}"));
        }
        // No useful PID: the real app is re-parented to launchd, so attribution comes
        // from snapshot diffing instead.
        return Ok(None);
    }

    let exe = std::path::Path::new(&path);
    let mut cmd = Command::new(&path);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn().map(|c| Some(c.id())).map_err(|e| e.to_string())
}

/// Which of `paths` currently have a running process?
///
/// Batched deliberately. The previous shape was one command per item, each building
/// a fresh `System` and scanning every process on the machine — with the UI polling
/// every 3s, an N-item workspace meant N full scans per tick.
#[tauri::command]
fn running_apps(state: tauri::State<'_, ProcState>, paths: Vec<String>) -> HashMap<String, bool> {
    let mut scan = state.scan.lock().expect("scan cache poisoned");
    scan.refresh_all_throttled();

    let exes: Vec<&std::path::Path> = scan.sys.processes().values().filter_map(|p| p.exe()).collect();

    paths
        .into_iter()
        .map(|wanted| {
            let running = exes.iter().any(|exe| matches_app_path(exe, &wanted));
            (wanted, running)
        })
        .collect()
}

#[tauri::command]
fn is_app_running(state: tauri::State<'_, ProcState>, path: String) -> bool {
    running_apps(state, vec![path.clone()]).get(&path).copied().unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProcState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            launch_app,
            is_app_running,
            running_apps,
            proc::commands::begin_launch_session,
            proc::commands::finalize_launch_session,
            proc::commands::get_launch_session,
            proc::commands::cancel_launch_session,
            proc::commands::close_launch_session,
            proc::commands::preview_close,
            proc::commands::arm_auto_close,
            proc::commands::disarm_auto_close,
            proc::commands::overlay_available,
            proc::commands::set_overlay_height,
            proc::commands::hide_overlay,
            proc::commands::list_tracked_pids,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Built hidden up front so showing it later is instant. Failure is logged,
            // not fatal — the frontend falls back to the in-app countdown.
            proc::overlay::create(app.handle());

            // Setting FLASHY_DEBUG_OVERLAY=1 pops the panel a moment after launch with a
            // long dummy countdown, so its appearance and its behaviour over fullscreen
            // apps can be checked without waiting out a real 60-second warning.
            if std::env::var_os("FLASHY_DEBUG_OVERLAY").is_some() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    use tauri::Emitter;
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let close_at_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0)
                        // One warning window exactly, so the progress ring starts full
                        // and drains to empty — a 10-minute dummy would clamp at 100%
                        // and sit there looking broken.
                        + 60_000;
                    let _ = handle.emit(
                        "flashy://close-warning",
                        proc::commands::WarningPayload {
                            workspace_id: "debug".into(),
                            workspace_name: "Debug preview".into(),
                            accent: 195.0,
                            close_at_ms,
                        },
                    );
                    proc::overlay::show(&handle, "Debug preview");
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
