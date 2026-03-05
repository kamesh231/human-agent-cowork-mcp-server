#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CoworkStore } from "./storage.js";
import { loadConfig } from "./config.js";
const config = loadConfig();
const store = new CoworkStore(config.storage?.path ?? "./cowork-data.json");
const SESSION_ID = `session_${Date.now()}`;
const server = new McpServer({ name: "cowork-protocol", version: "0.1.0" });

function isHighRisk(field: string): boolean {
  return config.authority.high_risk_fields.some(p => p.endsWith("*") ? field.startsWith(p.slice(0,-1)) : field === p);
}

function determineMode(score: number, field?: string): "act"|"suggest"|"escalate" {
  if (field && isHighRisk(field)) return "suggest";
  if (score >= 0.8) return "act";
  if (score >= 0.5) return "suggest";
  return "escalate";
}

// ─── Tool 1: cowork_propose ──────────────────────────
server.registerTool("cowork_propose", {
  title: "Propose an action (COWORK: Intent Declaration)",
  description: "Before taking any action, propose it through COWORK. Checks trust level and returns whether to act, suggest for review, or escalate. Agents propose — they don't just act.",
  inputSchema: {
    agent_id: z.string().describe("Agent identifier"),
    domain: z.string().describe("Domain (e.g. 'crm.deals', 'support.tickets')"),
    action: z.string().describe("What the agent wants to do"),
    target: z.string().describe("What it targets (record ID, etc)"),
    proposed_change: z.string().describe("JSON describing the proposed change"),
    confidence: z.number().min(0).max(1).describe("Confidence 0.0-1.0"),
    reasoning: z.string().describe("Why the agent wants to do this"),
    field: z.string().optional().describe("Specific field being modified"),
  },
}, async ({ agent_id, domain, action, target, proposed_change, confidence, reasoning, field }) => {
  const trust = store.getOrCreateTrust(agent_id, domain, config.trust.default_level);
  const mode = determineMode(trust.score, field);
  let changeObj: any;
  try { changeObj = JSON.parse(proposed_change); } catch { changeObj = { raw: proposed_change }; }

  const actionRec = store.addAction({ agent_id, action_type: "propose", domain, description: `${action} on ${target}`, confidence, reasoning, status: mode === "act" ? "executed" : "proposed", actor: "agent" });
  const proposal = store.addProposal({ action_id: actionRec.id, proposed_change: changeObj, trust_at_proposal: trust.score, threshold_required: field && isHighRisk(field) ? 1.0 : 0.8, auto_approved: mode === "act", human_decision: mode === "act" ? "approved" : null, human_reason: mode === "act" ? "Auto-approved: trust sufficient" : null, decided_at: mode === "act" ? new Date().toISOString() : null });
  store.updateTrust(agent_id, domain, { total_actions: trust.total_actions + 1 });
  if (mode === "act") store.updateTrust(agent_id, domain, { approved_actions: trust.approved_actions + 1, consecutive_overrides: 0, accuracy: (trust.approved_actions + 1) / (trust.total_actions + 1) });
  store.addTimelineEvent({ session_id: SESSION_ID, actor: "agent", event_type: "proposal", reference_id: proposal.id, summary: `Proposed: ${action} on ${target} (conf: ${confidence}, trust: ${trust.score.toFixed(2)}, mode: ${mode})` });

  const msg = mode === "act" ? `✅ AUTO-APPROVED: Trust (${trust.score.toFixed(2)}) sufficient.` : mode === "suggest" ? `⏳ AWAITING REVIEW: Proposal ${proposal.id}` : `🚨 ESCALATED: Trust (${trust.score.toFixed(2)}) too low. Proposal ${proposal.id}`;
  return { content: [{ type: "text" as const, text: JSON.stringify({ proposal_id: proposal.id, action_id: actionRec.id, mode, trust_level: trust.score, confidence, high_risk_field: field ? isHighRisk(field) : false, message: msg }, null, 2) }] };
});

