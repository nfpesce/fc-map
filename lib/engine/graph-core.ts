/*
 * Browser-safe port of the former app/api/graph/route.ts logic.
 * No Node APIs: runs inside a Web Worker (and in Node for tests).
 * Business rules are unchanged: SYSTEM_SBB excluded, FC ids longer than four
 * characters excluded, literal NULL options discarded, nodes/links deduplicated.
 */

export const CORE_TYPES = ["PPN", "SBB", "FC", "Option"] as const;
const EXCLUDED_NODE_IDS = new Set(["SYSTEM_SBB"]);
export const DATASET_VERSION = 5;
export const MAX_CSV_SIZE = 250 * 1024 * 1024;

export const COLUMN_ALIASES = {
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

export const FILTER_DEFINITIONS = [
  { key: "brand", field: "Brand" },
  { key: "fccat", field: "FCCAT" },
  { key: "ppncat", field: "PPNCAT" },
  { key: "comm2", field: "COMM2" },
  { key: "categoryosb", field: "CategoryOSB" },
] as const;

type CoreNodeType = (typeof CORE_TYPES)[number];
type NodeType = CoreNodeType | "GRP";
export type CanonicalField = keyof typeof COLUMN_ALIASES;
export type FilterKey = (typeof FILTER_DEFINITIONS)[number]["key"];
export type FilterSelections = Record<FilterKey, string[]>;
type RelationType = "PPN–SBB" | "SBB–FC" | "FC–Option";

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

export type EncodedColumn = { dictionary: string[]; values: Uint32Array };
export type DatasetSource = { fileName: string; sheetName: string; modifiedAt: string };

export type ParsedDataset = {
  version: number;
  rowCount: number;
  columns: Record<CanonicalField, EncodedColumn>;
  availableFields: CanonicalField[];
  sourceColumnMap: Partial<Record<CanonicalField, string>>;
  filterRows: Record<FilterKey, Record<string, Uint32Array>>;
  filterOptions: Record<FilterKey, Array<{ value: string; count: number }>>;
  source: DatasetSource;
  fileSize: number;
};

const FIELDS = Object.keys(COLUMN_ALIASES) as CanonicalField[];

export function clean(value: unknown): string | null {
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
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLocaleUpperCase();
}

function isDummyDescription(value: string | null) {
  return !!value && /\bdummy\b/i.test(value);
}

function nodeKey(type: NodeType, label: string) {
  return `${type}:${label}`;
}

/** Resolves canonical fields to column positions. Duplicate headers: the last one wins (csv-parse `columns: true` behaviour). */
export function resolveColumns(headers: string[]) {
  const normalizedHeaders = new Map<string, { header: string; index: number }>();
  headers.forEach((header, index) => normalizedHeaders.set(normalizedHeader(header), { header, index }));
  const sourceColumnMap: Partial<Record<CanonicalField, string>> = {};
  const columnIndexes: Partial<Record<CanonicalField, number>> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<[CanonicalField, readonly string[]]>) {
    const match = aliases.map((alias) => normalizedHeaders.get(normalizedHeader(alias))).find(Boolean);
    if (match) {
      sourceColumnMap[field] = match.header;
      columnIndexes[field] = match.index;
    }
  }
  const missing = [...CORE_TYPES, "MKTGNAME"].filter((field) => columnIndexes[field as CanonicalField] === undefined);
  if (missing.length) throw new Error(`Required CSV columns are missing: ${missing.join(", ")}.`);
  return { sourceColumnMap, columnIndexes };
}

class GrowableUint32 {
  private buffer = new Uint32Array(1 << 16);
  length = 0;
  push(value: number) {
    if (this.length === this.buffer.length) {
      const next = new Uint32Array(this.buffer.length * 2);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer[this.length++] = value;
  }
  toArray() {
    return this.buffer.slice(0, this.length);
  }
}

export class ColumnarBuilder {
  private readonly dictionaries = {} as Record<CanonicalField, string[]>;
  private readonly indexes = {} as Record<CanonicalField, Map<string, number>>;
  private readonly values = {} as Record<CanonicalField, GrowableUint32>;
  private readonly filterRows = Object.fromEntries(FILTER_DEFINITIONS.map(({ key }) => [key, new Map<string, number[]>()])) as Record<FilterKey, Map<string, number[]>>;
  private readonly sourceColumnMap: Partial<Record<CanonicalField, string>>;
  private readonly columnIndexes: Partial<Record<CanonicalField, number>>;
  private readonly filterFields = FILTER_DEFINITIONS.map(({ key, field }) => ({ key, field }));
  private rowCount = 0;

  constructor(headers: string[], private readonly source: DatasetSource, private readonly fileSize: number) {
    const resolved = resolveColumns(headers);
    this.sourceColumnMap = resolved.sourceColumnMap;
    this.columnIndexes = resolved.columnIndexes;
    for (const field of FIELDS) {
      this.dictionaries[field] = [""];
      this.indexes[field] = new Map();
      this.values[field] = new GrowableUint32();
    }
  }

