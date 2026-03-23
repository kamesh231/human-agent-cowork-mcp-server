#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { TraceStore } from "./trace-store.js";
import { SentryProxy } from "./proxy.js";
import { loadConfig } from "../config.js";

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

const VERSION = "0.2.0";

function printUsage(): void {
  process.stderr.write(
    `cowork-sentry v${VERSION} — COWORK Action Attribution Proxy

Usage:
  cowork-sentry [options] -- <command> [args...]

Options:
  --db <path>            Path to SQLite audit database  (default: ./cowork-traces.db)
  --agent-id <id>        Default agent ID for sessions without _cowork_metadata.agent_id
  --enforcement <mode>   "strict" blocks calls without intent, "warn" logs and forwards
                         (default: strict)
  --verify-chain         Verify the hash chain integrity and exit
  --version, -v          Print version and exit
  --help, -h             Show this help message

Examples:
  cowork-sentry -- npx @modelcontextprotocol/server-postgres postgresql://...
  cowork-sentry --db ./audit.db -- python my_mcp_server.py
  cowork-sentry --enforcement warn -- npx @modelcontextprotocol/server-filesystem ./
  cowork-sentry --verify-chain --db ./cowork-traces.db
`,
  );
}

interface CliArgs {
  dbPath: string;
  agentId?: string;
  enforcement: "strict" | "warn";
  verifyChain: boolean;
  downstreamCommand: string[];
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2); // strip node + script path

  // No arguments at all → print help and exit cleanly.
  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  // Load config file defaults for sentry section.
  const config = loadConfig();
  const sentryConfig = config.sentry;

  let dbPath = resolve(sentryConfig.db_path);
  let agentId: string | undefined;
  let enforcement: "strict" | "warn" = sentryConfig.enforcement;
  let verifyChain = false;
  let downstreamCommand: string[] = [];

  const delimIdx = args.indexOf("--");
  const ownArgs = delimIdx >= 0 ? args.slice(0, delimIdx) : args;
  downstreamCommand = delimIdx >= 0 ? args.slice(delimIdx + 1) : [];

  for (let i = 0; i < ownArgs.length; i++) {
    switch (ownArgs[i]) {
      case "--db":
        dbPath = resolve(ownArgs[++i] ?? "./cowork-traces.db");
        break;
      case "--agent-id":
        agentId = ownArgs[++i];
        break;
      case "--enforcement": {
        const mode = ownArgs[++i];
        if (mode !== "strict" && mode !== "warn") {
          log(`Invalid enforcement mode: "${mode}". Use "strict" or "warn".`);
          process.exit(1);
        }
        enforcement = mode;
        break;
      }
      case "--verify-chain":
        verifyChain = true;
        break;
      case "--version":
      case "-v":
        process.stderr.write(`cowork-sentry v${VERSION}\n`);
        process.exit(0);
        break; // unreachable but keeps linter happy
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break; // unreachable
      default:
        log(`Unknown option: ${ownArgs[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  // No downstream command and not verifying → show help and exit cleanly.
  if (!verifyChain && downstreamCommand.length === 0) {
    printUsage();
    process.exit(0);
  }

  return { dbPath, agentId, enforcement, verifyChain, downstreamCommand };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[cowork-sentry] ${msg}\n`);
}

function main(): void {
  const cliArgs = parseArgs(process.argv);
  if (!cliArgs) {
    process.exit(1);
  }

  // --- Verify Chain Mode ---
  if (cliArgs.verifyChain) {
    let store: TraceStore | undefined;
    try {
      store = new TraceStore(cliArgs.dbPath);
      const result = store.verifyChain();
      if (result.valid) {
        log("Hash chain is valid.");
        store.close();
        process.exit(0);
      } else {
        log(`Hash chain BROKEN at trace_id=${result.brokenAtTraceId}`);
        log(`  expected prev_hash: ${result.expected}`);
        log(`  actual prev_hash:   ${result.actual}`);
        store.close();
        process.exit(1);
      }
    } catch (err) {
      log(`Failed to verify chain: ${err}`);
      store?.close();
      process.exit(1);
    }
  }

  // --- Proxy Mode ---
  log(`DB: ${cliArgs.dbPath}`);
  log(`Enforcement: ${cliArgs.enforcement}`);
  log(`Downstream: ${cliArgs.downstreamCommand.join(" ")}`);

  let store: TraceStore;
  try {
    store = new TraceStore(cliArgs.dbPath);
  } catch (err) {
    log(`Failed to open audit database: ${err}`);
    process.exit(1);
  }

  // Guard against double-close (child exit + shutdown signal can race).
  let storeClosed = false;
  const safeCloseStore = () => {
    if (storeClosed) return;
    storeClosed = true;
    try { store.close(); } catch (err) { log(`Warning: error closing database: ${err}`); }
  };

  const [cmd, ...cmdArgs] = cliArgs.downstreamCommand;
  const child = spawn(cmd, cmdArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  child.on("error", (err) => {
    log(`Failed to spawn downstream server: ${err.message}`);
    safeCloseStore();
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    log(`Downstream server exited (code=${code}, signal=${signal})`);
    safeCloseStore();
    process.exit(code ?? 1);
  });

  const proxy = new SentryProxy(child, store, cliArgs.agentId, cliArgs.enforcement);
  proxy.start();

  // --- Graceful Shutdown ---
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    // Guard against double-shutdown from rapid SIGINT + SIGTERM.
    if (shuttingDown) return;
    shuttingDown = true;

    log(`Received ${signal}, shutting down...`);

    safeCloseStore();
    log("Audit database closed.");

    // Send SIGTERM to child, then force-kill after timeout.
    child.kill("SIGTERM");

    const forceKillTimer = setTimeout(() => {
      if (!child.killed) {
        log("Force-killing downstream server...");
        child.kill("SIGKILL");
      }
      process.exit(0);
    }, 3000);

    // Don't let the timer keep the process alive if child exits promptly.
    forceKillTimer.unref();

    child.on("exit", () => {
      clearTimeout(forceKillTimer);
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
