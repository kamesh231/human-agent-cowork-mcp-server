# Week 3 Plan — COWORK MCP Server

> **Context:** This plan is grounded in three sources: the COWORK Protocol spec (18 primitives), live
> testing of the codebase (authentication, mode determination, proposal flow), and real-world failure
> cases from the protocol examples (CRM data integrity, support handoffs, cross-environment context
> loss). Every item below traces back to a specific failure mode.

---

## Where We Are: End of Week 2

### What's Working (Verified in Testing)
| Component | Test Result | Evidence |
|-----------|------------|---------|
| Authentication | ✅ Closed mode, 2 agents | Server starts: "Auth: closed mode (2 agents)" |
| Trust Scoring | ✅ 0.3 initial, per-domain | `trust_level: 0.3` in response |
| Mode: High-risk field | ✅ deal_stage → "suggest" | high_risk_field: true in response |
| Mode: Low trust | ✅ amount + 0.3 trust → "escalate" | Two-factor logic confirmed |
| Proposal Recording | ✅ UUID IDs, SQLite persisted | proposal_id, action_id unique per call |
| Policy Engine | ✅ High-risk detection works | high_risk_field flag correct |
| Bulk Operations | ✅ cowork_bulk_approve/reject | 5 week-2 tools present |
| Audit Trail | ✅ Hash chain, governance detection | AuditLinker, TraceStore complete |

### Current Implementation Score
- **Tools:** 13 of 13 registered
- **Protocol primitives:** 33 of 38 (87%)
- **Test coverage:** 0% (no automated test suite)
- **npm publish:** Not yet (waiting on critical gaps)

### The 5 Gaps Preventing npm Publish
| Gap | Impact | Effort |
|-----|--------|--------|
| No agent-to-policy mapping | Can't attribute which policy fired for which agent | 1 day |
| Volume cap not enforced at runtime | Configured but silent — CRM case study failure exactly | 3 hours |
| Trust decay not implemented | Configured but dormant — agents never lose unused trust | 4 hours |
| No test suite | Can't validate regressions, can't ship with confidence | 2 days |
| Handoff has no callback mechanism | One-way escalation — support handoff case study failure | 1 day |

---

## Week 3 Goal

**Make the system testable and verifiable end-to-end, closing the five gaps that prevent
confident npm publish.**

Specifically:
1. An agent should trigger a named, traceable policy
2. Tests should prove it happened
3. Volume cap and trust decay should be runtime-enforced, not just configured
4. A human can hand work back to an agent, completing the feedback loop

---

## Day-by-Day Plan

---

### Day 1 — Agent-to-Policy Mapping

**The Problem (from testing session):**
Right now there is one global policy (the `authority` section in `cowork.config.yaml`) and two
registered agents (`sales-agent`, `support-agent`). There is no way to answer: "Did sales-agent
trigger the deal_stage policy? Did support-agent trigger a different policy?" The server has no
mechanism to attribute a policy violation or constraint check to a specific agent's rule set.

**Design Decision — Why NOT embed policies under each agent:**

The initial design embedded rules inline under each agent:
```yaml
# ❌ Wrong — policies can't be shared this way
agents:
  - id: "sales-agent"
    policies:
      - rules: [...]      # duplicated under every agent that needs the same rules
  - id: "support-agent"
    policies:
      - rules: [...]      # same rules copied again
```

This breaks two real requirements:
1. **1 agent → 2 policies** (different domains): sales-agent in `crm.deals` and `support.tickets` need different rule sets. Embedding means the agent carries all rules for all domains.
2. **2 agents → 1 policy** (shared rules): Both sales-agent and support-agent may need the same `crm-write-policy` in `crm.deals`. Embedding means duplicating the rule list under both agents.

**Correct design — three sections, policies reusable by reference:**

