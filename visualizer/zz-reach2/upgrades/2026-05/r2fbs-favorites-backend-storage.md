# R2FBS - Favorites Backend Storage Plan

**Date**: 2026-05-13  
**Goal**: Move ContextCore favorites persistence from visualizer-only localStorage to backend JSON storage, while keeping `ccv:favorites` active as the offline fallback.

## Working Contract

- Backend storage target: `{storage}/.settings/favorites.json`, beside the existing `{storage}/.settings/scopes.json`.
- Server copy is the online canonical copy, but startup differences between server and localStorage must be resolved by the user in a modal before overwriting either side.
- Offline startup must continue to render favorites from `ccv:favorites` without blocking the visualizer.
- Local mutations stay optimistic: update React state and localStorage immediately, then attempt to sync to the backend when reachable.
- The persisted favorites payload remains the current `FavoriteEntry[]` shape: `{ cardId, viewId, source, addedAt }`.
- Before starting any group below, switch to the Model named in the group tag. Do not continue into a later group until the active Model matches the new tag.

{{MEDIUM}}

## Difficulty Batch 1

- [x] Review `server/src/settings/ScopeStore.ts`, `server/src/server/routes/scopeRoutes.ts`, `server/src/server/RouteContext.ts`, and `server/src/ContextCore.ts` to mirror the existing settings-store pattern.
- [x] Review `visualizer/src/hooks/useFavorites.ts`, `visualizer/src/App.tsx`, `visualizer/src/api/search.ts`, and `visualizer/src/components/favorites/FavoritesPickerDialog.*` before editing favorites behavior.
- [x] Confirm the implementation keeps `ccv:favorites` as the local offline cache and does not rename or remove that localStorage key.
- [x] Define the server favorites payload as the same `FavoriteEntry[]` currently used by the visualizer, including `FavoriteSource` variants for `"message"` and `"thread"`.
- [x] Define a shared conflict identity rule for favorites as `(viewId, cardId)`.
- [x] Define a deterministic signature helper for comparing favorites lists by sorting entries by `viewId`, `cardId`, `addedAt`, and `source.type`.
- [x] Define the sync diff categories used by the modal: server additions, server removals, local additions, local removals, and source updates.
- [x] Keep new TypeScript comments in the project style, using `//Comment text` with no space after `//`.

{{HARD}}

## Difficulty Batch 2

- [x] Add a server-side `FavoriteEntry` / `FavoriteSource` model file that mirrors the visualizer shape without importing visualizer code.
- [x] Add a `FavoriteStore` under `server/src/settings/` with `load()`, `save()`, `list()`, and `replaceAll()` methods matching the shape and comments of `ScopeStore`.
- [x] Make `FavoriteStore` create `{storage}/.settings` if missing and read/write `{storage}/.settings/favorites.json` using pretty JSON.
- [x] Make `FavoriteStore.load()` fall back to an empty Array when the file is missing, malformed, or not an Array.
- [x] Add a favorite normalizer that validates `cardId`, `viewId`, numeric `addedAt`, and the `source.type` discriminator before accepting entries from HTTP payloads.
- [x] Preserve existing visualizer legacy migration in `useFavorites`; do not move legacy localStorage migration to the server for this upgrade.
- [x] Add focused Bun tests for `FavoriteStore` load/save/malformed-file behavior.

{{MEDIUM}}

## Difficulty Batch 3

- [x] Add `favoriteRoutes.ts` with `GET /api/favorites` returning the full `FavoriteEntry[]`.
- [x] Add `POST /api/favorites` accepting `{ favorites: FavoriteEntry[] }`, validating every entry, replacing the full store, saving it, and returning `{ saved: number }`.
- [x] Add `favoriteStore?: FavoriteStore` to `RouteContext`.
- [x] Register `favoriteRoutes` in `ContextServer` near `scopeRoutes`.
- [x] Instantiate and `load()` `FavoriteStore` in `ContextCore.ts` beside `ScopeStore`.
- [x] Pass `favoriteStore` into `startServer()` and log the loaded favorite count on startup.
- [x] Ensure the route returns a useful 404 or empty response if the store is unavailable, matching the local style used by scope routes.
- [x] Add route tests for empty list, valid replacement, invalid payload rejection, and persistence after reload.

{{SIMPLE}}

## Difficulty Batch 4

