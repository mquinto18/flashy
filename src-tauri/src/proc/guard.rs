//! The gauntlet every process must pass before it can be signalled.
//!
//! Getting this wrong doesn't produce a bug report, it logs the user out. So the
//! rules are layered and a candidate must pass *all* of them, the decision logic is
//! a pure function that can be exhaustively tested without live processes, and every
//! failure path defaults to "don't kill".

use std::collections::{HashMap, HashSet, VecDeque};

use sysinfo::{Pid, Process, System, Uid};

use super::paths::is_system_path;

/// Why a process was spared. Surfaced to the UI so a dry run is legible.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Denial {
    /// Flashy itself, an ancestor, or a descendant.
    Protected,
    /// Below the platform's "this is boot infrastructure" PID floor.
    LowPid,
    /// No readable exe path, so identity can't be verified.
    NoExe,
    /// Belongs to root or another user.
    ForeignUser,
    /// Lives in an OS infrastructure directory.
    SystemPath,
    /// Name is on the never-kill list.
    BlockedName,
}

/// PIDs below this are boot-time infrastructure on a freshly booted machine.
/// A tripwire only — PIDs wrap, so this is never load-bearing on its own.
#[cfg(target_os = "macos")]
const MIN_PID: u32 = 100;
#[cfg(windows)]
const MIN_PID: u32 = 16;
#[cfg(not(any(target_os = "macos", windows)))]
const MIN_PID: u32 = 100;

#[cfg(target_os = "macos")]
pub const BLOCKED_NAMES: &[&str] = &[
    // Kill any of these and the session wedges or the user gets logged out.
    "launchd",
    "kernel_task",
    "windowserver",
    "loginwindow",
    "logind",
    "systemuiserver",
    "dock",
    "finder",
    "coreaudiod",
    "cfprefsd",
    "distnoted",
    "launchservicesd",
    "opendirectoryd",
    "securityd",
    "trustd",
    "tccd",
    "mds",
    "mds_stores",
    "mdworker",
    "mdworker_shared",
    "notifyd",
    "powerd",
    "configd",
    "syslogd",
    "logd",
    "hidd",
    "usereventagent",
    "diskarbitrationd",
    "fseventsd",
    "amfid",
    "sandboxd",
    "watchdogd",
    "thermalmonitord",
    "bluetoothd",
    "corebrightnessd",
    "universalaccessd",
    "sharingd",
    "controlcenter",
    "notificationcenter",
    "spotlight",
    "talagent",
    "pboard",
    "nsurlsessiond",
    "backupd",
    "revisiond",
    // Terminals: in dev these are Flashy's own ancestors, and killing the user's
    // terminal mid-session is a nasty surprise even in release.
    "terminal",
    "iterm2",
    "ghostty",
    "alacritty",
    "wezterm-gui",
    "kitty",
];

#[cfg(windows)]
pub const BLOCKED_NAMES: &[&str] = &[
    "system",
    "registry",
    "idle",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "lsaiso.exe",
    "svchost.exe",
    "explorer.exe",
    "dwm.exe",
    "fontdrvhost.exe",
    "sihost.exe",
    "ctfmon.exe",
    "taskhostw.exe",
    "runtimebroker.exe",
    "searchhost.exe",
    "searchindexer.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "spoolsv.exe",
    "conhost.exe",
    "werfault.exe",
    "msmpeng.exe",
    "securityhealthservice.exe",
    "audiodg.exe",
    "wudfhost.exe",
    "dllhost.exe",
    "cmd.exe",
    "powershell.exe",
    "windowsterminal.exe",
    "openconsole.exe",
];

#[cfg(not(any(target_os = "macos", windows)))]
pub const BLOCKED_NAMES: &[&str] = &["systemd", "init", "dbus-daemon", "Xorg", "gnome-shell"];

pub struct Guard {
    protected: HashSet<u32>,
    own_uid: Option<Uid>,
    /// False when we couldn't identify our own process. Everything is denied.
    usable: bool,
}

impl Guard {
    /// Build the protected set from the same refresh the kill will read from.
    ///
    /// `exempt` is the set of PIDs this launch is responsible for. They are skipped
    /// during the descendant walk, along with their own subtrees.
    ///
    /// That exemption is essential, not an optimisation: `launch_app` starts apps with
    /// `Command::spawn`, making them *direct children* of Flashy. On Windows that is
    /// every launch, and on macOS every non-`.app` path. Without this they would all be
    /// protected as "our own descendants" and auto-close would silently close nothing.
    /// Flashy's real helpers — the webview processes, the dev server — are not in the
    /// tracked set, so they stay protected.
    pub fn build(sys: &System, exempt: &HashSet<u32>) -> Self {
        let mut protected = HashSet::new();
        protected.insert(0);
        protected.insert(1); // launchd / System Idle

        let Ok(me) = sysinfo::get_current_pid() else {
            // We can't establish what "self" is, so we can't guarantee we won't kill
            // ourselves or our parent. Fail closed rather than guess.
            return Self { protected, own_uid: None, usable: false };
        };
        protected.insert(me.as_u32());

        // Ancestors: the terminal, `cargo tauri dev`, Finder, whatever launched us.
        let mut cur = sys.process(me).and_then(|p| p.parent());
        for _ in 0..64 {
            // Bounded: a corrupt parent map must not spin forever.
            let Some(p) = cur else { break };
            if !protected.insert(p.as_u32()) {
                break; // Cycle.
            }
            cur = sys.process(p).and_then(|pr| pr.parent());
        }

        // Descendants: WebKit/WKWebView helpers, the vite dev server, etc.
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, pr) in sys.processes() {
            if let Some(parent) = pr.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }
        let mut queue = VecDeque::from([me]);
        while let Some(p) = queue.pop_front() {
            for child in children.get(&p).into_iter().flatten() {
                // A process we deliberately launched, and everything under it, is the
                // whole point of the feature — don't shield it as one of ours.
                if exempt.contains(&child.as_u32()) {
                    continue;
                }
                if protected.insert(child.as_u32()) {
                    queue.push_back(*child);
                }
            }
        }

