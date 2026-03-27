# ContextCore MCP - Connection Guide

**Date**: 2026-03-22  
**Scope**: Connect MCP clients (Claude Code, Cursor, VS Code, JetBrains IDEs, remote agents) to ContextCore  
**Related**: `archi-mcp.md`, `r2m3-mcp-iteration-3.md`

---

## 1. Transport Overview

ContextCore currently exposes two MCP transport modes:

| Transport | Endpoint                        | Use Case                                      | Auth                  |
| --------- | ------------------------------- | --------------------------------------------- | --------------------- |
| **stdio** | subprocess                      | Local clients that spawn ContextCore directly | None (local process)  |
| **SSE**   | `http://localhost:3210/mcp/sse` | Network/remote clients                        | Optional Bearer token |

Notes:

- `stdio` is started with `bun run mcp`.
- SSE routes are mounted only when the full server runs with `MCP_ENABLED=true` and `MCP_SSE_ENABLED=true`.
- Some clients now prefer HTTP transport over SSE. ContextCore remote transport is still SSE today.

### Prerequisites

- Bun installed on the machine running ContextCore.
- Dependencies installed: `cd server && bun install`.
- For stdio, no full server is required.
- For SSE, run the full server (`bun run start`) with SSE enabled.

> Important: For stdio configs, `cwd` must point to the `server/` directory (where `package.json` lives), not the repository root.

---

## 2. Claude Code (Current Format)

Claude Code now uses CLI-first setup and `.mcp.json` for project-shared configuration.

### 2.1 Recommended: add with CLI

From the repo root:

```bash
cd /path/to/context-core
claude mcp add --transport stdio --scope project context-core -- bun run mcp
```

This creates or updates `.mcp.json` in the project root.

### 2.2 Equivalent project file (`.mcp.json`)

```json
{
  "mcpServers": {
    "context-core": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/path/to/context-core/server"
    }
  }
}
```

Windows path example:

```json
{
  "mcpServers": {
    "context-core": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "<path-to-context-core>\\server"
    }
  }
}
```

### 2.3 SSE (legacy transport in Claude docs)

Anthropic marks SSE as deprecated where HTTP is available. ContextCore remote endpoint is SSE, so this is still valid:

```bash
claude mcp add --transport sse context-core http://localhost:3210/mcp/sse
```

With auth header:

```bash
claude mcp add --transport sse context-core http://localhost:3210/mcp/sse \
  --header "Authorization: Bearer <your-MCP_AUTH_TOKEN>"
```

### 2.4 Verify

- Run `claude mcp list`
- In session, run `/mcp`
- You should see `context-core` and available tools

---

## 3. Cursor

### 3.1 Config location

- Project: `.cursor/mcp.json`
- Global: `~/.cursor/mcp.json`

### 3.2 stdio

```json
{
  "mcpServers": {
    "context-core": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/path/to/context-core/server"
    }
  }
}
```

### 3.3 Remote (URL-based; HTTP/SSE)

```json
{
  "mcpServers": {
    "context-core": {
      "url": "http://localhost:3210/mcp/sse"
    }
  }
}
```

With auth token:

```json
{
  "mcpServers": {
    "context-core": {
      "url": "http://localhost:3210/mcp/sse",
      "headers": {
        "Authorization": "Bearer ${env:MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

### 3.4 Verify

- Open Cursor MCP settings
- Confirm the server is connected
- In chat/composer, invoke a ContextCore tool

---

## 4. VS Code (GitHub Copilot Chat)

Use `.vscode/mcp.json` for workspace-shared setup, or user-profile MCP config for global setup.

### 4.1 stdio

```json
{
  "servers": {
    "contextCore": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "${workspaceFolder}/server",
      "envFile": "${workspaceFolder}/server/.env"
    }
  }
}
```

### 4.2 Remote

VS Code supports `type: "http"` and `type: "sse"`. For ContextCore today, explicit SSE is the most direct config:

```json
{
  "servers": {
    "contextCore": {
      "type": "sse",
      "url": "http://localhost:3210/mcp/sse"
    }
  }
}
```

With auth input variable:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "mcp-token",
      "description": "ContextCore MCP Bearer token",
      "password": true
    }
  ],
  "servers": {
    "contextCore": {
      "type": "sse",
      "url": "http://localhost:3210/mcp/sse",
      "headers": {
        "Authorization": "Bearer ${input:mcp-token}"
      }
    }
  }
}
```

