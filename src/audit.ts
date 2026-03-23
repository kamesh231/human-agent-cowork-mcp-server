import type { CoworkStore, TrustScore } from "./storage.js";
import type { CoworkConfig } from "./config.js";

/**
 * AuditLinker: Bridge between COWORK server (proposals) and Sentry (actual tool calls).
 *
 * Problem: COWORK tracks proposals and approvals; Sentry tracks actual tool executions.
 * These are two separate audit trails that never connect.
 *
 * Solution: AuditLinker creates the link:
 * - Agent proposes action X → gets proposal_id
 * - Agent calls downstream tool, includes proposal_id in Sentry metadata
 * - Sentry traces reference that proposal_id
 * - AuditLinker queries: "find all Sentry traces for proposal_id P"
 * - Creates unified audit record: proposed → approved → executed → verified
 *
 * Additionally:
 * - Sentry reads trust scores and adapts enforcement mode (low trust = strict, high trust = warn)
 * - Proposal approval automatically unblocks agent in Sentry (if Sentry enforcement is enabled)
 */

export interface TraceMetadata {
  proposal_id?: string;
  agent_id: string;
  domain?: string;
  action: string;
  intent?: string; // Sentry: why is agent calling this?
  timestamp: string;
}

export interface AuditRecord {
  id: string;
  proposal_id?: string;
  agent_id: string;
  domain?: string;
  action: string;
  proposal_timestamp?: string;
  approved_timestamp?: string;
  executed_timestamp?: string;
  sentry_trace_id?: string;
  status: "proposed" | "approved" | "executed" | "verified" | "orphaned";
  notes: string;
}

export class AuditLinker {
  private auditLog: AuditRecord[] = [];

  constructor(
    private readonly store: CoworkStore,
    private readonly config: CoworkConfig,
  ) {}

