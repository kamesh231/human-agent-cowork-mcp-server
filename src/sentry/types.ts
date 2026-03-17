import { z } from "zod";
import { randomUUID } from "node:crypto";

/**
 * Zod schema for the ActionTrace record — the atomic unit of the COWORK audit trail.
 * Every MCP tool call intercepted by the Sentry proxy produces exactly one ActionTrace.
 */
export const ActionTraceSchema = z.object({
  /** Unique identifier for this trace record. */
  trace_id: z.string().uuid().default(() => randomUUID()),

  /** Session-level identifier for the agent that initiated the call. */
  agent_id: z.string().min(1),

  /** The agent's stated reasoning / justification for making this tool call. */
  intent: z.string().min(1),

  /** Name of the MCP tool being invoked. */
  tool_name: z.string().min(1),

  /** Sanitized, stringified JSON of the tool arguments. */
  args_json: z.string(),

  /** Lifecycle status — starts PENDING, updated after the downstream call resolves. */
  status: z.enum(["PENDING", "COMPLETED", "FAILED"]).default("PENDING"),

  /** Wall-clock duration of the downstream tool call in milliseconds. */
  duration_ms: z.number().int().nonnegative().default(0),

  /** SHA-256 hex digest of the previous audit_log row — forms a tamper-evident chain. */
  prev_hash: z.string().default(""),

  /** ISO 8601 timestamp of when the trace was created. */
  timestamp: z.string().datetime().default(() => new Date().toISOString()),
});

/** Inferred TypeScript type for a fully-parsed ActionTrace. */
export type ActionTrace = z.infer<typeof ActionTraceSchema>;

/** The subset of fields the caller must provide — everything else has defaults. */
export type ActionTraceInput = z.input<typeof ActionTraceSchema>;

/** Valid status values, useful for type-safe status updates. */
export type TraceStatus = ActionTrace["status"];
