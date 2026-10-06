FROM node:20-alpine

# docker CLI + compose plugin + git are shelled out to for every operation
# (see spec.md) -- the manager process itself never talks to the Docker API
# directly, it just needs these binaries and the socket mount below.
RUN apk add --no-cache docker-cli docker-cli-compose git

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
