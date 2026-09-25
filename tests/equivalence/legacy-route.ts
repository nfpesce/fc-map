import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { parse } from "csv-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORE_TYPES = ["PPN", "SBB", "FC", "Option"] as const;
const EXCLUDED_NODE_IDS = new Set(["SYSTEM_SBB"]);
const CACHE_VERSION = 4;
const MAX_CSV_SIZE = 250 * 1024 * 1024;

const COLUMN_ALIASES = {
  PPN: ["ppn"],
  SBB: ["sbb"],
  FC: ["fc"],
  Option: ["opt"],
  MKTGNAME: ["mktgname"],
  PPNDescription: ["ppndescription"],
  VENDOR_NAME: ["vendor"],
  Family: ["LMFamily"],
  Brand: ["brand"],
  FCCAT: ["fccat"],
  PPNCAT: ["ppncat"],
  COMM2: ["comm2"],
  CategoryOSB: ["categoryosb"],
} as const;

const FILTER_DEFINITIONS = [
  { key: "brand", field: "Brand" },
  { key: "fccat", field: "FCCAT" },
  { key: "ppncat", field: "PPNCAT" },
  { key: "comm2", field: "COMM2" },
  { key: "categoryosb", field: "CategoryOSB" },
] as const;

type CoreNodeType = (typeof CORE_TYPES)[number];
type NodeType = CoreNodeType | "GRP";
type CanonicalField = keyof typeof COLUMN_ALIASES;
type FilterKey = (typeof FILTER_DEFINITIONS)[number]["key"];
type FilterSelections = Record<FilterKey, string[]>;
type RelationType = "PPN–SBB" | "SBB–FC" | "FC–Option";
type CsvRecord = Record<string, string | undefined>;
type NodeAccumulator = {
  id: string;
  label: string;
  type: NodeType;
  names: Set<string>;
  ppnDescriptions: Set<string>;
  vendors: Set<string>;
  families: Set<string>;
  brands: Set<string>;
};

type EncodedColumn = { dictionary: string[]; values: number[] };

type ParsedDataset = {
  rowCount: number;
  columns: Record<CanonicalField, EncodedColumn>;
  availableFields: CanonicalField[];
  sourceColumnMap: Partial<Record<CanonicalField, string>>;
  filterRows: Record<FilterKey, Record<string, number[]>>;
  filterOptions: Record<FilterKey, Array<{ value: string; count: number }>>;
  source: { fileName: string; sheetName: string; modifiedAt: string };
};

type CacheEntry = {
  mtimeMs: number;
  origin: "disk" | "upload";
  parsed: ParsedDataset;
  familyFilter: string;
};

type ColumnarCacheFile = {
  version: number;
  sourceFileName: string;
  sourceSize: number;
  sourceSha256: string;
  parsed: ParsedDataset;
};

let cache: CacheEntry | null = null;

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function normalizedHeader(header: string) {
  return header.replace(/[^a-z0-9]/gi, "").toLocaleUpperCase();
}

function normalizedFamilyValue(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLocaleUpperCase();
}

function isDummyDescription(value: string | null) {
  return !!value && /\bdummy\b/i.test(value);
}

function nodeKey(type: NodeType, label: string) {
  return `${type}:${label}`;
}

function resolveColumns(headers: string[]) {
  const normalizedHeaders = new Map(headers.map((header) => [normalizedHeader(header), header]));
  const resolved: Partial<Record<CanonicalField, string>> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<[CanonicalField, readonly string[]]>) {
    const sourceHeader = aliases.map((alias) => normalizedHeaders.get(normalizedHeader(alias))).find(Boolean);
    if (sourceHeader) resolved[field] = sourceHeader;
  }
  const missing = [...CORE_TYPES, "MKTGNAME"].filter((field) => !resolved[field as CanonicalField]);
  if (missing.length) throw new Error(`Required CSV columns are missing: ${missing.join(", ")}.`);
  return resolved;
}

