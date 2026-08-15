//! Tauri commands for launch-session tracking.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Emitter, Manager};

use super::close::{run_close, CloseOptions, CloseReport};
use super::session::{
    diff_new_processes, find_preexisting_browsers, own_uid, snapshot_pids, LaunchSession,
    SessionState, TrackOrigin, TrackedProc,
};
use super::ProcState;

/// How long after `finalize` we keep watching for processes that were slow to appear.
const SWEEP_WINDOW_MS: u64 = 10_000;
const SWEEP_INTERVAL_MS: u64 = 750;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackedInfo {
    pub pid: u32,
    pub name: String,
    pub exe: String,
    pub origin: TrackOrigin,
}

impl From<&TrackedProc> for TrackedInfo {
    fn from(t: &TrackedProc) -> Self {
        Self { pid: t.pid, name: t.name.clone(), exe: t.exe.clone(), origin: t.origin }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub workspace_id: String,
    pub state: SessionState,
    pub had_website_items: bool,
    pub tracked: Vec<TrackedInfo>,
    pub preexisting_browsers: Vec<TrackedInfo>,
}

impl From<&LaunchSession> for SessionInfo {
    fn from(s: &LaunchSession) -> Self {
        Self {
            workspace_id: s.workspace_id.clone(),
            state: s.state,
            had_website_items: s.had_website_items,
            tracked: s.tracked.values().map(TrackedInfo::from).collect(),
            preexisting_browsers: s.preexisting_browsers.values().map(TrackedInfo::from).collect(),
        }
    }
}

/// Snapshot the process table before a category's items start opening.
#[tauri::command]
pub fn begin_launch_session(
    state: tauri::State<'_, ProcState>,
    workspace_id: String,
    has_website_items: bool,
) -> Result<(), String> {
    let mut scan = state.scan.lock().map_err(|_| "scan cache poisoned")?;
    scan.refresh_all_now();
    let baseline = snapshot_pids(&scan.sys);

    let mut sessions = state.sessions.lock().map_err(|_| "sessions poisoned")?;

    // Anything still alive from a previous launch of this same category would sit in
    // the new baseline and therefore never show up in the new diff. Carry those
    // entries forward so re-launching doesn't orphan them — but re-validate each one
    // first, so a recycled PID isn't inherited.
    let carried: Vec<TrackedProc> = sessions
        .get(&workspace_id)
        .map(|old| {
            old.tracked
                .values()
                .filter(|t| t.is_still_same(&scan.sys))
                .map(|t| TrackedProc { origin: TrackOrigin::CarriedForward, ..t.clone() })
                .collect()
        })
        .unwrap_or_default();

    let mut session = LaunchSession::new(workspace_id.clone(), has_website_items, baseline);
    for t in carried {
        session.tracked.insert(t.pid, t);
    }
    sessions.insert(workspace_id, session);
    Ok(())
}

/// Take the after-snapshot, store the diff, and start sweeping for late arrivals.
#[tauri::command]
pub fn finalize_launch_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProcState>,
    workspace_id: String,
    spawned_pids: Vec<u32>,
) -> Result<SessionInfo, String> {
    let info = {
        let mut scan = state.scan.lock().map_err(|_| "scan cache poisoned")?;
        scan.refresh_all_now();
        let uid = own_uid(&scan.sys);

        let mut sessions = state.sessions.lock().map_err(|_| "sessions poisoned")?;
        let session = sessions.get_mut(&workspace_id).ok_or("no session for workspace")?;

        for t in diff_new_processes(&scan.sys, &session.baseline, uid.as_ref(), TrackOrigin::Diff) {
            session.tracked.insert(t.pid, t);
        }

        // Directly spawned children (Windows binaries, CLI tools) that the bundle-main
        // filter wouldn't admit. Cheap insurance; usually empty on macOS.
        for pid in spawned_pids {
            if session.tracked.contains_key(&pid) {
                continue;
            }
            if let Some(p) = scan.sys.process(sysinfo::Pid::from(pid as usize)) {
                if let Some(t) = TrackedProc::from_process(p, TrackOrigin::Spawned) {
                    session.tracked.insert(pid, t);
                }
            }
        }

        if session.had_website_items {
            for t in find_preexisting_browsers(&scan.sys, &session.baseline, uid.as_ref()) {
                session.preexisting_browsers.insert(t.pid, t);
            }
        }

        SessionInfo::from(&*session)
    };

    spawn_sweeper(app, workspace_id);
    Ok(info)
}