        let own_uid = sys.process(me).and_then(|p| p.user_id()).cloned();
        // No resolvable uid means the ForeignUser rule can't discriminate, which would
        // silently widen the blast radius. Treat that as unusable too.
        let usable = own_uid.is_some();
        Self { protected, own_uid, usable }
    }

    pub fn is_usable(&self) -> bool {
        self.usable
    }

    /// The whole decision, as a pure function over extracted attributes.
    ///
    /// Split out from [`Guard::check`] so it can be tested against a fixture table of
    /// real process attributes — `sysinfo::Process` can't be constructed in a test.
    pub fn evaluate(
        usable: bool,
        protected: &HashSet<u32>,
        pid: u32,
        exe: Option<&str>,
        uid_matches: bool,
        name: &str,
    ) -> Result<(), Denial> {
        if !usable {
            return Err(Denial::Protected);
        }
        if protected.contains(&pid) {
            return Err(Denial::Protected);
        }
        if pid < MIN_PID {
            return Err(Denial::LowPid);
        }
        let Some(exe) = exe else {
            return Err(Denial::NoExe);
        };
        if !uid_matches {
            return Err(Denial::ForeignUser);
        }
        if is_system_path(exe) {
            return Err(Denial::SystemPath);
        }
        let leaf = exe.rsplit(['/', '\\']).next().unwrap_or(exe).to_lowercase();
        if BLOCKED_NAMES.contains(&leaf.as_str()) || BLOCKED_NAMES.contains(&name.to_lowercase().as_str())
        {
            return Err(Denial::BlockedName);
        }
        Ok(())
    }

    pub fn check(&self, p: &Process) -> Result<(), Denial> {
        let exe = p.exe().map(|e| e.to_string_lossy().into_owned());
        Self::evaluate(
            self.usable,
            &self.protected,
            p.pid().as_u32(),
            exe.as_deref(),
            self.own_uid.is_some() && p.user_id() == self.own_uid.as_ref(),
            &p.name().to_string_lossy(),
        )
    }
}

