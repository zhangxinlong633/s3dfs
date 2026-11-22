#define _GNU_SOURCE

#include "http.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

typedef struct http_writer {
    uint64_t id;
    s3dfs_writer *writer;
    struct http_writer *next;
} http_writer;

typedef struct conn_slot {
    int fd;
    struct conn_slot *next;
} conn_slot;

typedef struct live_conn {
    int fd;
    uint8_t *buf;
    size_t len;
    size_t cap;
    uint64_t queued_us;
    struct live_conn *next;
} live_conn;

struct s3dfs_http {
    s3dfs_store *store;
    int listen_fd;
    int wake_r;
    int wake_w;
    int stop;
    int nthreads;
    pthread_t poller;
    pthread_t *threads;
    pthread_cond_t work_cv;
    s3dfs_http_fallback fallback;
    void *fallback_user;
    pthread_mutex_t mu;
    http_writer *writers;
    uint64_t next_writer;
    conn_slot *conns;
    /* Idle keep-alive sockets stay here. A worker is only taken when poll says the socket has bytes. */
    live_conn *idle;
    live_conn *ready;
    live_conn *ready_tail;
    uint64_t accepted;
    uint64_t http_puts;
    uint64_t http_gets;
    uint64_t http_others;
    uint64_t put_us;
    uint64_t get_us;
    uint64_t put_max_us;
    uint64_t get_max_us;
    uint64_t queue_wait_us;
    uint64_t queue_wait_max_us;
    uint64_t ready_n;
    uint64_t ready_max;
    uint64_t idle_n;
    uint64_t idle_max;
};

static uint64_t mono_us(void);
static void note_route(s3dfs_http *http, int kind, uint64_t us);

typedef struct {
    int fd;
    uint8_t *buf;
    size_t len;
    size_t cap;
} conn_buf;

static const char *status_text(int status)
{
    switch (status) {
    case 200:
        return "OK";
    case 400:
        return "Bad Request";
    case 404:
        return "Not Found";
    case 500:
        return "Internal Server Error";
    default:
        return "Error";
    }
}

static const char *err_text(int rc)
{
    switch (rc) {
    case S3DFS_ERR_NOT_FOUND:
        return "not found";
    case S3DFS_ERR_IO:
        return "io error";
    case S3DFS_ERR_ARGS:
        return "invalid argument";
    case S3DFS_ERR_NOMEM:
        return "out of memory";
    default:
        return "s3dfs error";
    }
}

static int send_all(int fd, const void *data, size_t len)
{
    const uint8_t *p = (const uint8_t *)data;
    size_t off = 0;
    while (off < len) {
        ssize_t n;
#ifdef MSG_NOSIGNAL
        n = send(fd, p + off, len - off, MSG_NOSIGNAL);
#else
        n = send(fd, p + off, len - off, 0);
#endif
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                struct pollfd wait_out;
                wait_out.fd = fd;
                wait_out.events = POLLOUT;
                wait_out.revents = 0;
                if (poll(&wait_out, 1, -1) < 0 && errno != EINTR) {
                    return -1;
                }
                continue;
            }
            return -1;
        }
        if (n == 0) {
            return -1;
        }
        off += (size_t)n;
    }
    return 0;
}

static int write_response(int fd, int status, const char *type, const char *extra, const void *body, size_t len, int keep)
{
    char head[2048];
    int n = snprintf(head, sizeof(head),
                     "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: %s\r\n%s\r\n", status,
                     status_text(status), type ? type : "application/octet-stream", len, keep ? "keep-alive" : "close",
                     extra ? extra : "");
    if (n < 0 || (size_t)n >= sizeof(head)) {
        return -1;
    }
    if (send_all(fd, head, (size_t)n) != 0) {
        return -1;
    }
    if (len && body && send_all(fd, body, len) != 0) {
        return -1;
    }
    return 0;
}

static int write_json(int fd, int status, const char *json, int keep)
{
    return write_response(fd, status, "application/json; charset=utf-8", NULL, json, json ? strlen(json) : 0, keep);
}

static int write_error(int fd, int status, const char *message, int keep)
{
    char json[256];
    snprintf(json, sizeof(json), "{\"error\":\"%s\"}", message ? message : "error");
    return write_json(fd, status, json, keep);
}

static int loc_json(const s3dfs_locator *loc, char *out, size_t cap)
{
    const char *compress = "none";
    if (loc->compress_type == 1) {
        compress = "zstd";
    } else if (loc->compress_type == 2) {
        compress = "gzip";
    }
    return snprintf(out, cap,
                    "{\"chained\":%s,\"tombstone\":%s,\"crc\":%u,\"mtimeMs\":%llu,\"size\":%llu,\"generation\":%llu,"
                    "\"extentCount\":%u,\"recId\":%llu,\"compressType\":\"%s\",\"origSize\":%llu,\"origCrc\":%u}",
                    loc->chained ? "true" : "false", loc->tombstone ? "true" : "false", loc->crc,
                    (unsigned long long)loc->mtime_ms, (unsigned long long)loc->size, (unsigned long long)loc->generation,
                    loc->extent_count, (unsigned long long)loc->rec_id, compress, (unsigned long long)loc->orig_size,
                    loc->orig_crc);
}

static size_t url_decode(char *s)
{
    char *r = s;
    char *w = s;
    while (*r) {
        if (*r == '%' && isxdigit((unsigned char)r[1]) && isxdigit((unsigned char)r[2])) {
            char hex[3] = {r[1], r[2], 0};
            *w++ = (char)strtol(hex, NULL, 16);
            r += 3;
        } else {
            *w++ = *r++;
        }
    }
    *w = 0;
    return (size_t)(w - s);
}

