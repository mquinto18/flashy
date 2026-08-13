import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ChevronDown, FolderOpen, Plus, Sparkles, Trash2 } from "lucide-react";
import logo from "../assets/flashy-logo.png";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { useToastStore } from "../store/useToastStore";
import { detectItemFromInput, detectTypeFromPath, fileNameFromPath } from "../lib/detectItem";
import { ItemList } from "./ItemList";
import { AddItemModal } from "./AddItemModal";
import { ConfirmDialog } from "./ConfirmDialog";
import { LaunchButton } from "./LaunchButton";

export function FlashyIsland() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const selectedWorkspaceId = useWorkspaceStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
  const addItem = useWorkspaceStore((s) => s.addItem);
  const removeItem = useWorkspaceStore((s) => s.removeItem);
  const launchItem = useWorkspaceStore((s) => s.launchItem);
  const launchWorkspace = useWorkspaceStore((s) => s.launchWorkspace);
  const launchFeedback = useWorkspaceStore((s) => s.launchFeedback);
  const runningApps = useWorkspaceStore((s) => s.runningApps);
  const refreshRunningApps = useWorkspaceStore((s) => s.refreshRunningApps);
  const showToast = useToastStore((s) => s.show);

  const active = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, selectedWorkspaceId],
  );

  const [open, setOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newItemText, setNewItemText] = useState("");
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLaunchingAll, setIsLaunchingAll] = useState(false);
  const [showWorkspaceNameError, setShowWorkspaceNameError] = useState(false);
  const [showItemError, setShowItemError] = useState(false);

  const activeId = active?.id;

  useEffect(() => {
    if (!open || !activeId) return;

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
            const droppedPaths = event.payload.paths;
            for (const path of droppedPaths) {
              addItem(activeId, { type: detectTypeFromPath(path), name: fileNameFromPath(path), path });
            }
            if (droppedPaths.length === 1) {
              showToast(`Added ${fileNameFromPath(droppedPaths[0])}`);
            } else if (droppedPaths.length > 1) {
              showToast(`Added ${droppedPaths.length} items`);
            }
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
  }, [open, activeId, addItem, showToast]);

  useEffect(() => {
    void refreshRunningApps();
    const interval = setInterval(() => void refreshRunningApps(), 3000);
    return () => clearInterval(interval);
  }, [refreshRunningApps]);

  function handleAddWorkspace() {
    const name = newWorkspaceName.trim();
    if (!name) {
      setShowWorkspaceNameError(true);
      return;
    }
    createWorkspace(name);
    setNewWorkspaceName("");
    setShowWorkspaceNameError(false);
  }

  function handleQuickAddItem() {
    if (!activeId) return;
    const item = detectItemFromInput(newItemText);
    if (!item) {
      setShowItemError(true);
      return;
    }
    addItem(activeId, item);
    setNewItemText("");
    setShowItemError(false);
  }

  function commitName() {
    if (activeId && nameDraft.trim()) renameWorkspace(activeId, nameDraft);
    setIsEditingName(false);
  }

  async function handleLaunchAll() {
    if (!active) return;
    setIsLaunchingAll(true);
    await launchWorkspace(active.id);
    showToast(`Launched ${active.items.length} ${active.items.length === 1 ? "item" : "items"}`);
    setIsLaunchingAll(false);
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Dynamic island */}
      <div
        className="glass mx-auto flex items-center gap-3 rounded-full py-2 pl-2.5 pr-2 transition-all duration-500"
        style={{ width: open ? "100%" : "min(24rem, 100%)" }}
      >
        <img
          src={logo}
          alt="Flashy logo"
          width={40}
          height={40}
          className="size-9 shrink-0 drop-shadow-[0_0_14px_oklch(0.85_0.13_195/0.5)]"
        />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-semibold tracking-tight text-foreground">Flashy</p>
          <p className="truncate text-xs text-muted-foreground">
            {active ? `${active.name} · ${active.items.length} items ready` : "No workspaces yet"}
          </p>
        </div>
        {isLaunchingAll ? (
          <span className="hidden items-center gap-1.5 rounded-full border border-primary/40 px-3 py-1 text-xs text-primary sm:flex">
            <Sparkles className="size-3.5" /> Launching…
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse workspaces" : "Expand workspaces"}
          className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-secondary/40 transition-all duration-300 hover:border-primary/50 hover:bg-secondary/70 active:scale-95"
        >
          <ChevronDown
            className={`size-5 text-foreground transition-transform duration-500 ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {/* Dropped panel */}
      {open ? (
        <motion.div
          initial={{ opacity: 0, y: -16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, ease: [0.2, 0.9, 0.2, 1] }}
          className="glass-strong mt-3 rounded-[2rem] p-4 sm:p-5"
        >
          <div className="grid gap-4 md:grid-cols-[13rem_1fr]">
            {/* Categories */}
            <div className="flex min-w-0 flex-col gap-2">
              <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Categories
              </p>
              <ul className="flex gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
                {workspaces.map((w) => {
                  const isActive = active?.id === w.id;
                  return (
                    <li key={w.id} className="min-w-0 shrink-0 md:shrink">
                      <button
                        type="button"
                        onClick={() => selectWorkspace(w.id)}
                        className={`flex w-full min-w-0 items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-all duration-300 ${
                          isActive
                            ? "border-primary/50 bg-secondary/70 shadow-[0_0_24px_-8px_oklch(0.85_0.13_195/0.6)]"
                            : "border-border bg-secondary/20 hover:bg-secondary/45"
                        }`}
                      >
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: `oklch(0.82 0.14 ${w.accent})` }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{w.name}</span>
                        <span className="text-xs text-muted-foreground">{w.items.length}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div
                className={`mt-1 flex items-center gap-2 rounded-2xl border bg-secondary/20 px-3 py-1.5 ${
                  showWorkspaceNameError && !newWorkspaceName.trim() ? "border-destructive" : "border-border"
                }`}
              >
                <input
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddWorkspace()}
                  placeholder="New category"
                  className="min-w-0 flex-1 bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={handleAddWorkspace}
                  aria-label="Create category"
                  className="bg-brand-gradient grid size-7 shrink-0 place-items-center rounded-full text-primary-foreground transition-transform hover:scale-105 active:scale-95"
                >
                  <Plus className="size-4" />
                </button>
              </div>
              {showWorkspaceNameError && !newWorkspaceName.trim() && (
                <p className="px-1 text-xs text-destructive">Enter a name first</p>
              )}
            </div>

            {/* Storage */}
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 items-baseline justify-between gap-3 px-1">
                {active ? (
                  isEditingName ? (
                    <input
                      autoFocus
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={commitName}
                      onKeyDown={(e) => e.key === "Enter" && commitName()}
                      className="min-w-0 flex-1 rounded-lg border border-primary/50 bg-transparent px-2 py-1 text-lg font-semibold text-foreground outline-none"
                    />
                  ) : (
                    <h2
                      onClick={() => {
                        setNameDraft(active.name);
                        setIsEditingName(true);
                      }}
                      className="min-w-0 flex-1 cursor-text truncate text-lg font-semibold text-foreground"
                    >
                      {active.name} storage
                    </h2>
                  )
                ) : (
                  <h2 className="text-lg font-semibold text-foreground">No workspace yet</h2>
                )}
                <div className="flex shrink-0 items-center gap-2">
                  <p className="hidden text-xs text-muted-foreground sm:block">Drag items in or paste a link</p>
                  {active && (
                    <button
                      type="button"
                      onClick={() => setIsConfirmDeleteOpen(true)}
                      className="rounded-full p-1.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                      aria-label="Delete workspace"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              </div>

              <div
                className={`min-w-0 rounded-3xl border border-dashed p-2 transition-all duration-300 ${
                  isDragOver ? "border-primary/70 bg-primary/10" : "border-border/70 bg-secondary/10"
                }`}
              >
                {active ? (
                  <ItemList
                    items={active.items}
                    feedback={launchFeedback}
                    runningApps={runningApps}
                    isLaunchingAll={isLaunchingAll}
                    onRemove={(itemId) => removeItem(active.id, itemId)}
                    onLaunch={(item) => void launchItem(item)}
                  />
                ) : (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    Create a category to start filling it with apps, sites, files and folders.
                  </p>
                )}
              </div>

              {active && (
                <>
                  <div
                    className={`flex items-center gap-2 rounded-full border bg-secondary/25 px-4 py-2 ${
                      showItemError && !newItemText.trim() ? "border-destructive" : "border-border"
                    }`}
                  >
                    <Plus className="size-4 shrink-0 text-muted-foreground" />
                    <input
                      value={newItemText}
                      onChange={(e) => setNewItemText(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleQuickAddItem()}
                      placeholder="figma.com  ·  C:\Apps\code.exe  ·  C:\dev\project"
                      className="min-w-0 flex-1 bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    />
                    <button
                      type="button"
                      onClick={handleQuickAddItem}
                      className="shrink-0 rounded-full border border-border px-3 py-1 text-xs font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary"
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsAddOpen(true)}
                      className="shrink-0 rounded-full border border-border p-1.5 text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                      aria-label="Browse for an item"
                    >
                      <FolderOpen className="size-4" />
                    </button>
                  </div>
                  {showItemError && !newItemText.trim() && (
                    <p className="-mt-2 px-1 text-xs text-destructive">
                      Type a URL or path, or use the browse button
                    </p>
                  )}

                  <LaunchButton
                    onClick={handleLaunchAll}
                    status={isLaunchingAll ? "launching" : undefined}
                    label={isLaunchingAll ? `Opening ${active.items.length} items…` : `Launch ${active.name}`}
                    variant="primary"
                  />
                </>
              )}
            </div>
          </div>
        </motion.div>
      ) : null}

      {active && (
        <>
          <AddItemModal isOpen={isAddOpen} workspaceId={active.id} onClose={() => setIsAddOpen(false)} />
          <ConfirmDialog
            isOpen={isConfirmDeleteOpen}
            title="Delete workspace"
            message={`Are you sure you want to delete "${active.name}"? This can't be undone.`}
            onConfirm={() => {
              deleteWorkspace(active.id);
              setIsConfirmDeleteOpen(false);
            }}
            onCancel={() => setIsConfirmDeleteOpen(false)}
          />
        </>
      )}
    </div>
  );
}