export class ColumnarBuilder {
  private readonly dictionaries = {} as Record<CanonicalField, string[]>;
  private readonly indexes = {} as Record<CanonicalField, Map<string, number>>;
  private readonly values = {} as Record<CanonicalField, number[]>;
  private readonly filterRows = Object.fromEntries(FILTER_DEFINITIONS.map(({ key }) => [key, Object.create(null)])) as Record<FilterKey, Record<string, number[]>>;
  private readonly filterCounts = Object.fromEntries(FILTER_DEFINITIONS.map(({ key }) => [key, new Map<string, number>()])) as Record<FilterKey, Map<string, number>>;
  private rowCount = 0;

  constructor(
    private readonly sourceColumnMap: Partial<Record<CanonicalField, string>>,
    private readonly source: ParsedDataset["source"],
  ) {
    for (const field of Object.keys(COLUMN_ALIASES) as CanonicalField[]) {
      this.dictionaries[field] = [""];
      this.indexes[field] = new Map();
      this.values[field] = [];
    }
  }

  add(record: CsvRecord) {
    for (const field of Object.keys(COLUMN_ALIASES) as CanonicalField[]) {
      const sourceHeader = this.sourceColumnMap[field];
      const text = sourceHeader ? clean(record[sourceHeader]) : null;
      let dictionaryIndex = 0;
      if (text) {
        const existing = this.indexes[field].get(text);
        if (existing !== undefined) {
          dictionaryIndex = existing;
        } else {
          dictionaryIndex = this.dictionaries[field].length;
          this.dictionaries[field].push(text);
          this.indexes[field].set(text, dictionaryIndex);
        }
      }
      this.values[field].push(dictionaryIndex);
    }
    for (const { key, field } of FILTER_DEFINITIONS) {
      const sourceHeader = this.sourceColumnMap[field];
      const value = sourceHeader ? clean(record[sourceHeader]) : null;
      if (!value) continue;
      (this.filterRows[key][value] ??= []).push(this.rowCount);
      this.filterCounts[key].set(value, (this.filterCounts[key].get(value) ?? 0) + 1);
    }
    this.rowCount += 1;
  }

