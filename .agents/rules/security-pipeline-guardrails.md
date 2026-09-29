---
description: Guardrails for GitHub Actions security pipelines, CodeQL versioning, Dependabot, and vulnerability scanners
always_on: true
---

# Security Pipeline & Vulnerability Scanner Guardrails

1. **CodeQL Action Lockstep Invariant**:
   - `github/codeql-action/init`, `github/codeql-action/analyze`, and `github/codeql-action/upload-sarif` MUST all be pinned to the EXACT same version or commit SHA.
   - Mismatched versions (e.g., `init` on v3, `analyze` on v4) break the post-action step with: `Loaded configuration file, but it does not contain the expected 'version' field`.

2. **Dependabot Configuration Standards**:
   - Always configure `cooldown: default-days: 7` in `.github/dependabot.yml` to satisfy Semgrep supply-chain security rules.
   - Group `github/codeql-action/*` together under a single group in `dependabot.yml` so they are updated in lockstep.
   - Ignore major breaking updates for framework dependencies (`react`, `react-dom`, `tailwindcss`, `zod`) unless explicitly requested.

3. **Unified Workflow Architecture**:
   - Do NOT create standalone workflow files for Dependabot auto-merges or checks.
   - Embed Dependabot validation gates directly inside `.github/workflows/security.yml` under a dedicated `dependabot-gate` job.

4. **Supply Chain Security & Action Pinning**:
   - Pin all third-party GitHub Actions to 40-character commit SHAs in production workflows.

5. **Scanner False-Positive & Safe Defense Patterns**:
   - **Timing Attack Dummy Hashes**: When using dummy bcrypt hashes for constant-time authentication checks, break string literals or use `// nosemgrep` annotations to avoid false-positive secret scanner alerts.
   - **Resource Exhaustion (`js/resource-exhaustion`)**: Never use `String.prototype.repeat()` with dynamic variables in loops or bot-shield routines. Use static lookup tables or strictly clamped upper bounds.
   - **Nodemailer v10 Types**: Type mail transporters with `ReturnType<typeof nodemailer.createTransport>` instead of namespace `nodemailer.Transporter`.
