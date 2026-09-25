/*
 * Equivalence test: legacy server pipeline (csv-parse + route.ts) vs the new
 * browser engine (CsvStreamParser + graph-core), on a real CSV.
 * Usage: npx tsx tests/equivalence/compare.ts "<path to CSV>"
 */
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import * as legacy from "./legacy-route";
import { ColumnarBuilder, buildGraph, emptySelections, type FilterSelections } from "../../lib/engine/graph-core";
import { parseCsvByteStream } from "../../lib/engine/csv-stream";

const csvPath = process.argv[2];
if (!csvPath) throw new Error("Pass the CSV path.");
const source = { fileName: "x.csv", sheetName: "CSV", modifiedAt: "2026-01-01T00:00:00.000Z" };

async function main() {
  let started = performance.now();
  const oldParsed = await legacy.parseCsvStream(createReadStream(csvPath), source);
  console.log(`legacy parse: ${Math.round(performance.now() - started)} ms, rows ${oldParsed.rowCount}`);

  started = performance.now();
  let builder: ColumnarBuilder | null = null;
  await parseCsvByteStream(Readable.toWeb(createReadStream(csvPath)) as ReadableStream<Uint8Array>, {
    onHeader: (headers) => { builder = new ColumnarBuilder(headers, source, statSync(csvPath).size); },
    onRecord: (row) => builder!.add(row),
  });
  const newParsed = (builder as unknown as ColumnarBuilder).finish();
  console.log(`new parse: ${Math.round(performance.now() - started)} ms, rows ${newParsed.rowCount}`);

  let failures = 0;
  const check = (label: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures += 1; };
  check("rowCount", oldParsed.rowCount === newParsed.rowCount);
  check("filterOptions", isDeepStrictEqual(oldParsed.filterOptions, newParsed.filterOptions));
  for (const field of Object.keys(oldParsed.columns) as Array<keyof typeof oldParsed.columns>) {
    const a = oldParsed.columns[field];
    const b = newParsed.columns[field];
    check(`column ${field}`, isDeepStrictEqual(a.dictionary, b.dictionary) && a.values.length === b.values.length && a.values.every((v, i) => v === b.values[i]));
  }

  const comm2 = newParsed.filterOptions.comm2.map((o) => o.value);
  const brands = newParsed.filterOptions.brand.map((o) => o.value);
    const defaultBrands = brands.filter((b) => !["c4c", "c4c-share", "hyperscale", "opt"].includes(b.toLowerCase()));
  const topComm2 = [...newParsed.filterOptions.comm2].sort((a, b) => b.count - a.count).map((o) => o.value);
  const cases: Array<{ name: string; filters: FilterSelections; family: string; dummy: boolean }> = [
    { name: "comm2 top + default brands", filters: { ...emptySelections(), comm2: [topComm2[0]], brand: defaultBrands }, family: "", dummy: true },
    { name: "comm2 2 values + brand default, dummy off", filters: { ...emptySelections(), comm2: topComm2.slice(0, 2), brand: defaultBrands }, family: "", dummy: false },
    { name: "comm2 + fccat + family", filters: { ...emptySelections(), comm2: [topComm2[0]], fccat: [...newParsed.filterOptions.fccat].sort((a, b) => b.count - a.count).slice(0, 3).map((o) => o.value) }, family: newParsed.columns.Family.dictionary[1].slice(0, 5).toLowerCase(), dummy: true },
    { name: "all comm2 (unfiltered)", filters: { ...emptySelections(), comm2 }, family: "", dummy: true },
  ];
  for (const testCase of cases) {
    let t = performance.now();
    const oldGraph = legacy.buildGraph(oldParsed, testCase.filters, testCase.family, testCase.dummy);
    const oldMs = Math.round(performance.now() - t);
    t = performance.now();
    const newGraph = buildGraph(newParsed, testCase.filters, testCase.family, testCase.dummy);
    const newMs = Math.round(performance.now() - t);
    const oldRest: Record<string, unknown> = { ...oldGraph };
    const newRest: Record<string, unknown> = { ...newGraph };
    delete oldRest.source;
    delete newRest.source;
    check(`graph "${testCase.name}" (rows ${newGraph.stats.rows}, nodes ${newGraph.stats.nodes}, links ${newGraph.stats.links}; legacy ${oldMs} ms / new ${newMs} ms)`, isDeepStrictEqual(oldRest, newRest));
  }
  console.log(failures ? `${failures} FAILURES` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}

void main();
