FROM node:lts-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY audit.js .audit-ignore.json ./

ENV NODE_NO_WARNINGS=1

ENTRYPOINT ["node", "audit.js"]
