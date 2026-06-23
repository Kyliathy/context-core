# PWA Conversion — ContextCore Visualizer

**Date**: 2026-03-19
**Scope**: Convert `visualizer/` SPA into an installable Progressive Web App
**Goal**: Standalone browser window via `display: standalone`, app-shell caching, offline-resilient UI
**Non-goal**: Offline-first data (the backend API remains the source of truth — this is not an offline app)

---

## Context & Constraints

The visualizer is a Vite + React + D3 SPA served from Express at `:3210` via `express.static("visualizer/dist")`. In dev, Vite runs on `:5173`. All data comes from REST API calls to the backend (search, sessions, threads, agent builder). Client-side state (views, favorites, search history) lives in `localStorage` and already works without the network.

**What PWA buys us:**
- **Installable** — opens as a standalone window (no browser chrome) via Chrome/Edge "Install app"
- **App shell caching** — HTML/CSS/JS cached by service worker, so the shell loads instantly even if the backend is slow or briefly unreachable
- **Runtime API caching** — previously fetched search results / sessions available as stale fallback
- **Mobile-friendly** — proper manifest, icons, theme color for home-screen install on mobile

**What stays server-side (not PWA):**
- Qdrant vector search, SQLite database, harness ingestion, MCP transports, file watchers — all remain on the backend

**Zero impact on existing web app functionality:**
- The manifest and meta tags are inert in browsers that don't support PWA — they are simply ignored
- The service worker is a separate file that loads in parallel; if it fails, is absent, or is not yet installed, the app functions identically to today
- `vite-plugin-pwa` only **adds** files to the build output (`sw.js`, `manifest.webmanifest`, `registerSW.js`); it does not modify or wrap existing JS/CSS bundles
- All runtime caching strategies are pass-through by design: `NetworkFirst` hits the real API first, `StaleWhileRevalidate` serves fresh in background — the app never sees stale data while online
- The changes that touch existing source code are: (a) the `API_BASE` refactor (Level 5), which replaces `http://localhost:3210` with a relative URL — functionally equivalent, just cleaner for same-origin serving; and (b) the server port configuration (Level 3b), which makes the hardcoded port configurable via `.env` and adds graceful fallback on port conflict. Default behavior is unchanged (`PORT=3210`)
- `localStorage`-backed state (views, favorites, search history) is completely untouched

---

## Existing Assets

| Asset | Path | Details |
|---|---|---|
| **Logo PNG** | `visualizer/ui/ContextCore.png` | 1024×1024 RGBA — brain/space/chat-bubble mark with "ContextCore" text. Source for all PWA icon sizes |
| **Favicon** | `visualizer/ui/favicon.ico` | Already exists (~131 KB, multi-size). Ready to copy into `public/pwa/` |

All PWA icons will be derived from `ContextCore.png` by resizing. No need to generate new artwork.

---

## State Before This Plan

| Aspect | Status |
|---|---|
| `vite.config.ts` | React plugin only, port 5173, no PWA |
| `index.html` | Bare — no manifest link, no theme-color meta, no apple-touch-icon |
| `public/` directory | Empty (does not exist) |
| Service worker | None |
| Icons | `ui/ContextCore.png` (1024×1024) + `ui/favicon.ico` exist — need resizing & copying to `public/pwa/` |
| `API_BASE` | Hardcoded `http://localhost:3210` in `search.ts` |
| Server port | Hardcoded `3210` in `ContextCore.ts`, no `.env` setting, no EADDRINUSE handling |
| Production serving | `express.static("visualizer/dist")` on `:3210` (same origin) |
| CSS theme colors | `--bg-primary: #0a0a0f`, `--accent: #3b82f6` |

---

## Level 1 — Static Assets & HTML Scaffolding

{{SIMPLE}}

