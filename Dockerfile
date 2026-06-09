FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY public/ ./public/
COPY tsconfig.json ./

VOLUME ["/app/data"]

EXPOSE 8080

CMD ["bun", "src/server.ts"]
