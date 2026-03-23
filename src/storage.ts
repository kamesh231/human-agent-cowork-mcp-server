import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { CoworkConfig } from "./config.js";

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
  instructions: string | null;
  hand_back: boolean;
  instructions_read: boolean;
}

export interface TimelineEvent {
  id: string; session_id: string; actor: string; event_type: string;
  reference_id: string; summary: string; created_at: string;
}

export class CoworkStore {
  private db: Database.Database;

  constructor(dbPath: string, private readonly config?: CoworkConfig) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trust_scores (
        agent_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0.3,
        accuracy REAL NOT NULL DEFAULT 0,
        total_actions INTEGER NOT NULL DEFAULT 0,
        approved_actions INTEGER NOT NULL DEFAULT 0,
        overridden_actions INTEGER NOT NULL DEFAULT 0,
        consecutive_overrides INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL,
        PRIMARY KEY (agent_id, domain)
      );

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        domain TEXT NOT NULL,
        description TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        reasoning TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        proposed_change TEXT NOT NULL,
        trust_at_proposal REAL NOT NULL,
        threshold_required REAL NOT NULL,
        auto_approved INTEGER NOT NULL DEFAULT 0,
        human_decision TEXT,
        human_reason TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS overrides (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        override_type TEXT NOT NULL,
        description TEXT NOT NULL,
        trust_impact REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence_at_handoff REAL NOT NULL,
        context_packet TEXT NOT NULL,
        attempted_actions TEXT NOT NULL,
        resolution TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS timeline (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trust_agent ON trust_scores(agent_id);
      CREATE INDEX IF NOT EXISTS idx_actions_agent ON actions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_proposals_decision ON proposals(human_decision);
      CREATE INDEX IF NOT EXISTS idx_handoffs_resolved ON handoffs(resolved_at);
      CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline(session_id);
    `);
    // Migrations for existing databases
    try { this.db.exec("ALTER TABLE handoffs ADD COLUMN instructions TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE handoffs ADD COLUMN hand_back INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE handoffs ADD COLUMN instructions_read INTEGER NOT NULL DEFAULT 0"); } catch {}
  }

  private now(): string { return new Date().toISOString(); }
  private uuid(): string { return randomUUID(); }

  // ─── Trust ──────────────────────────
  getTrust(agentId: string, domain: string): TrustScore | null {
    return this.db.prepare("SELECT * FROM trust_scores WHERE agent_id = ? AND domain = ?").get(agentId, domain) as TrustScore | undefined ?? null;
  }

  getOrCreateTrust(agentId: string, domain: string, defaultLevel: number): TrustScore {
    let t = this.getTrust(agentId, domain);
    if (!t) {
      const now = this.now();
      this.db.prepare(
        "INSERT INTO trust_scores (agent_id, domain, score, accuracy, total_actions, approved_actions, overridden_actions, consecutive_overrides, last_updated) VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?)"
      ).run(agentId, domain, defaultLevel, now);
      t = this.getTrust(agentId, domain)!;
    }
    // Apply time-based decay
    const decayPerDay = this.config?.trust?.decay_per_day ?? 0.01;
    const daysSince = (Date.now() - new Date(t.last_updated).getTime()) / (1000 * 86400);
    const decayAmount = daysSince * decayPerDay;
    if (decayAmount > 0.001) {
      const newScore = Math.max(0.1, t.score - decayAmount);
      this.db.prepare("UPDATE trust_scores SET score = ?, last_updated = ? WHERE agent_id = ? AND domain = ?")
        .run(newScore, new Date().toISOString(), agentId, domain);
      t = { ...t, score: newScore };
    }
    return t;
  }

  updateTrust(agentId: string, domain: string, updates: Partial<TrustScore>): TrustScore {
    const existing = this.getTrust(agentId, domain);
    if (!existing) throw new Error(`No trust: ${agentId}:${domain}`);
    const merged = { ...existing, ...updates, last_updated: this.now() };
    this.db.prepare(
      "UPDATE trust_scores SET score=?, accuracy=?, total_actions=?, approved_actions=?, overridden_actions=?, consecutive_overrides=?, last_updated=? WHERE agent_id=? AND domain=?"
    ).run(merged.score, merged.accuracy, merged.total_actions, merged.approved_actions, merged.overridden_actions, merged.consecutive_overrides, merged.last_updated, agentId, domain);
    return merged;
  }

  getAllTrust(agentId?: string): TrustScore[] {
    if (agentId) return this.db.prepare("SELECT * FROM trust_scores WHERE agent_id = ?").all(agentId) as TrustScore[];
    return this.db.prepare("SELECT * FROM trust_scores").all() as TrustScore[];
  }

  // ─── Actions ────────────────────────
  addAction(a: Omit<Action, "id" | "created_at">): Action {
    const id = this.uuid();
    const created_at = this.now();
    this.db.prepare(
      "INSERT INTO actions (id, agent_id, action_type, domain, description, confidence, reasoning, status, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, a.agent_id, a.action_type, a.domain, a.description, a.confidence, a.reasoning, a.status, a.actor, created_at);
    return { ...a, id, created_at };
  }

  updateAction(id: string, updates: Partial<Action>): Action {
    const existing = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Action | undefined;
    if (!existing) throw new Error(`Action ${id} not found`);
    const merged = { ...existing, ...updates };
    this.db.prepare(
      "UPDATE actions SET agent_id=?, action_type=?, domain=?, description=?, confidence=?, reasoning=?, status=?, actor=? WHERE id=?"
    ).run(merged.agent_id, merged.action_type, merged.domain, merged.description, merged.confidence, merged.reasoning, merged.status, merged.actor, id);
    return merged;
  }

  getRecentActions(limit = 20): Action[] {
    return this.db.prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT ?").all(limit) as Action[];
  }

  // ─── Proposals ──────────────────────
  addProposal(p: Omit<Proposal, "id" | "created_at">): Proposal {
    const id = this.uuid();
    const created_at = this.now();
    this.db.prepare(
      "INSERT INTO proposals (id, action_id, proposed_change, trust_at_proposal, threshold_required, auto_approved, human_decision, human_reason, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, p.action_id, JSON.stringify(p.proposed_change), p.trust_at_proposal, p.threshold_required, p.auto_approved ? 1 : 0, p.human_decision, p.human_reason, p.decided_at, created_at);
    return { ...p, id, created_at };
  }

  updateProposal(id: string, updates: Partial<Proposal>): Proposal {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Proposal ${id} not found`);
    const existing = { ...row, proposed_change: JSON.parse(row.proposed_change), auto_approved: !!row.auto_approved } as Proposal;
    const merged = { ...existing, ...updates };
    this.db.prepare(
      "UPDATE proposals SET human_decision=?, human_reason=?, decided_at=? WHERE id=?"
    ).run(merged.human_decision, merged.human_reason, merged.decided_at, id);
    return merged;
  }

