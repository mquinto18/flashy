import { AnimatePresence, motion } from "motion/react";
import { AlarmClock } from "lucide-react";
import { useScheduleStore, WARNING_MS } from "../store/useScheduleStore";

/**
 * The last chance to stop a destructive close.
 *
 * Deliberately not routed through the toast system: that store is single-slot, so a
 * routine toast (dropping a file, finishing a launch) would silently replace this and
 * take the Cancel button with it. Toast's container is also pointer-events-none.
 */
export function CloseCountdown() {
  const armedCloses = useScheduleStore((s) => s.armedCloses);
  const now = useScheduleStore((s) => s.now);
  const disarm = useScheduleStore((s) => s.disarm);
  const closeNow = useScheduleStore((s) => s.closeNow);

  const warnings = Object.values(armedCloses).filter((e) => e.phase === "warning");

  return (
    // z-[60] keeps it above the z-50 modals; a countdown that can hide behind a dialog
    // is a bug. Top-center avoids the toast lane at bottom-6.
    <div className="pointer-events-none fixed inset-x-0 top-6 z-[60] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {warnings.map((entry) => {
          const remainingMs = Math.max(0, entry.fireAt - now);
          const seconds = Math.ceil(remainingMs / 1000);

          return (
            <motion.div
              key={entry.workspaceId}
              role="alert"
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16, scale: 0.96 }}
              transition={{ duration: 0.2 }}
              className="glass-strong pointer-events-auto relative w-full max-w-md overflow-hidden rounded-3xl px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span
                  className="grid size-9 shrink-0 place-items-center rounded-full"
                  style={{ background: `oklch(0.82 0.14 ${entry.accent} / 0.2)` }}
                >
                  <AlarmClock className="size-4 text-foreground" />
                </span>

                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate text-sm font-semibold text-foreground">
                    Closing {entry.workspaceName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {/* The ticking number is hidden from screen readers so they aren't
                        spammed once a second; the static sentence carries the meaning. */}
                    <span aria-hidden="true">in {seconds}s</span>
                    <span className="sr-only">Auto-close starts in under a minute.</span>
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => void closeNow(entry.workspaceId)}
                  className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Close now
                </button>
                <button
                  type="button"
                  onClick={() => disarm(entry.workspaceId)}
                  className="shrink-0 rounded-full border border-primary/50 px-4 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15"
                >
                  Cancel
                </button>
              </div>

              <motion.div
                className="absolute inset-x-0 bottom-0 h-0.5 bg-primary"
                animate={{ width: `${(remainingMs / WARNING_MS) * 100}%` }}
                transition={{ duration: 1, ease: "linear" }}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
