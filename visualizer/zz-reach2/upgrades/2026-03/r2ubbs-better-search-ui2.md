# R2UBBS: Advanced Search UI and Project Filtering

**Date**: 2026-03-16
**Status**: ✅ Complete
**Depends on**: `r2ubs-better-search-ui.md`

## 1. Overview
This upgrade continues search view enhancements by introducing **project-level filtering** for custom searches and reorganizing the view dropdown categories. When users create custom search views, they can now select exactly which projects/harnesses those searches apply to via an expanded Add/Edit View dialog.

### Key Changes
1. **Dropdown Categories**: Reorganize the view dropdown into "Built In", "Favorites", and "Searches".
2. **Project Fetching**: Fetch available projects/harnesses from `/api/projects`.
3. **Advanced Search Configuration**: Allow users to configure search views with specific harness/project scope (UI: 2 columns of checkboxes, max 500px scrollable div).
4. **POST Search Requests**: When a custom search uses project filtering, switch from a `GET` query to a `POST` body payload.

---

## 2. API Contract

### 2.1 Get Projects
**Endpoint**: `GET /api/projects`
**Response Shape**:
```json
[
  { "harness": "ClaudeCode", "projects": ["AXON", "NexusPlatform"] },
  { "harness": "Cursor",     "projects": ["AXON", "NexusPlatform"] },
  { "harness": "Kiro",       "projects": ["AXON"] },
  { "harness": "VSCode",     "projects": ["NexusPlatform"] }
]
```

### 2.2 POST Search (Filtered)
**Endpoint**: `POST /api/search`
**Payload Shape**:
```typescript
{
  query: string;
  projects?: {
    harness: string;
    project: string;
  }[]
}
```

**Example Request Payload (2 Projects):**
```json
{
  "query": "authentication flow",
  "projects": [
    { "harness": "ClaudeCode", "project": "NexusPlatform" },
    { "harness": "Cursor", "project": "NexusPlatform" }
  ]
}
```
*Note: If no projects are selected, the client will fall back to using `GET /api/search?q=...` or send an empty/omitted `projects` array, falling back to global search.*

---

## 3. Type Changes (Visualizer)

### 3.1 Project Definition
```typescript
export type ProjectGroup = {
  harness: string;
  projects: string[];
};

export type SelectedProject = {
  harness: string;
  project: string;
};
```

### 3.2 Update `ViewDefinition`
Update local view storage models to persist project combinations.
```typescript
export type ViewDefinition = {
  id: string;
  name: string;
  type: ViewType;
  emoji: string;
  color: string;
  createdAt: number;
  projects?: SelectedProject[]; // New field for specific harness:project scopes
};
```

---

## 4. UI Changes

### 4.1 Filter Form UI (Add/Edit View Dialog)
The Add View form needs to fetch and display the available combinations of `harness:project`.
- Below the **Emoji field**, add a new section for Scope/Projects.
- Container CSS: `max-height: 500px; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;`
- Render one checkbox per combination (e.g., `ClaudeCode:AXON`, `ClaudeCode:NexusPlatform`).
- The scrollbar applies if the list of permutations is large.

### 4.2 Dropdown Reorganization
Update the view dropdown list (likely in `ViewDropdown` or `Sidebar`) to group elements by three categories instead of two:
1. **Built In**: "Latest...", "Search Messages", "Search Threads".
2. **Favorites**: Views with type `favorites`.
3. **Searches**: Custom search views.

---

## 5. Implementation Tasks

### Group 1: API and Types
- [x] Add `ProjectGroup` and `SelectedProject` types to `visualizer/src/types.ts`.
- [x] Add `fetchProjects()` to `visualizer/src/api/search.ts` to call `GET /api/projects`.
- [x] Update `search()` API wrapper to handle `POST /api/search` for complex payloads (i.e. if `projects` array is present and non-empty), rather than `GET /api/search?q=...`.
- [x] Update `ViewDefinition` in `visualizer/src/types.ts` with optional `projects` array.

### Group 2: Add/Edit View Dialog
- [x] In `EditResultsView.tsx` (or equivalent "Add View" dialog), use a state `selectedProjects: SelectedProject[]`.
- [x] Implement a `useEffect` on mount to invoke `fetchProjects()` and build the permutation list (Harness X Project).
- [x] Add the 500px scrolling grid layout under the Emoji field picker.
- [x] Map combinations to `checkbox` inputs labelled `harness:project`.
- [x] Update view definitions with `selectedProjects` on save.

### Group 3: Dropdown Organization
- [x] Update the View Dropdown component's categorisation logic.
- [x] Separate logic dividing `views.filter(...)` into `Built In`, `Favorites` variants, and `Searches` (type `search` excluding built-ins).

### Group 4: Search Hook Integration
- [x] Update the `useSearch` hook (or equivalent) to extract `activeView.projects`.
- [x] If `projects` is present and the active view is executing a search, correctly route into the `POST` interface of the search function with the payload structured correctly.

---

## 6. Project Scope UX Improvements

**Date**: 2026-03-19

### 6.1 Live Search Filter for Projects

The Scope/Projects grid can contain many entries. Add a **live search box** directly above the grid that instantly filters the visible project checkboxes as the user types.

- Place an `<input>` with a search icon (CSS `::before` or inline SVG) above `.edit-results-view-projects-grid`.
- No submit button — filtering happens on every keystroke via a local `projectFilter` state.
- The filter matches against the combined `PROJECT [HARNESS]` label (case-insensitive substring match).
- Already-checked projects that don't match the filter should **still remain checked** in state — they are just hidden from view. Unchecking requires clearing the filter first or matching them again.

### 6.2 Display Format Change: PROJECT [HARNESS]

Switch the checkbox label format from `HARNESS:PROJECT` to `PROJECT [HARNESS]`.

- The flattened list of project combinations is sorted **alphabetically by project name** (case-insensitive), then by harness as tiebreaker.
- Example labels: `AXON [ClaudeCode]`, `AXON [Cursor]`, `NexusPlatform [ClaudeCode]`.

### 6.3 Implementation Tasks

#### Group 5: Project Scope UX
- [x] In `EditResultsView.tsx`, add a `projectFilter` state (`useState<string>("")`).
- [x] Build a sorted+flattened list of `{ harness, project, label }` entries from `availableProjects`, sorted alphabetically by project then harness. Use `useMemo` keyed on `availableProjects`.
- [x] Render a search input (with search icon via CSS) above the projects grid. On change, update `projectFilter`.
- [x] Filter the flattened list by case-insensitive substring match on `label` against `projectFilter`.
- [x] Update checkbox labels from `{harness}:{project}` to `{project} [{harness}]`.
- [x] In `EditResultsView.css`, style the project search input (search icon, consistent with existing inputs).
