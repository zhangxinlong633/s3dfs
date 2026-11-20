#ifndef S3DFS_FUSE_S3CLIENT_H
#define S3DFS_FUSE_S3CLIENT_H

#include <stddef.h>
#include <stdint.h>
#include <time.h>

typedef struct s3_client {
    char *endpoint;
    char *bucket;
} s3_client;

typedef struct s3_meta {
    int found;
    int64_t size;
    time_t mtime;
    char etag[128];
} s3_meta;

typedef struct s3_object {
    char *key;
    int64_t size;
    time_t mtime;
} s3_object;

typedef struct s3_listing {
    s3_object *objects;
    size_t object_count;
    char **prefixes;
    size_t prefix_count;
    int truncated;
    char *next_token;
} s3_listing;

s3_client *s3_client_new(const char *endpoint, const char *bucket);
void s3_client_free(s3_client *c);

int s3_head(s3_client *c, const char *key, s3_meta *out, char *err, size_t errcap);
int s3_get(s3_client *c, const char *key, const char *range_header, uint8_t **body, size_t *len, s3_meta *out,
           char *err, size_t errcap);
int s3_put(s3_client *c, const char *key, const void *body, size_t len, char *err, size_t errcap);
int s3_put_file(s3_client *c, const char *key, int fd, char *err, size_t errcap);
int s3_delete(s3_client *c, const char *key, char *err, size_t errcap);
int s3_list(s3_client *c, const char *prefix, const char *delimiter, const char *start_after, int max_keys,
            s3_listing *out, char *err, size_t errcap);
void s3_list_free(s3_listing *list);

#endif