- [x] Create `visualizer/public/pwa/` directory (all PWA assets live under `/pwa/` to keep `public/` organized)
- [x] Resize `visualizer/ui/ContextCore.png` (1024×1024) → `visualizer/public/pwa/icon-192x192.png` (192×192, high-quality downscale, preserve RGBA transparency)
- [x] Resize `visualizer/ui/ContextCore.png` → `visualizer/public/pwa/icon-512x512.png` (512×512)
- [x] Create maskable variant `visualizer/public/pwa/icon-maskable-512x512.png` (512×512): take the 512 icon and add padding so the visible content sits within the 80% safe zone (the maskable spec crops a circle/squircle from the outer edges). Use `#0a0a0f` background fill for the padded area
- [x] Copy `visualizer/ui/favicon.ico` → `visualizer/public/pwa/favicon.ico`
- [x] Add a `<link rel="icon" href="/pwa/favicon.ico">` to `visualizer/index.html` `<head>` (gives the tab/title bar the icon immediately, even before PWA install)
- [x] Add PWA meta tags to `visualizer/index.html`:
  - `<meta name="theme-color" content="#0a0a0f">`
  - `<meta name="description" content="ContextCore Visualizer — AI conversation history explorer">`
  - `<link rel="apple-touch-icon" href="/pwa/icon-192x192.png">`
  - `<meta name="apple-mobile-web-app-capable" content="yes">`
  - `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`

---

## Level 2 — Plugin Installation & Manifest Configuration

{{SIMPLE}}

- [x] Install `vite-plugin-pwa` as devDependency: `npm i -D vite-plugin-pwa`
- [x] Import `VitePWA` in `visualizer/vite.config.ts` and add to plugins array
- [x] Configure manifest object inside `VitePWA({})` options:
  ```ts
  manifest: {
    name: "ContextCore Visualizer",
    short_name: "CXC Viz",
    description: "AI conversation history explorer — search, browse, and build agents from multi-IDE chat archives",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0f",
    theme_color: "#0a0a0f",
    icons: [
      { src: "/pwa/icon-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/pwa/icon-512x512.png", sizes: "512x512", type: "image/png" },
      { src: "/pwa/icon-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
  ```
- [x] Set `registerType: "prompt"` so users see a controlled update prompt rather than silent auto-updates (we'll wire the UI in Level 4)
- [x] Set `devOptions: { enabled: true }` to allow testing SW behavior during `npm run dev`
- [x] Run `npm run build` and verify that `visualizer/dist/` contains `manifest.webmanifest` and a `sw.js` (or `registerSW.js`)
- [ ] Open built output in browser, verify manifest is detected (DevTools → Application → Manifest shows correct name, icons, display mode)

---

## Level 3 — Service Worker Caching Strategies

{{MEDIUM}}

- [x] Configure `workbox` section in `VitePWA` options for **precaching** — the plugin auto-precaches all Vite build outputs (JS, CSS, HTML) by default; verify this is happening by inspecting the generated SW file
- [x] Add `runtimeCaching` entry for API search routes (`/api/search*`) — strategy: `NetworkFirst` with 5-second network timeout, falling back to cache. Cache name: `api-search-cache`, max entries: 50, max age: 1 hour
  ```ts
  runtimeCaching: [
    {
      urlPattern: /\/api\/search/,
      handler: "NetworkFirst",
      options: {
        cacheName: "api-search-cache",
        networkTimeoutSeconds: 5,
        expiration: { maxEntries: 50, maxAgeSeconds: 3600 },
      },
    },
  ]
  ```
- [x] Add runtime caching entry for session/thread API routes (`/api/sessions*`, `/api/threads*`, `/api/messages*`) — strategy: `NetworkFirst`, 5s timeout, cache name `api-data-cache`, max 100 entries, max age 2 hours
- [x] Add runtime caching entry for project list (`/api/projects`) — strategy: `StaleWhileRevalidate`, cache name `api-meta-cache`, max age 24 hours (project list changes rarely)
- [x] Add runtime caching entry for agent builder routes (`/api/agent-builder/*`) — strategy: `NetworkFirst`, 5s timeout, cache name `api-agent-cache`, max 30 entries, max age 1 hour
- [x] Create `visualizer/public/pwa/offline.html` — a minimal standalone HTML page (inline CSS, no external deps) that shows "You're offline — ContextCore server is unreachable. Cached content may still be available." with the app's dark theme styling
- [x] Add `navigateFallback: "/index.html"` to workbox config so SPA routing works when offline (the app shell loads, then the React layer handles missing API data gracefully)
- [ ] Build and test: disconnect network in DevTools, reload app — verify shell loads from SW cache and API calls either serve cached responses or fail gracefully

---

## Level 3b — Server Port Configuration & Runtime Discovery

This level addresses the server port being hardcoded at `3210` with no fallback. The port must be configurable and discoverable at runtime so the PWA, the Vite dev proxy, and the server all agree on which port to use — without requiring a recompile of the visualizer.

**Design**: The server reads `PORT` from `.env` (default `3210`), attempts to bind, and on `EADDRINUSE` tries incrementing ports up to `PORT+10`. On successful bind, it writes the actual port to a runtime file (`server/.cxc-port`). The Vite dev proxy reads this file for its target. In production (PWA), the visualizer is served from the same Express origin, so relative `/api/*` paths work at any port without configuration.

{{MEDIUM}}

- [x] Add `PORT` setting to `server/.env.example` and `server/.env`:
  ```env
  # Server port (default: 3210). If busy, the server will try PORT+1 through PORT+10.
  PORT=3210
  ```
- [x] Add `readonly PORT: number` to `CCSettings` class, parsed from `process.env.PORT` with default `3210` and range validation (1024–65535). Use a new `parseEnvInt` helper (parallel to existing `parseEnvFloat`)
- [x] Refactor `startServer()` in `ContextServer.ts`: change the `app.listen(port, callback)` call to return a `Promise<{ server: Server; app: Express; actualPort: number }>`. Add an `'error'` handler on the server object that catches `EADDRINUSE`:
  ```ts
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[Server] Port ${currentPort} in use, trying ${currentPort + 1}...`);
      // retry with next port
    } else {
      reject(err);
    }
  });
  ```
  Try ports from `PORT` through `PORT+10`. If all 11 are busy, log a clear error and exit
- [x] Update `ContextCore.ts` `main()` to `await` the new async `startServer()`, passing `settings.PORT` instead of hardcoded `3210`. Capture `actualPort` from the result
- [x] After successful bind, write `actualPort` to `server/.cxc-port` (plain text file, just the port number). This file is read by the Vite dev proxy (Level 5) to discover where the backend is running
- [x] Add `.cxc-port` to `server/.gitignore` (it's a runtime artifact, not configuration)
- [x] On graceful shutdown (`gracefulShutdown()` in `ContextCore.ts`), delete the `.cxc-port` file so a stale port number doesn't mislead the next startup
- [x] Log the final bound port clearly: `[Server] ContextCore API listening on http://localhost:{actualPort}` — and if it differs from the configured PORT, additionally log: `[Server] Preferred port {PORT} was in use; bound to {actualPort} instead`

