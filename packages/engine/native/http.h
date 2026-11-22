#ifndef S3DFS_HTTP_H
#define S3DFS_HTTP_H

#include <stddef.h>
#include <stdint.h>

#include "s3dfs.h"

typedef struct s3dfs_http s3dfs_http;

typedef struct s3dfs_http_reply {
    int status;
    char *content_type;
    char *extra_headers;
    uint8_t *body;
    size_t body_len;
} s3dfs_http_reply;

typedef int (*s3dfs_http_fallback)(void *user, const char *method, const char *url, const char *const *names,
                                   const char *const *values, int nheaders, const uint8_t *body, size_t body_len,
                                   s3dfs_http_reply *reply);

/* Bind host:port. port 0 picks an ephemeral port. *bound_port receives the actual port. */
int s3dfs_http_listen(s3dfs_store *store, const char *host, int port, int threads, s3dfs_http_fallback fallback,
                      void *fallback_user, s3dfs_http **out, int *bound_port);
typedef struct s3dfs_http_stats {
    uint64_t accepted;
    uint64_t puts;
    uint64_t gets;
    uint64_t others;
    uint64_t put_us;
    uint64_t get_us;
    uint64_t put_max_us;
    uint64_t get_max_us;
    uint64_t queue_wait_us;
    uint64_t queue_wait_max_us;
    uint64_t ready_max;
    uint64_t idle_max;
    uint64_t ready_now;
    uint64_t idle_now;
} s3dfs_http_stats;

void s3dfs_http_get_stats(s3dfs_http *http, s3dfs_http_stats *out);
/* Wake accept and in-flight reads. Safe to call from the JavaScript thread. */
void s3dfs_http_shutdown(s3dfs_http *http);
/* Join worker threads. Call after fallback calls have been aborted. */
void s3dfs_http_join(s3dfs_http *http);

#endif
