#ifndef S3DFS_STAGE_H
#define S3DFS_STAGE_H

#include <stdint.h>

#include "s3dfs.h"

typedef struct stage_job {
    uint64_t id;
    int fd;
    int net_index;
    int keep;
    char *object_key;
    uint8_t *body;
    uint32_t body_len;
    uint32_t crc;
    s3dfs_locator loc;
    int rc;
} stage_job;

typedef void (*stage_indexed_fn)(stage_job *job);

/* Network threads accept and answer. Block threads call s3dfs_put.
   When a block write finishes, indexed() runs so the index can be written,
   then stage_reply sends the HTTP response on a network thread. */
int stage_start(s3dfs_store *store, const char *host, int port, int net_threads, int blk_threads, int backend_port,
                const char *access_key, const char *secret, stage_indexed_fn indexed);
int stage_reply(uint64_t id, int status);

#endif
