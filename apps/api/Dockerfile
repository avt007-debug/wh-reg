# Multi-stage build for the API and the worker (same image, different command).
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @wh/api... \
 && pnpm --filter @wh/shared build && pnpm --filter @wh/api build \
 && pnpm deploy --filter @wh/api --prod /out

FROM node:22-slim
ENV NODE_ENV=production TZ=Asia/Kolkata
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