- [x] Add visualizer API client functions `fetchFavorites()` and `saveFavorites(favorites)` using the same `API_BASE` convention as scope helpers.
- [x] Type the API helpers with `FavoriteEntry[]` and `{ saved: number }`.
- [x] Make `fetchFavorites()` defensively return `[]` when the server returns a non-Array payload.
- [x] Make `saveFavorites()` throw a status-aware error on non-OK responses.
- [x] Keep the API helpers in the existing client file unless the file becomes too noisy, in which case create a small favorites API module and update imports.

{{MEDIUM}}

## Difficulty Batch 5

- [x] Add a small visualizer helper module for sync comparison, for example `visualizer/src/hooks/favoriteSync.ts`, so `useFavorites.ts` does not become the home for every diff utility.
- [x] Add `favoriteKey(entry)` returning `${entry.viewId}::${entry.cardId}` and use it as the single identity rule for local/server comparison.
- [x] Add `serializeFavoriteSource(source)` using `JSON.stringify(source)` so changed snapshots can be detected without inventing source-specific comparisons.
- [x] Add `buildFavoritesSignature(favorites)` that sorts entries before stringifying, so identical lists compare equal even when Array order differs.
- [x] Add `getFavoriteConflictSummary(localFavorites, serverFavorites)` returning counts for local total, server total, server-only entries, local-only entries, removed-by-server entries, and changed entries.
- [x] Treat removed-by-server entries as local entries whose `(viewId, cardId)` key is missing from the server list.
- [x] Treat changed entries as shared keys where `addedAt` or serialized `source` differs.
- [x] Export only typed helpers from the sync module; keep all fetch, React state, and localStorage writing inside `useFavorites`.

{{MEDIUM}}

## Difficulty Batch 6

- [x] Use this helper shape or an equivalent typed shape for conflict data:

```typescript
type FavoriteSyncConflict = {
	localFavorites: FavoriteEntry[];
	serverFavorites: FavoriteEntry[];
	summary: FavoriteConflictSummary;
};
```

- [x] Use this decision shape or an equivalent function to simplify startup logic:

```typescript
type FavoriteStartupDecision =
	| { kind: "same" }
	| { kind: "accept-server" }
	| { kind: "ask-user"; conflict: FavoriteSyncConflict };
```

- [x] Add `decideFavoriteStartupSync(localFavorites, serverFavorites)` to return `"same"` when signatures match.
- [x] Make `decideFavoriteStartupSync()` return `"accept-server"` when localStorage is empty and the server has favorites.
- [x] Make `decideFavoriteStartupSync()` return `"same"` when both sides are empty.
- [x] Make `decideFavoriteStartupSync()` return `"ask-user"` when the server is empty and localStorage has favorites.
- [x] Make `decideFavoriteStartupSync()` return `"ask-user"` for every non-empty difference, including additions, deletions, and changed snapshots.
- [x] Add helper tests for all startup decisions before wiring them into React.

{{HARD}}

## Difficulty Batch 7

- [x] Refactor `useFavorites` so initial render still uses `useState(() => safeReadFavorites())` and therefore paints offline favorites without waiting for the backend.
- [x] Add returned sync state to `UseFavoritesResult`: `isSyncing`, `syncError`, `isServerAvailable`, `pendingConflict`, and `hasUnsyncedLocalChanges`.
- [x] Add returned sync actions to `UseFavoritesResult`: `acceptServerFavorites()`, `keepLocalFavorites()`, `dismissSyncConflict()`, and `retryFavoriteSync()`.
- [x] Add a `persistLocalFavorites(nextFavorites)` helper that writes `ccv:favorites` and sets `storageError` on localStorage failure.
- [x] Keep the current legacy migration inside `safeReadFavorites()` and reuse its normalized output as the local list for sync comparison.
- [x] Keep `getFavoritesForView`, `isFavorited`, and `getFavoriteViewIds` pure reads over the current React `favorites` state.
- [x] Keep all public mutation functions synchronous from the caller's perspective, even if they schedule backend sync after local state changes.
- [x] Avoid changing the `FavoriteEntry` and `FavoriteSource` visualizer types unless backend validation proves a missing field must be represented.

{{HARD}}

## Difficulty Batch 8

