// The floating auto-close warning.
//
// Runs in its own borderless always-on-top window, so it is visible even when Flashy
// is minimized — which is the normal case, since you launch a category and then go work
// in the apps it opened.
//
// Self-contained by necessity: this is a separate webview with its own JS heap, so it
// cannot read the main window's Zustand stores. Everything arrives on Tauri events and
// every action goes back out through `invoke`.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlarmClock } from "lucide-react";

interface WarningPayload {
  workspaceId: string;
  workspaceName: string;
  accent: number;
  closeAtMs: number;
}

interface CloseReportish {
  workspaceId: string;
}

/** How long past its deadline a warning may linger before being dropped as stale. */
const STALE_GRACE_MS = 90_000;
/** The warning window the border drains over. Matches WARNING_LEAD_MS in Rust. */
const WARNING_WINDOW_MS = 60_000;

export function CloseOverlay() {
  const [warnings, setWarnings] = useState<WarningPayload[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    function register(promise: Promise<() => void>) {
      void promise.then((un) => (cancelled ? un() : unlisteners.push(un)));
    }

    register(
      listen<WarningPayload>("flashy://close-warning", (event) => {
        setWarnings((prev) => [
          ...prev.filter((w) => w.workspaceId !== event.payload.workspaceId),
          event.payload,
        ]);
      }),
    );

    // Any of these means the schedule is resolved one way or another.
    const clearOn = ["flashy://close-report", "flashy://close-missed", "flashy://close-cancelled"];
    for (const name of clearOn) {
      register(
        listen<CloseReportish | string>(name, (event) => {
          const id = typeof event.payload === "string" ? event.payload : event.payload.workspaceId;
          setWarnings((prev) => prev.filter((w) => w.workspaceId !== id));
        }),
      );
    }

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, []);

  // Only ticks while something is on screen. This window is visible whenever it counts,
  // so unlike the main window's timer it isn't subject to background throttling.
  //
  // The same tick prunes stale entries: Rust hides the window on close, but dropping
  // them here means a later re-show can never flash an expired countdown before the
  // fresh payload lands.
  useEffect(() => {
    if (warnings.length === 0) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setWarnings((prev) => prev.filter((w) => t < w.closeAtMs + STALE_GRACE_MS));
    }, 1000);
    return () => clearInterval(id);
  }, [warnings.length]);

  // Size the window to the rendered card so there is no dead space above or below it,
  // and dismiss the window outright once there is nothing left to show.
  //
  // The self-hide is a backstop for the empty-glass-box failure: the frosting is a
  // native layer that keeps painting even when this component renders null, so if
  // anything ever leaves the window on screen without content, it looks broken.
  // Layout effect so measurement happens before paint, avoiding a visible resize.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) {
      void invoke("hide_overlay").catch(() => {
        /* Non-critical: Rust hides the window on the normal paths anyway. */
      });
      return;
    }
    const height = Math.ceil(el.getBoundingClientRect().height);
    if (height > 0) {
      void invoke("set_overlay_height", { height }).catch(() => {
        /* Window sizing is cosmetic — never let it break the warning. */
      });
    }
  }, [warnings.length]);

  if (warnings.length === 0) return null;

  // Driven by whichever deadline lands first, since that is the one the ring is
  // counting down to. Clamped so a long schedule (or the debug preview) shows a full
  // ring rather than overflowing past 360deg.
  const soonest = Math.min(...warnings.map((w) => w.closeAtMs));
  const fraction = Math.min(1, Math.max(0, (soonest - now) / WARNING_WINDOW_MS));

  return (
    // One rounded card filling the (transparent) window. The frosting itself comes from
    // the native vibrancy layer behind this; the tint here is what keeps it readable —
    // pure vibrancy over a bright browser page washes the text out.
    // `rounded-[20px]` matches CORNER_RADIUS in overlay.rs so the CSS edge and the
    // native effect's edge coincide exactly.
    // Height is intentionally content-driven, not h-svh: the window resizes to match
    // this card (see the layout effect above), so a viewport-height card would measure
    // the window and the two would never converge.
    <div
      ref={cardRef}
      // The faint white border stays as the unfilled track; the gradient ring paints
      // over it for the portion of time remaining.
      className="progress-ring flex max-h-[400px] w-full flex-col gap-1.5 overflow-y-auto rounded-[20px] border border-white/10 bg-card/70 px-3 py-2"
      style={{ "--ring-progress": `${fraction * 360}deg` } as CSSProperties}
    >
      {warnings.map((w) => {
        const seconds = Math.max(0, Math.ceil((w.closeAtMs - now) / 1000));
        return (
          <div key={w.workspaceId} role="alert" className="flex items-center gap-3">
            <span
              className="grid size-8 shrink-0 place-items-center rounded-full"
              style={{ background: `oklch(0.82 0.14 ${w.accent} / 0.22)` }}
            >
              <AlarmClock className="size-4 text-foreground" />
            </span>

            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-semibold text-foreground">
                Closing {w.workspaceName}
              </p>
              <p className="text-xs text-muted-foreground">
                <span aria-hidden="true">in {seconds}s</span>
                <span className="sr-only">Auto-close starts in under a minute.</span>
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                // Disarm first: without it the scheduled timer still fires later and
                // emits a second report with closed: 0, surfacing a bogus
                // "Closed 0 apps" toast after the user already closed everything.
                void invoke("disarm_auto_close", { workspaceId: w.workspaceId })
                  .then(() =>
                    invoke("close_launch_session", {
                      workspaceId: w.workspaceId,
                      opts: { includePreexistingBrowsers: true },
                    }),
                  )
                  .catch((e) => console.error("Flashy: close now failed", e))
              }
              className="shrink-0 rounded-full px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Close now
            </button>
            <button
              type="button"
              onClick={() =>
                void invoke("disarm_auto_close", { workspaceId: w.workspaceId }).catch((e) =>
                  console.error("Flashy: cancel failed", e),
                )
              }
              className="shrink-0 rounded-full border border-primary/50 px-3.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15"
            >
              Cancel
            </button>
          </div>
        );
      })}
    </div>
  );
}
