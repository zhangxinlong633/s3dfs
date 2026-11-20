#include "webdav.h"

#include "util.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t webdav_stop = 0;

static void on_signal(int sig) {
    (void)sig;
    webdav_stop = 1;
}

static int write_all_fd(int fd, const void *buf, size_t n) {
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
        off += (size_t)w;
    }
    return 0;
}

static int read_request(int fd, char **head_out, uint8_t **body_out, size_t *body_len) {
    size_t cap = 8192, len = 0, header_end = 0;
    char *buf = xmalloc(cap);
    while (!header_end) {
        if (len + 2048 > cap) {
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
        need = (size_t)strtoull(cl, NULL, 10);
    }
    while (len - header_end < need) {
        if (len + 4096 > cap) {
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
    }
    buf[len] = '\0';
    *head_out = buf;
    *body_out = (uint8_t *)(buf + header_end);
    *body_len = len - header_end < need ? len - header_end : need;
    return 0;
}

static void respond(int fd, int status, const char *reason, const char *extra, const void *body, size_t n) {
    char hdr[1024];
    snprintf(hdr, sizeof(hdr), "HTTP/1.1 %d %s\r\nConnection: close\r\nContent-Length: %zu\r\n%s\r\n", status, reason, n,
             extra ? extra : "");
    write_all_fd(fd, hdr, strlen(hdr));
    if (n && body) {
        write_all_fd(fd, body, n);
    }
}

static const char *status_reason(int code) {
    switch (code) {
    case 200:
        return "OK";
    case 201:
        return "Created";
    case 204:
        return "No Content";
    case 207:
        return "Multi-Status";
    case 400:
        return "Bad Request";
    case 404:
        return "Not Found";
    case 405:
        return "Method Not Allowed";
    case 409:
        return "Conflict";
    case 500:
        return "Internal Server Error";
    case 501:
        return "Not Implemented";
    default:
        return "Error";
    }
}

static int http_errno(int err) {
    if (err == ENOENT) {
        return 404;
    }
    if (err == EEXIST) {
        return 405;
    }
    if (err == ENOTEMPTY || err == ENOTDIR) {
        return 409;
    }
    if (err == ENOTSUP) {
        return 501;
    }
    if (err == EINVAL) {
        return 400;
    }
    return 500;
}

static void href_of(const char *path, int is_dir, char *out, size_t cap) {
    if (!path || path[0] == '\0' || strcmp(path, "/") == 0) {
        snprintf(out, cap, "/");
        return;
    }
    const char *p = path[0] == '/' ? path + 1 : path;
    size_t used = 0;
    out[0] = '\0';
    while (*p && used + 1 < cap) {
        const char *slash = strchr(p, '/');
        size_t n = slash ? (size_t)(slash - p) : strlen(p);
        char seg[1024];
        if (n >= sizeof(seg)) {
            n = sizeof(seg) - 1;
        }
        memcpy(seg, p, n);
        seg[n] = '\0';
        if (seg[0] == '\0') {
            p = slash ? slash + 1 : p + n;
            continue;
        }
        char *esc = url_escape(seg);
        int w = snprintf(out + used, cap - used, "/%s", esc);
        free(esc);
        if (w < 0 || (size_t)w >= cap - used) {
            break;
        }
        used += (size_t)w;
        if (!slash) {
            break;
        }
        p = slash + 1;
    }
    if (is_dir && used + 2 < cap && (used == 0 || out[used - 1] != '/')) {
        out[used++] = '/';
        out[used] = '\0';
    }
}

static void prop_xml(object_fs *fs, const char *path, char *out, size_t cap) {
    fs_info info;
    int rc = fs_stat(fs, path, &info);
    char href[2048];
    href_of(path, rc == 0 && info.is_dir, href, sizeof(href));
    if (rc != 0) {
        snprintf(out, cap,
                 "<D:response><D:href>%s</D:href><D:propstat><D:status>HTTP/1.1 %d %s</D:status></D:propstat></D:response>",
                 href, http_errno(rc), status_reason(http_errno(rc)));
        return;
    }
    char lm[64] = {0};
    if (info.mtime) {
        format_rfc1123(info.mtime, lm, sizeof(lm));
    }
    char name_esc[2048];
    xml_escape(info.name[0] ? info.name : path, name_esc, sizeof(name_esc));
    snprintf(out, cap,
             "<D:response><D:href>%s</D:href><D:propstat><D:prop>"
             "<D:displayname>%s</D:displayname>"
             "<D:getcontentlength>%lld</D:getcontentlength>"
             "<D:getlastmodified>%s</D:getlastmodified>"
             "<D:resourcetype>%s</D:resourcetype>"
             "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
             href, name_esc, (long long)info.size, lm, info.is_dir ? "<D:collection/>" : "");
}

static void handle_one(object_fs *fs, int fd) {
    char *head = NULL;
    uint8_t *body = NULL;
    size_t body_len = 0;
    if (read_request(fd, &head, &body, &body_len) != 0) {
        close(fd);
        return;
    }
    char method[32] = {0}, url[2048] = {0};
    sscanf(head, "%31s %2047s", method, url);
    char *q = strchr(url, '?');
    if (q) {
        *q = '\0';
    }
    url_unescape(url);
    char path[2048];
    snprintf(path, sizeof(path), "%s", url);
    if (strcmp(method, "OPTIONS") == 0) {
        respond(fd, 200, "OK",
                "Allow: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, LOCK, UNLOCK\r\n"
                "DAV: 1, 2\r\nMS-Author-Via: DAV\r\n",
                NULL, 0);
    } else if (strcmp(method, "PROPFIND") == 0) {
        char depth[16] = "1";
        header_value(head, "Depth", depth, sizeof(depth));
        char *xml = xmalloc(65536);
        size_t used = 0;
        used += (size_t)snprintf(xml, 65536,
                                 "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                                 "<D:multistatus xmlns:D=\"DAV:\">");
        char one[4096];
        prop_xml(fs, path, one, sizeof(one));
        used += (size_t)snprintf(xml + used, 65536 - used, "%s", one);
        if (strcmp(depth, "0") != 0) {
            fs_file *dir = NULL;
            if (fs_open(fs, path, O_RDONLY, &dir) == 0) {
                fs_info *ents = NULL;
                size_t n = 0;
                if (fs_readdir(dir, &ents, &n) == 0) {
                    for (size_t i = 0; i < n && used + 5000 < 65536; i++) {
                        char child[2048];
                        if (strcmp(path, "/") == 0) {
                            snprintf(child, sizeof(child), "/%s", ents[i].name);
                        } else {
                            snprintf(child, sizeof(child), "%s/%s", path, ents[i].name);
                        }
                        prop_xml(fs, child, one, sizeof(one));
                        used += (size_t)snprintf(xml + used, 65536 - used, "%s", one);
                    }
                    free(ents);
                }
                fs_close(dir);
            }
        }
        snprintf(xml + used, 65536 - used, "</D:multistatus>");
        respond(fd, 207, "Multi-Status", "Content-Type: application/xml; charset=utf-8\r\n", xml, strlen(xml));
        free(xml);
    } else if (strcmp(method, "GET") == 0 || strcmp(method, "HEAD") == 0) {
        fs_info info;
        int rc = fs_stat(fs, path, &info);
        if (rc != 0) {
            respond(fd, http_errno(rc), status_reason(http_errno(rc)), NULL, NULL, 0);
        } else if (info.is_dir) {
            respond(fd, 200, "OK", "Content-Type: httpd/unix-directory\r\n", NULL, 0);
        } else if (strcmp(method, "HEAD") == 0) {
            char extra[128];
            snprintf(extra, sizeof(extra), "Content-Type: application/octet-stream\r\n");
            /* Content-Length is the empty body here; stat size is not the HTTP body. */
            (void)extra;
            char hdr[256];
            snprintf(hdr, sizeof(hdr),
                     "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %lld\r\n"
                     "Connection: close\r\n\r\n",
                     (long long)info.size);
            write_all_fd(fd, hdr, strlen(hdr));
        } else {
            fs_file *f = NULL;
            rc = fs_open(fs, path, O_RDONLY, &f);
            if (rc != 0) {
                respond(fd, http_errno(rc), status_reason(http_errno(rc)), NULL, NULL, 0);
            } else {
                uint8_t *buf = xmalloc((size_t)info.size + 1);
                size_t got = 0;
                fs_read(f, buf, (size_t)info.size, &got);
                fs_close(f);
                char hdr[256];
                snprintf(hdr, sizeof(hdr),
                         "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %zu\r\n"
                         "Connection: close\r\n\r\n",
                         got);
                write_all_fd(fd, hdr, strlen(hdr));
                write_all_fd(fd, buf, got);
                free(buf);
            }
        }
    } else if (strcmp(method, "PUT") == 0) {
        fs_file *f = NULL;
        int rc = fs_open(fs, path, O_CREAT | O_RDWR | O_TRUNC, &f);
        if (rc == 0) {
            size_t got = 0;
            rc = fs_write(f, body, body_len, &got);
            int cerr = fs_close(f);
            if (rc == 0) {
                rc = cerr;
            }
        }
        if (rc != 0) {
            respond(fd, http_errno(rc), status_reason(http_errno(rc)), NULL, NULL, 0);
        } else {
            respond(fd, 201, "Created", NULL, NULL, 0);
        }
    } else if (strcmp(method, "DELETE") == 0) {
        int rc = fs_remove(fs, path);
        if (rc != 0) {
            respond(fd, http_errno(rc), status_reason(http_errno(rc)), NULL, NULL, 0);
        } else {
            respond(fd, 204, "No Content", NULL, NULL, 0);
        }
    } else if (strcmp(method, "MKCOL") == 0) {
        int rc = fs_mkdir(fs, path);
        if (rc != 0) {
            respond(fd, http_errno(rc), status_reason(http_errno(rc)), NULL, NULL, 0);
        } else {
            respond(fd, 201, "Created", NULL, NULL, 0);
        }
    } else if (strcmp(method, "MOVE") == 0) {
        char dest[2048] = {0};
        if (header_value(head, "Destination", dest, sizeof(dest)) != 0) {
            respond(fd, 400, "Bad Request", NULL, NULL, 0);
        } else {
            char *slash = strstr(dest, "://");
            char *dpath = slash ? strchr(slash + 3, '/') : dest;
            if (!dpath) {
                dpath = dest;
            }
            url_unescape(dpath);
            int rc = fs_rename(fs, path, dpath);
            if (rc != 0) {
                respond(fd, http_errno(rc), status_reason(http_errno(rc)), NULL, NULL, 0);
            } else {
                respond(fd, 201, "Created", NULL, NULL, 0);
            }
        }
    } else if (strcmp(method, "LOCK") == 0) {
        const char *xml =
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
            "<D:prop xmlns:D=\"DAV:\"><D:lockdiscovery><D:activelock>"
            "<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>"
            "<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>"
            "<D:locktoken><D:href>opaquelocktoken:s3dfs-fuse</D:href></D:locktoken>"
            "</D:activelock></D:lockdiscovery></D:prop>";
        respond(fd, 200, "OK", "Lock-Token: <opaquelocktoken:s3dfs-fuse>\r\nContent-Type: application/xml\r\n", xml,
                strlen(xml));
    } else if (strcmp(method, "UNLOCK") == 0) {
        respond(fd, 204, "No Content", NULL, NULL, 0);
    } else if (strcmp(method, "PROPPATCH") == 0) {
        const char *xml = "<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\"></D:multistatus>";
        respond(fd, 207, "Multi-Status", "Content-Type: application/xml\r\n", xml, strlen(xml));
    } else {
        respond(fd, 405, "Method Not Allowed", NULL, NULL, 0);
    }
    free(head);
    close(fd);
}

typedef struct {
    object_fs *fs;
    int fd;
} conn_arg;

static void *conn_thread(void *arg) {
    conn_arg *a = arg;
    handle_one(a->fs, a->fd);
    free(a);
    return NULL;
}

static int listen_on(const char *listen_addr, int *port_out) {
    char host[128] = "127.0.0.1";
    int port = 0;
    const char *colon = strrchr(listen_addr, ':');
    if (colon) {
        size_t n = (size_t)(colon - listen_addr);
        if (n >= sizeof(host)) {
            n = sizeof(host) - 1;
        }
        memcpy(host, listen_addr, n);
        host[n] = '\0';
        port = atoi(colon + 1);
    }
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        close(fd);
        return -1;
    }
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(fd, 64) != 0) {
        close(fd);
        return -1;
    }
    socklen_t alen = sizeof(addr);
    getsockname(fd, (struct sockaddr *)&addr, &alen);
    *port_out = ntohs(addr.sin_port);
    return fd;
}

