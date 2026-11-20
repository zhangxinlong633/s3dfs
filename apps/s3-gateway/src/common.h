#ifndef S3DFS_GATEWAY_COMMON_H
#define S3DFS_GATEWAY_COMMON_H

#define _GNU_SOURCE
#define _DARWIN_C_SOURCE

#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

#define S3DFS_OK 0
#define S3DFS_ERR -1
#define S3DFS_ERR_NOT_FOUND -2
#define S3DFS_ERR_IO -3
#define S3DFS_ERR_ARGS -4
#define S3DFS_ERR_NOMEM -5
#define S3DFS_ERR_UNAVAILABLE -6
#define S3DFS_ERR_UNSATISFIABLE -7

#define MIN_COMPRESS_BYTES 64

typedef enum {
    COMPRESS_NONE = 0,
    COMPRESS_ZSTD = 1,
    COMPRESS_GZIP = 2
} compress_type_t;

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} buf_t;

int buf_reserve(buf_t *b, size_t need);
int buf_append(buf_t *b, const void *p, size_t n);
int buf_append_str(buf_t *b, const char *s);
int buf_printf(buf_t *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void buf_clear(buf_t *b);
void buf_free(buf_t *b);

void log_info(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void log_error(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

uint64_t now_ms(void);
void format_iso8601(uint64_t ms, char *out, size_t cap);
void format_rfc1123(uint64_t ms, char *out, size_t cap);

uint32_t crc32_ieee(const void *data, size_t n);
void sha1_buf(const void *data, size_t n, unsigned char out[20]);
uint32_t sha1_u32be(const void *data, size_t n);

/* Match Node.js encodeURIComponent / decodeURIComponent. */
int url_encode(const char *in, size_t in_len, buf_t *out);
int url_decode(const char *in, size_t in_len, buf_t *out);
int url_decode_str(const char *in, char *out, size_t cap);

int xml_escape(const char *in, buf_t *out);
int json_escape(const char *in, buf_t *out);

const char *compress_name(compress_type_t t);
compress_type_t parse_compress_type(const char *raw);
int compress_value(const void *in, size_t in_len, compress_type_t prefer,
                   void **out, size_t *out_len, compress_type_t *applied);
int decompress_value(const void *in, size_t in_len, compress_type_t type,
                     size_t orig_size, void **out, size_t *out_len);

int parse_hostport(const char *s, char *host, size_t host_cap, int *port);
int parse_listen(const char *s, char *host, size_t host_cap, int *port);
int parse_http_url(const char *s, char *host, size_t host_cap, int *port, char *path, size_t path_cap);

void set_sock_opts(int fd, int timeout_ms);
int set_nonblock(int fd, int nb);

/* Case-insensitive header compare, token length n vs NUL-terminated name. */
int header_ieq(const char *a, size_t a_len, const char *name);

typedef enum {
    RANGE_ALL = 0,
    RANGE_PARTIAL = 1,
    RANGE_UNSATISFIABLE = 2
} range_kind_t;

typedef struct {
    range_kind_t kind;
    uint64_t start;
    uint64_t end;
} byte_range_t;

byte_range_t parse_byte_range(const char *header, uint64_t size);

int json_find_key(const char *json, size_t len, const char *key, const char **val, size_t *val_len);
int json_get_i64(const char *json, size_t len, const char *key, int64_t *out);
int json_get_u64(const char *json, size_t len, const char *key, uint64_t *out);
int json_get_u32(const char *json, size_t len, const char *key, uint32_t *out);
int json_get_bool(const char *json, size_t len, const char *key, int *out);
int json_get_string(const char *json, size_t len, const char *key, char *out, size_t cap);
int json_get_bool_or(const char *json, size_t len, const char *key, int default_val);

typedef int (*json_obj_cb)(const char *obj, size_t len, void *ud);
int json_array_objects(const char *json, size_t len, const char *array_key, json_obj_cb cb, void *ud);

int is_node_key(const char *key);
int is_replica_locator_key(const char *key);
int is_visible_object_key(const char *key);
void locator_key(const char *object_key, int replica, char *out, size_t cap);

#ifdef __cplusplus
}
#endif

#endif
