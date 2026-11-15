# syntax=docker/dockerfile:1
# Bounty Hunter bot — plain Node, no native modules.
# (Like pb-bot and unlike the bingo bot there is no `canvas` here, so no
# Cairo/Pango libs: boards are Discord embeds, not generated images.)
FROM node:20-bookworm-slim

WORKDIR /app

# Install deps first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# No inbound HTTP server — this is a Discord gateway client, so nothing is exposed.
CMD ["node", "index.js"]
