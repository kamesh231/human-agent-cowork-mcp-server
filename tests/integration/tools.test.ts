/**
 * Integration tests: spawn the real MCP server and send JSON-RPC requests via stdio.
 * These tests use child_process.spawn and communicate over stdin/stdout.
 * The server is spawned with a test config in an isolated temp directory.
 */
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "../../build/index.js");

// Write a minimal open-mode config (no agents = open mode)
const TEST_CONFIG_YAML = `
trust:
  default_level: 0.3
  auto_promote_after: 20
  auto_promote_accuracy: 0.8
  auto_demote_after: 3
  decay_per_day: 0.01
  autonomous_threshold: 0.7

authority:
  default_mode: suggest
  volume_cap: 50
  high_risk_fields:
    - deal_stage
    - owner
    - commission
    - "utm_*"
    - "billing_*"

handoff:
  context_format: structured
  include_reasoning: true
  include_confidence: true
  include_attempted: true
  timeout_seconds: 3600

feedback:
  override_requires_reason: true
  reason_types:
    - agent_wrong
    - human_preference
    - missing_context
    - policy_change
  override_trust_impact: -0.05
  approval_trust_impact: 0.02

storage:
  driver: sqlite
  path: ./integration-test.db
`;

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: any;
}

class MCPTestClient {
  private proc: ChildProcess;
  private buffer = "";
  private pending = new Map<number, { resolve: (r: MCPResponse) => void; timer: ReturnType<typeof setTimeout> }>();
  private idCounter = 1;
  private initDone = false;

  constructor(cwd: string) {
    this.proc = spawn("node", [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as MCPResponse;
          const entry = this.pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(msg.id);
            entry.resolve(msg);
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });
  }

  async initialize(): Promise<void> {
    if (this.initDone) return;
    const resp = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    if (resp.error) throw new Error(`Init failed: ${JSON.stringify(resp.error)}`);
    // Send initialized notification
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    this.initDone = true;
  }

  send(method: string, params: unknown): Promise<MCPResponse> {
    const id = this.idCounter++;
    return new Promise<MCPResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to method: ${method} (id=${id})`));
      }, 12000);
      this.pending.set(id, { resolve, timer });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin!.write(msg, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const resp = await this.send("tools/call", { name, arguments: args });
    if (resp.error) throw new Error(`Tool error: ${JSON.stringify(resp.error)}`);
    const text = resp.result?.content?.[0]?.text ?? "{}";
    return JSON.parse(text);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.on("close", () => resolve());
      this.proc.stdin!.end();
      // Clear any pending timers
      for (const [, entry] of this.pending) clearTimeout(entry.timer);
      this.pending.clear();
      setTimeout(() => { this.proc.kill(); resolve(); }, 1000);
    });
  }
}

describe("Integration: MCP Server tools", () => {
  let client: MCPTestClient;
  let tmpDir: string;

  beforeAll(async () => {
    // Create isolated temp dir with a fresh open-mode config + db
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-test-"));
    fs.writeFileSync(path.join(tmpDir, "cowork.config.yaml"), TEST_CONFIG_YAML, "utf-8");
    client = new MCPTestClient(tmpDir);
    await client.initialize();
  }, 20000);

  afterAll(async () => {
    await client.close();
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  test("cowork_propose — open mode accepts any agent_id without token", async () => {
    const result = await client.callTool("cowork_propose", {
      agent_id: "test-agent",
      domain: "test.domain",
      action: "test_action",
      target: "test-target",
      proposed_change: JSON.stringify({ value: "test" }),
      confidence: 0.5,
      reasoning: "Integration test",
    });
    // In open mode, should not return an auth error
    expect(result.auth_error).toBeUndefined();
  });

  test("cowork_propose — mode determination based on trust (escalate at default 0.3)", async () => {
    const result = await client.callTool("cowork_propose", {
      agent_id: "integration-agent",
      domain: "crm.deals",
      action: "update",
      target: "deal-001",
      proposed_change: JSON.stringify({ field: "name", value: "Test Deal" }),
      confidence: 0.7,
      reasoning: "Integration test",
      field: "name",
    });
    // Default trust is 0.3, name is not high-risk, so mode should be 'escalate'
    expect(result.mode).toBe("escalate");
    expect(result.proposal_id).toBeTruthy();
  });

  test("cowork_propose — high-risk field forces suggest mode regardless of trust", async () => {
    const result = await client.callTool("cowork_propose", {
      agent_id: "integration-agent",
      domain: "crm.deals",
      action: "update",
      target: "deal-002",
      proposed_change: JSON.stringify({ value: "prospect" }),
      confidence: 0.9,
      reasoning: "High-risk field test",
      field: "deal_stage",
    });
    expect(result.mode).toBe("suggest");
    expect(result.high_risk_field).toBe(true);
  });

  test("cowork_propose — volume_cap and volume_remaining in response", async () => {
    const result = await client.callTool("cowork_propose", {
      agent_id: "vol-cap-agent",
      domain: "test.domain",
      action: "update",
      target: "rec-001",
      proposed_change: JSON.stringify({ value: "x" }),
      confidence: 0.5,
      reasoning: "Volume cap test",
    });
    expect(typeof result.volume_cap).toBe("number");
    expect(typeof result.volume_remaining).toBe("number");
    expect(result.volume_cap).toBeGreaterThan(0);
  });

  test("cowork_propose — unmapped domain returns mapping_found: false", async () => {
    const result = await client.callTool("cowork_propose", {
      agent_id: "unmapped-agent",
      domain: "unmapped.domain",
      action: "update",
      target: "rec-001",
      proposed_change: JSON.stringify({ value: "x" }),
      confidence: 0.5,
      reasoning: "Unmapped domain test",
    });
    expect(result.mapping_found).toBe(false);
  });

  test("cowork_check_trust — returns trust score and mode", async () => {
    const result = await client.callTool("cowork_check_trust", {
      agent_id: "trust-agent",
      domain: "crm.deals",
    });
    expect(result.trust_score).toBeDefined();
    expect(result.mode).toBeDefined();
    expect(["act", "suggest", "escalate"]).toContain(result.mode);
  });

  test("cowork_check_handoff — returns empty pending instructions initially", async () => {
    const result = await client.callTool("cowork_check_handoff", {
      agent_id: "handoff-agent",
    });
    expect(result.count).toBe(0);
    expect(Array.isArray(result.pending_instructions)).toBe(true);
  });

  test("cowork_handoff + cowork_resolve_handoff + cowork_check_handoff — full loop", async () => {
    // Create handoff
    const handoffResult = await client.callTool("cowork_handoff", {
      agent_id: "loop-agent",
      domain: "crm.deals",
      reason: "Need human review",
      confidence: 0.4,
      attempted_actions: JSON.stringify(["tried action A"]),
      context: JSON.stringify({ note: "test" }),
      handoff_mode: "review",
    });
    expect(handoffResult.handoff_id).toBeTruthy();

    // Resolve with hand_back
    const resolveResult = await client.callTool("cowork_resolve_handoff", {
      handoff_id: handoffResult.handoff_id,
      resolution: "Reviewed and approved",
      hand_back: true,
      instructions: "Please proceed with action A",
    });
    expect(resolveResult.resolved).toBe(true);

    // Agent polls for callbacks
    const callbackResult = await client.callTool("cowork_check_handoff", {
      agent_id: "loop-agent",
    });
    expect(callbackResult.count).toBe(1);
    expect(callbackResult.pending_instructions[0].instructions).toBe("Please proceed with action A");
    expect(callbackResult.pending_instructions[0].hand_back).toBe(true);
  });
});
