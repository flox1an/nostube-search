# ---- Build stage ----
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc --project tsconfig.json


# ---- Runtime stage ----
FROM node:22-slim AS runner

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Static UI assets must be at src/api/public/ relative to WORKDIR
# (matches the hardcoded path in server.ts)
COPY src/api/public ./src/api/public

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/api/server.js"]
