# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Kolkata

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/config/generated_flows /app/imports /app/config-default \
  && cp -a /app/config/. /app/config-default/ \
  && sed -i 's/\r$//' /app/deploy/docker/entrypoint.sh \
  && chmod +x /app/deploy/docker/entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/app/deploy/docker/entrypoint.sh"]
CMD ["node", "server.js"]
