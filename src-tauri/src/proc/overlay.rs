//! The always-on-top warning panel.
//!
//! The in-app countdown is only visible when Flashy is, which is the wrong time — the
//! whole point of a scheduled close is that you launched a category and went off to
//! work in the apps it opened. This is a second, borderless window that floats above
//! everything so the warning (and its Cancel button) can't be missed.
//!
//! Rust owns the window rather than the frontend: creating and positioning it here is
//! not ACL-gated, so the overlay's own webview needs nothing beyond permission to
//! listen for events.
//!
//! Every failure path here is logged and swallowed. A machine where this window can't
//! be created must still launch and close normally — the frontend falls back to the
//! in-app countdown via [`is_available`].

use tauri::utils::{WindowEffect, WindowEffectState};
use tauri::utils::config::WindowEffectsConfig;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "close-overlay";

/// Gates creating the warning window at all.
///
/// Must stay in sync with `AUTO_CLOSE_ENABLED` in `src/lib/features.ts`. That flag is
/// what actually prevents anything being closed (nothing arms, so no timer runs); this
/// one just avoids paying for a second webview process that would never be shown.
const AUTO_CLOSE_ENABLED: bool = false;

/// Logical width of the panel. Height is measured from content — see [`set_height`].
const WIDTH: f64 = 420.0;
/// Starting height; replaced as soon as the overlay reports its real content height.
const HEIGHT: f64 = 64.0;
const MIN_HEIGHT: f64 = 44.0;
const MAX_HEIGHT: f64 = 400.0;
/// Gap below the top of the work area, so it reads as a floating panel.
const TOP_MARGIN: f64 = 16.0;
/// Corner radius of the native vibrancy layer. The CSS card matches this.
const CORNER_RADIUS: f64 = 20.0;

/// Build the overlay, hidden. Called once from `setup`.
pub fn create(app: &tauri::AppHandle) {
    if !AUTO_CLOSE_ENABLED {
        log::info!("flashy: auto-close disabled; skipping close overlay");
        return;
    }
    if app.get_webview_window(LABEL).is_some() {
        return;
    }

    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("Flashy auto-close")
        .inner_size(WIDTH, HEIGHT)
        // A bare panel: no chrome, no dock entry, not resizable, and never focused —
        // it must not steal focus from whatever the user is actually doing.
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        // Transparent so only the rounded card shows.
        .transparent(true)
        // Native shadow rather than a CSS one: the card fills the window, so a CSS
        // box-shadow would be clipped by the window bounds and never appear. macOS
        // derives this shadow from the rendered alpha, so it follows the rounded
        // vibrancy layer rather than the square window rect.
        .shadow(true)
        // Real glass. A CSS backdrop-filter cannot blur other applications, only
        // same-document content, so the frosting has to come from a native
        // NSVisualEffectView. `radius` rounds that layer to match the CSS card.
        .effects(WindowEffectsConfig {
            effects: vec![WindowEffect::HudWindow],
            state: Some(WindowEffectState::Active),
            radius: Some(CORNER_RADIUS),
            color: None,
        })
        // Without this, macOS swallows the first click as a focus click and Cancel
        // would need clicking twice on a window that is deliberately never focused.
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true);

    if let Some((x, y)) = top_center_position(app) {
        builder = builder.position(x, y);
    }

    match builder.build() {
        Ok(window) => {
            apply_native_float(app);
            // Belt and braces. `visible(false)` above should be enough, but the native
            // vibrancy layer paints even with no DOM content, so anything that reveals
            // this window early shows as an empty glass box sitting on the desktop.
            let _ = window.hide();
            log::info!("flashy: close overlay created");
        }
        Err(e) => log::warn!("flashy: could not create close overlay ({e}); falling back to in-app countdown"),
    }
}

/// Make the panel float over apps in native fullscreen.
///
/// Two things are needed, and Tauri gives neither:
///
/// 1. **Collection behavior.** `visible_on_all_workspaces(true)` sets only
///    `CanJoinAllSpaces`, which covers ordinary Spaces. macOS treats a fullscreen app as
///    its own Space and additionally requires `FullScreenAuxiliary` — a flag that
///    appears nowhere in tao.
/// 2. **Window level.** `always_on_top(true)` maps to `NSFloatingWindowLevel`, which is
///    only 3. A fullscreen app's Space sits well above that, so the panel stays hidden
///    behind it. Overlays that must be seen (launchers, password managers) use
///    `NSPopUpMenuWindowLevel`.
///
/// Re-applied on every show, because `set_always_on_top` resets the level back to 3.
///
/// Dispatched to the main thread: AppKit requires it, and `show` is driven from the
/// auto-close timer thread.
/// Configure the panel's floating behaviour without revealing it.
///
/// Safe to call on the hidden window at creation time.
#[cfg(target_os = "macos")]
pub fn apply_native_float(app: &tauri::AppHandle) {
    apply_native_float_inner(app, false, None);
}

