#include "fs.h"
#include "s3client.h"
#include "util.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static int failures = 0;

#define CHECK(cond, msg)                                                                                               \
    do {                                                                                                               \
        if (!(cond)) {                                                                                                 \
            fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, msg);                                               \
            failures++;                                                                                                \
        }                                                                                                              \
    } while (0)

typedef struct mem_obj {
    char *key;
    uint8_t *body;
    size_t len;
    time_t mtime;
    struct mem_obj *next;
} mem_obj;

static mem_obj *objs;
static pthread_mutex_t obj_mu = PTHREAD_MUTEX_INITIALIZER;

static mem_obj *find_obj(const char *key) {
    for (mem_obj *o = objs; o; o = o->next) {
        if (strcmp(o->key, key) == 0) {
            return o;
        }
    }
    return NULL;
}

static void put_obj(const char *key, const uint8_t *body, size_t len) {
    pthread_mutex_lock(&obj_mu);
    mem_obj *o = find_obj(key);
    if (!o) {
        o = xmalloc(sizeof(*o));
        o->key = xstrdup(key);
        o->next = objs;
        objs = o;
    } else {
        free(o->body);
    }
    o->body = xmalloc(len + 1);
    memcpy(o->body, body, len);
    o->len = len;
    o->mtime = time(NULL);
    pthread_mutex_unlock(&obj_mu);
}

static int read_http(int fd, char **req, uint8_t **body, size_t *body_len) {
    size_t cap = 4096, len = 0, header_end = 0;
    char *buf = xmalloc(cap);
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
    char cl[64] = {0};
    size_t need = 0;
    if (header_value(buf, "Content-Length", cl, sizeof(cl)) == 0) {
        need = (size_t)atoll(cl);
    }
    size_t have = len - header_end;
    while (have < need) {
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
        have += (size_t)n;
    }
    buf[len] = '\0';
    *req = buf;
    *body = (uint8_t *)buf + header_end;
    *body_len = have < need ? have : need;
    return 0;
}

static void send_all(int fd, const char *s) { (void)!write(fd, s, strlen(s)); }

static void handle_list(int fd, const char *query) {
    char prefix[1024] = {0};
    char delim[32] = {0};
    const char *p = query;
    while (p && *p) {
        char pair[1024];
        const char *amp = strchr(p, '&');
        size_t n = amp ? (size_t)(amp - p) : strlen(p);
        if (n >= sizeof(pair)) {
            n = sizeof(pair) - 1;
        }
        memcpy(pair, p, n);
        pair[n] = '\0';
        char *eq = strchr(pair, '=');
        if (eq) {
            *eq = '\0';
            url_unescape(eq + 1);
            if (strcmp(pair, "prefix") == 0) {
                snprintf(prefix, sizeof(prefix), "%s", eq + 1);
            } else if (strcmp(pair, "delimiter") == 0) {
                snprintf(delim, sizeof(delim), "%s", eq + 1);
            }
        }
        p = amp ? amp + 1 : NULL;
    }
    char *xml = xmalloc(4096);
    size_t cap = 4096, used = 0;
    used += (size_t)snprintf(xml, cap, "<?xml version=\"1.0\"?><ListBucketResult><IsTruncated>false</IsTruncated>");
    pthread_mutex_lock(&obj_mu);
    char seen[32][512];
    int seen_n = 0;
    for (mem_obj *o = objs; o; o = o->next) {
        if (strncmp(o->key, prefix, strlen(prefix)) != 0) {
            continue;
        }
        const char *rest = o->key + strlen(prefix);
        if (delim[0]) {
            const char *cut = strstr(rest, delim);
            if (cut) {
                char common[512];
                snprintf(common, sizeof(common), "%s%.*s%s", prefix, (int)(cut - rest), rest, delim);
                int dup = 0;
                for (int i = 0; i < seen_n; i++) {
                    if (strcmp(seen[i], common) == 0) {
                        dup = 1;
                    }
                }
                if (!dup && seen_n < 32) {
                    snprintf(seen[seen_n], sizeof(seen[seen_n]), "%s", common);
                    seen_n++;
                    char esc[1024];
                    xml_escape(common, esc, sizeof(esc));
                    if (used + strlen(esc) + 64 > cap) {
                        cap *= 2;
                        xml = xrealloc(xml, cap);
                    }
                    used += (size_t)sprintf(xml + used, "<CommonPrefixes><Prefix>%s</Prefix></CommonPrefixes>", esc);
                }
                continue;
            }
        }
        char esc[1024];
        xml_escape(o->key, esc, sizeof(esc));
        char mod[64];
        format_rfc1123(o->mtime, mod, sizeof(mod));
        /* List uses RFC3339 in the real API; the client accepts that. Emit RFC3339. */
        struct tm tm;
        gmtime_r(&o->mtime, &tm);
        strftime(mod, sizeof(mod), "%Y-%m-%dT%H:%M:%SZ", &tm);
        if (used + strlen(esc) + 128 > cap) {
            cap *= 2;
            xml = xrealloc(xml, cap);
        }
        used += (size_t)sprintf(xml + used, "<Contents><Key>%s</Key><Size>%zu</Size><LastModified>%s</LastModified></Contents>",
                                esc, o->len, mod);
    }
    pthread_mutex_unlock(&obj_mu);
    if (used + 32 > cap) {
        xml = xrealloc(xml, used + 32);
    }
    strcat(xml, "</ListBucketResult>");
    char hdr[256];
    snprintf(hdr, sizeof(hdr),
             "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
             strlen(xml));
    send_all(fd, hdr);
    send_all(fd, xml);
    free(xml);
}

