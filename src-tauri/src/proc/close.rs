//! Closing a launch session: graceful request, grace window, forced kill.

use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessesToUpdate};

use super::guard::{expand_descendants, Denial, Guard};
use super::session::{SessionState, TrackedProc};
use super::ProcState;

const MAX_DESCENDANT_DEPTH: usize = 6;
const MAX_KILL_SET: usize = 200;
const POLL_INTERVAL_MS: u64 = 250;

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CloseOptions {
    /// Also close browsers that were already running before the launch. ANDed with
    /// the session's recorded `had_website_items` — the frontend cannot widen this.
    #[serde(default)]
    pub include_preexisting_browsers: bool,
    #[serde(default)]
    pub exclude_pids: Vec<u32>,
    #[serde(default = "default_grace_ms")]
    pub grace_ms: u64,
    /// Produce the full report without signalling anything.
    #[serde(default)]
    pub dry_run: bool,
}

fn default_grace_ms() -> u64 {
    5_000
}

impl Default for CloseOptions {
    fn default() -> Self {
        Self {
            include_preexisting_browsers: false,
            exclude_pids: Vec::new(),
            grace_ms: default_grace_ms(),
            dry_run: false,
        }
    }
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CloseResult {
    /// Exited during the grace window after a polite request.
    Terminated,
    /// Needed a forced kill.
    Forced,
    AlreadyGone,
    /// The PID now belongs to a different process. Deliberately spared.
    Stale,
    Skipped { reason: Denial },
    Failed { error: String },
    WouldClose,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloseOutcome {
    pub pid: u32,
    pub name: String,
    pub exe: String,
    pub result: CloseResult,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloseReport {
    pub workspace_id: String,
    pub dry_run: bool,
    pub closed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub outcomes: Vec<CloseOutcome>,
    pub duration_ms: u64,
}

fn outcome(t: &TrackedProc, result: CloseResult) -> CloseOutcome {
    CloseOutcome { pid: t.pid, name: t.name.clone(), exe: t.exe.clone(), result }
}

/// Ask a process to quit, giving it a chance to run its shutdown path.
///
/// On macOS this is SIGTERM. Note that plain AppKit document apps take the default
/// disposition and die immediately without a save sheet — a true "prompt to save"
/// needs the `kAEQuitApplication` Apple Event, which requires a TCC automation grant.
/// Chrome, Firefox and Electron apps do handle SIGTERM and shut down cleanly.
#[cfg(unix)]
fn request_quit(p: &sysinfo::Process) -> bool {
    p.kill_with(sysinfo::Signal::Term).unwrap_or(false)
}

/// Windows has no signals: sysinfo only implements `Signal::Kill`, and its own kill
/// path always passes `/F`. Dropping `/F` posts WM_CLOSE instead, which is the
/// platform's actual equivalent of "you may prompt to save".
#[cfg(windows)]
fn request_quit(p: &sysinfo::Process) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("taskkill.exe")
        .args(["/PID", &p.pid().as_u32().to_string(), "/T"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run a close to completion. Blocking — callers must run it off the IPC thread.
pub fn run_close(app: &tauri::AppHandle, workspace_id: &str, opts: CloseOptions) -> CloseReport {
    use tauri::Manager;

    let started = Instant::now();
    let state = app.state::<ProcState>();
    let mut outcomes: Vec<CloseOutcome> = Vec::new();

    // --- Gather candidates, then release the sessions lock. ---
    let candidates: Vec<TrackedProc> = {
        let Ok(sessions) = state.sessions.lock() else {
            return finish(app, workspace_id, &opts, outcomes, started);
        };
        let Some(session) = sessions.get(workspace_id) else {
            return finish(app, workspace_id, &opts, outcomes, started);
        };

        let excluded: std::collections::HashSet<u32> = opts.exclude_pids.iter().copied().collect();
        // The consent gate: a category with no website items can never have its
        // pre-existing browsers closed, regardless of what the caller asked for.
        let browsers_ok = opts.include_preexisting_browsers && session.had_website_items;

        let mut v: Vec<TrackedProc> =
            session.tracked.values().filter(|t| !excluded.contains(&t.pid)).cloned().collect();
        if browsers_ok {
            v.extend(
                session
                    .preexisting_browsers
                    .values()
                    .filter(|t| !excluded.contains(&t.pid))
                    .cloned(),
            );
        }
        v
    };

    if candidates.is_empty() {
        return finish(app, workspace_id, &opts, outcomes, started);
    }

    let mut scan = match state.scan.lock() {
        Ok(s) => s,
        Err(_) => return finish(app, workspace_id, &opts, outcomes, started),
    };
    scan.refresh_all_now();

    // These are the processes this launch owns. The guard needs them up front so it
    // doesn't shield them as Flashy's own descendants — `launch_app` spawns apps as
    // direct children, which is every launch on Windows.
    let root_pids: Vec<u32> = candidates.iter().map(|t| t.pid).collect();
    let exempt: std::collections::HashSet<u32> = root_pids.iter().copied().collect();

    let guard = Guard::build(&scan.sys, &exempt);
    if !guard.is_usable() {
        // Fail closed: report everything as skipped rather than guessing.
        for t in &candidates {
            outcomes.push(outcome(t, CloseResult::Skipped { reason: Denial::Protected }));
        }
        drop(scan);
        return finish(app, workspace_id, &opts, outcomes, started);
    }

    // --- Expand to descendants, then vet every PID independently. ---
    let expanded = expand_descendants(&scan.sys, &root_pids, MAX_DESCENDANT_DEPTH, MAX_KILL_SET);
    if expanded.len() >= MAX_KILL_SET {
        log::warn!(
            "flashy: close set hit the {MAX_KILL_SET} cap for workspace {workspace_id}; some descendants were not included"
        );
    }

    let mut to_close: Vec<TrackedProc> = Vec::new();
    for pid in expanded {
        // Descendants discovered during expansion have no recorded identity, so build
        // one now from the same refresh we're about to act on.
        let tracked = candidates.iter().find(|t| t.pid == pid).cloned().or_else(|| {
            scan.sys
                .process(Pid::from(pid as usize))
                .and_then(|p| TrackedProc::from_process(p, super::session::TrackOrigin::Diff))
        });
        let Some(t) = tracked else { continue };

        let Some(p) = scan.sys.process(Pid::from(pid as usize)) else {
            outcomes.push(outcome(&t, CloseResult::AlreadyGone));
            continue;
        };
        if !t.is_still_same(&scan.sys) {
            outcomes.push(outcome(&t, CloseResult::Stale));
            continue;
        }
        if let Err(reason) = guard.check(p) {
            outcomes.push(outcome(&t, CloseResult::Skipped { reason }));
            continue;
        }
        if opts.dry_run {
            outcomes.push(outcome(&t, CloseResult::WouldClose));
            continue;
        }
        to_close.push(t);
    }

    if opts.dry_run {
        drop(scan);
        return finish(app, workspace_id, &opts, outcomes, started);
    }

    // --- Graceful phase. ---
    for t in &to_close {
        if let Some(p) = scan.sys.process(Pid::from(t.pid as usize)) {
            request_quit(p);
        }
    }
    // Released across the grace wait: holding it would stall every running-app poll.
    drop(scan);

    // --- Grace window. Polled, never Process::wait(): sysinfo's macOS implementation
    // loops unbounded for non-children, so an app showing a "Save changes?" sheet
    // would hang this thread forever. ---
    let deadline = Instant::now() + Duration::from_millis(opts.grace_ms);
    let mut survivors = to_close;
    while Instant::now() < deadline && !survivors.is_empty() {
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        let Ok(mut scan) = state.scan.lock() else { break };
        let pids: Vec<Pid> = survivors.iter().map(|t| Pid::from(t.pid as usize)).collect();
        scan.sys.refresh_processes(ProcessesToUpdate::Some(&pids), true);
        survivors.retain(|t| {
            let alive = t.is_still_same(&scan.sys);
            if !alive {
                outcomes.push(outcome(t, CloseResult::Terminated));
            }
            alive
        });
    }

    // --- Forced phase. Re-validate first: the grace window is precisely when a freed
    // PID gets recycled, and skipping this check is how you kill a stranger. ---
    if !survivors.is_empty() {
        if let Ok(mut scan) = state.scan.lock() {
            let pids: Vec<Pid> = survivors.iter().map(|t| Pid::from(t.pid as usize)).collect();
            scan.sys.refresh_processes(ProcessesToUpdate::Some(&pids), true);

            for t in &survivors {
                if !t.is_still_same(&scan.sys) {
                    outcomes.push(outcome(t, CloseResult::Stale));
                    continue;
                }
                let Some(p) = scan.sys.process(Pid::from(t.pid as usize)) else {
                    outcomes.push(outcome(t, CloseResult::Terminated));
                    continue;
                };
                if let Err(reason) = guard.check(p) {
                    outcomes.push(outcome(t, CloseResult::Skipped { reason }));
                    continue;
                }
                outcomes.push(outcome(
                    t,
                    if p.kill() {
                        CloseResult::Forced
                    } else {
                        CloseResult::Failed { error: "kill returned false".into() }
                    },
                ));
            }
        }
    }

    // --- Clear the session so a second close can't act on dead PIDs. ---
    if let Ok(mut sessions) = state.sessions.lock() {
        if let Some(session) = sessions.get_mut(workspace_id) {
            session.tracked.clear();
            session.preexisting_browsers.clear();
            session.state = SessionState::Closed;
        }
    }

    finish(app, workspace_id, &opts, outcomes, started)
}

/// Build the report and, crucially, release the session's `Closing` latch.
///
/// `close_launch_session` sets `Closing` before spawning this work and refuses to start
/// a second close while it is set. Every early return above lands here, so this is the
/// one place guaranteed to run — without it, a close that bailed early (no candidates,
/// missing session, poisoned lock) would leave the session latched forever and every
/// later close would fail with "close already in progress", silently swallowed by the
/// frontend's `safeInvoke`.
fn finish(
    app: &tauri::AppHandle,
    workspace_id: &str,
    opts: &CloseOptions,
    outcomes: Vec<CloseOutcome>,
    started: Instant,
) -> CloseReport {
    use tauri::Manager;

    if !opts.dry_run {
        if let Ok(mut sessions) = app.state::<ProcState>().sessions.lock() {
            if let Some(session) = sessions.get_mut(workspace_id) {
                // Only the latch; a completed close has already set Closed above.
                if session.state == SessionState::Closing {
                    session.state = SessionState::Ready;
                }
            }
        }
    }

    let closed = outcomes
        .iter()
        .filter(|o| matches!(o.result, CloseResult::Terminated | CloseResult::Forced | CloseResult::WouldClose))
        .count();
    let skipped = outcomes
        .iter()
        .filter(|o| matches!(o.result, CloseResult::Skipped { .. } | CloseResult::Stale))
        .count();
    let failed = outcomes.iter().filter(|o| matches!(o.result, CloseResult::Failed { .. })).count();

    CloseReport {
        workspace_id: workspace_id.to_string(),
        dry_run: opts.dry_run,
        closed,
        skipped,
        failed,
        outcomes,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}
