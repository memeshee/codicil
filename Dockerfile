# One Node process, zero third-party dependencies, so the image is a base, a copy and a CMD.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

# No npm install: the runtime is the Node standard library plus node:sqlite.
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data
EXPOSE 8080

# Type stripping and sqlite are still flagged in Node 22; both are what the product uses.
CMD ["node", "--experimental-sqlite", "--experimental-strip-types", "src/server.ts"]
