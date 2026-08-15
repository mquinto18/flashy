import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { loadData, saveData } from "./persistence";
import { beginLaunchSession, finalizeLaunchSession } from "../lib/launchSession";
import type { ApplicationItem, NewWorkspaceItem, Workspace, WorkspaceItem } from "../types/workspace";

type LaunchStatus = "launching" | "success" | "error";

const ACCENT_HUES = [195, 300, 150, 260, 30, 340];
const LAUNCH_FEEDBACK_DURATION_MS = 1500;
/** How long to let launched apps settle before taking the attribution snapshot. */
const LAUNCH_SETTLE_MS = 4000;

interface WorkspaceState {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  isLoaded: boolean;
  launchFeedback: Record<string, LaunchStatus>;
  runningApps: Record<string, boolean>;
  /**
   * Bumped after every completed launch. Not persisted.
   *
   * useScheduleStore subscribes to this to arm auto-close. It can't be a direct call
   * because useScheduleStore already imports this module to read workspaces, and the
   * reverse import would form an ESM cycle that crashes at startup (both modules call
   * create() at module scope).
   */
  lastLaunch: { workspaceId: string; at: number } | null;

  loadWorkspaces: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;

  createWorkspace: (name: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  setAutoCloseAt: (id: string, autoCloseAt: string | null) => void;

  addItem: (workspaceId: string, item: NewWorkspaceItem) => void;
  removeItem: (workspaceId: string, itemId: string) => void;

  /** Resolves to the spawned PID where the OS gives us one, otherwise null. */
  launchItem: (item: WorkspaceItem) => Promise<number | null>;
  launchWorkspace: (workspaceId: string) => Promise<void>;
  refreshRunningApps: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  subscribeWithSelector((set, get) => {
    function flashFeedback(itemId: string, status: LaunchStatus) {
      set((s) => ({ launchFeedback: { ...s.launchFeedback, [itemId]: status } }));
      setTimeout(() => {
        set((s) => {
          const next = { ...s.launchFeedback };
          delete next[itemId];
          return { launchFeedback: next };
        });
      }, LAUNCH_FEEDBACK_DURATION_MS);
    }

    return {
      workspaces: [],
      selectedWorkspaceId: null,
      isLoaded: false,
      launchFeedback: {},
      runningApps: {},
      lastLaunch: null,

      loadWorkspaces: async () => {
        const data = await loadData();
        set({ workspaces: data.workspaces, isLoaded: true });
      },

      selectWorkspace: (id) => set({ selectedWorkspaceId: id }),

      createWorkspace: (name) =>
        set((s) => {
          const id = crypto.randomUUID();
          return {
            selectedWorkspaceId: id,
            workspaces: [
              ...s.workspaces,
              {
                id,
                name: name.trim(),
                accent: ACCENT_HUES[s.workspaces.length % ACCENT_HUES.length],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                items: [],
              },
            ],
          };
        }),

      renameWorkspace: (id, name) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, name: name.trim(), updatedAt: new Date().toISOString() } : w,
          ),
        })),

      deleteWorkspace: (id) =>
        set((s) => ({
          workspaces: s.workspaces.filter((w) => w.id !== id),
          selectedWorkspaceId: s.selectedWorkspaceId === id ? null : s.selectedWorkspaceId,
        })),

      setAutoCloseAt: (id, autoCloseAt) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id
              ? // undefined rather than null so JSON.stringify drops the key entirely
                // when cleared, keeping workspaces.json free of dead entries.
                { ...w, autoCloseAt: autoCloseAt ?? undefined, updatedAt: new Date().toISOString() }
              : w,
          ),
        })),

      addItem: (workspaceId, item) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === workspaceId
              ? {
                  ...w,
                  updatedAt: new Date().toISOString(),
                  items: [
                    ...w.items,
                    { ...item, id: crypto.randomUUID(), createdAt: new Date().toISOString() } as WorkspaceItem,
                  ],
                }
              : w,
          ),
        })),

      removeItem: (workspaceId, itemId) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === workspaceId
              ? { ...w, items: w.items.filter((i) => i.id !== itemId), updatedAt: new Date().toISOString() }
              : w,
          ),
        })),

      launchItem: async (item) => {
        if (item.type === "application" && get().runningApps[item.id]) {
          flashFeedback(item.id, "success");
          return null;
        }

        flashFeedback(item.id, "launching");
        let spawnedPid: number | null = null;
        try {
          if (item.type === "website") await openUrl(item.url);
          else if (item.type === "file" || item.type === "folder") await openPath(item.path);
          // Returns a PID only where one is meaningful — a directly spawned child.
          // macOS .app bundles go through LaunchServices and yield null, which is why
          // snapshot diffing, not this, is the primary attribution mechanism.
          else spawnedPid = await invoke<number | null>("launch_app", { path: item.path });
          flashFeedback(item.id, "success");
          if (item.type === "application") void get().refreshRunningApps();
        } catch (err) {
          console.error("Flashy: failed to launch", item, err);
          flashFeedback(item.id, "error");
        }
        return spawnedPid;
      },

      launchWorkspace: async (workspaceId) => {
        const workspace = get().workspaces.find((w) => w.id === workspaceId);
        if (!workspace) return;

        // Snapshot the process table before anything opens, so the post-launch diff
        // can attribute what appeared. Never throws.
        const hasWebsiteItems = workspace.items.some((i) => i.type === "website");
        await beginLaunchSession(workspaceId, hasWebsiteItems);

        const results = await Promise.allSettled(
          workspace.items.map(
            (item, i) => new Promise((r) => setTimeout(r, i * 100)).then(() => get().launchItem(item)),
          ),
        );

        // Directly spawned children — Windows binaries and non-bundle paths. Snapshot
        // diffing catches most things, but its filter only admits GUI apps, so these
        // would otherwise be untracked and never closed.
        const spawnedPids = results.flatMap((r) =>
          r.status === "fulfilled" && typeof r.value === "number" ? [r.value] : [],
        );

        // Arm immediately so the user sees "closing at 3:00 PM" right away.
        set({ lastLaunch: { workspaceId, at: Date.now() } });

        // Apps keep spawning well after the launch calls resolve, so the after-snapshot
        // waits out a settle window. Deliberately not awaited: the UI must not block,
        // and running it at store scope means it survives FlashyIsland unmounting.
        void (async () => {
          await new Promise((r) => setTimeout(r, LAUNCH_SETTLE_MS));
          await finalizeLaunchSession(workspaceId, spawnedPids);
        })();
      },

      refreshRunningApps: async () => {
        const appItems = get()
          .workspaces.flatMap((w) => w.items)
          .filter((i): i is ApplicationItem => i.type === "application");

        if (appItems.length === 0) {
          if (Object.keys(get().runningApps).length > 0) set({ runningApps: {} });
          return;
        }

        // One round trip over one shared process scan, rather than one full scan per item.
        const uniquePaths = [...new Set(appItems.map((i) => i.path))];
        const byPath = await invoke<Record<string, boolean>>("running_apps", { paths: uniquePaths });

        set({
          runningApps: Object.fromEntries(appItems.map((item) => [item.id, byPath[item.path] ?? false])),
        });
      },
    };
  }),
);

useWorkspaceStore.subscribe(
  (s) => s.workspaces,
  (workspaces) => {
    if (useWorkspaceStore.getState().isLoaded) void saveData(workspaces);
  },
);
