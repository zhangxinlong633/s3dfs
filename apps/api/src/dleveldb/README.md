# 已拆出

对象索引不再由本进程内嵌的 `@s3dfs/dleveldb` 提供。S3 API 作为客户端，访问独立的 [dleveldb](https://github.com/zhangxinlong633/dleveldb) 集群（默认 `http://127.0.0.1:9800`）。这些 middleware 文件已不再挂到 `AppModule`。