```yaml
# ✅ Correct — define once, reference by ID

policies:
  - id: "crm-write-policy"
    description: "Standard write access for CRM fields"
    rules:
      - field: "deal_stage"
        constraint: "high_risk"
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

agents:                                    # identity only, no embedded rules
  - id: "sales-agent"
    token: "sk-cowork-..."
  - id: "support-agent"
    token: "sk-cowork-..."

mappings:                                  # explicit three-way join: who × where × which rules
  - agent_id: "sales-agent"
    domain: "crm.deals"
    policy_id: "crm-write-policy"

  - agent_id: "support-agent"
    domain: "support.tickets"
    policy_id: "support-write-policy"

  # 2 agents → 1 policy: both use crm-write-policy in crm.deals
  - agent_id: "support-agent"
    domain: "crm.deals"
    policy_id: "crm-write-policy"

  # 1 agent → 2 policies: sales-agent has different rules in support domain
  - agent_id: "sales-agent"
    domain: "support.tickets"
    policy_id: "support-write-policy"
```

**Blocking behavior:** If an agent proposes in a domain with no mapping entry, the proposal is
blocked and escalated to a human asking for permission. No silent fallback.

#### 1b. Config Type Changes (`src/config.ts`)

```typescript
// New top-level types
interface PolicyRule {
  field: string;
  constraint: "high_risk" | "readonly" | "value_range" | "enum" | "regex";
  reason?: string;
  min?: number;         // value_range
  max?: number;         // value_range
  values?: string[];    // enum
  pattern?: string;     // regex
}

interface PolicyConfig {
  id: string;
  description?: string;
  rules: PolicyRule[];
}

interface MappingConfig {
  agent_id: string;
  domain: string;
  policy_id: string;
}

interface CoworkConfig {
  trust: TrustConfig;
  authority: AuthorityConfig;
  handoff: HandoffConfig;
  feedback: FeedbackConfig;
  storage: StorageConfig;
  agents?: AgentConfig[];
  policies?: PolicyConfig[];    // ← NEW
  mappings?: MappingConfig[];   // ← NEW
  sentry?: SentryConfig;
}
```

#### 1c. PolicyEngine Changes (`src/policy.ts`)

```typescript
// New method: look up mapping for (agent_id, domain)
getMapping(agent_id: string, domain: string): MappingConfig | null {
  return config.mappings?.find(
    m => m.agent_id === agent_id && m.domain === domain
  ) ?? null;
}

// New method: get named policy for a mapping
getPolicy(policy_id: string): PolicyConfig | null {
  return config.policies?.find(p => p.id === policy_id) ?? null;
}

// Updated validate signature — now receives agent_id and domain
validate(agent_id: string, domain: string, field: string, value?: unknown): PolicyResult {
  const mapping = this.getMapping(agent_id, domain);

  if (!mapping) {
    // No mapping = blocked, escalate to human
    return {
      blocked: true,
      reason: `No policy mapping for agent '${agent_id}' in domain '${domain}'`,
      escalate_for_permission: true
    };
  }

  const policy = this.getPolicy(mapping.policy_id);
  // ... evaluate rules, return result with policy_id attached
}
```

#### 1d. Proposal Response — Add Policy Attribution

```json
{
  "proposal_id": "uuid",
  "mode": "suggest",
  "trust_level": 0.3,
  "high_risk_field": true,
  "policy_id": "crm-write-policy",       ← NEW: which policy was evaluated
  "policy_description": "Standard write access for CRM fields",  ← NEW
  "policy_rules_checked": 3,             ← NEW: how many rules were evaluated
  "policy_warnings": 0,
  "mapping_found": true,                 ← NEW: false = agent blocked, escalated
  "message": "..."
}
```

#### 1e. Tests: Verify Policy Attribution and Sharing

```javascript
// Test 1: sales-agent in crm.deals → triggers crm-write-policy
const r1 = await client.callTool("cowork_propose", {
  agent_id: "sales-agent", agent_token: SALES_TOKEN,
  domain: "crm.deals", field: "deal_stage", ...
});
assert(r1.policy_id === "crm-write-policy");
assert(r1.high_risk_field === true);

// Test 2: support-agent in crm.deals → SAME policy as sales-agent
const r2 = await client.callTool("cowork_propose", {
  agent_id: "support-agent", agent_token: SUPPORT_TOKEN,
  domain: "crm.deals", field: "amount",
  proposed_change: JSON.stringify({ amount: 999999 }), ...  // exceeds max
});
assert(r2.policy_id === "crm-write-policy");  // same policy, different agent
assert(r2.policy_warnings > 0);              // value_range violation

// Test 3: support-agent in support.tickets → triggers support-write-policy
const r3 = await client.callTool("cowork_propose", {
  agent_id: "support-agent", agent_token: SUPPORT_TOKEN,
  domain: "support.tickets", field: "priority",
  proposed_change: JSON.stringify({ priority: "nuclear" }), ...
});
assert(r3.policy_id === "support-write-policy");  // different policy
assert(r3.policy_warnings > 0);                   // enum violation

// Test 4: agent in unmapped domain → blocked + escalated
const r4 = await client.callTool("cowork_propose", {
  agent_id: "sales-agent", agent_token: SALES_TOKEN,
  domain: "billing.invoices", field: "amount", ...  // no mapping exists
});
assert(r4.blocked === true);
assert(r4.mapping_found === false);
assert(r4.mode === "escalate");
```

