import type { CoworkConfig } from "./config.js";
import type { CoworkStore, TrustScore, Action, Proposal, Override } from "./storage.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ProposeResult {
  trust: TrustScore;
  mode: "act" | "suggest" | "escalate";
  actionRec: Action;
  proposal: Proposal;
}

export interface ApproveResult {
  previousTrust: number;
  newScore: number;
  boost: number;
  newMode: "act" | "suggest" | "escalate";
}

export interface OverrideResult {
  previousTrust: number;
  newScore: number;
  impact: number;
  demoted: boolean;
  override: Override;
}

// ---------------------------------------------------------------------------
// TrustEngine
// ---------------------------------------------------------------------------

/**
 * TrustEngine centralises all trust-score logic and ensures that every
 * mutation — reading the current score, computing the mode, writing the new
 * state — happens inside a single BEGIN EXCLUSIVE SQLite transaction.
 *
 * Without this, two concurrent `cowork_propose` calls can both read the same
 * trust score (e.g. 0.79), both decide "suggest" mode, and both write back
 * without knowing about each other — a classic TOCTOU race.
 *
 * Production rule: nothing in this file ever touches the DB outside of a
 * `store.transaction()` block.
 */
export class TrustEngine {
  constructor(
    private readonly store: CoworkStore,
    private readonly config: CoworkConfig,
  ) {}

  // ─── Policy helpers ─────────────────────────────────────────────────────

  /**
   * Returns true if `field` matches any high-risk pattern in config.
   * Patterns ending in `*` are prefix-matched (e.g. `billing_*`).
   */
  isHighRisk(field: string): boolean {
    return this.config.authority.high_risk_fields.some((p) =>
      p.endsWith("*") ? field.startsWith(p.slice(0, -1)) : field === p,
    );
  }

  /**
   * Derive the operating mode from a trust score and optional field.
   *   act      → trust ≥ 0.8 and field is not high-risk
   *   suggest  → 0.5 ≤ trust < 0.8, or field is high-risk regardless of score
   *   escalate → trust < 0.5
   */
  determineMode(score: number, field?: string): "act" | "suggest" | "escalate" {
    if (field && this.isHighRisk(field)) return "suggest";
    if (score >= 0.8) return "act";
    if (score >= 0.5) return "suggest";
    return "escalate";
  }

  // ─── Atomic operations ──────────────────────────────────────────────────

  /**
   * Atomic propose.
   *
   * Reads the current trust score, decides the mode, then writes the action
   * record, the proposal record, the trust update, and the timeline event —
   * all inside one BEGIN EXCLUSIVE transaction.
   *
   * The exclusive lock guarantees:
   *   - No concurrent writer can change the trust score between read and write.
   *   - No concurrent reader can observe a proposal without its trust update.
   */
  atomicPropose(params: {
    agent_id: string;
    domain: string;
    action: string;
    target: string;
    proposed_change: unknown;
    confidence: number;
    reasoning: string;
    field?: string;
    session_id: string;
  }): ProposeResult {
    return this.store.transaction((): ProposeResult => {
      const trust = this.store.getOrCreateTrust(
        params.agent_id,
        params.domain,
        this.config.trust.default_level,
      );
      const mode = this.determineMode(trust.score, params.field);
      const isAutoApproved = mode === "act";

      const actionRec = this.store.addAction({
        agent_id: params.agent_id,
        action_type: "propose",
        domain: params.domain,
        description: `${params.action} on ${params.target}`,
        confidence: params.confidence,
        reasoning: params.reasoning,
        status: isAutoApproved ? "executed" : "proposed",
        actor: "agent",
      });

      const proposal = this.store.addProposal({
        action_id: actionRec.id,
        proposed_change: params.proposed_change,
        trust_at_proposal: trust.score,
        threshold_required:
          params.field && this.isHighRisk(params.field) ? 1.0 : 0.8,
        auto_approved: isAutoApproved,
        human_decision: isAutoApproved ? "approved" : null,
        human_reason: isAutoApproved ? "Auto-approved: trust sufficient" : null,
        decided_at: isAutoApproved ? new Date().toISOString() : null,
      });

      // Trust counters — same transaction, no drift
      const newTotal = trust.total_actions + 1;
      const newApproved = isAutoApproved
        ? trust.approved_actions + 1
        : trust.approved_actions;

      this.store.updateTrust(params.agent_id, params.domain, {
        total_actions: newTotal,
        approved_actions: newApproved,
        consecutive_overrides: isAutoApproved ? 0 : trust.consecutive_overrides,
        accuracy: newTotal > 0 ? newApproved / newTotal : 0,
      });

      this.store.addTimelineEvent({
        session_id: params.session_id,
        actor: "agent",
        event_type: "proposal",
        reference_id: proposal.id,
        summary:
          `Proposed: ${params.action} on ${params.target} ` +
          `(conf: ${params.confidence}, trust: ${trust.score.toFixed(2)}, mode: ${mode})`,
      });

      return { trust, mode, actionRec, proposal };
    });
  }

