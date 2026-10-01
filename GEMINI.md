# Sagentic - Project Guidelines & Standing Rules

## 1. Communication Style

- **Language**: Strictly respond in **Hinglish** (Hindi written in English alphabet / Roman script).
- **Tone & Conciseness**: High conciseness, low verbosity. Keep answers crisp, technical, and directly to the point. No fluff or unnecessary preambles.
- **Pull Requests**: PR titles and PR descriptions must be written in **English** (chat replies stay Hinglish).

## 2. Core Prohibitions & Boundaries

- **Push to GitHub**: Always ask user before pushing to github. If ever instructed to push, never announce the push.
- **GitHub Organization Guardrail**: If the user begins micromanaging commit history or giving prompts solely to make GitHub look clean/organized, intervene and remind:
  > _"Isme time aur token waste mat karo, baad me ek hi baar me pura clean aur organize kar denge."_
- **Semantics**: Do not change '' to "" or vice versa where it does not cause error.
- **No Legacy Backward-Compatibility Shims**: The application is in active development with no external users. Do NOT introduce transitional fallbacks, legacy compatibility bridges, or backward-compatibility workarounds (e.g. fallback secrets, legacy schema shims, or multi-version branching) to preserve obsolete versions. Always enforce clean, modern, and hardened cut-overs.

## 3. Architecture & Infrastructure

- **Backend**: Fastify v5 running on Node.js 20+ / TypeScript, optimized for Google Cloud Run container deployment.
- **Database**: Neon Serverless PostgreSQL with `pgvector` extension for semantic document retrieval and conversational memory.
- **Cache & Ephemeral State**: Redis hosted on Oracle Cloud Always-Free VM.
- **AI Model Orchestration**: Primary Cloudflare Workers AI fine-tuned LoRA models (`@cf/meta/llama-3.1-8b-instruct`) with automated fallback to Google Gemini 2.5 (`@google/genai`).

## 4. Zero-Cost & Financial Guardrails

- **Strict $0.00 Limit**: Debit cards are attached to cloud accounts. NEVER execute commands, provision resources, or suggest designs that trigger billing or charges.
- **Cloud Run Scale-to-Zero**: Always configure `--min-instances=0` and cap `--max-instances=2` (or minimal threshold). Ensure CPU is only allocated during request processing.
- **Oracle Free-Tier Safeguards**: Stay within Always-Free compute limits. Cap Redis RAM usage (`maxmemory 200mb`, `volatile-lru`) to prevent OOM on 1GB instances.

## 5. Security & Pipeline Invariants

- **Zero Hardcoded Secrets & Credentials Invariant**:
  - NEVER hardcode, paste, or default credentials, database passwords, API tokens, connection strings, or private keys into ANY Git-tracked file (including test scripts, scratch files, configs, documentation, or workflows).
  - Always read secrets from environment variables with generic placeholders (e.g., `'REPLACE_WITH_SECRET'`) if fallbacks are needed.
  - Actual credentials must ONLY reside in `.env` (git-ignored) or platform Secret Managers (Cloud Run / GitHub Secrets).
- **GitHub Actions Shell Injection Prevention**:
  - Never interpolate `${{ ... }}` context expressions (such as `github.event.*`, `inputs.*`, `vars.*`) directly inside `run:` inline bash scripts in `.github/workflows/`. Always map them to intermediate environment variables in `env:` and access them via `"$ENV_VAR"` in shell scripts.
- **Zod v4 API Invariants**:
  - Always use `error.issues` instead of `error.errors`.
  - Do NOT manually type-annotate `err` in `error.issues.forEach((err) => ...)` (Zod v4 `$ZodIssue.path` is `PropertyKey[]`, including `symbol`).
  - Always use two arguments for `z.record(z.string(), ...)` instead of `z.record(...)`.
- **Security Workflow Consolidation**:
  - Maintain unified workflows: `security-push.yml` for fast blocking PR/push guards (Gitleaks, Semgrep SAST, NPM Audit / Socket, CodeQL) and `security-daily.yml` for deep scans (Trivy, Promptfoo AI guardrails).
- **Container Hardening**:
  - Enforce non-root execution (`USER node`) in multi-stage Dockerfiles.