static const char *json_value(const char *json, const char *key)
{
    char pat[80];
    const char *p;
    if (!json || !key) {
        return NULL;
    }
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    p = strstr(json, pat);
    if (!p) {
        return NULL;
    }
    p += strlen(pat);
    while (*p && *p != ':') {
        p++;
    }
    if (*p == ':') {
        p++;
    }
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') {
        p++;
    }
    return p;
}

static int parse_locator(const char *json, s3dfs_locator *loc)
{
    const char *v;
    memset(loc, 0, sizeof(*loc));
    if (!json) {
        return 0;
    }
    if ((v = json_value(json, "chained"))) {
        loc->chained = strncmp(v, "true", 4) == 0;
    }
    if ((v = json_value(json, "tombstone"))) {
        loc->tombstone = strncmp(v, "true", 4) == 0;
    }
    if ((v = json_value(json, "crc"))) {
        loc->crc = (uint32_t)strtoul(v, NULL, 10);
    }
    if ((v = json_value(json, "mtimeMs"))) {
        loc->mtime_ms = (uint64_t)strtoull(v, NULL, 10);
    }
    if ((v = json_value(json, "size"))) {
        loc->size = (uint64_t)strtoull(v, NULL, 10);
    }
    if ((v = json_value(json, "generation"))) {
        loc->generation = (uint64_t)strtoull(v, NULL, 10);
    }
    if ((v = json_value(json, "extentCount"))) {
        loc->extent_count = (uint32_t)strtoul(v, NULL, 10);
    }
    if ((v = json_value(json, "recId"))) {
        loc->rec_id = (uint64_t)strtoull(v, NULL, 10);
    }
    if ((v = json_value(json, "compressType")) && *v == '"') {
        if (strncmp(v + 1, "zstd\"", 5) == 0) {
            loc->compress_type = 1;
        } else if (strncmp(v + 1, "gzip\"", 5) == 0) {
            loc->compress_type = 2;
        }
    }
    if ((v = json_value(json, "origSize"))) {
        loc->orig_size = (uint64_t)strtoull(v, NULL, 10);
    }
    if ((v = json_value(json, "origCrc"))) {
        loc->orig_crc = (uint32_t)strtoul(v, NULL, 10);
    }
    return loc->rec_id != 0 || loc->tombstone;
}

static int parse_meta(const char *json, s3dfs_put_meta *meta)
{
    const char *v;
    memset(meta, 0, sizeof(*meta));
    if (!json) {
        return 0;
    }
    meta->has_meta = 1;
    if ((v = json_value(json, "compressType")) && *v == '"') {
        if (strncmp(v + 1, "zstd\"", 5) == 0) {
            meta->compress_type = 1;
        } else if (strncmp(v + 1, "gzip\"", 5) == 0) {
            meta->compress_type = 2;
        }
    }
    if ((v = json_value(json, "origSize"))) {
        meta->orig_size = (uint64_t)strtoull(v, NULL, 10);
    }
    if ((v = json_value(json, "origCrc"))) {
        meta->orig_crc = (uint32_t)strtoul(v, NULL, 10);
    }
    return 1;
}

static char *header_get(const char *const *names, const char *const *values, int n, const char *name)
{
    int i;
    for (i = 0; i < n; i++) {
        if (strcasecmp(names[i], name) == 0) {
            return (char *)values[i];
        }
    }
    return NULL;
}

static char *query_get(const char *url, const char *name)
{
    const char *q = strchr(url, '?');
    size_t nlen = strlen(name);
    char *copy;
    char *save = NULL;
    char *tok;
    if (!q || !q[1]) {
        return NULL;
    }
    copy = strdup(q + 1);
    if (!copy) {
        return NULL;
    }
    for (tok = strtok_r(copy, "&", &save); tok; tok = strtok_r(NULL, "&", &save)) {
        if (strncmp(tok, name, nlen) == 0 && tok[nlen] == '=') {
            char *val = strdup(tok + nlen + 1);
            free(copy);
            if (val) {
                url_decode(val);
            }
            return val;
        }
    }
    free(copy);
    return NULL;
}

static char *request_key(const char *url, const char *const *names, const char *const *values, int n)
{
    char *raw = header_get(names, values, n, "x-s3dfs-key");
    char *owned = NULL;
    if (!raw) {
        raw = header_get(names, values, n, "x-dleveldb-key");
    }
    if (raw && raw[0]) {
        owned = strdup(raw);
        if (owned) {
            url_decode(owned);
        }
        return owned;
    }
    return query_get(url, "key");
}

static int ensure_bytes(conn_buf *c, size_t need)
{
    while (c->len < need) {
        ssize_t n;
        if (c->cap < need) {
            size_t cap = c->cap ? c->cap * 2 : 8192;
            uint8_t *grown;
            while (cap < need) {
                cap *= 2;
            }
            grown = (uint8_t *)realloc(c->buf, cap);
            if (!grown) {
                return -1;
            }
            c->buf = grown;
            c->cap = cap;
        }
        n = recv(c->fd, c->buf + c->len, c->cap - c->len, 0);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                return 1;
            }
            return -1;
        }
        if (n == 0) {
            return -1;
        }
        c->len += (size_t)n;
    }
    return 0;
}

static ssize_t header_end(conn_buf *c)
{
    size_t i;
    while (c->len < 4 || memmem(c->buf, c->len, "\r\n\r\n", 4) == NULL) {
        if (c->len > 65536) {
            return -2;
        }
        {
            int got = ensure_bytes(c, c->len + 1);
            if (got > 0) {
                return -3;
            }
            if (got != 0) {
                return -1;
            }
        }
    }
    for (i = 0; i + 3 < c->len; i++) {
        if (c->buf[i] == '\r' && c->buf[i + 1] == '\n' && c->buf[i + 2] == '\r' && c->buf[i + 3] == '\n') {
            return (ssize_t)i;
        }
    }
    return -1;
}

