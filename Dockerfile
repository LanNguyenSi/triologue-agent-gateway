FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

FROM node:22-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist dist/
# State files (read tracker, metrics log, JWT cache) live in STATE_DIR, owned by
# the unprivileged runtime user; /app itself stays root-owned.
RUN mkdir -p /app/state && chown app:app /app/state
USER app
ENV PORT=9500
ENV STATE_DIR=/app/state
EXPOSE 9500
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:9500/health || exit 1
CMD ["node", "dist/index.js"]
