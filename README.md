# Components Map · web (FC Map)

**Live app: https://nfpesce.github.io/fc-map/**

Visual explorer for the `PPN → SBB → FC → Option` relationship chain, published as a static site on GitHub Pages.
**Data is never published or uploaded.** Each user selects their own local files and the browser processes them on their own machine.

## How it works

| Component | Where it runs | What it does |
|---|---|---|
| UI (Next.js static export) | GitHub Pages | HTML/JS/CSS only. Contains no data. |
| Data engine (`lib/engine/data.worker.ts`) | Web Worker in the user's browser | Streams the CSV, builds a columnar index and generates the graph for the active filters. |
| Cache (`lib/engine/storage.ts`) | Browser IndexedDB | Keeps the processed dataset, TCE and Revenue data so the next visit opens instantly. |

The business logic is the same as the former `app/api/graph/route.ts` (ported to `lib/engine/graph-core.ts`):
`SYSTEM_SBB`, FC ids longer than four characters and `opt = NULL` are excluded; faceted filters use OR within a dimension and AND across dimensions; `Remove dummy`, Family, TCE and Revenue behave as before.

Privacy guarantees:

- No server and no `/api` routes; the site is 100% static.
- The page ships with `Content-Security-Policy: connect-src 'self'`, so it technically cannot send data to any other domain.
- The deployment workflow fails if any `.csv`/`.xlsx` file is tracked in the repository.
- `Remove data stored in this browser` (Source panel) clears the local cache.

## Usage

1. Open https://nfpesce.github.io/fc-map/ (Chrome or Edge recommended).
2. Select or drop your local files. You can pick all three at once; workbooks are detected automatically by their columns:
   - `Magellan PPN Tool Extended Export.csv` (required).
   - `TCE Selection.xlsx` (optional, enables `Show TCE only`).
   - `Revenue Contribution.xlsx` (optional, enables `Revenue Contribution & Units` in Zoom In).
3. Choose the initial `comm2`. On later visits the map opens from the browser cache without selecting files again.
4. To refresh the data, pick a new CSV or workbook from the sidebar.

## Development

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm lint
pnpm build        # generates out/ (static site)
pnpm start        # serves out/ locally
pnpm test:equivalence "../data_to_import/Magellan PPN Tool Extended Export.csv"
```

`test:equivalence` compares the new engine against the original server pipeline (`csv-parse` + `route.ts`, kept in `tests/equivalence/legacy-route.ts`) on a real CSV: row count, dictionaries, filter options and full graphs for several filter combinations.

Reference results with the 143 MB CSV (442,605 rows): identical output; parsing takes 2 s (vs 7.8 s on the former server); in Chromium, 2.9 s from file selection to the comm2 dialog and 0.3 s to reopen from the cache.

## Deployment to GitHub Pages

The `.github/workflows/pages.yml` workflow builds and deploys on every push to `main`, using `PAGES_BASE_PATH=/<repo-name>`.
One-time setup: GitHub → Settings → Pages → Source: **GitHub Actions** (already configured for this repository).

## Structure

```
app/                 UI (relationship-map.tsx, layout with CSP, styles)
lib/engine/          local engine: graph-core, csv-stream, tce-core, revenue-core, storage, data.worker, client
tests/equivalence/   comparison against the original backend
.github/workflows/   GitHub Pages deployment
```
