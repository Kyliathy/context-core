# R2US – ContextCore Interactive Setup Script

**Date**: 2026-03-15
**Status**: Planning
**Output**: `server/src/setup.ts` + `"setup"` script in `package.json`

---

## 1. Goal

Create an interactive CLI setup script (`bun run setup`) that discovers IDE chat data on the host machine and generates a ready-to-use machine config block in `cc.json`. The script must:

- Work on any machine (Windows, macOS, Linux)
- Never crash — every step fails gracefully with actionable advice
- Append to an existing `cc.json` or create a new one
- Propose sensible defaults throughout

---

## 2. User Flow

```
$ bun run setup

═══════════════════════════════════════════
  ContextCore Setup
═══════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────┐   ← chalk.cyan (light blue box)
│                                                                 │
│  IMPORTANT — Version 1.0 (Claude Code · Cursor · VS Code · Kiro)│
│                                                                 │
│  This is the first version of the setup wizard. It configures   │
│  the four currently supported harnesses. Support for additional │
│  agentic environments is planned for future releases:           │
│                                                                 │
│    • OpenCode                                                   │
│    • JetBrains AI Assistant                                     │
│    • Other agentic IDEs and CLI tools                           │
│                                                                 │
│  If your IDE is not listed, you can add its config manually     │
│  to cc.json once the schema is documented.                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Machine name detected: Kyliathy3
? Use this machine name? (Y/n): Y

? Storage directory [./cxc-storage]:

──── Claude Code ────
Scanning: c:\Users\Axonn\.claude\projects\
Found 3 project directories with .jsonl files:
  ✓ d--Codez-Nexus-Evo-NexusPlatform  (12 sessions)
  ✓ d--Codez-Nexus-AXON               (8 sessions)
  ✓ d--Codez-Nexus-Reach2-context-core (5 sessions)
? Include all 3 paths? (Y/n): Y

──── Cursor ────
Scanning: c:\Users\Axonn\AppData\Roaming\Cursor\User\globalStorage\
  ✓ state.vscdb found (14.2 MB)
? Include Cursor? (Y/n): Y

──── VS Code ────
Scanning: c:\Users\Axonn\AppData\Roaming\Code\User\workspaceStorage\
Found 3 workspace directories with chatSessions/:
  ✓ d408e4a80c64ab681f9df507c4c7b740
  ✓ 32f5b61a5bd25a075df43f887e697492
  ✓ aee888ac6f1b7a0dd7d34e476a192f8f
? Include all 3 paths? (Y/n): Y

──── Kiro ────
Scanning: c:\Users\Axonn\AppData\Roaming\Kiro\User\globalStorage\kiro.kiroagent\
Found 5 session directories (hex hash):
  • 1582a63a37f5cbc148e58da75716b816
  • 87db373831ef373c73f787d1470d35a6
  • 9daac64c13cd811c1fa8d6c03316826a
  • aa6468f5de3259f360105921aa31e9eb
  • fd37dbc1c42d2d933aee57a9d6e9646a
? Include all 5 paths? (Y/n): Y

? Configure project mapping rules for Kiro? (y/N): y
  Browsing 1582a63a37f5cbc148e58da75716b816...
  First user messages:
    1. "Help me refactor the AXON event system..."
    2. "Add a new command handler for..."
  ? Project name for this path (or skip): AXON

  Browsing 87db373831ef373c73f787d1470d35a6...
  First user messages:
    1. "Create a new React component for the chooser..."
  ? Project name for this path (or skip): Chooser
  ...

──── Generic Project Mapping Rules ────
? Add generic rules (byFirstDir)? (y/N): n

═══════════════════════════════════════════
  Configuration Preview
═══════════════════════════════════════════
{ ... JSON preview ... }

? Write to cc.json? (Y/n): Y
✓ Machine "Kyliathy3" added to cc.json
```

---

## 3. Architecture

### 3.1 File Structure

```
server/src/setup.ts          ← single entry point, all setup logic
```

No new dependencies. Uses only:
- `chalk` (already in dependencies) for colored terminal output
- `readline` (Node built-in via Bun) for interactive prompts
- `fs` / `path` (built-in) for file discovery
- `os` (built-in) for hostname/platform detection
- Kiro `.chat` parsing: inline minimal parser (not importing from harness to keep setup decoupled)

### Chalk Usage Convention

| Purpose | Style |
|---------|-------|
| IMPORTANT banner (version notice) | `chalk.cyan` (light blue box with border) |
| Section headers (`──── Claude Code ────`) | `chalk.bold` |
| Found / success | `chalk.green` |
| Warning / not found | `chalk.yellow` |
| Error | `chalk.red` |
| File paths | `chalk.dim` |
| User prompts (`?`) | `chalk.cyan` |

The version notice is rendered at startup using `chalk.cyan` on every line of the box, making it immediately visible without being alarming:

