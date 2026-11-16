#ifndef S3DFS_H
#define S3DFS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define S3DFS_OK            0
#define S3DFS_ERR           -1
#define S3DFS_ERR_NOT_FOUND -2
#define S3DFS_ERR_IO        -3
#define S3DFS_ERR_ARGS      -4
#define S3DFS_ERR_NOMEM     -5

typedef struct s3dfs_store s3dfs_store;

typedef struct s3dfs_options {
    uint64_t block_size;  /* default 1 GiB */
    uint32_t buffer_size; /* default 1 MiB group-commit buffer */
    int fsync_on_flush;   /* default 1 */
} s3dfs_options;

typedef struct s3dfs_stats {
    uint64_t objects;
    uint64_t deleted;
    uint64_t bytes_logical;
    uint64_t bytes_on_disk;
    uint64_t block_files;
    uint64_t puts;
    uint64_t gets;
    uint64_t deletes;
    uint64_t flushes;
    uint64_t fsyncs;
    uint64_t index_slots;
} s3dfs_stats;

typedef struct s3dfs_object_info {
    const char *key;
    uint32_t key_len;
    uint32_t size;
    uint32_t crc;
    uint64_t mtime_ms;
} s3dfs_object_info;

typedef struct s3dfs_put_item {
    const char *key;
    uint32_t key_len;
    const void *value;
    uint32_t value_len;
} s3dfs_put_item;

s3dfs_store *s3dfs_open(const char *data_dir, const s3dfs_options *opt);
void s3dfs_close(s3dfs_store *store);

int s3dfs_put(s3dfs_store *store, const char *key, uint32_t key_len,
              const void *value, uint32_t value_len);
int s3dfs_put_batch(s3dfs_store *store, const s3dfs_put_item *items, uint32_t n);
int s3dfs_get(s3dfs_store *store, const char *key, uint32_t key_len,
              void **out, uint32_t *out_len, uint32_t *crc, uint64_t *mtime_ms);
void s3dfs_free(void *p);
int s3dfs_head(s3dfs_store *store, const char *key, uint32_t key_len,
               uint32_t *size, uint32_t *crc, uint64_t *mtime_ms);
int s3dfs_delete(s3dfs_store *store, const char *key, uint32_t key_len);
int s3dfs_flush(s3dfs_store *store);
int s3dfs_compact(s3dfs_store *store);
int s3dfs_list(s3dfs_store *store, const char *prefix, uint32_t prefix_len,
               const char *start_after, uint32_t start_after_len,
               uint32_t max_keys, s3dfs_object_info *out, uint32_t *out_n,
               int *truncated);
void s3dfs_get_stats(s3dfs_store *store, s3dfs_stats *out);

#ifdef __cplusplus
}
#endif

#endif /* S3DFS_H */
