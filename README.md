# @cowork/mcp-server

### Human-Agent Collaboration Primitives as an MCP Server

> Add trust, handoffs, and accountability to any AI agent. Production-ready implementation of the [COWORK Protocol](https://github.com/kamesh231/cowork-protocol).

---

## Status

**v0.1.1 — Weeks 1, 2 & 3 Complete ✅ | Ready for npm Publish**

| Component | Status | Verified |
|-----------|--------|---------|
| 14 MCP tools | ✅ All registered | cowork_check_handoff added (14th tool) |
| Authentication | ✅ Open + closed mode | sales-agent token validated, closed mode enforced |
| Trust scoring | ✅ Per (agent, domain) | 0.3 initial, escalate/suggest/act working, auto-promote at 0.8 |
| Mode determination | ✅ Two-factor logic | High-risk field + trust level, policy-aware |
| Policy engine | ✅ Constraints + attribution | 5 constraint types, policy_id in response, wildcard matching |
| Agent-to-policy mapping | ✅ Three-way join | Explicit mappings: (agent, domain, policy_id) |
| Bulk operations | ✅ Approve/reject N | cowork_bulk_approve, cowork_bulk_reject fully functional |
| Audit trail | ✅ SHA-256 hash chain | Sentry proxy, proposal → execution trace linking |
| Volume cap enforcement | ✅ Per (agent, domain) | 50 proposals/hour, checked at propose time, volume_remaining in response |
| Trust decay | ✅ Lazy evaluation | 1% per day decay applied on-read, configurable decay_per_day |
| Handoff callbacks | ✅ Full round-trip | Agent escalates → human resolves → agent polls cowork_check_handoff → continues |
| Automated test suite | ✅ 49 tests passing | Jest: 10 trust, 17 policy, 10 auth, 12 integration tests |
| Policy attribution | ✅ Per-proposal | Response includes policy_id, policy_description, rules_checked, mapping_found |
| **npm publish** | ✅ Ready | All 95% of protocol implemented (36/38 primitives) |

**Install from source:** `npm install && npm run build && npm run start`
**npm registry:** Coming within 1 week after quality testing

---

## What This Does

**14 MCP Tools** that add collaboration primitives to any AI agent:

| Tool | Primitive | What it does |
|------|-----------|-------------|
| `cowork_propose` | Intent Declaration | Agent proposes before acting. Trust score + field type determine: act / suggest / escalate |
| `cowork_approve` | Approval Signal | Human approves proposal. Trust +0.02, closes positive feedback loop |
| `cowork_override` | Override Signal | Human corrects agent. Trust degrades. 5 categories × 4 severity levels |
| `cowork_check_trust` | Trust Score | Trust level + accuracy + operating mode for any (agent, domain) |
| `cowork_handoff` | Context Packet | Escalate to human with structured context: reason, confidence, attempted actions |
| `cowork_check_handoff` | Handoff Callback | Agent polls for resolved handoffs with instructions. Enables agent continuation after human escalation |
| `cowork_log` | Action Attribution | Log action with actor (agent / human / collaborative) |
| `cowork_validate_policy` | Action Scope | Pre-flight policy check. Field constraints + policy attribution. Hard-stop vs warning |
| `cowork_bulk_approve` | Batch Approval | Approve 50+ proposals in one human decision |
| `cowork_bulk_reject` | Batch Override | Reject multiple proposals with a single reason |
| `cowork_resolve_handoff` | Handoff Resolution | Human resolves escalation. Optionally hands work back with instructions |
| `cowork_audit_trail` | Action Attribution | Full chain: propose → approve → execute → verify |
| `cowork_governance_report` | Intervention Map | Detect orphaned executions, slow decisions, missing approvals |
| `cowork_status` | Dashboard | Trust scores, override rates, pending proposals, timeline |

---

## Installation

### Option 1: Local Development (Works Now) ✅

```bash
git clone https://github.com/kamesh231/human-agent-cowork-mcp-server.git
cd human-agent-cowork-mcp-server
npm install
npm run build
npm run start
```

**Expected output:**
```
🤝 COWORK MCP Server v0.1.0 started
   Auth: open mode (demo) | Mode: suggest | Trust default: 0.3
```

#### Claude Desktop

Edit `~/.config/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "cowork": {
      "command": "node",
      "args": ["/full/path/to/human-agent-cowork-mcp-server/build/index.js"]
    }
  }
}
```

Restart Claude Desktop → cowork tools appear.

#### Claude Code

```bash
claude mcp add cowork node "$(pwd)/build/index.js"
```

### Option 2: Global npm (Coming After Week 3) ⏳

```bash
# Not yet available. Will work after npm publish:
npm install -g @cowork/mcp-server
```

---

## How to Implement

### Step 1 — Demo Mode (No Auth)

By default the server runs in **open mode** — any `agent_id` is accepted, no token needed.

```bash
npm run start
# Auth: open mode (demo) | Mode: suggest | Trust default: 0.3
```

All 13 tools immediately available. Good for prototyping.

### Step 2 — Register Your Agents (Closed Auth)

Generate tokens and add them to `cowork.config.yaml`:

```bash
# Generate token + hash for each agent
node -e "
const {generateToken, hashToken} = require('./build/auth.js');
const t = generateToken();
console.log('token:', t);
console.log('hash:', hashToken(t));
"
```

```yaml
# cowork.config.yaml
agents:
  - id: "sales-agent"
    token: "sk-cowork-abc123..."     # Dev: plaintext in config
  - id: "support-agent"
    token: "sk-cowork-xyz789..."
```

Server output changes to: `Auth: closed mode (2 agents)`

> **Production mode:** Use `token_hash` instead of `token` and load plaintext tokens via `.env`

### Step 3 — Map Each Agent to Its Policies

> ⏳ **Week 3 feature — available soon.** Currently all agents share the global policy.

**The problem it solves:** With one global policy and multiple agents, you cannot answer "which
policy fired for which agent?" You can't verify that `sales-agent` is constrained by CRM rules
while `support-agent` gets support rules — or test that both share a policy in the same domain.

**Three-section design** (policies defined once, referenced by ID in mappings):

```yaml
# Section 1 — Named rule sets. Define once, share across many agents.
policies:
  - id: "crm-write-policy"
    description: "Standard write access for CRM fields"
    rules:
      - field: "deal_stage"
        constraint: "high_risk"        # always requires human review
      - field: "amount"
        constraint: "value_range"
        min: 0
        max: 500000
      - field: "commission"
        constraint: "readonly"
        reason: "Finance team only"

  - id: "support-write-policy"
    description: "Write access for support ticket fields"
    rules:
      - field: "priority"
        constraint: "enum"
        values: ["low", "medium", "high", "critical"]
      - field: "billing_*"
        constraint: "readonly"
        reason: "Billing fields require finance approval"

# Section 2 — Agent identity only. No rules embedded here.
agents:
  - id: "sales-agent"
    token: "sk-cowork-..."
  - id: "support-agent"
    token: "sk-cowork-..."

# Section 3 — Explicit three-way join: who × where × which rules
mappings:
  - agent_id: "sales-agent"
    domain: "crm.deals"
    policy_id: "crm-write-policy"

  - agent_id: "support-agent"
    domain: "support.tickets"
    policy_id: "support-write-policy"

  # 2 agents → 1 policy: support-agent uses same CRM rules as sales-agent
  - agent_id: "support-agent"
    domain: "crm.deals"
    policy_id: "crm-write-policy"

  # 1 agent → 2 policies: sales-agent has support rules when working tickets
  - agent_id: "sales-agent"
    domain: "support.tickets"
    policy_id: "support-write-policy"
```

**Blocking behavior:** If an agent proposes in a domain with no `mappings` entry, the proposal
is blocked and escalated to a human asking for permission. No silent fallback.

**Proposal response will include which policy fired:**
```json
{
  "proposal_id": "uuid",
  "mode": "suggest",
  "trust_level": 0.3,
  "high_risk_field": true,
  "policy_id": "crm-write-policy",
  "policy_description": "Standard write access for CRM fields",
  "policy_rules_checked": 3,
  "mapping_found": true
}
```

This makes policy attribution **testable**: `assert(response.policy_id === "crm-write-policy")`
is unambiguous regardless of which agent made the proposal.

**Why not RBAC?** The structure looks similar (user → role → permission) but the semantics
differ: policies here are dynamic — the same policy produces `escalate`, `suggest`, or `act`
based on the agent's earned trust score. RBAC is binary (allowed/denied). COWORK is gradient
(how much autonomy, right now, given this agent's track record). See [WEEK3_PLAN.md](./WEEK3_PLAN.md)
for the full design rationale.

### Step 4 — Configure Trust & Authority (Global Defaults)

```yaml
# cowork.config.yaml

trust:
  default_level: 0.3              # All agents start supervised
  auto_promote_after: 20          # Promote after 20 approvals
  auto_promote_threshold: 0.8     # At 80%+ approval rate
  auto_demote_after: 3            # 3 consecutive overrides → demotion
  decay_per_day: 0.01             # Trust decays 1%/day without activity (⏳ Week 3)

authority:
  default_mode: "suggest"
  volume_cap: 50                  # Max proposals/hour per agent (⏳ enforced in Week 3)
  high_risk_fields:               # Global: always require human review
    - "deal_stage"
    - "owner"
    - "commission"
    - "utm_*"
    - "billing_*"
    - "password"
    - "permissions"
```

### Step 5 — Wire Into Your Agent

```javascript
// Agent proposes before acting
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

// Handle the three operating modes
if (proposal.mode === "act") {
  // Trust ≥ 0.8, proceed autonomously
  await db.update("deals", "deal_12345", { deal_stage: "closed_won" });

} else if (proposal.mode === "suggest") {
  // Trust 0.5–0.8, or field is high-risk — wait for human review
  // deal_stage is in high_risk_fields, so always lands here
  notify.send(`📋 Awaiting review: ${proposal.proposal_id}`);

} else {
  // Trust < 0.5, escalate to human
  await cowork_handoff({
    agent_id: "sales-agent",
    agent_token: "sk-cowork-...",
    domain: "crm.deals",
    reason: "Trust too low to proceed",
    confidence: proposal.confidence,
    attempted_actions: JSON.stringify(["cowork_propose returned escalate"]),
    context: JSON.stringify({ proposal_id: proposal.proposal_id }),
    handoff_mode: "escalate"
  });
}
```

### Step 6 — Integrate Human Feedback

```javascript
// Approve — closes the positive feedback loop
await cowork_approve({
  proposal_id: "uuid",
  agent_id: "sales-agent",
  domain: "crm.deals",
  feedback: "Looks good — legal confirmed"
});
// Effect: trust +0.02, proposal marked approved

// Correct — closes the negative feedback loop
await cowork_override({
  agent_id: "sales-agent",
  domain: "crm.deals",
  action_description: "Deal closure was premature",
  override_type: "agent_wrong",
  severity: "high",
  description: "Contract still being negotiated"
});
// Effect: trust -0.12 (0.08 × 1.5 severity), consecutive_overrides +1
```

---

## How Mode Is Determined

`cowork_propose` uses **two-factor logic** to set the operating mode:

### Factor 1: High-Risk Field Check

If the field being modified is in `high_risk_fields` (or per-agent policy rules after Week 3):
```
deal_stage, owner, commission, utm_*, billing_*, password, permissions
→ Mode = "suggest" regardless of trust level
```

### Factor 2: Trust-Based Check (for non-high-risk fields)

```
trust < 0.5   → mode = "escalate"   (human must handle it)
0.5 ≤ trust < 0.8 → mode = "suggest"    (propose and wait for approval)
trust ≥ 0.8   → mode = "act"        (proceed autonomously)
```

### Verified Response Structure

Tested and confirmed from live test run:

```json
{
  "proposal_id": "9f8710ef-c245-4c19-9ff1-810ac300c185",
  "action_id": "e5c3a1d2-4f6b-11ec-81d3-0242ac130003",
  "mode": "escalate",
  "trust_level": 0.3,
  "confidence": 0.85,
  "high_risk_field": false,
  "policy_warnings": 0,
  "message": "🚨 ESCALATED: Trust (0.30) too low. Proposal 9f8710ef..."
}
```

Key field names: `trust_level` (not `trust.score`), `high_risk_field` (boolean).

---

## Domain & Agent Mapping

### Agents Are Explicitly Registered

```yaml
agents:
  - id: "sales-agent"
    token: "sk-cowork-abc..."
  - id: "support-agent"
    token: "sk-cowork-xyz..."
```

Every tool call must include matching `agent_id` + `agent_token`. Server rejects unknown agents in closed mode.

### Domains Are Agent-Chosen (Organic)

Domains are **not pre-registered** — agents name them at proposal time. Any string works:

```javascript
// Domains are just strings agents choose
domain: "crm.deals"          // sales agent's scope
domain: "support.tickets"    // support agent's scope
domain: "docs.api-ref"       // documentation agent's scope
```

**Trust is tracked per (agent_id, domain) pair:**
```
sales-agent : crm.deals         → trust 0.85 → mode: act
sales-agent : crm.contacts      → trust 0.40 → mode: suggest
sales-agent : support.tickets   → trust 0.30 → mode: escalate
support-agent : support.tickets → trust 0.72 → mode: suggest
```

Same agent can be trusted in one domain but not another.

---

## Override Categories & Severity

When a human corrects an agent, they categorize *why*:

| Category | Base Impact | When to Use |
|----------|-------------|-------------|
| `agent_wrong` | −0.08 | Factual or logical error |
| `missing_context` | −0.03 | Should have escalated, didn't have info |
| `edge_case` | −0.02 | Unusual situation, hard to anticipate |
| `human_preference` | −0.01 | Agent was correct, human prefers different approach |
| `policy_change` | 0.00 | Rules changed — not the agent's fault |

**Severity multiplier** scales the base impact:

| Severity | Multiplier | Example |
|----------|-----------|---------|
| `low` | 0.5× | Minor wording preference |
| `medium` | 1.0× | Standard correction |
| `high` | 1.5× | Serious error with real consequences |
| `critical` | 2.5× | Breach of policy or major failure |

Example: `agent_wrong` + `high` severity = −0.08 × 1.5 = **−0.12 trust**

---

## Volume Cap Enforcement

Agents are rate-limited to prevent runaway behavior. The limit is **per (agent, domain) pair**:

```yaml
# cowork.config.yaml
authority:
  volume_cap: 50  # Max proposals per hour
```

**Enforcement:** Every `cowork_propose` call checks the proposal count in the last 60 minutes for that (agent_id, domain). If the agent would exceed the cap with this proposal, the proposal is rejected with `VolumeCapError`.

**Response includes feedback:**
```json
{
  "volume_cap": 50,
  "volume_remaining": 12,
  "proposal_id": "uuid",
  "mode": "suggest"
}
```

This allows agents to monitor their own rate and back off voluntarily.

---

## Trust Decay

Agents lose trust gradually when inactive. This prevents "earn trust once, coast forever."

```yaml
# cowork.config.yaml
trust:
  decay_per_day: 0.01  # 1% per day
```

**How it works:**
- Decay is applied lazily on-read (no background job needed)
- Each time `cowork_check_trust` or `cowork_propose` runs, the trust score is recalculated
- Formula: `new_score = current_score - (days_since_last_activity × decay_per_day)`
- Minimum trust: 0.1 (never decays below this)

**Example:** If an agent at 0.8 trust stops proposing for 10 days:
```
0.8 - (10 × 0.01) = 0.8 - 0.1 = 0.7  (now in "suggest" mode instead of "act")
```

Reset decay by proposing again, or be approved. Each approval and proposal activity timestamp resets the decay clock.

---

## Handoff Callback Loop

When agents escalate via `cowork_handoff`, they don't just disappear. Humans can hand the work back with instructions, and the agent polls for those instructions.

### Agent Flow

```javascript
// Step 1: Agent escalates
const handoff = await cowork_handoff({
  agent_id: "sales-agent",
  domain: "crm.deals",
  reason: "Trust too low to modify deal_stage",
  confidence: 0.85,
  attempted_actions: JSON.stringify(["check budget", "verify stakeholders"]),
  context: JSON.stringify({ deal_id: "12345", issue: "..." })
});

// Agent receives handoff_id and waits
const handoff_id = handoff.handoff_id;

// Step 2: Human resolves with instructions (happens in UI or via cowork_resolve_handoff)
// Human chooses: approve and/or hand back with instructions
// Example: "You can proceed, but only if both stakeholders have confirmed in writing"

// Step 3: Agent polls for the resolution and instructions
const callback = await cowork_check_handoff({
  agent_id: "sales-agent",
  domain: "crm.deals"  // optional — omit to check all domains
});

if (callback.pending_handoffs.length > 0) {
  const handoff = callback.pending_handoffs[0];
  if (handoff.hand_back === true) {
    // Human handed work back with instructions
    console.log("Instructions:", handoff.instructions);
    // "Check for written stakeholder confirmation before proceeding"

    // Verify constraint and try again
    if (stakeholders_confirmed) {
      await cowork_propose({ /* same proposal */ });
    }
  }
}
```

### Human Flow

```javascript
// Human sees escalated work in dashboard
const status = await cowork_status({ agent_id: "sales-agent" });
// Shows pending handoffs with agent's reasoning and context

// Human resolves with instructions
await cowork_resolve_handoff({
  handoff_id: "uuid",
  resolution: "approved",
  hand_back: true,  // Agent can continue
  instructions: "Proceed only if both stakeholders have written confirmation in the deal notes"
});

// Agent's next cowork_check_handoff call returns this instruction
// Agent can now take informed action or ask clarifying questions
```

---

## Real-World Cases This Protocol Addresses

### CRM Data Integrity (HubSpot Case)

The CRM case study describes an agent with full write access that silently corrupted data for
3 weeks. Root cause: no field restrictions, no volume caps, no approval flow.

**What COWORK provides:**
- `high_risk_fields` blocks direct writes to deal_stage, commission, utm_*
- `volume_cap` pauses agent at 50 proposals/hour (enforced in Week 3)
- `cowork_propose` creates a staging layer before any write
- `cowork_override` with categorized reason creates a feedback loop

### Support Handoff Failures (Intercom Case)

50% of conversations required human handoff. Context was lost at every handoff — humans
re-read full transcripts and customers repeated themselves.

**What COWORK provides:**
- `cowork_handoff` carries structured context: reason, confidence, attempted_actions
- Per-domain trust (`support.tickets` separate from `billing.issues`)
- `cowork_resolve_handoff` lets human hand work back with instructions (callback in Week 3)

### Cross-Environment Context Loss

Two agents (Claude Desktop + Claude Code) sharing a filesystem but not sharing decision state.
The em-dash incident: Claude Desktop approved 80 replacements without knowing *why* they were made.

**What COWORK provides:**
- `cowork_handoff` context packet carries *decision state*, not just output state
- `cowork_log` with `actor: "agent"` attributes which environment made the change
- Timeline events allow reconstruction of cross-environment sequence

---

## Testing

### Automated Test Suite (Jest) ✅

```bash
npm test
```

**49 tests, 4 categories, all passing:**

#### Trust & Mode Determination (10 tests)
- Initial trust defaults to 0.3 → mode=escalate
- High-risk field (deal_stage) → mode=suggest regardless of trust
- Trust 0.85 → mode=act (autonomous)
- Approval increases trust +0.02
- Override with severity multiplier (high: 1.5×) decreases trust correctly
- 3 consecutive overrides triggers demotion
- Trust decay applied correctly (1% per day)
- Auto-promotion at 80% approval rate after 20 approvals

#### Policy Mapping & Attribution (17 tests)
- 2 agents + 1 policy: sales-agent & support-agent both use crm-write-policy
- 1 agent + 2 policies: sales-agent uses crm-write-policy in crm.deals AND support-write-policy in support.tickets
- Unmapped domain returns mapping_found=false (escalates gracefully)
- Policy constraints evaluated: high_risk, readonly, value_range, enum, regex
- Wildcard matching works (billing_* matches billing_amount, billing_status)
- Policy attribution in response: policy_id, policy_description, rules_checked

#### Authentication (10 tests)
- sales-agent token validates against config
- Invalid token throws AuthError
- Open mode accepts any agent_id
- Closed mode rejects unknown agents
- Token generation and hashing work correctly

#### Integration (12 tests)
- Full cowork_propose flow with auth + policy resolution
- Volume cap enforcement (50/hour) with volume_remaining feedback
- High-risk field detection + policy rules checked count
- Handoff callback loop: escalate → resolve → agent polls → continues
- Mode determination respects both high-risk check AND trust-based check

### Coverage

```bash
npm test -- --coverage
```

Generates coverage report for all 14 tools. Current coverage: 92% of core paths.

### MCP Inspector (Interactive)

```bash
npm run inspect
```

Opens browser-based tool to call any of the 14 tools manually, see live responses, inspect database state.

---

## Architecture

| File | Purpose |
|------|---------|
| `src/index.ts` | 14 MCP tool handlers, auth middleware, proposal → response pipeline |
| `src/trust.ts` | Atomic trust mutations via SQLite transactions, decay calculation |
| `src/storage.ts` | SQLite schema: 7 tables (proposals, trust_scores, actions, overrides, handoffs, timeline, audit_log), all queries, migration support |
| `src/auth.ts` | Token generation, verification, open/closed mode switching |
| `src/policy.ts` | Policy engine: 3-way mapping resolution, 5 constraint types, wildcard matching, high-risk field detection |
| `src/config.ts` | Config schema: policies (named rule sets), agents (identity), mappings (explicit joins), trust defaults, authority rules |
| `src/audit.ts` | Audit chain, governance issue detection, proposal→execution linking |
| `src/bulk-decision.ts` | Batch approve/reject operations with atomic updates |
| `src/notify.ts` | Multi-channel notifications framework (placeholder for email/Slack/webhook) |
| `src/sentry/` | Audit proxy — intercepts tool calls, intent validation, hash-chain logging |
| `tests/unit/` | 37 unit tests: trust (10), policy (17), auth (10) |
| `tests/integration/` | 12 integration tests: full MCP flows with auth + policy resolution |

**Production characteristics:**
- ✅ All trust mutations in `BEGIN EXCLUSIVE` SQLite transactions (no TOCTOU races)
- ✅ Full TypeScript with Zod input validation on all 14 tools
- ✅ Explicit policy mapping (3-way join) with attribution in response
- ✅ Open mode for prototyping, closed mode for production
- ✅ SHA-256 hash chain in Sentry traces (tamper-evident)
- ✅ Volume cap enforcement at propose time with feedback
- ✅ Trust decay applied lazily on-read (no background job)

---

## Protocol Alignment

| Category | Primitives | Implemented | Status |
|----------|-----------|-------------|--------|
| Trust | Score, Threshold, Evidence, Decay, Auto-Promote | 5/5 | ✅ Complete |
| Authority | Action Scope, Volume Cap, High-Risk Fields | 3/3 | ✅ Complete |
| Handoff | Context Packet, Escalation Trigger, Callbacks | 3/3 | ✅ Complete (Week 3) |
| Feedback | Override Signal, Approval Signal, Bulk | 3/3 | ✅ Complete |
| Communication | Confidence, Reasoning, Intent Declaration | 3/3 | ✅ Complete |
| Observability | Attribution, Timeline, Governance | 3/3 | ✅ Complete |
| Policy | Validation, Attribution, Constraint Evaluation | 3/3 | ✅ Complete (Week 3) |
| **Deferred to v0.2.0** | Quality Metrics, Structured Reasoning Schema | 2/2 | ⏳ Future |
| **Total** | **36 core + 2 advanced** | **36/38 (95%)** | ✅ Week 3 Complete |

Full detail: [PROTOCOL_ALIGNMENT.md](./PROTOCOL_ALIGNMENT.md)

---

## Week 3 Implementation ✅

| Day | Feature | Status | Impact |
|-----|---------|--------|--------|
| 1 | Agent-to-policy mapping (3-way join) | ✅ Complete | Policies now explicitly named, reusable, attributable in response |
| 2–3 | Automated test suite (Jest, 49 tests) | ✅ Complete | Full coverage: trust, policy, auth, integration flows |
| 4 | Volume cap enforcement (50/hour) + trust decay (1%/day) | ✅ Complete | Both checked at runtime, lazy evaluation for decay |
| 5 | Handoff callbacks (cowork_check_handoff) | ✅ Complete | Agent can poll for human instructions, enables continuation after escalation |

**Detailed plan & implementation notes:** [WEEK3_PLAN.md](./WEEK3_PLAN.md)

**What's ready:**
- ✅ 14 tools fully functional
- ✅ 36/38 COWORK protocol primitives implemented (95%)
- ✅ Production-ready: SQLite transactions, atomic trust mutations, Zod validation
- ✅ 49 automated tests all passing
- ✅ Policy attribution testable (policy_id in response)
- ✅ Volume cap feedback in response (volume_remaining field)
- ✅ Handoff callback loop fully operational

**What's deferred to v0.2.0:**
- Quality metrics collection (primitive #37)
- Structured reasoning schema (primitive #38)

---

## Storage

- **Default**: SQLite at `./cowork.db`
- **Tables**: proposals, trust_scores, actions, overrides, handoffs, timeline, audit_log
- **Access**: `sqlite3 cowork.db` or use `cowork_status` and `cowork_audit_trail` tools
- **Sentry traces**: Separate DB at `./cowork-traces.db` with hash chain

---

## Links

- **COWORK Protocol Spec**: https://github.com/kamesh231/cowork-protocol
- **This Repo**: https://github.com/kamesh231/human-agent-cowork-mcp-server
- **Week 3 Plan**: [WEEK3_PLAN.md](./WEEK3_PLAN.md)
- **Protocol Alignment**: [PROTOCOL_ALIGNMENT.md](./PROTOCOL_ALIGNMENT.md)

---

## License

MIT — Use freely in commercial or open-source projects.
