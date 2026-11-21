# 构建上下文是旁边的 dleveldb 仓库，不是本仓库。
# docker build -f deploy/docker/index.Dockerfile -t dleveldb ../dleveldb
FROM oven/bun:1.4
WORKDIR /opt/dleveldb
COPY . .
RUN bun install
VOLUME /var/lib/s3dfs
EXPOSE 9800
CMD ["bun", "packages/dleveldb/src/cli.ts"]
