import type { CoworkConfig } from "./config.js";
import type { CoworkStore } from "./storage.js";

/**
 * PolicyEngine: Domain-specific validation rules.
 *
 * Policies define constraints on what agents can propose in specific domains:
 * - Field-level restrictions (e.g. "commission" can only be set by sales-manager role)
 * - Value range constraints (e.g. "discount" must be 0-50%)
 * - Cumulative limits (e.g. "cannot approve >$1M in deals per hour")
 * - Time-based rules (e.g. "cannot delete data between 9am-5pm")
 *
 * PolicyEngine evaluates a proposal and returns a PolicyViolation if any rule fails.
 */

export interface PolicyRule {
  id: string;
  domain: string;
  field?: string; // applies to this field only, or all if omitted
  constraint: PolicyConstraint;
  severity: "warning" | "hard_stop"; // warning = log + propose anyway, hard_stop = reject
  reason: string;
}

export type PolicyConstraint =
  | { type: "field_readonly"; roles?: string[] } // field is readonly unless agent has specific role
  | { type: "value_range"; min?: number; max?: number } // numeric values must be in range
  | { type: "enum"; values: string[] } // value must be one of enum
  | { type: "regex"; pattern: string } // value must match regex
  | { type: "custom"; validator: (val: unknown) => boolean }; // custom function

export interface PolicyViolation {
  rule_id: string;
  field: string;
  severity: "warning" | "hard_stop";
  reason: string;
}

export class PolicyEngine {
  private policies: Map<string, PolicyRule[]> = new Map();

  constructor(
    private readonly store: CoworkStore,
    private readonly config: CoworkConfig,
  ) {
    this.initializeDefaultPolicies();
  }

  /**
   * Load default policies from config.
   * In production, these would come from a database or config service.
   */
  private initializeDefaultPolicies(): void {
    // High-risk fields always require human approval (hard stop if agent tries)
    for (const field of this.config.authority.high_risk_fields) {
      const cleanField = field.replace("*", "");
      const rules = this.policies.get("*") || [];
      rules.push({
        id: `policy_high_risk_${cleanField}`,
        domain: "*",
        field: cleanField,
        constraint: { type: "field_readonly" },
        severity: "hard_stop",
        reason: `Field "${cleanField}" is high-risk and requires explicit human approval`,
      });
      this.policies.set("*", rules);
    }
  }

  /**
   * Register a policy rule.
   * Agents cannot change policy; only humans via config can.
   */
  registerPolicy(rule: PolicyRule): void {
    const key = rule.domain;
    const existing = this.policies.get(key) || [];
    // Avoid duplicates
    if (!existing.find((r) => r.id === rule.id)) {
      existing.push(rule);
      this.policies.set(key, existing);
    }
  }

  /**
   * Evaluate a proposed change against all applicable policies.
   * Returns list of violations (if any).
   *
   * If any violation has severity "hard_stop", proposal should be rejected outright.
   * If all violations are "warning", proposal proceeds but with flags in audit trail.
   */
  validate(params: {
    domain: string;
    field: string;
    proposed_value: unknown;
    agent_id: string;
    agent_role?: string;
  }): PolicyViolation[] {
    const violations: PolicyViolation[] = [];

    const applicableRules = [
      ...(this.policies.get(params.domain) || []),
      ...(this.policies.get("*") || []), // wildcard rules apply to all domains
    ];

    for (const rule of applicableRules) {
      // Skip if rule is for a different field
      if (rule.field && !this.fieldMatches(rule.field, params.field)) {
        continue;
      }

      const violation = this.checkRule(rule, params);
      if (violation) {
        violations.push(violation);
      }
    }

    return violations;
  }

  /**
   * Check if a rule field pattern matches the proposed field.
   * Patterns ending in * are prefix-matched.
   */
  private fieldMatches(ruleField: string, proposedField: string): boolean {
    if (ruleField.endsWith("*")) {
      return proposedField.startsWith(ruleField.slice(0, -1));
    }
    return ruleField === proposedField;
  }

  /**
   * Evaluate a single rule against the proposed change.
   */
  private checkRule(
    rule: PolicyRule,
    params: {
      domain: string;
      field: string;
      proposed_value: unknown;
      agent_id: string;
      agent_role?: string;
    },
  ): PolicyViolation | null {
    const { constraint, field = params.field } = rule;

    if (constraint.type === "field_readonly") {
      // If rule specifies allowed roles, agent must have one
      if (constraint.roles && constraint.roles.length > 0) {
        if (!params.agent_role || !constraint.roles.includes(params.agent_role)) {
          return {
            rule_id: rule.id,
            field,
            severity: rule.severity,
            reason: rule.reason,
          };
        }
      } else {
        // No roles specified = field is readonly for everyone
        return {
          rule_id: rule.id,
          field,
          severity: rule.severity,
          reason: rule.reason,
        };
      }
    }

    if (constraint.type === "value_range" && typeof params.proposed_value === "number") {
      const { min, max } = constraint;
      if ((min !== undefined && params.proposed_value < min) ||
          (max !== undefined && params.proposed_value > max)) {
        return {
          rule_id: rule.id,
          field,
          severity: rule.severity,
          reason: rule.reason,
        };
      }
    }

    if (
      constraint.type === "enum" &&
      typeof params.proposed_value === "string"
    ) {
      if (!constraint.values.includes(params.proposed_value)) {
        return {
          rule_id: rule.id,
          field,
          severity: rule.severity,
          reason: rule.reason,
        };
      }
    }

    if (constraint.type === "regex" && typeof params.proposed_value === "string") {
      try {
        const regex = new RegExp(constraint.pattern);
        if (!regex.test(params.proposed_value)) {
          return {
            rule_id: rule.id,
            field,
            severity: rule.severity,
            reason: rule.reason,
          };
        }
      } catch (e) {
        // Invalid regex pattern — treat as warning
        console.warn(`Invalid regex in policy ${rule.id}:`, constraint.pattern);
      }
    }

    if (constraint.type === "custom") {
      try {
        if (!constraint.validator(params.proposed_value)) {
          return {
            rule_id: rule.id,
            field,
            severity: rule.severity,
            reason: rule.reason,
          };
        }
      } catch (e) {
        // Validator threw — treat as warning
        console.warn(`Custom validator in policy ${rule.id} threw:`, e);
      }
    }

    return null;
  }

  /**
   * Get all policies for a domain (for debugging/auditing).
   */
  getPoliciesForDomain(domain: string): PolicyRule[] {
    return [...(this.policies.get(domain) || []), ...(this.policies.get("*") || [])];
  }
}
