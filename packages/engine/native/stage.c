#define _GNU_SOURCE

#include "stage.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#include <CommonCrypto/CommonHMAC.h>
#else
#include <openssl/evp.h>
#include <openssl/hmac.h>
#endif
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define STAGE_NET_MAX 32
#define STAGE_CONN_MAX 512
#define STAGE_HDR_MAX (64 * 1024)

typedef struct reply {
    int fd;
    int status;
    int keep;
    char etag[16];
    struct reply *next;
} reply;

typedef struct conn {
    int fd;
    uint8_t *buf;
    size_t len;
    size_t cap;
    int live;
} conn;

typedef struct net {
    int index;
    int wake_r;
    int wake_w;
    pthread_t thread;
    pthread_mutex_t mu;
    reply *replies;
    int newfds[STAGE_CONN_MAX];
    int nnew;
    conn *conns[STAGE_CONN_MAX];
    int nconns;
} net;

typedef struct blk_job {
    stage_job job;
    struct blk_job *next;
} blk_job;

static s3dfs_store *g_store;
static stage_indexed_fn g_indexed;
static int g_backend = 0;
static char g_access[128];
static char g_secret[256];
static net g_nets[STAGE_NET_MAX];
static int g_nnets;
static int g_listen = -1;
static int g_stop = 0;
static pthread_t g_accept;
static pthread_mutex_t g_blk_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_blk_cv = PTHREAD_COND_INITIALIZER;
static blk_job *g_blk_head;
static blk_job *g_blk_tail;
static pthread_t *g_blk_threads;
static int g_nblk;
static pthread_mutex_t g_id_mu = PTHREAD_MUTEX_INITIALIZER;
static blk_job *g_inflight;
static uint64_t g_next_id = 1;
static uint32_t g_crc_table[256];
static int g_crc_ready = 0;

