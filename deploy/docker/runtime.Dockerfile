# 构建上下文是解压后的程序目录，例如 /opt/s3dfs，不是 git 源码。
# docker build -f deploy/docker/runtime.Dockerfile -t s3dfs /opt/s3dfs
FROM oven/bun:1.4
WORKDIR /opt/s3dfs
COPY . /opt/s3dfs
VOLUME /var/lib/s3dfs
EXPOSE 9000 9100 9001