**Files to change:**
- `cowork.config.yaml` — add `policies:` and `mappings:` sections (done ✅)
- `src/config.ts` — add `PolicyConfig`, `MappingConfig`, extend `CoworkConfig`
- `src/policy.ts` — add `getMapping()`, `getPolicy()`, update `validate()` signature
- `src/index.ts` — pass `agent_id` + `domain` to `policy.validate()`, add policy fields to response

---

### Day 2 — Test Suite Foundation

**The Problem:**
Zero test coverage. The manual test we wrote (`test-cowork-propose.cjs`) works, but it only
tests one tool with one scenario. Every change to `trust.ts` or `policy.ts` could silently
break other tools. Cannot publish to npm with zero test coverage.

**What to build:**

#### 2a. Test Infrastructure

```bash
npm install --save-dev jest ts-jest @types/jest
```

`jest.config.js`:
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  setupFilesAfterFramework: ['./tests/setup.ts'],
};
```

`tests/setup.ts` — in-memory SQLite, reset between tests:
```typescript
// Use :memory: database, not file
process.env.COWORK_TEST_MODE = "true";
```

#### 2b. Unit Tests: TrustEngine

File: `tests/unit/trust.test.ts`

| Test | What it verifies |
|------|-----------------|
| `atomicPropose — initial trust 0.3` | New agent starts at 0.3, mode=escalate |
| `atomicPropose — high-risk field` | deal_stage forces mode=suggest at any trust |
| `atomicPropose — high trust` | trust 0.85 + regular field → mode=act |
| `atomicApprove — trust increases` | +0.02 on approval |
| `atomicApprove — resets consecutive_overrides` | Consecutive counter goes to 0 |
| `atomicOverride — trust decreases` | Scaled by severity |
| `atomicOverride — 3 consecutive → demotion` | auto_demote_after=3 works |
| `determineMode — thresholds` | 0.3→escalate, 0.6→suggest, 0.85→act |
| `isHighRisk — config matching` | deal_stage=true, amount=false, billing_amount=true (prefix) |

#### 2c. Unit Tests: PolicyEngine

File: `tests/unit/policy.test.ts`

| Test | What it verifies |
|------|-----------------|
| `validate — hard_stop blocks proposal` | readonly field blocks with error |
| `validate — warning passes with flag` | out-of-range continues with warning |
| `validate — enum rejects invalid value` | priority="nuclear" fails |
| `validate — regex constraint` | phone format check |
| `validate — prefix wildcard` | billing_amount matches `billing_*` rule |
| `getAgentPolicyId — sales-agent` | Returns crm-write-policy |
| `getAgentPolicyId — support-agent` | Returns support-write-policy |
| `getAgentPolicyId — unknown agent` | Returns global-default-policy |
| `agent-policy isolation` | sales-agent rules don't apply to support-agent |

#### 2d. Unit Tests: AuthRegistry

File: `tests/unit/auth.test.ts`

| Test | What it verifies |
|------|-----------------|
| `verify — valid token passes` | Correct token accepted |
| `verify — invalid token throws AuthError` | Wrong token rejected |
| `verify — open mode accepts any agent` | No token required in open mode |
| `verify — unknown agent in closed mode` | Agent not in registry rejected |
| `hashToken — SHA-256` | Hash is 64 hex chars |
| `generateToken — prefix` | Starts with "sk-cowork-" |

---

### Day 3 — Test Suite Coverage: Integration Tests

**What to build:**

#### 3a. Integration Tests: Full MCP Tool Flows

File: `tests/integration/tools.test.ts`

Uses the `MCPTestClient` class (refactored from `.cjs` to proper TypeScript).

**Critical paths:**

```
1. Propose → Approve → Mode Upgrade
   - Propose (trust=0.3) → mode=escalate
   - Approve 20 times at 80%+ accuracy
   - Propose again → mode=suggest or act (auto-promote triggered)