static void crc_init(void)
{
    uint32_t i;
    uint32_t b;
    if (g_crc_ready) {
        return;
    }
    for (i = 0; i < 256; i++) {
        uint32_t c = i;
        for (b = 0; b < 8; b++) {
            c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        g_crc_table[i] = c;
    }
    g_crc_ready = 1;
}

static int header_end(const uint8_t *buf, size_t len);

static uint32_t crc32_of(const uint8_t *data, uint32_t len)
{
    uint32_t crc = 0xFFFFFFFFu;
    uint32_t i;
    crc_init();
    for (i = 0; i < len; i++) {
        crc = g_crc_table[(crc ^ data[i]) & 0xFFu] ^ (crc >> 8);
    }
    return crc ^ 0xFFFFFFFFu;
}

static int set_nonblock(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) {
        return -1;
    }
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void sha256_hex(const void *data, size_t len, char out[65])
{
    unsigned char raw[32];
    unsigned int i;
#if defined(__APPLE__)
    CC_SHA256(data, (CC_LONG)len, raw);
#else
    EVP_Digest(data, len, raw, NULL, EVP_sha256(), NULL);
#endif
    for (i = 0; i < 32; i++) {
        sprintf(out + (i * 2), "%02x", raw[i]);
    }
    out[64] = 0;
}

static void hmac_sha256(const void *key, size_t key_len, const void *data, size_t data_len, unsigned char out[32])
{
#if defined(__APPLE__)
    CCHmac(kCCHmacAlgSHA256, key, key_len, data, data_len, out);
#else
    unsigned int len = 32;
    HMAC(EVP_sha256(), key, (int)key_len, (const unsigned char *)data, data_len, out, &len);
#endif
}

static int hex_eq(const char *a, const char *b)
{
    size_t i;
    size_t n = strlen(a);
    if (n != strlen(b)) {
        return 0;
    }
    for (i = 0; i < n; i++) {
        char ca = a[i];
        char cb = b[i];
        if (ca >= 'A' && ca <= 'F') {
            ca = (char)(ca - 'A' + 'a');
        }
        if (cb >= 'A' && cb <= 'F') {
            cb = (char)(cb - 'A' + 'a');
        }
        if (ca != cb) {
            return 0;
        }
    }
    return 1;
}

static int header_copy(const char *headers, const char *name, char *out, size_t cap)
{
    size_t nlen = strlen(name);
    const char *p = headers;
    if (!out || cap == 0) {
        return 0;
    }
    out[0] = 0;
    while (*p) {
        const char *end = strstr(p, "\r\n");
        size_t len = end ? (size_t)(end - p) : strlen(p);
        if (len > nlen + 1 && strncasecmp(p, name, nlen) == 0 && p[nlen] == ':') {
            const char *v = p + nlen + 1;
            size_t vlen = len - (nlen + 1);
            while (vlen && (*v == ' ' || *v == '\t')) {
                v++;
                vlen--;
            }
            if (vlen >= cap) {
                vlen = cap - 1;
            }
            memcpy(out, v, vlen);
            out[vlen] = 0;
            return 1;
        }
        if (!end) {
            break;
        }
        p = end + 2;
    }
    return 0;
}

static int sig_ok(const char *method, const char *path, const char *headers, const uint8_t *body, uint32_t body_len)
{
    char auth[1024];
    char amz[64];
    if (!header_copy(headers, "authorization", auth, sizeof(auth)) || !header_copy(headers, "x-amz-date", amz, sizeof(amz))) {
        return 0;
    }
    const char *cred;
    const char *sig;
    const char *signed_names;
    char credential[256];
    char signature[128];
    char signed_hdrs[256];
    char canonical[4096];
    char canonical_hex[65];
    char string_to_sign[512];
    char expect[65];
    unsigned char k[32];
    unsigned char raw[32];
    char aws4[300];
    const char *access;
    const char *date;
    const char *region;
    const char *service;
    char *parts[5];
    int nparts = 0;
    char cred_copy[256];
    char *save = NULL;
    char *tok;
    const char *sp;
    char header_block[2048];
    size_t hlen = 0;
    unsigned int i;
    if (strncmp(auth, "AWS4-HMAC-SHA256 ", 17) != 0) {
        return 0;
    }
    cred = strstr(auth, "Credential=");
    sig = strstr(auth, "Signature=");
    signed_names = strstr(auth, "SignedHeaders=");
    if (!cred || !sig || !signed_names) {
        return 0;
    }
    cred += 11;
    sig += 10;
    signed_names += 14;
    nparts = 0;
    while (cred[nparts] && cred[nparts] != ',' && cred[nparts] != ' ' && nparts < (int)sizeof(credential) - 1) {
        credential[nparts] = cred[nparts];
        nparts++;
    }
    credential[nparts] = 0;
    nparts = 0;
    while (sig[nparts] && sig[nparts] != ',' && sig[nparts] != ' ' && nparts < (int)sizeof(signature) - 1) {
        signature[nparts] = sig[nparts];
        nparts++;
    }
    signature[nparts] = 0;
    nparts = 0;
    while (signed_names[nparts] && signed_names[nparts] != ',' && signed_names[nparts] != ' ' && nparts < (int)sizeof(signed_hdrs) - 1) {
        signed_hdrs[nparts] = signed_names[nparts];
        nparts++;
    }
    signed_hdrs[nparts] = 0;
    snprintf(cred_copy, sizeof(cred_copy), "%s", credential);
    nparts = 0;
    tok = strtok_r(cred_copy, "/", &save);
    while (tok && nparts < 5) {
        parts[nparts++] = tok;
        tok = strtok_r(NULL, "/", &save);
    }
    if (nparts != 5 || strcmp(parts[4], "aws4_request") != 0 || strcmp(parts[3], "s3") != 0) {
        return 0;
    }
    access = parts[0];
    date = parts[1];
    region = parts[2];
    service = parts[3];
    if (strcmp(access, g_access) != 0 || strncmp(amz, date, 8) != 0) {
        return 0;
    }
    sp = signed_hdrs;
    while (*sp) {
        char name[64];
        const char *comma = strchr(sp, ';');
        size_t nlen = comma ? (size_t)(comma - sp) : strlen(sp);
        char hv[512];
        if (nlen >= sizeof(name)) {
            return 0;
        }
        memcpy(name, sp, nlen);
        name[nlen] = 0;
        if (!header_copy(headers, name, hv, sizeof(hv))) {
            return 0;
        }
        if (hlen + nlen + strlen(hv) + 3 >= sizeof(header_block)) {
            return 0;
        }
        memcpy(header_block + hlen, name, nlen);
        hlen += nlen;
        header_block[hlen++] = ':';
        memcpy(header_block + hlen, hv, strlen(hv));
        hlen += strlen(hv);
        header_block[hlen++] = '\n';
        header_block[hlen] = 0;
        if (!comma) {
            break;
        }
        sp = comma + 1;
    }
    {
        char payload[80];
        if (!header_copy(headers, "x-amz-content-sha256", payload, sizeof(payload))) {
            sha256_hex(body, body_len, payload);
        }
        snprintf(canonical, sizeof(canonical), "%s\n%s\n\n%s\n%s\n%s", method, path, header_block, signed_hdrs, payload);
    }
    sha256_hex(canonical, strlen(canonical), canonical_hex);
    snprintf(string_to_sign, sizeof(string_to_sign), "AWS4-HMAC-SHA256\n%s\n%s/%s/%s/aws4_request\n%s", amz, date, region, service, canonical_hex);
    snprintf(aws4, sizeof(aws4), "AWS4%s", g_secret);
    hmac_sha256(aws4, strlen(aws4), date, strlen(date), k);
    hmac_sha256(k, 32, region, strlen(region), raw);
    memcpy(k, raw, 32);
    hmac_sha256(k, 32, service, strlen(service), raw);
    memcpy(k, raw, 32);
    hmac_sha256(k, 32, "aws4_request", 12, raw);
    memcpy(k, raw, 32);
    hmac_sha256(k, 32, string_to_sign, strlen(string_to_sign), raw);
    for (i = 0; i < 32; i++) {
        sprintf(expect + (i * 2), "%02x", raw[i]);
    }
    expect[64] = 0;
    return hex_eq(expect, signature);
}

static int write_all(int fd, const void *data, size_t len)
{
    const char *p = (const char *)data;
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, p + off, len - off);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                struct pollfd pfd;
                pfd.fd = fd;
                pfd.events = POLLOUT;
                pfd.revents = 0;
                if (poll(&pfd, 1, 1000) <= 0) {
                    return -1;
                }
                continue;
            }
            return -1;
        }
        off += (size_t)n;
    }
    return 0;
}

