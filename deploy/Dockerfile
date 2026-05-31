# VousFin backend (Node/Express) — production image.
# Build from the backend root:  docker build -f deploy/Dockerfile -t vousfin-backend .
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Install only production deps (reproducible).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source.
COPY . .

# Non-root for safety.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/v1/health || exit 1

CMD ["node", "server.js"]