```typescript
function printVersionNotice(): void {
  const lines = [
    "  IMPORTANT — Version 1.0  (Claude Code · Cursor · VS Code · Kiro)  ",
    "                                                                      ",
    "  This is the first version of the setup wizard. It configures        ",
    "  the four currently supported harnesses. Support for additional      ",
    "  agentic environments is planned for future releases:                ",
    "                                                                      ",
    "    • OpenCode                                                         ",
    "    • JetBrains AI Assistant                                           ",
    "    • Other agentic IDEs and CLI tools                                 ",
    "                                                                      ",
    "  If your IDE is not listed, add its config manually to cc.json.      ",
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const border = chalk.cyan("┌" + "─".repeat(width + 2) + "┐");
  const bottom = chalk.cyan("└" + "─".repeat(width + 2) + "┘");
  console.log(border);
  for (const line of lines) {
    console.log(chalk.cyan("│ ") + chalk.cyan(line.padEnd(width)) + chalk.cyan(" │"));
  }
  console.log(bottom);
  console.log();
}
```

### 3.2 Module Design

```
setup.ts
├── main()                          ← orchestrator
├── promptUser(question, default?)  ← readline wrapper, never throws
├── detectMachineName()             ← os.hostname / COMPUTERNAME
├── detectPlatform()                ← "win32" | "darwin" | "linux"
│
├── discoverClaudeCode(username, platform)
│   ├── getClaudeCodeBasePath(username, platform)
│   ├── scanForJsonlProjects(basePath)
│   └── returns: string[] (paths with .jsonl files)
│
├── discoverCursor(username, platform)
│   ├── getCursorDbPath(username, platform)
│   ├── checks existsSync for state.vscdb
│   └── returns: string | null
│
├── discoverVSCode(username, platform)
│   ├── getVSCodeStoragePath(username, platform)
│   ├── scanForChatSessionDirs(basePath)  ← filter by chatSessions/ subdir
│   └── returns: string[] (workspace hash dirs)
│
├── discoverKiro(username, platform)
│   ├── getKiroAgentPath(username, platform)
│   ├── scanForHexHashDirs(basePath)      ← /^[0-9a-f]{32}$/ filter
│   ├── browseKiroUserMessages(dirPath)   ← minimal .chat parser
│   ├── promptKiroProjectMappings(dirs)   ← interactive per-dir naming
│   └── returns: { paths: string[], rules: ProjectMappingRule[] }
│
├── promptGenericRules()                  ← optional byFirstDir rules
├── buildMachineConfig(...)               ← assembles the config object
├── previewConfig(config)                 ← pretty-prints for user review
├── writeConfig(config, ccJsonPath)       ← read existing → append → write
└── ensureStorageDir(path)                ← mkdir -p equivalent
```

### 3.3 Package.json Entry

```json
"setup": "bun run src/setup.ts"
```

---

## 4. Platform-Specific Default Paths

### 4.1 Claude Code

| Platform | Base Path |
|----------|-----------|
| Windows  | `C:\Users\{user}\.claude\projects\` |
| macOS    | `/Users/{user}/.claude/projects/` |
| Linux    | `/home/{user}/.claude/projects/` |

**Discovery**: List subdirectories, keep those containing at least one `.jsonl` file.

### 4.2 Cursor

| Platform | DB Path |
|----------|---------|
| Windows  | `C:\Users\{user}\AppData\Roaming\Cursor\User\globalStorage\state.vscdb` |
| macOS    | `/Users/{user}/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux    | `/home/{user}/.config/Cursor/User/globalStorage/state.vscdb` |

**Discovery**: Check `existsSync(path)`. Report file size.

### 4.3 VS Code