- [x] Add a mount-only sync effect in `useFavorites` that exits immediately when `typeof window === "undefined"`.
- [x] Make the mount sync effect exit without error when `navigator.onLine === false`.
- [x] When online, set `isSyncing` true, call `fetchFavorites()`, and set `isServerAvailable` true only after a successful response.
- [x] On `fetchFavorites()` failure, keep the local list, set `isServerAvailable` false, set a non-blocking `syncError`, and clear `isSyncing`.
- [x] On successful fetch, call `decideFavoriteStartupSync(localFavorites, serverFavorites)`.
- [x] For `"same"`, clear any conflict state and leave the current local favorites state unchanged.
- [x] For `"accept-server"`, set favorites to the server list and immediately write the server list into `ccv:favorites`.
- [x] For `"ask-user"`, set `pendingConflict` and do not write localStorage or backend storage yet.

{{MEDIUM}}

## Difficulty Batch 9

- [x] Add `FavoritesSyncConflictDialog.tsx` next to the other favorites components rather than inside `App.tsx`.
- [x] Give the dialog props for `open`, `conflict`, `isSaving`, `error`, `onAcceptServer`, `onKeepLocal`, and `onClose`.
- [x] Render `null` when `open` is false or no conflict is available.
- [x] Use `role="dialog"` and `aria-modal="true"` on the modal panel, matching the existing favorites picker accessibility pattern.
- [x] Stop click propagation on the panel and let overlay clicks call `onClose` only if unresolved conflict dismissal is allowed by `useFavorites`.
- [x] Show local and server total counts from `conflict.summary`.
- [x] Show server removals, server additions, local-only entries, and changed entries as short count rows rather than a long item table.
- [x] Include warning text when `removedByServerCount > 0` that accepting the server copy will remove local favorites.

{{MEDIUM}}

## Difficulty Batch 10

- [x] Add `FavoritesSyncConflictDialog.css` with class names prefixed consistently, for example `.fav-sync-*`.
- [x] Reuse the existing modal vibe: fixed overlay, `rgba(0, 0, 0, 0.45)`, dark card, rounded border, compact spacing, and z-index near `FavoritesPickerDialog`.
- [x] Add primary button styling for accepting the server version.
- [x] Add secondary button styling for keeping local favorites and uploading them.
- [x] Disable action buttons while `isSaving` is true.
- [x] Add an inline error area inside the modal for failed keep-local uploads.
- [x] Add small explanatory copy that says localStorage remains the offline fallback.
- [x] Keep this modal independent from `FavoritesPickerDialog`; do not add sync conflict props to the star-target picker.

{{HARD}}

## Difficulty Batch 11

- [x] Wire `FavoritesSyncConflictDialog` into `App.tsx` near the existing `FavoritesPickerDialog` render block.
- [x] Pass `pendingConflict`, `isSyncing`, `syncError`, `acceptServerFavorites`, `keepLocalFavorites`, and `dismissSyncConflict` from `useFavorites` into the dialog.
- [x] Implement `acceptServerFavorites()` in `useFavorites`: set React state to `pendingConflict.serverFavorites`, write `ccv:favorites`, clear unsynced flags, and close the conflict.
- [x] Implement `keepLocalFavorites()` in `useFavorites`: call `saveFavorites(pendingConflict.localFavorites)`, then clear conflict state only after the backend write succeeds.
- [x] If `keepLocalFavorites()` fails, keep `pendingConflict` open and expose the error in both `syncError` and the dialog error prop.
- [x] Make `dismissSyncConflict()` close the modal without changing favorites only if the UI intentionally allows later retry; otherwise omit the close button.
- [x] Ensure the existing `storageError` banner includes `syncError` only when no sync conflict modal is open.
- [x] Ensure accepting the server copy changes `favoritesSignature` so an active favorites view refreshes through the existing search trigger.

{{HARD}}

## Difficulty Batch 12

- [x] Add a private `saveVersionRef` or promise queue in `useFavorites` so backend saves cannot complete out of order and overwrite newer favorite state.
- [x] Add `scheduleBackendSave(nextFavorites)` that skips saving when offline, when no server is available, or when `pendingConflict` is set.
- [x] On successful backend save, clear `hasUnsyncedLocalChanges` only if the saved list still matches the latest favorites signature.
- [x] On failed backend save, keep the optimistic local UI, set `hasUnsyncedLocalChanges` true, and set a non-blocking `syncError`.
- [x] Update `addFavorite` to call `persistLocalFavorites(next)` and then `scheduleBackendSave(next)` after the duplicate check.
- [x] Update `updateFavorite` to call `persistLocalFavorites(next)` and then `scheduleBackendSave(next)` after mapping the entry.
- [x] Update `removeFavorite` to call `persistLocalFavorites(next)` and then `scheduleBackendSave(next)` after filtering the entry.
- [x] Update `removeFavoritesForView` to call `persistLocalFavorites(next)` and then `scheduleBackendSave(next)` after filtering the view.