  /**
   * Called when a proposal is created.
   * Records the initial audit entry.
   */
  recordProposal(params: {
    proposal_id: string;
    agent_id: string;
    domain: string;
    action: string;
  }): AuditRecord {
    const record: AuditRecord = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      proposal_id: params.proposal_id,
      agent_id: params.agent_id,
      domain: params.domain,
      action: params.action,
      proposal_timestamp: new Date().toISOString(),
      status: "proposed",
      notes: "Proposal created",
    };
    this.auditLog.push(record);
    return record;
  }

  /**
   * Called when a proposal is approved.
   * Updates the audit record to reflect approval.
   */
  recordApproval(params: {
    proposal_id: string;
    feedback?: string;
  }): AuditRecord | null {
    const record = this.auditLog.find((r) => r.proposal_id === params.proposal_id);
    if (!record) {
      return null;
    }
    record.status = "approved";
    record.approved_timestamp = new Date().toISOString();
    record.notes = params.feedback || "Human approved";
    return record;
  }

  /**
   * Called when a tool execution is intercepted by Sentry.
   * Links the trace to the proposal via proposal_id in metadata.
   */
  recordExecution(params: {
    proposal_id?: string;
    agent_id: string;
    sentry_trace_id: string;
    action: string;
    intent?: string;
  }): AuditRecord | null {
    let record: AuditRecord | undefined;

    if (params.proposal_id) {
      record = this.auditLog.find((r) => r.proposal_id === params.proposal_id);
    }

    if (!record) {
      // Orphaned execution — no corresponding proposal
      record = {
        id: `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        agent_id: params.agent_id,
        action: params.action,
        sentry_trace_id: params.sentry_trace_id,
        executed_timestamp: new Date().toISOString(),
        status: "orphaned",
        notes: `Execution without proposal: ${params.intent || "no intent"}`,
      };
      this.auditLog.push(record);
      return record;
    }

    // Update existing proposal record with execution info
    record.status = "executed";
    record.executed_timestamp = new Date().toISOString();
    record.sentry_trace_id = params.sentry_trace_id;
    record.notes = params.intent ? `Executed: ${params.intent}` : "Executed";

    return record;
  }

  /**
   * Verify the full chain: proposed → approved → executed.
   * Returns true if all three events are recorded in order.
   */
  verifyChain(proposalId: string): boolean {
    const record = this.auditLog.find((r) => r.proposal_id === proposalId);
    if (!record) {
      return false;
    }

    const hasProposal = !!record.proposal_timestamp;
    const hasApproval = !!record.approved_timestamp;
    const hasExecution = !!record.executed_timestamp;

    if (!hasProposal) {
      return false;
    }

    if (!hasApproval && !hasExecution) {
      return false; // Proposed but never approved or executed
    }

    if (hasApproval && hasExecution) {
      const approvalTime = new Date(record.approved_timestamp!).getTime();
      const executionTime = new Date(record.executed_timestamp!).getTime();
      if (executionTime < approvalTime) {
        return false; // Executed before approval
      }
    }

    record.status = "verified";
    return true;
  }

  /**
   * Find orphaned executions: Sentry traces with no corresponding proposal.
   * These indicate:
   * - Agent called downstream tools without proposing through COWORK
   * - COWORK proposal system was bypassed
   * - Major compliance/governance issue
   */
  getOrphanedExecutions(): AuditRecord[] {
    return this.auditLog.filter(
      (r) => r.status === "orphaned",
    );
  }

  /**
   * Get full audit trail for a proposal.
   */
  getAuditTrail(proposalId: string): AuditRecord | null {
    return this.auditLog.find((r) => r.proposal_id === proposalId) || null;
  }

  /**
   * Generate audit report for a time range.
   */
  getAuditReport(params: {
    agent_id?: string;
    domain?: string;
    start_time?: string;
    end_time?: string;
  }): {
    total: number;
    proposed: number;
    approved: number;
    executed: number;
    orphaned: number;
    verified_chains: number;
    records: AuditRecord[];
  } {
    let filtered = [...this.auditLog];

    if (params.agent_id) {
      filtered = filtered.filter((r) => r.agent_id === params.agent_id);
    }
    if (params.domain) {
      filtered = filtered.filter((r) => r.domain === params.domain);
    }
    if (params.start_time) {
      const start = new Date(params.start_time).getTime();
      filtered = filtered.filter(
        (r) =>
          new Date(r.proposal_timestamp || r.executed_timestamp || "").getTime() >= start,
      );
    }
    if (params.end_time) {
      const end = new Date(params.end_time).getTime();
      filtered = filtered.filter(
        (r) =>
          new Date(r.proposal_timestamp || r.executed_timestamp || "").getTime() <= end,
      );
    }

    return {
      total: filtered.length,
      proposed: filtered.filter((r) => r.status !== "orphaned").length,
      approved: filtered.filter((r) => r.approved_timestamp).length,
      executed: filtered.filter((r) => r.executed_timestamp).length,
      orphaned: filtered.filter((r) => r.status === "orphaned").length,
      verified_chains: filtered.filter((r) => r.status === "verified").length,
      records: filtered,
    };
  }

  /**
   * Sentry integration: Return enforcement mode based on trust score.
   * Wire trust decisions into Sentry enforcement.
   */
  getEnforcementMode(trust: TrustScore): "strict" | "warn" | "permissive" {
    // High trust: agent can call tools freely (Sentry: warn mode, just log)
    if (trust.score >= 0.8) {
      return "permissive";
    }

    // Medium trust: agent must provide intent (Sentry: warn mode)
    if (trust.score >= 0.5) {
      return "warn";
    }

    // Low trust: agent must have explicit approval (Sentry: strict mode, block unless approved)
    return "strict";
  }

  /**
   * Check if a proposal has been approved (needed for Sentry to unblock execution).
   */
  isProposalApproved(proposalId: string): boolean {
    const record = this.auditLog.find((r) => r.proposal_id === proposalId);
    return !!record && !!record.approved_timestamp;
  }

  /**
   * Comprehensive audit summary: detection of governance gaps.
   */
  getGovernanceIssues(): Array<{
    type:
      | "orphaned_execution"
      | "proposal_never_approved"
      | "execution_before_approval"
      | "missing_intent";
    severity: "low" | "medium" | "high";
    record: AuditRecord;
    recommendation: string;
  }> {
    const issues: ReturnType<typeof this.getGovernanceIssues> = [];

    for (const record of this.auditLog) {
      if (record.status === "orphaned") {
        issues.push({
          type: "orphaned_execution",
          severity: "high",
          record,
          recommendation:
            "Agent executed tools without COWORK proposal. Investigate why proposal flow was bypassed.",
        });
      }

      if (record.proposal_timestamp && !record.approved_timestamp && record.executed_timestamp) {
        issues.push({
          type: "execution_before_approval",
          severity: "high",
          record,
          recommendation:
            "Agent executed tool before proposal was approved. Enforce proposal-approval-execution sequence.",
        });
      }

      if (record.proposal_timestamp && !record.approved_timestamp && !record.executed_timestamp) {
        const proposalAge = Date.now() - new Date(record.proposal_timestamp).getTime();
        if (proposalAge > 24 * 60 * 60 * 1000) {
          // older than 24 hours
          issues.push({
            type: "proposal_never_approved",
            severity: "medium",
            record,
            recommendation: "Proposal is pending for >24h. Review and make decision.",
          });
        }
      }

      if (!record.notes && record.status === "executed") {
        issues.push({
          type: "missing_intent",
          severity: "low",
          record,
          recommendation:
            "Execution lacks intent explanation. Improve Sentry metadata to capture intent.",
        });
      }
    }

    return issues;
  }
}
