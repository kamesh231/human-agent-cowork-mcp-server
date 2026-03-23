import { createHash, randomBytes } from "crypto";
import type { CoworkConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A single agent registration as declared in cowork.config.yaml */
export interface AgentConfig {
  /** The stable identifier — must match agent_id passed to all tools */
  id: string;
  /**
   * Raw token (plaintext) — for local dev only.
   * Loaded at startup and immediately hashed; never held in memory after init.
   */
  token?: string;
  /**
   * SHA-256 hex digest of the raw token — use this in production.
   * If both `token` and `token_hash` are provided, `token_hash` wins.
   */
  token_hash?: string;
  /** Optional workspace namespace — for future multi-tenancy support */
  workspace_id?: string;
}

/**
 * Resolved identity returned after a successful verification.
 * `verified: false` means the server is running in open mode (no agents configured).
 */
export interface AgentIdentity {
  agent_id: string;
  verified: boolean;
  workspace_id?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

/**
 * Holds the set of registered agents and verifies incoming tokens.
 *
 * Open mode (no agents configured):
 *   All `agent_id` values pass through unverified — backward-compatible with
 *   the demo setup. `identity.verified` will be `false`.
 *
 * Closed mode (at least one agent registered):
 *   Every tool call must supply a matching `agent_token`. Missing or wrong
 *   tokens throw `AuthError`, which the tool layer converts to an error response.
 */
export class AgentRegistry {
  /** SHA-256 hashes keyed by agent_id */
  private registry = new Map<string, { hash: string; workspace_id?: string }>();
  private readonly openMode: boolean;

  constructor(config: CoworkConfig) {
    const agents: AgentConfig[] = (config as any).agents ?? [];
    this.openMode = agents.length === 0;

    for (const a of agents) {
      if (!a.id) continue;
      // token_hash takes precedence over plaintext token
      const hash = a.token_hash ?? (a.token ? hashToken(a.token) : null);
      if (!hash) {
        console.error(`[cowork:auth] Agent '${a.id}' has neither token nor token_hash — skipping.`);
        continue;
      }
      this.registry.set(a.id, { hash, workspace_id: a.workspace_id });
    }
  }

  /**
   * Verify an agent token.
   *
   * @throws {AuthError} in closed mode when token is missing or incorrect.
   */
  verify(agent_id: string, token?: string): AgentIdentity {
    if (this.openMode) {
      // Open mode — no agents configured, all pass through unverified
      return { agent_id, verified: false };
    }

    if (!token) {
      throw new AuthError(
        `Agent '${agent_id}' requires an agent_token. ` +
        `Configure agents in cowork.config.yaml or set open mode by removing all agents entries.`
      );
    }

    const entry = this.registry.get(agent_id);
    if (!entry) {
      throw new AuthError(
        `Unknown agent_id: '${agent_id}'. Register it under agents[] in cowork.config.yaml.`
      );
    }

    if (hashToken(token) !== entry.hash) {
      throw new AuthError(`Invalid token for agent '${agent_id}'.`);
    }

    return { agent_id, verified: true, workspace_id: entry.workspace_id };
  }

  /** True when no agents are registered — server accepts any agent_id */
  isOpenMode(): boolean {
    return this.openMode;
  }

  /** Number of registered agents */
  size(): number {
    return this.registry.size;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a raw token string */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Generate a new cryptographically random agent token.
 * Use this to bootstrap new agent registrations:
 *   const token = generateToken();
 *   console.log("token:", token);
 *   console.log("token_hash:", hashToken(token));  // store this in config
 */
export function generateToken(): string {
  return `sk-cowork-${randomBytes(24).toString("hex")}`;
}
