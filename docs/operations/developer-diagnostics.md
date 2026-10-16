# Operational Guide: Developer Diagnostics & Doctor Command

## Overview & Purpose

The **Trellis Developer Diagnostics Command** (`npm run diagnostics` / `npm run doctor`) provides a single, non-mutating health check command that validates local contributor setup and external service assumptions across the Trellis Frontend stack:

1. **Developer Tooling & Runtime**: Verifies Node.js runtime (`>= 20.0.0`) and Git repository state.
2. **Configuration & Environment**: Validates `.env.example` presence, `.env.local` variable synchronization, and strict [`AppConfig`](../lib/config/env.ts) security rules (HTTPS enforcement outside local development, Stellar network alignment, and webhook/permission secret hygiene) without leaking secret values.
3. **Project Dependencies & Setup**: Verifies `package.json`, `tsconfig.json`, `node_modules` installation, and core package manifests (`next`, `react`, `zod`, `@stellar/stellar-sdk`, `@stellar/freighter-api`).
4. **Service Connectivity & External Assumptions**: Probes Stellar Testnet Horizon (`https://horizon-testnet.stellar.org`), Stellar Soroban RPC (`https://soroban-testnet.stellar.org`), and Public IPFS Gateway (`https://ipfs.io`) with bounded timeouts.
5. **Seed Data & Fixture Integrity**: Runs deterministic, read-only domain invariant validation against [`scripts/fixtures/recovery-baseline.json`](../scripts/fixtures/recovery-baseline.json), invariant monitor fixtures (`healthy-dataset.json` and `corrupted-dataset.json`), and `lib/db/mock-db.ts`.
6. **System Requirements**: Checks available system memory (`>= 4 GB` RAM) and free disk capacity (`>= 1 GB`).
7. **Local Ports**: Probes local ports (`3000`, `8080`) for `EADDRINUSE` conflicts and identifies owning processes.
8. **Common Failure Fixes & Self-Healing (`--fix`)**: Surfaces deterministic remediation and rollback commands for common contributor issues, and optionally initializes missing `.env.local` files or clears stale `.next` caches.

---

## Command Usage

```bash
# Run full diagnostics (human-readable report)
npm run diagnostics

# Alias command
npm run doctor

# Skip external network/RPC reachability checks (offline or air-gapped environments)
npm run diagnostics -- --skip-network

# Output structured machine-readable JSON for CI or automated tooling
npm run diagnostics -- --json

# Treat warnings as failures (exit code 1 on any warning or failure)
npm run diagnostics -- --strict

# Automatically apply safe, idempotent fixes (e.g., copy .env.example -> .env.local)
npm run diagnostics -- --fix

# Display the full catalog of common failure modes, fixes, and rollback commands
npm run diagnostics -- --show-fixes
```

---

## Operational Edge Cases & Failure Modes

| Code | Failure Mode / Symptom | Root Cause | Diagnostic Status | Remediation Command |
| :--- | :--- | :--- | :--- | :--- |
| `ENV_MISSING_LOCAL` | No `.env.local` or `.env` file detected | Fresh repository clone without environment initialization | `WARN` (`FAIL` in `--strict`) | `cp .env.example .env.local` or `npm run diagnostics -- --fix` |
| `ENV_SCHEMA_INVALID` | `AppConfig Schema & Security Rules` fails | Staging/production mode configured with `http://`, `localhost`, or `testnet`, or placeholder/short `WEBHOOK_SECRET` (`< 32` chars) | `FAIL` | Align `.env.local` with `.env.example` or generate a 32+ char secret via `openssl rand -base64 48` |
| `DEPS_MISSING_MODULES` | `node_modules` missing or missing critical packages | Dependencies not installed or interrupted `npm install` | `FAIL` / `WARN` | `npm install` |
| `SEED_DATA_CORRUPTED` | `Seed Data & Baseline Invariants` fails | Local edits to `scripts/fixtures/recovery-baseline.json` violated primary key uniqueness, Stellar address format, or financial rules | `FAIL` | `git checkout -- scripts/fixtures/recovery-baseline.json` |
| `NETWORK_RPC_UNREACHABLE` | Stellar Horizon, Soroban RPC, or IPFS gateway unreachable | Offline workspace, corporate proxy/firewall, DNS failure, or upstream HTTP 429/5xx | `WARN` (`FAIL` in `--strict`) | Use `npm run diagnostics -- --skip-network` for offline work; built-in mocks handle fallback |
| `PORT_CONFLICT` | Port `3000` or `8080` is currently in use | Orphaned Next.js dev server, Docker container, or background service occupying the port | `FAIL` | `npx kill-port 3000 8080` or stop the reported PID |
| `NEXT_CACHE_CORRUPTED` | Stale `.next` build artifacts causing webpack/HMR failures | Branch switching or interrupted `next build` | Manual / `--fix` | `rm -rf .next` |

### Security & Privacy Edge Cases
- **Zero Secret Leakage**: When `WEBHOOK_SECRET` or `PERMISSION_TOKEN_SECRET` fails validation (e.g., fewer than 32 characters or matching placeholder patterns like `change_me`), diagnostics report the violated policy name without ever echoing the secret value to `stdout`, `stderr`, or JSON output.
- **Offline Development Mode**: External network probes default to `WARN` rather than `FAIL` (unless `--strict` is passed) so contributors working offline or on restricted networks can still validate local code, seed data, and configuration.

---

## Rollback & Recovery Steps

If an automated fix (`--fix`) or manual configuration change introduces unexpected behavior, follow these deterministic recovery steps:

### 1. Rollback Environment Configuration
If `.env.local` was auto-generated or modified with incompatible endpoints:
```bash
# Remove local environment override completely
rm -f .env.local

# Or reset to the canonical repository template
cp .env.example .env.local
```

### 2. Rollback Seed Data & Test Fixtures
If local seed data or invariant test fixtures (`scripts/fixtures/recovery-baseline.json` or `tests/fixtures/`) fail invariant checks:
```bash
# Restore canonical seed data and fixtures from Git HEAD
git checkout HEAD -- scripts/fixtures/recovery-baseline.json tests/fixtures/

# Verify restoration
npm run validate:invariants
npm run diagnostics -- --skip-network
```

### 3. Rollback Corrupted Dependency Tree or Build Cache
If dependency upgrades or build caches cause module resolution failures:
```bash
# Purge build cache and node_modules, then reinstall cleanly
rm -rf .next node_modules
npm install
```

---

## Compatibility & Public Contracts

- **Non-Mutating by Default**: Running `npm run diagnostics` without `--fix` performs strictly read-only filesystem, socket, and HTTP `GET` checks.
- **Backward-Compatible JSON Schema**: The `--json` output preserves `timestamp`, `isSuccess`, `summary` (`total`, `passed`, `warnings`, `failures`), and `groups`, while extending the payload with `appliedFixes` and `commonFailureFixes`.
