#ifndef S3DFS_ENGINE_INT_H
#define S3DFS_ENGINE_INT_H

#include "s3dfs.h"

#include <pthread.h>
#include <stdint.h>

#define S3DFS_PAGE_SLOTS 20480u
#define S3DFS_PAGE_SLOT 4u
#define S3DFS_PAGE_DATA S3DFS_PAGE_SLOTS
#define S3DFS_PAGE_VALUE (S3DFS_PAGE_SLOTS * S3DFS_PAGE_SLOT)
#define S3DFS_PAGE_TLV 6u
#define S3DFS_PAGE_META 16u
#define S3DFS_PAGE_HEADER (S3DFS_PAGE_TLV + S3DFS_PAGE_META)
#define S3DFS_PAGE_LEN (S3DFS_PAGE_META + S3DFS_PAGE_VALUE)
#define S3DFS_PAGE_ON_DISK (S3DFS_PAGE_TLV + S3DFS_PAGE_LEN)

typedef struct s3dfs_page_ent {
    uint64_t block_id;
    uint64_t first_rec_id;
    uint64_t file_off;
    uint64_t next_off;
    uint64_t src_block;
    uint32_t filled;
} s3dfs_page_ent;

typedef struct s3dfs_job s3dfs_job;

/* One write thread, one open .blk. */
typedef struct s3dfs_lane {
    struct s3dfs_store *store;
    int fd;
    uint64_t block_id;
    uint64_t size;
    uint8_t *buf;
    uint32_t buf_used;
    int pending_sync;
    uint8_t *page_slots;
    uint32_t page_cached;
    int page_dirty;
    uint32_t page_index;
    int fresh_page;
    uint64_t rec_cursor;
    uint64_t rec_end;
    pthread_t thread;
    pthread_mutex_t qmu;
    pthread_cond_t qcv;
    s3dfs_job *qhead;
    s3dfs_job *qtail;
    int stop;
    int started;
} s3dfs_lane;

struct s3dfs_job {
    void (*fn)(void *);
    void *arg;
    int done;
    pthread_cond_t cv;
    s3dfs_job *next;
};

struct s3dfs_store {
    char data_dir[4096];
    char blocks_dir[4096];
    uint64_t block_size;
    uint32_t buffer_size;
    int fsync_on_flush;

    uint64_t put_generation;
    uint64_t next_rec_id;
    uint64_t next_block_id;
    uint64_t dead_bytes;
    uint64_t tickets;

    struct s3dfs_rec_ent *rec_tab;
    uint32_t rec_cap;
    uint32_t rec_count;
    struct s3dfs_key_ent *key_tab;
    uint32_t key_cap;
    uint32_t key_count;
    s3dfs_page_ent *pages;
    uint32_t page_n;
    uint32_t page_cap;
    uint8_t **compact_slots;

    s3dfs_lane *lanes;
    uint32_t nlanes;
    int exclusive;

    s3dfs_stats stats;
    pthread_mutex_t mu;
};

extern __thread s3dfs_lane *s3dfs_tls_lane;
extern __thread int s3dfs_hold_depth;

static inline s3dfs_lane *lane_of(s3dfs_store *s)
{
    if (s3dfs_tls_lane && s3dfs_tls_lane->store == s) {
        return s3dfs_tls_lane;
    }
    return &s->lanes[0];
}

void s3dfs_store_lock(s3dfs_store *s);
void s3dfs_store_unlock(s3dfs_store *s);
void s3dfs_store_io_begin(s3dfs_store *s);
void s3dfs_store_io_end(s3dfs_store *s);

int s3dfs_lanes_init(s3dfs_store *s, uint32_t n);
int s3dfs_lanes_start(s3dfs_store *s);
void s3dfs_lanes_stop(s3dfs_store *s);
/* Run fn on the lane chosen by key. fn runs on that lane's thread with tls set. */
void s3dfs_lane_call(s3dfs_store *s, const char *key, uint32_t key_len, void (*fn)(void *), void *arg);
void s3dfs_lane_call_at(s3dfs_store *s, uint32_t index, void (*fn)(void *), void *arg);
void s3dfs_lane_call_all(s3dfs_store *s, void (*fn)(void *), void *arg);

#endif