/// Watch for processes that appear after `finalize` — cold-starting apps can take
/// several seconds to show up, well past the point the launch calls resolved.
fn spawn_sweeper(app: tauri::AppHandle, workspace_id: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(SWEEP_WINDOW_MS);

        while std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(SWEEP_INTERVAL_MS));

            let state = app.state::<ProcState>();
            let Ok(mut scan) = state.scan.lock() else { return };
            scan.refresh_all_now();
            let uid = own_uid(&scan.sys);

            let Ok(mut sessions) = state.sessions.lock() else { return };
            let Some(session) = sessions.get_mut(&workspace_id) else {
                return; // Session was cancelled or replaced; stop sweeping.
            };
            if session.state != SessionState::Collecting {
                return;
            }

            let mut changed = false;
            for t in
                diff_new_processes(&scan.sys, &session.baseline, uid.as_ref(), TrackOrigin::LateSweep)
            {
                if session.tracked.insert(t.pid, t).is_none() {
                    changed = true;
                }
            }

            if changed {
                let info = SessionInfo::from(&*session);
                drop(sessions);
                drop(scan);
                let _ = app.emit("flashy://session-updated", info);
            }
        }

        // Sweep window elapsed. Compute inside a scope so the state borrow and its
        // lock guard both release before the emit.
        let final_info = {
            let state = app.state::<ProcState>();
            let Ok(mut sessions) = state.sessions.lock() else { return };
            match sessions.get_mut(&workspace_id) {
                Some(session) if session.state == SessionState::Collecting => {
                    session.state = SessionState::Ready;
                    Some(SessionInfo::from(&*session))
                }
                _ => None,
            }
        };
        if let Some(info) = final_info {
            let _ = app.emit("flashy://session-updated", info);
        }
    });
}

#[tauri::command]
pub fn get_launch_session(
    state: tauri::State<'_, ProcState>,
    workspace_id: String,
) -> Option<SessionInfo> {
    let sessions = state.sessions.lock().ok()?;
    sessions.get(&workspace_id).map(SessionInfo::from)
}

#[tauri::command]
pub fn cancel_launch_session(state: tauri::State<'_, ProcState>, workspace_id: String) {
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(&workspace_id);
    }
}

/// Close everything a category's launch opened.
///
/// Returns immediately; the result arrives on `flashy://close-report`. The kill path
/// sleeps through a multi-second grace window, and blocking the IPC thread for that
/// long would visibly freeze the UI.
#[tauri::command]
pub fn close_launch_session(
    app: tauri::AppHandle,
    workspace_id: String,
    opts: Option<CloseOptions>,
) -> Result<(), String> {
    let opts = opts.unwrap_or_default();

    {
        let state = app.state::<ProcState>();
        let mut sessions = state.sessions.lock().map_err(|_| "sessions poisoned")?;
        let session = sessions.get_mut(&workspace_id).ok_or("no session for workspace")?;
        if session.state == SessionState::Closing {
            return Err("close already in progress".into());
        }
        if !opts.dry_run {
            session.state = SessionState::Closing;
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let report = run_close(&app, &workspace_id, opts);
        let _ = app.emit("flashy://close-report", report);
    });
    Ok(())
}

/// What *would* a close do, without signalling anything.
///
/// Synchronous, unlike the real close: the dry-run path returns before the graceful
/// phase, so there is no multi-second grace window to wait out — just one process
/// refresh. That lets the UI render the result inline instead of via an event.
///
/// `dry_run` is forced here rather than taken from the caller, so this command can
/// never kill anything regardless of what the frontend passes.
#[tauri::command]
pub fn preview_close(app: tauri::AppHandle, workspace_id: String) -> CloseReport {
    let opts = CloseOptions {
        include_preexisting_browsers: true,
        dry_run: true,
        ..CloseOptions::default()
    };
    run_close(&app, &workspace_id, opts)
}

/// Hide the shared overlay only when no other schedule is still armed.
///
/// The overlay is one window that can be showing several categories at once, so hiding
/// it whenever any single one resolves would take another category's live warning — and
/// its Cancel button — off screen.
///
/// Hiding here rather than leaving it entirely to the overlay's own self-hide matters
/// for one reason beyond tidiness: `overlay::hide` is also what restores the app from
/// accessory mode back to a normal Dock icon. Routing the last-one-out case through
/// Rust means that restore cannot be missed if the overlay's webview is wedged.
fn hide_overlay_if_idle(app: &tauri::AppHandle) {
    let idle = app
        .state::<ProcState>()
        .timers
        .lock()
        .map(|timers| timers.is_empty())
        .unwrap_or(true);
    if idle {
        super::overlay::hide(app);
    }
}

fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Longest single sleep before re-reading the wall clock.
///
/// Sleeping the whole remaining duration in one go would be wrong twice over:
/// `thread::sleep` is monotonic and does not advance while the machine is suspended,
/// and a long timer can't notice a cancel. Slicing bounds both.
const TIMER_SLICE_MS: u64 = 30_000;
const WARNING_LEAD_MS: i64 = 60_000;
/// Past this much lateness we assume the machine was asleep and the user's intent has
/// expired. Closing an hour of work an hour late is worse than not closing at all.
const MISSED_GRACE_MS: i64 = 5 * 60_000;