int webdav_serve(object_fs *fs, const char *mountpoint, const char *listen) {
    int port = 0;
    int lfd = listen_on(listen ? listen : "127.0.0.1:0", &port);
    if (lfd < 0) {
        fprintf(stderr, "s3dfs-fuse: listen %s failed\n", listen ? listen : "127.0.0.1:0");
        return 1;
    }
    fprintf(stderr, "s3dfs-fuse: FUSE is not available on this machine; mounting via local WebDAV at http://127.0.0.1:%d/\n",
            port);
#ifdef __APPLE__
    pid_t pid = fork();
    if (pid < 0) {
        close(lfd);
        return 1;
    }
    if (pid == 0) {
        char url[128];
        snprintf(url, sizeof(url), "http://127.0.0.1:%d/", port);
        execlp("mount_webdav", "mount_webdav", url, mountpoint, (char *)NULL);
        _exit(127);
    }
    int status = 0;
    waitpid(pid, &status, 0);
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "s3dfs-fuse: mount_webdav failed\n");
        close(lfd);
        return 1;
    }
#else
    fprintf(stderr, "s3dfs-fuse: no FUSE device; point a WebDAV client at http://127.0.0.1:%d/\n", port);
    (void)mountpoint;
#endif
    fprintf(stderr, "s3dfs-fuse: mounted %s at %s (press Ctrl-C to unmount)\n", fs_client(fs)->bucket, mountpoint);
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_signal;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    while (!webdav_stop) {
        int cfd = accept(lfd, NULL, NULL);
        if (cfd < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        conn_arg *arg = xmalloc(sizeof(*arg));
        arg->fs = fs;
        arg->fd = cfd;
        pthread_t th;
        pthread_create(&th, NULL, conn_thread, arg);
        pthread_detach(th);
    }
#ifdef __APPLE__
    pid_t u = fork();
    if (u == 0) {
        execlp("umount", "umount", mountpoint, (char *)NULL);
        _exit(1);
    }
    if (u > 0) {
        waitpid(u, NULL, 0);
    }
#endif
    close(lfd);
    return 0;
}