static void track_conn(s3dfs_http *http, int fd, int add)
{
    pthread_mutex_lock(&http->mu);
    if (add) {
        conn_slot *slot = (conn_slot *)calloc(1, sizeof(*slot));
        if (slot) {
            slot->fd = fd;
            slot->next = http->conns;
            http->conns = slot;
        }
    } else {
        conn_slot **prev = &http->conns;
        while (*prev) {
            if ((*prev)->fd == fd) {
                conn_slot *gone = *prev;
                *prev = gone->next;
                free(gone);
                break;
            }
            prev = &(*prev)->next;
        }
    }
    pthread_mutex_unlock(&http->mu);
}

static http_writer *find_writer(s3dfs_http *http, uint64_t id)
{
    http_writer *slot = http->writers;
    while (slot) {
        if (slot->id == id) {
            return slot;
        }
        slot = slot->next;
    }
    return NULL;
}

static void drop_writer(s3dfs_http *http, uint64_t id)
{
    http_writer **prev = &http->writers;
    while (*prev) {
        if ((*prev)->id == id) {
            http_writer *gone = *prev;
            *prev = gone->next;
            free(gone);
            return;
        }
        prev = &(*prev)->next;
    }
}

static int handle_put(s3dfs_http *http, int fd, const char *url, const char *const *names, const char *const *values, int nheaders,
                      const uint8_t *body, size_t body_len, int keep)
{
    char *key = request_key(url, names, values, nheaders);
    char *meta_raw;
    s3dfs_put_meta meta;
    s3dfs_locator loc;
    char json[512];
    int rc;
    int has_meta = 0;
    if (!key || !key[0]) {
        free(key);
        return write_error(fd, 400, "missing x-s3dfs-key", keep);
    }
    meta_raw = header_get(names, values, nheaders, "x-s3dfs-meta");
    if (meta_raw && meta_raw[0]) {
        char *decoded = strdup(meta_raw);
        if (decoded) {
            url_decode(decoded);
            has_meta = parse_meta(decoded, &meta);
            free(decoded);
        }
    }
    if (body_len > UINT32_MAX) {
        free(key);
        return write_error(fd, 400, "object too large", keep);
    }
    memset(&loc, 0, sizeof(loc));
    rc = s3dfs_put(http->store, key, (uint32_t)strlen(key), body, (uint32_t)body_len, has_meta ? &meta : NULL, &loc);
    free(key);
    if (rc != S3DFS_OK) {
        return write_error(fd, 500, err_text(rc), keep);
    }
    if (loc_json(&loc, json, sizeof(json)) < 0) {
        return write_error(fd, 500, "s3dfs error", keep);
    }
    return write_json(fd, 200, json, keep);
}

static int meta_headers(const s3dfs_locator *loc, uint64_t size, uint32_t crc, uint64_t mtime, int range, char *out, size_t cap)
{
    (void)loc;
    if (range) {
        return snprintf(out, cap, "x-s3dfs-size: %llu\r\nx-s3dfs-crc: %u\r\nx-s3dfs-mtime: %llu\r\nx-s3dfs-total-size: %llu\r\n",
                        (unsigned long long)size, crc, (unsigned long long)mtime, (unsigned long long)size);
    }
    return snprintf(out, cap, "x-s3dfs-size: %llu\r\nx-s3dfs-crc: %u\r\nx-s3dfs-mtime: %llu\r\n", (unsigned long long)size, crc,
                    (unsigned long long)mtime);
}

static int handle_get(s3dfs_http *http, int fd, const char *url, const char *const *names, const char *const *values, int nheaders,
                      int head_only, int keep)
{
    char *key = request_key(url, names, values, nheaders);
    char *loc_raw = header_get(names, values, nheaders, "x-s3dfs-locator");
    char *decoded = NULL;
    char *start_s;
    char *end_s;
    s3dfs_locator loc;
    char extra[256];
    int rc;
    if (!key || !key[0]) {
        free(key);
        return write_error(fd, 400, "missing key", keep);
    }
    if (!loc_raw || !loc_raw[0]) {
        char *from_query = query_get(url, "locator");
        if (from_query) {
            decoded = from_query;
        }
    } else {
        decoded = strdup(loc_raw);
        if (decoded) {
            url_decode(decoded);
        }
    }
    if (!decoded || !parse_locator(decoded, &loc)) {
        free(decoded);
        free(key);
        return write_error(fd, 400, "missing x-s3dfs-locator", keep);
    }
    free(decoded);
    start_s = query_get(url, "start");
    end_s = query_get(url, "end");
    if (!head_only && start_s && end_s) {
        uint64_t size = 0;
        uint32_t crc = 0;
        uint64_t mtime = 0;
        uint64_t start = (uint64_t)strtoull(start_s, NULL, 10);
        uint64_t end = (uint64_t)strtoull(end_s, NULL, 10);
        uint64_t span = end >= start ? end - start + 1 : 0;
        void *data = NULL;
        uint32_t out_len = 0;
        free(start_s);
        free(end_s);
        rc = s3dfs_head_at(http->store, key, (uint32_t)strlen(key), &loc, &size, &crc, &mtime);
        if (rc == S3DFS_ERR_NOT_FOUND) {
            free(key);
            return write_response(fd, 404, "application/octet-stream", NULL, NULL, 0, keep);
        }
        if (rc != S3DFS_OK) {
            free(key);
            return write_error(fd, 500, err_text(rc), keep);
        }
        rc = s3dfs_read_span(http->store, key, (uint32_t)strlen(key), &loc, start, span, &data, &out_len);
        free(key);
        if (rc != S3DFS_OK) {
            return write_error(fd, 500, err_text(rc), keep);
        }
        meta_headers(&loc, size, crc, mtime, 1, extra, sizeof(extra));
        rc = write_response(fd, 200, "application/octet-stream", extra, data, out_len, keep);
        s3dfs_free(data);
        return rc;
    }
    free(start_s);
    free(end_s);
    if (head_only) {
        uint64_t size = 0;
        uint32_t crc = 0;
        uint64_t mtime = 0;
        char json[128];
        rc = s3dfs_head_at(http->store, key, (uint32_t)strlen(key), &loc, &size, &crc, &mtime);
        free(key);
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return write_response(fd, 404, "application/json; charset=utf-8", NULL, NULL, 0, keep);
        }
        if (rc != S3DFS_OK) {
            return write_error(fd, 500, err_text(rc), keep);
        }
        snprintf(json, sizeof(json), "{\"size\":%llu,\"crc\":%u,\"mtimeMs\":%llu}", (unsigned long long)size, crc,
                 (unsigned long long)mtime);
        meta_headers(&loc, size, crc, mtime, 0, extra, sizeof(extra));
        return write_response(fd, 200, "application/json; charset=utf-8", extra, json, strlen(json), keep);
    }
    {
        void *data = NULL;
        uint32_t out_len = 0;
        uint32_t crc = 0;
        uint64_t mtime = 0;
        rc = s3dfs_get_at(http->store, key, (uint32_t)strlen(key), &loc, &data, &out_len, &crc, &mtime);
        free(key);
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return write_response(fd, 404, "application/octet-stream", NULL, NULL, 0, keep);
        }
        if (rc != S3DFS_OK) {
            return write_error(fd, 500, err_text(rc), keep);
        }
        meta_headers(&loc, out_len, crc, mtime, 0, extra, sizeof(extra));
        rc = write_response(fd, 200, "application/octet-stream", extra, data, out_len, keep);
        s3dfs_free(data);
        return rc;
    }
}