/// Everything the overlay needs to render, echoed back when the warning fires.
///
/// Rust has no idea what a category is called or what colour it is — that lives in the
/// frontend's workspaces.json, which the backend never reads. So the display fields are
/// passed in at arm time and carried on the timer. The overlay is a separate webview
/// with its own JS heap and can't read the main window's stores, so the event payload
/// is the only channel.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WarningPayload {
    pub workspace_id: String,
    pub workspace_name: String,
    pub accent: f64,
    pub close_at_ms: i64,
}

/// Schedule a close for `close_at_ms` (epoch milliseconds).
#[tauri::command]
pub fn arm_auto_close(
    app: tauri::AppHandle,
    workspace_id: String,
    close_at_ms: i64,
    workspace_name: Option<String>,
    accent: Option<f64>,
    opts: Option<CloseOptions>,
) -> Result<(), String> {
    let opts = opts.unwrap_or_default();
    let cancel = Arc::new(AtomicBool::new(false));
    let warning = WarningPayload {
        workspace_id: workspace_id.clone(),
        workspace_name: workspace_name.unwrap_or_else(|| "this category".into()),
        accent: accent.unwrap_or(195.0),
        close_at_ms,
    };

    {
        let state = app.state::<ProcState>();
        let mut timers = state.timers.lock().map_err(|_| "timers poisoned")?;
        // Re-arming supersedes any previous schedule for this category.
        if let Some(previous) = timers.insert(workspace_id.clone(), Arc::clone(&cancel)) {
            previous.store(true, Ordering::SeqCst);
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut warned = false;

        loop {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let remaining = close_at_ms - now_epoch_ms();
            if remaining <= 0 {
                break;
            }
            if !warned && remaining <= WARNING_LEAD_MS {
                warned = true;
                // Emit before showing, so the overlay has data to render the moment it
                // becomes visible rather than flashing an empty panel.
                let _ = app.emit("flashy://close-warning", &warning);
                super::overlay::show(&app, &warning.workspace_name);
            }
            // Never sleep past the warning boundary, or a long slice would swallow it.
            let slice = if remaining > WARNING_LEAD_MS {
                (remaining - WARNING_LEAD_MS).min(TIMER_SLICE_MS as i64)
            } else {
                remaining.min(TIMER_SLICE_MS as i64)
            };
            std::thread::sleep(std::time::Duration::from_millis(slice.max(50) as u64));
        }

        if cancel.load(Ordering::SeqCst) {
            return;
        }

        {
            let state = app.state::<ProcState>();
            // Bound to a local so the guard drops before `state` does.
            let locked = state.timers.lock();
            if let Ok(mut timers) = locked {
                timers.remove(&workspace_id);
            }
        }

        // Woke up far too late to act on the user's original intent.
        let lateness = now_epoch_ms() - close_at_ms;
        if lateness > MISSED_GRACE_MS {
            hide_overlay_if_idle(&app);
            let _ = app.emit("flashy://close-missed", &workspace_id);
            return;
        }

        let report = run_close(&app, &workspace_id, opts);
        hide_overlay_if_idle(&app);
        let _ = app.emit("flashy://close-report", report);
    });

    Ok(())
}

#[tauri::command]
pub fn disarm_auto_close(app: tauri::AppHandle, workspace_id: String) {
    {
        let state = app.state::<ProcState>();
        let locked = state.timers.lock();
        if let Ok(mut timers) = locked {
            if let Some(flag) = timers.remove(&workspace_id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    hide_overlay_if_idle(&app);
    // Separate JS contexts, so this has to be broadcast: the overlay and the main window
    // cannot see each other's state. The overlay drops the cancelled row on this event.
    let _ = app.emit("flashy://close-cancelled", &workspace_id);
}

/// Whether the floating overlay exists. False means the frontend should render its own
/// in-app countdown instead, so the warning is never simply lost.
#[tauri::command]
pub fn overlay_available(app: tauri::AppHandle) -> bool {
    super::overlay::is_available(&app)
}

/// Called by the overlay itself once it knows how tall its content is.
#[tauri::command]
pub fn set_overlay_height(app: tauri::AppHandle, height: f64) {
    super::overlay::set_height(&app, height);
}

/// Let the overlay dismiss itself when it has nothing left to show.
///
/// A backstop rather than the main path: the window's frosting is a native layer that
/// paints even with an empty webview, so "no warnings but still on screen" reads as a
/// blank glass box. The overlay knows that state first-hand.
#[tauri::command]
pub fn hide_overlay(app: tauri::AppHandle) {
    super::overlay::hide(&app);
}

/// Debug helper: what does the tracker currently think it could close?
#[tauri::command]
pub fn list_tracked_pids(state: tauri::State<'_, ProcState>) -> Vec<String> {
    let Ok(sessions) = state.sessions.lock() else { return Vec::new() };
    sessions
        .values()
        .flat_map(|s| {
            s.tracked
                .values()
                .map(|t| format!("{} [{}] {}", s.workspace_id, t.pid, t.exe))
                .collect::<Vec<_>>()
        })
        .collect()
}
