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

## Part of [COWORK Protocol](https://github.com/kamesh231/cowork-protocol)

MIT License
