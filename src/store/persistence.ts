import { readTextFile, writeTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import type { FlashyData } from "../types/workspace";

const FILE_NAME = "workspaces.json";
const SCHEMA_VERSION = 1 as const;

async function getFilePath(): Promise<string> {
  const dir = await appDataDir();
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return join(dir, FILE_NAME);
}

export async function loadData(): Promise<FlashyData> {
  try {
    const filePath = await getFilePath();
    if (!(await exists(filePath))) return { version: SCHEMA_VERSION, workspaces: [] };
    return JSON.parse(await readTextFile(filePath)) as FlashyData;
  } catch (err) {
    console.error("Flashy: failed to load workspaces.json", err);
    return { version: SCHEMA_VERSION, workspaces: [] };
  }
}

export async function saveData(workspaces: FlashyData["workspaces"]): Promise<void> {
  const filePath = await getFilePath();
  await writeTextFile(filePath, JSON.stringify({ version: SCHEMA_VERSION, workspaces }, null, 2));
}