  finish(): ParsedDataset {
    const columns = {} as Record<CanonicalField, EncodedColumn>;
    for (const field of Object.keys(COLUMN_ALIASES) as CanonicalField[]) {
      columns[field] = { dictionary: this.dictionaries[field], values: this.values[field] };
    }
    return {
      rowCount: this.rowCount,
      columns,
      availableFields: Object.keys(this.sourceColumnMap) as CanonicalField[],
      sourceColumnMap: this.sourceColumnMap,
      filterRows: this.filterRows,
      filterOptions: Object.fromEntries(FILTER_DEFINITIONS.map(({ key }) => [key, [...this.filterCounts[key].entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((first, second) => first.value.localeCompare(second.value))])) as ParsedDataset["filterOptions"],
      source: this.source,
    };
  }
}

export async function parseCsvStream(stream: Readable | ReadStream, source: ParsedDataset["source"]) {
  const startedAt = performance.now();
  const parser = stream.pipe(parse({
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }));
  let builder: ColumnarBuilder | null = null;
  for await (const rawRecord of parser) {
    const record = rawRecord as CsvRecord;
    if (!builder) builder = new ColumnarBuilder(resolveColumns(Object.keys(record)), source);
    builder.add(record);
  }
  if (!builder) throw new Error("The CSV file does not contain any records.");
  const parsed = builder.finish();
  console.info(`[graph] Parsed and indexed ${parsed.rowCount.toLocaleString("en-US")} CSV rows in ${Math.round(performance.now() - startedAt)} ms.`);
  return parsed;
}

function valueAt(parsed: ParsedDataset, field: CanonicalField, rowIndex: number) {
  const column = parsed.columns[field];
  const dictionaryIndex = column.values[rowIndex] ?? 0;
  return clean(column.dictionary[dictionaryIndex]);
}

function hasField(parsed: ParsedDataset, field: CanonicalField) {
  return parsed.availableFields.includes(field);
}

export function emptySelections(): FilterSelections {
  return { brand: [], fccat: [], ppncat: [], comm2: [], categoryosb: [] };
}

function serializeFilters(parsed: ParsedDataset, selected: FilterSelections) {
  return Object.fromEntries(FILTER_DEFINITIONS.map(({ key, field }) => [key, {
    available: hasField(parsed, field),
    options: parsed.filterOptions[key],
    selected: selected[key],
  }])) as Record<FilterKey, { available: boolean; options: Array<{ value: string; count: number }>; selected: string[] }>;
}

function metadata(parsed: ParsedDataset, selectionRequired = false, familyFilter = "") {
  return {
    selectionRequired,
    source: parsed.source,
    filters: {
      ...serializeFilters(parsed, emptySelections()),
      family: { available: hasField(parsed, "Family"), value: familyFilter },
    },
    features: { grpAvailable: false, grpIncluded: false, grpCount: 0 },
  };
}

export function buildGraph(parsed: ParsedDataset, selectedFilters: FilterSelections, familyFilter: string, removeDummy: boolean) {
  const normalizedFamilyFilter = normalizedFamilyValue(familyFilter);
  const nodes = new Map<string, NodeAccumulator>();
  const edges = new Map<string, { source: string; target: string; relation: RelationType }>();
  const incomplete: Record<CoreNodeType, number> = { PPN: 0, SBB: 0, FC: 0, Option: 0 };
  let matchedRows = 0;

  function ensureNode(type: NodeType, label: string, marketingName: string | null, ppnDescription: string | null, vendor: string | null, family: string | null, brand: string | null) {
    const id = nodeKey(type, label);
    let node = nodes.get(id);
    if (!node) {
      node = { id, label, type, names: new Set(), ppnDescriptions: new Set(), vendors: new Set(), families: new Set(), brands: new Set() };
      nodes.set(id, node);
    }
    if (marketingName) node.names.add(marketingName);
    if (type === "PPN" && ppnDescription) node.ppnDescriptions.add(ppnDescription);
    if (type === "PPN" && vendor) node.vendors.add(vendor);
    if ((type === "FC" || type === "Option") && family) node.families.add(family);
    if ((type === "FC" || type === "Option") && brand) node.brands.add(brand);
    return id;
  }

  function addEdge(source: string | null, target: string | null, relation: RelationType) {
    if (!source || !target) return;
    const key = `${source}|${target}|${relation}`;
    if (!edges.has(key)) edges.set(key, { source, target, relation });
  }

  const activeFilters = FILTER_DEFINITIONS.filter(({ key }) => selectedFilters[key].length > 0);
  const selectedSets = Object.fromEntries(activeFilters.map(({ key }) => [key, new Set(selectedFilters[key])])) as Partial<Record<FilterKey, Set<string>>>;
  const selectedRowSets = activeFilters.map(({ key }) => selectedFilters[key].flatMap((value) => parsed.filterRows[key][value] ?? []));
  const selectedRows = selectedRowSets.length
    ? selectedRowSets.reduce((smallest, rows) => rows.length < smallest.length ? rows : smallest)
    : null;
  const candidateCount = selectedRows?.length ?? parsed.rowCount;
  for (let position = 0; position < candidateCount; position += 1) {
    const rowIndex = selectedRows?.[position] ?? position;
    const matchesSelections = activeFilters.every(({ key, field }) => {
      const value = valueAt(parsed, field, rowIndex);
      return !!value && selectedSets[key]?.has(value);
    });
    if (!matchesSelections) continue;
    const family = valueAt(parsed, "Family", rowIndex);
    if (normalizedFamilyFilter && !normalizedFamilyValue(family).includes(normalizedFamilyFilter)) continue;
    const ppnDescription = valueAt(parsed, "PPNDescription", rowIndex);
    if (removeDummy && isDummyDescription(ppnDescription)) continue;
    matchedRows += 1;

    const marketingName = valueAt(parsed, "MKTGNAME", rowIndex);
    const vendor = valueAt(parsed, "VENDOR_NAME", rowIndex);
    const brand = valueAt(parsed, "Brand", rowIndex);
    const ids = {} as Record<CoreNodeType, string | null>;

    for (const type of CORE_TYPES) {
      const label = valueAt(parsed, type, rowIndex);
      const excludedSystemNode = !!label && EXCLUDED_NODE_IDS.has(label.toLocaleUpperCase());
      const excludedLongFeatureCode = type === "FC" && !!label && label.length > 4;
      const excludedNullOption = type === "Option" && label?.toLocaleUpperCase() === "NULL";
      if (!label || excludedSystemNode || excludedLongFeatureCode || excludedNullOption) {
        if (!label || excludedNullOption) incomplete[type] += 1;
        ids[type] = null;
      } else {
        ids[type] = ensureNode(type, label, marketingName, ppnDescription, vendor, family, brand);
      }
    }

    addEdge(ids.PPN, ids.SBB, "PPN–SBB");
    addEdge(ids.SBB, ids.FC, "SBB–FC");
    addEdge(ids.FC, ids.Option, "FC–Option");
  }

  const degree = new Map<string, number>();
  const relationCounts = {} as Record<RelationType, number>;
  for (const edge of edges.values()) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    relationCounts[edge.relation] = (relationCounts[edge.relation] ?? 0) + 1;
  }

