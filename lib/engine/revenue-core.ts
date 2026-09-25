/* Browser-safe port of the former app/api/revenue-contribution/route.ts parser. */
import * as XLSX from "xlsx";

export const REVENUE_FILE_NAME = "Revenue Contribution.xlsx";
const REQUIRED_FIELDS = ["_FeatureCodes", "_DetailQty", "_DetailRevenue"] as const;

type RevenueRecord = { id: number; revenue: number | null; units: number | null };
type RevenueFcMetric = { revenue: number | null; units: number | null; multi: boolean; recordIds: number[] };

export type RevenueContributionPayload = {
  available: boolean;
  source?: { fileName: string; sheetName: string; modifiedAt: string };
  records: RevenueRecord[];
  byFc: Record<string, RevenueFcMetric>;
  count: number;
  error?: string;
};

function normalizedHeader(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLocaleUpperCase();
}

function cleanFeatureCodes(value: unknown) {
  return [...new Set(String(value ?? "")
    .split(",")
    .map((featureCode) => featureCode.trim().toLocaleUpperCase())
    .filter(Boolean))];
}

function numericValue(value: unknown, field: string, rowNumber: number) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const text = String(value).trim();
  const negative = /^\(.*\)$/.test(text);
  const parsed = Number(text.replace(/[,$()\s]/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`${field} contains a non-numeric value on row ${rowNumber}.`);
  return negative ? -parsed : parsed;
}

function resolveColumns(headers: string[]) {
  const normalized = new Map(headers.map((header) => [normalizedHeader(header), header]));
  const columns = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, normalized.get(normalizedHeader(field))])) as Record<(typeof REQUIRED_FIELDS)[number], string | undefined>;
  const missing = REQUIRED_FIELDS.filter((field) => !columns[field]);
  return { columns, missing };
}

function findDataSheet(workbook: XLSX.WorkBook) {
  const candidates = workbook.SheetNames.includes("Export")
    ? ["Export", ...workbook.SheetNames.filter((sheetName) => sheetName !== "Export")]
    : workbook.SheetNames;

  for (const sheetName of candidates) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: null, raw: true });
    if (!rows.length) continue;
    const resolved = resolveColumns(Object.keys(rows[0]));
    if (!resolved.missing.length) return { sheetName, rows, columns: resolved.columns as Record<(typeof REQUIRED_FIELDS)[number], string> };
  }

  const firstSheet = candidates[0];
  if (!firstSheet) throw new Error("The revenue contribution workbook does not contain any worksheets.");
  const firstRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheet], { defval: null, raw: true });
  if (!firstRows.length) throw new Error(`The ${firstSheet} worksheet does not contain any records.`);
  const { missing } = resolveColumns(Object.keys(firstRows[0]));
  throw new Error(`Required revenue contribution columns are missing: ${missing.join(", ")}.`);
}

export function parseRevenueWorkbook(data: ArrayBuffer, fileName: string, modifiedAt: string): RevenueContributionPayload {
  const workbook = XLSX.read(new Uint8Array(data), { type: "array", cellDates: false });
  const { sheetName, rows, columns } = findDataSheet(workbook);
  const records: RevenueRecord[] = [];
  const byFc = Object.create(null) as Record<string, RevenueFcMetric>;

  rows.forEach((row, index) => {
    const featureCodes = cleanFeatureCodes(row[columns._FeatureCodes]);
    if (!featureCodes.length) return;

    const id = index + 2;
    const revenue = numericValue(row[columns._DetailRevenue], "_DetailRevenue", id);
    const units = numericValue(row[columns._DetailQty], "_DetailQty", id);
    const multi = featureCodes.length > 1;
    records.push({ id, revenue, units });

    for (const featureCode of featureCodes) {
      const metric = byFc[featureCode] ?? { revenue: null, units: null, multi: false, recordIds: [] };
      if (revenue !== null) metric.revenue = (metric.revenue ?? 0) + revenue;
      if (units !== null) metric.units = (metric.units ?? 0) + units;
      metric.multi ||= multi;
      metric.recordIds.push(id);
      byFc[featureCode] = metric;
    }
  });

  const count = Object.keys(byFc).length;
  if (!count) throw new Error("The revenue contribution workbook does not contain any feature codes.");
  return { available: true, source: { fileName, sheetName, modifiedAt }, records, byFc, count };
}

/** True when the workbook has the revenue contribution columns (used to auto-detect dropped files). */
export function looksLikeRevenueWorkbook(data: ArrayBuffer) {
  try {
    const workbook = XLSX.read(new Uint8Array(data), { type: "array", sheetRows: 2 });
    return workbook.SheetNames.some((sheetName) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: null });
      return rows.length > 0 && !resolveColumns(Object.keys(rows[0])).missing.length;
    });
  } catch {
    return false;
  }
}