---

## Level 4 — Offline-Aware UI & Update Prompt

{{MEDIUM}}

- [x] Create `visualizer/src/hooks/useOnlineStatus.ts` — a hook that tracks `navigator.onLine` via `online`/`offline` window events, returns `{ isOnline: boolean }`
- [x] Display offline indicator in `StatusBar.tsx` — when `isOnline` is false, show a small "OFFLINE" badge (amber background, dark text) next to existing status items
- [x] In `useSearch` hook, catch fetch failures and check `navigator.onLine` — if offline, set a distinct error message: "Offline — showing cached results if available" instead of the generic fetch error
- [x] Create `visualizer/src/components/UpdatePrompt.tsx` — a small toast/banner component at the top of the app that appears when the service worker detects a new version. Shows "A new version is available" with a "Reload" button. Uses `registerSW` from `virtual:pwa-register` to call `updateSW(true)` on click
- [x] Wire `UpdatePrompt` into `App.tsx` — render it at the top level, above the SearchBar. The prompt is self-contained: it subscribes to the SW update event internally
- [ ] Ensure `localStorage`-backed features (favorites, views, search history, clipboard basket) continue to work fully when offline — these should already work since they don't depend on fetch. Verify by testing each in offline mode
- [x] Add `display_override: ["window-controls-overlay", "standalone"]` to manifest for future WCO support (allows custom title bar on desktop). This is purely additive and browsers that don't support WCO fall back to `standalone`

---

## Level 5 — Production Hardening & API Base Resolution

{{HARD}}

