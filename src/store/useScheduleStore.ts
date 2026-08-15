// Auto-close scheduling.
//
// Rust owns the authoritative timer (a webview's timers get throttled when the window
// is backgrounded, and a long JS setTimeout can't survive machine sleep). This store
// mirrors that schedule so the UI can display it, and drives the countdown once Rust
// says the fire moment is near.

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "./useWorkspaceStore";
import { useToastStore } from "./useToastStore";
import { nextOccurrence } from "../lib/schedule";
import { armAutoClose, closeLaunchSession, disarmAutoClose, type CloseReport } from "../lib/launchSession";

/** How long before the close a countdown appears. Must match WARNING_LEAD_MS in Rust. */
export const WARNING_MS = 60_000;

/** Countdown visible: tick every second. */
const TICK_ACTIVE_MS = 1000;
/** Armed but nothing imminent: just enough to keep the display honest. */
const TICK_IDLE_MS = 5000;

export type ArmedPhase = "armed" | "warning";

export interface ArmedClose {
  workspaceId: string;
  /** Snapshotted so the countdown still renders coherently if the category is deleted. */
  workspaceName: string;
  accent: number;
  /** Epoch ms at which the close executes. */
  fireAt: number;
  phase: ArmedPhase;
}

interface ScheduleState {
  armedCloses: Record<string, ArmedClose>;
  /** Ticker-driven clock. Only written while a countdown is on screen. */
  now: number;
  /** Guards against firing a close twice for the same category. */
  closingIds: string[];

  arm: (workspaceId: string) => void;
  disarm: (workspaceId: string) => void;
  closeNow: (workspaceId: string) => Promise<void>;
}

export const useScheduleStore = create<ScheduleState>()(
  subscribeWithSelector((set, get) => ({
    armedCloses: {},
    now: Date.now(),
    closingIds: [],

    arm: (workspaceId) => {
      const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
      if (!workspace?.autoCloseAt) return;
      // Nothing was opened, so there is nothing to close.
      if (workspace.items.length === 0) return;

      const fireAt = nextOccurrence(workspace.autoCloseAt);
      if (fireAt === null) return; // Malformed value in workspaces.json.

      // Aggressive scope: Rust ANDs this with the session's recorded hasWebsiteItems,
      // so it can only ever apply to a category that actually opened a website.
      void armAutoClose(workspaceId, fireAt, workspace.name, workspace.accent, {
        includePreexistingBrowsers: true,
      });

      set((s) => ({
        armedCloses: {
          ...s.armedCloses,
          // Overwritten wholesale: re-launching resets the phase, which also dismisses
          // an in-flight countdown.
          [workspaceId]: {
            workspaceId,
            workspaceName: workspace.name,
            accent: workspace.accent,
            fireAt,
            phase: "armed",
          },
        },
      }));
    },

    disarm: (workspaceId) => {
      void disarmAutoClose(workspaceId);
      set((s) => {
        const armedCloses = { ...s.armedCloses };
        delete armedCloses[workspaceId];
        return { armedCloses };
      });
    },

    closeNow: async (workspaceId) => {
      const entry = get().armedCloses[workspaceId];
      if (!entry) return;
      if (get().closingIds.includes(workspaceId)) return;

      // Cancel the Rust timer first so it can't also fire.
      void disarmAutoClose(workspaceId);

      set((s) => {
        const armedCloses = { ...s.armedCloses };
        delete armedCloses[workspaceId];
        return { armedCloses, closingIds: [...s.closingIds, workspaceId] };
      });

      await closeLaunchSession(workspaceId, { includePreexistingBrowsers: true });
      set((s) => ({ closingIds: s.closingIds.filter((id) => id !== workspaceId) }));
    },
  })),
);

// --- Ticker -----------------------------------------------------------------
// A module-level singleton rather than a React hook: it must outlive FlashyIsland
// (which unmounts on "Back to start") and must not double-register under StrictMode.
// Being idempotent by construction makes both properties structural rather than
// dependent on where someone remembered to mount a hook.

let tickHandle: ReturnType<typeof setInterval> | undefined;
let tickRate = 0;

/**
 * How long past the fire time we keep showing a countdown before giving up on it.
 *
 * Rust owns the fire decision and reports back via close-report / close-missed, so the
 * only way an entry outlives its own deadline is if that report never arrives (backend
 * error, command not registered). Without this the countdown would sit at "in 0s"
 * forever with a Cancel button that cancels nothing.
 */
const REPORT_GRACE_MS = 90_000;

function tick() {
  const now = Date.now();
  const { armedCloses } = useScheduleStore.getState();

  let changed = false;
  const next = { ...armedCloses };

  for (const entry of Object.values(armedCloses)) {
    if (now > entry.fireAt + REPORT_GRACE_MS) {
      delete next[entry.workspaceId];
      changed = true;
      continue;
    }
    if (entry.phase === "armed" && now >= entry.fireAt - WARNING_MS) {
      next[entry.workspaceId] = { ...entry, phase: "warning" };
      changed = true;
    }
  }

  const hasWarning = Object.values(next).some((e) => e.phase === "warning");
  // `now` is only written while a countdown is visible, so idle ticks cause no renders.
  if (changed || hasWarning) {
    useScheduleStore.setState(hasWarning ? { armedCloses: next, now } : { armedCloses: next });
  }
}

