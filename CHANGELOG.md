# Changelog

All notable changes to the COWORK MCP Server are documented here.

## [0.1.1] - 2026-03-23

### Added
- Named policy system with `PolicyConfig` and `MappingConfig` in `src/config.ts`
- `PolicyEngine.validateWithMapping()` — resolves agent+domain to a named policy and evaluates its rules
- `cowork_check_handoff` tool (14th tool) — agent polls for resolved handoffs with human instructions, closing the human→agent callback loop
- `VolumeCapError` class in `src/trust.ts` — thrown when an agent exceeds their hourly proposal volume cap
- Volume cap enforcement in `TrustEngine.atomicPropose()` — pre-transaction check
- `CoworkStore.getProposalCountLastHour()` — counts proposals in the rolling 60-minute window
- `CoworkStore.getPendingCallbacks()` — queries handoffs resolved with `hand_back=1` and unread instructions
- `CoworkStore.markCallbackRead()` — marks a handoff callback as read by the agent
- `Handoff` interface extended with `instructions`, `hand_back`, and `instructions_read` fields
- Schema migrations for existing databases (ALTER TABLE handoffs)
- Trust score time-based decay applied on `getOrCreateTrust()` using `decay_per_day` config
- `cowork_resolve_handoff` now accepts `hand_back` and `instructions` parameters
- `cowork_propose` response now includes `policy_id`, `policy_description`, `policy_rules_checked`, `mapping_found`, `volume_remaining`, `volume_cap`
- Jest test suite with unit tests for TrustEngine, PolicyEngine, AgentRegistry, and integration tests

### Changed
- `decay_rate` renamed to `decay_per_day` in `CoworkConfig.trust` and `DEFAULT_CONFIG`
- `CoworkStore` constructor now accepts optional `CoworkConfig` for decay configuration
- `PolicyEngine` rewritten to support named policies + agent/domain mappings
- `cowork_propose` uses `validateWithMapping` instead of `validate`

### Fixed
- Handoff resolution now correctly persists `instructions` and `hand_back` flag to SQLite

---

## [0.1.0] - 2026-03-01

### Added
- Initial release with 13 MCP tools
- Trust scoring system with atomic propose/approve/override operations
- Handoff protocol for human–agent collaboration
- Policy engine with high-risk field detection
- Agent authentication (open and closed modes)
- Audit trail and governance report tools
- Bulk approve/reject for pending proposals
- Sentry integration for intent-gated tool calls
- YAML-based configuration (`cowork.config.yaml`)
- SQLite storage via better-sqlite3
