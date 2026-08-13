import { AppWindow, FileText, Folder, Globe } from "lucide-react";
import type { WorkspaceItem } from "../types/workspace";

export const itemTypeIcon: Record<WorkspaceItem["type"], typeof AppWindow> = {
  application: AppWindow,
  website: Globe,
  file: FileText,
  folder: Folder,
};

export const itemTypeLabel: Record<WorkspaceItem["type"], string> = {
  application: "Application",
  website: "Website",
  file: "File",
  folder: "Folder",
};

export function itemSubtext(item: WorkspaceItem): string {
  return item.type === "website" ? item.url : item.path;
}
