import { useEffect, useState, type SubmitEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { detectTypeFromPath, fileNameFromPath } from "../lib/detectItem";
import type { WorkspaceItemType } from "../types/workspace";

interface AddItemModalProps {
  isOpen: boolean;
  workspaceId: string;
  onClose: () => void;
}

const TYPE_OPTIONS: { value: WorkspaceItemType; label: string }[] = [
  { value: "application", label: "Application" },
  { value: "website", label: "Website" },
  { value: "file", label: "File" },
  { value: "folder", label: "Folder" },
];

export function AddItemModal({ isOpen, workspaceId, onClose }: AddItemModalProps) {
  const addItem = useWorkspaceStore((s) => s.addItem);
  const [type, setType] = useState<WorkspaceItemType>("application");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        switch (event.payload.type) {
          case "enter":
          case "over":
            setIsDragOver(true);
            break;
          case "drop": {
            setIsDragOver(false);
            const droppedPath = event.payload.paths[0];
            if (!droppedPath) break;
            setType(detectTypeFromPath(droppedPath));
            setPath(droppedPath);
            setName((prev) => (prev.trim() ? prev : fileNameFromPath(droppedPath)));
            break;
          }
          case "leave":
            setIsDragOver(false);
            break;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isOpen]);

  function reset() {
    setType("application");
    setName("");
    setPath("");
    setUrl("");
    setShowErrors(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleBrowse() {
    const selection = await open(
      type === "application"
        ? { multiple: false, directory: false, filters: [{ name: "Application", extensions: ["exe"] }] }
        : { multiple: false, directory: type === "folder" },
    );
    if (typeof selection !== "string") return;
    setPath(selection);
    if (!name.trim()) setName(fileNameFromPath(selection));
  }

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();

    const isNameValid = name.trim().length > 0;
    const isValueValid = type === "website" ? url.trim().length > 0 : path.trim().length > 0;
    if (!isNameValid || !isValueValid) {
      setShowErrors(true);
      return;
    }

    if (type === "website") {
      const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      addItem(workspaceId, { type: "website", name, url: normalizedUrl });
    } else {
      addItem(workspaceId, { type, name, path });
    }

    handleClose();
  }

  return (
    <AnimatePresence>
      {isOpen && (
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
            className={`glass-strong relative w-full max-w-sm rounded-3xl p-6 transition-colors ${
              isDragOver ? "border-primary/70" : ""
            }`}
          >
            <AnimatePresence>
              {isDragOver && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-3xl border border-dashed border-primary/70 bg-primary/10 text-sm font-medium text-primary"
                >
                  Drop to add
                </motion.div>
              )}
            </AnimatePresence>

            <h2 className="text-lg font-semibold text-foreground">Add item</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Drag a file, folder, or application into this window, or use Browse below.
            </p>

            <div className="mt-4 grid grid-cols-4 gap-1 rounded-2xl border border-border bg-secondary/20 p-1">
              {TYPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setType(option.value);
                    setPath("");
                  }}
                  className={`rounded-xl px-2 py-1.5 text-xs font-medium transition-colors ${
                    type === option.value
                      ? "bg-secondary/70 text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              className={`mt-4 w-full rounded-2xl border bg-secondary/20 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 ${
                showErrors && !name.trim() ? "border-destructive" : "border-border"
              }`}
            />
            {showErrors && !name.trim() && <p className="mt-1 px-1 text-xs text-destructive">Name is required</p>}

            {type === "website" ? (
              <>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                  className={`mt-3 w-full rounded-2xl border bg-secondary/20 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 ${
                    showErrors && !url.trim() ? "border-destructive" : "border-border"
                  }`}
                />
                {showErrors && !url.trim() && (
                  <p className="mt-1 px-1 text-xs text-destructive">Enter a website URL</p>
                )}
              </>
            ) : (
              <>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    value={path}
                    readOnly
                    placeholder={type === "folder" ? "No folder selected" : "No file selected"}
                    className={`min-w-0 flex-1 truncate rounded-2xl border bg-secondary/20 px-3 py-2 text-sm text-muted-foreground outline-none ${
                      showErrors && !path.trim() ? "border-destructive" : "border-border"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={handleBrowse}
                    className="shrink-0 rounded-2xl border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  >
                    Browse…
                  </button>
                </div>
                {showErrors && !path.trim() && (
                  <p className="mt-1 px-1 text-xs text-destructive">
                    Choose a {type === "folder" ? "folder" : "file"}
                  </p>
                )}
              </>
            )}

            <div className="mt-6 flex justify-end gap-2">
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
                Add
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
