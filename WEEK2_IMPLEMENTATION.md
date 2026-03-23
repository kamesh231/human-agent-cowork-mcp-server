# Week 2 Implementation: PolicyEngine, NotificationDispatcher, BulkDecision, AuditLinker

## Overview
Week 2 builds on the stable foundation (Week 1: auth + atomicity) with four parallel components that address the COWORK protocol's Feedback, Authority, and Observability categories.

---

## Component 1: PolicyEngine (Authority Category)

**File:** `src/policy.ts` (~200 lines)

**Solves:** The Authority primitive — "What agents can do and when."

### Design
- Domain-specific policy rules with configurable constraints
- Severity levels: "warning" (log + proceed) and "hard_stop" (reject)
- Constraint types: field_readonly, value_range, enum, regex, custom functions

### Integration
- Called in `cowork_propose` before trust check
- Hard-stop violations block proposals immediately
- Warning violations trigger notifications but allow proposal to proceed
- New tool: `cowork_validate_policy`

### Example Usage
```yaml
policies:
  - domain: "crm.deals"
    field: "commission"
    constraint:
      type: "field_readonly"
      roles: ["sales-manager"]
    severity: "hard_stop"
    reason: "Only sales managers can modify commission"
```

---

## Component 2: NotificationDispatcher (Feedback Category)

**File:** `src/notify.ts` (~280 lines)

**Solves:** Human awareness — timely alerts when human attention is needed.

### Design
- Event-driven notifications for:
  - Proposal needs review (mode: suggest)
  - Trust changes (promotion/demotion)
  - Handoff escalations
  - Policy violations
  - Bulk decisions ready
- User notification preferences (channels, event types, quiet hours, batching)
- Multiple dispatch channels: email, Slack, webhook, log, in-app

### Integration
- Triggered in `cowork_propose` when mode is "suggest"
- Triggered in `cowork_approve` and `cowork_override` on trust changes
- Triggered in PolicyEngine on violations
- Supports batch dispatch for low-priority events (5-minute window)

### Key Methods
- `notify()` - Dispatch notification respecting user preferences
- `onProposalCreated()` - Alert reviewers
- `onTrustChanged()` - Alert admins on trust shifts
- `onPolicyViolation()` - Alert compliance team
- `flushBatch()` - Send batched notifications

---

## Component 3: BulkDecisionEngine (Feedback Category)

**File:** `src/bulk-decision.ts` (~200 lines)

**Solves:** Approval scale — humans can't click "approve" 50 times for similar proposals.

### Design
- Query pending proposals by filter (agent_id, domain, confidence, trust_score)
- Batch approve/reject with single human decision
- Each proposal still gets individual audit record and trust impact
- Preview functionality: "show me what would be affected"

### Integration
- New tools:
  - `cowork_bulk_approve` - Approve multiple proposals at once
  - `cowork_bulk_reject` - Reject multiple proposals at once
  - `cowork_bulk_preview` - Preview affected proposals

### Example
```javascript
// Approve all proposals from agent "sales-bot" in "crm.deals" domain
// with confidence > 0.8 and trust_score < 0.6
bulk.batchApprove({
  filter: {
    agent_id: "sales-bot",
    domain: "crm.deals",
    min_confidence: 0.8,
    min_trust_score: 0.5,
  },
  feedback: "Consistent high-quality deal evaluations",
  session_id: SESSION_ID
})
```

---

## Component 4: AuditLinker (Observability Category)

**File:** `src/audit.ts` (~350 lines)

**Solves:** The audit gap — COWORK proposals and Sentry traces are separate audit trails.

### Design
- Unified audit record: propose → approve → execute → verify
- Detects governance issues:
  - Orphaned executions (tool calls without proposals)
  - Proposals never approved
  - Executions before approval
  - Missing intent strings
- Links Sentry traces to proposals via `proposal_id` metadata
- Returns enforcement mode based on trust score

### Integration
- Called in `cowork_propose` to record initial state
- Called in `cowork_approve` to record approval
- Called by Sentry proxy to link traces to proposals
- New tools:
  - `cowork_audit_trail` - Get full chain for a proposal
  - `cowork_governance_report` - Detect compliance gaps

### Key Methods
- `recordProposal()` - Create audit entry when proposal starts
- `recordApproval()` - Update when human approves
- `recordExecution()` - Link Sentry trace to proposal
- `verifyChain()` - Validate propose→approve→execute order
- `getOrphanedExecutions()` - Find tool calls without proposals
- `getGovernanceIssues()` - Generate compliance report
- `getEnforcementMode(trust)` - Return Sentry mode (strict/warn/permissive)

---

## Integration Points

### In `cowork_propose`
1. Validate against policies (PolicyEngine) — hard stops block proposal
2. Run trust check and determine mode (existing TrustEngine)
3. Record initial state in audit trail (AuditLinker)
4. Send notification if mode is "suggest" (NotificationDispatcher)
5. Log warnings if policies have non-blocking violations

### In `cowork_approve`
1. Update proposal in trust model (TrustEngine)
2. Record approval in audit trail (AuditLinker)
3. Send trust change notification (NotificationDispatcher)

### In `cowork_override`
1. Apply trust penalty (TrustEngine)
2. Send trust change notification (NotificationDispatcher)

### New Standalone Tools
- `cowork_validate_policy` - Check a proposed change against policies (pre-flight)
- `cowork_bulk_approve` - Batch approve multiple proposals
- `cowork_bulk_reject` - Batch reject multiple proposals
- `cowork_audit_trail` - Get full chain for a proposal
- `cowork_governance_report` - Compliance analysis

---

## COWORK Protocol Alignment

### Authority Category ✅
- **Primitive:** "What agents can do"
- **Implementation:** PolicyEngine validates proposals against domain rules before execution
- **Tool:** `cowork_validate_policy`

### Feedback Category ✅
- **Primitive:** "Approvals, overrides, quality scores"
- **Implementation:**
  - NotificationDispatcher alerts humans to proposals in "suggest" mode
  - BulkDecisionEngine enables scale on approvals
  - AuditLinker detects when feedback loop breaks (orphaned executions)
- **Tools:** `cowork_bulk_approve`, `cowork_bulk_reject`

### Observability Category ✅
- **Primitive:** "Attribution, timelines, accountability"
- **Implementation:**
  - AuditLinker creates unified trail: COWORK proposals + Sentry traces
  - Detects governance gaps (missing approvals, orphaned executions)
  - Links actual tool calls to their proposals
- **Tools:** `cowork_audit_trail`, `cowork_governance_report`

---

## File Structure Post-Week 2

```
src/
├── index.ts              (13 tools, 650+ lines)
├── auth.ts               (Week 1: AgentRegistry)
├── storage.ts            (Week 1: CoworkStore + transaction support)
├── config.ts             (Week 1 extended: AgentConfig)
├── trust.ts              (Week 1: TrustEngine)
├── policy.ts             (Week 2: PolicyEngine)
├── notify.ts             (Week 2: NotificationDispatcher)
├── bulk-decision.ts      (Week 2: BulkDecisionEngine)
└── audit.ts              (Week 2: AuditLinker)
```

---

## Compilation Status
✅ Zero TypeScript errors
✅ All new components compile cleanly
✅ Index.ts successfully integrates all four Week 2 systems

---

## Next Steps (Week 3)

Week 3 will add three parallel components:
1. **QueryEngine** — Complex filtering and search across proposals/trust/audit logs
2. **MetricsCache** — Performance metrics, throughput analysis, trust distribution
3. **StatusCleanup** — Garbage collection, archival, stale proposal handling

These will round out the Observability category and prepare for production deployment.
