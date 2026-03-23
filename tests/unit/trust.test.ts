import { CoworkStore } from "../../src/storage.js";
import { TrustEngine, VolumeCapError } from "../../src/trust.js";
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
};

function makeStore() {
  return new CoworkStore(":memory:", testConfig);
}

describe("TrustEngine", () => {
  let store: CoworkStore;
  let engine: TrustEngine;

  beforeEach(() => {
    store = makeStore();
    engine = new TrustEngine(store, testConfig);
  });

  test("initial trust 0.3 + non-risk field = escalate mode", () => {
    const mode = engine.determineMode(0.3, "contact_name");
    expect(mode).toBe("escalate");
  });

  test("initial trust 0.3 + high-risk field = suggest mode", () => {
    const mode = engine.determineMode(0.3, "deal_stage");
    expect(mode).toBe("suggest");
  });

  test("trust 0.6 + non-risk field = suggest mode", () => {
    const mode = engine.determineMode(0.6, "contact_name");
    expect(mode).toBe("suggest");
  });

  test("trust 0.85 + non-risk field = act mode", () => {
    const mode = engine.determineMode(0.85, "contact_name");
    expect(mode).toBe("act");
  });

  test("trust 0.85 + high-risk field = suggest mode (high-risk overrides)", () => {
    const mode = engine.determineMode(0.85, "commission");
    expect(mode).toBe("suggest");
  });

  test("wildcard high-risk field billing_* matches billing_address", () => {
    expect(engine.isHighRisk("billing_address")).toBe(true);
    expect(engine.isHighRisk("billing_email")).toBe(true);
    expect(engine.isHighRisk("shipping_address")).toBe(false);
  });

  test("wildcard high-risk field utm_* matches utm_source", () => {
    expect(engine.isHighRisk("utm_source")).toBe(true);
    expect(engine.isHighRisk("utm_campaign")).toBe(true);
  });

  test("atomicPropose creates action and proposal records", () => {
    const result = engine.atomicPropose({
      agent_id: "agent-1",
      domain: "crm.deals",
      action: "update",
      target: "deal-123",
      proposed_change: { field: "name", value: "New Name" },
      confidence: 0.7,
      reasoning: "Name correction",
      session_id: "sess-1",
    });
    expect(result.proposal.id).toBeTruthy();
    expect(result.actionRec.id).toBeTruthy();
    expect(result.mode).toBe("escalate"); // trust starts at 0.3
  });

  test("approve increases trust", () => {
    // First propose
    const propResult = engine.atomicPropose({
      agent_id: "agent-1",
      domain: "crm.deals",
      action: "update",
      target: "deal-123",
      proposed_change: { value: "test" },
      confidence: 0.5,
      reasoning: "test",
      session_id: "sess-1",
    });

    const initialTrust = store.getOrCreateTrust("agent-1", "crm.deals", 0.3);
    const initialScore = initialTrust.score;

    const approveResult = engine.atomicApprove({
      proposal_id: propResult.proposal.id,
      agent_id: "agent-1",
      domain: "crm.deals",
      session_id: "sess-1",
    });

    expect(approveResult.newScore).toBeGreaterThan(initialScore);
    expect(approveResult.boost).toBe(testConfig.feedback.approval_trust_impact);
  });

  test("override decreases trust", () => {
    const overrideResult = engine.atomicOverride({
      agent_id: "agent-1",
      domain: "crm.deals",
      action_description: "Bad update",
      override_type: "agent_wrong",
      severity: "medium",
      description: "Agent made a mistake",
      session_id: "sess-1",
    });

    expect(overrideResult.newScore).toBeLessThan(overrideResult.previousTrust);
  });

  test("3 consecutive overrides triggers demotion", () => {
    // We need auto_demote_after (3) consecutive overrides
    for (let i = 0; i < 3; i++) {
      engine.atomicOverride({
        agent_id: "agent-2",
        domain: "crm.deals",
        action_description: `Bad action ${i}`,
        override_type: "agent_wrong",
        severity: "medium",
        description: `Override ${i}`,
        session_id: "sess-demote",
      });
    }

    // The 3rd override (index 2) should have demoted = true
    const trust = store.getOrCreateTrust("agent-2", "crm.deals", 0.3);
    expect(trust.consecutive_overrides).toBeGreaterThanOrEqual(3);
  });

  test("VolumeCapError is thrown when volume cap exceeded", () => {
    // Create a store with very low cap
    const lowCapConfig = {
      ...testConfig,
      authority: { ...testConfig.authority, volume_cap: 2 },
    };
    const lowCapStore = new CoworkStore(":memory:", lowCapConfig);
    const lowCapEngine = new TrustEngine(lowCapStore, lowCapConfig);

    // Make 2 proposals to hit the cap
    for (let i = 0; i < 2; i++) {
      lowCapEngine.atomicPropose({
        agent_id: "agent-cap",
        domain: "crm.deals",
        action: "update",
        target: "deal-1",
        proposed_change: {},
        confidence: 0.5,
        reasoning: "test",
        session_id: "sess-cap",
      });
    }

    // 3rd should throw VolumeCapError
    expect(() => {
      lowCapEngine.atomicPropose({
        agent_id: "agent-cap",
        domain: "crm.deals",
        action: "update",
        target: "deal-1",
        proposed_change: {},
        confidence: 0.5,
        reasoning: "test",
        session_id: "sess-cap",
      });
    }).toThrow(VolumeCapError);
  });
});