// ─── Tool 2: cowork_check_trust ──────────────────────
server.registerTool("cowork_check_trust", {
  title: "Check trust level (COWORK: Trust Score)",
  description: "Check current trust level for an agent in a domain. Returns score, accuracy, and operating mode (act/suggest/escalate).",
  inputSchema: {
    agent_id: z.string().describe("Agent identifier"),
    domain: z.string().describe("Domain to check"),
    field: z.string().optional().describe("Field for high-risk check"),
  },
}, async ({ agent_id, domain, field }) => {
  const trust = store.getOrCreateTrust(agent_id, domain, config.trust.default_level);
  const mode = determineMode(trust.score, field);
  return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id, domain, trust_score: trust.score, accuracy: trust.accuracy, total_actions: trust.total_actions, overridden_actions: trust.overridden_actions, consecutive_overrides: trust.consecutive_overrides, mode, high_risk: field ? isHighRisk(field) : false, message: `Trust: ${trust.score.toFixed(2)} | Mode: ${mode} | Accuracy: ${(trust.accuracy*100).toFixed(1)}% over ${trust.total_actions} actions` }, null, 2) }] };
});

// ─── Tool 3: cowork_handoff ──────────────────────────
server.registerTool("cowork_handoff", {
  title: "Handoff to human (COWORK: Context Packet)",
  description: "Hand off to human with structured context: what was tried, confidence level, reasoning. Human receives everything needed to continue.",
  inputSchema: {
    agent_id: z.string().describe("Agent identifier"),
    domain: z.string().describe("Domain"),
    reason: z.string().describe("Why handing off"),
    confidence: z.number().min(0).max(1).describe("Confidence at handoff"),
    attempted_actions: z.string().describe("JSON array of actions tried"),
    context: z.string().describe("JSON context for the human"),
    handoff_mode: z.enum(["escalate","review","collaborate"]).describe("escalate/review/collaborate"),
  },
}, async ({ agent_id, domain, reason, confidence, attempted_actions, context, handoff_mode }) => {
  let attempts: string[]; try { attempts = JSON.parse(attempted_actions); } catch { attempts = [attempted_actions]; }
  let ctx: any; try { ctx = JSON.parse(context); } catch { ctx = { raw: context }; }
  const handoff = store.addHandoff({ agent_id, domain, reason, confidence_at_handoff: confidence, context_packet: { mode: handoff_mode, reason, confidence, attempted: attempts, context: ctx }, attempted_actions: attempts, resolution: null, resolved_at: null });
  store.addAction({ agent_id, action_type: "escalate", domain, description: `Handoff (${handoff_mode}): ${reason}`, confidence, reasoning: reason, status: "proposed", actor: "agent" });
  store.addTimelineEvent({ session_id: SESSION_ID, actor: "agent", event_type: "handoff", reference_id: handoff.id, summary: `Handoff (${handoff_mode}): ${reason} | Conf: ${confidence} | ${attempts.length} attempts` });
  return { content: [{ type: "text" as const, text: JSON.stringify({ handoff_id: handoff.id, mode: handoff_mode, message: `🤝 HANDOFF (${handoff_mode.toUpperCase()}): ${reason}`, context_packet: { tried: attempts, confidence, reasoning: reason, context: ctx }, for_human: `Agent handing off (${handoff_mode}). Tried ${attempts.length} approach(es), confidence ${confidence}. Reason: ${reason}` }, null, 2) }] };
});

// ─── Tool 4: cowork_log ─────────────────────────────
server.registerTool("cowork_log", {
  title: "Log action (COWORK: Action Attribution)",
  description: "Log any action with attribution: who did it (agent/human/collaborative), what domain, why.",
  inputSchema: {
    agent_id: z.string(), domain: z.string(), action: z.string(),
    actor: z.enum(["agent","human","collaborative"]).describe("Who performed it"),
    confidence: z.number().min(0).max(1).optional(),
    reasoning: z.string().optional(),
  },
}, async ({ agent_id, domain, action, actor, confidence, reasoning }) => {
  const rec = store.addAction({ agent_id, action_type: "log", domain, description: action, confidence: confidence||0, reasoning: reasoning||"", status: "executed", actor });
  store.addTimelineEvent({ session_id: SESSION_ID, actor, event_type: "action", reference_id: rec.id, summary: `[${actor.toUpperCase()}] ${action}` });
  return { content: [{ type: "text" as const, text: JSON.stringify({ action_id: rec.id, logged: true, message: `📝 Logged: [${actor}] ${action}` }, null, 2) }] };
});