{{HARD}}

## Difficulty Batch 13

- [x] Add an online-event effect in `useFavorites` that retries only when `hasUnsyncedLocalChanges` is true and no `pendingConflict` is open.
- [x] On retry, fetch the current server favorites before uploading local favorites.
- [x] If the fetched server signature still matches the last known server signature or server is empty, upload the local favorites.
- [x] If the fetched server signature differs from the last known server signature, open `pendingConflict` instead of uploading local favorites.
- [x] Update `lastKnownServerSignatureRef` after every successful fetch or save.
- [x] Keep direct single-view starring behavior unchanged from the user's perspective.
- [x] Keep `FavoritesPickerDialog` batch add/remove behavior unchanged from the user's perspective.
- [x] Ensure custom favorites created or edited through `AddFavoriteMessage` use the same sync path as normal stars.

{{MEDIUM}}

## Difficulty Batch 14

- [x] Add unit-level tests for favorite signature helpers, including same entries with different Array order.
- [x] Add unit-level tests for conflict summary counts, including deletion-only conflicts.
- [x] Add unit-level tests for `decideFavoriteStartupSync()` covering empty/local/server combinations.
- [x] Add backend tests to the existing Bun test suite without requiring the visualizer build.
- [x] Add hook-level or component-level coverage if a visualizer test harness exists; otherwise document manual verification steps in the PR notes.
- [x] Run `bun test` in `server/`.
- [x] Run `bun run typecheck` in `server/`.
- [x] Run `npm run build` in `visualizer/`.

{{SIMPLE}}

## Difficulty Batch 15

- [x] Use `ReadLints` on the edited server and visualizer files and fix introduced diagnostics.
- [x] Update `visualizer/zz-reach2/architecture/ui/archi-favorites-ui.md` to describe backend persistence, localStorage fallback, and conflict modal behavior.
- [x] Update `visualizer/zz-reach2/architecture/ui/archi-context-core-visualizer-ui.md` storage and hook sections for `useFavorites` sync state.
- [x] Update `server/zz-reach2/architecture/archi-context-core-level0.md` API/storage sections to include `{storage}/.settings/favorites.json`.
- [x] Update search/UI docs only where they still say favorites are local-only.
- [x] Add the new API endpoints to `server/interop/insomnia-context-core.json` if that file is maintained for REST coverage.
- [x] Manually test offline startup by blocking/stopping the backend and confirming favorites still render from `ccv:favorites`.
- [x] Manually test online startup where the server has removals and confirm the modal asks before overwriting localStorage.

{{SIMPLE}}

## Difficulty Batch 16

- [x] Manually test accepting the server version and confirm `ccv:favorites` changes to match `{storage}/.settings/favorites.json`.
- [x] Manually test keeping local favorites in the conflict modal and confirm `{storage}/.settings/favorites.json` receives the local list.
- [x] Manually test a failed keep-local upload and confirm the modal remains open with a recoverable error.
- [x] Manually test adding, removing, and editing custom favorites while online and confirm each change reaches the backend JSON file.
- [x] Manually test rapid favorites picker changes and confirm the final backend JSON matches the final UI state.
- [x] Manually test going offline, changing favorites, going online, and confirming unsynced local changes retry.

{{SIMPLE}}

## Follow-up: Favorite view labels and per-view conflict UI (2026-05)

- [x] Persist `favoriteViews` (id, name, emoji, color) next to `favorites` in `favorites.json` and in `GET`/`POST` `/api/favorites` payloads so cross-machine imports show human-readable tab names.
- [x] Visualizer always POSTs merged `favoriteViews` built from live favorites-type tabs plus any orphan `viewId`s referenced only in entries.
- [x] Extend `favoriteSync` bundle signatures and conflict payloads with per-view delta rows for the modal.
- [x] Conflict modal: scrollable per-view section, dialog `max-height` within viewport (pattern aligned with `EditResultsView`).
- [x] On “Accept server”, merge server `favoriteViews` into `ccv:views` (upsert UUID favorites tabs) so imported rows resolve to real tabs.
