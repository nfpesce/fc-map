# Components Map · web (FC Map Web)

Explorador visual de la cadena `PPN → SBB → FC → Option`, publicado como sitio estático (GitHub Pages).
**Los datos nunca se publican ni se suben**: cada usuario selecciona sus archivos locales y el navegador los procesa en su propio equipo.

## Cómo funciona

| Pieza | Dónde corre | Qué hace |
|---|---|---|
| Interfaz (Next.js, export estático) | GitHub Pages | Solo HTML/JS/CSS. No contiene datos. |
| Motor de datos (`lib/engine/data.worker.ts`) | Web Worker en el navegador del usuario | Lee el CSV en streaming, lo indexa en columnas y arma el grafo con los filtros activos. |
| Caché (`lib/engine/storage.ts`) | IndexedDB del navegador | Guarda el dataset procesado, TCE y Revenue para que la próxima visita abra al instante. |

La lógica de negocio es la misma que tenía `app/api/graph/route.ts` (portada a `lib/engine/graph-core.ts`):
exclusión de `SYSTEM_SBB`, de FC con más de cuatro caracteres y de `opt = NULL`; filtros facetados con OR dentro de cada dimensión y AND entre dimensiones; `Remove dummy`, Family, TCE y Revenue.

Garantías de privacidad:

- No hay servidor ni rutas `/api`; el sitio es 100 % estático.
- La página se publica con `Content-Security-Policy: connect-src 'self'`, así que técnicamente no puede enviar datos a otro dominio.
- El workflow de publicación falla si detecta archivos `.csv`/`.xlsx` versionados en el repositorio.
- `Remove data stored in this browser` (panel Source) borra la caché local.

## Uso

1. Abrir la URL del sitio (Chrome o Edge recomendados).
2. Seleccionar o arrastrar los archivos locales. Se pueden elegir los tres a la vez; los Excel se detectan automáticamente por sus columnas:
   - `Magellan PPN Tool Extended Export.csv` (obligatorio).
   - `TCE Selection.xlsx` (opcional, habilita `Show TCE only`).
   - `Revenue Contribution.xlsx` (opcional, habilita `Revenue Contribution & Units` en Zoom In).
3. Elegir el `comm2` inicial. En las visitas siguientes el mapa se abre desde la caché del navegador sin volver a seleccionar archivos.
4. Para actualizar los datos, elegir un CSV o Excel nuevo desde el panel lateral.

## Desarrollo

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm lint
pnpm build        # genera out/ (sitio estático)
pnpm start        # sirve out/ localmente
pnpm test:equivalence "../data_to_import/Magellan PPN Tool Extended Export.csv"
```

`test:equivalence` compara el motor nuevo contra el pipeline original del servidor (`csv-parse` + `route.ts`, copia en `tests/equivalence/legacy-route.ts`) sobre un CSV real: filas, diccionarios, opciones de filtros y grafos completos para varias combinaciones.

Resultado de referencia con el CSV de 143 MB (442.605 filas): todo idéntico; parseo 2 s (vs 7,8 s del servidor anterior); en Chromium, 2,9 s desde la selección del archivo hasta el diálogo de comm2 y 0,3 s al reabrir desde la caché.

## Publicación en GitHub Pages

El workflow `.github/workflows/pages.yml` compila y publica en cada push a `main`. Toma `PAGES_BASE_PATH=/<nombre-del-repo>`.
Requisito único: en GitHub → Settings → Pages → Source: **GitHub Actions**.

## Estructura

```
app/                 UI (relationship-map.tsx, layout con CSP, estilos)
lib/engine/          motor local: graph-core, csv-stream, tce-core, revenue-core, storage, data.worker, client
tests/equivalence/   comparación contra el backend original
.github/workflows/   publicación en GitHub Pages
```
