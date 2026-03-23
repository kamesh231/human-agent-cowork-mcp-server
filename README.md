# @cowork/mcp-server

### Human-Agent Collaboration Primitives as an MCP Server

> Add trust, handoffs, and accountability to any AI agent. Production-ready implementation of the [COWORK Protocol](https://github.com/kamesh231/cowork-protocol).

---

## Status

**v0.1.0 — Week 1 Foundation Complete ✅**

- ✅ Core 6 primitives implemented and tested
- ✅ 13 MCP tools (core + week 2 enhancements)
- ✅ Atomic trust operations (no TOCTOU races)
- ✅ Identity binding with open/closed auth modes
- ✅ Policy engine with hard-stop constraints
- ✅ Bulk operations and governance reporting
- ✅ SQLite audit trail with hash-chain integrity
- ⏳ **npm publish coming after final validation**

**Not yet published to npm.** Install from source (local development) or wait for registry release.

---

## What This Does

**13 MCP Tools** that add collaboration primitives to any AI agent:

| Tool | Primitive | What it does |
|------|-----------|-------------|
| `cowork_propose` | Intent Declaration | Agent proposes before acting. Trust score determines: act / suggest / escalate |
| `cowork_approve` | Approval Signal | Human approves proposal. Trust increases, closes positive feedback loop |
| `cowork_override` | Override Signal | Human corrects agent. Trust degrades. 5 categories + 4 severity levels |
| `cowork_check_trust` | Trust Score | Check trust level + accuracy + operating mode for any domain |
| `cowork_handoff` | Context Packet | Escalate to human with structured context + attempted actions + reasoning |
| `cowork_log` | Action Attribution | Log action with who did it (agent/human/collaborative) |
| `cowork_validate_policy` | Action Scope | Pre-flight policy validation. Field-level constraints + role-based exemptions |
| `cowork_bulk_approve` | Batch Approval | Approve 50+ proposals in one decision. Human review fatigue ↓ |
| `cowork_bulk_reject` | Batch Override | Reject multiple proposals with one reason |
| `cowork_resolve_handoff` | Handoff Resolution | Human resolves escalation. Optionally hands work back with instructions |
| `cowork_audit_trail` | Action Attribution | Full audit chain: propose → approve → execute → verify |
| `cowork_governance_report` | Intervention Map | Detect governance gaps: orphaned executions, slow decisions, missing approvals |
| `cowork_status` | Dashboard | Trust scores, override rates, pending proposals, timeline |

---

## Installation

### Option 1: Local Development (Works Now) ✅

```bash
# Clone the repo
git clone https://github.com/kamesh231/human-agent-cowork-mcp-server.git
cd cowork-mcp-server

# Install and build
npm install
npm run build

# Verify it works
npm run start
```

**Expected output:**
```
🤝 COWORK MCP Server v0.1.0 started
   Auth: open mode (demo) | Mode: suggest | Trust default: 0.3
```

#### Claude Desktop (Local)

Edit `~/.config/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Restart Claude Desktop. You'll see "cowork" in the tools menu.

#### Claude Code (Local)

```bash
# From the cowork-mcp-server directory:
claude mcp add cowork node "$(pwd)/build/index.js"
```

### Option 2: Global npm (Coming Soon) ⏳

When published to npm registry, these commands will work:

```bash
# Global install
npm install -g @cowork/mcp-server

# Claude Desktop config
{
  "mcpServers": {
    "cowork": {
      "command": "cowork-mcp"
    }
  }
}

# Claude Code
claude mcp add cowork cowork-mcp
```

**Status:** Not yet published. Estimated ~1 week after fixing critical gaps.

---

## How to Implement

### 1. Start Small — Demo Mode (Open Auth)

By default, the server runs in **open mode** — any `agent_id` is accepted, no token verification needed.

```bash
npm run start
```

All 13 tools are immediately available. Great for prototyping.

### 2. Add Identity Binding (Closed Auth)

Create or edit `cowork.config.yaml`:

```yaml
# cowork.config.yaml
agents:
  - id: "sales-agent"
    token: "sk-cowork-..."
  - id: "support-agent"
    token: "sk-cowork-..."
```

Generate tokens:
```bash
node -e "
const {generateToken, hashToken} = require('./build/auth.js');
const t = generateToken();
console.log('token:', t);
console.log('hash:', hashToken(t));
"
```

Now every tool call requires `agent_token`. The token is hashed against the config.

### 3. Configure Trust Thresholds & Policies

```yaml
trust:
  default_level: 0.3        # Agents start supervised
  auto_promote_after: 20    # Trust increases after 20 approvals
  auto_promote_accuracy: 0.8  # At 80%+ approval rate
  auto_demote_after: 3      # Trust drops after 3 consecutive overrides

authority:
  default_mode: "suggest"   # All agents must propose first
  volume_cap: 50            # Max 50 proposals/hour per agent
  high_risk_fields:         # Always force human review
    - "deal_stage"
    - "commission"
    - "utm_*"
    - "billing_*"
```

### 4. Add Policy Constraints (Domain-Specific)

```yaml
policies:
  crm.deals:
    rules:
      - type: "field_readonly"
        field: "owner"
        reason: "Deal owner change requires manager approval"
        roles_exempt: ["manager", "admin"]
      - type: "value_range"
        field: "deal_amount"
        min: 0
        max: 1000000
```

### 5. Wire into Your Agent

```javascript
// Agent proposes action
const proposal = await cowork_propose({
  agent_id: "sales-agent",
  agent_token: "sk-cowork-...",
  domain: "crm.deals",
  action: "update_deal",
  target: "deal_12345",
  proposed_change: JSON.stringify({ deal_stage: "closed_won" }),
  confidence: 0.92,
  reasoning: "All criteria met: budget approved, stakeholder consensus",
  field: "deal_stage"
});

if (proposal.mode === "act") {
  // Trust is high, proceed autonomously
  await database.update("deals", deal_12345, { deal_stage: "closed_won" });
} else if (proposal.mode === "suggest") {
  // Trust is medium, wait for review
  console.log(`📋 Proposal ${proposal.proposal_id} awaiting review`);
} else {
  // Trust is low, escalate
  console.log(`🚨 Escalated: ${proposal.proposal_id}`);
}
```

### 6. Integrate Human Feedback

```javascript
// Approve
await cowork_approve({
  proposal_id: proposal_id,
  agent_id: "sales-agent",
  domain: "crm.deals",
  feedback: "Looks good — legal confirmed."
});
// Trust: +0.02

// Or correct
await cowork_override({
  agent_id: "sales-agent",
  domain: "crm.deals",
  action_description: "Deal closure was premature",
  override_type: "agent_wrong",
  severity: "high",
  description: "Contract still being negotiated."
});
// Trust: -0.12 (0.08 × 1.5 severity multiplier)
```

---

## Domain & Agent Mapping

### How Agents Are Mapped

Agents are **explicitly registered** in config:

```yaml
agents:
  - id: "sales-agent"
    token: "sk-cowork-abc123..."
    workspace_id: "acme-corp"
  - id: "support-agent"
    token: "sk-cowork-xyz789..."
```

Every tool call must include matching `agent_id` + `agent_token`.

### How Domains Are Mapped

Domains are **organic** — agents choose them at proposal time:

```javascript
// Sales agent in CRM
await cowork_propose({
  agent_id: "sales-agent",
  domain: "crm.deals",  // ← Agent chooses domain
  // ...
});

// Same agent, different domain
await cowork_propose({
  agent_id: "sales-agent",
  domain: "support.tickets",  // ← Different domain = separate trust
  // ...
});
```

**Trust is per (agent_id, domain):**
```
sales-agent:crm.deals         → trust 0.85 (act mode)
sales-agent:crm.contacts      → trust 0.40 (suggest mode)
sales-agent:support.tickets   → trust 0.30 (escalate mode)
```

Same agent can have different trust levels in different domains.

---

## Examples

### Example 1: CRM Data Integrity (Sales Agent)

```javascript
const proposal = await cowork_propose({
  agent_id: "sales-agent",
  agent_token: "sk-cowork-...",
  domain: "crm.deals",
  action: "advance_deal",
  target: "deal_45678",
  proposed_change: JSON.stringify({
    deal_stage: "negotiation",
    amount: 150000
  }),
  confidence: 0.85,
  reasoning: "All criteria met: 3+ touchpoints, budget confirmed, timeline aligns",
  field: "deal_stage"
});

// Policy engine checks: deal_stage is high_risk_field → violations (warnings)
// Trust engine checks: agent trust = 0.65 in crm.deals → mode = "suggest"
// Result: proposal created, human review required
```

### Example 2: Cross-Environment Handoff

```javascript
// Claude Desktop (research) hands off to Claude Code (implementation)
const handoff = await cowork_handoff({
  agent_id: "research-agent",
  domain: "documentation",
  reason: "Code implementation needed for API reference",
  confidence: 0.88,
  attempted_actions: JSON.stringify([
    "found existing examples",
    "identified gaps in spec"
  ]),
  context: JSON.stringify({
    task: "Fill POST /deals endpoint docs",
    gaps: ["request schema", "error codes"],
    suggested_approach: "Use SDK examples as reference"
  }),
  handoff_mode: "collaborate"
});

// Claude Code resumes with context packet
```

---

## Philosophy

| Design | Position |
|--------|----------|
| Trust | Earned through approval history. Starts low (0.3), increases on correct actions, degrades on corrections |
| Autonomy | More autonomy = more trust. Agent at 0.85 trust can act on most things. At 0.3, must be reviewed |
| Feedback | Overrides matter more than approvals. One "agent_wrong" can trigger demotion if repeated |
| Authority | Granted per domain. Agent can be trusted in CRM but not in billing |
| Transparency | Every action logged. Human can see: who did it, why they proposed it, what feedback was given |

---

## Override Categories

When a human corrects an agent:

| Category | Impact | Meaning | Example |
|----------|--------|---------|---------|
| `agent_wrong` | -0.08 | Factual error | Agent marked deal closed without signature |
| `missing_context` | -0.03 | Should have escalated | Agent didn't realize field was deprecated |
| `edge_case` | -0.02 | Hard to anticipate | Rare rule agent didn't know |
| `human_preference` | -0.01 | Correct, but human prefers different | Used "Hi there" instead of "Dear..." |
| `policy_change` | 0.00 | Rules changed, not agent's fault | Company policy updated yesterday |

**Severity multiplier:**
- `low`: 0.5× (minor)
- `medium`: 1.0× (standard)
- `high`: 1.5× (serious)
- `critical`: 2.5× (major failure)

---

## Storage

- **Default**: Local SQLite database at `./cowork.db`
- **Data**: Proposals, approvals, overrides, actions, timeline, audit trail
- **Access**: Query with `sqlite3 cowork.db` or use `cowork_status` / `cowork_audit_trail` tools
- **Schema**: Fully inspectable. No proprietary encoding.

---

## Protocol Alignment

This implementation covers **9 of 18** COWORK Protocol primitives with full fidelity. See [PROTOCOL_ALIGNMENT.md](./PROTOCOL_ALIGNMENT.md) for detailed analysis.

**Fully implemented (9):**
- ✅ Trust Score (per domain)
- ✅ Trust Threshold (3-tier with auto-promotion)
- ✅ Action Scope (policies + high-risk fields)
- ✅ Context Packet (structured handoff data)
- ✅ Override Signal (categorized + severity-scaled)
- ✅ Approval Signal (closes positive feedback loop)
- ✅ Confidence Signal (0.0–1.0 on every proposal)
- ✅ Intent Declaration (cowork_propose before action)
- ✅ Action Attribution (agent/human/collaborative)

**Partially implemented (9):** See [PROTOCOL_ALIGNMENT.md](./PROTOCOL_ALIGNMENT.md) for gaps.

---

## Known Gaps & Roadmap

### Critical (Before npm Publish)

- [ ] **Volume cap enforcement** — configured but never checked at runtime
- [ ] **Continuity State** — SESSION_ID resets on restart, no checkpoint/resume
- [ ] **BulkDecision schema** — Proposal lacks agent_id/domain for denormalization
- [ ] **Test suite** — manual testing only, no automated tests

### High-Priority (v0.2–0.3)

- [ ] Trust Evidence chain — "why does this agent have this score?"
- [ ] Intervention Map aggregation tool
- [ ] Handoff modes — add `delegate` and `takeover`
- [ ] Reasoning structure validation

### Timeline to npm

- **This week:** Fix critical gaps (~25 hours)
- **Next week:** npm publish
- **After publish:** `npm install -g @cowork/mcp-server` works globally

---

## Testing

```bash
# Run the server
npm run start

# In another terminal, use MCP Inspector
npm run inspect

# Or integrate with Claude Desktop/Code and test the tools
```

---

## Architecture

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | 774 | 13 MCP tool handlers |
| `src/trust.ts` | 300+ | Atomic trust mutations |
| `src/auth.ts` | 145 | Token verification |
| `src/policy.ts` | 200+ | Field-level constraints |
| `src/storage.ts` | 400+ | SQLite schema + queries |
| `src/audit.ts` | 330 | Audit trail + governance |
| `src/bulk-decision.ts` | 211 | Batch operations |
| `src/notify.ts` | 150+ | Notifications |

**Production features:**
- Atomicity: SQLite `BEGIN EXCLUSIVE` transactions
- Backward compatible: open mode for demos
- Type-safe: Full TypeScript + Zod validation
- Immutable audit: WAL mode with `PRAGMA synchronous = FULL`
- Extensible: YAML-driven policies

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

---

## Links

- **COWORK Protocol Spec**: https://github.com/kamesh231/cowork-protocol
- **This Repo**: https://github.com/kamesh231/human-agent-cowork-mcp-server
- **Protocol Alignment**: [PROTOCOL_ALIGNMENT.md](./PROTOCOL_ALIGNMENT.md)
- **Installation Status**: [INSTALLATION_STATUS.md](./INSTALLATION_STATUS.md)
- **Quick Start**: [QUICK_START.md](./QUICK_START.md)

---

## License

MIT — Use freely in commercial or open-source projects.

---

**Questions?** Open an issue on GitHub or see [INSTALLATION_STATUS.md](./INSTALLATION_STATUS.md) for detailed answers to common questions.
