FROM node:lts-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY audit.js server.js .audit-ignore.json ./
COPY lib/ ./lib/

ENV NODE_NO_WARNINGS=1
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "server.js"]