static void handle_conn(int fd) {
    char *req = NULL;
    uint8_t *body = NULL;
    size_t body_len = 0;
    if (read_http(fd, &req, &body, &body_len) != 0) {
        close(fd);
        return;
    }
    char method[16] = {0}, url[2048] = {0};
    sscanf(req, "%15s %2047s", method, url);
    char *q = strchr(url, '?');
    char *query = NULL;
    if (q) {
        *q = '\0';
        query = q + 1;
    }
    url_unescape(url);
    const char *path = url;
    if (strcmp(method, "GET") == 0 && strcmp(path, "/demo") == 0) {
        handle_list(fd, query ? query : "");
        free(req);
        close(fd);
        return;
    }
    const char *key = path;
    if (strncmp(key, "/demo/", 6) == 0) {
        key += 6;
    } else if (strcmp(key, "/demo") == 0) {
        key = "";
    }
    if (strcmp(method, "PUT") == 0) {
        put_obj(key, body, body_len);
        send_all(fd, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    } else if (strcmp(method, "HEAD") == 0 || strcmp(method, "GET") == 0) {
        pthread_mutex_lock(&obj_mu);
        mem_obj *o = find_obj(key);
        size_t len = o ? o->len : 0;
        uint8_t *copy = NULL;
        time_t mtime = 0;
        if (o) {
            copy = xmalloc(o->len + 1);
            memcpy(copy, o->body, o->len);
            mtime = o->mtime;
        }
        pthread_mutex_unlock(&obj_mu);
        if (!o) {
            send_all(fd, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            free(copy);
            free(req);
            close(fd);
            return;
        }
        char lm[64];
        format_rfc1123(mtime, lm, sizeof(lm));
        char range[128] = {0};
        header_value(req, "Range", range, sizeof(range));
        if (strcmp(method, "GET") == 0 && range[0]) {
            long long start = 0, end = (long long)len - 1;
            sscanf(range, "bytes=%lld-%lld", &start, &end);
            if (start < 0 || start >= (long long)len || end < start) {
                char hdr[256];
                snprintf(hdr, sizeof(hdr),
                         "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */%zu\r\nContent-Length: 0\r\n"
                         "Connection: close\r\n\r\n",
                         len);
                send_all(fd, hdr);
            } else {
                if (end >= (long long)len) {
                    end = (long long)len - 1;
                }
                size_t n = (size_t)(end - start + 1);
                char hdr[256];
                snprintf(hdr, sizeof(hdr),
                         "HTTP/1.1 206 Partial Content\r\nETag: \"abc\"\r\nLast-Modified: %s\r\n"
                         "Content-Range: bytes %lld-%lld/%zu\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
                         lm, start, end, len, n);
                send_all(fd, hdr);
                (void)!write(fd, copy + start, n);
            }
        } else {
            char hdr[256];
            snprintf(hdr, sizeof(hdr),
                     "HTTP/1.1 200 OK\r\nETag: \"abc\"\r\nLast-Modified: %s\r\nContent-Length: %zu\r\n"
                     "Connection: close\r\n\r\n",
                     lm, len);
            send_all(fd, hdr);
            if (strcmp(method, "GET") == 0) {
                (void)!write(fd, copy, len);
            }
        }
        free(copy);
    } else if (strcmp(method, "DELETE") == 0) {
        pthread_mutex_lock(&obj_mu);
        mem_obj **pp = &objs;
        while (*pp) {
            if (strcmp((*pp)->key, key) == 0) {
                mem_obj *dead = *pp;
                *pp = dead->next;
                free(dead->key);
                free(dead->body);
                free(dead);
                break;
            }
            pp = &(*pp)->next;
        }
        pthread_mutex_unlock(&obj_mu);
        send_all(fd, "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    } else {
        send_all(fd, "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
    free(req);
    close(fd);
}

static void *serve(void *arg) {
    int lfd = *(int *)arg;
    for (;;) {
        int cfd = accept(lfd, NULL, NULL);
        if (cfd < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        handle_conn(cfd);
    }
    return NULL;
}

static void test_roundtrip(const char *endpoint) {
    s3_client *client = s3_client_new(endpoint, "demo");
    object_fs *fs = fs_new(client);
    CHECK(fs_mkdir(fs, "dir") == 0, "mkdir");
    fs_file *f = NULL;
    CHECK(fs_open(fs, "dir/hello.txt", O_CREAT | O_RDWR | O_TRUNC, &f) == 0, "open write");
    size_t got = 0;
    CHECK(fs_write(f, "hello-fuse", 10, &got) == 0 && got == 10, "write");
    CHECK(fs_close(f) == 0, "close");
    fs_info st;
    CHECK(fs_stat(fs, "dir/hello.txt", &st) == 0 && !st.is_dir && st.size == 10, "stat file");
    CHECK(fs_open(fs, "dir/hello.txt", O_RDONLY, &f) == 0, "open read");
    char buf[32] = {0};
    got = 0;
    CHECK(fs_read(f, buf, sizeof(buf), &got) == 0 && got == 10 && memcmp(buf, "hello-fuse", 10) == 0, "read");
    fs_close(f);
    CHECK(fs_open(fs, "dir", O_RDONLY, &f) == 0, "open dir");
    fs_info *ents = NULL;
    size_t n = 0;
    CHECK(fs_readdir(f, &ents, &n) == 0 && n == 1 && strcmp(ents[0].name, "hello.txt") == 0 && !ents[0].is_dir,
          "readdir");
    free(ents);
    fs_close(f);
    CHECK(fs_rename(fs, "dir/hello.txt", "dir/renamed.txt") == 0, "rename");
    CHECK(fs_remove(fs, "dir/renamed.txt") == 0, "unlink");
    CHECK(fs_stat(fs, "dir/renamed.txt", &st) == ENOENT, "missing after delete");
    CHECK(fs_remove(fs, "dir") == 0, "rmdir");
    fs_free(fs);
    s3_client_free(client);
}

static void test_range(const char *endpoint) {
    s3_client *client = s3_client_new(endpoint, "demo");
    char err[256] = {0};
    CHECK(s3_put(client, "x.bin", "abcdefghij", 10, err, sizeof(err)) == 0, "put range src");
    uint8_t *body = NULL;
    size_t len = 0;
    CHECK(s3_get(client, "x.bin", "bytes=2-5", &body, &len, NULL, err, sizeof(err)) == 0, "range get");
    CHECK(body && len == 4 && memcmp(body, "cdef", 4) == 0, "range bytes");
    free(body);
    s3_client_free(client);
}

int main(void) {
    int lfd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    int yes = 1;
    setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    if (bind(lfd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(lfd, 16) != 0) {
        perror("listen");
        return 1;
    }
    socklen_t alen = sizeof(addr);
    getsockname(lfd, (struct sockaddr *)&addr, &alen);
    pthread_t th;
    pthread_create(&th, NULL, serve, &lfd);
    char endpoint[64];
    snprintf(endpoint, sizeof(endpoint), "http://127.0.0.1:%d", ntohs(addr.sin_port));
    test_roundtrip(endpoint);
    test_range(endpoint);
    shutdown(lfd, SHUT_RDWR);
    close(lfd);
    pthread_join(th, NULL);
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("ok\n");
    return 0;
}