static int handle_delete(s3dfs_http *http, int fd, const char *url, const char *const *names, const char *const *values, int nheaders,
                         const uint8_t *body, size_t body_len, int keep)
{
    char *key = request_key(url, names, values, nheaders);
    int rc;
    if ((!key || !key[0]) && body && body_len) {
        char *text = (char *)malloc(body_len + 1);
        const char *v;
        free(key);
        key = NULL;
        if (!text) {
            return write_error(fd, 500, "out of memory", keep);
        }
        memcpy(text, body, body_len);
        text[body_len] = 0;
        v = json_value(text, "key");
        if (v && *v == '"') {
            const char *end = strchr(v + 1, '"');
            if (end) {
                key = (char *)malloc((size_t)(end - (v + 1)) + 1);
                if (key) {
                    memcpy(key, v + 1, (size_t)(end - (v + 1)));
                    key[end - (v + 1)] = 0;
                }
            }
        }
        free(text);
    }
    if (!key || !key[0]) {
        free(key);
        return write_error(fd, 400, "missing key", keep);
    }
    rc = s3dfs_tombstone(http->store, key, (uint32_t)strlen(key));
    free(key);
    if (rc != S3DFS_OK) {
        return write_error(fd, 500, err_text(rc), keep);
    }
    return write_json(fd, 200, "{\"ok\":true}", keep);
}

static int handle_write_begin(s3dfs_http *http, int fd, const char *url, const char *const *names, const char *const *values,
                              int nheaders, int keep)
{
    char *key = request_key(url, names, values, nheaders);
    s3dfs_writer *writer;
    http_writer *slot;
    char json[64];
    if (!key || !key[0]) {
        free(key);
        return write_error(fd, 400, "missing x-s3dfs-key", keep);
    }
    writer = s3dfs_write_begin(http->store, key, (uint32_t)strlen(key), NULL);
    free(key);
    if (!writer) {
        return write_error(fd, 500, "out of memory", keep);
    }
    slot = (http_writer *)calloc(1, sizeof(*slot));
    if (!slot) {
        s3dfs_write_abort(writer);
        return write_error(fd, 500, "out of memory", keep);
    }
    pthread_mutex_lock(&http->mu);
    slot->id = http->next_writer++;
    slot->writer = writer;
    slot->next = http->writers;
    http->writers = slot;
    snprintf(json, sizeof(json), "{\"id\":\"%llu\"}", (unsigned long long)slot->id);
    pthread_mutex_unlock(&http->mu);
    return write_json(fd, 200, json, keep);
}

static int handle_write_chunk(s3dfs_http *http, int fd, const char *const *names, const char *const *values, int nheaders,
                              const uint8_t *body, size_t body_len, int keep)
{
    char *id_s = header_get(names, values, nheaders, "x-s3dfs-write");
    uint64_t id;
    http_writer *slot;
    s3dfs_writer *writer = NULL;
    int rc;
    if (!id_s || !id_s[0]) {
        return write_error(fd, 404, "unknown writer", keep);
    }
    id = (uint64_t)strtoull(id_s, NULL, 10);
    pthread_mutex_lock(&http->mu);
    slot = find_writer(http, id);
    if (slot) {
        writer = slot->writer;
    }
    pthread_mutex_unlock(&http->mu);
    if (!writer) {
        return write_error(fd, 404, "unknown writer", keep);
    }
    if (body_len > UINT32_MAX) {
        return write_error(fd, 400, "object too large", keep);
    }
    rc = s3dfs_write(writer, body, (uint32_t)body_len);
    if (rc != S3DFS_OK) {
        return write_error(fd, 500, err_text(rc), keep);
    }
    return write_json(fd, 200, "{\"ok\":true}", keep);
}

