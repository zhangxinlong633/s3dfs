#include "http.h"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

#include "picohttpparser.h"

#define CLIENT_TIMEOUT_MS 10000
#define SERVER_READ_TIMEOUT_MS 60000
#define MAX_HEADERS 64
#define POOL_SIZE 32

typedef struct {
    int fd;
    char host[256];
    int port;
    int in_use;
} pool_conn_t;

static __thread pool_conn_t g_pool[POOL_SIZE];

void http_response_free(http_response_t *r)
{
    if (!r) {
        return;
    }
    free(r->body);
    r->body = NULL;
    r->body_len = 0;
}

void http_in_free(http_in_t *in)
{
    if (!in) {
        return;
    }
    free(in->hdr_block);
    in->hdr_block = NULL;
    free(in->body);
    in->body = NULL;
    in->body_len = 0;
    in->hdr_len = 0;
}

static void close_conn(pool_conn_t *c)
{
    if (c->fd >= 0) {
        close(c->fd);
    }
    c->fd = -1;
    c->in_use = 0;
    c->host[0] = '\0';
    c->port = 0;
}

static int connect_host(const char *host, int port)
{
    char portstr[16];
    snprintf(portstr, sizeof(portstr), "%d", port);
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    struct addrinfo *res = NULL;
    int g = getaddrinfo(host, portstr, &hints, &res);
    if (g != 0 || !res) {
        return -1;
    }
    int fd = -1;
    for (struct addrinfo *p = res; p; p = p->ai_next) {
        fd = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
        if (fd < 0) {
            continue;
        }
        set_sock_opts(fd, CLIENT_TIMEOUT_MS);
        if (connect(fd, p->ai_addr, p->ai_addrlen) == 0) {
            break;
        }
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    return fd;
}

static pool_conn_t *pool_acquire(const char *host, int port)
{
    pool_conn_t *empty = NULL;
    for (int i = 0; i < POOL_SIZE; i++) {
        pool_conn_t *c = &g_pool[i];
        if (c->fd > 0 && !c->in_use && c->port == port && strcmp(c->host, host) == 0) {
            c->in_use = 1;
            return c;
        }
        if (!empty && c->fd <= 0 && !c->in_use) {
            empty = c;
        }
    }
    if (!empty) {
        for (int i = 0; i < POOL_SIZE; i++) {
            if (!g_pool[i].in_use) {
                close_conn(&g_pool[i]);
                empty = &g_pool[i];
                break;
            }
        }
    }
    if (!empty) {
        return NULL;
    }
    int fd = connect_host(host, port);
    if (fd < 0) {
        return NULL;
    }
    snprintf(empty->host, sizeof(empty->host), "%s", host);
    empty->port = port;
    empty->fd = fd;
    empty->in_use = 1;
    return empty;
}

static void pool_release(pool_conn_t *c, int reuse)
{
    if (!c) {
        return;
    }
    if (!reuse) {
        close_conn(c);
        return;
    }
    c->in_use = 0;
}

static int write_all(int fd, const void *data, size_t n)
{
    const char *p = data;
    size_t left = n;
    while (left) {
        ssize_t w = write(fd, p, left);
        if (w < 0) {
            if (errno == EINTR) {
                continue;
            }
            return S3DFS_ERR_IO;
        }
        if (w == 0) {
            return S3DFS_ERR_IO;
        }
        p += w;
        left -= (size_t)w;
    }
    return S3DFS_OK;
}

static int writev_all(int fd, struct iovec *iov, int iovcnt)
{
    while (iovcnt > 0) {
        ssize_t w = writev(fd, iov, iovcnt);
        if (w < 0) {
            if (errno == EINTR) {
                continue;
            }
            return S3DFS_ERR_IO;
        }
        size_t left = (size_t)w;
        while (iovcnt > 0 && left >= iov[0].iov_len) {
            left -= iov[0].iov_len;
            iov++;
            iovcnt--;
        }
        if (left && iovcnt > 0) {
            iov[0].iov_base = (char *)iov[0].iov_base + left;
            iov[0].iov_len -= left;
        }
    }
    return S3DFS_OK;
}

static int header_lookup(struct phr_header *hdrs, size_t n, const char *name, const char **val, size_t *vlen)
{
    for (size_t i = 0; i < n; i++) {
        if (header_ieq(hdrs[i].name, hdrs[i].name_len, name)) {
            *val = hdrs[i].value;
            *vlen = hdrs[i].value_len;
            return 1;
        }
    }
    return 0;
}

static int64_t header_i64(struct phr_header *hdrs, size_t n, const char *name, int *present)
{
    const char *v;
    size_t vl;
    if (!header_lookup(hdrs, n, name, &v, &vl)) {
        if (present) {
            *present = 0;
        }
        return 0;
    }
    if (present) {
        *present = 1;
    }
    char tmp[64];
    if (vl >= sizeof(tmp)) {
        vl = sizeof(tmp) - 1;
    }
    memcpy(tmp, v, vl);
    tmp[vl] = '\0';
    return (int64_t)strtoll(tmp, NULL, 10);
}

static int read_more(int fd, buf_t *b)
{
    if (buf_reserve(b, 8192) != S3DFS_OK) {
        return S3DFS_ERR_NOMEM;
    }
    ssize_t r = read(fd, b->data + b->len, b->cap - b->len - 1);
    if (r < 0) {
        if (errno == EINTR) {
            return 0;
        }
        return S3DFS_ERR_IO;
    }
    if (r == 0) {
        return S3DFS_ERR_IO;
    }
    b->len += (size_t)r;
    b->data[b->len] = '\0';
    return (int)r;
}

static int parse_and_read_response(int fd, http_response_t *out)
{
    memset(out, 0, sizeof(*out));
    buf_t b = {0};
    int minor = 0;
    int status = 0;
    const char *msg = NULL;
    size_t msg_len = 0;
    struct phr_header hdrs[MAX_HEADERS];
    size_t prev = 0;
    size_t header_len = 0;
    size_t num_headers = 0;
    for (;;) {
        size_t num = MAX_HEADERS;
        int n = phr_parse_response(b.data ? b.data : "", b.len, &minor, &status, &msg, &msg_len, hdrs, &num, prev);
        if (n > 0) {
            header_len = (size_t)n;
            num_headers = num;
            break;
        }
        if (n == -1) {
            buf_free(&b);
            return S3DFS_ERR;
        }
        prev = b.len;
        if (read_more(fd, &b) < 0) {
            buf_free(&b);
            return S3DFS_ERR_IO;
        }
    }

    int64_t clen = -1;
    int keepalive = (minor >= 1);
    const char *hv;
    size_t hl;
    if (header_lookup(hdrs, num_headers, "content-length", &hv, &hl)) {
        char tmp[32];
        if (hl >= sizeof(tmp)) {
            hl = sizeof(tmp) - 1;
        }
        memcpy(tmp, hv, hl);
        tmp[hl] = '\0';
        clen = strtoll(tmp, NULL, 10);
    }
    if (header_lookup(hdrs, num_headers, "connection", &hv, &hl)) {
        if (hl == 5 && strncasecmp(hv, "close", 5) == 0) {
            keepalive = 0;
        }
    }
    if (header_lookup(hdrs, num_headers, "content-type", &hv, &hl)) {
        size_t c = hl < sizeof(out->content_type) - 1 ? hl : sizeof(out->content_type) - 1;
        memcpy(out->content_type, hv, c);
        out->content_type[c] = '\0';
    }
    out->x_size = header_i64(hdrs, num_headers, "x-dleveldb-size", &out->has_x_size);
    if (!out->has_x_size) {
        out->x_size = header_i64(hdrs, num_headers, "x-s3dfs-size", &out->has_x_size);
    }
    out->x_crc = header_i64(hdrs, num_headers, "x-dleveldb-crc", &out->has_x_crc);
    if (!out->has_x_crc) {
        out->x_crc = header_i64(hdrs, num_headers, "x-s3dfs-crc", &out->has_x_crc);
    }
    out->x_mtime = header_i64(hdrs, num_headers, "x-dleveldb-mtime", &out->has_x_mtime);
    if (!out->has_x_mtime) {
        out->x_mtime = header_i64(hdrs, num_headers, "x-s3dfs-mtime", &out->has_x_mtime);
    }

    out->status = status;
    if (clen < 0) {
        /* No content-length: only OK for 204/304 or empty 404. Read until close if needed. */
        if (status == 204 || status == 304 || status == 404) {
            clen = (int64_t)(b.len > header_len ? b.len - header_len : 0);
            /* if we already have leftover and connection stays open, leftover might be 0 */
            if (keepalive) {
                clen = 0;
            } else {
                while (read_more(fd, &b) > 0) {
                }
                clen = (int64_t)(b.len - header_len);
            }
        } else if (status == 200 || status == 201) {
            while (read_more(fd, &b) > 0) {
            }
            clen = (int64_t)(b.len - header_len);
            keepalive = 0;
        } else {
            clen = 0;
        }
    }

    size_t have = b.len > header_len ? b.len - header_len : 0;
    while ((int64_t)have < clen) {
        if (read_more(fd, &b) < 0) {
            buf_free(&b);
            return S3DFS_ERR_IO;
        }
        have = b.len - header_len;
    }
    out->body_len = (size_t)clen;
    if (clen > 0) {
        out->body = malloc((size_t)clen + 1);
        if (!out->body) {
            buf_free(&b);
            return S3DFS_ERR_NOMEM;
        }
        memcpy(out->body, b.data + header_len, (size_t)clen);
        out->body[clen] = '\0';
    } else {
        out->body = malloc(1);
        if (out->body) {
            out->body[0] = '\0';
        }
    }
    buf_free(&b);
    return keepalive ? 1 : 0;
}

int http_request(const char *host, int port,
                 const char *method, const char *path,
                 const char *extra_headers,
                 const void *body, size_t body_len,
                 int allow_404,
                 http_response_t *out)
{
    memset(out, 0, sizeof(*out));
    char hdr[4096];
    int n = snprintf(hdr, sizeof(hdr),
                     "%s %s HTTP/1.1\r\n"
                     "Host: %s:%d\r\n"
                     "Connection: keep-alive\r\n"
                     "Content-Length: %zu\r\n"
                     "%s"
                     "\r\n",
                     method, path, host, port, body_len,
                     extra_headers ? extra_headers : "");
    if (n < 0 || (size_t)n >= sizeof(hdr)) {
        return S3DFS_ERR_ARGS;
    }

    int last_err = S3DFS_ERR_IO;
    for (int attempt = 0; attempt < 2; attempt++) {
        pool_conn_t *c = pool_acquire(host, port);
        if (!c) {
            last_err = S3DFS_ERR_UNAVAILABLE;
            continue;
        }
        struct iovec iov[2];
        iov[0].iov_base = hdr;
        iov[0].iov_len = (size_t)n;
        int iovcnt = 1;
        if (body && body_len) {
            iov[1].iov_base = (void *)body;
            iov[1].iov_len = body_len;
            iovcnt = 2;
        }
        if (writev_all(c->fd, iov, iovcnt) != S3DFS_OK) {
            pool_release(c, 0);
            last_err = S3DFS_ERR_IO;
            continue;
        }
        http_response_t resp;
        int ka = parse_and_read_response(c->fd, &resp);
        if (ka < 0) {
            http_response_free(&resp);
            pool_release(c, 0);
            last_err = S3DFS_ERR_IO;
            continue;
        }
        pool_release(c, ka > 0);
        if (resp.status >= 200 && resp.status < 300) {
            *out = resp;
            return S3DFS_OK;
        }
        if (allow_404 && resp.status == 404) {
            *out = resp;
            return S3DFS_OK;
        }
        *out = resp;
        return S3DFS_ERR_UNAVAILABLE;
    }
    return last_err;
}

int http_listen(const char *host, int port, int backlog)
{
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
#ifdef SO_REUSEPORT
    setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one));
