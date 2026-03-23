import { AgentRegistry, AuthError, hashToken } from "../../src/auth.js";
import type { CoworkConfig } from "../../src/config.js";

function makeConfig(agents: any[]): CoworkConfig {
  return {
    trust: { default_level: 0.3, auto_promote_after: 20, auto_promote_accuracy: 0.8, auto_demote_after: 3, decay_per_day: 0.01, autonomous_threshold: 0.7 },
    authority: { default_mode: "suggest", volume_cap: 50, high_risk_fields: [] },
    handoff: { context_format: "structured", include_reasoning: true, include_confidence: true, include_attempted: true, timeout_seconds: 3600 },
    feedback: { override_requires_reason: true, reason_types: [], approval_trust_impact: 0.02, override_trust_impact: -0.05 },
    storage: { driver: "sqlite", path: ":memory:" },
    sentry: { enabled: false, db_path: ":memory:", enforcement: "strict", sensitive_keys: [], hash_chain: false },
    agents,
  };
}

describe("AgentRegistry", () => {
  describe("open mode (no agents)", () => {
    let registry: AgentRegistry;

    beforeEach(() => {
      registry = new AgentRegistry(makeConfig([]));
    });

    test("isOpenMode returns true", () => {
      expect(registry.isOpenMode()).toBe(true);
    });

    test("size is 0", () => {
      expect(registry.size()).toBe(0);
    });

    test("any agent_id passes without token", () => {
      const identity = registry.verify("any-agent");
      expect(identity.agent_id).toBe("any-agent");
      expect(identity.verified).toBe(false);
    });

    test("any agent_id passes even with wrong token", () => {
      const identity = registry.verify("any-agent", "wrong-token");
      expect(identity.verified).toBe(false);
    });
  });

  describe("closed mode (agents configured)", () => {
    const TOKEN = "my-secret-token-12345";
    let registry: AgentRegistry;

    beforeEach(() => {
      registry = new AgentRegistry(makeConfig([
        { id: "crm-agent", token: TOKEN },
        { id: "support-agent", token_hash: hashToken("support-secret") },
      ]));
    });

    test("isOpenMode returns false", () => {
      expect(registry.isOpenMode()).toBe(false);
    });

    test("size is 2", () => {
      expect(registry.size()).toBe(2);
    });

    test("valid token passes", () => {
      const identity = registry.verify("crm-agent", TOKEN);
      expect(identity.agent_id).toBe("crm-agent");
      expect(identity.verified).toBe(true);
    });

    test("invalid token throws AuthError", () => {
      expect(() => registry.verify("crm-agent", "wrong-token")).toThrow(AuthError);
    });

    test("missing token throws AuthError", () => {
      expect(() => registry.verify("crm-agent")).toThrow(AuthError);
      expect(() => registry.verify("crm-agent", undefined)).toThrow(AuthError);
    });

    test("unknown agent_id throws AuthError", () => {
      expect(() => registry.verify("unknown-agent", TOKEN)).toThrow(AuthError);
    });

    test("token_hash works correctly", () => {
      const identity = registry.verify("support-agent", "support-secret");
      expect(identity.verified).toBe(true);
    });

    test("wrong token for token_hash agent throws AuthError", () => {
      expect(() => registry.verify("support-agent", "wrong-token")).toThrow(AuthError);
    });
  });
});
