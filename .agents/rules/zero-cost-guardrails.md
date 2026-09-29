---
description: Strict $0 budget invariant and cloud resource provisioning guardrails
always_on: true
---

# Zero-Cost & Cloud Billing Guardrails

1. **Strict $0.00 Financial Limit**:
   - The user has debit cards linked to cloud accounts (Oracle Cloud, Google Cloud). NEVER run commands, enable features, or propose architectures that incur financial cost.
   - Do not trigger account tier upgrades (e.g., leaving the Free Trial or upgrading to Pay-As-You-Go) without explicit user confirmation.

2. **Google Cloud Run Invariants**:
   - Always enforce `--min-instances=0` to ensure containers scale to zero when idle.
   - Cap `--max-instances=2` (or minimal threshold) to prevent runaway costs during traffic spikes.
   - Always verify `--allow-unauthenticated` for public APIs/apps.
   - Always select CPU allocation: "CPU is only allocated during request processing".

3. **Oracle Cloud Always-Free Invariants**:
   - Keep compute instances strictly within Always-Free limits (e.g., VM.Standard.E2.1.Micro or Ampere within free quota).
   - Configure memory swap and cap Redis memory (`maxmemory 200mb`, `maxmemory-policy volatile-lru`) to prevent OOM termination on 1GB RAM instances.
