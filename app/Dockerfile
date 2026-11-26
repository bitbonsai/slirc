FROM docker.io/oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 8080
CMD ["sh", "-c", "bun src/direct-readiness.ts check || exit 1; until bun src/migrate-founder.ts; do sleep 1; done; (bun src/seed.ts || echo \"seed failed\" >&2) & exec bun src/main.ts"]