  const colors: Record<NodeType, string> = { PPN: "#4f8cff", SBB: "#c06cff", FC: "#ffad4d", Option: "#45d39a", GRP: "#f4d35e" };
  const counts: Record<NodeType, number> = { PPN: 0, SBB: 0, FC: 0, Option: 0, GRP: 0 };
  const serializedNodes = Array.from(nodes.values()).map((node) => {
    counts[node.type] += 1;
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      color: colors[node.type],
      degree: degree.get(node.id) ?? 0,
      mktgNames: Array.from(node.names).sort((first, second) => first.localeCompare(second)),
      ppnDescriptions: Array.from(node.ppnDescriptions).sort((first, second) => first.localeCompare(second)),
      vendors: Array.from(node.vendors).sort((first, second) => first.localeCompare(second)),
      families: Array.from(node.families).sort((first, second) => first.localeCompare(second)),
      brands: Array.from(node.brands).sort((first, second) => first.localeCompare(second)),
    };
  });

  return {
    selectionRequired: false,
    nodes: serializedNodes,
    links: Array.from(edges.values()),
    stats: { rows: matchedRows, nodes: serializedNodes.length, links: edges.size, counts, relationCounts, incomplete },
    source: parsed.source,
    filters: {
      ...serializeFilters(parsed, selectedFilters),
      family: { available: hasField(parsed, "Family"), value: familyFilter },
    },
    features: { grpAvailable: false, grpIncluded: false, grpCount: 0 },
  };
}

function defaultCsvPath() {
  return process.env.PPN_CSV_PATH || path.resolve(/* turbopackIgnore: true */ process.cwd(), "..", "Magellan PPN Tool Extended Export.csv");
}

function columnarCachePath() {
  return process.env.PPN_COLUMNAR_CACHE_PATH || path.resolve(process.cwd(), "db", "magellan-ppn-cache-v4.json");
}

async function fileSha256(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readColumnarCache(csvPath: string, fileSize: number, sourceSha256: string) {
  try {
    const raw = await readFile(columnarCachePath(), "utf8");
    const snapshot = JSON.parse(raw) as ColumnarCacheFile;
    if (
      snapshot.version !== CACHE_VERSION
      || snapshot.sourceFileName.toLocaleLowerCase() !== path.basename(csvPath).toLocaleLowerCase()
      || snapshot.sourceSize !== fileSize
      || snapshot.sourceSha256 !== sourceSha256
      || !snapshot.parsed?.rowCount
    ) return null;
    console.info(`[graph] Loaded ${snapshot.parsed.rowCount.toLocaleString("en-US")} rows from the columnar cache.`);
    return snapshot.parsed;
  } catch {
    return null;
  }
}

async function writeColumnarCache(csvPath: string, fileSize: number, sourceSha256: string, parsed: ParsedDataset) {
  const cacheFile: ColumnarCacheFile = {
    version: CACHE_VERSION,
    sourceFileName: path.basename(csvPath),
    sourceSize: fileSize,
    sourceSha256,
    parsed,
  };
  const targetPath = columnarCachePath();
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(cacheFile), "utf8");
  console.info(`[graph] Wrote columnar cache to ${targetPath}.`);
}

