import { CoworkStore } from "../../src/storage.js";
import { PolicyEngine } from "../../src/policy.js";
import type { CoworkConfig } from "../../src/config.js";

const testConfig: CoworkConfig = {
  trust: {
    default_level: 0.3,
    auto_promote_after: 20,
    auto_promote_accuracy: 0.8,
    auto_demote_after: 3,
    decay_per_day: 0.01,
    autonomous_threshold: 0.7,
  },
  authority: {
    default_mode: "suggest",
    volume_cap: 50,
    high_risk_fields: ["deal_stage", "owner", "commission", "utm_*", "billing_*"],
  },
  handoff: {
    context_format: "structured",
    include_reasoning: true,
    include_confidence: true,
    include_attempted: true,
    timeout_seconds: 3600,
  },
  feedback: {
    override_requires_reason: true,
    reason_types: ["agent_wrong", "human_preference", "missing_context", "policy_change"],
    approval_trust_impact: 0.02,
    override_trust_impact: -0.05,
  },
  storage: { driver: "sqlite", path: ":memory:" },
  sentry: { enabled: false, db_path: ":memory:", enforcement: "strict", sensitive_keys: [], hash_chain: false },
  policies: [
    {
      id: "crm-write-policy",
      description: "CRM write access policy",
      rules: [
        { field: "commission", constraint: "value_range", min: 0, max: 50, reason: "Commission must be 0-50%" },
        { field: "deal_stage", constraint: "enum", values: ["prospect", "qualified", "proposal", "closed_won", "closed_lost"], reason: "Invalid deal stage" },
        { field: "owner", constraint: "readonly", reason: "Deal owner cannot be changed by agents" },
        { field: "billing_*", constraint: "high_risk", reason: "Billing fields need review" },
      ],
    },
    {
      id: "support-write-policy",
      description: "Support ticket write policy",
      rules: [
        { field: "priority", constraint: "enum", values: ["low", "medium", "high", "critical"], reason: "Invalid priority" },
        { field: "escalation_reason", constraint: "regex", pattern: "^.{10,}$", reason: "Escalation reason must be at least 10 characters" },
      ],
    },
  ],
  mappings: [
    { agent_id: "crm-agent", domain: "crm.deals", policy_id: "crm-write-policy" },
    { agent_id: "crm-agent", domain: "support.tickets", policy_id: "support-write-policy" },
    { agent_id: "support-agent", domain: "support.tickets", policy_id: "support-write-policy" },
  ],
};

function makeEngine() {
  const store = new CoworkStore(":memory:", testConfig);
  return new PolicyEngine(store, testConfig);
}

