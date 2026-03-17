import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { ActionTraceSchema } from "./types.js";
import { sanitizeArgs } from "./sanitizer.js";
import type { TraceStore } from "./trace-store.js";

/** Metadata that COWORK-aware agents attach to every tool call. */
interface CoworkMetadata {
  intent: string;
  agent_id?: string;
}

/** In-flight request tracked between intercept and response. */
interface PendingCall {
  traceId: string;
  startMs: number;
}

/**
 * MCP JSON-RPC error codes.
 * -32602 = Invalid params (MCP spec).
 */
const COWORK_ERR_CODE = -32602;

/**
 * SentryProxy — a transparent MCP middleware that sits between an MCP client
 * (reading from process.stdin / writing to process.stdout) and a downstream
 * MCP server (spawned as a child process communicating over stdio).
 *
 * Behaviour:
 *  - All non-`tools/call` messages pass through untouched in both directions.
 *  - `tools/call` messages are intercepted:
 *      1. `_cowork_metadata.intent` is extracted (or the call is blocked).
 *      2. Arguments are sanitized and an ActionTrace is logged (PENDING).
 *      3. `_cowork_metadata` is stripped before forwarding downstream.
 *  - Responses from the child are matched by JSON-RPC `id`:
 *      if the id belongs to a tracked call, the trace is updated
 *      (COMPLETED / FAILED) with the elapsed duration.
 */
export class SentryProxy {
  private pendingCalls = new Map<string | number, PendingCall>();
  private defaultAgentId: string;
  private enforcement: "strict" | "warn";

  constructor(
    private child: ChildProcess,
    private store: TraceStore,
    agentId?: string,
    enforcement: "strict" | "warn" = "strict",
  ) {
    this.defaultAgentId = agentId ?? `session-${Date.now()}`;
    this.enforcement = enforcement;
  }

  /** Wire up stdin → intercept → child.stdin and child.stdout → intercept → stdout. */
  start(): void {
    // --- Client → Proxy → Child ---
    const clientRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    clientRl.on("line", (line) => {
      this.handleClientMessage(line);
    });
    clientRl.on("close", () => {
      this.child.stdin?.end();
    });

    // --- Child → Proxy → Client ---
    if (!this.child.stdout) {
      this.log("ERROR: child process has no stdout — cannot proxy responses");
      return;
    }
    const childRl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    childRl.on("line", (line) => {
      this.handleChildMessage(line);
    });

    // Pipe child stderr to our stderr for visibility.
    this.child.stderr?.pipe(process.stderr);

    this.log("Proxy started");
  }

  // ---------------------------------------------------------------------------
  // Client → Proxy
  // ---------------------------------------------------------------------------

  private handleClientMessage(raw: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      // Not valid JSON — forward as-is (shouldn't happen in MCP, but be safe).
      this.sendToChild(raw);
      return;
    }

    // Only intercept JSON-RPC requests with method "tools/call".
    if (!isToolsCallRequest(msg)) {
      this.sendToChild(raw);
      return;
    }

    const params = msg.params as ToolsCallParams | undefined;
    if (!params) {
      this.sendToChild(raw);
      return;
    }

    // --- Defensive unpack: handle double-nested / stringified arguments from UIs ---
    const unpacked = this.unpackArguments(params.arguments ?? {});

    // --- Extract _cowork_metadata ---
    const metadata = unpacked._cowork_metadata as CoworkMetadata | undefined;

    if (!metadata?.intent) {
      if (this.enforcement === "strict") {
        // Strict mode: block the call — no intent provided.
        this.sendErrorToClient(msg.id, COWORK_ERR_CODE, "COWORK_ERR: Action Attribution Required. Missing intent.");
        this.log(`BLOCKED tools/call "${params.name}" — missing intent (id=${msg.id})`);
        return;
      }
      // Warn mode: log warning but forward the call anyway.
      this.log(`WARN: tools/call "${params.name}" — missing intent (id=${msg.id}), forwarding anyway`);
    }

    // --- Sanitize & log ---
    const intent = metadata?.intent ?? "[MISSING]";
    const agentId = metadata?.agent_id ?? this.defaultAgentId;

    // Clone unpacked arguments and strip _cowork_metadata before sanitizing/forwarding.
    const cleanArgs = { ...unpacked };
    delete cleanArgs._cowork_metadata;

