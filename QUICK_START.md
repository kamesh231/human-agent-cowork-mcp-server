# Quick Start

Choose your path:

## 👨‍💻 I want to try it right now (local dev)

```bash
git clone https://github.com/kamesh231/human-agent-cowork-mcp-server.git
cd cowork-mcp-server
npm install
npm run build
npm run start
```

Then connect Claude Desktop or Claude Code to the running server.

**Time: 2 min** | **Difficulty: Easy** | **Status: ✅ Works**

---

## 🌍 I want to install globally (npm)

```bash
npm install -g @cowork/mcp-server
cowork-mcp
```

**Status: ❌ Not yet published** | **ETA: ~1 week** | **Current: Use local method above**

---

## 🔧 I want to integrate into my agent

### Step 1: Start the COWORK server
```bash
npm run start
# Runs on stdio, ready for MCP connections
```

### Step 2: Configure Claude Desktop or Code
**Claude Desktop** (`~/.config/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "cowork": {
      "command": "node",
      "args": ["/full/path/to/cowork-mcp-server/build/index.js"]
    }
  }
}
```

**Claude Code**:
```bash
claude mcp add cowork node /path/to/cowork-mcp-server/build/index.js
```

### Step 3: Call tools from your agent
```javascript
// In your agent code, the COWORK tools are now available:
// - cowork_propose
// - cowork_approve
// - cowork_override
// - cowork_check_trust
// - cowork_status
// ... and 8 more
```

---

## 🧪 I want to inspect what's happening

```bash
npm run inspect
# Opens MCP Inspector — test all tools interactively
```

Or query the database:
```bash
sqlite3 cowork.db "SELECT * FROM trust_scores;"
sqlite3 cowork.db "SELECT * FROM proposals;"
```

---

## 🚀 I want to understand the protocol first

Read: [PROTOCOL_ALIGNMENT.md](./PROTOCOL_ALIGNMENT.md)

It shows:
- Which 18 COWORK primitives are implemented
- Real-world case studies (CRM data integrity, cross-environment handoffs)
- Gaps and what's missing
- Questions for architecture decisions

---

## ❓ I have a question

See [README.md](./README.md) for detailed docs, examples, and configuration guide.

See [INSTALLATION_STATUS.md](./INSTALLATION_STATUS.md) for the honest truth about what works and what doesn't.

---

## 📋 Status Summary

| Component | Status |
|-----------|--------|
| Core protocol | ✅ 9/18 primitives implemented |
| Code quality | ✅ Type-safe, atomic, audited |
| Local setup | ✅ Works in 2 minutes |
| npm global install | ❌ Coming in ~1 week |
| Production ready | ⚠️ 3 critical gaps to fix first |
| Documentation | ✅ Complete |

