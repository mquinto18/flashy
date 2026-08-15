import { useState, type SubmitEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2, ShieldCheck, X } from "lucide-react";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { formatTimeOfDay, isTomorrow, nextOccurrence, offsetPreset, parseTimeOfDay } from "../lib/schedule";
import { previewClose, type CloseReport } from "../lib/launchSession";
import type { Workspace } from "../types/workspace";

/** Why a process was spared, in words a user can act on. */
const DENIAL_LABEL: Record<string, string> = {
  protected: "Flashy or its parent",
  low_pid: "system process",
  no_exe: "unidentifiable",
  foreign_user: "another user's",
  system_path: "system file",
  blocked_name: "protected system app",
};

interface SetCloseTimeModalProps {
  isOpen: boolean;
  workspace: Workspace;
  onClose: () => void;
}

type Mode = "1h" | "2h" | "4h" | "custom";

const PRESETS: { value: Exclude<Mode, "custom">; label: string; hours: number }[] = [
  { value: "1h", label: "+1h", hours: 1 },
  { value: "2h", label: "+2h", hours: 2 },
  { value: "4h", label: "+4h", hours: 4 },
];

export function SetCloseTimeModal({ isOpen, workspace, onClose }: SetCloseTimeModalProps) {
  return (
    <AnimatePresence>
      {isOpen && <CloseTimeForm workspace={workspace} onClose={onClose} />}
    </AnimatePresence>
  );
}

/**
 * Split out so it mounts fresh every time the modal opens.
 *
 * That makes the saved time the natural initial state, rather than something an effect
 * has to sync back in — no reset path to forget, and no cascading render.
 */
function CloseTimeForm({ workspace, onClose }: Omit<SetCloseTimeModalProps, "isOpen">) {
  const setAutoCloseAt = useWorkspaceStore((s) => s.setAutoCloseAt);
  const [mode, setMode] = useState<Mode>("custom");
  const [time, setTime] = useState(workspace.autoCloseAt ?? "");
  const [showErrors, setShowErrors] = useState(false);
  const [preview, setPreview] = useState<CloseReport | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  async function handlePreview() {
    setIsPreviewing(true);
    setPreview(await previewClose(workspace.id));
    setIsPreviewing(false);
  }

  function handleClose() {
    onClose();
  }

  function handleRemove() {
    setAutoCloseAt(workspace.id, null);
    handleClose();
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!parseTimeOfDay(time)) {
      setShowErrors(true);
      return;
    }
    setAutoCloseAt(workspace.id, time);
    handleClose();
  }

  const parsed = parseTimeOfDay(time);
  const fireAt = parsed ? nextOccurrence(time) : null;

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={handleClose}
    >
          <motion.form
            onSubmit={handleSubmit}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.15 }}
            className="glass-modal relative w-full max-w-sm rounded-3xl p-6"
          >
            <h2 className="text-lg font-semibold text-foreground">Auto-close {workspace.name}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Everything this category opens gets closed at this time, after a 60-second warning.
              The timer starts when you launch — and Flashy needs to stay open.
            </p>

            <div className="mt-4 grid grid-cols-4 gap-1 rounded-2xl border border-border bg-secondary/20 p-1">
              {PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => {
                    setMode(preset.value);
                    setTime(offsetPreset(preset.hours));
                  }}
                  className={`rounded-xl px-2 py-1.5 text-xs font-medium transition-colors ${
                    mode === preset.value
                      ? "bg-secondary/70 text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setMode("custom")}
                className={`rounded-xl px-2 py-1.5 text-xs font-medium transition-colors ${
                  mode === "custom"
                    ? "bg-secondary/70 text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Custom
              </button>
            </div>

            <input
              type="time"
              step={300}
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                setMode("custom");
              }}
              // color-scheme:dark keeps the native picker indicator legible against the
              // dark glass panel; without it the control renders as a white field.
              className={`mt-3 w-full rounded-2xl border bg-secondary/20 px-3 py-2 text-sm text-foreground outline-none [color-scheme:dark] focus:border-primary/50 ${
                showErrors && !parsed ? "border-destructive" : "border-border"
              }`}
            />
            {showErrors && !parsed && <p className="mt-1 px-1 text-xs text-destructive">Pick a time</p>}

            {parsed && fireAt !== null && (
              <p className="mt-3 rounded-2xl border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
                Next launch closes {isTomorrow(fireAt) ? "tomorrow" : "today"} at{" "}
                <span className="font-semibold text-foreground">{formatTimeOfDay(time)}</span>.
              </p>
            )}

            {/* Dry run. Nothing here signals a process — it's the safe way to confirm
                the aggressive scope is picking the right targets before trusting it. */}
            <div className="mt-4 rounded-2xl border border-border bg-secondary/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">What would close?</span>
                <button
                  type="button"
                  onClick={() => void handlePreview()}
                  disabled={isPreviewing}
                  className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-50"
                >
                  {isPreviewing ? <Loader2 className="size-3 animate-spin" /> : null}
                  {preview ? "Re-check" : "Preview"}
                </button>
              </div>

              {preview && (
                <div className="mt-2 max-h-40 overflow-y-auto">
                  {preview.outcomes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Nothing tracked yet. Launch this category, then preview again.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {preview.outcomes.map((o) => {
                        const willClose = o.result.kind === "wouldClose";
                        return (
                          <li key={o.pid} className="flex items-center gap-2 text-xs">
                            {willClose ? (
                              <X className="size-3 shrink-0 text-destructive" />
                            ) : (
                              <ShieldCheck className="size-3 shrink-0 text-primary" />
                            )}
                            <span
                              className={`min-w-0 flex-1 truncate ${
                                willClose ? "text-foreground" : "text-muted-foreground"
                              }`}
                            >
                              {o.name}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {willClose
                                ? "closes"
                                : `spared · ${DENIAL_LABEL[o.result.reason ?? ""] ?? o.result.kind}`}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="mt-6 flex items-center justify-between gap-2">
              {workspace.autoCloseAt ? (
                <button
                  type="button"
                  onClick={handleRemove}
                  className="rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-destructive"
                >
                  Remove
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-full px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-brand-gradient rounded-full px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.02] active:scale-[0.99]"
                >
                  Save
                </button>
              </div>
      </div>
      </motion.form>
    </motion.div>
  );
}