### 4.3 Verify

- Command Palette -> `MCP: List Servers`
- Select `contextCore` -> check status / `Show Output`
- In Chat, run a prompt that should use the server tools

---

## 5. JetBrains IDEs (IntelliJ IDEA 2025.2+)

JetBrains IDEs include an integrated MCP server and can auto-configure external clients.

### 5.1 Auto-configure external clients from IntelliJ

1. Open `Settings | Tools | MCP Server`
2. Enable MCP Server
3. Use `Auto-Configure` for target clients (Claude Code, Cursor, VS Code, etc.)
4. Restart the target client

### 5.2 Manual config export

From the same UI, use:

- `Copy SSE Config` or
- `Copy Stdio Config`

Then paste into the target client's MCP config file.

---

## 6. SSE API (Remote / Network Clients)

The SSE transport is active when full server is running with:

```bash
MCP_ENABLED=true
MCP_SSE_ENABLED=true
```

### 6.1 Open session stream

```bash
curl -N -H "Accept: text/event-stream" http://localhost:3210/mcp/sse
```

Server responds with endpoint event, for example:

```text
event: endpoint
data: /mcp/messages?sessionId=<session-id>
```

### 6.2 Send JSON-RPC messages

```bash
curl -X POST "http://localhost:3210/mcp/messages?sessionId=<session-id>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### 6.3 Authenticated mode

Start server with token:

```bash
MCP_AUTH_TOKEN=my-secret-token bun run start
```

Connect with auth header:

```bash
curl -N \
  -H "Accept: text/event-stream" \
  -H "Authorization: Bearer my-secret-token" \
  http://localhost:3210/mcp/sse
```

---

## 7. Tools, Resources, Prompts (Current ContextCore)

### 7.1 Tools

ContextCore exposes 12 tools across message/session retrieval, search, and topic management.

### 7.2 Resources

ContextCore exposes 4 static resources plus 1 URI template:

- `cxc://stats`
- `cxc://projects`
- `cxc://harnesses`
- `cxc://query-syntax`
- `cxc://projects/{name}/sessions` (template)

### 7.3 Prompts

ContextCore exposes 4 prompts:

- `explore_history`
- `summarize_session`
- `find_decisions`
- `debug_history`

---

## 8. Config Syntax Quick Reference

| Client                    | Root key                        | Local stdio keys                                                            | Remote keys                             |
| ------------------------- | ------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| Claude Code (`.mcp.json`) | `mcpServers`                    | `type`, `command`, `args`, `cwd`, `env`                                     | `type`, `url`, `headers`, `oauth`       |
| Cursor (`mcp.json`)       | `mcpServers`                    | `type`, `command`, `args`, `cwd`, `env`, `envFile`                          | `url`, `headers`, optional `auth`       |
| VS Code (`mcp.json`)      | `servers` (+ optional `inputs`) | `type`, `command`, `args`, `cwd`, `env`, `envFile`, optional sandbox fields | `type` (`http`/`sse`), `url`, `headers` |

---

## 9. Troubleshooting

| Symptom              | Likely cause                               | Fix                                                            |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Server not listed    | Wrong config path or root key              | Confirm file location and root key (`mcpServers` or `servers`) |
| `bun` not found      | PATH issue                                 | Use full executable path in `command`                          |
| 401 on SSE           | Missing/mismatched token                   | Match `MCP_AUTH_TOKEN` and `Authorization` header              |
| Connection refused   | SSE route disabled                         | Set `MCP_SSE_ENABLED=true` and restart full server             |
| Empty search results | Index not ready                            | Run full ingest path (`bun run start`) to build/update corpus  |
| Topic store errors   | Running stdio-only with missing topic data | Ensure topic data exists in storage or run full server flow    |

---

## 10. Sources Checked (March 2026)

- Claude Code MCP docs: `https://code.claude.com/docs/en/mcp`
- Cursor MCP docs: `https://cursor.com/docs/mcp`
- VS Code MCP docs: `https://code.visualstudio.com/docs/copilot/customization/mcp-servers`
- VS Code MCP config reference: `https://code.visualstudio.com/docs/copilot/reference/mcp-configuration`
- IntelliJ IDEA MCP server docs: `https://www.jetbrains.com/help/idea/mcp-server.html`
- Kiro MCP config docs: `https://kiro.dev/docs/mcp/configuration/`