    const argsJson = sanitizeArgs(cleanArgs as Record<string, unknown>);

    const trace = ActionTraceSchema.parse({
      agent_id: agentId,
      intent,
      tool_name: params.name,
      args_json: argsJson,
    });

    try {
      this.store.logTrace(trace);
    } catch (err) {
      // DB write failed — block the call (safety fail-over).
      this.sendErrorToClient(msg.id, COWORK_ERR_CODE, "COWORK_ERR: Audit log write failed. Tool call blocked for safety.");
      this.log(`BLOCKED tools/call "${params.name}" — DB write failed: ${err}`);
      return;
    }

    // Track the in-flight call so we can update the trace on response.
    if (msg.id !== undefined && msg.id !== null) {
      this.pendingCalls.set(msg.id, { traceId: trace.trace_id, startMs: Date.now() });
    }

    this.log(`TRACED tools/call "${params.name}" → ${trace.trace_id} (intent: "${intent}")`);

    // --- Forward with _cowork_metadata stripped ---
    const forwarded: JsonRpcMessage = {
      ...msg,
      params: { ...params, arguments: cleanArgs },
    };
    this.sendToChild(JSON.stringify(forwarded));
  }

  // ---------------------------------------------------------------------------
  // Child → Proxy
  // ---------------------------------------------------------------------------

  private handleChildMessage(raw: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      // Not valid JSON — forward as-is.
      this.sendToClient(raw);
      return;
    }

    // Check if this response matches a pending traced call.
    if (msg.id !== undefined && msg.id !== null && this.pendingCalls.has(msg.id)) {
      const pending = this.pendingCalls.get(msg.id)!;
      this.pendingCalls.delete(msg.id);

      const durationMs = Date.now() - pending.startMs;
      const failed = "error" in msg && msg.error != null;

      try {
        this.store.updateTraceStatus(
          pending.traceId,
          failed ? "FAILED" : "COMPLETED",
          durationMs,
        );
      } catch (err) {
        this.log(`WARN: Failed to update trace ${pending.traceId}: ${err}`);
      }

      this.log(
        `${failed ? "FAILED" : "COMPLETED"} ${pending.traceId} (${durationMs}ms)`,
      );
    }

    // Always forward the response to the client.
    this.sendToClient(raw);
  }

  // ---------------------------------------------------------------------------
  // I/O helpers
  // ---------------------------------------------------------------------------

  private sendToChild(line: string): void {
    this.child.stdin?.write(line + "\n");
  }

  private sendToClient(line: string): void {
    process.stdout.write(line + "\n");
  }

  private sendErrorToClient(
    id: string | number | undefined | null,
    code: number,
    message: string,
  ): void {
    const response: JsonRpcErrorResponse = {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    };
    this.sendToClient(JSON.stringify(response));
  }

  /**
   * Unpacks arguments that have been double-nested or stringified by UIs/LLMs.
   * Example: { "path": "{\"path\": \"file.txt\", \"_cowork_metadata\": {...}}" }
   * Becomes: { "path": "file.txt", "_cowork_metadata": {...} }
   */
  private unpackArguments(args: Record<string, unknown>): Record<string, unknown> {
    const unpacked: Record<string, unknown> = { ...args };
    for (const [key, value] of Object.entries(unpacked)) {
      if (typeof value === "string" && value.trim().startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(value);

          // If the string was actually a JSON object containing our metadata
          // or a key that matches the parent key name, spread the parsed
          // values into the top level.
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            ((parsed as Record<string, unknown>)._cowork_metadata !== undefined ||
              (parsed as Record<string, unknown>)[key] !== undefined)
          ) {
            this.log(`Auto-unpacking stringified JSON in key: "${key}"`);
            Object.assign(unpacked, parsed);
          }
        } catch {
          // Not valid JSON, just a regular string (like a file path). Carry on.
        }
      }
    }
    return unpacked;
  }

  /** Log to stderr so it never contaminates the JSON-RPC stdout stream. */
  private log(msg: string): void {
    process.stderr.write(`[cowork-sentry] ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC type helpers (minimal, just enough for routing)
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown } | null;
  [key: string]: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: string;
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

function isToolsCallRequest(msg: JsonRpcMessage): boolean {
  return msg.method === "tools/call" && msg.id !== undefined;
}
