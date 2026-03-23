#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CoworkStore } from "./storage.js";
import { loadConfig } from "./config.js";
import { AgentRegistry, AuthError } from "./auth.js";
import { TrustEngine } from "./trust.js";
import { PolicyEngine } from "./policy.js";
import { NotificationDispatcher } from "./notify.js";
import { BulkDecisionEngine } from "./bulk-decision.js";
import { AuditLinker } from "./audit.js";

const config  = loadConfig();
const store   = new CoworkStore(config.storage?.path ?? "./cowork.db");
const registry = new AgentRegistry(config);
const trust   = new TrustEngine(store, config);
const policy  = new PolicyEngine(store, config);
const notify  = new NotificationDispatcher(store, config);
const bulk    = new BulkDecisionEngine(store, trust);
const audit   = new AuditLinker(store, config);
const SESSION_ID = `session_${Date.now()}`;
const server  = new McpServer({ name: "cowork-protocol", version: "0.1.0" });

// ---------------------------------------------------------------------------
// Auth helper — converts AuthError into a tool-level error response so the
// MCP caller gets a clean message instead of an unhandled exception.
// ---------------------------------------------------------------------------
function verifyAgent(agent_id: string, agent_token?: string) {
  return registry.verify(agent_id, agent_token);
}

function authErrorResponse(err: AuthError) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: true, auth_error: true, message: err.message }, null, 2),
    }],
  };
}

// ─── Tool 1: cowork_propose ──────────────────────────────────────────────────
server.registerTool("cowork_propose", {
  title: "Propose an action (COWORK: Intent Declaration)",
  description:
    "Before taking any action, propose it through COWORK. Checks trust level and " +
    "returns whether to act, suggest for review, or escalate. Agents propose — they don't just act.",
  inputSchema: {
    agent_id:        z.string().describe("Agent identifier"),
    agent_token:     z.string().optional().describe("Agent auth token (required in closed mode)"),
    domain:          z.string().describe("Domain (e.g. 'crm.deals', 'support.tickets')"),
    action:          z.string().describe("What the agent wants to do"),
    target:          z.string().describe("What it targets (record ID, etc)"),
    proposed_change: z.string().describe("JSON describing the proposed change"),
    confidence:      z.number().min(0).max(1).describe("Confidence 0.0–1.0"),
    reasoning:       z.string().describe("Why the agent wants to do this"),
    field:           z.string().optional().describe("Specific field being modified"),
  },
}, async ({ agent_id, agent_token, domain, action, target, proposed_change, confidence, reasoning, field }) => {
  try { verifyAgent(agent_id, agent_token); }
  catch (e) { return authErrorResponse(e as AuthError); }

  let changeObj: unknown;
  try { changeObj = JSON.parse(proposed_change); } catch { changeObj = { raw: proposed_change }; }

  // Validate against policies
  let policyViolations: any[] = [];
  if (field && changeObj && typeof changeObj === "object" && "value" in changeObj) {
    policyViolations = policy.validate({
      domain, field,
      proposed_value: (changeObj as any).value,
      agent_id,
    });
  }

  // Hard-stop violations block the proposal
  const hardStops = policyViolations.filter((v) => v.severity === "hard_stop");
  if (hardStops.length > 0) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: true,
          policy_error: true,
          violations: hardStops.map((v) => ({ rule_id: v.rule_id, reason: v.reason })),
          message: `Proposal blocked by ${hardStops.length} hard-stop policy violation(s)`,
        }, null, 2),
      }],
    };
  }

  const result = trust.atomicPropose({
    agent_id, domain, action, target,
    proposed_change: changeObj,
    confidence, reasoning, field,
    session_id: SESSION_ID,
  });

  const { mode, proposal, actionRec } = result;
  const currentTrust = result.trust.score;

  // Record in audit trail
  audit.recordProposal({
    proposal_id: proposal.id,
    agent_id,
    domain,
    action,
  });

  // Send notification if in suggest mode
  if (mode === "suggest") {
    await notify.onProposalCreated({
      id: proposal.id,
      action_id: actionRec.id,
      trust_at_proposal: currentTrust,
    });
  }

  // Warn about policy violations (non-blocking)
  if (policyViolations.length > 0) {
    await notify.onPolicyViolation({
      agent_id,
      domain,
      field: field || "unknown",
      rule_id: policyViolations[0].rule_id,
      severity: "warning",
    });
  }

  const msg =
    mode === "act"      ? `✅ AUTO-APPROVED: Trust (${currentTrust.toFixed(2)}) sufficient.` :
    mode === "suggest"  ? `⏳ AWAITING REVIEW: Proposal ${proposal.id}` :
                          `🚨 ESCALATED: Trust (${currentTrust.toFixed(2)}) too low. Proposal ${proposal.id}`;

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        proposal_id:    proposal.id,
        action_id:      actionRec.id,
        mode,
        trust_level:    currentTrust,
        confidence,
        high_risk_field: field ? trust.isHighRisk(field) : false,
        policy_warnings: policyViolations.filter((v) => v.severity === "warning").length,
        message: msg,
      }, null, 2),
    }],
  };
});

