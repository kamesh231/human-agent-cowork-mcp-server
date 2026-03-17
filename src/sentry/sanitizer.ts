import { createHash } from "node:crypto";

/** Maximum recursion depth before the sanitizer bails out. */
const MAX_DEPTH = 10;

/**
 * Single regex that flags any key whose lowercase form contains one of
 * these substrings. Case-insensitive partial matching — catches
 * MY_PRIVATE_KEY, dbPassword, auth_token, aws_secret_access_key, etc.
 */
const SENSITIVE_KEY_RE = /key|secret|token|password|passwd|pwd|auth|credential|certificate/i;

/**
 * Value-level patterns: if a string value matches any of these regexes
 * it is redacted regardless of the key name. This catches secrets leaked
 * into innocent keys like `content` or `message`.
 *
 * Each regex targets a known provider prefix or common secret shape.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // OpenAI / Anthropic / Stripe / Slack / GitHub style prefixed keys
  /sk[-_]live[-_][\w-]{10,}/,        // Stripe live secret
  /sk[-_]test[-_][\w-]{10,}/,        // Stripe test secret
  /sk[-_]ant[-_][\w-]{10,}/,         // Anthropic
  /sk[-_]proj[-_][\w-]{10,}/,        // OpenAI project key
  /sk[-_][\w-]{20,}/,                // Generic sk- long key (20+ chars after prefix)
  /AIza[A-Za-z0-9_-]{30,}/,         // Google API key
  /ghp_[A-Za-z0-9]{36,}/,           // GitHub personal access token
  /gho_[A-Za-z0-9]{36,}/,           // GitHub OAuth token
  /github_pat_\w{20,}/,             // GitHub fine-grained PAT
  /xoxb-[A-Za-z0-9-]+/,            // Slack bot token
  /xoxp-[A-Za-z0-9-]+/,            // Slack user token
  /xapp-[A-Za-z0-9-]+/,            // Slack app token
  /AKIA[A-Z0-9]{16}/,              // AWS access key ID
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // JWT
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, // PEM private key
  /Bearer\s+[A-Za-z0-9_.~+/=-]{20,}/i,       // Bearer token in value
];

/** Legacy list kept for backward-compat with callers passing custom patterns. */
const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  "password",
  "token",
  "secret",
  "api_key",
  "apikey",
  "authorization",
  "credential",
  "private_key",
  "access_key",
];

/**
 * Returns true only for plain objects and arrays — the only things safe to recurse into.
 * Rejects Buffer, Date, RegExp, TypedArrays, class instances, and other exotic objects
 * that would crash or produce nonsense if we iterated their entries.
 */
function isPlainObjectOrArray(value: unknown): value is Record<string, unknown> | unknown[] {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  // Buffer / TypedArray guard
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  // Date, RegExp, Map, Set, etc.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Test whether a key matches any sensitive pattern.
 *
 * Two-tier check:
 *  1. Built-in regex (`SENSITIVE_KEY_RE`) — case-insensitive partial match that
 *     catches MY_PRIVATE_KEY, dbPassword, auth_token, etc.
 *  2. Custom patterns list (supports literal substring + simple glob) for
 *     backward-compat with callers passing their own `sensitiveKeys` array.
 */
function isSensitiveKey(key: string, patterns: readonly string[]): boolean {
  // Tier 1: built-in regex — catches the vast majority of cases.
  if (SENSITIVE_KEY_RE.test(key)) return true;

  // Tier 2: caller-supplied patterns (substring + glob).
  const lower = key.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (p.includes("*")) {
      const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      if (new RegExp(`^${escaped}$`).test(lower)) return true;
    } else {
      if (lower === p || lower.includes(p)) return true;
    }
  }
  return false;
}

/**
 * Test whether a string *value* looks like a known secret format (API key,
 * JWT, PEM key, bearer token, etc.). This catches secrets placed in innocently
 * named keys like `content`, `message`, or `data`.
 */
function isSensitiveValue(value: string): boolean {
  for (const re of SENSITIVE_VALUE_PATTERNS) {
    if (re.test(value)) return true;
  }
  return false;
}

/**
 * Build a redaction placeholder that includes a short SHA-256 prefix
 * of the original value for correlation without exposing the secret.
 */
function redact(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `[REDACTED:${hash}]`;
}

/**
 * Recursively sanitize an object, redacting values whose keys match sensitive patterns.
 *
 * Safety guarantees (fail-safe design):
 *  - Does NOT mutate the input — always returns a new object / array.
 *  - Depth-limited (default 10) to prevent infinite recursion from circular
 *    or pathologically nested structures.
 *  - Only recurses into plain objects and arrays — Buffers, Dates, TypedArrays,
 *    class instances, etc. are returned as-is (prevents better-sqlite3 crashes).
 *  - If a string value is valid JSON *and* parses to a plain object/array, it is
 *    sanitized recursively then re-stringified. Bare primitives ("42", "true") are
 *    left alone.
 *  - Any unexpected error returns the original value rather than crashing the proxy.
 */
export function sanitize(
  input: unknown,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_PATTERNS,
  depth: number = 0,
): unknown {
  // --- Fail-safe: if anything goes wrong, return input unchanged ---
  try {
    // Depth guard — bail out before we blow the stack.
    if (depth > MAX_DEPTH) return input;

    // Nullish — pass through.
    if (input === null || input === undefined) return input;

    // Arrays — recurse element-by-element (only if plain array).
    if (Array.isArray(input)) {
      return input.map((item) => sanitize(item, sensitiveKeys, depth + 1));
    }

    // Objects — only plain objects; skip Buffers, Dates, TypedArrays, etc.
    if (typeof input === "object") {
      if (!isPlainObjectOrArray(input)) return input;

      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (isSensitiveKey(key, sensitiveKeys)) {
          // Key name is sensitive — redact the whole value.
          result[key] = redact(value);
        } else if (typeof value === "string" && isSensitiveValue(value)) {
          // Key is innocent but value looks like a known secret format.
          result[key] = redact(value);
        } else {
          result[key] = sanitize(value, sensitiveKeys, depth + 1);
        }
      }
      return result;
    }

    // String values: attempt to parse as JSON, sanitize the parsed result, re-stringify.
    // Then apply value-level pattern scrubbing for known secret formats.
    if (typeof input === "string") {
      // Try JSON parse first — nested objects may contain sensitive keys.
      try {
        const parsed: unknown = JSON.parse(input);
        if (isPlainObjectOrArray(parsed)) {
          return JSON.stringify(sanitize(parsed, sensitiveKeys, depth + 1));
        }
      } catch {
        // Not JSON — continue to value-level check.
      }

      // Value-level scrubbing: redact strings that look like API keys, JWTs, etc.
      if (isSensitiveValue(input)) {
        return redact(input);
      }

      return input;
    }

    // Numbers, booleans, etc. — pass through.
    return input;
  } catch {
    // Fail-safe: if anything unexpected happens, return the original value
    // rather than crashing the entire proxy.
    return input;
  }
}

/**
 * Convenience wrapper: sanitize an args object and return the stringified result.
 * This is what the proxy calls before writing `args_json` to the trace store.
 */
export function sanitizeArgs(
  args: Record<string, unknown>,
  sensitiveKeys?: readonly string[],
): string {
  return JSON.stringify(sanitize(args, sensitiveKeys));
}