function ensureTicker(rate: number) {
  if (tickHandle !== undefined && tickRate === rate) return;
  if (tickHandle !== undefined) clearInterval(tickHandle);
  tickRate = rate;
  tickHandle = setInterval(tick, rate);
}

function stopTicker() {
  if (tickHandle !== undefined) clearInterval(tickHandle);
  tickHandle = undefined;
  tickRate = 0;
}

useScheduleStore.subscribe(
  (s) => {
    const entries = Object.values(s.armedCloses);
    if (entries.length === 0) return 0;
    return entries.some((e) => e.phase === "warning") ? TICK_ACTIVE_MS : TICK_IDLE_MS;
  },
  (rate) => (rate === 0 ? stopTicker() : ensureTicker(rate)),
  { fireImmediately: true },
);

if (import.meta.hot) import.meta.hot.dispose(stopTicker);

// --- Wiring -----------------------------------------------------------------
// Dependencies point one way only (schedule -> workspace), so there is no ESM cycle.

/** Arm whenever a launch completes. */
useWorkspaceStore.subscribe(
  (s) => s.lastLaunch,
  (lastLaunch) => {
    if (lastLaunch) useScheduleStore.getState().arm(lastLaunch.workspaceId);
  },
);

/** Reconcile armed schedules against category edits: delete, retime, and clear. */
useWorkspaceStore.subscribe(
  (s) => s.workspaces,
  (workspaces) => {
    const { armedCloses } = useScheduleStore.getState();
    const ids = Object.keys(armedCloses);
    if (ids.length === 0) return;

    let changed = false;
    const next = { ...armedCloses };

    for (const id of ids) {
      const workspace = workspaces.find((w) => w.id === id);

      // Category deleted, or its close time cleared.
      if (!workspace?.autoCloseAt) {
        void disarmAutoClose(id);
        delete next[id];
        changed = true;
        continue;
      }

      const fireAt = nextOccurrence(workspace.autoCloseAt);
      if (fireAt === null) {
        void disarmAutoClose(id);
        delete next[id];
        changed = true;
      } else if (fireAt !== next[id].fireAt || workspace.name !== next[id].workspaceName) {
        // Re-time in Rust too, and drop back out of warning: pushing the time out
        // mid-countdown should dismiss the countdown.
        void armAutoClose(id, fireAt, workspace.name, workspace.accent, {
          includePreexistingBrowsers: true,
        });
        next[id] = { ...next[id], fireAt, phase: "armed", workspaceName: workspace.name };
        changed = true;
      }
    }

    if (changed) useScheduleStore.setState({ armedCloses: next });
  },
);

// --- Backend events ---------------------------------------------------------

function clearArmed(workspaceId: string) {
  useScheduleStore.setState((s) => {
    const armedCloses = { ...s.armedCloses };
    delete armedCloses[workspaceId];
    return { armedCloses };
  });
}

/**
 * Best-effort display name.
 *
 * Checks the workspace store first because `closeNow` removes the armed entry before
 * the report comes back, and falls back to the armed snapshot so a category deleted
 * mid-close still reads coherently.
 */
function workspaceName(workspaceId: string, fallback = "category"): string {
  return (
    useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.name ??
    useScheduleStore.getState().armedCloses[workspaceId]?.workspaceName ??
    fallback
  );
}

/**
 * Rust's wall-clock timer is the authoritative warning signal.
 *
 * The local ticker below also promotes entries to "warning", but macOS throttles JS
 * timers in a backgrounded webview — precisely when the app is minimized and the user
 * most needs the warning. This listener is immune to that.
 */
void listen<{ workspaceId: string }>("flashy://close-warning", (event) => {
  const { workspaceId } = event.payload;
  useScheduleStore.setState((s) => {
    const entry = s.armedCloses[workspaceId];
    if (!entry || entry.phase === "warning") return s;
    return { armedCloses: { ...s.armedCloses, [workspaceId]: { ...entry, phase: "warning" } } };
  });
});

/** Cancelled from the overlay window, which has its own JS heap and can't reach here. */
void listen<string>("flashy://close-cancelled", (event) => {
  clearArmed(event.payload);
});

void listen<CloseReport>("flashy://close-report", (event) => {
  const report = event.payload;
  const name = workspaceName(report.workspaceId);
  clearArmed(report.workspaceId);

  if (report.dryRun) {
    useToastStore.getState().show(`Dry run: would close ${report.closed} from ${name}`);
    return;
  }

  const noun = report.closed === 1 ? "app" : "apps";
  const suffix = report.failed > 0 ? ` (${report.failed} failed)` : "";
  useToastStore.getState().show(`Closed ${report.closed} ${noun} from ${name}${suffix}`);
});

void listen<string>("flashy://close-missed", (event) => {
  const workspaceId = event.payload;
  const name = workspaceName(workspaceId, "A category");
  clearArmed(workspaceId);
  useToastStore.getState().show(`${name} auto-close was missed while away`);
});