static int handle_write_finish(s3dfs_http *http, int fd, const char *const *names, const char *const *values, int nheaders, int keep)
{
    char *id_s = header_get(names, values, nheaders, "x-s3dfs-write");
    char *meta_raw;
    uint64_t id;
    http_writer *slot;
    s3dfs_writer *writer = NULL;
    s3dfs_locator loc;
    char json[512];
    int rc;
    if (!id_s || !id_s[0]) {
        return write_error(fd, 404, "unknown writer", keep);
    }
    id = (uint64_t)strtoull(id_s, NULL, 10);
    pthread_mutex_lock(&http->mu);
    slot = find_writer(http, id);
    if (slot) {
        writer = slot->writer;
        drop_writer(http, id);
    }
    pthread_mutex_unlock(&http->mu);
    if (!writer) {
        return write_error(fd, 404, "unknown writer", keep);
    }
    meta_raw = header_get(names, values, nheaders, "x-s3dfs-meta");
    if (meta_raw && meta_raw[0]) {
        char *decoded = strdup(meta_raw);
        s3dfs_put_meta meta;
        if (decoded) {
            url_decode(decoded);
            if (parse_meta(decoded, &meta)) {
                s3dfs_write_set_meta(writer, &meta);
            }
            free(decoded);
        }
    }
    memset(&loc, 0, sizeof(loc));
    rc = s3dfs_write_finish(writer, &loc);
    if (rc != S3DFS_OK) {
        return write_error(fd, 500, err_text(rc), keep);
    }
    loc_json(&loc, json, sizeof(json));
    return write_json(fd, 200, json, keep);
}

static int handle_write_abort(s3dfs_http *http, int fd, const char *const *names, const char *const *values, int nheaders, int keep)
{
    char *id_s = header_get(names, values, nheaders, "x-s3dfs-write");
    if (id_s && id_s[0]) {
        uint64_t id = (uint64_t)strtoull(id_s, NULL, 10);
        s3dfs_writer *writer = NULL;
        pthread_mutex_lock(&http->mu);
        {
            http_writer *slot = find_writer(http, id);
            if (slot) {
                writer = slot->writer;
                drop_writer(http, id);
            }
        }
        pthread_mutex_unlock(&http->mu);
        if (writer) {
            s3dfs_write_abort(writer);
        }
    }
    return write_json(fd, 200, "{\"ok\":true}", keep);
}

static void free_reply(s3dfs_http_reply *reply)
{
    free(reply->content_type);
    free(reply->extra_headers);
    free(reply->body);
    reply->content_type = NULL;
    reply->extra_headers = NULL;
    reply->body = NULL;
}

static int dispatch(s3dfs_http *http, int fd, const char *method, const char *url, const char *const *names,
                    const char *const *values, int nheaders, const uint8_t *body, size_t body_len, int keep)
{
    char path[1024];
    const char *q;
    q = strchr(url, '?');
    size_t plen = q ? (size_t)(q - url) : strlen(url);
    if (plen >= sizeof(path)) {
        plen = sizeof(path) - 1;
    }
    memcpy(path, url, plen);
    path[plen] = 0;
    if (strcmp(method, "POST") == 0 && strcmp(path, "/_s3dfs/block/put") == 0) {
        uint64_t t0 = mono_us();
        int rc = handle_put(http, fd, url, names, values, nheaders, body, body_len, keep);
        note_route(http, 1, mono_us() - t0);
        return rc;
    }
    if (strcmp(method, "GET") == 0 && strcmp(path, "/_s3dfs/block/get") == 0) {
        uint64_t t0 = mono_us();
        int rc = handle_get(http, fd, url, names, values, nheaders, 0, keep);
        note_route(http, 2, mono_us() - t0);
        return rc;
    }
    if (strcmp(method, "GET") == 0 && strcmp(path, "/_s3dfs/block/head") == 0) {
        uint64_t t0 = mono_us();
        int rc = handle_get(http, fd, url, names, values, nheaders, 1, keep);
        note_route(http, 2, mono_us() - t0);
        return rc;
    }
    if (strcmp(method, "POST") == 0 && strcmp(path, "/_s3dfs/block/delete") == 0) {
        note_route(http, 0, 0);
        return handle_delete(http, fd, url, names, values, nheaders, body, body_len, keep);
    }
    if (strcmp(method, "POST") == 0 && strcmp(path, "/_s3dfs/block/write/begin") == 0) {
        note_route(http, 0, 0);
        return handle_write_begin(http, fd, url, names, values, nheaders, keep);
    }
    if (strcmp(method, "POST") == 0 && strcmp(path, "/_s3dfs/block/write/chunk") == 0) {
        note_route(http, 0, 0);
        return handle_write_chunk(http, fd, names, values, nheaders, body, body_len, keep);
    }
    if (strcmp(method, "POST") == 0 && strcmp(path, "/_s3dfs/block/write/finish") == 0) {
        note_route(http, 0, 0);
        return handle_write_finish(http, fd, names, values, nheaders, keep);
    }
    if (strcmp(method, "POST") == 0 && strcmp(path, "/_s3dfs/block/write/abort") == 0) {
        note_route(http, 0, 0);
        return handle_write_abort(http, fd, names, values, nheaders, keep);
    }
    note_route(http, 0, 0);
    if (http->fallback) {
        s3dfs_http_reply reply;
        int rc;
        memset(&reply, 0, sizeof(reply));
        rc = http->fallback(http->fallback_user, method, url, names, values, nheaders, body, body_len, &reply);
        if (rc != 0) {
            free_reply(&reply);
            return write_error(fd, 500, "s3dfs error", keep);
        }
        rc = write_response(fd, reply.status ? reply.status : 200, reply.content_type, reply.extra_headers, reply.body, reply.body_len,
                            keep);
        free_reply(&reply);
        return rc;
    }
    return write_response(fd, 404, "application/octet-stream", NULL, NULL, 0, keep);
}

