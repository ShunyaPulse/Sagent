# ==============================================================================
# Sagentic Production Multi-Stage Hardened Dockerfile (Cloud Run Ready)
# Security Profile: Minimal Surface, Non-Root execution, Trivy-Hardened
# ==============================================================================

# Stage 1: Build & Compile TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY sql/ ./sql/

RUN npm run build

# Stage 2: Minimal Distroless / Hardened Alpine Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Security: Apply latest Alpine OS security updates (e.g. libcrypto3 patches)
RUN apk upgrade --no-cache

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Security Hardening: Remove package managers from production container to eliminate unused library CVEs
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn*

# Copy compiled JavaScript output and migration SQL schemas
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/sql ./sql

# Security: Execute as non-root user
USER node

EXPOSE 8080

CMD ["node", "dist/server.js"]
