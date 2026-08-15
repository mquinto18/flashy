// Feature flags.
//
// Flipping one of these is meant to be the whole change — the code behind it stays
// built, tested and committed rather than being deleted and rewritten later.

/**
 * Scheduled auto-close: set a time on a category and everything it opened closes
 * automatically.
 *
 * Off for the MVP, which ships as a launcher only. The feature is complete and its
 * safety guard is unit-tested, but it force-quits applications and has never been run
 * end-to-end against real apps — so it stays hidden until that verification happens
 * (see docs/MVP-LAUNCH.md).
 *
 * Turning it back on: flip this to true AND `AUTO_CLOSE_ENABLED` in
 * `src-tauri/src/proc/overlay.rs`, which gates creating the warning window.
 *
 * Existing `autoCloseAt` values stay in workspaces.json while this is off — nothing is
 * armed, so nothing fires, and a returning user keeps their setting.
 */
export const AUTO_CLOSE_ENABLED = false;
