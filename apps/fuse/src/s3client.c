#include "s3client.h"

#include "util.h"

#include <errno.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <unistd.h>

s3_client *s3_client_new(const char *endpoint, const char *bucket) {
    s3_client *c = xmalloc(sizeof(*c));
    size_t n = strlen(endpoint);
    while (n > 0 && endpoint[n - 1] == '/') {
        n--;
    }
    c->endpoint = xmalloc(n + 1);
    memcpy(c->endpoint, endpoint, n);
    c->endpoint[n] = '\0';
    while (*bucket == '/') {
        bucket++;
    }
    size_t bn = strlen(bucket);
    while (bn > 0 && bucket[bn - 1] == '/') {
        bn--;
    }
    c->bucket = xmalloc(bn + 1);
    memcpy(c->bucket, bucket, bn);
    c->bucket[bn] = '\0';
    return c;
}

void s3_client_free(s3_client *c) {
    if (!c) {
        return;
    }
    free(c->endpoint);
    free(c->bucket);
    free(c);
}

static int parse_endpoint(const char *endpoint, char *host, size_t hostcap, char *port, size_t portcap) {
    const char *p = endpoint;
    if (strncmp(p, "http://", 7) != 0) {
        return -1;
    }
    p += 7;
    const char *slash = strchr(p, '/');
    const char *colon = strchr(p, ':');
    if (colon && (!slash || colon < slash)) {
        size_t hn = (size_t)(colon - p);
        if (hn == 0 || hn >= hostcap) {
            return -1;
        }
        memcpy(host, p, hn);
        host[hn] = '\0';
        const char *pe = slash ? slash : p + strlen(p);
        size_t pn = (size_t)(pe - (colon + 1));
        if (pn == 0 || pn >= portcap) {
            return -1;
        }
        memcpy(port, colon + 1, pn);
        port[pn] = '\0';
        return 0;
    }
    size_t hn = slash ? (size_t)(slash - p) : strlen(p);
    if (hn == 0 || hn >= hostcap) {
        return -1;
    }
    memcpy(host, p, hn);
    host[hn] = '\0';
    snprintf(port, portcap, "80");
    return 0;
}

static int dial(const char *endpoint, char *host, size_t hostcap) {
    char port[16];
    if (parse_endpoint(endpoint, host, hostcap, port, sizeof(port)) != 0) {
        return -1;
    }
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_family = AF_UNSPEC;
    struct addrinfo *res = NULL;
    if (getaddrinfo(host, port, &hints, &res) != 0) {
        return -1;
    }
    int fd = -1;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) {
            continue;
        }
        if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) {
            break;
        }
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    return fd;
}

