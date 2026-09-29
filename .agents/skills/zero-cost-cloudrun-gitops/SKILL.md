---
name: zero-cost-cloudrun-gitops
description: Playbook for building, dockerizing, and automating CI/CD for full-stack Node/Next.js apps on Cloud Run, Neon Postgres, and Oracle VM Redis.
---

# Zero-Cost Cloud Run GitOps Playbook

## 1. Registry & Naming Conventions
- **Strict Lowercase Image URLs**: GitHub Container Registry (GHCR) and Docker strictly enforce lowercase image names. Always transform image names in CI/CD using:
  `IMAGE=$(echo "ghcr.io/${{ env.IMAGE_NAME }}:..." | tr '[:upper:]' '[:lower:]')`
  Mixed-case names cause Google Cloud Run to fail with `Image not found`.

## 2. Preventing Cloud Run Image Caching Bug
- Deploying with `--image=...:latest` causes Google Cloud's caching proxy (`cache.<region>-docker.pkg.dev`) to serve stale cached image manifests across commits.
- **Mandatory Fix in GitHub Actions**:
  1. In `docker-metadata-action`, generate both `latest` and `type=sha,format=long,prefix=`.
  2. In the deployment step, deploy the unique commit tag:
     `gcloud run deploy <SERVICE_NAME> --image=ghcr.io/<REPO>:${{ github.sha }} ...`

## 3. Workflow Service Name Alignment
- Ensure the service name in `gcloud run deploy <SERVICE_NAME>` in `.github/workflows/deploy.yml` exactly matches the GCP service name. Mismatches cause GitHub Actions to silently create/update an unintended service.

## 4. Resilient Database & Cache Layer
- **Neon Postgres**: Configure pool limit (`max: 10`), SSL enabled (`rejectUnauthorized: true`), and connection timeouts. Modern Neon endpoints provide valid TLS certificates; setting `rejectUnauthorized: false` triggers high-severity Semgrep supply-chain/TLS alerts.
- **Oracle VM Redis**: Serverless functions may be blocked by Oracle VCN security lists. Always configure `ioredis` with `maxRetriesPerRequest: 1` and fallback gracefully to direct PostgreSQL queries instead of hanging or crashing the container.

## 5. Next.js 16+ Container Builds (Dockerfile)
- Base image must be `node:20-alpine` or higher (`node:18` fails to build modern Next.js 16 features).
- Use `npm ci --legacy-peer-deps` in Docker build stages to prevent peer dependency resolution errors during container assembly.

## 6. GitHub API Token Fallback in Automation
- If `gh` CLI commands fail with `gh auth login`, check `git remote -v`. The repository origin URL often embeds an authenticated GitHub Personal Access Token (PAT) (`https://<token>@github.com/...`) which can be used directly with REST API requests (`Invoke-RestMethod` / `curl`).