static int serve_one(s3dfs_http *http, conn_buf *c)
{
    ssize_t hend;
    char *header_copy;
    char *line;
    char *save = NULL;
    char *method = NULL;
    char *url = NULL;
    char *version = NULL;
    const char *names[64];
    const char *values[64];
    int nheaders = 0;
    long content_length = 0;
    int keep = 1;
    int saw_connection = 0;
    size_t body_off;
    const uint8_t *body;
    int rc;
    hend = header_end(c);
    if (hend == -3) {
        return 1;
    }
    if (hend < 0) {
        return -1;
    }
    header_copy = (char *)malloc((size_t)hend + 1);
    if (!header_copy) {
        return -1;
    }
    memcpy(header_copy, c->buf, (size_t)hend);
    header_copy[hend] = 0;
    line = strtok_r(header_copy, "\n", &save);
    if (!line) {
        free(header_copy);
        return -1;
    }
    if (line[strlen(line) - 1] == '\r') {
        line[strlen(line) - 1] = 0;
    }
    method = strtok_r(line, " ", &version);
    if (!method) {
        free(header_copy);
        return -1;
    }
    url = strtok_r(NULL, " ", &version);
    if (!url || !version) {
        free(header_copy);
        return -1;
    }
    if (strncmp(version, "HTTP/1.1", 8) != 0) {
        keep = 0;
    }
    while ((line = strtok_r(NULL, "\n", &save)) != NULL && nheaders < 64) {
        char *colon;
        char *value;
        if (line[0] && line[strlen(line) - 1] == '\r') {
            line[strlen(line) - 1] = 0;
        }
        colon = strchr(line, ':');
        if (!colon) {
            continue;
        }
        *colon = 0;
        value = colon + 1;
        while (*value == ' ' || *value == '\t') {
            value++;
        }
        {
            char *p = line;
            for (; *p; p++) {
                *p = (char)tolower((unsigned char)*p);
            }
        }
        names[nheaders] = line;
        values[nheaders] = value;
        if (strcmp(line, "content-length") == 0) {
            content_length = strtol(value, NULL, 10);
        } else if (strcmp(line, "connection") == 0) {
            saw_connection = 1;
            if (strcasecmp(value, "close") == 0) {
                keep = 0;
            } else if (strcasecmp(value, "keep-alive") == 0) {
                keep = 1;
            }
        } else if (strcmp(line, "transfer-encoding") == 0) {
            free(header_copy);
            write_error(c->fd, 400, "chunked body is not supported", 0);
            return -1;
        }
        nheaders++;
    }
    (void)saw_connection;
    if (content_length < 0) {
        free(header_copy);
        return write_error(c->fd, 400, "invalid content-length", 0);
    }
    body_off = (size_t)hend + 4;
    {
        int filled = ensure_bytes(c, body_off + (size_t)content_length);
        if (filled != 0) {
            free(header_copy);
            return filled > 0 ? 1 : -1;
        }
    }
    body = c->buf + body_off;
    rc = dispatch(http, c->fd, method, url, names, values, nheaders, body, (size_t)content_length, keep);
    if (c->len > body_off + (size_t)content_length) {
        size_t used = body_off + (size_t)content_length;
        memmove(c->buf, c->buf + used, c->len - used);
        c->len -= used;
    } else {
        c->len = 0;
    }
    free(header_copy);
    if (rc != 0 || !keep || http->stop) {
        return -1;
    }
    return 0;
}

static uint64_t mono_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ull + (uint64_t)ts.tv_nsec / 1000ull;
}

static void note_route(s3dfs_http *http, int kind, uint64_t us)
{
    pthread_mutex_lock(&http->mu);
    if (kind == 1) {
        http->http_puts++;
        http->put_us += us;
        if (us > http->put_max_us) {
            http->put_max_us = us;
        }
    } else if (kind == 2) {
        http->http_gets++;
        http->get_us += us;
        if (us > http->get_max_us) {
            http->get_max_us = us;
        }
    } else {
        http->http_others++;
    }
    pthread_mutex_unlock(&http->mu);
}

static int set_nonblock(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) {
        return -1;
    }
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void wake_poller(s3dfs_http *http)
{
    char byte = 1;
    ssize_t n;
    if (!http || http->wake_w < 0) {
        return;
    }
    do {
        n = write(http->wake_w, &byte, 1);
    } while (n < 0 && errno == EINTR);
}

static void ready_push(s3dfs_http *http, live_conn *conn)
{
    conn->next = NULL;
    conn->queued_us = mono_us();
    if (http->ready_tail) {
        http->ready_tail->next = conn;
    } else {
        http->ready = conn;
    }
    http->ready_tail = conn;
    http->ready_n++;
    if (http->ready_n > http->ready_max) {
        http->ready_max = http->ready_n;
    }
    pthread_cond_signal(&http->work_cv);
}

static live_conn *ready_pop(s3dfs_http *http)
{
    live_conn *conn = http->ready;
    if (!conn) {
        return NULL;
    }
    http->ready = conn->next;
    if (!http->ready) {
        http->ready_tail = NULL;
    }
    if (http->ready_n > 0) {
        http->ready_n--;
    }
    conn->next = NULL;
    return conn;
}

static void idle_push(s3dfs_http *http, live_conn *conn)
{
    conn->next = http->idle;
    http->idle = conn;
    http->idle_n++;
    if (http->idle_n > http->idle_max) {
        http->idle_max = http->idle_n;
    }
    wake_poller(http);
}

static int idle_take(s3dfs_http *http, live_conn *conn)
{
    live_conn **prev = &http->idle;
    while (*prev) {
        if (*prev == conn) {
            *prev = conn->next;
            conn->next = NULL;
            if (http->idle_n > 0) {
                http->idle_n--;
            }
            return 1;
        }
        prev = &(*prev)->next;
    }
    return 0;
}

static void free_conn(s3dfs_http *http, live_conn *conn)
{
    if (!conn) {
        return;
    }
    track_conn(http, conn->fd, 0);
    close(conn->fd);
    free(conn->buf);
    free(conn);
}

