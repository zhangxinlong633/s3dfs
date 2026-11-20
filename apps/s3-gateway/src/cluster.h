#ifndef S3DFS_GATEWAY_CLUSTER_H
#define S3DFS_GATEWAY_CLUSTER_H

#include "common.h"
#include "http.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MAX_INDEX_URLS 8
#define MAX_BLOCK_NODES 64
#define MAX_REPLICAS 8
#define MAX_LIST_OBJECTS 10000

typedef struct {
    char host[256];
    int port;
    char base[512]; /* http://host:port with no trailing slash */
} index_ep_t;

typedef struct {
    char node_id[128];
    char address[256];
    char host[256];
    int port;
    char status[16]; /* up, down, unknown */
    char zone[64];
    uint64_t last_seen_ms;
    char last_error[128];
} block_node_t;

typedef struct {
    int v;
    int replica;
    int replica_count;
    char node_id[128];
    char address[256];
    char host[256];
    int port;
    uint64_t rec_id;
    int chained;
    uint64_t generation;
    uint32_t extent_count;
    uint64_t size;
    uint64_t stored_size;
    compress_type_t compress_type;
    uint32_t crc;
    uint64_t mtime_ms;
} object_locator_t;

typedef struct {
    void *value;
    size_t size;
    uint32_t crc;
    uint64_t mtime_ms;
    compress_type_t compress_type;
    uint64_t total_size;
} object_value_t;

typedef struct {
    char key[1024];
    uint64_t size;
    uint32_t crc;
    uint64_t mtime_ms;
} list_obj_t;

typedef struct {
    list_obj_t *objects;
    size_t object_count;
    char **prefixes;
    size_t prefix_count;
    int truncated;
    char next_token[1024];
} list_result_t;

typedef struct {
    char name[256];
    uint64_t mtime_ms;
} bucket_info_t;

typedef struct {
    index_ep_t index[MAX_INDEX_URLS];
    int index_count;
    block_node_t nodes[MAX_BLOCK_NODES];
    int node_count;
    pthread_rwlock_t lock;
    int data_replicas;
    compress_type_t compress_type;
    int health_interval_ms;
    int stop;
    pthread_t health_thread;
    int health_started;
} cluster_t;

int cluster_init(cluster_t *c, const char *index_urls, const char *block_seeds,
                 int data_replicas, compress_type_t compress, int health_interval_ms);
void cluster_free(cluster_t *c);
int cluster_refresh(cluster_t *c);

void object_key(const char *bucket, const char *key, char *out, size_t cap);

int cluster_put(cluster_t *c, const char *bucket, const char *key, const void *value, size_t len, uint32_t *crc_out);
int cluster_get(cluster_t *c, const char *bucket, const char *key, object_value_t *out);
int cluster_get_range(cluster_t *c, const char *bucket, const char *key, uint64_t start, uint64_t end,
                      object_value_t *out);
int cluster_head(cluster_t *c, const char *bucket, const char *key, object_value_t *out);
int cluster_delete(cluster_t *c, const char *bucket, const char *key);
int cluster_create_bucket(cluster_t *c, const char *bucket);
int cluster_delete_bucket(cluster_t *c, const char *bucket);
int cluster_bucket_exists(cluster_t *c, const char *bucket);
int cluster_list_buckets(cluster_t *c, bucket_info_t **out, size_t *n);
int cluster_list(cluster_t *c, const char *bucket, const char *prefix, const char *start_after, int max_keys,
                 const char *delimiter, list_result_t *out);
void list_result_free(list_result_t *r);
void object_value_free(object_value_t *v);

#ifdef __cplusplus
}
#endif

#endif