  add(row: string[]) {
    for (const field of FIELDS) {
      const columnIndex = this.columnIndexes[field];
      const text = columnIndex === undefined ? null : clean(row[columnIndex]);
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
    for (const { key, field } of this.filterFields) {
      const columnIndex = this.columnIndexes[field];
      const value = columnIndex === undefined ? null : clean(row[columnIndex]);
      if (!value) continue;
      const rows = this.filterRows[key].get(value);
      if (rows) rows.push(this.rowCount);
      else this.filterRows[key].set(value, [this.rowCount]);
    }
    this.rowCount += 1;
  }

  finish(): ParsedDataset {
    const columns = {} as Record<CanonicalField, EncodedColumn>;
    for (const field of FIELDS) columns[field] = { dictionary: this.dictionaries[field], values: this.values[field].toArray() };
    const filterRows = {} as ParsedDataset["filterRows"];
    const filterOptions = {} as ParsedDataset["filterOptions"];
    for (const { key } of FILTER_DEFINITIONS) {
      filterRows[key] = Object.create(null) as Record<string, Uint32Array>;
      const options: Array<{ value: string; count: number }> = [];
      for (const [value, rows] of this.filterRows[key]) {
        filterRows[key][value] = Uint32Array.from(rows);
        options.push({ value, count: rows.length });
      }
      filterOptions[key] = options.sort((first, second) => first.value.localeCompare(second.value));
    }
    return {
      version: DATASET_VERSION,
      rowCount: this.rowCount,
      columns,
      availableFields: Object.keys(this.sourceColumnMap) as CanonicalField[],
      sourceColumnMap: this.sourceColumnMap,
      filterRows,
      filterOptions,
      source: this.source,
      fileSize: this.fileSize,
    };
  }
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

export function metadata(parsed: ParsedDataset, selectionRequired = false, familyFilter = "") {
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

function concatRows(parts: Uint32Array[]) {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint32Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
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
  const selectedRowSets = activeFilters.map(({ key }) => concatRows(selectedFilters[key].map((value) => parsed.filterRows[key][value] ?? new Uint32Array(0))));
  const selectedRows = selectedRowSets.length
    ? selectedRowSets.reduce((smallest, rows) => rows.length < smallest.length ? rows : smallest)
    : null;
  const candidateCount = selectedRows?.length ?? parsed.rowCount;
  for (let position = 0; position < candidateCount; position += 1) {
    const rowIndex = selectedRows ? selectedRows[position] : position;
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

export type GraphRequest = {
  filters: Partial<Record<FilterKey, string[]>>;
  family?: string;
  allowUnfiltered: boolean;
  removeDummy: boolean;
};

export type EngineResponse<T = unknown> = { status: number; body: T };

/**
 * Equivalent of the former GET /api/graph handler. `state.familyFilter`
 * mirrors the in-memory cache field the server kept between requests.
 */
export function handleGraphRequest(parsed: ParsedDataset, state: { familyFilter: string }, request: GraphRequest): EngineResponse {
  const selectedFilters = emptySelections();
  for (const { key } of FILTER_DEFINITIONS) {
    const requestedValues = (request.filters[key] ?? []).map(clean).filter((value): value is string => !!value);
    if (!requestedValues.length) continue;
    const options = parsed.filterOptions[key];
    const resolvedValues: string[] = [];
    for (const requestedValue of requestedValues) {
      const exactOption = options.find((option) => option.value === requestedValue);
      const caseInsensitiveOptions = exactOption ? [] : options.filter((option) => option.value.toLocaleLowerCase() === requestedValue.toLocaleLowerCase());
      if (caseInsensitiveOptions.length > 1) {
        return { status: 400, body: { error: `${key} value is ambiguous; use the exact capitalization: ${requestedValue}.` } };
      }
      const matchingOption = exactOption ?? caseInsensitiveOptions[0];
      if (!matchingOption) return { status: 400, body: { error: `${key} value not found: ${requestedValue}.` } };
      if (!resolvedValues.includes(matchingOption.value)) resolvedValues.push(matchingOption.value);
    }
    selectedFilters[key] = resolvedValues;
  }
  const requestedFamilyFilter = request.family !== undefined ? clean(request.family) ?? "" : state.familyFilter;
  if (requestedFamilyFilter.length > 100) {
    return { status: 400, body: { error: "The Family filter cannot exceed 100 characters." } };
  }
  if (requestedFamilyFilter && !hasField(parsed, "Family")) {
    return { status: 400, body: { error: "This CSV file does not contain the LMFamily column." } };
  }
  if (!selectedFilters.comm2.length && parsed.filterOptions.comm2.length === 1) {
    selectedFilters.comm2 = [parsed.filterOptions.comm2[0].value];
  } else if (!selectedFilters.comm2.length && parsed.filterOptions.comm2.length > 1 && !request.allowUnfiltered) {
    state.familyFilter = requestedFamilyFilter;
    return { status: 200, body: metadata(parsed, true, requestedFamilyFilter) };
  }
  state.familyFilter = requestedFamilyFilter;
  return { status: 200, body: buildGraph(parsed, selectedFilters, requestedFamilyFilter, request.removeDummy) };
}
