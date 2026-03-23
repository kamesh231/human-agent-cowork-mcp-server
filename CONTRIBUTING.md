# Contributing to COWORK MCP Server

Thank you for considering a contribution to the COWORK Protocol MCP Server! This project aims to give AI agents trust, handoffs, and accountability in human-agent collaboration scenarios.

## Our Philosophy

This project is **intentionally opinionated**. We have strong positions on:

- **Trust scoring** as the foundation for agent accountability
- **Immutable audit trails** for transparency and dispute resolution
- **PII sanitization** at the protocol level for security
- **Handoff mechanisms** that prioritize human oversight over automation

We welcome contributions that debate these positions. Disagree with our defaults? [Open an issue](../../issues) to propose alternatives, or fork the config and submit a PR with your perspective.

## Code of Conduct

We're committed to providing a welcoming and inclusive environment. All contributors are expected to follow basic respect and professionalism standards. Harassment, discrimination, or bad-faith arguments will not be tolerated.

## Getting Started

### Prerequisites

- **Node.js** 16+ (check your version: `node --version`)
- **npm** (comes with Node.js)
- Basic familiarity with TypeScript and the [MCP specification](https://modelcontextprotocol.io)

### Local Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/kamesh231/human-agent-cowork-mcp-server.git
   cd human-agent-cowork-mcp-server
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Verify your setup**
   ```bash
   npm run build
   npm run inspect
   ```
   This should start the MCP Inspector. You can verify the server is working by checking the available tools in the inspector UI.

## Project Architecture

### Main Components

**`src/index.ts` - Core MCP Server (167 lines)**
- Implements 6 tools: `cowork_propose`, `cowork_check_trust`, `cowork_handoff`, `cowork_log`, `cowork_override`, `cowork_status`
- Integrates with storage and Sentry security proxy
- Exposes MCP protocol to Claude and other clients

**`src/storage.ts` - Data Persistence (191 lines)**
- TrustScore: Agent trust ratings by domain
- Action: Proposed and executed actions with attribution
- Proposal: Change proposals with trust state
- Override: Human corrections with structured reason types
- Handoff: Context packets for human escalation
- TimelineEvent: Immutable audit trail

**`src/sentry/` - Security Proxy (972 lines)**
- `proxy.ts`: Intercepts tool calls, validates intent strings, enforces trust policies
- `trace-store.ts`: SQLite-backed immutable audit database with tamper-evident hash chains
- `sanitizer.ts`: Strips PII (passwords, API keys, tokens, SSNs)
- `types.ts`: Type definitions for proxy layer

**`src/config.ts` - Configuration (83 lines)**
- Loads `cowork.config.yaml`
- Validates trust thresholds, authority modes, high-risk fields
- Exposes runtime config to tools

### Directory Structure

```
src/
├── index.ts              # Main MCP server + 6 tools
├── storage.ts            # Data models and persistence
├── config.ts             # Configuration loader
└── sentry/
    ├── index.ts          # Sentry server entry point
    ├── proxy.ts          # Tool call interception & validation
    ├── trace-store.ts    # SQLite audit trail
    ├── sanitizer.ts      # PII redaction
    └── types.ts          # Type definitions
```

## Development Workflow

### Scripts

```bash
npm run dev       # Watch mode: compile TypeScript on file changes
npm run build     # Compile to JavaScript, set executable permissions
npm start         # Run the compiled server
npm run inspect   # Open MCP Inspector for manual testing
npm run inspect:sentry  # Inspect with Sentry security proxy enabled
```

### Making Changes

1. **Edit TypeScript files** in `src/`
2. **Run `npm run dev`** in a terminal to watch for changes
3. **Test with `npm run inspect`** to verify against Claude Desktop or Claude Code
4. **Run `npm run build`** before committing to ensure it compiles

## Code Standards

This project enforces several standards to maintain quality and security:

### TypeScript Strict Mode

All code must pass TypeScript strict mode (`noImplicitAny`, `strictNullChecks`, etc.). If you add new code:
- Annotate function parameters and return types explicitly
- Don't use `any` unless absolutely unavoidable (and justify it in a comment)
- Enable strict mode in your editor settings

### Runtime Validation with Zod

For any new API inputs or config options, use [Zod](https://zod.dev) schemas:
```typescript
const MyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().min(0).max(1),
});
```

This ensures schema validation at runtime, not just compile time.

### Immutable Audit Trail

If you add new data models to `storage.ts`:
- All state mutations must be logged to the audit trail
- Use `TimelineEvent` to record intent, actor, and outcome
- Never delete historical records; mark as archived if needed

### PII Sanitization

If you add new fields to Actions or Proposals:
- Review `src/sentry/sanitizer.ts` to ensure PII (passwords, tokens, keys) will be stripped
- Update `SENSITIVE_PATTERNS` if introducing new secret formats

### Trust Scoring

When implementing trust-related changes:
- Changes to trust calculation require strong justification (opens debate)
- Trust scores are always 0.0–1.0; clarify what thresholds trigger in-review vs. auto-approve modes
- Document how your change interacts with `cowork.config.yaml` authority modes

## Types of Contributions

### Bug Fixes

Found a bug? Great! Submit a PR with:
- Clear description of the bug and how to reproduce it
- Link to any related issues
- Tests validating the fix (if applicable)

**High-priority bugs:**
- Trust calculation errors
- PII leaking in logs or stored data
- Audit trail integrity issues
- Config parsing failures

### Feature Proposals

New tool? New config option? Before diving into code:
1. **Open an issue** describing the feature and motivation
2. **Wait for discussion** (we may suggest alternatives or point out philosophical concerns)
3. **Implement only after consensus** to avoid wasted effort

Feature PRs should include:
- Clear commit messages explaining intent
- Tests demonstrating the new functionality
- Updated `cowork.config.yaml` example if adding config options
- Documentation in code comments (especially for trust logic)

### Documentation

Improvements to README, inline comments, or this file are always welcome. For significant doc changes, open an issue first to discuss scope.

### Configuration Defaults

Our `cowork.config.yaml` defaults represent opinionated positions. Want to debate them? Open an issue! We're happy to discuss:
- Default trust thresholds
- Authority modes (suggest vs. review vs. act)
- High-risk field definitions
- Feedback mechanism structures

Proposed changes to defaults should explain the philosophy behind the new position, not just the technical change.

## PR Guidelines

### Before You Submit

1. **Run the build**
   ```bash
   npm run build
   ```
   Your PR must compile without TypeScript errors.

2. **Test with the Inspector**
   ```bash
   npm run inspect
   # Open the inspector, test your changes manually
   ```

3. **Check against the MCP spec**
   - Ensure your changes don't break the [Model Context Protocol specification](https://modelcontextprotocol.io)
   - If modifying tool schemas, validate they're backward-compatible

4. **Update related files**
   - If you modify config defaults, update `cowork.config.yaml`
   - If you modify tools, consider whether `src/sentry/sanitizer.ts` needs updates
   - If you touch storage, add `TimelineEvent` entries

### Submitting Your PR

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Write clear commit messages**
   ```
   [Tool Name] Brief description of change

   Longer explanation of why this change is needed, how it works,
   and any implications for trust scoring, security, or config.
   ```

3. **Push and open a PR** with:
   - Clear title summarizing the change
   - Description of what changed and why
   - Link to related issues
   - Any notes for reviewers (e.g., "This changes the default trust threshold from 0.3 to 0.4")

### PR Review

We'll review PRs for:
- ✅ Code quality and TypeScript compliance
- ✅ MCP specification compliance
- ✅ Security implications (PII, audit trail integrity)
- ✅ Alignment with project philosophy
- ✅ Test coverage for new features

## Testing

### Manual Testing

The MCP Inspector is your primary testing tool:
```bash
npm run inspect
```

This opens a UI where you can:
- Call each tool with different inputs
- Verify response schemas
- Check error handling
- Inspect the server logs

### Automated Tests

*(Currently, the project uses manual testing. If you add tests, great! We can discuss patterns in your PR.)*

### Integration Testing

To test your changes with Claude Desktop or Claude Code:
1. Build your changes: `npm run build`
2. Update your Claude Desktop config to point to the local server
3. Test with Claude and verify the tools work as expected

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE), the same license as this project. All contributions are covered by this license.

## Questions or Need Help?

- **Usage questions?** Check the [README](README.md) and config examples
- **Philosophical debates?** [Open an issue](../../issues) with the `discussion` label
- **Bug reports?** [Open an issue](../../issues) with clear reproduction steps
- **Larger discussions?** Link to the main [COWORK Protocol](https://github.com/kamesh231/human-agent-cowork-mcp-server) repository

## Recognition

We love acknowledging contributions! If your PR is merged, we'll add you to the contributors list.

---

**Thank you for making COWORK better!** 🚀
