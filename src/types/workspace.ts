export type WorkspaceItemType = "application" | "website" | "file" | "folder";

interface BaseItem {
  id: string;
  name: string;
  icon?: string;
  createdAt: string;
}

export interface ApplicationItem extends BaseItem {
  type: "application";
  path: string;
}

export interface WebsiteItem extends BaseItem {
  type: "website";
  url: string;
}

export interface FileItem extends BaseItem {
  type: "file";
  path: string;
}

export interface FolderItem extends BaseItem {
  type: "folder";
  path: string;
}

export type WorkspaceItem = ApplicationItem | WebsiteItem | FileItem | FolderItem;

export interface Workspace {
  id: string;
  name: string;
  icon?: string;
  accent: number;
  /**
   * Local wall-clock time of day, 24h zero-padded "HH:MM" (e.g. "15:00"). Absent means
   * no auto-close.
   *
   * Stored as a time of day rather than a timestamp because the schedule recurs on
   * every launch — a stored date would be permanently in the past after midnight. It
   * also keeps "3 PM" at 3 PM across DST, and matches what `<input type="time">` emits.
   */
  autoCloseAt?: string;
  createdAt: string;
  updatedAt: string;
  items: WorkspaceItem[];
}

export interface FlashyData {
  version: 1;
  workspaces: Workspace[];
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type NewWorkspaceItem = DistributiveOmit<WorkspaceItem, "id" | "createdAt">;