static int send_simple(int fd, int status, const char *etag, int keep)
{
    char msg[256];
    const char *text = status == 200 ? "OK" : status == 403 ? "Forbidden" : "Error";
    int n;
    if (status == 200 && etag && etag[0]) {
        n = snprintf(msg, sizeof(msg),
                     "HTTP/1.1 200 OK\r\nETag: \"%s\"\r\nx-s3dfs-etag-algorithm: crc32\r\nContent-Length: 0\r\nConnection: %s\r\n\r\n",
                     etag, keep ? "keep-alive" : "close");
    } else {
        n = snprintf(msg, sizeof(msg), "HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status, text);
        keep = 0;
    }
    if (n < 0 || write_all(fd, msg, (size_t)n) != 0) {
        return -1;
    }
    return keep ? 0 : -1;
}

static int proxy_backend(int client, const uint8_t *raw, size_t raw_len)
{
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr;
    uint8_t buf[8192];
    size_t got = 0;
    size_t cap = sizeof(buf);
    uint8_t *msg = (uint8_t *)malloc(cap);
    int hend = -1;
    long content_length = 0;
    size_t total;
    struct timeval tv;
    if (fd < 0 || !msg) {
        free(msg);
        if (fd >= 0) {
            close(fd);
        }
        return -1;
    }
    tv.tv_sec = 5;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)g_backend);
    addr.sin_addr.s_addr = htonl(0x7F000001);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || write_all(fd, raw, raw_len) != 0) {
        free(msg);
        close(fd);
        return -1;
    }
    const time_t deadline = time(NULL) + 600;
    while (hend < 0) {
        ssize_t n;
        if (got + 1024 > cap) {
            cap *= 2;
            uint8_t *grown = (uint8_t *)realloc(msg, cap);
            if (!grown) {
                free(msg);
                close(fd);
                return -1;
            }
            msg = grown;
        }
        n = read(fd, msg + got, cap - got);
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ETIMEDOUT)) {
            if (time(NULL) > deadline) {
                free(msg);
                close(fd);
                return -1;
            }
            continue;
        }
        if (n <= 0) {
            free(msg);
            close(fd);
            return -1;
        }
        got += (size_t)n;
        hend = header_end(msg, got);
    }
    {
        char *headers = (char *)malloc((size_t)hend + 1);
        char clbuf[32];
        if (!headers) {
            free(msg);
            close(fd);
            return -1;
        }
        memcpy(headers, msg, (size_t)hend);
        headers[hend] = 0;
        if (header_copy(headers, "content-length", clbuf, sizeof(clbuf))) {
            content_length = strtol(clbuf, NULL, 10);
        }
        free(headers);
    }
    total = (size_t)hend + (content_length > 0 ? (size_t)content_length : 0);
    while (got < total) {
        ssize_t n;
        if (got + 1024 > cap) {
            cap *= 2;
            uint8_t *grown = (uint8_t *)realloc(msg, cap);
            if (!grown) {
                free(msg);
                close(fd);
                return -1;
            }
            msg = grown;
        }
        n = read(fd, msg + got, cap - got);
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ETIMEDOUT)) {
            if (time(NULL) > deadline) {
                break;
            }
            continue;
        }
        if (n <= 0) {
            break;
        }
        got += (size_t)n;
    }
    close(fd);
    if (write_all(client, msg, got) != 0) {
        free(msg);
        return -1;
    }
    free(msg);
    return 0;
}

