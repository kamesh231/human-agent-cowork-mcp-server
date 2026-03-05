import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";

export interface TrustScore {
  agent_id: string; domain: string; score: number; accuracy: number;
  total_actions: number; approved_actions: number; overridden_actions: number;
  consecutive_overrides: number; last_updated: string;
}

export interface Action {
  id: string; agent_id: string; action_type: string; domain: string;
  description: string; confidence: number; reasoning: string;
  status: string; actor: string; created_at: string;
}

export interface Proposal {
  id: string; action_id: string; proposed_change: any; trust_at_proposal: number;
  threshold_required: number; auto_approved: boolean;
  human_decision: string | null; human_reason: string | null;
  decided_at: string | null; created_at: string;
}

export interface Override {
  id: string; action_id: string; override_type: string;
  description: string; trust_impact: number; created_at: string;
}

export interface Handoff {
  id: string; agent_id: string; domain: string; reason: string;
  confidence_at_handoff: number; context_packet: any;
  attempted_actions: string[]; resolution: string | null;
  resolved_at: string | null; created_at: string;
}

export interface TimelineEvent {
  id: string; session_id: string; actor: string; event_type: string;
  reference_id: string; summary: string; created_at: string;
}

interface CoworkData {
  trust_scores: TrustScore[]; actions: Action[]; proposals: Proposal[];
  overrides: Override[]; handoffs: Handoff[]; timeline: TimelineEvent[];
}

export class CoworkStore {
  private data: CoworkData;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    if (existsSync(filePath)) {
      this.data = JSON.parse(readFileSync(filePath, "utf-8"));
    } else {
      this.data = { trust_scores: [], actions: [], proposals: [], overrides: [], handoffs: [], timeline: [] };
      this.save();
    }
  }

  private save() { writeFileSync(this.filePath, JSON.stringify(this.data, null, 2)); }
  private now() { return new Date().toISOString(); }
  private uuid() { return randomUUID(); }

  // ─── Trust ──────────────────────────
  getTrust(agentId: string, domain: string): TrustScore | null {
    return this.data.trust_scores.find(t => t.agent_id === agentId && t.domain === domain) || null;
  }

  getOrCreateTrust(agentId: string, domain: string, defaultLevel: number): TrustScore {
    let t = this.getTrust(agentId, domain);
    if (!t) {
      t = { agent_id: agentId, domain, score: defaultLevel, accuracy: 0, total_actions: 0,
            approved_actions: 0, overridden_actions: 0, consecutive_overrides: 0, last_updated: this.now() };
      this.data.trust_scores.push(t);
      this.save();
    }
    return t;
  }

  updateTrust(agentId: string, domain: string, updates: Partial<TrustScore>): TrustScore {
    const idx = this.data.trust_scores.findIndex(t => t.agent_id === agentId && t.domain === domain);
    if (idx === -1) throw new Error(`No trust: ${agentId}:${domain}`);
    this.data.trust_scores[idx] = { ...this.data.trust_scores[idx], ...updates, last_updated: this.now() };
    this.save();
    return this.data.trust_scores[idx];
  }

  getAllTrust(agentId?: string): TrustScore[] {
    return agentId ? this.data.trust_scores.filter(t => t.agent_id === agentId) : this.data.trust_scores;
  }

  // ─── Actions ────────────────────────
  addAction(a: Omit<Action, "id" | "created_at">): Action {
    const full: Action = { ...a, id: this.uuid(), created_at: this.now() };
    this.data.actions.push(full);
    this.save();
    return full;
  }

  updateAction(id: string, updates: Partial<Action>): Action {
    const idx = this.data.actions.findIndex(a => a.id === id);
    if (idx === -1) throw new Error(`Action ${id} not found`);
    this.data.actions[idx] = { ...this.data.actions[idx], ...updates };
    this.save();
    return this.data.actions[idx];
  }

  getRecentActions(limit = 20): Action[] { return this.data.actions.slice(-limit); }

  // ─── Proposals ──────────────────────
  addProposal(p: Omit<Proposal, "id" | "created_at">): Proposal {
    const full: Proposal = { ...p, id: this.uuid(), created_at: this.now() };
    this.data.proposals.push(full);
    this.save();
    return full;
  }

  updateProposal(id: string, updates: Partial<Proposal>): Proposal {
    const idx = this.data.proposals.findIndex(p => p.id === id);
    if (idx === -1) throw new Error(`Proposal ${id} not found`);
    this.data.proposals[idx] = { ...this.data.proposals[idx], ...updates };
    this.save();
    return this.data.proposals[idx];
  }

  getPendingProposals(): Proposal[] { return this.data.proposals.filter(p => p.human_decision === null); }

  // ─── Overrides ──────────────────────
  addOverride(o: Omit<Override, "id" | "created_at">): Override {
    const full: Override = { ...o, id: this.uuid(), created_at: this.now() };
    this.data.overrides.push(full);
    this.save();
    return full;
  }

  // ─── Handoffs ───────────────────────
  addHandoff(h: Omit<Handoff, "id" | "created_at">): Handoff {
    const full: Handoff = { ...h, id: this.uuid(), created_at: this.now() };
    this.data.handoffs.push(full);
    this.save();
    return full;
  }

  getOpenHandoffs(): Handoff[] { return this.data.handoffs.filter(h => h.resolved_at === null); }

  resolveHandoff(id: string, resolution: string): Handoff {
    const idx = this.data.handoffs.findIndex(h => h.id === id);
    if (idx === -1) throw new Error(`Handoff ${id} not found`);
    this.data.handoffs[idx].resolution = resolution;
    this.data.handoffs[idx].resolved_at = this.now();
    this.save();
    return this.data.handoffs[idx];
  }

  // ─── Timeline ───────────────────────
  addTimelineEvent(e: Omit<TimelineEvent, "id" | "created_at">): TimelineEvent {
    const full: TimelineEvent = { ...e, id: this.uuid(), created_at: this.now() };
    this.data.timeline.push(full);
    this.save();
    return full;
  }

  getTimeline(sessionId?: string, limit = 50): TimelineEvent[] {
    const events = sessionId ? this.data.timeline.filter(e => e.session_id === sessionId) : this.data.timeline;
    return events.slice(-limit);
  }

  // ─── Stats ──────────────────────────
  getStats() {
    const total = this.data.actions.length;
    const approved = this.data.actions.filter(a => a.status === "approved" || a.status === "executed").length;
    const overrides = this.data.overrides.length;
    const reasons: Record<string, number> = {};
    for (const o of this.data.overrides) reasons[o.override_type] = (reasons[o.override_type] || 0) + 1;

    return {
      total_actions: total,
      approved_actions: approved,
      overrides,
      override_rate: total > 0 ? `${(overrides / total * 100).toFixed(1)}%` : "0%",
      pending_proposals: this.data.proposals.filter(p => p.human_decision === null).length,
      open_handoffs: this.data.handoffs.filter(h => h.resolved_at === null).length,
      override_reasons: reasons,
      trust_scores: this.data.trust_scores.map(t => ({
        agent: t.agent_id, domain: t.domain,
        score: t.score.toFixed(2),
        accuracy: `${(t.accuracy * 100).toFixed(1)}%`,
        sample_size: t.total_actions,
      })),
    };
  }
}
