//! Path classification shared by process attribution and the safety guard.
//!
//! These are pure functions over path strings so they can be unit tested without
//! a live process table — which matters, because getting them wrong here is how
//! you end up killing WindowServer.

use std::path::Path;

/// macOS: is this the *main* binary of a GUI app bundle, rather than a helper,
/// XPC service, or embedded extension?
///
/// Returns the bundle root (e.g. `/Applications/Google Chrome.app`) when it is.
///
/// The first `.app` in the path is the one that matters. Matching the last one
/// would accept `Google Chrome.app/Contents/Frameworks/.../Google Chrome Helper.app/
/// Contents/MacOS/Google Chrome Helper`, and killing a renderer yields "Aw, Snap!"
/// rather than a clean shutdown.
#[cfg(target_os = "macos")]
pub fn mac_app_bundle_main(exe: &Path) -> Option<&str> {
    let s = exe.to_str()?;
    let dot_app = s.find(".app/")?;
    let rest = &s[dot_app + 4..]; // "/Contents/MacOS/Google Chrome"
    let leaf = rest.strip_prefix("/Contents/MacOS/")?;
    if leaf.is_empty() || leaf.contains('/') {
        return None;
    }
    Some(&s[..dot_app + 4])
}

/// Does a running process's exe path correspond to the app path stored on an item?
///
/// Items store the bundle root on macOS (`/Applications/Foo.app`) but `Process::exe()`
/// reports the inner binary (`/Applications/Foo.app/Contents/MacOS/Foo`), so a plain
/// equality check can never match. That was a live bug in `is_app_running`.
pub fn matches_app_path(exe: &Path, wanted: &str) -> bool {
    let e = exe.to_string_lossy().to_lowercase();
    let w = wanted.trim_end_matches(['/', '\\']).to_lowercase();
    if w.is_empty() {
        return false;
    }
    if e == w {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        // Bundle root stored, inner binary running.
        if e.starts_with(&format!("{w}/contents/macos/")) {
            return true;
        }
    }
    false
}

/// Deny-list of directory prefixes that hold OS infrastructure.
///
/// The `.app` carve-out has to come first: Preview, TextEdit, Mail and Safari all
/// live under `/System/Applications/`, and the whole feature is pointless if a
/// scheduled close can't shut Preview.
#[cfg(target_os = "macos")]
pub fn is_system_path(s: &str) -> bool {
    if mac_app_bundle_main(Path::new(s)).is_some() {
        return false;
    }
    const DENY: &[&str] = &[
        "/usr/libexec/",
        "/usr/sbin/",
        "/sbin/",
        "/usr/bin/",
        "/System/Library/",
        "/System/Cryptexes/",
        "/Library/Apple/",
        "/Library/PrivilegedHelperTools/",
        "/System/Volumes/Preboot/Cryptexes/App/usr/",
    ];
    DENY.iter().any(|p| s.starts_with(p))
}

