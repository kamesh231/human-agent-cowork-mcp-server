# @cowork/mcp-server

### Human-Agent Collaboration Primitives as an MCP Server

> Give your AI agent trust, handoffs, and accountability in 5 minutes.

## What This Does

6 MCP tools that add collaboration primitives to any AI agent:

| Tool | Primitive | What it does |
|------|-----------|-------------|
| `cowork_propose` | Intent Declaration | Agent proposes before acting. System checks trust → act / suggest / escalate |
| `cowork_check_trust` | Trust Score | Check trust level and operating mode for any domain |
| `cowork_handoff` | Context Packet | Escalate to human with structured context |
| `cowork_log` | Action Attribution | Log every action with who did it (agent/human/collaborative) |
| `cowork_override` | Override Signal | Record human corrections with structured reasons. Updates trust model |
| `cowork_status` | Dashboard | Trust scores, override rates, pending proposals, timeline |

## Quick Start

```bash
git clone https://github.com/kamesh231/cowork-protocol.git
cd cowork-protocol/mcp-server
npm install && npm run build
```

### Claude Desktop
```json
{ "mcpServers": { "cowork": { "command": "node", "args": ["/path/to/mcp-server/build/index.js"] } } }
```

### Claude Code
```bash
claude mcp add cowork node /path/to/mcp-server/build/index.js
```

## Before vs After

**Before:** Agent updates 200 CRM records. Nobody knows until conversion rates drop 3 weeks later.

**After:** Agent proposes each change. Trust score determines if it auto-executes or waits for review. Every action is attributed. Overrides feed back into trust. The system gets smarter.

## Opinionated Defaults

| Default | Value | Position |
|---------|-------|----------|
| Starting trust | 0.3 | Agents prove themselves |
| Default mode | `suggest` | Propose, never act directly |
| Auto-promote | 20 approved actions | Trust is earned |
| Auto-demote | 3 consecutive overrides | Trust degrades on correction |
| Override requires reason | `true` | "Wrong" ≠ "I prefer different" |
| Volume cap | 50/hour | No silent mass changes |

**Disagree? Fork the config. Submit a PR.**

## Override Types Matter

| Type | Trust Impact | Meaning |
|------|-------------|---------|
| `agent_wrong` | -0.08 | Factual error |
| `missing_context` | -0.03 | Should have escalated |
| `edge_case` | -0.02 | Hard to anticipate |
| `human_preference` | -0.01 | Correct but human prefers different |
| `policy_change` | 0.00 | Rules changed, not agent's fault |

## Storage

Local JSON file by default. Your data stays on your machine. Inspect with any text editor.

---

## COWORK Sentry — AI Flight Recorder

### The "Shadow AI" Problem

Standard AI agents often operate in a "Black Box." They call tools, modify databases, and read files without leaving a clear trail of **why** they took those actions. In a production environment, this is a governance nightmare.

### The COWORK Sentry Solution

`cowork-sentry` is a high-performance security proxy that sits between your AI (the MCP Client) and your Tools (the MCP Server). It enforces **Action Attribution** by requiring every tool call to be accompanied by a human-readable intent.

```
MCP Client (Claude, Cursor, etc.)
        |
        v
  +-----------------+
  | cowork-sentry   |  <-- Intercepts tools/call
  |                 |      Requires intent string
  |  SQLite Audit   |      Sanitizes args
  |  Hash Chain     |      Logs trace
  +-----------------+
        |
        v
  Downstream MCP Server
  (postgres, filesystem, git, etc.)
```

### Core Security Features

- **Immutable Audit Log**: Every action is recorded in a local SQLite database.
- **Tamper-Evident Hash Chain**: Each log entry is cryptographically linked to the previous one. If a single row is modified manually, the chain breaks and the Sentry alerts you.
- **PII Sanitization**: Automatically redacts sensitive patterns (keys, tokens, passwords) from the logs before they hit the disk. Also scrubs known secret formats (AWS keys, JWTs, Stripe keys, etc.) even in innocently named fields.
- **UI-Resilient Proxying**: Automatically "unpacks" stringified JSON-in-JSON, making it compatible with the MCP Inspector and various LLM quirks.

### Quick Start

Wrap any existing MCP server in one command:

```bash
cowork-sentry -- npx @modelcontextprotocol/server-postgres postgresql://localhost/mydb
```

### Installation

```bash
# Global install
npm install -g @cowork/mcp-server

# Or zero-install
npx -p @cowork/mcp-server cowork-sentry -- npx @modelcontextprotocol/server-filesystem ./
```

### Claude Desktop Configuration

```json
{
  "mcpServers": {
    "cowork": {
      "command": "cowork-mcp"
    },
    "my-db-with-audit": {
      "command": "cowork-sentry",
      "args": ["--", "npx", "@modelcontextprotocol/server-postgres", "postgresql://..."]
    }
  }
}
```

### Claude Code Configuration

```bash
claude mcp add cowork cowork-mcp
claude mcp add my-db cowork-sentry -- npx @modelcontextprotocol/server-postgres "postgresql://..."
```

### How It Works

An agent sends a `tools/call` request with `_cowork_metadata`:

```json
{
  "method": "tools/call",
  "params": {
    "name": "read_file",
    "arguments": {
      "path": "/etc/config.yaml",
      "_cowork_metadata": {
        "intent": "Reading config to check database connection settings",
        "agent_id": "support-bot-v2"
      }
    }
  }
}
```

The Sentry:
1. Extracts the intent
2. Sanitizes sensitive arguments (passwords, tokens, API keys)
3. Logs an `ActionTrace` to SQLite (status: PENDING)
4. Strips `_cowork_metadata` and forwards the clean call downstream
5. Updates the trace (COMPLETED/FAILED) with duration when the response arrives

### CLI Options

```
cowork-sentry [options] -- <command> [args...]

Options:
  --db <path>            SQLite audit database path     (default: ./cowork-traces.db)
  --agent-id <id>        Default agent ID for sessions
  --enforcement <mode>   "strict" blocks without intent, "warn" logs and forwards
  --verify-chain         Verify hash chain integrity and exit
  --version, -v          Print version
  --help, -h             Show help
```

### Enforcement Modes

| Mode | Missing Intent | Use Case |
|------|---------------|----------|
| `strict` (default) | Blocks the call with error `-32602` | Production: every action must be attributed |
| `warn` | Logs warning, forwards anyway, records `[MISSING]` intent | Development / gradual rollout with non-COWORK agents |

### Verify Audit Integrity

```bash
cowork-sentry --verify-chain --db ./cowork-traces.db
# [cowork-sentry] Hash chain is valid.
```

### ActionTrace Schema

Every intercepted tool call produces one row:

| Field | Type | Description |
|-------|------|-------------|
| `trace_id` | UUID | Unique trace identifier |
| `agent_id` | string | Session/agent identifier |
| `intent` | string | Why the agent made this call |
| `tool_name` | string | MCP tool name |
| `args_json` | string | Sanitized, stringified arguments |
| `status` | enum | PENDING, COMPLETED, or FAILED |
| `duration_ms` | integer | Downstream call duration |
| `prev_hash` | string | SHA-256 of previous row (tamper-evident chain) |
| `timestamp` | ISO 8601 | When the trace was created |

### Configuration

Add a `sentry` section to `cowork.config.yaml`:

```yaml
sentry:
  enabled: true
  db_path: "./cowork-traces.db"
  enforcement: "strict"      # or "warn"
  sensitive_keys: []          # additional patterns on top of built-ins
  hash_chain: true
```

---

## Part of [COWORK Protocol](https://github.com/kamesh231/cowork-protocol)

MIT License