// ─── Tool 2: cowork_check_trust ──────────────────────────────────────────────
server.registerTool("cowork_check_trust", {
  title: "Check trust level (COWORK: Trust Score)",
  description:
    "Check current trust level for an agent in a domain. " +
    "Returns score, accuracy, and operating mode (act/suggest/escalate).",
  inputSchema: {
    agent_id:    z.string().describe("Agent identifier"),
    agent_token: z.string().optional().describe("Agent auth token (required in closed mode)"),
    domain:      z.string().describe("Domain to check"),
    field:       z.string().optional().describe("Field for high-risk check"),
  },
}, async ({ agent_id, agent_token, domain, field }) => {
  try { verifyAgent(agent_id, agent_token); }
  catch (e) { return authErrorResponse(e as AuthError); }

  const t = store.getOrCreateTrust(agent_id, domain, config.trust.default_level);
  const mode = trust.determineMode(t.score, field);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        agent_id, domain,
        trust_score:          t.score,
        accuracy:             t.accuracy,
        total_actions:        t.total_actions,
        overridden_actions:   t.overridden_actions,
        consecutive_overrides: t.consecutive_overrides,
        mode,
        high_risk:            field ? trust.isHighRisk(field) : false,
        message: `Trust: ${t.score.toFixed(2)} | Mode: ${mode} | Accuracy: ${(t.accuracy * 100).toFixed(1)}% over ${t.total_actions} actions`,
      }, null, 2),
    }],
  };
});

// ─── Tool 3: cowork_handoff ──────────────────────────────────────────────────
server.registerTool("cowork_handoff", {
  title: "Handoff to human (COWORK: Context Packet)",
  description:
    "Hand off to human with structured context: what was tried, confidence level, reasoning. " +
    "Human receives everything needed to continue.",
  inputSchema: {
    agent_id:         z.string().describe("Agent identifier"),
    agent_token:      z.string().optional().describe("Agent auth token (required in closed mode)"),
    domain:           z.string().describe("Domain"),
    reason:           z.string().describe("Why handing off"),
    confidence:       z.number().min(0).max(1).describe("Confidence at handoff"),
    attempted_actions: z.string().describe("JSON array of actions tried"),
    context:          z.string().describe("JSON context for the human"),
    handoff_mode:     z.enum(["escalate", "review", "collaborate"]).describe("escalate/review/collaborate"),
  },
}, async ({ agent_id, agent_token, domain, reason, confidence, attempted_actions, context, handoff_mode }) => {
  try { verifyAgent(agent_id, agent_token); }
  catch (e) { return authErrorResponse(e as AuthError); }

  let attempts: string[];
  try { attempts = JSON.parse(attempted_actions); } catch { attempts = [attempted_actions]; }
  let ctx: unknown;
  try { ctx = JSON.parse(context); } catch { ctx = { raw: context }; }

  const handoff = store.addHandoff({
    agent_id, domain, reason, confidence_at_handoff: confidence,
    context_packet: { mode: handoff_mode, reason, confidence, attempted: attempts, context: ctx },
    attempted_actions: attempts,
    resolution: null, resolved_at: null,
  });
  store.addAction({
    agent_id, action_type: "escalate", domain,
    description: `Handoff (${handoff_mode}): ${reason}`,
    confidence, reasoning: reason, status: "proposed", actor: "agent",
  });
  store.addTimelineEvent({
    session_id: SESSION_ID, actor: "agent", event_type: "handoff",
    reference_id: handoff.id,
    summary: `Handoff (${handoff_mode}): ${reason} | Conf: ${confidence} | ${attempts.length} attempts`,
  });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        handoff_id:   handoff.id,
        mode:         handoff_mode,
        message:      `🤝 HANDOFF (${handoff_mode.toUpperCase()}): ${reason}`,
        context_packet: { tried: attempts, confidence, reasoning: reason, context: ctx },
        for_human:    `Agent handing off (${handoff_mode}). Tried ${attempts.length} approach(es), confidence ${confidence}. Reason: ${reason}`,
      }, null, 2),
    }],
  };
});

