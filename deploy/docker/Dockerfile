FROM node:26-bookworm AS build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm dist

FROM oven/bun:1.4
WORKDIR /opt/s3dfs
COPY --from=build /src/dist /opt/s3dfs
# 数据挂在 /var/lib/s3dfs，不放进镜像。换镜像不删这块目录。
VOLUME /var/lib/s3dfs
EXPOSE 9000 9100 9001
