# Streaming sync worker. Build context is the repo root (it shares src/ and the
# lockfile with the Next app), so deploy with:
#   flyctl deploy --config worker/fly.toml --dockerfile worker/Dockerfile
FROM node:22-slim

WORKDIR /app

# Install deps from the shared lockfile. tsx (a devDependency) is needed at
# runtime, so don't omit dev dependencies.
COPY package.json package-lock.json ./
RUN npm ci

# App + worker source. .dockerignore keeps node_modules/.next/.env* out.
COPY . .

ENV NODE_ENV=production

# Long-running process, no inbound HTTP.
CMD ["npx", "tsx", "worker/index.ts"]
