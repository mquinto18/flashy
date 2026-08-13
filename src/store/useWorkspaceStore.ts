import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { loadData, saveData } from "./persistence";
import type { ApplicationItem, NewWorkspaceItem, Workspace, WorkspaceItem } from "../types/workspace";

type LaunchStatus = "launching" | "success" | "error";

const ACCENT_HUES = [195, 300, 150, 260, 30, 340];
const LAUNCH_FEEDBACK_DURATION_MS = 1500;

interface WorkspaceState {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  isLoaded: boolean;
  launchFeedback: Record<string, LaunchStatus>;
  runningApps: Record<string, boolean>;

  loadWorkspaces: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;

  createWorkspace: (name: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;

  addItem: (workspaceId: string, item: NewWorkspaceItem) => void;
  removeItem: (workspaceId: string, itemId: string) => void;

  launchItem: (item: WorkspaceItem) => Promise<void>;
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
          return;
        }

        flashFeedback(item.id, "launching");
        try {
          if (item.type === "website") await openUrl(item.url);
          else if (item.type === "file" || item.type === "folder") await openPath(item.path);
          else await invoke("launch_app", { path: item.path });
          flashFeedback(item.id, "success");
          if (item.type === "application") void get().refreshRunningApps();
        } catch (err) {
          console.error("Flashy: failed to launch", item, err);
          flashFeedback(item.id, "error");
        }
      },

      launchWorkspace: async (workspaceId) => {
        const workspace = get().workspaces.find((w) => w.id === workspaceId);
        if (!workspace) return;
        await Promise.allSettled(
          workspace.items.map(
            (item, i) => new Promise((r) => setTimeout(r, i * 100)).then(() => get().launchItem(item)),
          ),
        );
      },

      refreshRunningApps: async () => {
        const appItems = get()
          .workspaces.flatMap((w) => w.items)
          .filter((i): i is ApplicationItem => i.type === "application");

        const entries = await Promise.all(
          appItems.map(
            async (item) => [item.id, await invoke<boolean>("is_app_running", { path: item.path })] as const,
          ),
        );

        set({ runningApps: Object.fromEntries(entries) });
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
