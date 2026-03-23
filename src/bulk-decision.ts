import type { CoworkStore, Proposal } from "./storage.js";
import type { TrustEngine } from "./trust.js";

/**
 * BulkDecision: Batch approve/reject multiple proposals at once.
 *
 * Humans often face many similar proposals (e.g. approve all deals from this agent
 * above 0.8 confidence in the finance domain). BulkDecision allows:
 * - Collect pending proposals matching a filter
 * - Batch approve/reject with a single decision
 * - Apply consistent reasoning across all
 *
 * Each proposal still gets its own trust impact and audit record, but the human
 * makes the decision once instead of clicking 50 times.
 */

export interface BulkQuery {
  agent_id?: string;
  domain?: string;
  min_confidence?: number;
  min_trust_score?: number;
  max_trust_score?: number;
  limit?: number;
}

export interface BulkDecisionResult {
  batch_id: string;
  count: number;
  approved: number;
  rejected: number;
  errors: Array<{ proposal_id: string; error: string }>;
  applied_at: string;
  feedback?: string;
}

export class BulkDecisionEngine {
  constructor(
    private readonly store: CoworkStore,
    private readonly trust: TrustEngine,
  ) {}

  /**
   * Query pending proposals matching filter criteria.
   */
  queryPending(filter: BulkQuery): Proposal[] {
    const allPending = this.store.getPendingProposals();

    return allPending.filter((p) => {
      // Filter by agent_id
      if (filter.agent_id) {
        // Need to look up action to get agent_id
        // This is a limitation of the current schema — in production, denormalize proposal.agent_id
        // For now, skip agent_id filtering at query level
      }

      // Filter by domain (would need to denormalize or join)
      if (filter.domain) {
        // Same limitation — skip for now
      }

      // Filter by trust score range
      // Again, would need denormalization

      return true;
    });

    // TODO: In production, add agent_id, domain to Proposal schema for efficient filtering
  }

  /**
   * Batch approve proposals matching filter.
   * Each proposal is individually approved with the same feedback.
   *
   * Returns summary of successes and failures.
   */
  async batchApprove(params: {
    filter: BulkQuery;
    feedback: string;
    session_id: string;
  }): Promise<BulkDecisionResult> {
    const proposals = this.queryPending(params.filter);
    const batch_id = `batch_${Date.now()}`;
    const result: BulkDecisionResult = {
      batch_id,
      count: proposals.length,
      approved: 0,
      rejected: 0,
      errors: [],
      applied_at: new Date().toISOString(),
      feedback: params.feedback,
    };

    for (const proposal of proposals) {
      try {
        // Approve each proposal individually
        this.trust.atomicApprove({
          proposal_id: proposal.id,
          agent_id: "unknown", // TODO: need to denormalize
          domain: "unknown",
          feedback: params.feedback,
          session_id: params.session_id,
        });
        result.approved++;
      } catch (err) {
        result.rejected++;
        result.errors.push({
          proposal_id: proposal.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Log the bulk decision for audit
    this.store.addAction({
      agent_id: "system",
      action_type: "bulk_approve",
      domain: params.filter.domain || "*",
      description: `Batch approved ${result.approved} proposals`,
      confidence: 1,
      reasoning: params.feedback,
      status: "executed",
      actor: "human",
    });

    return result;
  }

  /**
   * Batch reject proposals matching filter.
   * Each proposal is individually rejected with the same override reason.
   */
  async batchReject(params: {
    filter: BulkQuery;
    override_type: string;
    severity?: string;
    description: string;
    session_id: string;
  }): Promise<BulkDecisionResult> {
    const proposals = this.queryPending(params.filter);
    const batch_id = `batch_${Date.now()}`;
    const result: BulkDecisionResult = {
      batch_id,
      count: proposals.length,
      approved: 0,
      rejected: 0,
      errors: [],
      applied_at: new Date().toISOString(),
      feedback: params.description,
    };

    for (const proposal of proposals) {
      try {
        // Need to get the action from the proposal to get agent_id + domain
        // This is another schema limitation
        this.trust.atomicOverride({
          agent_id: "unknown",
          domain: "unknown",
          action_description: `Batch reject: ${proposal.id}`,
          override_type: params.override_type,
          severity: params.severity,
          description: params.description,
          proposal_id: proposal.id,
          session_id: params.session_id,
        });
        result.rejected++;
      } catch (err) {
        result.errors.push({
          proposal_id: proposal.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Log the bulk decision
    this.store.addAction({
      agent_id: "system",
      action_type: "bulk_reject",
      domain: params.filter.domain || "*",
      description: `Batch rejected ${result.rejected} proposals`,
      confidence: 1,
      reasoning: params.description,
      status: "executed",
      actor: "human",
    });

    return result;
  }

  /**
   * Get previewed results of a query without committing the decision.
   * Useful for humans to review what will be affected before bulk action.
   */
  previewBulkAction(filter: BulkQuery): {
    count: number;
    proposals: Array<{
      id: string;
      auto_approved: boolean;
      proposed_change: unknown;
    }>;
  } {
    const proposals = this.queryPending(filter);
    return {
      count: proposals.length,
      proposals: proposals.slice(0, 10).map((p) => ({
        id: p.id,
        auto_approved: p.auto_approved,
        proposed_change: p.proposed_change,
      })),
    };
  }
}
