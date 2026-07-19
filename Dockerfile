# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/data ./data
COPY --from=builder /app/package.json ./package.json

USER node

EXPOSE 3100

HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=30s \
  CMD node -e "\
    const http = require('http'); \
    const req = http.get('http://localhost:3100/health/live', (res) => { \
      process.exit(res.statusCode === 200 ? 0 : 1); \
    }); \
    req.on('error', () => process.exit(1)); \
    req.end(); \
  "

CMD ["node", "dist/main.js"]