2. Propose → Override → Demotion
   - Build trust to 0.6
   - Override 3 consecutive times (severity=high)
   - Check trust decreased and mode regressed

3. Propose → Handoff → Resolve → Callback
   - Agent proposes, gets escalate
   - Agent calls cowork_handoff with context packet
   - Human resolves with instructions
   - Callback flag present in response

4. Policy Attribution
   - sales-agent in crm.deals → crm-write-policy in response
   - support-agent in support.tickets → support-write-policy in response
   - sales-agent hitting support.tickets → global policy (no match)

5. Volume Cap
   - Make 51 proposals in rapid succession
   - 51st proposal should be rejected with volume_cap_exceeded

6. Bulk Operations
   - Create 5 proposals
   - cowork_bulk_approve → all 5 approved, trust +0.10 total
   - Verify proposals are marked approved in DB
```

#### 3b. Integration Tests: Auth Scenarios

File: `tests/integration/auth.test.ts`

| Test | Expected |
|------|----------|
| Valid sales-agent token | Proposal created |
| Invalid token | `{ error: true, auth_error: true }` |
| support-agent token → wrong agent_id | Rejected |
| Unknown agent in closed mode | Rejected |
| Open mode (no agents config) | Any agent_id accepted |

---

### Day 4 — Volume Cap + Trust Decay

#### 4a. Volume Cap Enforcement

**The Problem (from CRM data integrity example):**
> The team built volume alerts after the damage had been compounding for 3 weeks. An agent that
> can modify one record should not automatically be able to modify 500 without a pause.

Currently: `volume_cap: 50` is in config but `cowork_propose` never checks it.

**What to build:**

Add volume tracking to `storage.ts`:
```typescript
// New query in CoworkStore
getProposalCountLastHour(agent_id: string, domain: string): number {
  return this.db.prepare(`
    SELECT COUNT(*) as count FROM proposals
    WHERE agent_id = ? AND domain = ?
    AND created_at > datetime('now', '-1 hour')
  `).get(agent_id, domain).count;
}
```

In `trust.ts atomicPropose()`:
```typescript
const hourlyCount = store.getProposalCountLastHour(agent_id, domain);
if (hourlyCount >= config.authority.volume_cap) {
  throw new VolumeCapError(
    `Volume cap exceeded: ${hourlyCount}/${config.authority.volume_cap} proposals in last hour`
  );
}
```

Add `volume_remaining` to proposal response:
```json
{
  "proposal_id": "uuid",
  "mode": "suggest",
  "volume_remaining": 42,    ← NEW: 50 - 8 = 42 proposals left this hour
  "volume_cap": 50,          ← NEW
  ...
}
```

**Test:**
```javascript
// Make 50 proposals
for (let i = 0; i < 50; i++) await client.callTool("cowork_propose", payload);
// 51st should fail
const result = await client.callTool("cowork_propose", payload);
assert(result.error === true);
assert(result.code === "VOLUME_CAP_EXCEEDED");
```

#### 4b. Trust Decay

**The Problem:**
Trust should reflect recent behavior, not just lifetime approval rate. An agent approved 50 times
6 months ago and inactive since should not start at 0.9 today. `decay_per_day: 0.01` is configured
but never applied.

**Implementation strategy — Decay on Read (not cron):**
When trust is read, compute how many days have passed since `last_updated` and apply decay:

```typescript
// In CoworkStore.getOrCreateTrust()
const trust = this.db.prepare('SELECT * FROM trust_scores WHERE ...').get(...);
if (trust && trust.last_updated) {
  const daysSince = (Date.now() - new Date(trust.last_updated).getTime()) / (1000 * 86400);
  const decayAmount = daysSince * config.trust.decay_per_day;
  if (decayAmount > 0.001) {  // only update if decay is significant
    const newScore = Math.max(0.1, trust.score - decayAmount);  // floor at 0.1
    this.db.prepare('UPDATE trust_scores SET score = ?, last_updated = ? WHERE ...')
      .run(newScore, new Date().toISOString(), agent_id, domain);
    trust.score = newScore;
  }
}
return trust;
```

**Add to `cowork_check_trust` response:**
```json
{
  "score": 0.76,
  "days_since_active": 14,
  "decay_applied": 0.14,      ← NEW: how much was decayed
  "score_before_decay": 0.90, ← NEW: what it was before decay
  ...
}
```

**Test:**
```typescript
// Manually set last_updated to 10 days ago in test DB
// Read trust → score should be 0.3 + (0.3) - (10 × 0.01) = 0.2
// Floor kicks in if score < 0.1
```

---

### Day 5 — Handoff Callback + Publish Prep

#### 5a. Handoff Callback Mechanism

**The Problem (from support handoff example):**
> When human agents resolved escalated tickets, Fin didn't learn from the resolution. The same
> types of queries continued being escalated at the same rate.

Currently: `cowork_resolve_handoff` marks a handoff as resolved and optionally sets instructions.
But there is no mechanism for the agent to *receive* those instructions and continue work.

**What to build:**

Add `cowork_check_handoff` tool — agent polls for resolved handoffs with instructions:
```typescript
// Input: agent_id, agent_token, domain (optional)
// Output: resolved handoffs with instructions
{
  "pending_instructions": [
    {
      "handoff_id": "uuid",
      "resolved_at": "2026-03-23T14:30:00Z",
      "resolution": "Customer confirmed issue resolved. Close the ticket.",
      "instructions": "Use update_ticket with status=closed and add resolution note.",
      "hand_back": true
    }
  ],
  "count": 1
}
```

This closes the loop:
```
Agent → cowork_handoff (escalate) → handoff_id
Human → cowork_resolve_handoff (with instructions, hand_back=true)
Agent → cowork_check_handoff → gets instructions → continues work
Agent → cowork_propose (new proposal based on instructions)
```

**Files to change:**
- `src/storage.ts` — add `getPendingCallbacks(agent_id, domain)` query
- `src/index.ts` — register `cowork_check_handoff` tool (14th tool)

#### 5b. npm Publish Prep Checklist

Run through before `npm publish`:

```bash
# 1. All tests pass
npm test