static int write_all(int fd, const void *buf, size_t n) {
    const char *p = buf;
    size_t off = 0;
    while (off < n) {
        ssize_t w = write(fd, p + off, n - off);
        if (w < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (w == 0) {
            return -1;
        }
        off += (size_t)w;
    }
    return 0;
}

static char *object_path(const s3_client *c, const char *key) {
    char *bucket = url_escape(c->bucket);
    size_t cap = strlen(bucket) + (key ? strlen(key) : 0) * 3 + 8;
    char *path = xmalloc(cap);
    size_t used = (size_t)snprintf(path, cap, "/%s", bucket);
    free(bucket);
    int trail = key && key[0] && key[strlen(key) - 1] == '/';
    if (key && key[0]) {
        const char *p = key;
        while (*p && used + 1 < cap) {
            if (*p == '/') {
                p++;
                continue;
            }
            const char *slash = strchr(p, '/');
            size_t seglen = slash ? (size_t)(slash - p) : strlen(p);
            char seg[1024];
            if (seglen >= sizeof(seg)) {
                seglen = sizeof(seg) - 1;
            }
            memcpy(seg, p, seglen);
            seg[seglen] = '\0';
            char *esc = url_escape(seg);
            int w = snprintf(path + used, cap - used, "/%s", esc);
            free(esc);
            if (w < 0 || (size_t)w >= cap - used) {
                break;
            }
            used += (size_t)w;
            p += seglen;
        }
    }
    if (trail && used + 2 < cap && path[used - 1] != '/') {
        path[used++] = '/';
        path[used] = '\0';
    }
    return path;
}

typedef struct {
    int status;
    char *headers;
    uint8_t *body;
    size_t body_len;
} http_resp;

static void http_resp_free(http_resp *r) {
    free(r->headers);
    free(r->body);
    r->headers = NULL;
    r->body = NULL;
}

static int read_resp(int fd, http_resp *out) {
    memset(out, 0, sizeof(*out));
    size_t cap = 4096;
    size_t len = 0;
    char *buf = xmalloc(cap);
    size_t header_end = 0;
    while (!header_end) {
        if (len + 1024 > cap) {
            cap *= 2;
            buf = xrealloc(buf, cap);
        }
        ssize_t n = read(fd, buf + len, cap - len - 1);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            free(buf);
            return -1;
        }
        if (n == 0) {
            break;
        }
        len += (size_t)n;
        buf[len] = '\0';
        char *mark = strstr(buf, "\r\n\r\n");
        if (mark) {
            header_end = (size_t)(mark - buf) + 4;
        }
    }
    if (!header_end) {
        free(buf);
        return -1;
    }
    int status = 0;
    if (sscanf(buf, "HTTP/%*s %d", &status) != 1) {
        free(buf);
        return -1;
    }
    out->status = status;
    out->headers = xmalloc(header_end + 1);
    memcpy(out->headers, buf, header_end);
    out->headers[header_end] = '\0';
    size_t already = len - header_end;
    char cl[64] = {0};
    long long content_length = -1;
    if (header_value(out->headers, "Content-Length", cl, sizeof(cl)) == 0) {
        content_length = atoll(cl);
    }
    if (content_length < 0) {
        size_t bcap = already + 1;
        uint8_t *body = xmalloc(bcap);
        if (already) {
            memcpy(body, buf + header_end, already);
        }
        size_t blen = already;
        for (;;) {
            if (blen + 4096 > bcap) {
                bcap = bcap * 2 + 4096;
                body = xrealloc(body, bcap);
            }
            ssize_t n = read(fd, body + blen, bcap - blen);
            if (n < 0) {
                if (errno == EINTR) {
                    continue;
                }
                free(body);
                free(buf);
                return -1;
            }
            if (n == 0) {
                break;
            }
            blen += (size_t)n;
        }
        out->body = body;
        out->body_len = blen;
    } else {
        uint8_t *body = xmalloc((size_t)content_length + 1);
        size_t got = already;
        if (already) {
            if (already > (size_t)content_length) {
                already = (size_t)content_length;
            }
            memcpy(body, buf + header_end, already);
            got = already;
        }
        while (got < (size_t)content_length) {
            ssize_t n = read(fd, body + got, (size_t)content_length - got);
            if (n < 0) {
                if (errno == EINTR) {
                    continue;
                }
                free(body);
                free(buf);
                return -1;
            }
            if (n == 0) {
                break;
            }
            got += (size_t)n;
        }
        out->body = body;
        out->body_len = got;
    }
    free(buf);
    return 0;
}

static int request(s3_client *c, const char *method, const char *path, const char *extra_headers, const void *body,
                    size_t body_len, int send_file_fd, http_resp *resp, char *err, size_t errcap) {
    char host[256];
    int fd = dial(c->endpoint, host, sizeof(host));
    if (fd < 0) {
        snprintf(err, errcap, "connect %s failed", c->endpoint);
        return -1;
    }
    char head[2048];
    int hn = snprintf(head, sizeof(head),
                      "%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\nContent-Length: %zu\r\n%s\r\n", method, path,
                      host, send_file_fd >= 0 ? body_len : body_len, extra_headers ? extra_headers : "");
    if (hn < 0 || (size_t)hn >= sizeof(head)) {
        close(fd);
        snprintf(err, errcap, "request header too long");
        return -1;
    }
    if (write_all(fd, head, (size_t)hn) != 0) {
        close(fd);
        snprintf(err, errcap, "write header failed");
        return -1;
    }
    if (send_file_fd >= 0) {
        off_t start = lseek(send_file_fd, 0, SEEK_SET);
        (void)start;
        char buf[8192];
        size_t left = body_len;
        while (left > 0) {
            size_t chunk = left < sizeof(buf) ? left : sizeof(buf);
            ssize_t n = read(send_file_fd, buf, chunk);
            if (n < 0) {
                if (errno == EINTR) {
                    continue;
                }
                close(fd);
                snprintf(err, errcap, "read file failed");
                return -1;
            }
            if (n == 0) {
                break;
            }
            if (write_all(fd, buf, (size_t)n) != 0) {
                close(fd);
                snprintf(err, errcap, "write body failed");
                return -1;
            }
            left -= (size_t)n;
        }
    } else if (body_len > 0 && body) {
        if (write_all(fd, body, body_len) != 0) {
            close(fd);
            snprintf(err, errcap, "write body failed");
            return -1;
        }
    }
    int rc = read_resp(fd, resp);
    close(fd);
    if (rc != 0) {
        snprintf(err, errcap, "read response failed");
    }
    return rc;
}