// ─── Tool 4: cowork_log ──────────────────────────────────────────────────────
server.registerTool("cowork_log", {
  title: "Log action (COWORK: Action Attribution)",
  description: "Log any action with attribution: who did it (agent/human/collaborative), what domain, why.",
  inputSchema: {
    agent_id:    z.string(),
    agent_token: z.string().optional().describe("Agent auth token (required in closed mode)"),
    domain:      z.string(),
    action:      z.string(),
    actor:       z.enum(["agent", "human", "collaborative"]).describe("Who performed it"),
    confidence:  z.number().min(0).max(1).optional(),
    reasoning:   z.string().optional(),
    proposal_id: z.string().optional().describe("Link to the proposal this action executes"),
  },
}, async ({ agent_id, agent_token, domain, action, actor, confidence, reasoning, proposal_id }) => {
  try { verifyAgent(agent_id, agent_token); }
  catch (e) { return authErrorResponse(e as AuthError); }

  const rec = store.addAction({
    agent_id, action_type: "log", domain, description: action,
    confidence: confidence ?? 0, reasoning: reasoning ?? "",
    status: "executed", actor,
  });
  store.addTimelineEvent({
    session_id: SESSION_ID, actor, event_type: "action",
    reference_id: rec.id,
    summary: `[${actor.toUpperCase()}] ${action}${proposal_id ? ` (proposal: ${proposal_id})` : ""}`,
  });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        action_id:   rec.id,
        proposal_id: proposal_id ?? null,
        logged:      true,
        message:     `📝 Logged: [${actor}] ${action}${proposal_id ? ` (linked to proposal ${proposal_id})` : ""}`,
      }, null, 2),
    }],
  };
});

// ─── Tool 5: cowork_override ─────────────────────────────────────────────────
server.registerTool("cowork_override", {
  title: "Record override (COWORK: Override Signal)",
  description:
    "Human corrects agent action. Reason type matters: 'agent_wrong' hits trust hard, " +
    "'human_preference' barely affects it. Severity scales the impact. Feeds back into trust model.",
  inputSchema: {
    agent_id:         z.string(),
    agent_token:      z.string().optional().describe("Agent auth token (required in closed mode)"),
    domain:           z.string(),
    action_description: z.string().describe("What's being overridden"),
    override_type:    z.enum(["agent_wrong", "human_preference", "missing_context", "policy_change", "edge_case"]),
    severity:         z.enum(["low", "medium", "high", "critical"]).optional()
                       .describe("Severity of the error (scales trust impact). Default: medium"),
    description:      z.string().describe("Details about the correction"),
    proposal_id:      z.string().optional(),
  },
}, async ({ agent_id, agent_token, domain, action_description, override_type, severity, description, proposal_id }) => {
  try { verifyAgent(agent_id, agent_token); }
  catch (e) { return authErrorResponse(e as AuthError); }

  const result = trust.atomicOverride({
    agent_id, domain, action_description, override_type,
    severity, description, proposal_id,
    session_id: SESSION_ID,
  });

  // Send trust change notification
  await notify.onTrustChanged({
    agent_id,
    domain,
    previous_score: result.previousTrust,
    new_score: result.newScore,
    reason: `Override (${override_type}): ${description}`,
  });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        override_id:   result.override.id,
        override_type,
        trust_impact:  result.impact,
        previous_trust: result.previousTrust,
        new_trust:     result.newScore,
        demoted:       result.demoted,
        message:
          `⚠️ OVERRIDE (${override_type}): ${description}\n` +
          `Trust: ${result.previousTrust.toFixed(2)} → ${result.newScore.toFixed(2)}` +
          (result.demoted ? " [DEMOTED]" : ""),
      }, null, 2),
    }],
  };
});