describe("PolicyEngine", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = makeEngine();
  });

  // Mapping resolution tests
  describe("resolveMapping", () => {
    test("crm-agent + crm.deals → crm-write-policy", () => {
      const m = engine.resolveMapping("crm-agent", "crm.deals");
      expect(m).not.toBeNull();
      expect(m!.policy_id).toBe("crm-write-policy");
    });

    test("crm-agent + support.tickets → support-write-policy", () => {
      const m = engine.resolveMapping("crm-agent", "support.tickets");
      expect(m).not.toBeNull();
      expect(m!.policy_id).toBe("support-write-policy");
    });

    test("support-agent + support.tickets → support-write-policy", () => {
      const m = engine.resolveMapping("support-agent", "support.tickets");
      expect(m).not.toBeNull();
      expect(m!.policy_id).toBe("support-write-policy");
    });

    test("support-agent + crm.deals → no mapping", () => {
      const m = engine.resolveMapping("support-agent", "crm.deals");
      expect(m).toBeNull();
    });

    test("unknown-agent + any domain → no mapping", () => {
      const m = engine.resolveMapping("unknown-agent", "crm.deals");
      expect(m).toBeNull();
    });
  });

  // Unmapped domain
  describe("unmapped domain", () => {
    test("unmapped agent/domain returns mapping_found: false, blocked: false", () => {
      const result = engine.validateWithMapping({
        agent_id: "support-agent",
        domain: "crm.deals",
        field: "owner",
        proposed_value: "new-owner",
      });
      expect(result.mapping_found).toBe(false);
      expect(result.blocked).toBe(false);
    });
  });

  // Constraint evaluations
  describe("constraint evaluations", () => {
    test("high_risk constraint → warning violation (not hard stop)", () => {
      const result = engine.validateWithMapping({
        agent_id: "crm-agent",
        domain: "crm.deals",
        field: "billing_address",
        proposed_value: "123 Main St",
      });
      expect(result.mapping_found).toBe(true);
      // billing_* is both a named policy rule (high_risk) and a global high_risk_field
      const warnings = result.violations.filter(v => v.severity === "warning");
      expect(warnings.length).toBeGreaterThan(0);
      expect(result.hard_stops.length).toBe(0);
    });

    test("readonly constraint → hard_stop violation", () => {
      const result = engine.validateWithMapping({
        agent_id: "crm-agent",
        domain: "crm.deals",
        field: "owner",
        proposed_value: "new-owner",
      });
      expect(result.mapping_found).toBe(true);
      expect(result.hard_stops.length).toBeGreaterThan(0);
      expect(result.blocked).toBe(true);
    });

    test("value_range constraint — valid value passes", () => {
      const result = engine.validateWithMapping({
        agent_id: "crm-agent",
        domain: "crm.deals",
        field: "commission",
        proposed_value: 25,
      });
      // commission is also a global high_risk_field → warning, but no hard stop from value_range
      const rangeViolations = result.violations.filter(v => v.rule_id.includes("value_range"));
      expect(rangeViolations.length).toBe(0);
    });

    test("value_range constraint — out-of-range value fails", () => {
      const result = engine.validateWithMapping({
        agent_id: "crm-agent",
        domain: "crm.deals",
        field: "commission",
        proposed_value: 75,
      });
      const rangeViolations = result.violations.filter(v => v.rule_id.includes("value_range"));
      expect(rangeViolations.length).toBeGreaterThan(0);
      expect(rangeViolations[0].severity).toBe("hard_stop");
    });

    test("enum constraint — valid value passes", () => {
      const result = engine.validateWithMapping({
        agent_id: "crm-agent",
        domain: "crm.deals",
        field: "deal_stage",
        proposed_value: "qualified",
      });
      // deal_stage is also a global high_risk_field → warning, but no enum hard stop
      const enumViolations = result.violations.filter(v => v.rule_id.includes("enum"));
      expect(enumViolations.length).toBe(0);
    });

    test("enum constraint — invalid value fails", () => {
      const result = engine.validateWithMapping({
        agent_id: "crm-agent",
        domain: "crm.deals",
        field: "deal_stage",
        proposed_value: "invalid_stage",
      });
      const enumViolations = result.violations.filter(v => v.rule_id.includes("enum"));
      expect(enumViolations.length).toBeGreaterThan(0);
    });

    test("wildcard field matching — billing_* matches billing_phone", () => {
      const result = engine.validateWithMapping({
        agent_id: "crm-agent",
        domain: "crm.deals",
        field: "billing_phone",
        proposed_value: "555-1234",
      });
      expect(result.mapping_found).toBe(true);
      const billingViolations = result.violations.filter(v => v.field === "billing_phone");
      expect(billingViolations.length).toBeGreaterThan(0);
    });

    test("wildcard field — non-matching field has no wildcard violations", () => {
      const result = engine.validateWithMapping({
        agent_id: "crm-agent",
        domain: "crm.deals",
        field: "contact_name",
        proposed_value: "John Doe",
      });
      // contact_name is not in any policy rules nor global high_risk_fields
      expect(result.violations.length).toBe(0);
    });

    test("getPolicyById returns policy", () => {
      const p = engine.getPolicyById("crm-write-policy");
      expect(p).not.toBeNull();
      expect(p!.id).toBe("crm-write-policy");
    });

    test("getPolicyById returns null for unknown", () => {
      const p = engine.getPolicyById("nonexistent");
      expect(p).toBeNull();
    });
  });

  // Backward-compat validate()
  describe("backward-compat validate()", () => {
    test("returns violations array", () => {
      const violations = engine.validate({
        agent_id: "crm-agent",
        domain: "crm.deals",
        field: "owner",
        proposed_value: "new-owner",
      });
      expect(Array.isArray(violations)).toBe(true);
      expect(violations.some(v => v.severity === "hard_stop")).toBe(true);
    });
  });
});