async function getDiskCache() {
  const csvPath = defaultCsvPath();
  const fileStat = await stat(csvPath);
  if (!cache || cache.origin !== "upload" && cache.mtimeMs !== fileStat.mtimeMs) {
    const sourceSha256 = await fileSha256(csvPath);
    let parsed = await readColumnarCache(csvPath, fileStat.size, sourceSha256);
    if (!parsed) {
      parsed = await parseCsvStream(createReadStream(csvPath), {
        fileName: path.basename(csvPath),
        sheetName: "CSV",
        modifiedAt: fileStat.mtime.toISOString(),
      });
      const cacheWrite = writeColumnarCache(csvPath, fileStat.size, sourceSha256, parsed)
        .catch((error) => console.warn("[graph] Columnar cache could not be written.", error));
      if (process.env.PPN_WAIT_FOR_CACHE_WRITE === "true") await cacheWrite;
      else void cacheWrite;
    }
    cache = { mtimeMs: fileStat.mtimeMs, origin: "disk", parsed, familyFilter: "" };
  }
  return cache;
}

export async function GET(request: Request) {
  try {
    const activeCache = cache?.origin === "upload" ? cache : await getDiskCache();
    const url = new URL(request.url);
    const allowUnfiltered = url.searchParams.get("allowUnfiltered") === "true";
    const removeDummy = url.searchParams.get("removeDummy") !== "false";
    const selectedFilters = emptySelections();
    for (const { key } of FILTER_DEFINITIONS) {
      const requestedValues = url.searchParams.getAll(key).map(clean).filter((value): value is string => !!value);
      if (!requestedValues.length) continue;
      const options = activeCache.parsed.filterOptions[key];
      const resolvedValues: string[] = [];
      for (const requestedValue of requestedValues) {
        const exactOption = options.find((option) => option.value === requestedValue);
        const caseInsensitiveOptions = exactOption ? [] : options.filter((option) => option.value.toLocaleLowerCase() === requestedValue.toLocaleLowerCase());
        if (caseInsensitiveOptions.length > 1) {
          return Response.json({ error: `${key} value is ambiguous; use the exact capitalization: ${requestedValue}.` }, { status: 400 });
        }
        const matchingOption = exactOption ?? caseInsensitiveOptions[0];
        if (!matchingOption) return Response.json({ error: `${key} value not found: ${requestedValue}.` }, { status: 400 });
        if (!resolvedValues.includes(matchingOption.value)) resolvedValues.push(matchingOption.value);
      }
      selectedFilters[key] = resolvedValues;
    }
    const requestedFamilyFilter = url.searchParams.has("family")
      ? clean(url.searchParams.get("family")) ?? ""
      : activeCache.familyFilter;
    if (requestedFamilyFilter.length > 100) {
      return Response.json({ error: "The Family filter cannot exceed 100 characters." }, { status: 400 });
    }
    if (requestedFamilyFilter && !hasField(activeCache.parsed, "Family")) {
      return Response.json({ error: "This CSV file does not contain the LMFamily column." }, { status: 400 });
    }
    if (!selectedFilters.comm2.length && activeCache.parsed.filterOptions.comm2.length === 1) {
      selectedFilters.comm2 = [activeCache.parsed.filterOptions.comm2[0].value];
    } else if (!selectedFilters.comm2.length && activeCache.parsed.filterOptions.comm2.length > 1 && !allowUnfiltered) {
      activeCache.familyFilter = requestedFamilyFilter;
      return Response.json(metadata(activeCache.parsed, true, requestedFamilyFilter), { headers: { "Cache-Control": "no-store" } });
    }
    activeCache.familyFilter = requestedFamilyFilter;
    return Response.json(buildGraph(activeCache.parsed, selectedFilters, requestedFamilyFilter, removeDummy), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The CSV file could not be read.";
    return Response.json({ error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File)) return Response.json({ error: "Select a CSV file." }, { status: 400 });
    if (!/\.csv$/i.test(uploadedFile.name)) return Response.json({ error: "The file must use the .csv format." }, { status: 400 });
    if (uploadedFile.size > MAX_CSV_SIZE) return Response.json({ error: "The CSV file exceeds the 250 MB limit." }, { status: 400 });

    const stream = Readable.from(uploadedFile.stream() as unknown as AsyncIterable<Uint8Array>);
    const parsed = await parseCsvStream(stream, {
      fileName: uploadedFile.name,
      sheetName: "CSV",
      modifiedAt: new Date(uploadedFile.lastModified || Date.now()).toISOString(),
    });
    cache = { mtimeMs: Date.now(), origin: "upload", parsed, familyFilter: "" };
    return Response.json(metadata(parsed), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The CSV file could not be processed.";
    return Response.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