// ─── Tool 6: cowork_approve ──────────────────────────────────────────────────
server.registerTool("cowork_approve", {
  title: "Approve a proposal (COWORK: Approval Signal)",
  description:
    "Human approves a pending proposal. Closes the feedback loop: trust increases, " +
    "consecutive overrides reset. Without this, trust can only decrease.",
  inputSchema: {
    proposal_id: z.string().describe("ID of the proposal to approve"),
    agent_id:    z.string().describe("Agent identifier"),
    agent_token: z.string().optional().describe("Agent auth token (required in closed mode)"),
    domain:      z.string().describe("Domain"),
    feedback:    z.string().optional().describe("Optional feedback for the agent"),
  },
}, async ({ proposal_id, agent_id, agent_token, domain, feedback }) => {
  try { verifyAgent(agent_id, agent_token); }
  catch (e) { return authErrorResponse(e as AuthError); }

  try {
    const result = trust.atomicApprove({
      proposal_id, agent_id, domain,
      feedback, session_id: SESSION_ID,
    });

    // Record approval in audit trail
    audit.recordApproval({
      proposal_id,
      feedback,
    });

    // Send notification about trust change
    await notify.onTrustChanged({
      agent_id,
      domain,
      previous_score: result.previousTrust,
      new_score: result.newScore,
      reason: `Human approved proposal ${proposal_id}`,
    });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          proposal_id,
          approved:       true,
          trust_impact:   `+${result.boost}`,
          previous_trust: result.previousTrust,
          new_trust:      result.newScore,
          new_mode:       result.newMode,
          feedback:       feedback ?? null,
          message:
            `✅ APPROVED: Proposal ${proposal_id}\n` +
            `Trust: ${result.previousTrust.toFixed(2)} → ${result.newScore.toFixed(2)} (${result.newMode})` +
            (feedback ? `\nFeedback: ${feedback}` : ""),
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: true,
          message: err instanceof Error ? err.message : String(err),
        }, null, 2),
      }],
    };
  }
});

// ─── Tool 7: cowork_resolve_handoff ──────────────────────────────────────────
server.registerTool("cowork_resolve_handoff", {
  title: "Resolve a handoff (COWORK: Handoff Resolution)",
  description:
    "Human resolves an open handoff. Closes the loop: records resolution, " +
    "optionally hands work back to agent with instructions.",
  inputSchema: {
    handoff_id:         z.string().describe("ID of the handoff to resolve"),
    resolution:         z.string().describe("What the human did or decided"),
    hand_back_to_agent: z.boolean().optional().describe("Whether to delegate back to the agent"),
    instructions:       z.string().optional().describe("Instructions for the agent if handing back"),
  },
}, async ({ handoff_id, resolution, hand_back_to_agent, instructions }) => {
  try {
    store.resolveHandoff(handoff_id, resolution);
    store.addTimelineEvent({
      session_id: SESSION_ID, actor: "human", event_type: "handoff",
      reference_id: handoff_id,
      summary: `Resolved handoff: ${resolution}${hand_back_to_agent ? " [HANDED BACK]" : ""}`,
    });

    const result: Record<string, unknown> = {
      handoff_id, resolved: true, resolution,
      message: `🤝 RESOLVED: ${resolution}`,
    };
    if (hand_back_to_agent && instructions) {
      result.hand_back   = true;
      result.instructions = instructions;
      result.message = `🤝 RESOLVED & HANDED BACK: ${resolution}\n📋 Instructions: ${instructions}`;
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ error: true, message: `Handoff ${handoff_id} not found.` }, null, 2),
      }],
    };
  }
});

// ─── Tool 8: cowork_status ───────────────────────────────────────────────────
server.registerTool("cowork_status", {
  title: "Collaboration dashboard (COWORK: Status)",
  description:
    "Full dashboard: trust scores, action stats, override rates, pending proposals, " +
    "open handoffs, timeline.",
  inputSchema: {
    agent_id:        z.string().optional(),
    include_timeline: z.boolean().optional(),
    timeline_limit:  z.number().optional(),
  },
}, async ({ agent_id, include_timeline, timeline_limit }) => {
  const stats    = store.getStats();
  const trusts   = store.getAllTrust(agent_id ?? undefined);
  const pending  = store.getPendingProposals();
  const handoffs = store.getOpenHandoffs();
  const timeline = include_timeline !== false
    ? store.getTimeline(undefined, timeline_limit ?? 20)
    : [];

  let text = `═══ COWORK DASHBOARD ═══\n`;
  text += `📊 ${stats.total_actions} actions | ${stats.approved_actions} approved | ${stats.overrides} overrides (${stats.override_rate})\n`;
  text += `📋 ${pending.length} pending proposals | ${handoffs.length} open handoffs\n`;
  text += registry.isOpenMode()
    ? `🔓 Auth: open mode (no agents registered)\n`
    : `🔐 Auth: closed mode (${registry.size()} registered agents)\n`;
  text += "\n";

  if (trusts.length > 0) {
    text += `🔐 Trust:\n`;
    for (const t of trusts) {
      text += `   ${t.agent_id}:${t.domain} → ${t.score.toFixed(2)} (${trust.determineMode(t.score)}) | ${t.total_actions} actions\n`;
    }
    text += "\n";
  }
  if (timeline.length > 0) {
    text += `📜 Timeline:\n`;
    for (const e of timeline.slice(-10)) text += `   [${e.actor}] ${e.summary}\n`;
  }

  return {
    content: [
      { type: "text" as const, text },
      {
        type: "text" as const,
        text: JSON.stringify({
          session_id:       SESSION_ID,
          auth_mode:        registry.isOpenMode() ? "open" : "closed",
          stats,
          trust_scores:     trusts,
          pending_proposals: pending.length,
          open_handoffs:    handoffs.length,
          timeline:         timeline.slice(-20),
          config: {
            default_trust: config.trust.default_level,
            default_mode:  config.authority.default_mode,
            volume_cap:    config.authority.volume_cap,
          },
        }, null, 2),
      },
    ],
  };
});

