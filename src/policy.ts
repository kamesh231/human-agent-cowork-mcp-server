import type { CoworkConfig, PolicyConfig, MappingConfig } from "./config.js";
import type { CoworkStore } from "./storage.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PolicyViolation {
  rule_id: string;
  field: string;
  severity: "warning" | "hard_stop";
  reason: string;
}

export interface PolicyValidationResult {
  blocked: boolean;
  mapping_found: boolean;
  policy_id?: string;
  policy_description?: string;
  rules_checked: number;
  violations: PolicyViolation[];
  hard_stops: PolicyViolation[];
}

// ---------------------------------------------------------------------------
// PolicyEngine
// ---------------------------------------------------------------------------

/**
 * PolicyEngine: named policies + agent-domain mapping.
 *
 * Policies are loaded from config.policies and matched via config.mappings
 * (agent_id + domain → policy_id). Global high_risk_fields from
 * config.authority are also evaluated.
 */
export class PolicyEngine {
  private namedPolicies: Map<string, PolicyConfig> = new Map();

  constructor(
    private readonly store: CoworkStore,
    private readonly config: CoworkConfig,
  ) {
    for (const p of config.policies ?? []) {
      this.namedPolicies.set(p.id, p);
    }
  }

  // ─── Mapping helpers ──────────────────────────────────────────────────────

  resolveMapping(agent_id: string, domain: string): MappingConfig | null {
    const mappings = this.config.mappings ?? [];
    return mappings.find(m => m.agent_id === agent_id && m.domain === domain) ?? null;
  }

  getPolicyById(id: string): PolicyConfig | null {
    return this.namedPolicies.get(id) ?? null;
  }

  // ─── Core validation ──────────────────────────────────────────────────────

  /**
   * Validate a proposed change with full mapping + named policy support.
   *
   * - No mapping found → not blocked, mapping_found: false
   *   (caller should escalate for permission but proposal is not hard-stopped)
   * - Mapping found → evaluate named policy rules + global high_risk_fields
   */
  validateWithMapping(params: {
    agent_id: string;
    domain: string;
    field: string;
    proposed_value?: unknown;
  }): PolicyValidationResult {
    const mapping = this.resolveMapping(params.agent_id, params.domain);

    if (!mapping) {
      return {
        blocked: false,
        mapping_found: false,
        rules_checked: 0,
        violations: [],
        hard_stops: [],
      };
    }

    const policy = this.getPolicyById(mapping.policy_id);
    const violations: PolicyViolation[] = [];
    let rulesChecked = 0;

    // Evaluate named policy rules
    if (policy) {
      for (const rule of policy.rules) {
        if (!this.fieldMatches(rule.field, params.field)) continue;
        rulesChecked++;

        const violation = this.evaluateRule(rule, params.field, params.proposed_value);
        if (violation) violations.push(violation);
      }
    }

    // Evaluate global high_risk_fields
    for (const pattern of this.config.authority.high_risk_fields) {
      if (!this.fieldMatches(pattern, params.field)) continue;
      rulesChecked++;
      violations.push({
        rule_id: `global_high_risk_${pattern.replace("*", "")}`,
        field: params.field,
        severity: "warning",
        reason: `Field "${params.field}" matches high-risk pattern "${pattern}" and requires review`,
      });
    }

    const hardStops = violations.filter(v => v.severity === "hard_stop");

    return {
      blocked: hardStops.length > 0,
      mapping_found: true,
      policy_id: mapping.policy_id,
      policy_description: policy?.description,
      rules_checked: rulesChecked,
      violations,
      hard_stops: hardStops,
    };
  }

  /**
   * Evaluate a single rule config against a field + proposed value.
   */
  private evaluateRule(
    rule: { field: string; constraint: string; reason?: string; min?: number; max?: number; values?: string[]; pattern?: string },
    field: string,
    proposed_value: unknown,
  ): PolicyViolation | null {
    const reason = rule.reason ?? `Field "${field}" violates constraint "${rule.constraint}"`;
    const rule_id = `${rule.constraint}_${field}`;

    switch (rule.constraint) {
      case "high_risk":
        return { rule_id, field, severity: "warning", reason };

      case "readonly":
        return { rule_id, field, severity: "hard_stop", reason };

      case "value_range": {
        if (typeof proposed_value !== "number") return null;
        const { min, max } = rule;
        if ((min !== undefined && proposed_value < min) || (max !== undefined && proposed_value > max)) {
          return { rule_id, field, severity: "hard_stop", reason: reason + ` (value ${proposed_value} out of range [${min ?? "-∞"}, ${max ?? "∞"}])` };
        }
        return null;
      }

      case "enum": {
        if (typeof proposed_value !== "string") return null;
        if (!(rule.values ?? []).includes(proposed_value)) {
          return { rule_id, field, severity: "hard_stop", reason: reason + ` (value "${proposed_value}" not in [${(rule.values ?? []).join(", ")}])` };
        }
        return null;
      }

      case "regex": {
        if (typeof proposed_value !== "string" || !rule.pattern) return null;
        try {
          const regex = new RegExp(rule.pattern);
          if (!regex.test(proposed_value)) {
            return { rule_id, field, severity: "hard_stop", reason: reason + ` (value "${proposed_value}" does not match pattern)` };
          }
        } catch {
          console.warn(`[policy] Invalid regex pattern "${rule.pattern}" in rule for field "${field}"`);
        }
        return null;
      }

      default:
        return null;
    }
  }

  /**
   * Check if a field pattern matches the proposed field.
   * Patterns ending in `*` are prefix-matched.
   */
  private fieldMatches(pattern: string, field: string): boolean {
    if (pattern.endsWith("*")) {
      return field.startsWith(pattern.slice(0, -1));
    }
    return pattern === field;
  }

  // ─── Backward-compat aliases ──────────────────────────────────────────────

  /**
   * Original validate() — now delegates to validateWithMapping.
   * Returns violation array for callers that expect the old interface.
   */
  validate(params: {
    domain: string;
    field: string;
    proposed_value: unknown;
    agent_id: string;
    agent_role?: string;
  }): PolicyViolation[] {
    const result = this.validateWithMapping({
      agent_id: params.agent_id,
      domain: params.domain,
      field: params.field,
      proposed_value: params.proposed_value,
    });
    return result.violations;
  }

  /**
   * Get policy violations for a domain (backward compat / debugging).
   */
  getPoliciesForDomain(domain: string): PolicyViolation[] {
    // Return global high-risk violations for the domain (no field context)
    return this.config.authority.high_risk_fields.map(pattern => ({
      rule_id: `global_high_risk_${pattern.replace("*", "")}`,
      field: pattern,
      severity: "warning" as const,
      reason: `Field "${pattern}" is globally high-risk`,
    }));
  }
}