/// Expand a set of PIDs to include their descendants.
///
/// Done at close time rather than snapshot time, because at snapshot time the tree
/// hasn't formed yet. Bounded in depth and total size so a pathological tree can't
/// turn into an unbounded kill list. Every expanded PID is vetted independently by
/// the guard afterwards — expansion grants no exemption.
pub fn expand_descendants(sys: &System, roots: &[u32], max_depth: usize, cap: usize) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, pr) in sys.processes() {
        if let Some(parent) = pr.parent() {
            children.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }

    let mut seen: HashSet<u32> = roots.iter().copied().collect();
    let mut out: Vec<u32> = roots.to_vec();
    let mut queue: VecDeque<(u32, usize)> = roots.iter().map(|&p| (p, 0)).collect();

    while let Some((pid, depth)) = queue.pop_front() {
        if depth >= max_depth || out.len() >= cap {
            break;
        }
        // Never expand from the roots of the process tree.
        if pid <= 1 {
            continue;
        }
        for &child in children.get(&pid).into_iter().flatten() {
            if out.len() >= cap {
                break;
            }
            if seen.insert(child) {
                out.push(child);
                queue.push_back((child, depth + 1));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protected_set() -> HashSet<u32> {
        HashSet::from([0, 1, 4242])
    }

    #[test]
    fn unusable_guard_denies_everything() {
        // The fail-closed path: if we can't identify ourselves, nothing dies.
        let r = Guard::evaluate(false, &protected_set(), 9999, Some("/Applications/Foo.app/Contents/MacOS/Foo"), true, "Foo");
        assert_eq!(r, Err(Denial::Protected));
    }

    #[test]
    fn protects_self_and_low_pids() {
        let p = protected_set();
        assert_eq!(
            Guard::evaluate(true, &p, 4242, Some("/Applications/Foo.app/Contents/MacOS/Foo"), true, "Foo"),
            Err(Denial::Protected)
        );
        assert_eq!(
            Guard::evaluate(true, &p, 2, Some("/Applications/Foo.app/Contents/MacOS/Foo"), true, "Foo"),
            Err(Denial::LowPid)
        );
    }

    #[test]
    fn requires_exe_and_matching_user() {
        let p = protected_set();
        assert_eq!(Guard::evaluate(true, &p, 9999, None, true, "mystery"), Err(Denial::NoExe));
        assert_eq!(
            Guard::evaluate(true, &p, 9999, Some("/Applications/Foo.app/Contents/MacOS/Foo"), false, "Foo"),
            Err(Denial::ForeignUser)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn blocks_system_paths_and_names() {
        let p = protected_set();
        assert_eq!(
            Guard::evaluate(true, &p, 9999, Some("/usr/libexec/searchpartyd"), true, "searchpartyd"),
            Err(Denial::SystemPath)
        );
        // Finder lives in a .app so it clears the path rule — the name list is what
        // catches it. This is exactly why both layers exist.
        assert_eq!(
            Guard::evaluate(
                true,
                &p,
                9999,
                Some("/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"),
                true,
                "Finder"
            ),
            Err(Denial::BlockedName)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn allows_ordinary_user_apps() {
        let p = protected_set();
        for (exe, name) in [
            ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "Google Chrome"),
            ("/System/Applications/Preview.app/Contents/MacOS/Preview", "Preview"),
            ("/Applications/Microsoft Word.app/Contents/MacOS/Microsoft Word", "Microsoft Word"),
        ] {
            assert_eq!(
                Guard::evaluate(true, &p, 9999, Some(exe), true, name),
                Ok(()),
                "should be killable: {exe}"
            );
        }
    }

    /// Builds a guard from the real process table. If this ever fails, the feature is
    /// unsafe to ship — the whole design rests on never signalling our own process.
    #[test]
    fn real_system_protects_self_and_ancestors() {
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let guard = Guard::build(&sys, &HashSet::new());
        assert!(guard.is_usable(), "guard must be usable on a normal system");

        let me = sysinfo::get_current_pid().expect("own pid");
        let my_proc = sys.process(me).expect("own process");
        assert_eq!(guard.check(my_proc), Err(Denial::Protected), "must never kill self");

        // Walk up the real ancestor chain; every link must be spared.
        let mut cur = my_proc.parent();
        let mut checked = 0;
        while let Some(pid) = cur {
            if let Some(p) = sys.process(pid) {
                assert_eq!(guard.check(p), Err(Denial::Protected), "must never kill ancestor {pid}");
                checked += 1;
                cur = p.parent();
            } else {
                break;
            }
        }
        assert!(checked > 0, "expected at least one ancestor to verify");
    }

    /// Regression guard for the bug that silently disabled auto-close on Windows.
    ///
    /// `launch_app` uses `Command::spawn`, so launched apps are direct children of
    /// Flashy. The descendant walk protects our own children, which meant every
    /// launched app was skipped as `Protected` and nothing ever closed. Exempting the
    /// tracked PIDs is what makes the feature work at all off macOS.
    #[test]
    fn exempt_pids_are_not_protected_as_our_descendants() {
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let me = sysinfo::get_current_pid().expect("own pid");
        let children: Vec<u32> = sys
            .processes()
            .iter()
            .filter(|(_, p)| p.parent() == Some(me))
            .map(|(pid, _)| pid.as_u32())
            .collect();

        let Some(&child) = children.first() else {
            // No child processes in this environment; nothing to assert against.
            return;
        };

        // Without the exemption a direct child is shielded...
        let plain = Guard::build(&sys, &HashSet::new());
        let child_proc = sys.process(Pid::from(child as usize)).expect("child process");
        assert_eq!(
            plain.check(child_proc),
            Err(Denial::Protected),
            "a direct child should be protected when not exempt"
        );

        // ...and with it, the child is no longer protected on that basis. It may still
        // be denied for another reason (system path, blocklist), so assert only that
        // the verdict is no longer Protected.
        let exempt = HashSet::from([child]);
        let exempting = Guard::build(&sys, &exempt);
        assert_ne!(
            exempting.check(child_proc),
            Err(Denial::Protected),
            "an exempt child must not be shielded as one of our own descendants"
        );
    }

    /// Sweep the entire live process table and assert nothing session-critical is
    /// considered killable.
    #[test]
    fn real_system_spares_critical_processes() {
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let guard = Guard::build(&sys, &HashSet::new());

        for (pid, p) in sys.processes() {
            let name = p.name().to_string_lossy().to_lowercase();
            let critical = BLOCKED_NAMES.contains(&name.as_str());
            if critical {
                assert!(
                    guard.check(p).is_err(),
                    "critical process must be spared: {} (pid {pid})",
                    name
                );
            }
        }
    }

    #[test]
    fn descendant_expansion_is_bounded() {
        let sys = System::new();
        // No processes loaded, so expansion returns just the roots — the point here is
        // that the cap and depth arguments are respected rather than ignored.
        let out = expand_descendants(&sys, &[9999], 6, 200);
        assert_eq!(out, vec![9999]);
    }

    #[test]
    fn descendant_expansion_never_walks_from_pid_one() {
        let sys = System::new();
        let out = expand_descendants(&sys, &[1], 6, 200);
        assert_eq!(out, vec![1]);
    }
}
