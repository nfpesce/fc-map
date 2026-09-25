/* Browser-safe port of the former app/api/tce/route.ts parser. */
import * as XLSX from "xlsx";

export const MAX_TCE_SIZE = 10 * 1024 * 1024;

export type TcePayload = {
  available: boolean;
  source?: { fileName: string; sheetName: string; modifiedAt: string };
  fcIds: string[];
  count: number;
  error?: string;
};

function normalizedHeader(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLocaleUpperCase();
}

function cleanFc(value: unknown) {
  return String(value ?? "").trim().toLocaleUpperCase();
}

export function parseTceWorkbook(data: ArrayBuffer, fileName: string, modifiedAt: string): TcePayload {
  const workbook = XLSX.read(new Uint8Array(data), { type: "array", cellDates: false });
  const sheetName = workbook.SheetNames.includes("Selection") ? "Selection" : workbook.SheetNames[0];
  if (!sheetName) throw new Error("The TCE workbook does not contain any worksheets.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: null, raw: false });
  if (!rows.length) throw new Error(`The ${sheetName} worksheet does not contain any records.`);
  const headers = Object.keys(rows[0]);
  const fcColumn = headers.find((header) => normalizedHeader(header) === "FC");
  if (!fcColumn) throw new Error("The TCE workbook must contain an FC column.");
  const fcIds = [...new Set(rows.map((row) => cleanFc(row[fcColumn])).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (!fcIds.length) throw new Error("The FC column in the TCE workbook is empty.");
  return { available: true, source: { fileName, sheetName, modifiedAt }, fcIds, count: fcIds.length };
}
