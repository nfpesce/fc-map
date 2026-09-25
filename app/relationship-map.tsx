"use client";

import dynamic from "next/dynamic";
import {
  Box,
  HardDrive,
  ShieldCheck,
  Trash2,
  ChevronRight,
  FileSpreadsheet,
  Focus,
  GitBranch,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  UnfoldHorizontal,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { localEngine, requestPersistentStorage } from "../lib/engine/client";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

type CoreNodeType = "PPN" | "SBB" | "FC" | "Option";
type NodeType = CoreNodeType | "GRP";
type RelationType = "PPN–SBB" | "SBB–FC" | "FC–Option" | "PPN–GRP" | "GRP–SBB" | "GRP–FC" | "GRP–Option";
type RelationshipDepth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
type FilterKey = "brand" | "fccat" | "ppncat" | "comm2" | "categoryosb";
type FilterSelections = Record<FilterKey, string[]>;
type FacetFilter = {
  available: boolean;
  options: Array<{ value: string; count: number }>;
  selected: string[];
};

type LoadingProgress = {
  phase: string;
  basePercent: number;
  targetPercent: number;
  startedAt: number;
  estimatedMs: number;
  estimated: boolean;
  fixedPercent?: number;
};

type GraphNode = {
  id: string;
  label: string;
  type: NodeType;
  color: string;
  degree: number;
  mktgNames: string[];
  ppnDescriptions: string[];
  vendors: string[];
  families: string[];
  brands: string[];
  x?: number;
  y?: number;
};

type GraphLink = {
  source: string | GraphNode;
  target: string | GraphNode;
  relation: RelationType;
};

type GraphPayload = {
  selectionRequired?: boolean;
  nodes: GraphNode[];
  links: GraphLink[];
  stats: {
    rows: number;
    nodes: number;
    links: number;
    counts: Record<NodeType, number>;
    relationCounts: Record<RelationType, number>;
    incomplete: Record<CoreNodeType, number>;
  };
  source: { fileName: string; sheetName: string; modifiedAt: string };
  filters: Record<FilterKey, FacetFilter> & {
    family: {
      available: boolean;
      value: string;
    };
  };
  features: {
    grpAvailable: boolean;
    grpIncluded: boolean;
    grpCount: number;
  };
};

type UploadMetadata = Pick<GraphPayload, "source" | "filters" | "features"> & { selectionRequired?: boolean };

type TcePayload = {
  available: boolean;
  source?: { fileName: string; sheetName: string; modifiedAt: string };
  fcIds: string[];
  count: number;
  error?: string;
};

type RevenueContributionPayload = {
  available: boolean;
  source?: { fileName: string; sheetName: string; modifiedAt: string };
  records: Array<{ id: number; revenue: number | null; units: number | null }>;
  byFc: Record<string, {
    revenue: number | null;
    units: number | null;
    multi: boolean;
    recordIds: number[];
  }>;
  count: number;
  error?: string;
};

type RestorePayload = {
  dataset: { source: GraphPayload["source"]; rowCount: number; fileSize: number } | null;
  tce: TcePayload;
  revenue: RevenueContributionPayload;
};

type GraphHandle = {
  centerAt: (x?: number, y?: number, ms?: number) => void;
  zoom: (scale?: number, ms?: number) => number;
  zoomToFit: (ms?: number, padding?: number, filter?: (node: GraphNode) => boolean) => void;
  d3ReheatSimulation: () => void;
};

const TYPE_ORDER: CoreNodeType[] = ["PPN", "SBB", "FC", "Option"];
const NODE_TYPE_ORDER: NodeType[] = [...TYPE_ORDER, "GRP"];
const TYPE_COLORS: Record<NodeType, string> = {
  PPN: "#4f8cff",
  SBB: "#c06cff",
  FC: "#ffad4d",
  Option: "#45d39a",
  GRP: "#f4d35e",
};
const TCE_COLOR = "#9a4639";
const FILTER_CONFIG: Array<{ key: FilterKey; label: string }> = [
  { key: "brand", label: "brand" },
  { key: "fccat", label: "FCCAT" },
  { key: "ppncat", label: "ppncat" },
  { key: "comm2", label: "comm2" },
  { key: "categoryosb", label: "categoryosb" },
];
const EMPTY_FILTERS: FilterSelections = { brand: [], fccat: [], ppncat: [], comm2: [], categoryosb: [] };
const DEFAULT_EXCLUDED_BRANDS = new Set(["c4c", "c4c-share", "hyperscale", "opt"]);

function defaultBrandSelection(filter: FacetFilter) {
  return filter.options
    .map((option) => option.value)
    .filter((value) => !DEFAULT_EXCLUDED_BRANDS.has(value.trim().toLocaleLowerCase()));
}

function filtersWithDefaultBrands(filters: UploadMetadata["filters"], comm2: string[]) {
  return { ...EMPTY_FILTERS, brand: defaultBrandSelection(filters.brand), comm2 };
}

function endpointId(endpoint: string | GraphNode) {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function hexToRgba(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompactRevenue(value: number) {
  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (absoluteValue >= 1_000_000) return `$${Math.round(value / 1_000_000)}M`;
  if (absoluteValue >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${formatNumber(Math.round(value))}`;
}

function formatCompactUnits(value: number) {
  if (Math.abs(value) > 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatNumber(Math.round(value));
}

function revenueMetricLabel(metric?: RevenueContributionPayload["byFc"][string]) {
  if (!metric || metric.revenue === null && metric.units === null) return "- / -";
  const revenue = metric.revenue === null ? "-" : formatCompactRevenue(metric.revenue);
  const units = metric.units === null ? "-" : formatCompactUnits(metric.units);
  return `Rev.C ${revenue} / U. ${units}${metric.multi ? " · Multi" : ""}`;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function csvEstimateMs(fileSize: number) {
  const sizeMb = Math.max(0.1, fileSize / (1024 * 1024));
  const storedRate = typeof window === "undefined" ? Number.NaN : Number(window.localStorage.getItem("crm-csv-ms-per-mb"));
  const millisecondsPerMb = Number.isFinite(storedRate) && storedRate > 10 ? storedRate : 100;
  return Math.min(30000, Math.max(1500, sizeMb * millisecondsPerMb));
}

function ProgressCard({ progress, clock }: { progress: LoadingProgress; clock: number }) {
  const elapsedMs = Math.max(0, clock - progress.startedAt);
  const calculated = progress.fixedPercent ?? progress.basePercent + (elapsedMs / Math.max(1, progress.estimatedMs)) * (progress.targetPercent - progress.basePercent);
  const percent = Math.max(0, Math.min(progress.targetPercent, Math.round(calculated)));
  const remainingMs = Math.max(0, progress.estimatedMs - elapsedMs);
  return (
    <div className="progress-card">
      <div className="progress-ring" style={{ "--progress": `${percent * 3.6}deg` } as React.CSSProperties}>
        <span>{percent}%</span>
      </div>
      <div className="progress-copy">
        <div className="progress-heading"><strong>{progress.phase}</strong>{progress.estimated && <span>Estimated</span>}</div>
        <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
        <div className="progress-time">
          <span>Elapsed {formatDuration(elapsedMs)}</span>
          <span>{elapsedMs >= progress.estimatedMs && progress.estimated ? "Finishing up…" : `About ${formatDuration(remainingMs)} remaining`}</span>
        </div>
      </div>
    </div>
  );
}

function tooltipFamilyValues(values: string[]) {
  return [...new Set(values.map((value) => value
    .replace(/\b(?:ThinkSystem|ThinkAgile|Lenovo)\b/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim())
    .filter(Boolean))];
}

function FacetMultiSelect({
  filterKey,
  label,
  filter,
  selected,
  disabled,
  onChange,
}: {
  filterKey: FilterKey;
  label: string;
  filter?: FacetFilter;
  selected: string[];
  disabled: boolean;
  onChange: (key: FilterKey, values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const summary = useMemo(() => {
    if (!selected.length) return `All ${label}`;
    if (selected.length > 1) return `${selected.length} selected`;
    const option = filter?.options.find((candidate) => candidate.value === selected[0]);
    return `${selected[0]}${option ? ` (${formatNumber(option.count)})` : ""}`;
  }, [filter?.options, label, selected]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="filter-field">
      <span>{label}</span>
      <div className="facet-filter-row" ref={containerRef}>
        <button
          className="facet-select-trigger"
          type="button"
          onClick={() => setOpen((current) => !current)}
          disabled={disabled}
          aria-label={`${label} filter`}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span>{summary}</span>
          <ChevronRight size={13} className={open ? "open" : ""} />
        </button>
        {selected.length > 0 && (
          <button
            className="icon-button facet-clear"
            type="button"
            onClick={() => onChange(filterKey, [])}
            disabled={disabled}
            aria-label={`Clear ${label} filter`}
            title={`Clear ${label} filter`}
          >
            <X size={13} />
          </button>
        )}
        {open && (
          <div className="facet-multi-menu" role="listbox" aria-label={`${label} values`} aria-multiselectable="true">
            <div className="facet-multi-hint">Ctrl + left click to select multiple</div>
            <button
              type="button"
              role="option"
              aria-selected={selected.length === 0}
              className={`facet-multi-option ${selected.length === 0 ? "selected" : ""}`}
              onClick={() => onChange(filterKey, [])}
              disabled={disabled}
            >
              <span className="facet-option-check">{selected.length === 0 ? "✓" : ""}</span>
              <span className="facet-option-label">All {label}</span>
            </button>
            {filter?.options.map((option) => {
              const isSelected = selectedSet.has(option.value);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`facet-multi-option ${isSelected ? "selected" : ""}`}
                  key={option.value}
                  disabled={disabled}
                  onClick={(event) => {
                    const additive = event.ctrlKey || event.metaKey;
                    if (!additive) {
                      if (selected.length !== 1 || !isSelected) onChange(filterKey, [option.value]);
                      return;
                    }
                    onChange(filterKey, isSelected ? selected.filter((value) => value !== option.value) : [...selected, option.value]);
                  }}
                >
                  <span className="facet-option-check">{isSelected ? "✓" : ""}</span>
                  <span className="facet-option-label">{option.value}</span>
                  <small>{formatNumber(option.count)}</small>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function RelationshipMap({ appVersion }: { appVersion: string }) {
  const graphRef = useRef<GraphHandle | null>(null);
  const graphStageRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const tceFileInputRef = useRef<HTMLInputElement | null>(null);
  const layoutTransitionRef = useRef(0);
  const tooltipPositionFrameRef = useRef(0);
  const [data, setData] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [focusOnly, setFocusOnly] = useState(false);
  const [relationshipDepth, setRelationshipDepth] = useState<RelationshipDepth>(2);
  const [enabledTypes, setEnabledTypes] = useState<Set<CoreNodeType>>(new Set(TYPE_ORDER));
  const [selectedFilters, setSelectedFilters] = useState<FilterSelections>(EMPTY_FILTERS);
  const [familyContains, setFamilyContains] = useState("");
  const [familyDraft, setFamilyDraft] = useState("");
  const [tceOnlyEnabled, setTceOnlyEnabled] = useState(false);
  const [removeDummyEnabled, setRemoveDummyEnabled] = useState(true);
  const [tceData, setTceData] = useState<TcePayload | null>(null);
  const [tceLoading, setTceLoading] = useState(true);
  const [tceError, setTceError] = useState<string | null>(null);
  const [revenueContributionEnabled, setRevenueContributionEnabled] = useState(false);
  const [revenueContributionData, setRevenueContributionData] = useState<RevenueContributionPayload | null>(null);
  const [revenueContributionLoading, setRevenueContributionLoading] = useState(true);
  const [pendingUpload, setPendingUpload] = useState<UploadMetadata | null>(null);
  const [pendingComm2, setPendingComm2] = useState("");
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [progressClock, setProgressClock] = useState(() => Date.now());
  const [layoutRequest, setLayoutRequest] = useState(0);
  const [didFit, setDidFit] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 900, height: 700 });
  const [hasLocalData, setHasLocalData] = useState<boolean | null>(null);
  const [revenueError, setRevenueError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const loadGraph = useCallback(async (filters: FilterSelections, familyFilter: string, expectedRows = 0, allowUnfiltered = true, removeDummy = true) => {
    setLoading(true);
    setError(null);
    setProgressClock(Date.now());
    setLoadingProgress({
      phase: filters.comm2.length ? `Building ${filters.comm2.join(", ")} map` : "Reading CSV data",
      basePercent: 5,
      targetPercent: 94,
      startedAt: Date.now(),
      estimatedMs: expectedRows ? Math.min(20000, Math.max(1200, expectedRows / 5)) : 6000,
      estimated: true,
    });
    try {
      const response = await localEngine.graph<GraphPayload & UploadMetadata & { error?: string }>({
        filters: Object.fromEntries(FILTER_CONFIG.map(({ key }) => [key, filters[key]])),
        family: familyFilter.trim(),
        allowUnfiltered,
        removeDummy,
      });
      const payload = response.payload;
      if (response.status === 404) {
        setHasLocalData(false);
        setData(null);
        return null;
      }
      if (!response.ok) throw new Error(payload.error || "The map could not be loaded.");
      if (payload.selectionRequired) {
        setPendingUpload(payload as UploadMetadata);
        setPendingComm2("");
        setLoadingProgress(null);
        return null;
      }
      setLoadingProgress((current) => current ? { ...current, phase: "Rendering map", fixedPercent: 98, estimated: false } : current);
      const graphPayload = payload as GraphPayload;
      setData(graphPayload);
      setSelectedFilters(Object.fromEntries(FILTER_CONFIG.map(({ key }) => [key, graphPayload.filters[key].selected])) as FilterSelections);
      setFamilyContains(graphPayload.filters.family.value);
      setFamilyDraft(graphPayload.filters.family.value);
      setDidFit(false);
      window.setTimeout(() => graphRef.current?.zoomToFit(700, 46), 120);
      return graphPayload;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The map could not be loaded.");
      return null;
    } finally {
      setLoading(false);
      setLoadingProgress(null);
    }
  }, []);

  const applyRestoredState = useCallback((restored: RestorePayload) => {
    setTceData(restored.tce);
    if (!restored.tce.available) setTceOnlyEnabled(false);
    setRevenueContributionData(restored.revenue);
    if (!restored.revenue.available) setRevenueContributionEnabled(false);
    setHasLocalData(!!restored.dataset);
    setTceLoading(false);
    setRevenueContributionLoading(false);
    return restored;
  }, []);

  useEffect(() => {
    if (!loadingProgress) return;
    const timer = window.setInterval(() => setProgressClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [loadingProgress]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void (async () => {
        let restored: RestorePayload;
        try {
          restored = applyRestoredState((await localEngine.restore<RestorePayload>()).payload);
        } catch (restoreError) {
          setError(restoreError instanceof Error ? restoreError.message : "The local data engine could not start.");
          setLoading(false);
          return;
        }
        if (!restored.dataset) {
          setLoading(false);
          return;
        }
        const loaded = await loadGraph(EMPTY_FILTERS, "", 0, false);
        if (!loaded) return;
        const defaultFilters = filtersWithDefaultBrands(loaded.filters, loaded.filters.comm2.selected);
        await loadGraph(defaultFilters, "", loaded.stats.rows, true, true);
      })();
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [applyRestoredState, loadGraph]);

  const processCsvFile = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError(null);
    const csvStartedAt = Date.now();
    const fileSizeMb = Math.max(0.1, file.size / (1024 * 1024));
    try {
      setProgressClock(csvStartedAt);
      setLoadingProgress({ phase: "Reading and indexing CSV", basePercent: 0, targetPercent: 92, startedAt: csvStartedAt, estimatedMs: csvEstimateMs(file.size), estimated: true, fixedPercent: 0 });
      const response = await localEngine.loadCsv<UploadMetadata & { error?: string }>(file, (progress) => {
        const ratio = progress.totalBytes ? progress.bytesRead / progress.totalBytes : 0;
        const elapsed = Math.max(1, Date.now() - csvStartedAt);
        setLoadingProgress({
          phase: progress.phase,
          basePercent: 0,
          targetPercent: 92,
          startedAt: csvStartedAt,
          estimatedMs: ratio > 0 ? elapsed / ratio : csvEstimateMs(file.size),
          estimated: false,
          fixedPercent: Math.round(ratio * 92),
        });
      });
      const payload = response.payload;
      if (!response.ok) throw new Error(payload.error || "The CSV file could not be processed.");
      const measuredRate = (Date.now() - csvStartedAt) / fileSizeMb;
      try {
        const previousRate = Number(window.localStorage.getItem("crm-csv-ms-per-mb"));
        const blendedRate = Number.isFinite(previousRate) && previousRate > 10 ? previousRate * 0.65 + measuredRate * 0.35 : measuredRate;
        window.localStorage.setItem("crm-csv-ms-per-mb", String(Math.round(blendedRate)));
      } catch {
        // Storage may be unavailable; the estimate is optional.
      }
      void requestPersistentStorage();
      setHasLocalData(true);
      setLoadingProgress({ phase: "Preparing categories", basePercent: 96, targetPercent: 99, startedAt: Date.now(), estimatedMs: 500, estimated: false, fixedPercent: 97 });
      setError(null);
      setSelectedId(null);
      setFocusOnly(false);
      setRevenueContributionEnabled(false);
      setDidFit(false);
      setFamilyContains("");
      setFamilyDraft("");
      const options = payload.filters.comm2.options;
      if (options.length > 1) {
        setPendingUpload(payload);
        setPendingComm2("");
      } else {
        const onlyComm2 = options[0]?.value ?? null;
        await loadGraph(filtersWithDefaultBrands(payload.filters, onlyComm2 ? [onlyComm2] : []), "", options[0]?.count ?? 0, true, removeDummyEnabled);
      }
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : "The CSV file could not be processed.");
    } finally {
      setUploading(false);
      setLoadingProgress(null);
    }
  }, [loadGraph, removeDummyEnabled]);

  const uploadWorkbook = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await processCsvFile(file);
  }, [processCsvFile]);

  const processTceFile = useCallback(async (file: File) => {
    setTceLoading(true);
    setTceError(null);
    try {
      const response = await localEngine.loadTce<TcePayload>(file);
      if (!response.ok) throw new Error(response.payload.error || "The TCE workbook could not be processed.");
      setTceData(response.payload);
    } catch (uploadFailure) {
      setTceError(uploadFailure instanceof Error ? uploadFailure.message : "The TCE workbook could not be processed.");
    } finally {
      setTceLoading(false);
    }
  }, []);

  const uploadTceWorkbook = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await processTceFile(file);
  }, [processTceFile]);

  const processRevenueFile = useCallback(async (file: File) => {
    setRevenueContributionLoading(true);
    setRevenueError(null);
    try {
      const response = await localEngine.loadRevenue<RevenueContributionPayload>(file);
      if (!response.ok) throw new Error(response.payload.error || "The revenue contribution workbook could not be processed.");
      setRevenueContributionData(response.payload);
    } catch (uploadFailure) {
      setRevenueError(uploadFailure instanceof Error ? uploadFailure.message : "The revenue contribution workbook could not be processed.");
    } finally {
      setRevenueContributionLoading(false);
    }
  }, []);

  const uploadRevenueWorkbook = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await processRevenueFile(file);
  }, [processRevenueFile]);

  /** Routes any mix of selected/dropped files: .csv → map, workbooks → TCE or Revenue (auto-detected by columns). */
  const processLocalFiles = useCallback(async (files: File[]) => {
    const csvFiles = files.filter((file) => /\.csv$/i.test(file.name));
    const workbooks = files.filter((file) => /\.(xlsx|xls)$/i.test(file.name));
    const ignored = files.length - csvFiles.length - workbooks.length;
    if (ignored > 0 || csvFiles.length > 1) {
      setUploadError(csvFiles.length > 1 ? "Select only one CSV file at a time." : "Only .csv, .xlsx and .xls files are supported.");
      if (csvFiles.length > 1) return;
    }
    for (const workbook of workbooks) {
      try {
        const kind = (await localEngine.classifyWorkbook(workbook)).payload.kind;
        if (kind === "revenue") await processRevenueFile(workbook);
        else await processTceFile(workbook);
      } catch (classifyError) {
        setUploadError(classifyError instanceof Error ? classifyError.message : `${workbook.name} could not be read.`);
      }
    }
    if (csvFiles[0]) await processCsvFile(csvFiles[0]);
  }, [processCsvFile, processRevenueFile, processTceFile]);

  const selectLocalFiles = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length) await processLocalFiles(files);
  }, [processLocalFiles]);

  const dropLocalFiles = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) void processLocalFiles(files);
  }, [processLocalFiles]);

  const forgetLocalData = useCallback(async () => {
    if (!window.confirm("Remove the data stored in this browser? Your original files are not affected.")) return;
    await localEngine.clear();
    setData(null);
    setHasLocalData(false);
    setSelectedId(null);
    setFocusOnly(false);
    setPendingUpload(null);
    setTceOnlyEnabled(false);
    setRevenueContributionEnabled(false);
    setTceData({ available: false, fcIds: [], count: 0, error: "Select the TCE Selection.xlsx file from this computer." });
    setRevenueContributionData({ available: false, records: [], byFc: {}, count: 0, error: "Select the Revenue Contribution.xlsx file from this computer." });
    setSelectedFilters(EMPTY_FILTERS);
    setFamilyContains("");
    setFamilyDraft("");
    setError(null);
    setUploadError(null);
  }, []);

  const applyFacetFilter = useCallback(async (key: FilterKey, values: string[]) => {
    setSelectedId(null);
    setFocusOnly(false);
    setRevenueContributionEnabled(false);
    const nextFilters = { ...selectedFilters, [key]: values };
    const activeEstimates = FILTER_CONFIG.map(({ key: filterKey }) => nextFilters[filterKey].reduce((total, value) => (
      total + (data?.filters[filterKey].options.find((option) => option.value === value)?.count ?? 0)
    ), 0)).filter((count) => count > 0);
    const allRowsEstimate = data?.filters.comm2.options.reduce((total, option) => total + option.count, 0) ?? data?.stats.rows ?? 0;
    const expectedRows = activeEstimates.length ? Math.min(...activeEstimates) : allRowsEstimate;
    await loadGraph(nextFilters, familyContains, expectedRows, true, removeDummyEnabled);
  }, [data, familyContains, loadGraph, removeDummyEnabled, selectedFilters]);

  const applyFamilyFilter = useCallback(async () => {
    const nextFamilyFilter = familyDraft.trim();
    setSelectedId(null);
    setFocusOnly(false);
    setRevenueContributionEnabled(false);
    await loadGraph(selectedFilters, nextFamilyFilter, data?.stats.rows ?? 0, true, removeDummyEnabled);
  }, [data?.stats.rows, familyDraft, loadGraph, removeDummyEnabled, selectedFilters]);

  const clearFamilyFilter = useCallback(async () => {
    setFamilyDraft("");
    setSelectedId(null);
    setFocusOnly(false);
    setRevenueContributionEnabled(false);
    await loadGraph(selectedFilters, "", data?.stats.rows ?? 0, true, removeDummyEnabled);
  }, [data?.stats.rows, loadGraph, removeDummyEnabled, selectedFilters]);

  const confirmPendingUpload = useCallback(async () => {
    if (!pendingUpload || !pendingComm2) return;
    const expectedRows = pendingUpload.filters.comm2.options.find((option) => option.value === pendingComm2)?.count ?? 0;
    const loaded = await loadGraph(filtersWithDefaultBrands(pendingUpload.filters, [pendingComm2]), "", expectedRows, true, removeDummyEnabled);
    if (loaded) setPendingUpload(null);
  }, [loadGraph, pendingComm2, pendingUpload, removeDummyEnabled]);

  useEffect(() => {
    const stage = graphStageRef.current;
    if (!stage) return;
    const update = () => setDimensions({ width: Math.max(320, stage.clientWidth), height: Math.max(420, stage.clientHeight) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const nodeById = useMemo(() => new Map(data?.nodes.map((node) => [node.id, node]) ?? []), [data]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const link of data?.links ?? []) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (!map.has(source)) map.set(source, new Set());
      if (!map.has(target)) map.set(target, new Set());
      map.get(source)?.add(target);
      map.get(target)?.add(source);
    }
    return map;
  }, [data]);

  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;
  const hopById = useMemo(() => {
    if (!selectedId) return null;
    const hops = new Map<string, number>([[selectedId, 0]]);
    let frontier = new Set([selectedId]);
    for (let depth = 1; depth <= relationshipDepth; depth += 1) {
      const next = new Set<string>();
      for (const nodeId of frontier) {
        for (const neighborId of adjacency.get(nodeId) ?? []) {
          if (hops.has(neighborId)) continue;
          hops.set(neighborId, depth);
          next.add(neighborId);
        }
      }
      frontier = next;
    }
    return hops;
  }, [selectedId, adjacency, relationshipDepth]);
  const highlightedIds = useMemo(() => hopById ? new Set(hopById.keys()) : null, [hopById]);
  const tceFcIds = useMemo(() => new Set((tceData?.fcIds ?? []).map((fc) => fc.toLocaleUpperCase())), [tceData]);
  const revenueByFc = useMemo(() => new Map(Object.entries(revenueContributionData?.byFc ?? {})), [revenueContributionData]);
  const revenueRecordById = useMemo(() => new Map((revenueContributionData?.records ?? []).map((record) => [record.id, record])), [revenueContributionData]);
  const tceMapCount = useMemo(() => data?.nodes.filter((node) => node.type === "FC" && tceFcIds.has(node.label.toLocaleUpperCase())).length ?? 0, [data, tceFcIds]);
  const tceBaseNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!data) return ids;

    const tceFeatureCodeIds = new Set(
      data.nodes
        .filter((node) => node.type === "FC" && tceFcIds.has(node.label.toLocaleUpperCase()))
        .map((node) => node.id),
    );
    for (const featureCodeId of tceFeatureCodeIds) ids.add(featureCodeId);

    // The base TCE map is deliberately limited to the upstream chain. Walking
    // the whole connected component would bring Options and non-TCE FCs back
    // through shared SBBs/PPNs, making the general view misleadingly broad.
    for (const link of data.links) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      const sourceNode = nodeById.get(source);
      const targetNode = nodeById.get(target);
      if (sourceNode?.type === "SBB" && tceFeatureCodeIds.has(target)) ids.add(source);
      if (targetNode?.type === "SBB" && tceFeatureCodeIds.has(source)) ids.add(target);
    }

    const tceSbbIds = new Set([...ids].filter((id) => nodeById.get(id)?.type === "SBB"));
    for (const link of data.links) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      const sourceNode = nodeById.get(source);
      const targetNode = nodeById.get(target);
      if (sourceNode?.type === "PPN" && tceSbbIds.has(target)) ids.add(source);
      if (targetNode?.type === "PPN" && tceSbbIds.has(source)) ids.add(target);
    }
    return ids;
  }, [data, nodeById, tceFcIds]);
  const tceBaseViewEnabled = tceOnlyEnabled && !focusOnly;

  const graphData = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const allowed = new Set(
      data.nodes
        .filter((node) => node.type !== "GRP" && enabledTypes.has(node.type))
        .filter((node) => {
          if (tceBaseViewEnabled) {
            if (!tceBaseNodeIds.has(node.id)) return false;
          }
          return !focusOnly || !highlightedIds || highlightedIds.has(node.id);
        })
        .map((node) => node.id),
    );
    return {
      nodes: data.nodes.filter((node) => allowed.has(node.id)),
      links: data.links.filter((link) => allowed.has(endpointId(link.source)) && allowed.has(endpointId(link.target))),
    };
  }, [data, enabledTypes, focusOnly, highlightedIds, tceBaseViewEnabled, tceBaseNodeIds]);

  const revenueContributionSummary = useMemo(() => {
    const visibleFeatureCodes = graphData.nodes
      .filter((node) => node.type === "FC")
      .filter((node) => !tceOnlyEnabled || tceFcIds.has(node.label.toLocaleUpperCase()));
    const recordIds = new Set<number>();
    let missingFeatureCodes = 0;

    for (const node of visibleFeatureCodes) {
      const metric = revenueByFc.get(node.label.toLocaleUpperCase());
      if (!metric || metric.revenue === null && metric.units === null) {
        missingFeatureCodes += 1;
        continue;
      }
      for (const recordId of metric.recordIds) recordIds.add(recordId);
    }

    let revenue = 0;
    let units = 0;
    let hasRevenue = false;
    let hasUnits = false;
    for (const recordId of recordIds) {
      const record = revenueRecordById.get(recordId);
      if (!record) continue;
      if (record.revenue !== null) {
        revenue += record.revenue;
        hasRevenue = true;
      }
      if (record.units !== null) {
        units += record.units;
        hasUnits = true;
      }
    }

    return {
      featureCodes: visibleFeatureCodes.length,
      missingFeatureCodes,
      revenue: hasRevenue ? revenue : null,
      units: hasUnits ? units : null,
    };
  }, [graphData.nodes, revenueByFc, revenueRecordById, tceFcIds, tceOnlyEnabled]);

  const mapStats = useMemo(() => {
    if (!data) {
      return { nodes: 0, links: 0, counts: { PPN: 0, SBB: 0, FC: 0, Option: 0 } as Record<CoreNodeType, number>, thirdValue: 0, thirdLabel: "Rows" };
    }
    if (!tceBaseViewEnabled) {
      return { nodes: data.stats.nodes, links: data.stats.links, counts: data.stats.counts, thirdValue: data.stats.rows, thirdLabel: "Rows" };
    }
    const visibleNodes = data.nodes.filter((node) => node.type !== "GRP" && tceBaseNodeIds.has(node.id));
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const counts: Record<CoreNodeType, number> = { PPN: 0, SBB: 0, FC: 0, Option: 0 };
    for (const node of visibleNodes) counts[node.type as CoreNodeType] += 1;
    const links = data.links.filter((link) => visibleIds.has(endpointId(link.source)) && visibleIds.has(endpointId(link.target))).length;
    return { nodes: visibleNodes.length, links, counts, thirdValue: tceMapCount, thirdLabel: "TCE FCs" };
  }, [data, tceBaseViewEnabled, tceBaseNodeIds, tceMapCount]);

  const suggestions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized || !data) return [];
    return data.nodes
      .filter((node) => node.type !== "GRP" && enabledTypes.has(node.type))
      .filter((node) => !tceBaseViewEnabled || tceBaseNodeIds.has(node.id))
      .filter((node) => !focusOnly || !highlightedIds || highlightedIds.has(node.id))
      .map((node) => {
        const label = node.label.toLocaleLowerCase();
        const matchingName = node.mktgNames.find((name) => name.toLocaleLowerCase().includes(normalized));
        const score = label === normalized ? 0 : label.startsWith(normalized) ? 1 : label.includes(normalized) ? 2 : matchingName ? 3 : 99;
        return { node, score, matchingName };
      })
      .filter((item) => item.score < 99)
      .sort((a, b) => a.score - b.score || b.node.degree - a.node.degree || a.node.label.localeCompare(b.node.label))
      .slice(0, 8);
  }, [query, data, enabledTypes, focusOnly, highlightedIds, tceBaseViewEnabled, tceBaseNodeIds]);

  const returnToBaseMap = useCallback(() => {
    setSelectedId(null);
    setFocusOnly(false);
    setRevenueContributionEnabled(false);
    setSearchOpen(false);
    setLayoutRequest((current) => current + 1);
  }, []);

  const focusNode = useCallback((node: GraphNode, isolate = true, toggleSelected = false) => {
    if (toggleSelected && isolate && focusOnly && selectedId === node.id) {
      returnToBaseMap();
      return;
    }
    setSelectedId(node.id);
    setFocusOnly(isolate);
    setQuery("");
    setSearchOpen(false);
    setLayoutRequest((current) => current + 1);
  }, [focusOnly, returnToBaseMap, selectedId]);

  const copyNodeId = useCallback(async (node: GraphNode) => {
    try {
      await navigator.clipboard.writeText(node.label);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = node.label;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      textArea.remove();
    }
    setCopiedId(node.label);
    window.setTimeout(() => setCopiedId((current) => current === node.label ? null : current), 1600);
  }, []);

  const clearFocus = useCallback(() => {
    if (!selectedId && !focusOnly) {
      graphRef.current?.zoomToFit(700, 55);
      return;
    }
    returnToBaseMap();
  }, [focusOnly, returnToBaseMap, selectedId]);

  const regenerateLayout = useCallback((nodes: GraphNode[], padding = 60) => {
    const transitionId = ++layoutTransitionRef.current;
    const orderedNodes = [...nodes].sort((first, second) =>
      NODE_TYPE_ORDER.indexOf(first.type) - NODE_TYPE_ORDER.indexOf(second.type)
      || first.label.localeCompare(second.label));
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const spacing = orderedNodes.length < 80 ? 12 : orderedNodes.length < 400 ? 9 : 7;

    for (const [index, node] of orderedNodes.entries()) {
      // Re-seed every visible node around the graph origin. Filtering used to
      // preserve the coordinates from the full map, so the smaller TCE graph
      // remained spread across large empty areas instead of being redesigned.
      const radius = spacing * Math.sqrt(index);
      const angle = index * goldenAngle;
      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
      (node as GraphNode & { vx?: number }).vx = 0;
      (node as GraphNode & { vy?: number }).vy = 0;
      delete (node as GraphNode & { fx?: number }).fx;
      delete (node as GraphNode & { fy?: number }).fy;
    }
    setDidFit(false);
    window.setTimeout(() => {
      if (layoutTransitionRef.current !== transitionId) return;
      graphRef.current?.d3ReheatSimulation();
      for (const delay of [180, 520, 1000]) {
        window.setTimeout(() => {
          if (layoutTransitionRef.current === transitionId) graphRef.current?.zoomToFit(650, padding);
        }, delay);
      }
    }, 30);
  }, []);

  useEffect(() => {
    if (!layoutRequest) return;
    const timer = window.setTimeout(() => regenerateLayout(graphData.nodes, focusOnly ? revenueContributionEnabled ? 105 : 80 : tceBaseViewEnabled ? 70 : 55), 0);
    return () => window.clearTimeout(timer);
  }, [focusOnly, graphData.nodes, layoutRequest, regenerateLayout, revenueContributionEnabled, tceBaseViewEnabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement !== searchRef.current) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        returnToBaseMap();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [returnToBaseMap]);

  const toggleType = (type: CoreNodeType) => {
    setEnabledTypes((current) => {
      const next = new Set(current);
      if (next.has(type) && next.size > 1) next.delete(type);
      else next.add(type);
      return next;
    });
    if (selectedNode?.type === type && enabledTypes.has(type)) clearFocus();
  };

  const selectedRelationsByLevel = useMemo(() => {
    const levels = Array.from({ length: relationshipDepth }, () => new Map<NodeType, GraphNode[]>());
    if (!hopById) return levels;
    for (const [nodeId, depth] of hopById) {
      if (depth === 0) continue;
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const grouped = levels[depth - 1];
      if (!grouped) continue;
      if (!grouped.has(node.type)) grouped.set(node.type, []);
      grouped.get(node.type)?.push(node);
    }
    for (const grouped of levels) {
      for (const nodes of grouped.values()) nodes.sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
    }
    return levels;
  }, [hopById, nodeById, relationshipDepth]);

  const relationshipLevelCounts = useMemo(
    () => selectedRelationsByLevel.map((groups) => [...groups.values()].reduce((total, nodes) => total + nodes.length, 0)),
    [selectedRelationsByLevel],
  );
  const focusedRelationshipCount = relationshipLevelCounts.reduce((total, count) => total + count, 0);

  const drawNode = useCallback((nodeValue: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = nodeValue as GraphNode;
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const isSelected = node.id === selectedId;
    const isHighlighted = !highlightedIds || highlightedIds.has(node.id);
    const isTceFeatureCode = tceOnlyEnabled && node.type === "FC" && tceFcIds.has(node.label.toLocaleUpperCase());
    const fillColor = isTceFeatureCode ? TCE_COLOR : node.color;
    const radius = Math.min(12, 3.8 + Math.sqrt(Math.max(1, node.degree)) * 1.15) + (isSelected ? 2.5 : 0);

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(fillColor, isHighlighted ? 0.98 : 0.12);
    ctx.fill();

    if (isHighlighted) {
      ctx.strokeStyle = isSelected ? "rgba(255,255,255,.95)" : hexToRgba(fillColor, isTceFeatureCode ? 0.72 : 0.30);
      ctx.lineWidth = (isSelected ? 1.8 : 0.65) / globalScale;
      ctx.stroke();
    }

    const showLabel = isSelected || (!!highlightedIds && highlightedIds.has(node.id)) || globalScale > 3.2 || (globalScale > 1.6 && node.degree >= 18);
    if (showLabel && isHighlighted) {
      const maxLabelWidth = radius * 1.72;
      const preferredFontSize = Math.max(2.4, Math.min(4.8, radius * 0.42));
      ctx.font = `${isSelected ? 700 : 600} ${preferredFontSize}px Inter, Arial, sans-serif`;
      const measuredWidth = Math.max(1, ctx.measureText(node.label).width);
      const fontSize = Math.max(1.15, Math.min(preferredFontSize, preferredFontSize * (maxLabelWidth / measuredWidth)));
      ctx.font = `${isSelected ? 700 : 600} ${fontSize}px Inter, Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255,255,255,.96)";
      ctx.fillText(node.label, x, y, maxLabelWidth);
    }

    if (!revenueContributionEnabled || !focusOnly || node.type !== "FC" || !isHighlighted) return;
    const metric = revenueByFc.get(node.label.toLocaleUpperCase());
    const badgeText = revenueMetricLabel(metric);
    const badgeFontSize = Math.max(2.4, Math.min(3.5, radius * 0.34));
    const horizontalPadding = badgeFontSize * 0.72;
    const badgeHeight = badgeFontSize * 1.9;
    const badgeRadius = badgeFontSize * 0.5;
    ctx.font = `650 ${badgeFontSize}px Inter, Arial, sans-serif`;
    const badgeWidth = ctx.measureText(badgeText).width + horizontalPadding * 2;
    const badgeX = x + radius * 0.62;
    const badgeY = y - radius - badgeHeight * 0.72;

    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, badgeRadius);
    ctx.fillStyle = "rgba(12,16,24,.94)";
    ctx.fill();
    ctx.strokeStyle = hexToRgba(fillColor, 0.78);
    ctx.lineWidth = 0.34;
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,.97)";
    ctx.fillText(badgeText, badgeX + horizontalPadding, badgeY + badgeHeight / 2);
  }, [selectedId, highlightedIds, tceFcIds, tceOnlyEnabled, revenueContributionEnabled, focusOnly, revenueByFc]);

  const paintPointer = useCallback((nodeValue: object, color: string, ctx: CanvasRenderingContext2D) => {
    const node = nodeValue as GraphNode;
    const radius = Math.min(12, 3.8 + Math.sqrt(Math.max(1, node.degree)) * 1.15) + (node.id === selectedId ? 2.5 : 0);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, radius + 2, 0, Math.PI * 2);
    ctx.fill();
  }, [selectedId]);

  const nodeTooltip = useCallback((nodeValue: object) => {
    const node = nodeValue as GraphNode;
    const tooltipColor = tceOnlyEnabled && node.type === "FC" && tceFcIds.has(node.label.toLocaleUpperCase()) ? TCE_COLOR : node.color;
    const renderSection = (label: string, details: string[]) => {
      const values = details.map((value) => `<div class="node-tooltip-value">${escapeHtml(value)}</div>`).join("");
      return `<section class="node-tooltip-section"><div class="node-tooltip-label">${label}</div><div class="node-tooltip-values">${values || `<div class="node-tooltip-empty">No ${label} available</div>`}</div></section>`;
    };
    const details = node.type === "PPN"
      ? `${renderSection("PPN Description", node.ppnDescriptions)}${renderSection("Vendor", node.vendors)}`
      : node.type === "FC" || node.type === "Option" || node.type === "GRP"
        ? `${renderSection("MKTGNAME", node.mktgNames)}${renderSection("Family", tooltipFamilyValues(node.families))}${renderSection("Brand", node.brands)}`
        : renderSection("MKTGNAME", node.mktgNames);
    return `<div class="node-tooltip-content"><strong style="color:${tooltipColor}">${escapeHtml(node.type)}</strong><div class="node-tooltip-id">${escapeHtml(node.label)}</div>${details}<div class="node-tooltip-copy">Ctrl + left click to copy ID</div></div>`;
  }, [tceFcIds, tceOnlyEnabled]);

  const repositionTooltip = useCallback((clientX: number, clientY: number) => {
    window.cancelAnimationFrame(tooltipPositionFrameRef.current);
    tooltipPositionFrameRef.current = window.requestAnimationFrame(() => {
      const stage = graphStageRef.current;
      const tooltip = stage?.querySelector<HTMLElement>(".float-tooltip-kap");
      if (!stage || !tooltip || window.getComputedStyle(tooltip).display === "none") return;

      const stageRect = stage.getBoundingClientRect();
      const mouseX = clientX - stageRect.left;
      const mouseY = clientY - stageRect.top;
      const margin = 12;
      const cursorGap = 18;

      const tooltipRect = tooltip.getBoundingClientRect();
      const left = Math.max(margin, Math.min(mouseX - tooltipRect.width / 2, stageRect.width - tooltipRect.width - margin));
      const spaceAbove = mouseY - margin;
      const spaceBelow = stageRect.height - mouseY - margin;
      const placeAbove = tooltipRect.height + cursorGap > spaceBelow && spaceAbove > spaceBelow;
      const top = placeAbove
        ? Math.max(margin, mouseY - tooltipRect.height - cursorGap)
        : Math.min(stageRect.height - tooltipRect.height - margin, mouseY + cursorGap);

      stage.style.setProperty("--node-tooltip-left", `${left}px`);
      stage.style.setProperty("--node-tooltip-top", `${Math.max(margin, top)}px`);
      stage.classList.add("tooltip-viewport-positioned");
    });
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent | MouseEvent) => {
      const stage = graphStageRef.current;
      if (!stage) return;
      const bounds = stage.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      repositionTooltip(event.clientX, event.clientY);
    };
    window.addEventListener("pointermove", handlePointerMove, { capture: true, passive: true });
    window.addEventListener("mousemove", handlePointerMove, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("mousemove", handlePointerMove, { capture: true });
      window.cancelAnimationFrame(tooltipPositionFrameRef.current);
    };
  }, [repositionTooltip]);

  const workspaceClass = selectedNode ? "workspace has-details" : "workspace";
  const sourceDate = data ? new Date(data.source.modifiedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><GitBranch size={18} /></div>
          <div className="brand-copy">
            <div className="brand-heading">
              <h1>Components Map</h1>
              <span className="version-badge">v{appVersion}</span>
            </div>
            <p>Product relationship explorer</p>
          </div>
        </div>

        <div className="search-wrap">
          <div className="search-box">
            <Search size={16} color="#8792a9" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && suggestions[0]) focusNode(suggestions[0].node);
              }}
              placeholder="Search by ID or MKTGNAME…"
              aria-label="Search by ID or MKTGNAME"
            />
            {query ? <button className="icon-button" style={{ width: 26, height: 26, border: 0 }} onClick={() => setQuery("")} aria-label="Clear search"><X size={13} /></button> : <span className="key-hint">/</span>}
          </div>
          {searchOpen && query.trim() && (
            <div className="suggestions">
              {suggestions.length ? suggestions.map(({ node, matchingName }) => (
                <button key={node.id} className="suggestion" onMouseDown={(event) => event.preventDefault()} onClick={() => focusNode(node)}>
                  <span className="type-dot" style={{ color: node.color, background: node.color }} />
                  <span className="suggestion-copy">
                    <strong>{node.label}</strong>
                    <small>{node.type}{matchingName ? ` · ${matchingName}` : node.mktgNames[0] ? ` · ${node.mktgNames[0]}` : ""}</small>
                  </span>
                  <ChevronRight size={13} color="#69738a" />
                </button>
              )) : <div style={{ padding: "12px", color: "#7f899f", fontSize: 11 }}>No matching items found.</div>}
            </div>
          )}
        </div>

        <div className="top-actions">
          <span className="status-pill"><span className="status-led" style={error ? { background: "#ff6b6b", boxShadow: "0 0 12px rgba(255,107,107,.75)" } : undefined} />{loadingProgress ? loadingProgress.phase : pendingUpload ? "Choose comm2" : error ? "CSV error" : hasLocalData ? "Local data · not uploaded" : "No local data"}</span>
          <button className="text-button" onClick={() => {
            void loadGraph(selectedFilters, familyContains, data?.stats.rows ?? 0, true, removeDummyEnabled);
          }} disabled={loading || uploading || !!pendingUpload || !hasLocalData}><RefreshCw size={13} className={loading || uploading ? "spin" : ""} /> Reload</button>
        </div>
      </header>

      <div className={workspaceClass}>
        <aside className="sidebar">
          <section className="section">
            <h2 className="section-title">Relationship chain</h2>
            <div className="chain">
              {TYPE_ORDER.map((type, index) => (
                <span key={type} style={{ display: "contents" }}>
                  <span className="chain-step" style={{ color: TYPE_COLORS[type] }}>{type}</span>
                  {index < TYPE_ORDER.length - 1 && <span className="chain-arrow">→</span>}
                </span>
              ))}
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">Filters</h2>
            {FILTER_CONFIG.map(({ key, label }) => (
              <FacetMultiSelect
                key={key}
                filterKey={key}
                label={label}
                filter={data?.filters[key]}
                selected={selectedFilters[key]}
                disabled={loading || !data?.filters[key].available}
                onChange={(filterKey, values) => void applyFacetFilter(filterKey, values)}
              />
            ))}
            <form className="family-filter" onSubmit={(event) => { event.preventDefault(); void applyFamilyFilter(); }}>
              <label className="filter-field">
                <span>Family contains</span>
                <div className="family-filter-row">
                  <input
                    type="text"
                    value={familyDraft}
                    onChange={(event) => setFamilyDraft(event.target.value)}
                    placeholder="e.g. SR650 V4"
                    maxLength={100}
                    disabled={loading || !data?.filters.family.available}
                    aria-label="Family contains filter"
                  />
                  <button className="text-button primary" type="submit" disabled={loading || !data?.filters.family.available || familyDraft.trim() === familyContains}>Apply</button>
                  {familyContains && (
                    <button className="icon-button family-clear" type="button" onClick={() => void clearFamilyFilter()} disabled={loading} aria-label="Clear Family filter" title="Clear Family filter">
                      <X size={13} />
                    </button>
                  )}
                </div>
              </label>
              <small>{familyContains ? `Active: ${familyContains}` : "Optional · ignores spaces and punctuation"}</small>
            </form>
            <button
              className={`layer-control tce-control tce-only-control ${tceOnlyEnabled ? "active" : ""}`}
              onClick={() => {
                const nextState = !tceOnlyEnabled;
                setTceOnlyEnabled(nextState);
                if (!focusOnly) {
                  setSelectedId(null);
                  setLayoutRequest((current) => current + 1);
                }
              }}
              disabled={tceLoading || !tceData?.available || tceMapCount === 0}
              aria-pressed={tceOnlyEnabled}
            >
              <span className="layer-icon tce-color-swatch" aria-hidden="true"><span /></span>
              <span className="layer-copy">
                <strong>Show TCE only</strong>
                <small>{tceLoading ? "Reading TCE selection" : tceData?.available ? focusOnly ? "Highlight matching FCs in the current focus" : `Keep ${formatNumber(tceMapCount)} TCE FCs with SBB and PPN` : "TCE selection file required"}</small>
              </span>
              <span className="layer-switch" aria-hidden="true"><span /></span>
            </button>
            <button
              className={`layer-control revenue-control ${revenueContributionEnabled ? "active" : ""}`}
              onClick={() => {
                const nextState = !revenueContributionEnabled;
                setRevenueContributionEnabled(nextState);
                if (nextState) window.setTimeout(() => graphRef.current?.zoomToFit(550, 105), 40);
              }}
              disabled={revenueContributionLoading || !revenueContributionData?.available || !focusOnly || !selectedNode}
              aria-pressed={revenueContributionEnabled}
              title={revenueContributionData?.error}
            >
              <span className="layer-icon revenue-icon" aria-hidden="true">$</span>
              <span className="layer-copy">
                <strong>Revenue Contribution &amp; Units</strong>
                <small>{revenueContributionLoading
                  ? "Reading revenue contribution file"
                  : !revenueContributionData?.available
                    ? "Revenue Contribution file required"
                    : !focusOnly || !selectedNode
                      ? "Available in Zoom In"
                      : revenueContributionEnabled
                        ? "Showing values for visible FCs"
                        : "Show revenue and units for visible FCs"}</small>
              </span>
              <span className="layer-switch" aria-hidden="true"><span /></span>
            </button>
            <button
              className={`layer-control dummy-control ${removeDummyEnabled ? "active" : ""}`}
              onClick={() => {
                const nextState = !removeDummyEnabled;
                setRemoveDummyEnabled(nextState);
                setSelectedId(null);
                setFocusOnly(false);
                setRevenueContributionEnabled(false);
                void loadGraph(selectedFilters, familyContains, data?.stats.rows ?? 0, true, nextState);
              }}
              disabled={loading || uploading || !!pendingUpload}
              aria-pressed={removeDummyEnabled}
            >
              <span className="layer-icon dummy-icon" aria-hidden="true"><X size={16} /></span>
              <span className="layer-copy">
                <strong>Remove dummy</strong>
                <small>Exclude rows whose PPN description contains DUMMY</small>
              </span>
              <span className="layer-switch" aria-hidden="true"><span /></span>
            </button>
            <label className="tce-file-picker">
              <Upload size={12} />
              <span>{tceData?.available ? `Source: ${tceData.source?.fileName ?? "TCE file"} · Change` : "Select TCE Excel file"}</span>
              <input ref={tceFileInputRef} type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => void uploadTceWorkbook(event)} disabled={tceLoading} aria-label="Select TCE Excel file" />
            </label>
            {tceError && <p className="tce-file-error">{tceError}</p>}
            <label className="tce-file-picker">
              <Upload size={12} />
              <span>{revenueContributionData?.available ? `Revenue: ${revenueContributionData.source?.fileName ?? "file"} · Change` : "Select Revenue Contribution file"}</span>
              <input type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => void uploadRevenueWorkbook(event)} disabled={revenueContributionLoading} aria-label="Select Revenue Contribution Excel file" />
            </label>
            {revenueError && <p className="tce-file-error">{revenueError}</p>}
          </section>

          <section className="section compact-summary-section">
            <h2 className="section-title">Categories</h2>
            <div className="category-grid">
              {TYPE_ORDER.map((type) => (
                <button key={type} className={`category-card ${enabledTypes.has(type) ? "" : "off"}`} onClick={() => toggleType(type)}>
                  <span className="category-card-heading">
                    <span className="type-dot" style={{ color: TYPE_COLORS[type], background: TYPE_COLORS[type] }} />
                    <span>{type}</span>
                  </span>
                  <strong>{formatNumber(mapStats.counts[type])}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="section compact-summary-section">
            <h2 className="section-title">Map</h2>
            <div className="stats-grid">
              <div className="stat-card"><strong>{formatNumber(mapStats.nodes)}</strong><span>Nodes</span></div>
              <div className="stat-card"><strong>{formatNumber(mapStats.links)}</strong><span>Relationships</span></div>
              <div className="stat-card"><strong>{formatNumber(mapStats.thirdValue)}</strong><span>{mapStats.thirdLabel}</span></div>
              <div className="stat-card"><strong>{selectedNode ? focusedRelationshipCount : 0}</strong><span>In focus</span></div>
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">Source</h2>
            <div className="source-card">
              <strong>{data?.source.fileName ?? (hasLocalData === false ? "No CSV selected" : "Loading file…")}</strong>
              <span>{data ? `Format ${data.source.sheetName} · updated ${sourceDate}` : hasLocalData === false ? "Choose the Magellan CSV from this computer" : "Reading data"}</span>
            </div>
            <label className={`file-upload ${uploading ? "loading-file" : ""}`}>
              <Upload size={15} />
              <span><strong>{uploading ? "Processing file…" : "Select CSV file"}</strong><small>.csv · up to 250 MB</small></span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => void uploadWorkbook(event)}
                disabled={uploading}
                aria-label="Select a CSV file to build the map"
              />
            </label>
            {uploadError && <p className="file-upload-error">{uploadError}</p>}
            <p className="local-privacy-note"><ShieldCheck size={12} /> Files are processed in this browser and stored only on this computer. Nothing is uploaded.</p>
            {hasLocalData !== null && (hasLocalData || tceData?.available || revenueContributionData?.available) && (
              <button className="local-forget-button" type="button" onClick={() => void forgetLocalData()} disabled={loading || uploading}>
                <Trash2 size={12} /> Remove data stored in this browser
              </button>
            )}
          </section>
        </aside>

        <section
          ref={graphStageRef}
          className="graph-stage"
          aria-label="Interactive relationship map"
          onMouseLeave={(event) => event.currentTarget.classList.remove("tooltip-viewport-positioned")}
        >
          {hasLocalData === false && !data && !pendingUpload ? (
            <div
              className={`welcome-state ${dragActive ? "drag-active" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={dropLocalFiles}
            >
              <div className="welcome-card">
                <div className="welcome-icon"><HardDrive size={26} /></div>
                <h2>Open your local data</h2>
                <p>Select or drop the files from this computer. They are read by your browser and never leave this machine.</p>
                <ul className="welcome-files">
                  <li><strong>Magellan PPN Tool Extended Export.csv</strong><span>Required · builds the map</span></li>
                  <li><strong>TCE Selection.xlsx</strong><span>Optional · Show TCE only</span></li>
                  <li><strong>Revenue Contribution.xlsx</strong><span>Optional · revenue &amp; units</span></li>
                </ul>
                <label className={`welcome-picker ${uploading ? "loading-file" : ""}`}>
                  <Upload size={15} />
                  <span>{uploading ? "Processing files…" : "Select files"}</span>
                  <input type="file" multiple accept=".csv,text/csv,.xlsx,.xls" onChange={(event) => void selectLocalFiles(event)} disabled={uploading} aria-label="Select local data files" />
                </label>
                <small>You can select the three files at once. Workbooks are detected automatically.</small>
                {uploadError && <p className="file-upload-error">{uploadError}</p>}
                <p className="welcome-privacy"><ShieldCheck size={12} /> The processed data is kept in this browser so the next visit opens instantly. Remove it any time from the Source panel.</p>
              </div>
            </div>
          ) : loading && !data ? (
            <div className="loading"><div className="loading-card"><div className="loading-orbit" /><h2>Building the map</h2><p>Reading the CSV file and arranging the items.</p></div></div>
          ) : error ? (
            <div className="error-state"><div className="error-card"><FileSpreadsheet size={30} color="#ffad4d" /><h2>CSV file could not be read</h2><p>{error}</p><button className="text-button primary" style={{ marginTop: 16 }} onClick={() => void loadGraph(selectedFilters, familyContains, data?.stats.rows ?? 0, true, removeDummyEnabled)}><RefreshCw size={13} /> Try again</button></div></div>
          ) : (
            <>
              <div className="graph-canvas">
                <ForceGraph2D
                  ref={graphRef as React.MutableRefObject<never>}
                  width={dimensions.width}
                  height={dimensions.height}
                  graphData={graphData}
                  backgroundColor="#080b11"
                  nodeCanvasObject={drawNode}
                  nodePointerAreaPaint={paintPointer}
                  nodeLabel={nodeTooltip}
                  linkColor={(linkValue: object) => {
                    const link = linkValue as GraphLink;
                    if (!selectedId) return "rgba(174,190,222,.38)";
                    const source = endpointId(link.source);
                    const target = endpointId(link.target);
                    const isDirect = source === selectedId || target === selectedId;
                    const isWithinTwoLevels = highlightedIds?.has(source) && highlightedIds.has(target);
                    if (isDirect) return "rgba(220,228,255,.94)";
                    return isWithinTwoLevels ? "rgba(184,202,242,.72)" : "rgba(130,145,177,.07)";
                  }}
                  linkWidth={(linkValue: object) => {
                    const link = linkValue as GraphLink;
                    if (!selectedId) return 0.9;
                    const source = endpointId(link.source);
                    const target = endpointId(link.target);
                    if (source === selectedId || target === selectedId) return 2.2;
                    return highlightedIds?.has(source) && highlightedIds.has(target) ? 1.35 : 0.25;
                  }}
                  linkDirectionalParticles={(linkValue: object) => {
                    const link = linkValue as GraphLink;
                    if (!selectedId) return 0;
                    const source = endpointId(link.source);
                    const target = endpointId(link.target);
                    return highlightedIds?.has(source) && highlightedIds.has(target) ? 1 : 0;
                  }}
                  linkDirectionalParticleWidth={1.8}
                  linkDirectionalParticleSpeed={0.003}
                  onNodeClick={(nodeValue: object, event: MouseEvent) => {
                    const node = nodeValue as GraphNode;
                    if (event.ctrlKey && event.button === 0) {
                      void copyNodeId(node);
                      return;
                    }
                    focusNode(node, true, true);
                  }}
                  onNodeRightClick={(nodeValue: object, event: MouseEvent) => {
                    event.preventDefault();
                    focusNode(nodeValue as GraphNode, true, true);
                  }}
                  onBackgroundClick={clearFocus}
                  onEngineStop={() => {
                    if (!didFit) {
                      graphRef.current?.zoomToFit(700, selectedId && focusOnly ? revenueContributionEnabled ? 105 : 80 : 46);
                      setDidFit(true);
                    }
                  }}
                  cooldownTicks={180}
                  warmupTicks={36}
                  d3AlphaDecay={0.028}
                  d3VelocityDecay={0.32}
                  minZoom={0.12}
                  maxZoom={12}
                  enableNodeDrag
                />
              </div>

              {focusOnly && selectedNode && (
                <div className="focus-banner">
                  <Focus size={13} color={selectedNode.color} />
                  <span className="focus-summary">Showing {relationshipDepth} {relationshipDepth === 1 ? "level" : "levels"} · {focusedRelationshipCount} related</span>
                  <label className="depth-slider" htmlFor="focus-depth-slider">
                    <span>Depth</span>
                    <input
                      id="focus-depth-slider"
                      type="range"
                      min={1}
                      max={10}
                      step={1}
                      value={relationshipDepth}
                      onChange={(event) => {
                        setRelationshipDepth(Number(event.target.value) as RelationshipDepth);
                        setLayoutRequest((current) => current + 1);
                      }}
                      aria-label="Relationship depth"
                    />
                    <strong>{relationshipDepth}</strong>
                  </label>
                  <button className="text-button primary" onClick={returnToBaseMap}><UnfoldHorizontal size={12} /> {tceOnlyEnabled ? "View TCE base" : "View full map"}</button>
                </div>
              )}

              {revenueContributionEnabled && focusOnly && (
                <div className="revenue-summary" aria-live="polite">
                  <strong>{revenueContributionSummary.revenue === null && revenueContributionSummary.units === null
                    ? "- / -"
                    : `Rev. Contribution ${revenueContributionSummary.revenue === null ? "-" : formatCompactRevenue(revenueContributionSummary.revenue)} / Units ${revenueContributionSummary.units === null ? "-" : formatCompactUnits(revenueContributionSummary.units)}`}</strong>
                  <small>{formatNumber(revenueContributionSummary.featureCodes)} {revenueContributionSummary.featureCodes === 1 ? "FC" : "FCs"}{tceOnlyEnabled ? " · TCE only" : ""}{revenueContributionSummary.missingFeatureCodes ? ` · ${formatNumber(revenueContributionSummary.missingFeatureCodes)} without data` : ""}</small>
                </div>
              )}

              <div className={`floating-controls ${revenueContributionEnabled && focusOnly ? "revenue-summary-active" : ""}`}>
                <button className="icon-button" onClick={() => graphRef.current?.zoom((graphRef.current?.zoom() ?? 1) * 1.35, 250)} aria-label="Zoom in"><Plus size={15} /></button>
                <button className="icon-button" onClick={() => graphRef.current?.zoom((graphRef.current?.zoom() ?? 1) / 1.35, 250)} aria-label="Zoom out"><Minus size={15} /></button>
                <button className="icon-button" onClick={() => graphRef.current?.zoomToFit(650, revenueContributionEnabled && focusOnly ? 105 : 50)} aria-label="Fit map"><Maximize2 size={14} /></button>
              </div>
              {copiedId && <div className="copy-toast">ID {copiedId} copied</div>}
              <div className="graph-caption">Drag to explore · scroll to zoom · select a node to view its relationships</div>
            </>
          )}
        </section>

        {selectedNode && (
          <aside className="details-panel">
            <div className="details-heading">
              <div className="node-orb" style={{ background: selectedNode.color, color: selectedNode.color }}><Box size={16} color="white" /></div>
              <div className="details-heading-copy"><p className="eyebrow">{selectedNode.type}</p><h2>{selectedNode.label}</h2></div>
              <button className="icon-button close" onClick={clearFocus} aria-label="Close details"><X size={14} /></button>
            </div>

            <div className="detail-block"><span className="degree-badge"><GitBranch size={12} /> {focusedRelationshipCount} related · {relationshipDepth} {relationshipDepth === 1 ? "level" : "levels"}</span></div>

            {selectedNode.type === "PPN" ? (
              <>
                <div className="detail-block">
                  <h3>PPN Description</h3>
                  <div className="marketing-list">
                    {selectedNode.ppnDescriptions.length ? selectedNode.ppnDescriptions.slice(0, 18).map((value) => <div className="marketing-item" key={value}>{value}</div>) : <div className="marketing-item" style={{ color: "#7f899f" }}>No PPN Description available</div>}
                  </div>
                </div>
                <div className="detail-block">
                  <h3>Vendor</h3>
                  <div className="marketing-list">
                    {selectedNode.vendors.length ? selectedNode.vendors.slice(0, 18).map((value) => <div className="marketing-item" key={value}>{value}</div>) : <div className="marketing-item" style={{ color: "#7f899f" }}>No Vendor available</div>}
                  </div>
                </div>
              </>
            ) : (
              <div className="detail-block">
                <h3>MKTGNAME</h3>
                <div className="marketing-list">
                  {selectedNode.mktgNames.length ? selectedNode.mktgNames.slice(0, 18).map((value) => <div className="marketing-item" key={value}>{value}</div>) : <div className="marketing-item" style={{ color: "#7f899f" }}>No MKTGNAME available</div>}
                  {selectedNode.mktgNames.length > 18 && <div className="more-label">+{selectedNode.mktgNames.length - 18} additional values</div>}
                </div>
              </div>
            )}

            {selectedRelationsByLevel.map((groups, levelIndex) => relationshipLevelCounts[levelIndex] > 0 && (
              <div className="detail-block" key={`level-${levelIndex + 1}`}>
                <h3>{levelIndex === 0 ? "Direct relationships" : `Level ${levelIndex + 1} relationships`}</h3>
                {[...groups.entries()].sort((a, b) => NODE_TYPE_ORDER.indexOf(a[0]) - NODE_TYPE_ORDER.indexOf(b[0])).map(([type, nodes]) => (
                  <div className="relation-group" key={type}>
                    <div className="relation-group-title"><span className="type-dot" style={{ color: TYPE_COLORS[type], background: TYPE_COLORS[type] }} /><span>{type}</span><span>{nodes.length}</span></div>
                    <div className="relation-list">
                      {nodes.slice(0, 24).map((node) => <button className="relation-item" key={node.id} onClick={() => focusNode(node)}>{node.label}</button>)}
                      {nodes.length > 24 && <div className="more-label">+{nodes.length - 24} additional items</div>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </aside>
        )}
      </div>

      {loadingProgress && (
        <div className="progress-overlay" role="status" aria-live="polite">
          <ProgressCard progress={loadingProgress} clock={progressClock} />
        </div>
      )}

      {pendingUpload && (
        <div className="upload-selection-backdrop">
          <div className="upload-selection-dialog" role="dialog" aria-modal="true" aria-labelledby="comm2-dialog-title">
            <div className="dialog-icon"><FileSpreadsheet size={20} /></div>
            <p className="eyebrow">CSV file ready</p>
            <h2 id="comm2-dialog-title">Select a comm2 value</h2>
            <p>Choose the product category to build from <strong>{pendingUpload.source.fileName}</strong>. You can change this filter later.</p>
            <div className="dialog-filter">
              <span className="dialog-filter-label">comm2</span>
              <div className="fccat-choice-list" role="listbox" aria-label="comm2 value for uploaded file" tabIndex={0}>
                {pendingUpload.filters.comm2.options.map((option) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={pendingComm2 === option.value}
                    className={`fccat-choice ${pendingComm2 === option.value ? "selected" : ""}`}
                    key={option.value}
                    onClick={() => setPendingComm2(option.value)}
                  >
                    <span>{option.value}</span>
                    <small>{formatNumber(option.count)} rows</small>
                  </button>
                ))}
              </div>
            </div>
            <button className="text-button primary dialog-action" onClick={() => void confirmPendingUpload()} disabled={!pendingComm2 || loading}>
              {loading ? <RefreshCw size={13} className="spin" /> : <GitBranch size={13} />}
              Build map
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
