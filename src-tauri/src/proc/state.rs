//! Tauri-managed process state.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sysinfo::{ProcessesToUpdate, System};

use super::session::LaunchSession;

/// Minimum spacing between full process-table refreshes.
///
/// The UI polls running-app status on a 3s interval; this floor means a chatty
/// caller can't turn that into repeated full scans of a ~650-process table.
const REFRESH_FLOOR: Duration = Duration::from_millis(1000);

/// A `System` reused across calls.
///
/// Reuse is the point: on a warm `System`, `ProcessRefreshKind`'s
/// `with_exe(UpdateKind::OnlyIfNotSet)` skips the `proc_pidpath` syscall for every
/// already-known PID. Constructing a fresh `System` per call (as `is_app_running`
/// used to) pays that cost for every process, every time.
pub struct ScanCache {
    pub sys: System,
    pub last_refresh: Option<Instant>,
}

impl Default for ScanCache {
    fn default() -> Self {
        Self { sys: System::new(), last_refresh: None }
    }
}

impl ScanCache {
    /// Refresh the full process table unless it was already refreshed very recently.
    pub fn refresh_all_throttled(&mut self) {
        // map_or rather than is_none_or: the latter is stable only since 1.82, and
        // Cargo.toml declares an MSRV of 1.77.2.
        let stale = self.last_refresh.map_or(true, |t| t.elapsed() > REFRESH_FLOOR);
        if stale {
            self.refresh_all_now();
        }
    }

    /// Refresh the full process table unconditionally. Use where a stale read would
    /// be a correctness problem rather than a cosmetic one — notably before killing.
    pub fn refresh_all_now(&mut self) {
        self.sys.refresh_processes(ProcessesToUpdate::All, true);
        self.last_refresh = Some(Instant::now());
    }
}

/// Shared state registered with `.manage()`.
///
/// `scan` and `sessions` are deliberately separate mutexes. The scan lock is held
/// across a full process refresh (and, during a close, must be released across the
/// multi-second grace wait); sharing one lock would stall every UI poll behind it.
/// Lock ordering, where both are needed: `scan` before `sessions`.
#[derive(Default)]
pub struct ProcState {
    pub scan: Mutex<ScanCache>,
    pub sessions: Mutex<HashMap<String, LaunchSession>>,
    /// Cancel flags for armed auto-close timers, keyed by workspace id.
    ///
    /// A flag rather than a JoinHandle: `spawn_blocking` tasks can't be aborted
    /// mid-sleep, so the timer checks this at the top of each slice instead.
    pub timers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