static void fill_head(const http_resp *resp, s3_meta *out) {
    memset(out, 0, sizeof(*out));
    out->found = 1;
    header_value(resp->headers, "ETag", out->etag, sizeof(out->etag));
    char cl[64] = {0};
    if (header_value(resp->headers, "Content-Length", cl, sizeof(cl)) == 0) {
        out->size = atoll(cl);
    } else {
        out->size = (int64_t)resp->body_len;
    }
    char lm[128] = {0};
    if (header_value(resp->headers, "Last-Modified", lm, sizeof(lm)) == 0) {
        parse_rfc1123(lm, &out->mtime);
    }
}

int s3_head(s3_client *c, const char *key, s3_meta *out, char *err, size_t errcap) {
    char *path = object_path(c, key);
    http_resp resp;
    int rc = request(c, "HEAD", path, NULL, NULL, 0, -1, &resp, err, errcap);
    free(path);
    if (rc != 0) {
        return -1;
    }
    if (resp.status == 404) {
        memset(out, 0, sizeof(*out));
        http_resp_free(&resp);
        return 0;
    }
    if (resp.status >= 400) {
        snprintf(err, errcap, "head %s: HTTP %d", key, resp.status);
        http_resp_free(&resp);
        return -1;
    }
    fill_head(&resp, out);
    http_resp_free(&resp);
    return 0;
}

int s3_get(s3_client *c, const char *key, const char *range_header, uint8_t **body, size_t *len, s3_meta *out,
           char *err, size_t errcap) {
    char *path = object_path(c, key);
    char extra[256] = {0};
    if (range_header && range_header[0]) {
        snprintf(extra, sizeof(extra), "Range: %s\r\n", range_header);
    }
    http_resp resp;
    int rc = request(c, "GET", path, extra[0] ? extra : NULL, NULL, 0, -1, &resp, err, errcap);
    free(path);
    if (rc != 0) {
        return -1;
    }
    if (resp.status == 404) {
        *body = NULL;
        *len = 0;
        if (out) {
            memset(out, 0, sizeof(*out));
        }
        http_resp_free(&resp);
        return 0;
    }
    int ranged = range_header && range_header[0];
    if (ranged && resp.status != 206 && resp.status != 200) {
        snprintf(err, errcap, "get %s: HTTP %d", key, resp.status);
        http_resp_free(&resp);
        return -1;
    }
    if (!ranged && resp.status != 200) {
        snprintf(err, errcap, "get %s: HTTP %d", key, resp.status);
        http_resp_free(&resp);
        return -1;
    }
    if (out) {
        fill_head(&resp, out);
    }
    *body = resp.body;
    *len = resp.body_len;
    resp.body = NULL;
    http_resp_free(&resp);
    return 0;
}

int s3_put(s3_client *c, const char *key, const void *body, size_t len, char *err, size_t errcap) {
    char *path = object_path(c, key);
    http_resp resp;
    int rc = request(c, "PUT", path, "Content-Type: application/octet-stream\r\n", body, len, -1, &resp, err, errcap);
    free(path);
    if (rc != 0) {
        return -1;
    }
    int status = resp.status;
    http_resp_free(&resp);
    if (status >= 400) {
        snprintf(err, errcap, "put %s: HTTP %d", key, status);
        return -1;
    }
    return 0;
}

int s3_put_file(s3_client *c, const char *key, int fd, char *err, size_t errcap) {
    off_t end = lseek(fd, 0, SEEK_END);
    if (end < 0) {
        snprintf(err, errcap, "stat temp file failed");
        return -1;
    }
    char *path = object_path(c, key);
    http_resp resp;
    int rc = request(c, "PUT", path, "Content-Type: application/octet-stream\r\n", NULL, (size_t)end, fd, &resp, err,
                     errcap);
    free(path);
    if (rc != 0) {
        return -1;
    }
    int status = resp.status;
    http_resp_free(&resp);
    if (status >= 400) {
        snprintf(err, errcap, "put %s: HTTP %d", key, status);
        return -1;
    }
    return 0;
}

int s3_delete(s3_client *c, const char *key, char *err, size_t errcap) {
    char *path = object_path(c, key);
    http_resp resp;
    int rc = request(c, "DELETE", path, NULL, NULL, 0, -1, &resp, err, errcap);
    free(path);
    if (rc != 0) {
        return -1;
    }
    int status = resp.status;
    http_resp_free(&resp);
    if (status != 404 && status >= 400) {
        snprintf(err, errcap, "delete %s: HTTP %d", key, status);
        return -1;
    }
    return 0;
}

static char *tag_text(const char *xml, const char *open, const char *close, const char **next) {
    const char *a = strstr(xml, open);
    if (!a) {
        return NULL;
    }
    a += strlen(open);
    const char *b = strstr(a, close);
    if (!b) {
        return NULL;
    }
    size_t n = (size_t)(b - a);
    char *raw = xmalloc(n + 1);
    memcpy(raw, a, n);
    raw[n] = '\0';
    char *out = xmalloc(n + 1);
    xml_unescape(raw, out, n + 1);
    free(raw);
    if (next) {
        *next = b + strlen(close);
    }
    return out;
}

