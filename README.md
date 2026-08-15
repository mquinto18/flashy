# Flashy

A desktop launcher. Group the apps, websites and files you use together into a
category, open them all with one click — and optionally have them all close again at a
time you set.

Built with Tauri v2 (Rust) + React 19 + TypeScript + Vite + Tailwind v4.

---

## Running the app

### The built app

```bash
open /Users/janmatthewquinto/flashy/src-tauri/target/release/bundle/macos/Flashy.app
```

This is the real thing: the Flashy bolt icon, named "Flashy" in the Dock. Install it
properly with:

```bash
cp -R src-tauri/target/release/bundle/macos/Flashy.app /Applications/
```

Then launch it from Spotlight or Launchpad like any other app.

### Development

```bash
npm run tauri dev
```

Hot-reloads the frontend on save. Rust changes trigger a rebuild automatically.

> **The Dock icon will be Tauri's default logo, labelled `app`.** That is expected and
> not a bug. Icons and the product name are *bundle* metadata, and dev runs a bare
> executable rather than a `.app`. Only the built app shows the bolt.

### Frontend only, in a browser

```bash
npm run dev
```

Opens at `http://localhost:5173`. Useful for pure UI work, but anything calling Rust
(launching, closing, process tracking) will fail — those commands do not exist outside
the Tauri shell.

---

## Building

```bash
npm run tauri build
```

Takes a few minutes. Outputs to `src-tauri/target/release/bundle/`:

| Artifact | Purpose |
|---|---|
| `macos/Flashy.app` | the app itself |
| `dmg/Flashy_0.1.0_x64.dmg` | installer, for giving to other people |

### If the `.dmg` step fails

Anything that shadows the system `head` on your `PATH` breaks `bundle_dmg.sh`, which
uses it internally. XAMPP is a common culprit — it ships a Perl `head` (an HTTP client,
not the line-reader) and puts its `bin` ahead of `/usr/bin`. The Tauri CLI swallows the
script's stderr, so the error you see is an unhelpful `failed to run bundle_dmg.sh`.

Check with `which -a head`. If a non-`/usr/bin` copy wins, build with:

```bash
PATH="/usr/bin:$PATH" npm run tauri build
```

Every failed DMG run also leaves a mounted temp image behind, which blocks the next
attempt. Clean up with:

```bash
for d in $(hdiutil info | awk '/^\/dev\/disk/{print $1}' | sort -u); do hdiutil detach "$d" -force 2>/dev/null; done
rm -f src-tauri/target/release/bundle/macos/rw.*.dmg
```

The permanent fix is to move the offending directory *after* the system paths in
`~/.zshrc`:

```bash
export PATH="$PATH:/Applications/XAMPP/xamppfiles/bin"
```

---

## Prerequisites

| | |
|---|---|
| Node | 18+ (developed on 24) |
| Rust | 1.77.2+ (`rustup` recommended) |
| Xcode CLT | for the macOS build |

```bash
npm install
```

Rust dependencies are fetched automatically on first build. If `cargo` is not found
after installing via rustup, your shell may not be sourcing it — add
`. "$HOME/.cargo/env"` to `~/.zshrc`.

---

## Tests and checks

```bash
cd src-tauri && cargo test --lib   # process guard + path classification
cd src-tauri && cargo clippy --lib
npx tsc -b                          # typecheck
npx eslint src --max-warnings=0
npm run build                       # must emit both index.html and overlay.html
```

The Rust tests are the important ones. They cover the safety guard that decides whether
a process may be closed, including live-system checks asserting that Flashy itself, its
ancestors, and every blocklisted system process are always spared.

---

## Auto-close

> **Hidden in the current build.** The MVP ships as a launcher only. The feature is
> complete and its safety guard is unit-tested, but it force-quits applications and has
> not been verified end-to-end against real apps, so it stays off until it is.
>
> To enable: set `AUTO_CLOSE_ENABLED = true` in `src/lib/features.ts` **and**
> `AUTO_CLOSE_ENABLED` in `src-tauri/src/proc/overlay.rs`. The frontend flag is the one
> that matters — with nothing armed, no timer runs and nothing can be closed. The Rust
> flag only avoids creating a webview that would never be shown.

Set a time on a category with the clock button, then launch it. At that time, everything
the launch opened is closed, after a 60-second warning with a Cancel button.

**Flashy must stay running** for the schedule to fire. The tracked process list is held
in memory on purpose and never written to disk — restoring PIDs from a previous session
would mean acting on whatever unrelated processes inherited those numbers.

### Previewing what will close

Because this force-quits applications, there is a dry run. Open the clock modal after
launching a category and press **Preview** — it lists exactly what would be closed and
what would be spared, without signalling anything.

Worth doing once before trusting a schedule with real work.

### How it decides what to close

It does not track what it launched — it *observes what appeared*. A website item stores
a URL and a file item stores a document path; neither names a process. On macOS,
opening anything goes through LaunchServices, which re-parents the result to PID 1, so
there is no parent-child link back to Flashy either.

Instead: snapshot every running PID before the launch, snapshot again after, and treat
the difference as the set that launch is responsible for. This has a useful safety
property — a browser that was *already* running is in the baseline, so it never lands in
the diff and its existing tabs survive.

### Limitations

- **SIGTERM is not Cmd-Q.** Plain AppKit document apps (Preview, TextEdit) take the
  default disposition and exit immediately without a save prompt. Chrome, Firefox and
  Electron apps do shut down cleanly. Unsaved work in some apps may be lost.
- **Slow-starting apps may be missed.** Attribution stops sweeping ~10s after launch.
- **Fullscreen on macOS.** The warning overlay cannot always enter another app's
  fullscreen Space. When it detects this (`NSWindow.isOnActiveSpace`), it falls back to
  a system notification. Notifications only work from the **built** app, not `tauri dev`.

---

## Project layout

```
src/
  components/      UI. CloseOverlay renders in its own window, not the main one.
  store/           Zustand. useWorkspaceStore = data, useScheduleStore = auto-close.
  lib/             Pure helpers: schedule math, item detection, Rust command wrappers.
  pages/           Start / loading / app screens.
overlay.html       Second entry point — the floating warning window.
src-tauri/src/
  lib.rs           Commands + Tauri builder.
  proc/            Process launching, tracking, safety guard, closing, overlay window.
```

Two things that are easy to trip over:

- **`overlay.html` is a real second entry point.** It runs in its own webview with its
  own JS heap, so it cannot read the Zustand stores — it communicates purely over Tauri
  events. Both entries are registered in `vite.config.ts`; removing one breaks the
  overlay in production only.
- **`workspaces.json`** lives in the OS app-data directory, not the repo. Every mutation
  to `state.workspaces` rewrites it. Anything added to the top-level store instead of
  the workspace object will not persist.

---

## Platform notes

**macOS.** `macOSPrivateApi` is enabled so the warning overlay can have a transparent,
rounded window. This rules out Mac App Store distribution; direct distribution is
unaffected. Never enable sysinfo's `apple-sandbox` feature or sandbox the app — under
App Sandbox the process list is restricted to your own processes and the close path
silently becomes a no-op.

**Windows.** Should build with `npm run tauri build` after `npm install`; the icons are
committed, so nothing needs regenerating. Two known differences: notifications only work
for *installed* apps (in dev they show with a PowerShell name and icon), and process
attribution is looser than on macOS, so an app opened by hand during the ~10s window
after a launch could be adopted into the session. Untested on real hardware.