  getPendingProposals(): Proposal[] {
    const rows = this.db.prepare("SELECT * FROM proposals WHERE human_decision IS NULL").all() as any[];
    return rows.map(r => ({ ...r, proposed_change: JSON.parse(r.proposed_change), auto_approved: !!r.auto_approved }));
  }

  // ─── Overrides ──────────────────────
  addOverride(o: Omit<Override, "id" | "created_at">): Override {
    const id = this.uuid();
    const created_at = this.now();
    this.db.prepare(
      "INSERT INTO overrides (id, action_id, override_type, description, trust_impact, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, o.action_id, o.override_type, o.description, o.trust_impact, created_at);
    return { ...o, id, created_at };
  }

  // ─── Handoffs ───────────────────────
  addHandoff(h: Omit<Handoff, "id" | "created_at">): Handoff {
    const id = this.uuid();
    const created_at = this.now();
    this.db.prepare(
      "INSERT INTO handoffs (id, agent_id, domain, reason, confidence_at_handoff, context_packet, attempted_actions, resolution, resolved_at, instructions, hand_back, instructions_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, h.agent_id, h.domain, h.reason, h.confidence_at_handoff, JSON.stringify(h.context_packet), JSON.stringify(h.attempted_actions), h.resolution, h.resolved_at, h.instructions ?? null, h.hand_back ? 1 : 0, h.instructions_read ? 1 : 0, created_at);
    return { ...h, id, created_at };
  }

  private mapHandoffRow(r: any): Handoff {
    return {
      ...r,
      context_packet: JSON.parse(r.context_packet),
      attempted_actions: JSON.parse(r.attempted_actions),
      hand_back: !!r.hand_back,
      instructions_read: !!r.instructions_read,
      instructions: r.instructions ?? null,
    };
  }

  getOpenHandoffs(): Handoff[] {
    const rows = this.db.prepare("SELECT * FROM handoffs WHERE resolved_at IS NULL").all() as any[];
    return rows.map(r => this.mapHandoffRow(r));
  }

  resolveHandoff(id: string, resolution: string, instructions?: string, handBack?: boolean): Handoff {
    const now = this.now();
    const info = this.db.prepare(
      "UPDATE handoffs SET resolution=?, resolved_at=?, instructions=?, hand_back=? WHERE id=?"
    ).run(resolution, now, instructions ?? null, handBack ? 1 : 0, id);
    if (info.changes === 0) throw new Error(`Handoff ${id} not found`);
    const row = this.db.prepare("SELECT * FROM handoffs WHERE id=?").get(id) as any;
    return this.mapHandoffRow(row);
  }

  getProposalCountLastHour(agentId: string, domain: string): number {
    const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM actions WHERE agent_id = ? AND domain = ? AND action_type = 'propose' AND created_at >= ?"
    ).get(agentId, domain, cutoff) as any;
    return row?.c ?? 0;
  }

  getPendingCallbacks(agentId: string, domain?: string): Handoff[] {
    let rows: any[];
    if (domain) {
      rows = this.db.prepare(
        "SELECT * FROM handoffs WHERE agent_id = ? AND resolved_at IS NOT NULL AND hand_back = 1 AND instructions_read = 0 AND domain = ?"
      ).all(agentId, domain) as any[];
    } else {
      rows = this.db.prepare(
        "SELECT * FROM handoffs WHERE agent_id = ? AND resolved_at IS NOT NULL AND hand_back = 1 AND instructions_read = 0"
      ).all(agentId) as any[];
    }
    return rows.map(r => this.mapHandoffRow(r));
  }

  markCallbackRead(handoffId: string): void {
    this.db.prepare("UPDATE handoffs SET instructions_read = 1 WHERE id = ?").run(handoffId);
  }

  // ─── Timeline ───────────────────────
  addTimelineEvent(e: Omit<TimelineEvent, "id" | "created_at">): TimelineEvent {
    const id = this.uuid();
    const created_at = this.now();
    this.db.prepare(
      "INSERT INTO timeline (id, session_id, actor, event_type, reference_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, e.session_id, e.actor, e.event_type, e.reference_id, e.summary, created_at);
    return { ...e, id, created_at };
  }

  getTimeline(sessionId?: string, limit = 50): TimelineEvent[] {
    if (sessionId) return this.db.prepare("SELECT * FROM timeline WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(sessionId, limit) as TimelineEvent[];
    return this.db.prepare("SELECT * FROM timeline ORDER BY created_at DESC LIMIT ?").all(limit) as TimelineEvent[];
  }

  // ─── Stats ──────────────────────────
  getStats() {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM actions").get() as any).c;
    const approved = (this.db.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('approved', 'executed')").get() as any).c;
    const overrides = (this.db.prepare("SELECT COUNT(*) as c FROM overrides").get() as any).c;

    const reasonRows = this.db.prepare("SELECT override_type, COUNT(*) as c FROM overrides GROUP BY override_type").all() as any[];
    const reasons: Record<string, number> = {};
    for (const r of reasonRows) reasons[r.override_type] = r.c;

    const trustScores = this.getAllTrust();

    return {
      total_actions: total,
      approved_actions: approved,
      overrides,
      override_rate: total > 0 ? `${(overrides / total * 100).toFixed(1)}%` : "0%",
      pending_proposals: (this.db.prepare("SELECT COUNT(*) as c FROM proposals WHERE human_decision IS NULL").get() as any).c,
      open_handoffs: (this.db.prepare("SELECT COUNT(*) as c FROM handoffs WHERE resolved_at IS NULL").get() as any).c,
      override_reasons: reasons,
      trust_scores: trustScores.map(t => ({
        agent: t.agent_id, domain: t.domain,
        score: t.score.toFixed(2),
        accuracy: `${(t.accuracy * 100).toFixed(1)}%`,
        sample_size: t.total_actions,
      })),
    };
  }

  /**
   * Run a set of store operations inside a single BEGIN EXCLUSIVE transaction.
   *
   * Use this wherever multiple reads + writes must be atomic (e.g. trust
   * read → mode decision → action insert → trust update).  SQLite exclusive
   * mode prevents any other reader from observing an intermediate state and
   * any other writer from racing on the same rows.
   *
   * Example:
   *   const result = store.transaction(() => {
   *     const trust = store.getOrCreateTrust(id, domain, 0.3);
   *     store.addAction({ ... });
   *     store.updateTrust(id, domain, { score: trust.score + 0.02 });
   *     return trust;
   *   });
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).exclusive();
  }

  close(): void {
    this.db.close();
  }
}