| Platform | Storage Path |
|----------|--------------|
| Windows  | `C:\Users\{user}\AppData\Roaming\Code\User\workspaceStorage\` |
| macOS    | `/Users/{user}/Library/Application Support/Code/User/workspaceStorage/` |
| Linux    | `/home/{user}/.config/Code/User/workspaceStorage/` |

**Discovery**: List subdirectories, keep those containing a `chatSessions/` subdirectory (this is how we distinguish workspace dirs that have chat data from those that don't).

### 4.4 Kiro

| Platform | Agent Path |
|----------|------------|
| Windows  | `C:\Users\{user}\AppData\Roaming\Kiro\User\globalStorage\kiro.kiroagent\` |
| macOS    | `/Users/{user}/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/` |
| Linux    | `/home/{user}/.config/Kiro/User/globalStorage/kiro.kiroagent/` |

**Discovery**: List subdirectories, keep those whose name matches `/^[0-9a-f]{32}$/` (32 hex chars). This filters out `.diffs`, `.migrations`, `.utils`, `default`, `dev_data`, `index`, `workspace-sessions`, and config files.

**Kiro project mapping**: For each discovered hex dir:
1. Find `.chat` files in that directory
2. Parse JSON, extract `chat[]` entries where `role === "human"`
3. Skip the first human entry if it contains `<identity>` (system prompt)
4. Show the first 3 user messages (truncated to 120 chars each)
5. Ask the user to assign a project name or skip

---

## 5. Error Handling Strategy

Every discovery function follows this pattern:

```typescript
function discoverX(username: string, platform: string): Result {
  try {
    const basePath = getXPath(username, platform);
    if (!existsSync(basePath)) {
      console.log(`  ⚠ ${basePath} not found — skipping`);
      console.log(`    Tip: Install X or check if it stores data elsewhere`);
      return emptyResult;
    }
    // ... discovery logic ...
  } catch (err) {
    console.log(`  ✗ Error scanning for X: ${err.message}`);
    console.log(`    You can manually add X paths to cc.json later`);
    return emptyResult;
  }
}
```

Rules:
- **Never throw** from any discovery or prompt function
- **Always print** what went wrong and how to fix it manually
- **Always continue** to the next harness after a failure
- **Wrap file I/O** in try/catch at every call site
- **Validate cc.json** parse — if malformed, offer to create fresh

---

## 6. cc.json Write Strategy

1. Read existing `cc.json` if it exists
2. Parse it (if parse fails, ask user: overwrite or abort?)
3. Check if a machine with the same name already exists
   - If yes: ask "Replace existing config for {machine}?"
4. Append or replace the machine entry in `machines[]`
5. Write back with 2-tab indentation (matching existing style)
6. Preserve `storage` field — if it already exists and differs from the proposed default, ask which to keep

---

## 7. Kiro Message Preview — Minimal Parser

To keep setup.ts decoupled from the harness modules (which have heavier dependencies like winkNLP), we implement a **minimal inline parser** that only needs `fs.readFileSync` and `JSON.parse`:

```typescript
function browseKiroUserMessages(dirPath: string): string[] {
  // 1. Find .chat files in dirPath
  // 2. Parse JSON
  // 3. Extract chat[] entries with role === "human"
  // 4. Skip first entry if content contains "<identity>"
  // 5. Return first 3 user message texts (truncated)
}
```

This intentionally does NOT write to storage, call SubjectGenerator, or invoke any pipeline logic. It's read-only inspection.

---

## 8. Output Format

The generated config block matches the existing `cc.json` structure exactly:

```jsonc
{
  "machine": "Kyliathy3",
  "harnesses": {
    "ClaudeCode": {
      "path": [
        "c:\\Users\\Axonn\\.claude\\projects\\d--Codez-Nexus-Evo-NexusPlatform\\",
        // ...
      ]
    },
    "Cursor": {
      "path": "c:\\Users\\Axonn\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb",
      // projectMappingRules if any
    },
    "VSCode": {
      "path": [
        "c:\\Users\\Axonn\\AppData\\Roaming\\Code\\User\\workspaceStorage\\d408e...\\",
        // ...
      ]
    },
    "Kiro": {
      "path": [
        "c:\\Users\\Axonn\\AppData\\Roaming\\Kiro\\...\\1582a63a37f5cbc1...\\",
        // ...
      ],
      "projectMappingRules": [
        { "path": "1582a63a37f5cbc1...", "newPath": "AXON" }
      ]
    },
    "genericProjectMappingRules": [
      // if configured
    ]
  }
}
```

Key format notes:
- **Cursor path** is a single string (not array) — it's always one `state.vscdb` file
- **All other paths** are arrays of strings
- **Trailing backslash** on directory paths (matching existing convention)
- **Windows paths** use double-backslash in JSON

---

## 9. Implementation Steps

| # | Step | Description |
|---|------|-------------|
| 1 | Scaffold `setup.ts` | Create file with `main()`, `promptUser()`, `detectMachineName()`, `detectPlatform()` |
| 2 | Implement `discoverClaudeCode()` | Path detection, `.jsonl` scanning, user confirmation |
| 3 | Implement `discoverCursor()` | Path detection, `state.vscdb` existence check |
| 4 | Implement `discoverVSCode()` | Path detection, `chatSessions/` subdir filtering |
| 5 | Implement `discoverKiro()` | Path detection, hex hash filtering, `.chat` message preview, project mapping prompts |
| 6 | Implement `promptGenericRules()` | Optional `byFirstDir` rule creation |
| 7 | Implement `buildMachineConfig()` | Assemble config object from all discovery results |
| 8 | Implement `previewConfig()` | Pretty-print JSON for user review |
| 9 | Implement `writeConfig()` | Read/merge/write `cc.json` with collision handling |
| 10 | Add `"setup"` to `package.json` | `"setup": "bun run src/setup.ts"` |
| 11 | Test on current machine | Run `bun run setup` and verify output matches expected `cc.json` structure |

---

## 10. Non-Goals

- **No harness module imports** — setup.ts is self-contained (minimal Kiro parser inlined)
- **No data ingestion** — setup only writes config, never writes to storage
- **No network calls** — pure local filesystem inspection
- **No new dependencies** — uses only Bun/Node built-ins
