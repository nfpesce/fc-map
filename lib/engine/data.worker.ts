/// <reference lib="webworker" />
/*
 * Local data engine. Runs in a dedicated Web Worker so parsing a ~145 MB CSV
 * and building graphs never blocks the UI. Files are read straight from the
 * user's disk through the File API; nothing leaves this browser.
 */
import { ColumnarBuilder, DATASET_VERSION, MAX_CSV_SIZE, handleGraphRequest, metadata, type ParsedDataset } from "./graph-core";
import { parseCsvByteStream } from "./csv-stream";
import { MAX_TCE_SIZE, parseTceWorkbook, type TcePayload } from "./tce-core";
import { looksLikeRevenueWorkbook, parseRevenueWorkbook, type RevenueContributionPayload } from "./revenue-core";
import { clearEntries, loadEntry, saveEntry } from "./storage";
import type { WorkerMessage, WorkerRequest } from "./protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

let dataset: ParsedDataset | null = null;
const graphState = { familyFilter: "" };
let tce: TcePayload | null = null;
let revenue: RevenueContributionPayload | null = null;
let restored = false;

const NO_DATASET = { error: "No local CSV has been selected yet. Choose the Magellan PPN CSV file to build the map." };

function post(message: WorkerMessage) {
  scope.postMessage(message);
}

function fileModifiedAt(file: File) {
  return new Date(file.lastModified || Date.now()).toISOString();
}

async function restore() {
  if (restored) return;
  restored = true;
  const [storedDataset, storedTce, storedRevenue] = await Promise.all([
    loadEntry<ParsedDataset>("dataset"),
    loadEntry<TcePayload>("tce"),
    loadEntry<RevenueContributionPayload>("revenue"),
  ]);
  if (!dataset && storedDataset?.version === DATASET_VERSION && storedDataset.rowCount) dataset = storedDataset;
  if (!tce && storedTce?.available) tce = storedTce;
  if (!revenue && storedRevenue?.available) revenue = storedRevenue;
}

function persist(key: "dataset" | "tce" | "revenue", value: unknown) {
  saveEntry(key, value).catch((error) => console.warn(`[engine] ${key} could not be saved locally.`, error));
}

function tcePayload(): TcePayload {
  return tce ?? { available: false, fcIds: [], count: 0, error: "Select the TCE Selection.xlsx file from this computer." };
}

function revenuePayload(): RevenueContributionPayload {
  return revenue ?? { available: false, records: [], byFc: {}, count: 0, error: "Select the Revenue Contribution.xlsx file from this computer." };
}

async function loadCsv(id: number, file: File) {
  if (!/\.csv$/i.test(file.name)) return { status: 400, body: { error: "The file must use the .csv format." } };
  if (file.size > MAX_CSV_SIZE) return { status: 400, body: { error: "The CSV file exceeds the 250 MB limit." } };
  const startedAt = performance.now();
  let builder: ColumnarBuilder | null = null;
  let lastReport = 0;
  const source = { fileName: file.name, sheetName: "CSV", modifiedAt: fileModifiedAt(file) };
  await parseCsvByteStream(file.stream(), {
    onHeader: (headers) => { builder = new ColumnarBuilder(headers, source, file.size); },
    onRecord: (row) => builder!.add(row),
    onProgress: (bytesRead) => {
      const now = performance.now();
      if (now - lastReport < 120 && bytesRead < file.size) return;
      lastReport = now;
      post({ id, kind: "progress", bytesRead, totalBytes: file.size, phase: "Reading and indexing CSV" });
    },
  });
  if (!builder) throw new Error("The CSV file does not contain any records.");
  const parsed = (builder as ColumnarBuilder).finish();
  if (!parsed.rowCount) throw new Error("The CSV file does not contain any records.");
  console.info(`[engine] Parsed and indexed ${parsed.rowCount.toLocaleString("en-US")} CSV rows in ${Math.round(performance.now() - startedAt)} ms.`);
  dataset = parsed;
  graphState.familyFilter = "";
  persist("dataset", parsed);
  return { status: 200, body: metadata(parsed) };
}

async function handle(id: number, request: WorkerRequest) {
  await restore();
  switch (request.method) {
    case "restore":
      return {
        status: 200,
        body: {
          dataset: dataset ? { source: dataset.source, rowCount: dataset.rowCount, fileSize: dataset.fileSize } : null,
          tce: tcePayload(),
          revenue: revenuePayload(),
        },
      };
    case "loadCsv":
      return loadCsv(id, request.file);
    case "graph":
      if (!dataset) return { status: 404, body: NO_DATASET };
      return handleGraphRequest(dataset, graphState, request.request);
    case "loadTce": {
      const file = request.file;
      if (!/\.(xlsx|xls)$/i.test(file.name)) return { status: 400, body: { error: "The TCE file must use the .xlsx or .xls format." } };
      if (file.size > MAX_TCE_SIZE) return { status: 400, body: { error: "The TCE file exceeds the 10 MB limit." } };
      tce = parseTceWorkbook(await file.arrayBuffer(), file.name, fileModifiedAt(file));
      persist("tce", tce);
      return { status: 200, body: tce };
    }
    case "loadRevenue": {
      const file = request.file;
      if (!/\.(xlsx|xls)$/i.test(file.name)) return { status: 400, body: { error: "The revenue file must use the .xlsx or .xls format." } };
      revenue = parseRevenueWorkbook(await file.arrayBuffer(), file.name, fileModifiedAt(file));
      persist("revenue", revenue);
      return { status: 200, body: revenue };
    }
    case "classifyWorkbook":
      return { status: 200, body: { kind: looksLikeRevenueWorkbook(await request.file.arrayBuffer()) ? "revenue" : "tce" } };
    case "clear":
      dataset = null;
      tce = null;
      revenue = null;
      graphState.familyFilter = "";
      await clearEntries();
      return { status: 200, body: { cleared: true } };
  }
}

scope.onmessage = (event: MessageEvent<{ id: number; request: WorkerRequest }>) => {
  const { id, request } = event.data;
  handle(id, request)
    .then((result) => post({ id, kind: "result", status: result.status, body: result.body }))
    .catch((error: unknown) => post({ id, kind: "error", message: error instanceof Error ? error.message : "The local file could not be processed." }));
};
