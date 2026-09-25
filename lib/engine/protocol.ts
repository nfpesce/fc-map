import type { GraphRequest } from "./graph-core";

export type WorkerRequest =
  | { method: "restore" }
  | { method: "loadCsv"; file: File }
  | { method: "graph"; request: GraphRequest }
  | { method: "loadTce"; file: File }
  | { method: "loadRevenue"; file: File }
  | { method: "classifyWorkbook"; file: File }
  | { method: "clear" };

export type WorkerMessage =
  | { id: number; kind: "result"; status: number; body: unknown }
  | { id: number; kind: "error"; message: string }
  | { id: number; kind: "progress"; bytesRead: number; totalBytes: number; phase: string };