- [x] Refactor `API_BASE` in `visualizer/src/api/search.ts`: replace the hardcoded `http://localhost:3210` with `""` (empty string = relative URL). In production, the visualizer is served from the same Express origin, so relative `/api/*` paths resolve correctly regardless of which port the server bound to. No recompile needed when the port changes
- [x] Update `visualizer/vite.config.ts` to add a dev proxy that reads the actual server port from `server/.cxc-port` (written by Level 3b). Fallback to `3210` if the file doesn't exist:
  ```ts
  import { readFileSync, existsSync } from "fs";
  import { resolve } from "path";

  function getApiPort(): number {
    const portFile = resolve(__dirname, "../server/.cxc-port");
    if (existsSync(portFile)) {
      const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
      if (port > 0) return port;
    }
    return 3210;
  }

  // inside defineConfig:
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${getApiPort()}`, changeOrigin: true },
    },
  }
  ```
  Note: Vite reads the config at startup. If the server restarts on a different port mid-session, the Vite dev server needs a restart too. This is acceptable for dev
- [ ] After the `API_BASE` change, verify all API calls work in both dev (`:5173` with proxy) and production (same-origin) modes. Test with the server on the default port and on a fallback port
- [x] Review CSP (Content Security Policy) implications — if the Express server sets CSP headers, ensure they allow `manifest-src 'self'`, `worker-src 'self'`, and `connect-src 'self'` (for SW fetch interception). If no CSP is set currently, add a note in this doc for future hardening. **Result**: No CSP headers are set. When CSP is added in the future, ensure `manifest-src 'self'`, `worker-src 'self'`, and `connect-src 'self'` are included
- [ ] Test the full install flow on Chrome (desktop): navigate to `:3210`, verify install icon appears in address bar, click install, verify standalone window opens with correct theme color and no browser chrome
- [ ] Test the full install flow on Edge (desktop): same verification as Chrome
- [ ] Test on a mobile device or mobile emulator (Chrome Android): verify home-screen icon, splash screen (name + icon + background_color), and standalone display mode

{{HARD}}

- [ ] Run Lighthouse PWA audit (DevTools → Lighthouse → check "Progressive Web App"): target all core PWA checks passing (installable, service worker, HTTPS-redirect note, manifest, themed). Fix any failing checks → see [Manual Testing Guide — Lighthouse](#lighthouse-pwa-audit)
- [ ] Test SW update lifecycle end-to-end: build v1, install app, build v2 with a visible change, reopen app → verify `UpdatePrompt` appears, click "Reload" → verify new version loads → see [Manual Testing Guide — SW Update Lifecycle](#sw-update-lifecycle)
- [x] Verify that `express.static("visualizer/dist")` serves the SW file with correct headers — specifically, `Cache-Control: no-cache` on `sw.js` itself (browsers re-check SW on navigation, but stale caching of the SW file itself delays updates). If Express's default static middleware caches aggressively, add a `setHeaders` option to exclude `sw.js`. **Done**: Added `setHeaders` callback that sets `Cache-Control: no-cache` on `sw.js` and `workbox-*.js`
- [x] Add a brief "PWA / Standalone Window" section to `README.MD` explaining how to install the app as a standalone window (navigate to `:3210` in Chrome or Edge, click the install icon in the address bar). Note: `localhost` is always a secure origin — no certificates needed. HTTPS is only required if the app is ever served over a network hostname.
- [ ] Add `screenshots` array to manifest (optional but improves install prompt UX on mobile):
  ```json
  "screenshots": [
    { "src": "/pwa/screenshots/search-wide.png", "sizes": "1280x720", "type": "image/png", "form_factor": "wide" },
    { "src": "/pwa/screenshots/search-narrow.png", "sizes": "390x844", "type": "image/png", "form_factor": "narrow" }
  ]
  ```
  Capture screenshots of the search view at desktop and mobile widths

---

## File Change Summary

| File | Change |
|---|---|
| **Server — Port Configuration (Level 3b)** | |
| `server/.env.example` | Add `PORT=3210` setting |
| `server/.env` | Add `PORT=3210` setting |
| `server/src/settings/CCSettings.ts` | Add `PORT` property, `parseEnvInt` helper |
| `server/src/server/ContextServer.ts` | Make `startServer` async with EADDRINUSE retry loop, return `actualPort` |
| `server/src/ContextCore.ts` | Use `settings.PORT`, capture `actualPort`, write/cleanup `.cxc-port` file |
| `server/.gitignore` | Add `.cxc-port` |
| **Visualizer — PWA (Levels 1–5)** | |
| `visualizer/package.json` | Add `vite-plugin-pwa` devDependency |
| `visualizer/vite.config.ts` | Add `VitePWA` plugin with manifest, workbox, runtime caching, port-aware proxy, devOptions |
| `visualizer/index.html` | Add meta tags (theme-color, description, favicon, apple-touch-icon, apple-mobile-web-app-capable) |
| `visualizer/public/pwa/icon-192x192.png` | New — resized from `ui/ContextCore.png` (1024→192) |
| `visualizer/public/pwa/icon-512x512.png` | New — resized from `ui/ContextCore.png` (1024→512) |
| `visualizer/public/pwa/icon-maskable-512x512.png` | New — maskable variant with safe-zone padding |
| `visualizer/public/pwa/favicon.ico` | Copied from `ui/favicon.ico` |
| `visualizer/public/pwa/offline.html` | New — offline fallback page |
| `visualizer/public/pwa/screenshots/` | New — install prompt screenshots (Level 5) |
| `visualizer/src/api/search.ts` | Replace hardcoded `API_BASE` with `""` (relative URL) |
| `visualizer/src/hooks/useOnlineStatus.ts` | New — `navigator.onLine` tracking hook |
| `visualizer/src/components/UpdatePrompt.tsx` | New — SW update toast/banner |
| `visualizer/src/components/StatusBar.tsx` | Add offline badge |
| `visualizer/src/hooks/useSearch.ts` | Offline-aware error messaging |
| `visualizer/src/App.tsx` | Mount `UpdatePrompt`, pass `isOnline` to StatusBar |
| `README.MD` | Add PWA + port configuration section (Level 5) |

---

## Caching Strategy Rationale

```
┌──────────────────────────┬────────────────────────┬───────────────────────────────────┐
│ Resource Type            │ Workbox Strategy       │ Why                               │
├──────────────────────────┼────────────────────────┼───────────────────────────────────┤
│ App shell (HTML/JS/CSS)  │ Precache (build-time)  │ Hashed filenames, immutable once  │
│                          │                        │ built. SW serves instantly.        │
├──────────────────────────┼────────────────────────┼───────────────────────────────────┤
│ /api/search*             │ NetworkFirst (5s)      │ Search results should be fresh    │
│                          │                        │ when online; cached fallback for  │
│                          │                        │ brief disconnects.                │
├──────────────────────────┼────────────────────────┼───────────────────────────────────┤
│ /api/sessions*           │ NetworkFirst (5s)      │ Session data changes on ingest    │
│ /api/threads*            │                        │ but reading stale data is fine    │
│ /api/messages*           │                        │ for a few minutes.                │
├──────────────────────────┼────────────────────────┼───────────────────────────────────┤
│ /api/projects            │ StaleWhileRevalidate   │ Project list is quasi-static;     │
│                          │                        │ instant response + background     │
│                          │                        │ revalidation is ideal.            │
├──────────────────────────┼────────────────────────┼───────────────────────────────────┤
│ /api/agent-builder/*     │ NetworkFirst (5s)      │ Agent building is interactive;    │
│                          │                        │ fresh data preferred, but cached  │
│                          │                        │ list/templates OK as fallback.    │
└──────────────────────────┴────────────────────────┴───────────────────────────────────┘
```

---

## Risks & Notes

1. **HTTPS — not needed for local use**: `localhost` is permanently treated as a secure origin by all browsers (Chrome, Edge, Firefox). PWA install, service workers, and `display: standalone` all work at `localhost:3210` with zero certificates. HTTPS is only needed if CXC is ever served from a non-localhost hostname (e.g. a LAN IP or domain), in which case an HTTPS reverse proxy (nginx, Caddy) or `mkcert` local CA would be required.

2. **SW scope**: The service worker must be served from `/` to intercept all routes. Since `express.static("visualizer/dist")` serves from the root, the SW at `/sw.js` naturally has `/` scope. No `Service-Worker-Allowed` header needed.

3. **Cache invalidation on deploy**: `vite-plugin-pwa` hashes all precached assets. On rebuild, the SW detects changed hashes and triggers the update flow. The `registerType: "prompt"` setting means users see the `UpdatePrompt` banner and consciously reload — no silent mid-session updates that could break in-flight state.

4. **`API_BASE` migration**: The hardcoded `http://localhost:3210` currently works because both dev and production run locally. Switching to relative URLs is strictly better: same-origin fetch works in production, and the Vite proxy handles dev. This change is prerequisite for SW fetch interception to work correctly (SW only intercepts same-origin requests by default). It also decouples the visualizer from any specific port number.

5. **Port auto-increment and installed PWAs**: If a user installs the PWA at `localhost:3210` and the server later restarts on `3211` (because 3210 was busy), the installed PWA shortcut will open `localhost:3210` — which is now dead. The user would need to navigate to `localhost:3211` manually and re-install. This is an acceptable edge case for a local dev tool. Mitigation: the server logs the actual port clearly on startup, and the `.cxc-port` file provides a machine-readable reference.

6. **Vite dev proxy and port discovery**: The Vite proxy reads `server/.cxc-port` at config load time (startup). If the server restarts on a different port while Vite is running, the proxy target becomes stale. The developer needs to restart `npm run dev`. This is standard for Vite proxy configs and acceptable for dev workflows.

7. **No push notifications**: This plan intentionally omits push notifications. The visualizer is a data exploration tool, not a messaging app. If live-update notifications are ever wanted (e.g., "new conversations ingested"), they would use the existing `FileWatcher` → WebSocket pathway rather than web push.

---

## Manual Testing Guide

### Verify API Calls (dev + production)

**Dev mode** — Vite proxy at `:5173`:
1. `cd server && bun run dev`
2. In a second terminal: `cd visualizer && npm run dev`
3. Open `http://localhost:5173` and run a search. Results confirm the Vite proxy is forwarding `/api/*`.

**Production mode** — same-origin at `:3210`:
1. `cd visualizer && npm run build` — compiles the React app into `visualizer/dist/`
2. `cd server && bun run dev` — the Express server starts and serves both the API **and** the built frontend from `dist/` via `express.static`. No separate Vite process needed.
3. Open `http://localhost:3210` in a browser — you get the full React UI served by Express
4. Type a search query in the UI. Results confirm the relative `/api/search` URL is being resolved same-origin (no proxy involved).

---

### Install Flow (Chrome)

1. Open `http://localhost:3210` in Chrome.
2. Look for a small **monitor-with-arrow icon** on the right side of the address bar (the install prompt). If it's not there, wait a few seconds or try the browser menu (three-dot → "Install ContextCore Visualizer…").
3. Click it, then click **Install** in the dialog.
4. A new standalone window opens — no address bar, no tabs, dark `#0a0a0f` title bar.
5. Check the Windows taskbar — the ContextCore icon should appear there.

To uninstall: in the standalone window, click the three-dot menu (top-right) → "Uninstall ContextCore Visualizer".

### Install Flow (Edge)

Same steps as Chrome. Edge shows a similar install icon in the address bar.

---

### Lighthouse PWA Audit

Lighthouse is built into Chrome DevTools — no install needed.

1. Open `http://localhost:3210` in Chrome (must be the production build, not dev mode).
2. Press `F12` → click the **Lighthouse** tab (if hidden, click `>>` in the DevTools tab bar).
3. Under categories, check only **Progressive Web App** (uncheck the others to save time).
4. Leave Mode as **Navigation** and Device as **Desktop**.
5. Click **Analyze page load** and wait ~15 seconds.
6. The report will show pass/fail for:
   - Installable (manifest + service worker registered)
   - Service worker intercepts network requests
   - Theme color set in manifest
   - Viewport meta tag configured
   - HTTPS note (localhost is always OK)

Fix any failing items — the report links directly to the failing criterion with an explanation.

---

### SW Update Lifecycle

The goal: confirm that rebuilding the app causes the "A new version is available" banner to appear for users who already have it open.

**Background**: when you `npm run build`, `vite-plugin-pwa` hashes all assets into `sw.js`. The next time a user navigates to the app, their browser re-fetches `sw.js`, detects the different hashes, installs the new service worker in the background, and fires the `needRefresh` event — which our `UpdatePrompt` component listens for.

**Steps**:

1. Build v1: `cd visualizer && npm run build`
2. Start the server: `cd server && bun run dev`
3. Open `http://localhost:3210` in Chrome. Let it fully load. The SW installs silently.
4. Confirm the SW is active: DevTools (`F12`) → **Application** tab → **Service Workers** in the left panel. You should see `sw.js` listed as "activated and is running".
5. Make a visible change — for example, edit `visualizer/index.html` and change the `<title>` to `ContextCore Visualizer v2`.
6. Rebuild: `npm run build` (keep the browser tab open, don't reload yet).
7. Go back to the browser tab. Either **navigate to the page** (type the URL again and press Enter) or wait — the SW checks for updates on navigation.
8. The blue **"A new version is available — Reload"** banner should appear at the top of the app.
9. Click **Reload** — the page refreshes with the new build. Revert the title change afterward if desired.