static void wake_net(net *n)
{
    char b = 1;
    if (write(n->wake_w, &b, 1) < 0) {
        /* The pipe is full. The thread will still observe the queued reply. */
    }
}

static void enqueue_reply(net *n, int fd, int status, const char *etag, int keep)
{
    reply *r = (reply *)calloc(1, sizeof(*r));
    if (!r) {
        close(fd);
        return;
    }
    r->fd = fd;
    r->status = status;
    r->keep = keep;
    if (etag) {
        snprintf(r->etag, sizeof(r->etag), "%s", etag);
    }
    pthread_mutex_lock(&n->mu);
    r->next = n->replies;
    n->replies = r;
    pthread_mutex_unlock(&n->mu);
    wake_net(n);
}

static blk_job *take_id(uint64_t id)
{
    blk_job **prev = &g_inflight;
    pthread_mutex_lock(&g_id_mu);
    while (*prev) {
        if ((*prev)->job.id == id) {
            blk_job *found = *prev;
            *prev = found->next;
            pthread_mutex_unlock(&g_id_mu);
            return found;
        }
        prev = &(*prev)->next;
    }
    pthread_mutex_unlock(&g_id_mu);
    return NULL;
}

int stage_reply(uint64_t id, int status)
{
    blk_job *job = take_id(id);
    char etag[16];
    int fd;
    int net_index;
    int keep;
    if (!job) {
        return -1;
    }
    fd = job->job.fd;
    net_index = job->job.net_index;
    keep = job->job.keep;
    etag[0] = 0;
    if (status == 200) {
        snprintf(etag, sizeof(etag), "%08x", job->job.crc);
    }
    free(job->job.object_key);
    free(job->job.body);
    free(job);
    if (net_index < 0 || net_index >= g_nnets) {
        close(fd);
        return -1;
    }
    enqueue_reply(&g_nets[net_index], fd, status, etag, status == 200 ? keep : 0);
    return 0;
}

static void hold_job(blk_job *job)
{
    pthread_mutex_lock(&g_id_mu);
    job->next = g_inflight;
    g_inflight = job;
    pthread_mutex_unlock(&g_id_mu);
}

static void *blk_loop(void *arg)
{
    (void)arg;
#if defined(__APPLE__)
    pthread_setname_np("s3dfs-blk");
#else
    pthread_setname_np(pthread_self(), "s3dfs-blk");
#endif
    for (;;) {
        blk_job *job;
        s3dfs_put_meta meta;
        pthread_mutex_lock(&g_blk_mu);
        while (!g_stop && !g_blk_head) {
            pthread_cond_wait(&g_blk_cv, &g_blk_mu);
        }
        if (g_stop && !g_blk_head) {
            pthread_mutex_unlock(&g_blk_mu);
            return NULL;
        }
        job = g_blk_head;
        g_blk_head = job->next;
        if (!g_blk_head) {
            g_blk_tail = NULL;
        }
        job->next = NULL;
        pthread_mutex_unlock(&g_blk_mu);
        memset(&meta, 0, sizeof(meta));
        meta.has_meta = 1;
        meta.orig_size = job->job.body_len;
        meta.orig_crc = job->job.crc;
        job->job.rc = s3dfs_put(g_store, job->job.object_key, (uint32_t)strlen(job->job.object_key), job->job.body, job->job.body_len, &meta,
                                &job->job.loc);
        if (job->job.rc != S3DFS_OK) {
            enqueue_reply(&g_nets[job->job.net_index], job->job.fd, 500, NULL, 0);
            free(job->job.object_key);
            free(job->job.body);
            free(job);
            continue;
        }
        hold_job(job);
        if (g_indexed) {
            g_indexed(&job->job);
        }
    }
}