/// Apply the float behaviour, optionally ordering the window front, and — when
/// `notify_for` is set — fall back to a system notification if the panel turns out not
/// to be on the user's active Space.
///
/// `order_front` must stay false anywhere the window is meant to remain hidden:
/// `orderFrontRegardless` *reveals* a window, so calling it at creation would leave an
/// empty glass box on screen from launch (the vibrancy layer is native and paints even
/// with no DOM content).
#[cfg(target_os = "macos")]
fn apply_native_float_inner(app: &tauri::AppHandle, order_front: bool, notify_for: Option<String>) {
    let app = app.clone();
    let result = app.clone().run_on_main_thread(move || {
        use objc2_app_kit::{NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior};

        let Some(window) = app.get_webview_window(LABEL) else { return };
        let Ok(ptr) = window.ns_window() else {
            log::warn!("flashy: no ns_window handle; overlay will not clear fullscreen apps");
            if let Some(name) = notify_for.as_deref() {
                notify_fallback(&app, name);
            }
            return;
        };
        if ptr.is_null() {
            return;
        }

        // Safety: `ns_window()` returns this window's live NSWindow, and this closure is
        // running on the main thread. The reference is borrowed only for these calls.
        unsafe {
            let ns_window: &NSWindow = &*(ptr as *const NSWindow);
            let behavior = ns_window.collectionBehavior()
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary;
            ns_window.setCollectionBehavior(behavior);
            ns_window.setLevel(NSPopUpMenuWindowLevel);

            // `orderFront:` (what tao's show() uses) can be ignored for a background
            // app. The "regardless" variant ignores app activation state, which is the
            // situation here — we deliberately never take focus. Only on the show path:
            // this reveals the window.
            if order_front {
                ns_window.orderFrontRegardless();
            }

            // Read back rather than assume: AppKit silently ignores some combinations,
            // and this is the only way to tell "we set it" from "it took effect".
            let applied = ns_window.collectionBehavior();
            let on_active_space = ns_window.isOnActiveSpace();
            log::info!(
                "flashy: overlay level={} behavior={:?} (canJoinAllSpaces={}, fullScreenAuxiliary={}) onActiveSpace={}",
                ns_window.level(),
                applied,
                applied.contains(NSWindowCollectionBehavior::CanJoinAllSpaces),
                applied.contains(NSWindowCollectionBehavior::FullScreenAuxiliary),
                on_active_space,
            );

            // The authoritative "can the user actually see this?" check. If the panel
            // failed to join the active Space — the fullscreen case — the warning would
            // otherwise pass silently, so escalate to a notification.
            if let Some(name) = notify_for.as_deref() {
                if !on_active_space {
                    log::info!("flashy: overlay not on active space; sending notification instead");
                    notify_fallback(&app, name);
                }
            }
        }
    });
    if let Err(e) = result {
        log::warn!("flashy: could not apply overlay float behaviour: {e}");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn apply_native_float(_app: &tauri::AppHandle) {}

/// Last-resort warning when the panel cannot be seen.
///
/// Text only, and that is a platform limit rather than a choice: Tauri's notification
/// Actions API is mobile-only, so there is no way to put a Cancel button on a desktop
/// notification. Clicking it raises Flashy, where the countdown and its Cancel button
/// are. Silently does nothing if notifications are denied or suppressed by a Focus mode.
fn notify_fallback(app: &tauri::AppHandle, workspace_name: &str) {
    use tauri_plugin_notification::NotificationExt;

    let result = app
        .notification()
        .builder()
        .title(format!("Closing {workspace_name}"))
        .body("Flashy closes this category in under a minute. Open Flashy to cancel.")
        .show();

    if let Err(e) = result {
        log::warn!("flashy: notification fallback failed: {e}");
    }
}

/// Briefly present as an accessory app so the panel can enter another app's fullscreen
/// Space.
///
/// The collection behavior and window level are provably correct (they read back as
/// `level=101, canJoinAllSpaces=true, fullScreenAuxiliary=true`), yet a fullscreen app
/// still covers the panel. The remaining difference between us and the tools that manage
/// this — Alfred, Bartender, and friends — is that they run as accessory apps. macOS
/// does not let a regular, Dock-icon app composite into another app's fullscreen Space.
///
/// Scoped to just the warning: accessory mode is restored to regular as soon as the
/// panel hides, so the Dock icon is only absent for the countdown. The policy is
/// per-process runtime state, so an unexpected exit cannot leave it stuck.
#[cfg(target_os = "macos")]
fn set_accessory_mode(app: &tauri::AppHandle, accessory: bool) {
    let _ = app.clone().run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

        let Some(mtm) = MainThreadMarker::new() else { return };
        let policy = if accessory {
            NSApplicationActivationPolicy::Accessory
        } else {
            NSApplicationActivationPolicy::Regular
        };
        let applied = NSApplication::sharedApplication(mtm).setActivationPolicy(policy);
        log::info!("flashy: activation policy accessory={accessory} applied={applied}");
    });
}