// ─── Tool 9: cowork_validate_policy ──────────────────────────────────────────
server.registerTool("cowork_validate_policy", {
  title: "Validate proposal against domain policies",
  description:
    "Check if a proposed change violates any domain-specific policies. Returns violations " +
    "that are warnings (proceed anyway) or hard stops (reject).",
  inputSchema: {
    agent_id: z.string().describe("Agent identifier"),
    agent_token: z.string().optional().describe("Agent auth token"),
    domain: z.string().describe("Domain for policy lookup"),
    field: z.string().describe("Field being modified"),
    proposed_value: z.unknown().describe("The value being proposed"),
    agent_role: z.string().optional().describe("Agent role (e.g. 'sales-manager')"),
  },
}, async ({ agent_id, agent_token, domain, field, proposed_value, agent_role }) => {
  try {
    verifyAgent(agent_id, agent_token);
  } catch (err) {
    return authErrorResponse(err as AuthError);
  }

  const violations = policy.validate({
    domain,
    field,
    proposed_value,
    agent_id,
    agent_role,
  });

  const hasHardStops = violations.some((v) => v.severity === "hard_stop");

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        valid: violations.length === 0,
        hard_stop: hasHardStops,
        violations: violations.map((v) => ({
          rule_id: v.rule_id,
          field: v.field,
          severity: v.severity,
          reason: v.reason,
        })),
      }, null, 2),
    }],
  };
});

// ─── Tool 10: cowork_bulk_approve ────────────────────────────────────────────
server.registerTool("cowork_bulk_approve", {
  title: "Batch approve multiple proposals",
  description:
    "Approve multiple pending proposals at once based on filter criteria. " +
    "Each proposal is individually approved but with a single human decision.",
  inputSchema: {
    agent_id: z.string().describe("Human approver (typically 'human' or user ID)"),
    agent_token: z.string().optional().describe("Auth token"),
    filter_agent_id: z.string().optional().describe("Filter by proposing agent"),
    filter_domain: z.string().optional().describe("Filter by domain"),
    filter_min_confidence: z.number().optional().describe("Minimum confidence"),
    filter_min_trust_score: z.number().optional().describe("Minimum trust score"),
    feedback: z.string().describe("Feedback/reason for bulk approval"),
  },
}, async ({ agent_id, agent_token, filter_agent_id, filter_domain, filter_min_confidence, filter_min_trust_score, feedback }) => {
  try {
    verifyAgent(agent_id, agent_token);
  } catch (err) {
    return authErrorResponse(err as AuthError);
  }

  const result = await bulk.batchApprove({
    filter: {
      agent_id: filter_agent_id,
      domain: filter_domain,
      min_confidence: filter_min_confidence,
      min_trust_score: filter_min_trust_score,
    },
    feedback,
    session_id: SESSION_ID,
  });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        batch_id: result.batch_id,
        count: result.count,
        approved: result.approved,
        rejected: result.rejected,
        errors: result.errors.slice(0, 5), // first 5 errors only
        error_count: result.errors.length,
      }, null, 2),
    }],
  };
});