static void submit_blk(blk_job *job)
{
    pthread_mutex_lock(&g_blk_mu);
    job->next = NULL;
    if (g_blk_tail) {
        g_blk_tail->next = job;
    } else {
        g_blk_head = job;
    }
    g_blk_tail = job;
    pthread_cond_signal(&g_blk_cv);
    pthread_mutex_unlock(&g_blk_mu);
}

static int header_end(const uint8_t *buf, size_t len)
{
    size_t i;
    for (i = 0; i + 3 < len; i++) {
        if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') {
            return (int)(i + 4);
        }
    }
    return -1;
}

static int object_put_path(const char *path, char *out, size_t cap)
{
    const char *p = path;
    const char *slash;
    if (path[0] != '/') {
        return 0;
    }
    if (strchr(path, '?')) {
        return 0;
    }
    p++;
    slash = strchr(p, '/');
    if (!slash || slash[1] == 0) {
        return 0;
    }
    if (strlen(p) >= cap) {
        return 0;
    }
    memcpy(out, p, strlen(p) + 1);
    return 1;
}

static void handle_request(net *n, conn *c, size_t hend, long content_length)
{
    char *headers = (char *)malloc((size_t)hend + 1);
    char *parse;
    char *save = NULL;
    char *line;
    char *method;
    char *url;
    char *version;
    const uint8_t *raw = c->buf;
    size_t raw_len = hend + (content_length > 0 ? (size_t)content_length : 0);
    const uint8_t *body = c->buf + hend;
    char object_key[1024];
    int keep = 1;
    if (!headers) {
        c->live = 0;
        return;
    }
    memcpy(headers, c->buf, hend);
    headers[hend] = 0;
    parse = strdup(headers);
    if (!parse) {
        free(headers);
        c->live = 0;
        return;
    }
    line = strtok_r(parse, "\n", &save);
    if (!line) {
        free(parse);
        free(headers);
        c->live = 0;
        return;
    }
    if (line[strlen(line) - 1] == '\r') {
        line[strlen(line) - 1] = 0;
    }
    method = strtok_r(line, " ", &version);
    url = method ? strtok_r(NULL, " ", &version) : NULL;
    if (!method || !url || !version) {
        free(parse);
        free(headers);
        c->live = 0;
        return;
    }
    if (strstr(headers, "Connection: close") || strstr(headers, "connection: close")) {
        keep = 0;
    }
    if (strcmp(method, "PUT") == 0 && object_put_path(url, object_key, sizeof(object_key))) {
        blk_job *job;
        if (!sig_ok(method, url, headers, body, (uint32_t)content_length)) {
            free(parse);
            free(headers);
            send_simple(c->fd, 403, NULL, 0);
            c->live = 0;
            return;
        }
        job = (blk_job *)calloc(1, sizeof(*job));
        if (!job) {
            free(parse);
            free(headers);
            c->live = 0;
            return;
        }
        pthread_mutex_lock(&g_id_mu);
        job->job.id = g_next_id++;
        pthread_mutex_unlock(&g_id_mu);
        job->job.fd = c->fd;
        job->job.net_index = n->index;
        job->job.keep = keep;
        job->job.object_key = strdup(object_key);
        job->job.body_len = (uint32_t)content_length;
        job->job.body = (uint8_t *)malloc(job->job.body_len ? job->job.body_len : 1);
        if (!job->job.object_key || !job->job.body) {
            free(job->job.object_key);
            free(job->job.body);
            free(job);
            free(parse);
            free(headers);
            c->live = 0;
            return;
        }
        if (job->job.body_len) {
            memcpy(job->job.body, body, job->job.body_len);
        }
        job->job.crc = crc32_of(job->job.body, job->job.body_len);
        c->fd = -1;
        c->live = 0;
        free(parse);
        free(headers);
        submit_blk(job);
        return;
    }
    free(parse);
    free(headers);
    if (proxy_backend(c->fd, raw, raw_len) != 0) {
        send_simple(c->fd, 502, NULL, 0);
        c->live = 0;
        return;
    }
    if (!keep) {
        c->live = 0;
    }
}

