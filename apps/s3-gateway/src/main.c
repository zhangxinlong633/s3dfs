#include "cluster.h"
#include "http.h"
#include "s3.h"

#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

static volatile int g_stop = 0;

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
}

static int env_int(const char *name, int fallback)
{
    const char *v = getenv(name);
    if (!v || !v[0]) {
        return fallback;
    }
    return atoi(v);
}

static int env_workers(void)
{
    int n = env_int("S3DFS_S3_WORKERS", 0);
    if (n > 0) {
        return n;
    }
#ifdef _SC_NPROCESSORS_ONLN
    long cpus = sysconf(_SC_NPROCESSORS_ONLN);
    if (cpus < 1) {
        cpus = 4;
    }
    n = (int)cpus * 2;
#else
    n = 16;
#endif
    if (n < 16) {
        n = 16;
    }
    if (n > 64) {
        n = 64;
    }
    /* 32-in-flight benches need enough workers to avoid queueing. */
    if (n < 32) {
        n = 32;
    }
    return n;
}

typedef struct {
    int listen_fd;
    cluster_t *cluster;
} worker_arg_t;

static void *worker_main(void *arg)
{
    worker_arg_t *wa = arg;
    while (!g_stop) {
        int fd = http_accept(wa->listen_fd);
        if (fd < 0) {
            if (g_stop) {
                break;
            }
            if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) {
                continue;
            }
            /* brief pause on unexpected accept errors */
            struct timespec ts = {0, 5 * 1000 * 1000};
            nanosleep(&ts, NULL);
            continue;
        }
        int keepalive = 1;
        while (keepalive && !g_stop) {
            http_in_t in;
            int got_expect = 0;
            int r = http_read_request(fd, &in, &got_expect);
            if (r <= 0) {
                http_in_free(&in);
                break;
            }
            http_out_t out;
            memset(&out, 0, sizeof(out));
            out.fd = fd;
            out.keepalive = in.keepalive;
            out.is_head = strcmp(in.method, "HEAD") == 0;
            s3_handle(wa->cluster, &in, &out);
            keepalive = in.keepalive && out.keepalive;
            http_in_free(&in);
            if (!out.header_sent) {
                http_reply_str(&out, 500, "text/plain", "internal error");
                keepalive = 0;
            }
        }
        close(fd);
    }
    return NULL;
}

int main(int argc, char **argv)
{
    (void)argc;
    (void)argv;
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, SIG_IGN);

    const char *listen = getenv("S3DFS_S3_LISTEN");
    const char *index_urls = getenv("S3DFS_INDEX_URLS");
    const char *seeds = getenv("S3DFS_BLOCK_NODES");
    int replicas = env_int("S3DFS_DATA_REPLICAS", 1);
    if (replicas < 1) {
        replicas = 1;
    }
    compress_type_t compress = parse_compress_type(getenv("S3DFS_COMPRESS"));
    int health_ms = env_int("S3DFS_HEALTH_INTERVAL_MS", 5000);

    if (!index_urls || !index_urls[0]) {
        log_error("S3DFS_INDEX_URLS is required (e.g. http://127.0.0.1:39100)");
        return 1;
    }

    char host[256];
    int port = 19002;
    if (parse_listen(listen ? listen : "0.0.0.0:19002", host, sizeof(host), &port) != S3DFS_OK) {
        log_error("invalid S3DFS_S3_LISTEN=%s", listen ? listen : "");
        return 1;
    }

    cluster_t cluster;
    if (cluster_init(&cluster, index_urls, seeds, replicas, compress, health_ms) != S3DFS_OK) {
        log_error("failed to init cluster client");
        return 1;
    }

    int lfd = http_listen(host, port, 512);
    if (lfd < 0) {
        log_error("listen %s:%d failed: %s", host, port, strerror(errno));
        cluster_free(&cluster);
        return 1;
    }

    const char *access_key = getenv("S3DFS_ACCESS_KEY");
    const char *secret_key = getenv("S3DFS_SECRET_KEY");
    s3_set_credentials(access_key, secret_key);

    int workers = env_workers();
    log_info("s3dfs C S3 gateway listening on %s:%d  workers=%d  compress=%s  replicas=%d  index=%s  auth=%s", host, port,
             workers, compress_name(compress), replicas, index_urls, (access_key && access_key[0] && secret_key && secret_key[0]) ? "sigv4" : "open");

    worker_arg_t wa = {.listen_fd = lfd, .cluster = &cluster};
    pthread_t *th = calloc((size_t)workers, sizeof(pthread_t));
    if (!th) {
        log_error("oom");
        close(lfd);
        cluster_free(&cluster);
        return 1;
    }
    for (int i = 0; i < workers; i++) {
        if (pthread_create(&th[i], NULL, worker_main, &wa) != 0) {
            log_error("failed to start worker %d", i);
            g_stop = 1;
            break;
        }
    }
    while (!g_stop) {
        struct timespec ts = {0, 200 * 1000 * 1000};
        nanosleep(&ts, NULL);
    }
    /* wake acceptors */
    shutdown(lfd, SHUT_RDWR);
    close(lfd);
    for (int i = 0; i < workers; i++) {
        if (th[i]) {
            pthread_join(th[i], NULL);
        }
    }
    free(th);
    cluster_free(&cluster);
    log_info("stopped");
    return 0;
}