// ─── Tool 5: cowork_override ─────────────────────────
server.registerTool("cowork_override", {
  title: "Record override (COWORK: Override Signal)",
  description: "Human corrects agent action. Reason type matters: 'agent_wrong' hits trust hard, 'human_preference' barely affects it. Feeds back into trust model.",
  inputSchema: {
    agent_id: z.string(), domain: z.string(),
    action_description: z.string().describe("What's being overridden"),
    override_type: z.enum(["agent_wrong","human_preference","missing_context","policy_change","edge_case"]),
    description: z.string().describe("Details about the correction"),
    proposal_id: z.string().optional(),
  },
}, async ({ agent_id, domain, action_description, override_type, description, proposal_id }) => {
  const action = store.addAction({ agent_id, action_type: "propose", domain, description: action_description, confidence: 0, reasoning: "Overridden", status: "rejected", actor: "agent" });
  const impacts: Record<string,number> = { agent_wrong: -0.08, human_preference: -0.01, missing_context: -0.03, policy_change: 0, edge_case: -0.02 };
  const impact = impacts[override_type] ?? -0.05;
  const override = store.addOverride({ action_id: action.id, override_type, description, trust_impact: impact });
  const trust = store.getOrCreateTrust(agent_id, domain, config.trust.default_level);
  const newConsec = trust.consecutive_overrides + 1;
  const demoted = newConsec >= config.trust.auto_demote_after;
  const newScore = Math.max(0, Math.min(1, trust.score + impact - (demoted ? 0.1 : 0)));
  store.updateTrust(agent_id, domain, { score: newScore, overridden_actions: trust.overridden_actions+1, total_actions: trust.total_actions+1, consecutive_overrides: newConsec, accuracy: trust.total_actions > 0 ? trust.approved_actions/(trust.total_actions+1) : 0 });
  if (proposal_id) { try { store.updateProposal(proposal_id, { human_decision: "rejected", human_reason: `${override_type}: ${description}`, decided_at: new Date().toISOString() }); } catch {} }
  store.addTimelineEvent({ session_id: SESSION_ID, actor: "human", event_type: "override", reference_id: override.id, summary: `Override (${override_type}): ${description} | Impact: ${impact} → ${newScore.toFixed(2)}${demoted?" [DEMOTED]":""}` });
  return { content: [{ type: "text" as const, text: JSON.stringify({ override_id: override.id, override_type, trust_impact: impact, new_trust: newScore, demoted, message: `⚠️ OVERRIDE (${override_type}): ${description}\nTrust: ${trust.score.toFixed(2)} → ${newScore.toFixed(2)}${demoted?" [DEMOTED]":""}` }, null, 2) }] };
});

// ─── Tool 6: cowork_status ───────────────────────────
server.registerTool("cowork_status", {
  title: "Collaboration dashboard (COWORK: Status)",
  description: "Full dashboard: trust scores, action stats, override rates, pending proposals, open handoffs, timeline.",
  inputSchema: {
    agent_id: z.string().optional(),
    include_timeline: z.boolean().optional(),
    timeline_limit: z.number().optional(),
  },
}, async ({ agent_id, include_timeline, timeline_limit }) => {
  const stats = store.getStats();
  const trusts = store.getAllTrust(agent_id ?? undefined);
  const pending = store.getPendingProposals();
  const handoffs = store.getOpenHandoffs();
  const timeline = include_timeline !== false ? store.getTimeline(undefined, timeline_limit || 20) : [];

  let text = `═══ COWORK DASHBOARD ═══\n`;
  text += `📊 ${stats.total_actions} actions | ${stats.approved_actions} approved | ${stats.overrides} overrides (${stats.override_rate})\n`;
  text += `📋 ${pending.length} pending proposals | ${handoffs.length} open handoffs\n\n`;
  if (trusts.length > 0) { text += `🔐 Trust:\n`; for (const t of trusts) text += `   ${t.agent_id}:${t.domain} → ${t.score.toFixed(2)} (${determineMode(t.score)}) | ${t.total_actions} actions\n`; text += `\n`; }
  if (timeline.length > 0) { text += `📜 Timeline:\n`; for (const e of timeline.slice(-10)) text += `   [${e.actor}] ${e.summary}\n`; }

  return { content: [
    { type: "text" as const, text },
    { type: "text" as const, text: JSON.stringify({ session_id: SESSION_ID, stats, trust_scores: trusts, pending_proposals: pending.length, open_handoffs: handoffs.length, timeline: timeline.slice(-20), config: { default_trust: config.trust.default_level, default_mode: config.authority.default_mode, volume_cap: config.authority.volume_cap } }, null, 2) },
  ] };
});

// ─── Start ───────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🤝 COWORK MCP Server v0.1.0 started");
  console.error(`   Mode: ${config.authority.default_mode} | Trust default: ${config.trust.default_level} | Storage: ${config.storage.path}`);
}
main().catch(e => { console.error("Fatal:", e); process.exit(1); });
