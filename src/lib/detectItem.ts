import type { NewWorkspaceItem, WorkspaceItemType } from "../types/workspace";

export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

// Dropped/pasted paths aren't statable without broadening fs permissions past the
// app-data scope, so type is inferred from the path shape rather than an actual stat().
export function detectTypeFromPath(path: string): Exclude<WorkspaceItemType, "website"> {
  const base = fileNameFromPath(path);
  if (/\.exe$/i.test(base)) return "application";
  return base.includes(".") ? "file" : "folder";
}

const URL_LIKE = /^(https?:\/\/|www\.)/i;
const DOMAIN_LIKE = /\.[a-z]{2,}(\/|$)/i;
const WINDOWS_PATH = /^[a-z]:[\\/]/i;

export function detectItemFromInput(raw: string): NewWorkspaceItem | null {
  const value = raw.trim();
  if (!value) return null;

  const looksLikeUrl =
    URL_LIKE.test(value) || (DOMAIN_LIKE.test(value) && !value.includes("\\") && !WINDOWS_PATH.test(value));

  if (looksLikeUrl) {
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const name = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
    return { type: "website", name, url };
  }

  const type = detectTypeFromPath(value);
  return { type, name: fileNameFromPath(value), path: value };
}
