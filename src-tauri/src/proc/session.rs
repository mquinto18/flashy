//! Launch sessions: figuring out which processes a category's launch actually opened.
//!
//! # Why snapshot diffing
//!
//! We can't track what we launched. Website items store a URL and file items store a
//! document path — neither names a process. And on macOS `tauri-plugin-opener` shells
//! out to `/usr/bin/open`, which hands off to LaunchServices and exits, so everything
//! it starts is re-parented to PID 1. Parent-chain attribution finds nothing.
//!
//! So instead: snapshot every PID before the launch, snapshot again afterwards, and
//! treat the difference as the set this launch is responsible for. That covers apps
//! that re-exec under a new PID, a browser started fresh by `openUrl`, and whatever
//! app the OS picked to open a document — uniformly, without knowing any of their names.
//!
//! It also fails safe in a useful way: a browser that was *already* running is in the
//! baseline, so it never lands in the diff and its pre-existing tabs survive.

use std::collections::{BTreeMap, HashSet};

use sysinfo::{Process, System, Uid};

use super::paths::is_browser_main;

/// How a process came to be in a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackOrigin {
    /// Appeared in the immediate before/after diff.
    Diff,
    /// Reported by `launch_app` as a directly spawned child.
    Spawned,
    /// Appeared during the post-launch sweep (slow cold-start apps).
    LateSweep,
    /// Still alive from a previous launch of the same category.
    CarriedForward,
    /// Was already running before the launch; only closeable with explicit consent.
    PreexistingBrowser,
}

/// A process plus enough identity to detect PID reuse later.
///
/// `start_time` + `exe` together are the identity key. PIDs alone are not: the grace
/// window between SIGTERM and SIGKILL is exactly when a freed PID gets recycled, and
/// acting on a stale PID means killing an unrelated process.
#[derive(Clone, Debug)]
pub struct TrackedProc {
    pub pid: u32,
    pub start_time: u64,
    pub exe: String,
    pub name: String,
    pub origin: TrackOrigin,
}

impl TrackedProc {
    pub fn from_process(p: &Process, origin: TrackOrigin) -> Option<Self> {
        let exe = p.exe()?.to_string_lossy().into_owned();
        Some(Self {
            pid: p.pid().as_u32(),
            start_time: p.start_time(),
            exe,
            name: p.name().to_string_lossy().into_owned(),
            origin,
        })
    }

    /// Is the process at this PID still the same one we recorded?
    pub fn is_still_same(&self, sys: &System) -> bool {
        sys.process(sysinfo::Pid::from(self.pid as usize)).is_some_and(|p| {
            p.start_time() == self.start_time
                && p.exe().map(|e| e.to_string_lossy().into_owned()).as_deref() == Some(self.exe.as_str())
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// Launch finished, sweeper still watching for late arrivals.
    Collecting,
    Ready,
    Closing,
    Closed,
}

pub struct LaunchSession {
    pub workspace_id: String,
    /// Every PID alive immediately before the launch began.
    pub baseline: HashSet<u32>,
    /// Recorded at `begin` and ANDed into any browser-killing request, so a frontend
    /// bug can't enable browser closing for a category with no website items.
    pub had_website_items: bool,
    pub tracked: BTreeMap<u32, TrackedProc>,
    pub preexisting_browsers: BTreeMap<u32, TrackedProc>,
    pub state: SessionState,
}

impl LaunchSession {
    pub fn new(workspace_id: String, had_website_items: bool, baseline: HashSet<u32>) -> Self {
        Self {
            workspace_id,
            baseline,
            had_website_items,
            tracked: BTreeMap::new(),
            preexisting_browsers: BTreeMap::new(),
            state: SessionState::Collecting,
        }
    }
}

/// Own user id, used to reject every process belonging to root or another user.
pub fn own_uid(sys: &System) -> Option<Uid> {
    let me = sysinfo::get_current_pid().ok()?;
    sys.process(me).and_then(|p| p.user_id()).cloned()
}

/// Every PID currently alive.
pub fn snapshot_pids(sys: &System) -> HashSet<u32> {
    sys.processes().keys().map(|p| p.as_u32()).collect()
}

/// Could this process plausibly be something a launch opened?
///
/// The bundle-main rule does most of the work on macOS: background daemons
/// (`mdworker`, `searchpartyd`, `biomed`, …) don't live in `.app` bundles, while every
/// real GUI app does. That filters the diff down to things a user would recognise
/// without needing to enumerate noise.
pub fn is_attributable(p: &Process, uid: Option<&Uid>) -> bool {
    let Some(exe) = p.exe() else {
        return false; // No exe means we can't verify identity, so never track it.
    };
    if uid.is_none() || p.user_id() != uid {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        super::paths::mac_app_bundle_main(exe).is_some()
    }
    #[cfg(not(target_os = "macos"))]
    {
        !super::paths::is_system_path(&exe.to_string_lossy())
    }
}

/// Processes that appeared since `baseline` and look attributable.
pub fn diff_new_processes(
    sys: &System,
    baseline: &HashSet<u32>,
    uid: Option<&Uid>,
    origin: TrackOrigin,
) -> Vec<TrackedProc> {
    sys.processes()
        .iter()
        .filter(|(pid, p)| !baseline.contains(&pid.as_u32()) && is_attributable(p, uid))
        .filter_map(|(_, p)| TrackedProc::from_process(p, origin))
        .collect()
}

/// Browsers that were already running before the launch.
///
/// Kept in their own bucket and never merged into `tracked`: closing one takes down
/// every unrelated tab the user had open, so it requires explicit consent.
pub fn find_preexisting_browsers(
    sys: &System,
    baseline: &HashSet<u32>,
    uid: Option<&Uid>,
) -> Vec<TrackedProc> {
    sys.processes()
        .iter()
        .filter(|(pid, p)| baseline.contains(&pid.as_u32()) && is_attributable(p, uid))
        .filter(|(_, p)| p.exe().is_some_and(is_browser_main))
        .filter_map(|(_, p)| TrackedProc::from_process(p, TrackOrigin::PreexistingBrowser))
        .collect()
}
