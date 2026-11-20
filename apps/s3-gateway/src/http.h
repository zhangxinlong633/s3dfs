#ifndef S3DFS_GATEWAY_HTTP_H
#define S3DFS_GATEWAY_HTTP_H

#include "common.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int status;
    char *body;
    size_t body_len;
    int64_t x_size;
    int64_t x_crc;
    int64_t x_mtime;
    int has_x_size;
    int has_x_crc;
    int has_x_mtime;
    char content_type[96];
} http_response_t;

void http_response_free(http_response_t *r);

/* Keep-alive HTTP/1.1 client with thread-local connection reuse. */
int http_request(const char *host, int port,
                 const char *method, const char *path,
                 const char *extra_headers,
                 const void *body, size_t body_len,
                 int allow_404,
                 http_response_t *out);

typedef struct {
    char method[16];
    char path[4096];
    char query[4096];
    char raw_target[8192];
    char *hdr_block;
    size_t hdr_len;
    char *body;
    size_t body_len;
    int keepalive;
    char range[256];
    char expect[64];
    int64_t content_length;
} http_in_t;

typedef struct {
    int fd;
    int header_sent;
    int status;
    int keepalive;
    int is_head; /* if set, headers include Content-Length but the body is not sent */
} http_out_t;

void http_in_free(http_in_t *in);
int http_in_header(const http_in_t *in, const char *name, char *out, size_t cap);

int http_reply(http_out_t *out, int status, const char *extra_headers,
               const void *body, size_t body_len);
int http_reply_str(http_out_t *out, int status, const char *content_type, const char *body);

int http_listen(const char *host, int port, int backlog);
int http_accept(int listen_fd);

/* Read one HTTP/1.1 request from fd. Returns 1 on success, 0 on EOF, -1 on error. */
int http_read_request(int fd, http_in_t *in, int *got_expect);

#ifdef __cplusplus
}
#endif

#endif