  /**
   * Atomic approve.
   *
   * Marks the proposal decided and applies the trust boost in a single
   * transaction. Either both writes succeed or neither does — no orphaned
   * approvals without trust updates.
   *
   * @throws Error when proposal_id is not found or already decided.
   */
  atomicApprove(params: {
    proposal_id: string;
    agent_id: string;
    domain: string;
    feedback?: string;
    session_id: string;
  }): ApproveResult {
    return this.store.transaction((): ApproveResult => {
      const pending = this.store.getPendingProposals();
      const proposal = pending.find((p) => p.id === params.proposal_id);
      if (!proposal) {
        throw new Error(
          `Proposal ${params.proposal_id} not found or already decided.`,
        );
      }

      const decidedAt = new Date().toISOString();
      this.store.updateProposal(params.proposal_id, {
        human_decision: "approved",
        human_reason: params.feedback ?? "Human approved",
        decided_at: decidedAt,
      });

      const trust = this.store.getOrCreateTrust(
        params.agent_id,
        params.domain,
        this.config.trust.default_level,
      );
      const boost = this.config.feedback.approval_trust_impact;
      const newScore = Math.min(1, trust.score + boost);
      const newTotal = trust.total_actions + 1;
      const newApproved = trust.approved_actions + 1;

      this.store.updateTrust(params.agent_id, params.domain, {
        score: newScore,
        approved_actions: newApproved,
        total_actions: newTotal,
        consecutive_overrides: 0,
        accuracy: newApproved / newTotal,
      });

      this.store.addAction({
        agent_id: params.agent_id,
        action_type: "approve",
        domain: params.domain,
        description: `Approved proposal ${params.proposal_id}`,
        confidence: 1,
        reasoning: params.feedback ?? "Human approved",
        status: "executed",
        actor: "human",
      });

      this.store.addTimelineEvent({
        session_id: params.session_id,
        actor: "human",
        event_type: "proposal",
        reference_id: params.proposal_id,
        summary:
          `✅ Approved proposal ${params.proposal_id} | ` +
          `Trust: ${trust.score.toFixed(2)} → ${newScore.toFixed(2)}` +
          (params.feedback ? ` | Feedback: ${params.feedback}` : ""),
      });

      return {
        previousTrust: trust.score,
        newScore,
        boost,
        newMode: this.determineMode(newScore),
      };
    });
  }

  /**
   * Atomic override.
   *
   * Creates the action record, the override record, and applies the trust
   * penalty in one transaction. Severity scales the base impact so a
   * critical mistake on a high-value domain hurts more than a typo fix.
   */
  atomicOverride(params: {
    agent_id: string;
    domain: string;
    action_description: string;
    override_type: string;
    severity?: string;
    description: string;
    proposal_id?: string;
    session_id: string;
  }): OverrideResult {
    return this.store.transaction((): OverrideResult => {
      const actionRec = this.store.addAction({
        agent_id: params.agent_id,
        action_type: "propose",
        domain: params.domain,
        description: params.action_description,
        confidence: 0,
        reasoning: "Overridden",
        status: "rejected",
        actor: "agent",
      });

      const BASE_IMPACTS: Record<string, number> = {
        agent_wrong: -0.08,
        human_preference: -0.01,
        missing_context: -0.03,
        policy_change: 0,
        edge_case: -0.02,
      };
      const SEVERITY_MULTIPLIERS: Record<string, number> = {
        low: 0.5,
        medium: 1.0,
        high: 1.5,
        critical: 2.5,
      };
      const impact =
        (BASE_IMPACTS[params.override_type] ?? -0.05) *
        (SEVERITY_MULTIPLIERS[params.severity ?? "medium"] ?? 1.0);

      const overrideRec = this.store.addOverride({
        action_id: actionRec.id,
        override_type: params.override_type,
        description: params.description,
        trust_impact: impact,
      });

      const trust = this.store.getOrCreateTrust(
        params.agent_id,
        params.domain,
        this.config.trust.default_level,
      );
      const newConsec = trust.consecutive_overrides + 1;
      const demoted = newConsec >= this.config.trust.auto_demote_after;
      const newScore = Math.max(
        0,
        Math.min(1, trust.score + impact - (demoted ? 0.1 : 0)),
      );
      const newTotal = trust.total_actions + 1;

      this.store.updateTrust(params.agent_id, params.domain, {
        score: newScore,
        overridden_actions: trust.overridden_actions + 1,
        total_actions: newTotal,
        consecutive_overrides: newConsec,
        accuracy: newTotal > 0 ? trust.approved_actions / newTotal : 0,
      });

      if (params.proposal_id) {
        try {
          this.store.updateProposal(params.proposal_id, {
            human_decision: "rejected",
            human_reason: `${params.override_type}: ${params.description}`,
            decided_at: new Date().toISOString(),
          });
        } catch {
          // proposal may not exist — override is still valid
        }
      }

      this.store.addTimelineEvent({
        session_id: params.session_id,
        actor: "human",
        event_type: "override",
        reference_id: overrideRec.id,
        summary:
          `Override (${params.override_type}): ${params.description} | ` +
          `Impact: ${impact.toFixed(3)} → ${newScore.toFixed(2)}` +
          (demoted ? " [DEMOTED]" : ""),
      });

      return {
        previousTrust: trust.score,
        newScore,
        impact,
        demoted,
        override: overrideRec,
      };
    });
  }
}