#[cfg(windows)]
pub fn is_system_path(s: &str) -> bool {
    let l = s.to_lowercase();
    l.starts_with(r"c:\windows\") || l.starts_with(r"\??\c:\windows\")
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn is_system_path(s: &str) -> bool {
    const DENY: &[&str] = &["/usr/libexec/", "/usr/sbin/", "/sbin/", "/lib/systemd/"];
    DENY.iter().any(|p| s.starts_with(p))
}

/// Known browser main-binary path suffixes.
///
/// Matched on the exe *path suffix*, never the process name. Two reasons, both real:
/// Safari's actual path is under a `/System/Volumes/Preboot/Cryptexes/App/...` prefix
/// that shifts between OS updates, and name-matching "Google Chrome" would sweep in
/// its ~8 helper processes.
#[cfg(target_os = "macos")]
pub const BROWSER_MAIN_SUFFIXES: &[&str] = &[
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "Chromium.app/Contents/MacOS/Chromium",
    "Safari.app/Contents/MacOS/Safari",
    "Firefox.app/Contents/MacOS/firefox",
    "Firefox Developer Edition.app/Contents/MacOS/firefox",
    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "Brave Browser.app/Contents/MacOS/Brave Browser",
    "Arc.app/Contents/MacOS/Arc",
    "Dia.app/Contents/MacOS/Dia",
    "Vivaldi.app/Contents/MacOS/Vivaldi",
    "Opera.app/Contents/MacOS/Opera",
    "Zen.app/Contents/MacOS/zen",
    "Orion.app/Contents/MacOS/Orion",
];

#[cfg(windows)]
pub const BROWSER_MAIN_SUFFIXES: &[&str] = &[
    r"\chrome.exe",
    r"\msedge.exe",
    r"\firefox.exe",
    r"\brave.exe",
    r"\opera.exe",
    r"\vivaldi.exe",
    r"\arc.exe",
];

#[cfg(not(any(target_os = "macos", windows)))]
pub const BROWSER_MAIN_SUFFIXES: &[&str] = &["/chrome", "/firefox", "/chromium", "/brave"];

/// Is this exe path a browser's main process (not a renderer or helper)?
pub fn is_browser_main(exe: &Path) -> bool {
    // On macOS the bundle-main check already excludes helpers; elsewhere the
    // suffix table is specific enough on its own.
    #[cfg(target_os = "macos")]
    if mac_app_bundle_main(exe).is_none() {
        return false;
    }
    let s = exe.to_string_lossy();
    BROWSER_MAIN_SUFFIXES.iter().any(|suffix| s.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn accepts_main_app_binaries() {
        for path in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/System/Applications/Preview.app/Contents/MacOS/Preview",
            "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari",
        ] {
            assert!(
                mac_app_bundle_main(Path::new(path)).is_some(),
                "should accept main binary: {path}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_helpers_and_daemons() {
        for path in [
            // Helper bundle nested inside Chrome — must be rejected via FIRST .app.
            "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
            "/Applications/Safari.app/Contents/Extensions/SafariLinkExtension",
            "/usr/bin/open",
            "/usr/libexec/searchpartyd",
            "/Applications/Google Chrome.app/Contents/Frameworks/chrome_crashpad_handler",
        ] {
            assert!(
                mac_app_bundle_main(Path::new(path)).is_none(),
                "should reject non-main binary: {path}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_apps_are_not_system_paths() {
        // The carve-out: these must stay killable.
        assert!(!is_system_path(
            "/System/Applications/Preview.app/Contents/MacOS/Preview"
        ));
        // These must not.
        assert!(is_system_path("/usr/libexec/searchpartyd"));
        assert!(is_system_path("/System/Library/CoreServices/Dock.app"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn browser_detection_matches_mains_not_helpers() {
        assert!(is_browser_main(Path::new(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        )));
        // Safari's cryptex path must still match via suffix.
        assert!(is_browser_main(Path::new(
            "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari"
        )));
        // A renderer helper must not — SIGKILLing one yields "Aw, Snap!".
        assert!(!is_browser_main(Path::new(
            "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"
        )));
        assert!(!is_browser_main(Path::new(
            "/System/Applications/Preview.app/Contents/MacOS/Preview"
        )));
    }

    #[test]
    fn app_path_matching_handles_bundles_and_trailing_slashes() {
        #[cfg(target_os = "macos")]
        {
            assert!(matches_app_path(
                Path::new("/Applications/Foo.app/Contents/MacOS/Foo"),
                "/Applications/Foo.app"
            ));
            assert!(matches_app_path(
                Path::new("/Applications/Foo.app/Contents/MacOS/Foo"),
                "/Applications/Foo.app/"
            ));
            assert!(!matches_app_path(
                Path::new("/Applications/Bar.app/Contents/MacOS/Bar"),
                "/Applications/Foo.app"
            ));
        }
        assert!(matches_app_path(Path::new("/tmp/thing"), "/tmp/thing"));
        assert!(!matches_app_path(Path::new("/tmp/thing"), ""));
    }
}
