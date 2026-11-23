# 构建上下文是本仓库里的 dleveldb 目录。
# docker build -f deploy/docker/index.Dockerfile -t dleveldb dleveldb
FROM oven/bun:1.4
WORKDIR /opt/dleveldb
COPY . .
RUN bun install
VOLUME /var/lib/s3dfs
EXPOSE 9800
CMD ["bun", "packages/dleveldb/src/dleveldb.ts"]