static void enqueue_accepted(s3dfs_http *http, int fd)
{
    live_conn *conn;
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
#ifdef SO_NOSIGPIPE
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
    if (set_nonblock(fd) != 0) {
        close(fd);
        return;
    }
    conn = (live_conn *)calloc(1, sizeof(*conn));
    if (!conn) {
        close(fd);
        return;
    }
    conn->fd = fd;
    track_conn(http, fd, 1);
    pthread_mutex_lock(&http->mu);
    http->accepted++;
    ready_push(http, conn);
    pthread_mutex_unlock(&http->mu);
}

static void accept_ready(s3dfs_http *http)
{
    while (!http->stop && http->listen_fd >= 0) {
        struct sockaddr_storage addr;
        socklen_t len = sizeof(addr);
        int fd = accept(http->listen_fd, (struct sockaddr *)&addr, &len);
        if (fd < 0) {
            if (errno == EINTR) {
                continue;
            }
            return;
        }
        enqueue_accepted(http, fd);
    }
}

static void drain_wake(s3dfs_http *http)
{
    char junk[64];
    while (read(http->wake_r, junk, sizeof(junk)) > 0) {
    }
}

static void *http_poller(void *arg)
{
    s3dfs_http *http = (s3dfs_http *)arg;
    struct pollfd *fds = NULL;
    live_conn **map = NULL;
    size_t cap = 0;
#if defined(__APPLE__)
    pthread_setname_np("s3dfs-poll");
#else
    pthread_setname_np(pthread_self(), "s3dfs-poll");
#endif
    while (!http->stop) {
        size_t nidle = 0;
        size_t i;
        int ready;
        live_conn *conn;
        pthread_mutex_lock(&http->mu);
        for (conn = http->idle; conn; conn = conn->next) {
            nidle++;
        }
        pthread_mutex_unlock(&http->mu);
        if (cap < nidle + 2) {
            size_t next = cap ? cap * 2 : 16;
            struct pollfd *grown_fds;
            live_conn **grown_map;
            while (next < nidle + 2) {
                next *= 2;
            }
            grown_fds = (struct pollfd *)realloc(fds, next * sizeof(*grown_fds));
            if (!grown_fds) {
                break;
            }
            fds = grown_fds;
            grown_map = (live_conn **)realloc(map, next * sizeof(*grown_map));
            if (!grown_map) {
                break;
            }
            map = grown_map;
            cap = next;
        }
        pthread_mutex_lock(&http->mu);
        if (http->stop) {
            pthread_mutex_unlock(&http->mu);
            break;
        }
        fds[0].fd = http->listen_fd;
        fds[0].events = POLLIN;
        fds[0].revents = 0;
        fds[1].fd = http->wake_r;
        fds[1].events = POLLIN;
        fds[1].revents = 0;
        i = 2;
        for (conn = http->idle; conn && i < cap; conn = conn->next) {
            fds[i].fd = conn->fd;
            fds[i].events = POLLIN;
            fds[i].revents = 0;
            map[i] = conn;
            i++;
        }
        pthread_mutex_unlock(&http->mu);
        ready = poll(fds, (nfds_t)i, 1000);
        if (http->stop) {
            break;
        }
        if (ready < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        if (fds[1].revents) {
            drain_wake(http);
        }
        if (fds[0].revents & (POLLIN | POLLERR | POLLHUP)) {
            accept_ready(http);
        }
        pthread_mutex_lock(&http->mu);
        for (size_t k = 2; k < i; k++) {
            if (!(fds[k].revents & (POLLIN | POLLERR | POLLHUP | POLLNVAL))) {
                continue;
            }
            if (idle_take(http, map[k])) {
                ready_push(http, map[k]);
            }
        }
        pthread_mutex_unlock(&http->mu);
    }
    free(fds);
    free(map);
    return NULL;
}

static void *http_worker(void *arg)
{
    s3dfs_http *http = (s3dfs_http *)arg;
#if defined(__APPLE__)
    pthread_setname_np("s3dfs-http");
#else
    pthread_setname_np(pthread_self(), "s3dfs-http");
#endif
    for (;;) {
        live_conn *conn;
        int rc;
        pthread_mutex_lock(&http->mu);
        while (!http->ready && !http->stop) {
            pthread_cond_wait(&http->work_cv, &http->mu);
        }
        if (http->stop) {
            pthread_mutex_unlock(&http->mu);
            return NULL;
        }
        conn = ready_pop(http);
        if (conn) {
            uint64_t wait = mono_us() - conn->queued_us;
            http->queue_wait_us += wait;
            if (wait > http->queue_wait_max_us) {
                http->queue_wait_max_us = wait;
            }
        }
        pthread_mutex_unlock(&http->mu);
        if (!conn) {
            continue;
        }
        rc = serve_one(http, (conn_buf *)conn);
        if (http->stop || rc < 0) {
            free_conn(http, conn);
            if (http->stop) {
                return NULL;
            }
            continue;
        }
        pthread_mutex_lock(&http->mu);
        if (http->stop) {
            pthread_mutex_unlock(&http->mu);
            free_conn(http, conn);
            return NULL;
        }
        if (rc == 0 && conn->len > 0) {
            ready_push(http, conn);
        } else {
            idle_push(http, conn);
        }
        pthread_mutex_unlock(&http->mu);
    }
    return NULL;
}

int s3dfs_http_listen(s3dfs_store *store, const char *host, int port, int threads, s3dfs_http_fallback fallback, void *fallback_user,
                      s3dfs_http **out, int *bound_port)
{
    struct addrinfo hints;
    struct addrinfo *res = NULL;
    struct addrinfo *it;
    char port_text[16];
    int fd = -1;
    int i;
    s3dfs_http *http;
    if (!store || !out) {
        return -1;
    }
    if (threads < 1) {
        threads = 1;
    }
    if (threads > 32) {
        threads = 32;
    }
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE;
    snprintf(port_text, sizeof(port_text), "%d", port);
    if (getaddrinfo(host && host[0] ? host : NULL, port_text, &hints, &res) != 0) {
        return -1;
    }
    for (it = res; it; it = it->ai_next) {
        int one = 1;
        fd = socket(it->ai_family, it->ai_socktype, it->ai_protocol);
        if (fd < 0) {
            continue;
        }
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        if (bind(fd, it->ai_addr, it->ai_addrlen) == 0 && listen(fd, 128) == 0) {
            break;
        }
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) {
        return -1;
    }
    if (set_nonblock(fd) != 0) {
        close(fd);
        return -1;
    }
    http = (s3dfs_http *)calloc(1, sizeof(*http));
    if (!http) {
        close(fd);
        return -1;
    }
    http->store = store;
    http->listen_fd = fd;
    http->wake_r = -1;
    http->wake_w = -1;
    http->nthreads = threads;
    http->fallback = fallback;
    http->fallback_user = fallback_user;
    http->next_writer = 1;
    pthread_mutex_init(&http->mu, NULL);
    pthread_cond_init(&http->work_cv, NULL);
    http->threads = (pthread_t *)calloc((size_t)threads, sizeof(pthread_t));
    {
        int wake[2];
        if (!http->threads || pipe(wake) != 0) {
            close(fd);
            pthread_cond_destroy(&http->work_cv);
            pthread_mutex_destroy(&http->mu);
            free(http->threads);
            free(http);
            return -1;
        }
        http->wake_r = wake[0];
        http->wake_w = wake[1];
    }
    set_nonblock(http->wake_r);
    set_nonblock(http->wake_w);
    if (pthread_create(&http->poller, NULL, http_poller, http) != 0) {
        close(fd);
        close(http->wake_r);
        close(http->wake_w);
        pthread_cond_destroy(&http->work_cv);
        pthread_mutex_destroy(&http->mu);
        free(http->threads);
        free(http);
        return -1;
    }
    for (i = 0; i < threads; i++) {
        if (pthread_create(&http->threads[i], NULL, http_worker, http) != 0) {
            http->stop = 1;
            shutdown(fd, SHUT_RDWR);
            close(fd);
            http->listen_fd = -1;
            wake_poller(http);
            pthread_cond_broadcast(&http->work_cv);
            pthread_join(http->poller, NULL);
            while (--i >= 0) {
                pthread_join(http->threads[i], NULL);
            }
            close(http->wake_r);
            close(http->wake_w);
            pthread_cond_destroy(&http->work_cv);
            pthread_mutex_destroy(&http->mu);
            free(http->threads);
            free(http);
            return -1;
        }
    }
    if (bound_port) {
        struct sockaddr_storage addr;
        socklen_t len = sizeof(addr);
        *bound_port = port;
        if (getsockname(fd, (struct sockaddr *)&addr, &len) == 0) {
            if (addr.ss_family == AF_INET) {
                *bound_port = ntohs(((struct sockaddr_in *)&addr)->sin_port);
            } else if (addr.ss_family == AF_INET6) {
                *bound_port = ntohs(((struct sockaddr_in6 *)&addr)->sin6_port);
            }
        }
    }
    *out = http;
    return 0;
}

void s3dfs_http_get_stats(s3dfs_http *http, s3dfs_http_stats *out)
{
    if (!out) {
        return;
    }
    memset(out, 0, sizeof(*out));
    if (!http) {
        return;
    }
    pthread_mutex_lock(&http->mu);
    out->accepted = http->accepted;
    out->puts = http->http_puts;
    out->gets = http->http_gets;
    out->others = http->http_others;
    out->put_us = http->put_us;
    out->get_us = http->get_us;
    out->put_max_us = http->put_max_us;
    out->get_max_us = http->get_max_us;
    out->queue_wait_us = http->queue_wait_us;
    out->queue_wait_max_us = http->queue_wait_max_us;
    out->ready_max = http->ready_max;
    out->idle_max = http->idle_max;
    out->ready_now = http->ready_n;
    out->idle_now = http->idle_n;
    pthread_mutex_unlock(&http->mu);
}

void s3dfs_http_shutdown(s3dfs_http *http)
{
    conn_slot *slot;
    if (!http || http->stop) {
        return;
    }
    http->stop = 1;
    if (http->listen_fd >= 0) {
        shutdown(http->listen_fd, SHUT_RDWR);
        close(http->listen_fd);
        http->listen_fd = -1;
    }
    pthread_mutex_lock(&http->mu);
    for (slot = http->conns; slot; slot = slot->next) {
        shutdown(slot->fd, SHUT_RDWR);
    }
    pthread_cond_broadcast(&http->work_cv);
    pthread_mutex_unlock(&http->mu);
    wake_poller(http);
}

void s3dfs_http_join(s3dfs_http *http)
{
    int i;
    http_writer *slot;
    if (!http) {
        return;
    }
    if (!http->stop) {
        s3dfs_http_shutdown(http);
    }
    pthread_join(http->poller, NULL);
    pthread_mutex_lock(&http->mu);
    pthread_cond_broadcast(&http->work_cv);
    pthread_mutex_unlock(&http->mu);
    for (i = 0; i < http->nthreads; i++) {
        pthread_join(http->threads[i], NULL);
    }
    while (http->idle) {
        live_conn *conn = http->idle;
        http->idle = conn->next;
        free_conn(http, conn);
    }
    while (http->ready) {
        live_conn *conn = http->ready;
        http->ready = conn->next;
        free_conn(http, conn);
    }
    free(http->threads);
    if (http->wake_r >= 0) {
        close(http->wake_r);
    }
    if (http->wake_w >= 0) {
        close(http->wake_w);
    }
    pthread_cond_destroy(&http->work_cv);
    slot = http->writers;
    while (slot) {
        http_writer *next = slot->next;
        s3dfs_write_abort(slot->writer);
        free(slot);
        slot = next;
    }
    pthread_mutex_destroy(&http->mu);
    free(http);
}
