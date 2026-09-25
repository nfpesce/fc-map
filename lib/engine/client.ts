"use client";
/*
 * Main-thread client for the local data engine (replaces fetch("/api/...")).
 * Each call returns { ok, status, payload } like the former API responses.
 */
import type { GraphRequest } from "./graph-core";
import type { WorkerMessage, WorkerRequest } from "./protocol";

export type EngineResult<T> = { ok: boolean; status: number; payload: T };
export type EngineProgress = { bytesRead: number; totalBytes: number; phase: string };

type Pending = {
  resolve: (value: EngineResult<unknown>) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: EngineProgress) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./data.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.kind === "progress") {
      entry.onProgress?.({ bytesRead: message.bytesRead, totalBytes: message.totalBytes, phase: message.phase });
      return;
    }
    pending.delete(message.id);
    if (message.kind === "error") entry.reject(new Error(message.message));
    else entry.resolve({ ok: message.status >= 200 && message.status < 300, status: message.status, payload: message.body });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "The local data engine stopped unexpectedly.");
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call<T>(request: WorkerRequest, onProgress?: (progress: EngineProgress) => void): Promise<EngineResult<T>> {
  const id = nextId++;
  return new Promise<EngineResult<T>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as Pending["resolve"], reject, onProgress });
    getWorker().postMessage({ id, request });
  });
}

/** Asks the browser not to evict the locally stored data under storage pressure. */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist?.();
  } catch {
    // Best effort only.
  }
}

export const localEngine = {
  restore: <T>() => call<T>({ method: "restore" }),
  graph: <T>(request: GraphRequest) => call<T>({ method: "graph", request }),
  loadCsv: <T>(file: File, onProgress?: (progress: EngineProgress) => void) => call<T>({ method: "loadCsv", file }, onProgress),
  loadTce: <T>(file: File) => call<T>({ method: "loadTce", file }),
  loadRevenue: <T>(file: File) => call<T>({ method: "loadRevenue", file }),
  classifyWorkbook: (file: File) => call<{ kind: "tce" | "revenue" }>({ method: "classifyWorkbook", file }),
  clear: () => call<{ cleared: boolean }>({ method: "clear" }),
};