#endif
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (!host || !host[0] || strcmp(host, "0.0.0.0") == 0) {
        addr.sin_addr.s_addr = htonl(INADDR_ANY);
    } else if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        close(fd);
        return -1;
    }
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    if (listen(fd, backlog > 0 ? backlog : 512) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

int http_accept(int listen_fd)
{
    struct sockaddr_in addr;
    socklen_t len = sizeof(addr);
    int fd = accept(listen_fd, (struct sockaddr *)&addr, &len);
    if (fd < 0) {
        return -1;
    }
    set_sock_opts(fd, SERVER_READ_TIMEOUT_MS);
    return fd;
}

int http_in_header(const http_in_t *in, const char *name, char *out, size_t cap)
{
    if (!in->hdr_block || !in->hdr_len) {
        return S3DFS_ERR_NOT_FOUND;
    }
    const char *p = in->hdr_block;
    const char *end = in->hdr_block + in->hdr_len;
    size_t nlen = strlen(name);
    while (p < end) {
        const char *eol = memchr(p, '\n', (size_t)(end - p));
        if (!eol) {
            break;
        }
        const char *line_end = eol;
        if (line_end > p && line_end[-1] == '\r') {
            line_end--;
        }
        const char *colon = memchr(p, ':', (size_t)(line_end - p));
        if (colon) {
            size_t klen = (size_t)(colon - p);
            if (klen == nlen && header_ieq(p, klen, name)) {
                const char *v = colon + 1;
                while (v < line_end && (*v == ' ' || *v == '\t')) {
                    v++;
                }
                size_t vl = (size_t)(line_end - v);
                if (vl >= cap) {
                    vl = cap - 1;
                }
                memcpy(out, v, vl);
                out[vl] = '\0';
                return S3DFS_OK;
            }
        }
        p = eol + 1;
    }
    return S3DFS_ERR_NOT_FOUND;
}

int http_reply(http_out_t *out, int status, const char *extra_headers,
               const void *body, size_t body_len)
{
    const char *text = "OK";
    if (status == 200) {
        text = "OK";
    } else if (status == 204) {
        text = "No Content";
    } else if (status == 206) {
        text = "Partial Content";
    } else if (status == 400) {
        text = "Bad Request";
    } else if (status == 404) {
        text = "Not Found";
    } else if (status == 405) {
        text = "Method Not Allowed";
    } else if (status == 416) {
        text = "Range Not Satisfiable";
    } else if (status == 500) {
        text = "Internal Server Error";
    } else if (status == 501) {
        text = "Not Implemented";
    } else if (status == 503) {
        text = "Service Unavailable";
    }
    char hdr[1024];
    int n = snprintf(hdr, sizeof(hdr),
                     "HTTP/1.1 %d %s\r\n"
                     "Content-Length: %zu\r\n"
                     "Connection: %s\r\n"
                     "%s"
                     "\r\n",
                     status, text, body_len,
                     out->keepalive ? "keep-alive" : "close",
                     extra_headers ? extra_headers : "");
    if (n < 0 || (size_t)n >= sizeof(hdr)) {
        return S3DFS_ERR;
    }
    struct iovec iov[2];
    iov[0].iov_base = hdr;
    iov[0].iov_len = (size_t)n;
    int iovcnt = 1;
    if (body && body_len && !out->is_head) {
        iov[1].iov_base = (void *)body;
        iov[1].iov_len = body_len;
        iovcnt = 2;
    }
    out->header_sent = 1;
    out->status = status;
    return writev_all(out->fd, iov, iovcnt);
}

int http_reply_str(http_out_t *out, int status, const char *content_type, const char *body)
{
    char extra[192];
    snprintf(extra, sizeof(extra), "Content-Type: %s\r\n", content_type ? content_type : "text/plain");
    return http_reply(out, status, extra, body, body ? strlen(body) : 0);
}

static int send_100_continue(int fd)
{
    static const char msg[] = "HTTP/1.1 100 Continue\r\n\r\n";
    return write_all(fd, msg, sizeof(msg) - 1);
}

int http_read_request(int fd, http_in_t *in, int *got_expect)
{
    memset(in, 0, sizeof(*in));
    in->content_length = -1;
    in->keepalive = 1;
    if (got_expect) {
        *got_expect = 0;
    }
    buf_t b = {0};
    size_t prev = 0;
    const char *method;
    size_t method_len;
    const char *path;
    size_t path_len;
    int minor = 0;
    struct phr_header hdrs[MAX_HEADERS];
    size_t header_len = 0;
    size_t num_headers = 0;
    for (;;) {
        num_headers = MAX_HEADERS;
        int n = phr_parse_request(b.data ? b.data : "", b.len, &method, &method_len, &path, &path_len, &minor, hdrs,
                                  &num_headers, prev);
        if (n > 0) {
            header_len = (size_t)n;
            break;
        }
        if (n == -1) {
            buf_free(&b);
            return -1;
        }
        prev = b.len;
        int r = read_more(fd, &b);
        if (r < 0) {
            int eof = (b.len == 0);
            buf_free(&b);
            return eof ? 0 : -1;
        }
    }

    if (method_len >= sizeof(in->method)) {
        buf_free(&b);
        return -1;
    }
    memcpy(in->method, method, method_len);
    in->method[method_len] = '\0';
    for (char *p = in->method; *p; p++) {
        if (*p >= 'a' && *p <= 'z') {
            *p = (char)(*p - 'a' + 'A');
        }
    }

    if (path_len >= sizeof(in->raw_target)) {
        buf_free(&b);
        return -1;
    }
    memcpy(in->raw_target, path, path_len);
    in->raw_target[path_len] = '\0';

    const char *q = memchr(in->raw_target, '?', path_len);
    buf_t pathbuf = {0};
    if (q) {
        if (url_decode(in->raw_target, (size_t)(q - in->raw_target), &pathbuf) != S3DFS_OK) {
            buf_free(&pathbuf);
            buf_free(&b);
            return -1;
        }
        snprintf(in->query, sizeof(in->query), "%s", q + 1);
    } else {
        if (url_decode(in->raw_target, strlen(in->raw_target), &pathbuf) != S3DFS_OK) {
            buf_free(&pathbuf);
            buf_free(&b);
            return -1;
        }
        in->query[0] = '\0';
    }
    snprintf(in->path, sizeof(in->path), "%s", pathbuf.data ? pathbuf.data : "/");
    buf_free(&pathbuf);

    /* capture raw header block for later lookups */
    in->hdr_len = header_len;
    in->hdr_block = malloc(header_len + 1);
    if (!in->hdr_block) {
        buf_free(&b);
        return -1;
    }
    memcpy(in->hdr_block, b.data, header_len);
    in->hdr_block[header_len] = '\0';

    if (minor < 1) {
        in->keepalive = 0;
    }
    for (size_t i = 0; i < num_headers; i++) {
        if (header_ieq(hdrs[i].name, hdrs[i].name_len, "content-length")) {
            char tmp[32];
            size_t l = hdrs[i].value_len < sizeof(tmp) - 1 ? hdrs[i].value_len : sizeof(tmp) - 1;
            memcpy(tmp, hdrs[i].value, l);
            tmp[l] = '\0';
            in->content_length = strtoll(tmp, NULL, 10);
        } else if (header_ieq(hdrs[i].name, hdrs[i].name_len, "connection")) {
            if (hdrs[i].value_len == 5 && strncasecmp(hdrs[i].value, "close", 5) == 0) {
                in->keepalive = 0;
            } else if (hdrs[i].value_len == 10 && strncasecmp(hdrs[i].value, "keep-alive", 10) == 0) {
                in->keepalive = 1;
            }
        } else if (header_ieq(hdrs[i].name, hdrs[i].name_len, "range")) {
            size_t l = hdrs[i].value_len < sizeof(in->range) - 1 ? hdrs[i].value_len : sizeof(in->range) - 1;
            memcpy(in->range, hdrs[i].value, l);
            in->range[l] = '\0';
        } else if (header_ieq(hdrs[i].name, hdrs[i].name_len, "expect")) {
            size_t l = hdrs[i].value_len < sizeof(in->expect) - 1 ? hdrs[i].value_len : sizeof(in->expect) - 1;
            memcpy(in->expect, hdrs[i].value, l);
            in->expect[l] = '\0';
        }
    }

    if (in->expect[0] && strstr(in->expect, "100-continue")) {
        if (got_expect) {
            *got_expect = 1;
        }
        if (send_100_continue(fd) != S3DFS_OK) {
            http_in_free(in);
            buf_free(&b);
            return -1;
        }
    }

    int64_t clen = in->content_length < 0 ? 0 : in->content_length;
    size_t have = b.len > header_len ? b.len - header_len : 0;
    while ((int64_t)have < clen) {
        if (read_more(fd, &b) < 0) {
            http_in_free(in);
            buf_free(&b);
            return -1;
        }
        have = b.len - header_len;
    }
    in->body_len = (size_t)clen;
    if (clen > 0) {
        /* attach body onto hdr_block by reallocating a combined buffer? keep separate copy */
        char *body = malloc((size_t)clen + 1);
        if (!body) {
            http_in_free(in);
            buf_free(&b);
            return -1;
        }
        memcpy(body, b.data + header_len, (size_t)clen);
        body[clen] = '\0';
        in->body = body;
    }
    /* stash body pointer separately; http_in_free must free body too */
    buf_free(&b);
    return 1;
}