#[cfg(not(target_os = "macos"))]
fn set_accessory_mode(_app: &tauri::AppHandle, _accessory: bool) {}

/// Top-center of the primary monitor's work area, in logical pixels.
///
/// `work_area` rather than `size` so the panel clears the menu bar, and the result is
/// divided by the scale factor because monitor geometry is physical while the builder's
/// `position` is logical.
fn top_center_position(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return None;
    }

    let area = monitor.work_area();
    let area_x = area.position.x as f64 / scale;
    let area_y = area.position.y as f64 / scale;
    let area_w = area.size.width as f64 / scale;

    Some((area_x + (area_w - WIDTH) / 2.0, area_y + TOP_MARGIN))
}

pub fn is_available(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

/// Resize the panel to exactly fit its rendered content.
///
/// A fixed height leaves dead space above and below a single warning, and clips when two
/// are showing. The overlay measures itself after render and calls this, so the card is
/// always snug regardless of how many warnings are up.
pub fn set_height(app: &tauri::AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    // Clamped so a measurement bug can't produce a zero-height or screen-filling panel.
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let _ = window.set_size(tauri::LogicalSize::new(WIDTH, height));
    if let Some((x, y)) = top_center_position(app) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

/// Show the panel. `workspace_name` is used only if the panel turns out to be invisible
/// and the warning has to be escalated to a notification.
pub fn show(app: &tauri::AppHandle, workspace_name: &str) {
    let Some(window) = app.get_webview_window(LABEL) else {
        // No overlay at all — the warning still has to reach the user somehow.
        #[cfg(target_os = "macos")]
        notify_fallback(app, workspace_name);
        return;
    };
    // Re-assert position on every show: the panel may have been created before an
    // external display was attached.
    if let Some((x, y)) = top_center_position(app) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    // Before showing: a regular app's window will not join another app's fullscreen
    // Space, so drop to accessory for the duration of the warning.
    set_accessory_mode(app, true);

    if let Err(e) = window.show() {
        log::warn!("flashy: could not show close overlay: {e}");
        set_accessory_mode(app, false);
        #[cfg(target_os = "macos")]
        notify_fallback(app, workspace_name);
        return;
    }

    // Deliberately not `set_always_on_top`: that would drop the window back to
    // NSFloatingWindowLevel and undo the fullscreen handling. This also verifies the
    // panel really landed on the active Space, falling back to a notification if not.
    #[cfg(target_os = "macos")]
    apply_native_float_inner(app, true, Some(workspace_name.to_string()));
    #[cfg(not(target_os = "macos"))]
    apply_native_float(app);
}

pub fn hide(app: &tauri::AppHandle) {
    // Both steps run in one main-thread closure, in this order, deliberately.
    //
    // Restoring the activation policy re-activates the app, and AppKit re-orders windows
    // front when that happens — so a hide issued on a separate queue beforehand could be
    // undone, leaving an empty glass box on screen. Doing the policy change first and
    // hiding after means the hide always has the last word.
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let result = app.clone().run_on_main_thread(move || {
            use objc2::MainThreadMarker;
            use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

            if let Some(mtm) = MainThreadMarker::new() {
                let applied = NSApplication::sharedApplication(mtm)
                    .setActivationPolicy(NSApplicationActivationPolicy::Regular);
                log::info!("flashy: activation policy accessory=false applied={applied}");
            }
            if let Some(window) = handle.get_webview_window(LABEL) {
                let _ = window.hide();
            }
        });
        if result.is_err() {
            // Main thread unreachable — hide directly rather than leave it on screen.
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.hide();
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}