// ─── Tool 11: cowork_bulk_reject ─────────────────────────────────────────────
server.registerTool("cowork_bulk_reject", {
  title: "Batch reject multiple proposals",
  description:
    "Reject multiple pending proposals at once. Each receives the same override reason.",
  inputSchema: {
    agent_id: z.string().describe("Human approver"),
    agent_token: z.string().optional().describe("Auth token"),
    filter_domain: z.string().optional().describe("Filter by domain"),
    override_type: z.enum([
      "agent_wrong",
      "human_preference",
      "missing_context",
      "policy_change",
      "edge_case",
    ]).describe("Override category"),
    severity: z.enum(["low", "medium", "high", "critical"]).optional().describe("Severity"),
    description: z.string().describe("Why proposals are being rejected"),
  },
}, async ({ agent_id, agent_token, filter_domain, override_type, severity, description }) => {
  try {
    verifyAgent(agent_id, agent_token);
  } catch (err) {
    return authErrorResponse(err as AuthError);
  }

  const result = await bulk.batchReject({
    filter: {
      domain: filter_domain,
    },
    override_type,
    severity,
    description,
    session_id: SESSION_ID,
  });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        batch_id: result.batch_id,
        count: result.count,
        rejected: result.rejected,
        errors: result.errors.slice(0, 5),
        error_count: result.errors.length,
      }, null, 2),
    }],
  };
});

// ─── Tool 12: cowork_audit_trail ────────────────────────────────────────────
server.registerTool("cowork_audit_trail", {
  title: "Get full audit trail for a proposal",
  description:
    "Retrieve the complete audit chain: propose → approve → execute → verify. " +
    "Checks if all steps completed in order and links to Sentry traces.",
  inputSchema: {
    agent_id: z.string().describe("Requester"),
    agent_token: z.string().optional().describe("Auth token"),
    proposal_id: z.string().describe("Proposal to audit"),
  },
}, async ({ agent_id, agent_token, proposal_id }) => {
  try {
    verifyAgent(agent_id, agent_token);
  } catch (err) {
    return authErrorResponse(err as AuthError);
  }

  const trail = audit.getAuditTrail(proposal_id);
  const verified = audit.verifyChain(proposal_id);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        proposal_id,
        found: !!trail,
        verified,
        trail: trail
          ? {
              id: trail.id,
              agent_id: trail.agent_id,
              action: trail.action,
              status: trail.status,
              proposal_timestamp: trail.proposal_timestamp,
              approved_timestamp: trail.approved_timestamp,
              executed_timestamp: trail.executed_timestamp,
              sentry_trace_id: trail.sentry_trace_id,
              notes: trail.notes,
            }
          : null,
      }, null, 2),
    }],
  };
});

// ─── Tool 13: cowork_governance_report ───────────────────────────────────────
server.registerTool("cowork_governance_report", {
  title: "Governance and compliance report",
  description:
    "Analyze audit logs to detect governance issues: orphaned executions, " +
    "missing approvals, intent gaps, slow decisions. Recommendations for policy fixes.",
  inputSchema: {
    agent_id: z.string().describe("Requester (should be admin)"),
    agent_token: z.string().optional().describe("Auth token"),
    agent_id_filter: z.string().optional().describe("Filter by agent"),
    domain_filter: z.string().optional().describe("Filter by domain"),
    start_time: z.string().optional().describe("ISO 8601 timestamp"),
    end_time: z.string().optional().describe("ISO 8601 timestamp"),
  },
}, async ({ agent_id, agent_token, agent_id_filter, domain_filter, start_time, end_time }) => {
  try {
    verifyAgent(agent_id, agent_token);
  } catch (err) {
    return authErrorResponse(err as AuthError);
  }

  const report = audit.getAuditReport({
    agent_id: agent_id_filter,
    domain: domain_filter,
    start_time,
    end_time,
  });

  const issues = audit.getGovernanceIssues();

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        audit_report: {
          total: report.total,
          proposed: report.proposed,
          approved: report.approved,
          executed: report.executed,
          orphaned: report.orphaned,
          verified_chains: report.verified_chains,
        },
        governance_issues: issues.slice(0, 10).map((i) => ({
          type: i.type,
          severity: i.severity,
          agent_id: i.record.agent_id,
          proposal_id: i.record.proposal_id,
          recommendation: i.recommendation,
        })),
        issue_count: issues.length,
      }, null, 2),
    }],
  };
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const authStatus = registry.isOpenMode()
    ? "open mode (demo)"
    : `closed mode (${registry.size()} agents)`;
  console.error("🤝 COWORK MCP Server v0.1.0 started");
  console.error(`   Auth: ${authStatus} | Mode: ${config.authority.default_mode} | Trust default: ${config.trust.default_level}`);
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
