// Thin wrappers over the Rust launch-session commands.
//
// None of these throw. A failure here (command not registered, session missing,
// backend panic) must never break launching — the user's items still need to open.

import { invoke } from "@tauri-apps/api/core";

export type TrackOrigin = "diff" | "spawned" | "lateSweep" | "carriedForward" | "preexistingBrowser";

export interface TrackedInfo {
  pid: number;
  name: string;
  exe: string;
  origin: TrackOrigin;
}

export interface SessionInfo {
  workspaceId: string;
  state: "collecting" | "ready" | "closing" | "closed";
  hadWebsiteItems: boolean;
  tracked: TrackedInfo[];
  preexistingBrowsers: TrackedInfo[];
}

export interface CloseOutcome {
  pid: number;
  name: string;
  exe: string;
  result: { kind: string; reason?: string; error?: string };
}

export interface CloseReport {
  workspaceId: string;
  dryRun: boolean;
  closed: number;
  skipped: number;
  failed: number;
  outcomes: CloseOutcome[];
  durationMs: number;
}

export interface CloseOptions {
  includePreexistingBrowsers?: boolean;
  excludePids?: number[];
  graceMs?: number;
  dryRun?: boolean;
}

async function safeInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T | null> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`Flashy: ${cmd} failed`, err);
    return null;
  }
}

export const beginLaunchSession = (workspaceId: string, hasWebsiteItems: boolean) =>
  safeInvoke<void>("begin_launch_session", { workspaceId, hasWebsiteItems });

export const finalizeLaunchSession = (workspaceId: string, spawnedPids: number[] = []) =>
  safeInvoke<SessionInfo>("finalize_launch_session", { workspaceId, spawnedPids });

export const getLaunchSession = (workspaceId: string) =>
  safeInvoke<SessionInfo | null>("get_launch_session", { workspaceId });

export const cancelLaunchSession = (workspaceId: string) =>
  safeInvoke<void>("cancel_launch_session", { workspaceId });

export const closeLaunchSession = (workspaceId: string, opts: CloseOptions = {}) =>
  safeInvoke<void>("close_launch_session", { workspaceId, opts });

/** Dry run: reports what a close would do without signalling anything. */
export const previewClose = (workspaceId: string) =>
  safeInvoke<CloseReport>("preview_close", { workspaceId });

/**
 * `workspaceName` and `accent` are passed through purely so the backend can echo them
 * in the warning event — the floating overlay is a separate webview and has no other
 * way to learn what the category is called.
 */
export const armAutoClose = (
  workspaceId: string,
  closeAtMs: number,
  workspaceName: string,
  accent: number,
  opts: CloseOptions = {},
) => safeInvoke<void>("arm_auto_close", { workspaceId, closeAtMs, workspaceName, accent, opts });

export const disarmAutoClose = (workspaceId: string) =>
  safeInvoke<void>("disarm_auto_close", { workspaceId });

/** False when the floating overlay couldn't be created, so the in-app countdown is needed. */
export const overlayAvailable = () => safeInvoke<boolean>("overlay_available", {});
