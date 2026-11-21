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

/* On-disk block records are little-endian TLV frames (magic "S3R1"):
 *
 *   magic u32 | rec_len u32 | tags... | crc32 u32 | rec_len u32 | magic u32
 *
 * Each tag is: type u16 | length u32 | value[length].
 * Unknown tags are skipped, so new fields can be added without breaking
 * readers. A torn write is detected by magic / rec_len / crc mismatch.
 * Scanning every .blk file is enough to rebuild the object index.
 */

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
    uint64_t dead_bytes;
    uint64_t tickets;
    uint64_t unflushed_bytes;
} s3dfs_stats;

/* Optional attributes written as TLV tags so a later index rebuild can
   recover compression metadata. compress_type: 0=none, 1=zstd, 2=gzip. */
typedef struct s3dfs_put_meta {
    uint8_t has_meta;
    uint8_t compress_type;
    uint64_t orig_size;
    uint32_t orig_crc;
} s3dfs_put_meta;

/* Location of the last extent (or the only record). The stable identifier
   is rec_id; block_id/offset/rec_len are the current physical location in
   the node's map and may change after compaction. dleveldb stores rec_id. */
typedef struct s3dfs_locator {
    uint8_t chained;
    uint8_t tombstone;
    uint32_t crc;
    uint64_t mtime_ms;
    uint64_t size;
    uint64_t generation;
    uint32_t extent_count;
    uint64_t rec_id;
    uint64_t block_id;
    uint64_t offset;
    uint32_t rec_len;
    uint8_t compress_type;
    uint64_t orig_size;
    uint32_t orig_crc;
} s3dfs_locator;

typedef struct s3dfs_put_item {
    const char *key;
    uint32_t key_len;
    const void *value;
    uint32_t value_len;
} s3dfs_put_item;

typedef int (*s3dfs_scan_cb)(void *user, const char *key, uint32_t key_len, const s3dfs_locator *loc);

s3dfs_store *s3dfs_open(const char *data_dir, const s3dfs_options *opt);
void s3dfs_close(s3dfs_store *store);

int s3dfs_put(s3dfs_store *store, const char *key, uint32_t key_len,
              const void *value, uint32_t value_len, const s3dfs_put_meta *meta,
              s3dfs_locator *out);
int s3dfs_put_batch(s3dfs_store *store, const s3dfs_put_item *items, uint32_t n,
                    const s3dfs_put_meta *meta, s3dfs_locator *out);
int s3dfs_tombstone(s3dfs_store *store, const char *key, uint32_t key_len);
int s3dfs_get_at(s3dfs_store *store, const char *key, uint32_t key_len,
                 const s3dfs_locator *loc, void **out, uint32_t *out_len,
                 uint32_t *crc, uint64_t *mtime_ms);
/* Copy only [start, start+len) of the stored bytes. len must fit in uint32. */
int s3dfs_read_span(s3dfs_store *store, const char *key, uint32_t key_len, const s3dfs_locator *loc,
                    uint64_t start, uint64_t len, void **out, uint32_t *out_len);
typedef struct s3dfs_writer s3dfs_writer;
/* Append extents so the object size is a uint64, not one uint32 value. */
s3dfs_writer *s3dfs_write_begin(s3dfs_store *store, const char *key, uint32_t key_len, const s3dfs_put_meta *meta);
int s3dfs_write(s3dfs_writer *writer, const void *data, uint32_t len);
void s3dfs_write_set_meta(s3dfs_writer *writer, const s3dfs_put_meta *meta);
int s3dfs_write_finish(s3dfs_writer *writer, s3dfs_locator *out);
void s3dfs_write_abort(s3dfs_writer *writer);
void s3dfs_free(void *p);
int s3dfs_head_at(s3dfs_store *store, const char *key, uint32_t key_len,
                  const s3dfs_locator *loc, uint64_t *size, uint32_t *crc,
                  uint64_t *mtime_ms);
int s3dfs_scan(s3dfs_store *store, s3dfs_scan_cb cb, void *user);
typedef struct s3dfs_audit_report {
    uint64_t records;
    uint64_t bad;
    uint64_t bytes;
} s3dfs_audit_report;
/* Reread every stored record and check its frame checksum. */
int s3dfs_audit(s3dfs_store *store, s3dfs_audit_report *out);
int s3dfs_flush(s3dfs_store *store);
int s3dfs_compact(s3dfs_store *store);
void s3dfs_get_stats(s3dfs_store *store, s3dfs_stats *out);

#ifdef __cplusplus
}
#endif

#endif /* S3DFS_H */
