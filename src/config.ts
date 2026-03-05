import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import { join, resolve } from "path";

export interface CoworkConfig {
  trust: {
    default_level: number;
    auto_promote_after: number;
    auto_promote_accuracy: number;
    auto_demote_after: number;
    decay_rate: number;
    autonomous_threshold: number;
  };
  authority: {
    default_mode: string;
    volume_cap: number;
    high_risk_fields: string[];
  };
  handoff: {
    context_format: string;
    include_reasoning: boolean;
    include_confidence: boolean;
    include_attempted: boolean;
    timeout_seconds: number;
  };
  feedback: {
    override_requires_reason: boolean;
    reason_types: string[];
    override_trust_impact: number;
    approval_trust_impact: number;
  };
  storage: {
    driver: string;
    path?: string;
    url?: string;
    token?: string;
  };
}

const DEFAULT_CONFIG: CoworkConfig = {
  trust: { default_level: 0.3, auto_promote_after: 20, auto_promote_accuracy: 0.8, auto_demote_after: 3, decay_rate: 0.01, autonomous_threshold: 0.7 },
  authority: { default_mode: "suggest", volume_cap: 50, high_risk_fields: ["deal_stage", "owner", "commission", "utm_*", "billing_*"] },
  handoff: { context_format: "structured", include_reasoning: true, include_confidence: true, include_attempted: true, timeout_seconds: 3600 },
  feedback: { override_requires_reason: true, reason_types: ["agent_wrong", "human_preference", "missing_context", "policy_change"], override_trust_impact: -0.05, approval_trust_impact: 0.02 },
  storage: { driver: "sqlite", path: "./cowork.db" },
};

export function loadConfig(configPath?: string): CoworkConfig {
  const paths = [configPath, join(process.cwd(), "cowork.config.yaml"), join(process.cwd(), "cowork.config.yml")].filter(Boolean) as string[];
  for (const p of paths) {
    const r = resolve(p);
    if (existsSync(r)) {
      try { return deepMerge(DEFAULT_CONFIG, parse(readFileSync(r, "utf-8"))) as CoworkConfig; }
      catch (e) { console.error(`[cowork] Config parse error at ${r}:`, e); }
    }
  }
  console.error("[cowork] No config found, using defaults");
  return DEFAULT_CONFIG;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) result[key] = deepMerge(target[key] || {}, source[key]);
    else result[key] = source[key];
  }
  return result;
}
