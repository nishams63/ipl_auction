# Production Dockerfile for IPL Auction Simulator Backend
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment defaults
ENV NODE_ENV=production
ENV PORT=4000

# Copy package files and install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy server application, persistence layer, data, and scripts
COPY server/ ./server/
COPY scripts/ ./scripts/

# Expose internal listening port
EXPOSE 4000

# Healthcheck configuration using built-in Node or wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4000/api/health || exit 1

# Start authoritative server
CMD ["node", "server/index.js"]
