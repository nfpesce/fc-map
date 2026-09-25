"use client";
/*
 * Folder import: the user picks ONE folder and the app finds the three data
 * files inside it by name. Uses the File System Access API when available
 * (Chrome/Edge: the folder can be remembered and re-read later) and falls back
 * to <input webkitdirectory> elsewhere. Files are only read locally.
 */
import { loadEntry, saveEntry } from "./storage";

export const EXPECTED_FILES = {
  csv: "Magellan PPN Tool Extended Export.csv",
  tce: "TCE Selection.xlsx",
  revenue: "Revenue Contribution.xlsx",
} as const;

export type FolderSelection = {
  folderName: string;
  csv: File | null;
  tce: File | null;
  revenue: File | null;
};

type DirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterable<{ kind: "file" | "directory"; name: string; getFile?: () => Promise<File> }>;
  queryPermission?: (options: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: "read" }) => Promise<PermissionState>;
};

type WindowWithPicker = Window & { showDirectoryPicker?: (options?: { id?: string; mode?: "read" }) => Promise<DirectoryHandle> };

const lower = (value: string) => value.trim().toLocaleLowerCase();

function depth(file: File) {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
  return relativePath ? relativePath.split("/").length : 1;
}

/** Prefers the exact expected name, then a name starting with the expected stem, then a keyword match. Shallowest, newest first. */
function pick(files: File[], exactName: string, extensions: RegExp, keyword: string) {
  const candidates = files.filter((file) => extensions.test(file.name));
  const rank = (list: File[]) => [...list].sort((first, second) => depth(first) - depth(second) || second.lastModified - first.lastModified)[0] ?? null;
  const exact = candidates.filter((file) => lower(file.name) === lower(exactName));
  if (exact.length) return rank(exact);
  const stem = lower(exactName.replace(/\.[^.]+$/, ""));
  const prefixed = candidates.filter((file) => lower(file.name).startsWith(stem));
  if (prefixed.length) return rank(prefixed);
  return rank(candidates.filter((file) => lower(file.name).includes(keyword)));
}

export function selectDataFiles(files: File[], folderName: string): FolderSelection {
  const visible = files.filter((file) => !file.name.startsWith("~$") && !file.name.startsWith("."));
  return {
    folderName,
    csv: pick(visible, EXPECTED_FILES.csv, /\.csv$/i, "magellan"),
    tce: pick(visible, EXPECTED_FILES.tce, /\.(xlsx|xls)$/i, "tce"),
    revenue: pick(visible, EXPECTED_FILES.revenue, /\.(xlsx|xls)$/i, "revenue"),
  };
}

export function supportsDirectoryPicker() {
  return typeof window !== "undefined" && typeof (window as WindowWithPicker).showDirectoryPicker === "function";
}

async function readDirectory(handle: DirectoryHandle): Promise<FolderSelection> {
  const files: File[] = [];
  for await (const entry of handle.values()) {
    if (entry.kind === "file" && entry.getFile && /\.(csv|xlsx|xls)$/i.test(entry.name)) files.push(await entry.getFile());
  }
  return selectDataFiles(files, handle.name);
}

/** Opens the folder picker (File System Access API). Returns null if the user cancels. */
export async function pickDataFolder(): Promise<FolderSelection | null> {
  const picker = (window as WindowWithPicker).showDirectoryPicker;
  if (!picker) return null;
  let handle: DirectoryHandle;
  try {
    handle = await picker({ id: "fc-map-data", mode: "read" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
  try {
    await saveEntry("folderHandle", handle);
  } catch {
    // Remembering the folder is optional.
  }
  return readDirectory(handle);
}

export async function rememberedFolderName() {
  const handle = await loadEntry<DirectoryHandle>("folderHandle");
  return handle?.name ?? null;
}

/** Re-reads the remembered folder. The browser asks the user to confirm read access once per visit. */
export async function reloadRememberedFolder(): Promise<FolderSelection | null> {
  const handle = await loadEntry<DirectoryHandle>("folderHandle");
  if (!handle) return null;
  const permission = (await handle.queryPermission?.({ mode: "read" })) ?? "granted";
  if (permission !== "granted" && (await handle.requestPermission?.({ mode: "read" })) !== "granted") {
    throw new Error(`Read access to the folder "${handle.name}" was not granted.`);
  }
  return readDirectory(handle);
}
