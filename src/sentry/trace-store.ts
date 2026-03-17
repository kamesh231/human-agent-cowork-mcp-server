import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { ActionTrace, TraceStatus } from "./types.js";

/**
 * TraceStore — SQLite-backed persistence for the COWORK audit trail.
 *
 * Design decisions:
 *  - Uses `better-sqlite3` (synchronous) for <1ms insert latency.
 *  - WAL journal mode for concurrent read safety.
 *  - Hash chain: each row stores a `prev_hash` (SHA-256 of the prior row's
 *    canonical form). Insertions use BEGIN EXCLUSIVE to serialise hash
 *    computation and prevent chain forks under concurrency.
 */
export class TraceStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;
  private lastHashStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    // Enable WAL mode for concurrent reads + fast writes.
    this.db.pragma("journal_mode = WAL");
    // Sync only on checkpoint, not every commit — safe with WAL.
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        trace_id    TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        intent      TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        args_json   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'PENDING',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        prev_hash   TEXT NOT NULL DEFAULT '',
        timestamp   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_tool   ON audit_log (tool_name);
      CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_log (status);
      CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_log (timestamp);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO audit_log (trace_id, agent_id, intent, tool_name, args_json, status, duration_ms, prev_hash, timestamp)
      VALUES (@trace_id, @agent_id, @intent, @tool_name, @args_json, @status, @duration_ms, @prev_hash, @timestamp)
    `);

    this.updateStatusStmt = this.db.prepare(`
      UPDATE audit_log SET status = @status, duration_ms = @duration_ms WHERE trace_id = @trace_id
    `);

    this.lastHashStmt = this.db.prepare(`
      SELECT trace_id, agent_id, intent, tool_name, args_json, status, duration_ms, prev_hash, timestamp
      FROM audit_log ORDER BY rowid DESC LIMIT 1
    `);
  }

  /**
   * Compute the SHA-256 hex digest of a trace row's canonical form.
   *
   * Only immutable fields are included — `status` and `duration_ms` are excluded
   * because they are updated after the row is inserted (once the downstream call
   * resolves). Including them would break the chain whenever a status update occurs.
   */
  private static hashRow(row: ActionTrace): string {
    const canonical = JSON.stringify({
      agent_id: row.agent_id,
      args_json: row.args_json,
      intent: row.intent,
      prev_hash: row.prev_hash,
      timestamp: row.timestamp,
      tool_name: row.tool_name,
      trace_id: row.trace_id,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * Log a new ActionTrace to the audit trail.
   *
   * Uses BEGIN EXCLUSIVE to serialise the read-last-hash → compute → insert
   * sequence, preventing two concurrent callers from grabbing the same
   * prev_hash and forking the chain.
   *
   * Throws on failure — the caller (proxy) MUST block the tool call if this throws.
   */
  logTrace(trace: ActionTrace): void {
    // BEGIN EXCLUSIVE acquires an exclusive lock before reading, preventing
    // any other connection from reading or writing until we commit.
    this.db.exec("BEGIN EXCLUSIVE");
    try {
      const lastRow = this.lastHashStmt.get() as ActionTrace | undefined;
      const prevHash = lastRow ? TraceStore.hashRow(lastRow) : "";

      this.insertStmt.run({
        trace_id: trace.trace_id,
        agent_id: trace.agent_id,
        intent: trace.intent,
        tool_name: trace.tool_name,
        args_json: trace.args_json,
        status: trace.status,
        duration_ms: trace.duration_ms,
        prev_hash: prevHash,
        timestamp: trace.timestamp,
      });

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Update the status and duration of an existing trace after the downstream
   * call completes. Called by the proxy once it receives the tool result.
   */
  updateTraceStatus(traceId: string, status: TraceStatus, durationMs: number): void {
    const info = this.updateStatusStmt.run({
      trace_id: traceId,
      status,
      duration_ms: durationMs,
    });
    if (info.changes === 0) {
      throw new Error(`[TraceStore] No trace found with id: ${traceId}`);
    }
  }

  /**
   * Walk the entire audit_log in insertion order and verify that every row's
   * prev_hash matches the SHA-256 of the preceding row.
   *
   * Returns `{ valid: true }` or `{ valid: false, brokenAtTraceId, expected, actual }`.
   */
  verifyChain(): ChainVerificationResult {
    const rows = this.db
      .prepare(
        "SELECT trace_id, agent_id, intent, tool_name, args_json, status, duration_ms, prev_hash, timestamp FROM audit_log ORDER BY rowid ASC",
      )
      .all() as ActionTrace[];

    let expectedPrevHash = "";

    for (const row of rows) {
      if (row.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          brokenAtTraceId: row.trace_id,
          expected: expectedPrevHash,
          actual: row.prev_hash,
        };
      }
      expectedPrevHash = TraceStore.hashRow(row);
    }

    return { valid: true };
  }

  /**
   * Query recent traces, optionally filtered by tool name or status.
   */
  queryTraces(opts?: { toolName?: string; status?: TraceStatus; limit?: number }): ActionTrace[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts?.toolName) {
      conditions.push("tool_name = @toolName");
      params.toolName = opts.toolName;
    }
    if (opts?.status) {
      conditions.push("status = @status");
      params.status = opts.status;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit ?? 100;

    return this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY rowid DESC LIMIT @limit`)
      .all({ ...params, limit }) as ActionTrace[];
  }

  /** Close the database connection. Call on process exit. */
  close(): void {
    this.db.close();
  }
}

/** Result of `verifyChain()`. */
export type ChainVerificationResult =
  | { valid: true }
  | { valid: false; brokenAtTraceId: string; expected: string; actual: string };