# 2. Build succeeds
npm run build

# 3. No secrets in build output
grep -r "sk-cowork-" build/

# 4. package.json has correct exports
#    - "main": "build/index.js"
#    - "bin": { "cowork-mcp": "build/index.js" }
#    - "files": ["build/", "cowork.config.yaml", "README.md"]

# 5. README install section verified against actual published package name
npm pack --dry-run

# 6. Version bump
npm version patch   # 0.1.0 → 0.1.1

# 7. Tag and publish
git tag v0.1.1
npm publish --access public
```

#### 5c. CHANGELOG.md

Create `CHANGELOG.md` with:
- v0.1.0 — Week 1 & 2 baseline (13 tools, 33/38 primitives)
- v0.1.1 — Week 3 (agent-policy mapping, test suite, volume cap, trust decay, handoff callbacks)

---

## What Week 3 Unlocks in the Protocol

| Protocol Gap Before Week 3 | After Week 3 |
|---------------------------|--------------|
| One global policy — can't attribute which agent triggered which rule | Per-agent named policies, policy_id in every proposal response |
| Volume cap configured but ignored | Runtime enforcement, volume_remaining in response |
| Trust decay configured but dormant | Applied on read, decay_applied in check_trust response |
| Handoff is one-way (escalate only) | Full loop: escalate → resolve with instructions → agent resumes |
| 0% test coverage | ~80% coverage: 30+ unit tests + 10 integration flows |

### Updated Protocol Alignment After Week 3

| Category | Before | After | Delta |
|----------|--------|-------|-------|
| Trust | 4/5 (decay missing) | 5/5 | +1 |
| Authority | 6/6 ✅ (volume cap not enforced) | 6/6 ✅ (enforced) | runtime only |
| Handoff | 5/7 (no callback) | 6/7 | +1 |
| Feedback | 6/8 | 6/8 | 0 (quality metrics deferred) |
| Communication | 4/5 | 5/5 (policy attribution = structured reasoning) | +1 |
| Observability | 8/8 ✅ | 8/8 ✅ | 0 |
| **Total** | **33/38 (87%)** | **36/38 (95%)** | **+3** |

---

## What This Week Does NOT Cover

Intentionally deferred to v0.2.0:

| Item | Why Deferred |
|------|-------------|
| Per-proposal quality score | Requires UI to make useful; deferred |
| Bulk decision schema denormalization | Low impact until bulk ops are heavily used |
| Structured reasoning schema (JSON vs free-form string) | Needs protocol spec alignment first |
| Multi-tenant workspace isolation | Out of scope for v0.1.x |
| npm package scope change | @cowork/mcp-server registration pending |

---

## File Deliverables for Week 3

| File | Action | What Changes |
|------|--------|-------------|
| `cowork.config.yaml` | ✅ Done | `policies:` + `mappings:` sections added. Three-way join design. |
| `src/config.ts` | Modify | Add `PolicyConfig`, `MappingConfig` types; extend `CoworkConfig` |
| `src/policy.ts` | Modify | Add `getMapping()`, `getPolicy()`, update `validate()` to take `agent_id`+`domain` |
| `src/storage.ts` | Modify | Add `getProposalCountLastHour()`, decay logic in `getOrCreateTrust()` |
| `src/trust.ts` | Modify | Volume cap check in `atomicPropose()` |
| `src/index.ts` | Modify | Policy attribution in response, register `cowork_check_handoff` |
| `tests/setup.ts` | Create | In-memory SQLite, env config for test mode |
| `tests/unit/trust.test.ts` | Create | 9 TrustEngine unit tests |
| `tests/unit/policy.test.ts` | Create | 9 PolicyEngine unit tests including agent-policy mapping |
| `tests/unit/auth.test.ts` | Create | 6 AuthRegistry unit tests |
| `tests/integration/tools.test.ts` | Create | 6 end-to-end tool flow tests |
| `tests/integration/auth.test.ts` | Create | 5 auth scenario tests |
| `jest.config.js` | Create | Jest + ts-jest configuration |
| `CHANGELOG.md` | Create | v0.1.0 and v0.1.1 entries |
| `README.md` | Update | Week 3 status, agent-policy config docs, install instructions |

---

## Effort Estimate

| Day | Task | Hours |
|-----|------|-------|
| Day 1 | Agent-to-policy mapping (config, engine, response, test) | 6-8h |
| Day 2 | Test suite foundation (infra, unit tests) | 6-8h |
| Day 3 | Integration tests (6 flows + auth) | 5-6h |
| Day 4 | Volume cap enforcement + trust decay | 4-5h |
| Day 5 | Handoff callback + npm prep + CHANGELOG | 4-5h |
| **Total** | | **25-32h** |

---

## Why This Order

1. **Agent-to-policy mapping first** — it's the answer to the question "how do we test that an
   agent triggered the right policy." Everything else is easier to test once policy attribution
   exists in the response.

2. **Test suite second** — once policy IDs are in responses, tests can make specific assertions.
   Tests written before Day 1 would need to be rewritten after Day 1 changes.

3. **Volume cap and decay third** — self-contained, no cross-file dependencies. Can be done in
   parallel on Day 4 if time allows.

4. **Handoff callback last** — adds a 14th tool, which changes the tool list. Better to finalize
   the tool set after all other changes are tested.

---

## Connection to Real-World Cases

| Week 3 Feature | CRM Case | Support Case | Cross-Env Case |
|----------------|----------|--------------|----------------|
| Agent-policy mapping | ✅ Field restrictions per agent | ✅ Per-agent topic confidence | — |
| Volume cap enforcement | ✅ Volume alerts after damage | — | — |
| Trust decay | ✅ Agents shouldn't hold trust forever | ✅ Topic confidence drift | — |
| Handoff callbacks | — | ✅ Human resolution feeds back to agent | ✅ Hand-back with instructions |
| Test suite | ✅ Verify constraints fire | ✅ Verify escalation triggers | ✅ Verify context packets |

The Week 3 features are not theoretical additions. They are direct implementations of
patterns that teams built as workarounds in the CRM and support case studies. Week 3
formalizes the workarounds into first-class primitives.