static void consume_conn(net *n, conn *c)
{
    for (;;) {
        int hend;
        long content_length = 0;
        char *headers;
        char clbuf[32];
        size_t total;
        if (!c->live || c->fd < 0) {
            return;
        }
        hend = header_end(c->buf, c->len);
        if (hend < 0) {
            if (c->len > STAGE_HDR_MAX) {
                c->live = 0;
            }
            return;
        }
        headers = (char *)malloc((size_t)hend + 1);
        if (!headers) {
            c->live = 0;
            return;
        }
        memcpy(headers, c->buf, (size_t)hend);
        headers[hend] = 0;
        if (header_copy(headers, "content-length", clbuf, sizeof(clbuf))) {
            content_length = strtol(clbuf, NULL, 10);
        }
        free(headers);
        if (content_length < 0) {
            c->live = 0;
            return;
        }
        total = (size_t)hend + (size_t)content_length;
        if (c->len < total) {
            return;
        }
        handle_request(n, c, (size_t)hend, content_length);
        if (c->fd < 0 || !c->live) {
            if (c->len >= total && c->fd >= 0) {
                memmove(c->buf, c->buf + total, c->len - total);
                c->len -= total;
            }
            return;
        }
        memmove(c->buf, c->buf + total, c->len - total);
        c->len -= total;
    }
}

static void add_conn(net *n, int fd)
{
    conn *c;
    int i;
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    if (set_nonblock(fd) != 0) {
        close(fd);
        return;
    }
    c = (conn *)calloc(1, sizeof(*c));
    if (!c) {
        close(fd);
        return;
    }
    c->fd = fd;
    c->live = 1;
    c->cap = 8192;
    c->buf = (uint8_t *)malloc(c->cap);
    if (!c->buf) {
        free(c);
        close(fd);
        return;
    }
    for (i = 0; i < STAGE_CONN_MAX; i++) {
        if (!n->conns[i]) {
            n->conns[i] = c;
            if (i >= n->nconns) {
                n->nconns = i + 1;
            }
            return;
        }
    }
    free(c->buf);
    free(c);
    close(fd);
}

static void drop_conn(net *n, int index)
{
    conn *c = n->conns[index];
    if (!c) {
        return;
    }
    if (c->fd >= 0) {
        close(c->fd);
    }
    free(c->buf);
    free(c);
    n->conns[index] = NULL;
}

static void drain_wake(net *n)
{
    char junk[64];
    while (read(n->wake_r, junk, sizeof(junk)) > 0) {
    }
}

static void drain_replies(net *n)
{
    reply *list;
    pthread_mutex_lock(&n->mu);
    while (n->nnew > 0) {
        n->nnew--;
        add_conn(n, n->newfds[n->nnew]);
    }
    list = n->replies;
    n->replies = NULL;
    pthread_mutex_unlock(&n->mu);
    while (list) {
        reply *next = list->next;
        int keep = send_simple(list->fd, list->status, list->etag, list->keep) == 0;
        if (!keep) {
            close(list->fd);
        } else {
            conn *c = (conn *)calloc(1, sizeof(*c));
            if (!c) {
                close(list->fd);
            } else {
                c->fd = list->fd;
                c->live = 1;
                c->cap = 8192;
                c->buf = (uint8_t *)malloc(c->cap);
                if (!c->buf) {
                    free(c);
                    close(list->fd);
                } else {
                    int i;
                    int placed = 0;
                    for (i = 0; i < STAGE_CONN_MAX; i++) {
                        if (!n->conns[i]) {
                            n->conns[i] = c;
                            if (i >= n->nconns) {
                                n->nconns = i + 1;
                            }
                            placed = 1;
                            break;
                        }
                    }
                    if (!placed) {
                        free(c->buf);
                        free(c);
                        close(list->fd);
                    }
                }
            }
        }
        free(list);
        list = next;
    }
}

