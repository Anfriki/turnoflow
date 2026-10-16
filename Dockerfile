# ── Build ──
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Runtime ──
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY public ./public
COPY brand.config.js package.json ./
USER node
EXPOSE 3000
# Aplica migraciones pendientes y arranca
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/server.js"]