void s3_list_free(s3_listing *list) {
    if (!list) {
        return;
    }
    for (size_t i = 0; i < list->object_count; i++) {
        free(list->objects[i].key);
    }
    free(list->objects);
    for (size_t i = 0; i < list->prefix_count; i++) {
        free(list->prefixes[i]);
    }
    free(list->prefixes);
    free(list->next_token);
    memset(list, 0, sizeof(*list));
}

int s3_list(s3_client *c, const char *prefix, const char *delimiter, const char *start_after, int max_keys,
            s3_listing *out, char *err, size_t errcap) {
    memset(out, 0, sizeof(*out));
    if (max_keys <= 0) {
        max_keys = 1000;
    }
    char *esc_prefix = url_escape(prefix ? prefix : "");
    char *esc_delim = delimiter && delimiter[0] ? url_escape(delimiter) : NULL;
    char *esc_start = start_after && start_after[0] ? url_escape(start_after) : NULL;
    char *bucket = url_escape(c->bucket);
    size_t pathcap = strlen(bucket) + strlen(esc_prefix) + (esc_delim ? strlen(esc_delim) : 0) +
                     (esc_start ? strlen(esc_start) : 0) + 64;
    char *path = xmalloc(pathcap);
    snprintf(path, pathcap, "/%s?prefix=%s&max-keys=%d%s%s%s%s", bucket, esc_prefix, max_keys,
             esc_delim ? "&delimiter=" : "", esc_delim ? esc_delim : "", esc_start ? "&start-after=" : "",
             esc_start ? esc_start : "");
    free(esc_prefix);
    free(esc_delim);
    free(esc_start);
    free(bucket);
    http_resp resp;
    int rc = request(c, "GET", path, NULL, NULL, 0, -1, &resp, err, errcap);
    free(path);
    if (rc != 0) {
        return -1;
    }
    if (resp.status >= 400) {
        snprintf(err, errcap, "list %s: HTTP %d", prefix ? prefix : "", resp.status);
        http_resp_free(&resp);
        return -1;
    }
    char *xml = xmalloc(resp.body_len + 1);
    memcpy(xml, resp.body ? resp.body : (uint8_t *)"", resp.body_len);
    xml[resp.body_len] = '\0';
    http_resp_free(&resp);
    char *trunc = tag_text(xml, "<IsTruncated>", "</IsTruncated>", NULL);
    out->truncated = trunc && strcmp(trunc, "true") == 0;
    free(trunc);
    out->next_token = tag_text(xml, "<NextContinuationToken>", "</NextContinuationToken>", NULL);

    const char *cursor = xml;
    while (cursor && *cursor) {
        const char *block = strstr(cursor, "<Contents>");
        if (!block) {
            break;
        }
        const char *end = strstr(block, "</Contents>");
        if (!end) {
            break;
        }
        size_t blen = (size_t)(end - block);
        char *piece = xmalloc(blen + 1);
        memcpy(piece, block, blen);
        piece[blen] = '\0';
        char *key = tag_text(piece, "<Key>", "</Key>", NULL);
        char *size = tag_text(piece, "<Size>", "</Size>", NULL);
        char *mod = tag_text(piece, "<LastModified>", "</LastModified>", NULL);
        if (key) {
            out->objects = xrealloc(out->objects, (out->object_count + 1) * sizeof(out->objects[0]));
            s3_object *obj = &out->objects[out->object_count++];
            memset(obj, 0, sizeof(*obj));
            obj->key = key;
            obj->size = size ? atoll(size) : 0;
            if (mod) {
                parse_rfc3339(mod, &obj->mtime);
            }
        }
        free(size);
        free(mod);
        free(piece);
        cursor = end + 11;
    }
    cursor = xml;
    while (cursor && *cursor) {
        const char *block = strstr(cursor, "<CommonPrefixes>");
        if (!block) {
            break;
        }
        const char *end = strstr(block, "</CommonPrefixes>");
        if (!end) {
            break;
        }
        size_t blen = (size_t)(end - block);
        char *piece = xmalloc(blen + 1);
        memcpy(piece, block, blen);
        piece[blen] = '\0';
        char *pfx = tag_text(piece, "<Prefix>", "</Prefix>", NULL);
        if (pfx) {
            out->prefixes = xrealloc(out->prefixes, (out->prefix_count + 1) * sizeof(char *));
            out->prefixes[out->prefix_count++] = pfx;
        }
        free(piece);
        cursor = end + 16;
    }
    free(xml);
    return 0;
}