static void *net_loop(void *arg)
{
    net *n = (net *)arg;
#if defined(__APPLE__)
    pthread_setname_np("s3dfs-net");
#else
    pthread_setname_np(pthread_self(), "s3dfs-net");
#endif
    for (;;) {
        struct pollfd pfds[STAGE_CONN_MAX + 1];
        int nfds = 1;
        int i;
        int ready;
        pfds[0].fd = n->wake_r;
        pfds[0].events = POLLIN;
        for (i = 0; i < n->nconns; i++) {
            conn *c = n->conns[i];
            if (!c || c->fd < 0 || !c->live) {
                if (c && !c->live) {
                    drop_conn(n, i);
                }
                continue;
            }
            pfds[nfds].fd = c->fd;
            pfds[nfds].events = POLLIN;
            pfds[nfds].revents = 0;
            nfds++;
        }
        ready = poll(pfds, (nfds_t)nfds, 1000);
        if (ready < 0 && errno == EINTR) {
            continue;
        }
        if (pfds[0].revents & POLLIN) {
            drain_wake(n);
            drain_replies(n);
        }
        for (i = 1; i < nfds; i++) {
            int fd;
            int j;
            if (!(pfds[i].revents & (POLLIN | POLLHUP | POLLERR))) {
                continue;
            }
            fd = pfds[i].fd;
            for (j = 0; j < n->nconns; j++) {
                conn *c = n->conns[j];
                ssize_t nread;
                if (!c || c->fd != fd) {
                    continue;
                }
                if (c->len + 4096 > c->cap) {
                    size_t cap = c->cap * 2;
                    uint8_t *grown = (uint8_t *)realloc(c->buf, cap);
                    if (!grown) {
                        c->live = 0;
                        break;
                    }
                    c->buf = grown;
                    c->cap = cap;
                }
                nread = read(fd, c->buf + c->len, c->cap - c->len);
                if (nread < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                    break;
                }
                if (nread <= 0) {
                    c->live = 0;
                    break;
                }
                c->len += (size_t)nread;
                consume_conn(n, c);
                break;
            }
        }
    }
}

static void assign_fd(int fd)
{
    static unsigned cursor = 0;
    net *n = &g_nets[cursor % (unsigned)g_nnets];
    cursor++;
    pthread_mutex_lock(&n->mu);
    if (n->nnew < STAGE_CONN_MAX) {
        n->newfds[n->nnew++] = fd;
        pthread_mutex_unlock(&n->mu);
        wake_net(n);
        return;
    }
    pthread_mutex_unlock(&n->mu);
    close(fd);
}

static void *accept_loop(void *arg)
{
    (void)arg;
    for (;;) {
        struct sockaddr_storage addr;
        socklen_t len = sizeof(addr);
        int fd = accept(g_listen, (struct sockaddr *)&addr, &len);
        if (fd < 0) {
            if (errno == EINTR) {
                continue;
            }
            if (g_stop) {
                return NULL;
            }
            continue;
        }
        assign_fd(fd);
    }
}

int stage_start(s3dfs_store *store, const char *host, int port, int net_threads, int blk_threads, int backend_port,
                const char *access_key, const char *secret, stage_indexed_fn indexed)
{
    struct sockaddr_in addr;
    int one = 1;
    int i;
    int fd;
    if (!store || !access_key || !secret || net_threads < 1 || blk_threads < 1) {
        return -1;
    }
    if (net_threads > STAGE_NET_MAX) {
        net_threads = STAGE_NET_MAX;
    }
    g_store = store;
    g_indexed = indexed;
    g_backend = backend_port;
    snprintf(g_access, sizeof(g_access), "%s", access_key);
    snprintf(g_secret, sizeof(g_secret), "%s", secret);
    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return -1;
    }
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (!host || strcmp(host, "0.0.0.0") == 0) {
        addr.sin_addr.s_addr = htonl(INADDR_ANY);
    } else if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        close(fd);
        return -1;
    }
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(fd, 512) != 0) {
        close(fd);
        return -1;
    }
    g_listen = fd;
    g_nnets = net_threads;
    g_nblk = blk_threads;
    for (i = 0; i < g_nnets; i++) {
        int pipes[2];
        if (pipe(pipes) != 0) {
            return -1;
        }
        set_nonblock(pipes[0]);
        g_nets[i].index = i;
        g_nets[i].wake_r = pipes[0];
        g_nets[i].wake_w = pipes[1];
        pthread_mutex_init(&g_nets[i].mu, NULL);
        pthread_create(&g_nets[i].thread, NULL, net_loop, &g_nets[i]);
    }
    g_blk_threads = (pthread_t *)calloc((size_t)g_nblk, sizeof(pthread_t));
    if (!g_blk_threads) {
        return -1;
    }
    for (i = 0; i < g_nblk; i++) {
        pthread_create(&g_blk_threads[i], NULL, blk_loop, NULL);
    }
    pthread_create(&g_accept, NULL, accept_loop, NULL);
    return 0;
}
