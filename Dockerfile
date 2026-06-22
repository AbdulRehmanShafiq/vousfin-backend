# Portable container for the VousFin backend — runs on any card-free container
# host (Koyeb, Back4App Containers, Northflank, etc.). The host injects PORT;
# the app reads process.env.PORT (config.PORT), so no port is hard-coded.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching). Full install (not --omit=dev)
# so nothing breaks if a runtime module is misplaced in devDependencies.
COPY package*.json ./
RUN npm install

# App source.
COPY . .

ENV NODE_ENV=production

# Documentation only; the platform's PORT env var is what the app actually binds to.
EXPOSE 8000

CMD ["npm", "start"]
