#include "cluster.h"

#include <ctype.h>

static int parse_address(const char *address, char *host, size_t host_cap, int *port)
{
    const char *s = address;
    if (!strncmp(s, "http://", 7)) {
        s += 7;
    } else if (!strncmp(s, "https://", 8)) {
        s += 8;
    }
    return parse_hostport(s, host, host_cap, port);
}

static int kv_request(cluster_t *c, const char *method, const char *path, const char *extra,
                      const void *body, size_t body_len, int allow_404, http_response_t *out)
{
    int last = S3DFS_ERR_UNAVAILABLE;
    for (int i = 0; i < c->index_count; i++) {
        index_ep_t *ep = &c->index[i];
        int rc = http_request(ep->host, ep->port, method, path, extra, body, body_len, allow_404, out);
        if (rc == S3DFS_OK) {
            return S3DFS_OK;
        }
        http_response_free(out);
        memset(out, 0, sizeof(*out));
        last = rc;
    }
    return last;
}

static int kv_put(cluster_t *c, const char *key, const void *value, size_t len)
{
    buf_t enc = {0};
    if (url_encode(key, strlen(key), &enc) != S3DFS_OK) {
        buf_free(&enc);
        return S3DFS_ERR_NOMEM;
    }
    char extra[1024];
    snprintf(extra, sizeof(extra),
             "Content-Type: application/octet-stream\r\n"
             "x-dleveldb-key: %s\r\n",
             enc.data);
    buf_free(&enc);
    http_response_t r = {0};
    int rc = kv_request(c, "POST", "/_dleveldb/kv/put", extra, value, len, 0, &r);
    http_response_free(&r);
    return rc;
}

static int kv_get(cluster_t *c, const char *key, http_response_t *out)
{
    buf_t enc = {0};
    if (url_encode(key, strlen(key), &enc) != S3DFS_OK) {
        buf_free(&enc);
        return S3DFS_ERR_NOMEM;
    }
    char path[2048];
    snprintf(path, sizeof(path), "/_dleveldb/kv/get?key=%s", enc.data);
    buf_free(&enc);
    int rc = kv_request(c, "GET", path, NULL, NULL, 0, 1, out);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (out->status == 404) {
        return S3DFS_ERR_NOT_FOUND;
    }
    return S3DFS_OK;
}

static int kv_head(cluster_t *c, const char *key)
{
    buf_t enc = {0};
    if (url_encode(key, strlen(key), &enc) != S3DFS_OK) {
        buf_free(&enc);
        return S3DFS_ERR_NOMEM;
    }
    char path[2048];
    snprintf(path, sizeof(path), "/_dleveldb/kv/head?key=%s", enc.data);
    buf_free(&enc);
    http_response_t r = {0};
    int rc = kv_request(c, "GET", path, NULL, NULL, 0, 1, &r);
    if (rc != S3DFS_OK) {
        http_response_free(&r);
        return rc;
    }
    int found = (r.status == 200);
    http_response_free(&r);
    return found ? S3DFS_OK : S3DFS_ERR_NOT_FOUND;
}

static int kv_delete(cluster_t *c, const char *key, int *deleted)
{
    buf_t body = {0};
    buf_append_str(&body, "{\"key\":");
    json_escape(key, &body);
    buf_append_str(&body, "}");
    http_response_t r = {0};
    int rc = kv_request(c, "POST", "/_dleveldb/kv/delete", "Content-Type: application/json\r\n", body.data, body.len, 0,
                        &r);
    buf_free(&body);
    if (rc != S3DFS_OK) {
        http_response_free(&r);
        return rc;
    }
    int d = json_get_bool_or(r.body, r.body_len, "deleted", 0);
    if (deleted) {
        *deleted = d;
    }
    http_response_free(&r);
    return S3DFS_OK;
}

typedef struct {
    char key[1024];
    uint64_t size;
    uint32_t crc;
    uint64_t mtime_ms;
} kv_entry_t;

typedef struct {
    kv_entry_t *items;
    size_t count;
    size_t cap;
    int truncated;
} kv_scan_t;

static int scan_cb(const char *obj, size_t len, void *ud)
{
    kv_scan_t *s = ud;
    if (s->count >= s->cap) {
        size_t ncap = s->cap ? s->cap * 2 : 32;
        kv_entry_t *n = realloc(s->items, ncap * sizeof(*n));
        if (!n) {
            return -1;
        }
        s->items = n;
        s->cap = ncap;
    }
    kv_entry_t *e = &s->items[s->count];
    memset(e, 0, sizeof(*e));
    if (json_get_string(obj, len, "key", e->key, sizeof(e->key)) != S3DFS_OK) {
        return 0;
    }
    json_get_u64(obj, len, "size", &e->size);
    json_get_u32(obj, len, "crc", &e->crc);
    json_get_u64(obj, len, "mtimeMs", &e->mtime_ms);
    s->count++;
    return 0;
}

static int kv_scan(cluster_t *c, const char *prefix, const char *start_after, int max_keys, kv_scan_t *out)
{
    memset(out, 0, sizeof(*out));
    buf_t body = {0};
    buf_append_str(&body, "{");
    int first = 1;
    if (prefix) {
        buf_append_str(&body, "\"prefix\":");
        json_escape(prefix, &body);
        first = 0;
    }
    if (start_after && start_after[0]) {
        if (!first) {
            buf_append_str(&body, ",");
        }
        buf_append_str(&body, "\"startAfter\":");
        json_escape(start_after, &body);
        first = 0;
    }
    if (!first) {
        buf_append_str(&body, ",");
    }
    buf_printf(&body, "\"maxKeys\":%d}", max_keys > 0 ? max_keys : 1000);
    http_response_t r = {0};
    int rc = kv_request(c, "POST", "/_dleveldb/kv/scan", "Content-Type: application/json\r\n", body.data, body.len, 0, &r);
    buf_free(&body);
    if (rc != S3DFS_OK) {
        http_response_free(&r);
        return rc;
    }
    out->truncated = json_get_bool_or(r.body, r.body_len, "truncated", 0);
    json_array_objects(r.body, r.body_len, "objects", scan_cb, out);
    http_response_free(&r);
    return S3DFS_OK;
}

static void kv_scan_free(kv_scan_t *s)
{
    free(s->items);
    memset(s, 0, sizeof(*s));
}

static int loc_from_json(const char *json, size_t len, object_locator_t *loc)
{
    memset(loc, 0, sizeof(*loc));
    int64_t v = 0;
    json_get_i64(json, len, "v", &v);
    loc->v = (int)v;
    json_get_i64(json, len, "replica", &v);
    loc->replica = (int)v;
    json_get_i64(json, len, "replicaCount", &v);
    loc->replica_count = (int)v;
    json_get_string(json, len, "nodeId", loc->node_id, sizeof(loc->node_id));
    json_get_string(json, len, "address", loc->address, sizeof(loc->address));
    parse_address(loc->address, loc->host, sizeof(loc->host), &loc->port);
    json_get_u64(json, len, "recId", &loc->rec_id);
    loc->chained = json_get_bool_or(json, len, "chained", 0);
    json_get_u64(json, len, "generation", &loc->generation);
    json_get_u32(json, len, "extentCount", &loc->extent_count);
    json_get_u64(json, len, "size", &loc->size);
    if (json_get_u64(json, len, "storedSize", &loc->stored_size) != S3DFS_OK) {
        loc->stored_size = loc->size;
    }
    char ctype[16] = "none";
    json_get_string(json, len, "compressType", ctype, sizeof(ctype));
    loc->compress_type = parse_compress_type(ctype);
    json_get_u32(json, len, "crc", &loc->crc);
    json_get_u64(json, len, "mtimeMs", &loc->mtime_ms);
    return loc->rec_id ? S3DFS_OK : S3DFS_ERR;
}

static int loc_to_json(const object_locator_t *loc, buf_t *out)
{
    buf_clear(out);
    buf_append_str(out, "{\"v\":3,\"replica\":");
    buf_printf(out, "%d,\"replicaCount\":%d,\"nodeId\":", loc->replica, loc->replica_count);
    json_escape(loc->node_id, out);
    buf_append_str(out, ",\"address\":");
    json_escape(loc->address, out);
    buf_printf(out,
               ",\"recId\":%" PRIu64 ",\"chained\":%s,\"generation\":%" PRIu64 ",\"extentCount\":%" PRIu32
               ",\"size\":%" PRIu64 ",\"storedSize\":%" PRIu64 ",\"compressType\":\"%s\",\"crc\":%" PRIu32
               ",\"mtimeMs\":%" PRIu64 "}",
               loc->rec_id, loc->chained ? "true" : "false", loc->generation, loc->extent_count, loc->size,
               loc->stored_size, compress_name(loc->compress_type), loc->crc, loc->mtime_ms);
    return S3DFS_OK;
}

static int extent_to_json(const object_locator_t *loc, buf_t *out)
{
    uint64_t stored = loc->stored_size ? loc->stored_size : loc->size;
    buf_clear(out);
    buf_printf(out,
               "{\"chained\":%s,\"crc\":%" PRIu32 ",\"mtimeMs\":%" PRIu64 ",\"size\":%" PRIu64
               ",\"generation\":%" PRIu64 ",\"extentCount\":%" PRIu32 ",\"recId\":%" PRIu64 "}",
               loc->chained ? "true" : "false", loc->crc, loc->mtime_ms, stored, loc->generation,
               loc->extent_count ? loc->extent_count : 1, loc->rec_id);
    return S3DFS_OK;
}

static int block_put(const char *host, int port, const char *key, const void *value, size_t len,
                     compress_type_t ctype, uint64_t orig_size, uint32_t orig_crc, object_locator_t *ev)
{
    buf_t enc = {0}, meta = {0}, extra = {0};
    if (url_encode(key, strlen(key), &enc) != S3DFS_OK) {
        buf_free(&enc);
        return S3DFS_ERR_NOMEM;
    }
    buf_printf(&meta, "{\"compressType\":\"%s\",\"origSize\":%" PRIu64 ",\"origCrc\":%" PRIu32 "}", compress_name(ctype),
               orig_size, orig_crc);
    buf_t meta_enc = {0};
    url_encode(meta.data, meta.len, &meta_enc);
    buf_printf(&extra,
               "Content-Type: application/octet-stream\r\n"
               "x-s3dfs-key: %s\r\n"
               "x-s3dfs-meta: %s\r\n",
               enc.data, meta_enc.data);
    buf_free(&enc);
    buf_free(&meta);
    buf_free(&meta_enc);
    http_response_t r = {0};
    int rc = http_request(host, port, "POST", "/_s3dfs/block/put", extra.data, value, len, 0, &r);
    buf_free(&extra);
    if (rc != S3DFS_OK) {
        http_response_free(&r);
        return rc;
    }
    memset(ev, 0, sizeof(*ev));
    ev->chained = json_get_bool_or(r.body, r.body_len, "chained", 0);
    json_get_u32(r.body, r.body_len, "crc", &ev->crc);
    json_get_u64(r.body, r.body_len, "mtimeMs", &ev->mtime_ms);
    json_get_u64(r.body, r.body_len, "size", &ev->stored_size);
    json_get_u64(r.body, r.body_len, "generation", &ev->generation);
    json_get_u32(r.body, r.body_len, "extentCount", &ev->extent_count);
    json_get_u64(r.body, r.body_len, "recId", &ev->rec_id);
    http_response_free(&r);
    return ev->rec_id ? S3DFS_OK : S3DFS_ERR;
}

static int block_get(const char *host, int port, const char *key, const object_locator_t *loc, http_response_t *out)
{
    buf_t enc = {0}, ext = {0}, ext_enc = {0}, extra = {0};
    url_encode(key, strlen(key), &enc);
    extent_to_json(loc, &ext);
    url_encode(ext.data, ext.len, &ext_enc);
    buf_printf(&extra, "x-s3dfs-key: %s\r\n" "x-s3dfs-locator: %s\r\n", enc.data, ext_enc.data);
    char path[2048];
    snprintf(path, sizeof(path), "/_s3dfs/block/get?key=%s", enc.data);
    int rc = http_request(host, port, "GET", path, extra.data, NULL, 0, 1, out);
    buf_free(&enc);
    buf_free(&ext);
    buf_free(&ext_enc);
    buf_free(&extra);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (out->status == 404) {
        return S3DFS_ERR_NOT_FOUND;
    }
    return S3DFS_OK;
}

static int block_tombstone(const char *host, int port, const char *key)
{
    buf_t enc = {0}, body = {0};
    url_encode(key, strlen(key), &enc);
    buf_append_str(&body, "{\"key\":");
    json_escape(key, &body);
    buf_append_str(&body, "}");
    char extra[1024];
    snprintf(extra, sizeof(extra), "Content-Type: application/json\r\n" "x-s3dfs-key: %s\r\n", enc.data);
    http_response_t r = {0};
    int rc = http_request(host, port, "POST", "/_s3dfs/block/delete", extra, body.data, body.len, 1, &r);
    buf_free(&enc);
    buf_free(&body);
    if (rc == S3DFS_OK && (r.status == 200 || r.status == 404)) {
        http_response_free(&r);
        return S3DFS_OK;
    }
    http_response_free(&r);
    return rc == S3DFS_OK ? S3DFS_ERR : rc;
}

static int block_health(const char *host, int port, block_node_t *info)
{
    http_response_t r = {0};
    int rc = http_request(host, port, "GET", "/health", NULL, NULL, 0, 0, &r);
    if (rc != S3DFS_OK || r.status != 200) {
        http_response_free(&r);
        return S3DFS_ERR;
    }
    json_get_string(r.body, r.body_len, "nodeId", info->node_id, sizeof(info->node_id));
    json_get_string(r.body, r.body_len, "address", info->address, sizeof(info->address));
    snprintf(info->status, sizeof(info->status), "up");
    info->last_seen_ms = now_ms();
    info->last_error[0] = '\0';
    parse_address(info->address, info->host, sizeof(info->host), &info->port);
    http_response_free(&r);
    return S3DFS_OK;
}

static int node_cmp(const void *a, const void *b)
{
    const block_node_t *x = a, *y = b;
    return strcmp(x->node_id, y->node_id);
}

static void sort_nodes(cluster_t *c)
{
    if (c->node_count > 1) {
        qsort(c->nodes, (size_t)c->node_count, sizeof(c->nodes[0]), node_cmp);
    }
}

static block_node_t *find_node(cluster_t *c, const char *node_id)
{
    for (int i = 0; i < c->node_count; i++) {
        if (strcmp(c->nodes[i].node_id, node_id) == 0) {
            return &c->nodes[i];
        }
    }
    return NULL;
}

static int upsert_node(cluster_t *c, const block_node_t *info)
{
    block_node_t *ex = find_node(c, info->node_id);
    if (ex) {
        *ex = *info;
        return S3DFS_OK;
    }
    if (c->node_count >= MAX_BLOCK_NODES) {
        return S3DFS_ERR;
    }
    c->nodes[c->node_count++] = *info;
    sort_nodes(c);
    return S3DFS_OK;
}

static int parse_seeds(cluster_t *c, const char *raw)
{
    if (!raw || !raw[0]) {
        return S3DFS_OK;
    }
    const char *p = raw;
    while (*p) {
        while (*p == ' ' || *p == ',') {
            p++;
        }
        if (!*p) {
            break;
        }
        const char *end = p;
        while (*end && *end != ',') {
            end++;
        }
        char item[512];
        size_t n = (size_t)(end - p);
        if (n >= sizeof(item)) {
            n = sizeof(item) - 1;
        }
        memcpy(item, p, n);
        item[n] = '\0';
        /* trim */
        while (n && (item[n - 1] == ' ' || item[n - 1] == '\t')) {
            item[--n] = '\0';
        }
        block_node_t node;
        memset(&node, 0, sizeof(node));
        snprintf(node.status, sizeof(node.status), "unknown");
        char *eq = strchr(item, '=');
        if (eq) {
            *eq = '\0';
            snprintf(node.node_id, sizeof(node.node_id), "%s", item);
            snprintf(node.address, sizeof(node.address), "%s", eq + 1);
        } else {
            snprintf(node.address, sizeof(node.address), "%s", item);
            const char *colon = strrchr(item, ':');
            const char *host = item;
            char hostbuf[256];
            if (colon && colon != item) {
                size_t hn = (size_t)(colon - item);
                memcpy(hostbuf, item, hn);
                hostbuf[hn] = '\0';
                host = hostbuf;
            }
            size_t o = 0;
            for (const char *s = host; *s && o + 1 < sizeof(node.node_id); s++) {
                if (isalnum((unsigned char)*s) || *s == '.' || *s == '_' || *s == '-') {
                    node.node_id[o++] = *s;
                } else {
                    node.node_id[o++] = '_';
                }
            }
            if (o == 0) {
                snprintf(node.node_id, sizeof(node.node_id), "block%d", c->node_count);
            } else {
                node.node_id[o] = '\0';
            }
        }
        parse_address(node.address, node.host, sizeof(node.host), &node.port);
        upsert_node(c, &node);
        p = end;
    }
    return S3DFS_OK;
}

static int load_from_index(cluster_t *c)
{
    kv_scan_t scan = {0};
    int rc = kv_scan(c, "$node/", NULL, 10000, &scan);
    if (rc != S3DFS_OK) {
        kv_scan_free(&scan);
        return rc;
    }
    for (size_t i = 0; i < scan.count; i++) {
        http_response_t r = {0};
        if (kv_get(c, scan.items[i].key, &r) != S3DFS_OK) {
            http_response_free(&r);
            continue;
        }
        block_node_t node;
        memset(&node, 0, sizeof(node));
        if (json_get_string(r.body, r.body_len, "nodeId", node.node_id, sizeof(node.node_id)) != S3DFS_OK ||
            json_get_string(r.body, r.body_len, "address", node.address, sizeof(node.address)) != S3DFS_OK) {
            http_response_free(&r);
            continue;
        }
        char st[16] = "unknown";
        json_get_string(r.body, r.body_len, "status", st, sizeof(st));
        snprintf(node.status, sizeof(node.status), "%s", st[0] ? st : "unknown");
        json_get_u64(r.body, r.body_len, "lastSeenMs", &node.last_seen_ms);
        json_get_string(r.body, r.body_len, "lastError", node.last_error, sizeof(node.last_error));
        parse_address(node.address, node.host, sizeof(node.host), &node.port);
        pthread_rwlock_wrlock(&c->lock);
        /* keep previous status if index omitted it and we already know the node */
        block_node_t *prev = find_node(c, node.node_id);
        if (prev && (!st[0] || strcmp(st, "unknown") == 0)) {
            snprintf(node.status, sizeof(node.status), "%s", prev->status);
            if (!node.last_seen_ms) {
                node.last_seen_ms = prev->last_seen_ms;
            }
        }
        upsert_node(c, &node);
        pthread_rwlock_unlock(&c->lock);
        http_response_free(&r);
    }
    kv_scan_free(&scan);
    return S3DFS_OK;
}

static int persist_node(cluster_t *c, const block_node_t *n)
{
    char key[256];
    snprintf(key, sizeof(key), "$node/%s", n->node_id);
    buf_t body = {0};
    buf_append_str(&body, "{\"nodeId\":");
    json_escape(n->node_id, &body);
    buf_append_str(&body, ",\"address\":");
    json_escape(n->address, &body);
    buf_printf(&body, ",\"status\":\"%s\",\"lastSeenMs\":%" PRIu64, n->status, n->last_seen_ms);
    if (n->last_error[0]) {
        buf_append_str(&body, ",\"lastError\":");
        json_escape(n->last_error, &body);
    }
    buf_append_str(&body, "}");
    int rc = kv_put(c, key, body.data, body.len);
    buf_free(&body);
    return rc;
}

int cluster_refresh(cluster_t *c)
{
    load_from_index(c);
    block_node_t snapshot[MAX_BLOCK_NODES];
    int n;
    pthread_rwlock_rdlock(&c->lock);
    n = c->node_count;
    memcpy(snapshot, c->nodes, (size_t)n * sizeof(snapshot[0]));
    pthread_rwlock_unlock(&c->lock);

    for (int i = 0; i < n; i++) {
        char host[256];
        int port = 0;
        snprintf(host, sizeof(host), "%s", snapshot[i].host[0] ? snapshot[i].host : snapshot[i].address);
        port = snapshot[i].port;
        if (!port) {
            parse_address(snapshot[i].address, host, sizeof(host), &port);
        }
        block_node_t health;
        memset(&health, 0, sizeof(health));
        if (block_health(host, port, &health) == S3DFS_OK) {
            if (!health.node_id[0]) {
                snprintf(health.node_id, sizeof(health.node_id), "%s", snapshot[i].node_id);
            }
            if (!health.address[0]) {
                snprintf(health.address, sizeof(health.address), "%s", snapshot[i].address);
                parse_address(health.address, health.host, sizeof(health.host), &health.port);
            }
        } else {
            health = snapshot[i];
            snprintf(health.status, sizeof(health.status), "down");
            snprintf(health.last_error, sizeof(health.last_error), "health check failed");
        }
        pthread_rwlock_wrlock(&c->lock);
        /* write against the original nodeId in case health returns a new id */
        block_node_t *slot = find_node(c, snapshot[i].node_id);
        if (slot) {
            /* keep map key as original nodeId if health omitted it */
            if (strcmp(health.node_id, snapshot[i].node_id) != 0 && health.node_id[0]) {
                /* replace in place but also keep lookup by original */
                snprintf(health.node_id, sizeof(health.node_id), "%s", snapshot[i].node_id);
            }
            *slot = health;
        } else {
            upsert_node(c, &health);
        }
        pthread_rwlock_unlock(&c->lock);
        persist_node(c, &health);
    }
    return S3DFS_OK;
}

static void *health_loop(void *arg)
{
    cluster_t *c = arg;
    while (!c->stop) {
        int ms = c->health_interval_ms > 0 ? c->health_interval_ms : 5000;
        /* sleep in small slices so stop is responsive */
        for (int i = 0; i < ms / 100 && !c->stop; i++) {
            struct timespec ts = {0, 100 * 1000 * 1000};
            nanosleep(&ts, NULL);
        }
        if (!c->stop) {
            cluster_refresh(c);
        }
    }
    return NULL;
}

int cluster_init(cluster_t *c, const char *index_urls, const char *block_seeds, int data_replicas,
                 compress_type_t compress, int health_interval_ms)
{
    memset(c, 0, sizeof(*c));
    pthread_rwlock_init(&c->lock, NULL);
    c->data_replicas = data_replicas > 0 ? data_replicas : 1;
    c->compress_type = compress;
    c->health_interval_ms = health_interval_ms;
    if (!index_urls || !index_urls[0]) {
        return S3DFS_ERR_ARGS;
    }
    const char *p = index_urls;
    while (*p && c->index_count < MAX_INDEX_URLS) {
        while (*p == ' ' || *p == ',') {
            p++;
        }
        if (!*p) {
            break;
        }
        const char *end = p;
        while (*end && *end != ',') {
            end++;
        }
        char url[512];
        size_t n = (size_t)(end - p);
        while (n && (p[n - 1] == ' ' || p[n - 1] == '/')) {
            n--;
        }
        if (n >= sizeof(url) || n == 0) {
            p = end;
            continue;
        }
        memcpy(url, p, n);
        url[n] = '\0';
        index_ep_t *ep = &c->index[c->index_count];
        memset(ep, 0, sizeof(*ep));
        if (parse_http_url(url, ep->host, sizeof(ep->host), &ep->port, NULL, 0) != S3DFS_OK) {
            p = end;
            continue;
        }
        snprintf(ep->base, sizeof(ep->base), "http://%s:%d", ep->host, ep->port);
        c->index_count++;
        p = end;
    }
    if (c->index_count == 0) {
        return S3DFS_ERR_ARGS;
    }
    parse_seeds(c, block_seeds);
    cluster_refresh(c);
    if (c->health_interval_ms > 0) {
        c->health_started = 1;
        if (pthread_create(&c->health_thread, NULL, health_loop, c) != 0) {
            c->health_started = 0;
        }
    }
    return S3DFS_OK;
}

void cluster_free(cluster_t *c)
{
    c->stop = 1;
    if (c->health_started) {
        pthread_join(c->health_thread, NULL);
    }
    pthread_rwlock_destroy(&c->lock);
}

void object_key(const char *bucket, const char *key, char *out, size_t cap)
{
    if (key && key[0]) {
        snprintf(out, cap, "%s/%s", bucket, key);
    } else {
        snprintf(out, cap, "%s/", bucket);
    }
}

static int collect_live(cluster_t *c, block_node_t *out, int *n_out)
{
    pthread_rwlock_rdlock(&c->lock);
    int n = 0;
    for (int i = 0; i < c->node_count; i++) {
        if (strcmp(c->nodes[i].status, "up") == 0) {
            out[n++] = c->nodes[i];
        }
    }
    if (n == 0) {
        for (int i = 0; i < c->node_count; i++) {
            if (strcmp(c->nodes[i].status, "unknown") == 0) {
                out[n++] = c->nodes[i];
            }
        }
    }
    pthread_rwlock_unlock(&c->lock);
    if (n > 1) {
        qsort(out, (size_t)n, sizeof(out[0]), node_cmp);
    }
    *n_out = n;
    return n;
}

static int is_down(cluster_t *c, const char *node_id)
{
    int down = 0;
    pthread_rwlock_rdlock(&c->lock);
    block_node_t *n = find_node(c, node_id);
    if (n && strcmp(n->status, "down") == 0) {
        down = 1;
    }
    pthread_rwlock_unlock(&c->lock);
    return down;
}

static int pick_nodes(cluster_t *c, const char *object_key_str, int want, block_node_t *out, int *n_out)
{
    block_node_t live[MAX_BLOCK_NODES];
    int nlive = 0;
    collect_live(c, live, &nlive);
    if (nlive == 0) {
        return S3DFS_ERR_UNAVAILABLE;
    }
    int need = want < 1 ? 1 : want;
    if (need > nlive) {
        need = nlive;
    }
    uint32_t start = sha1_u32be(object_key_str, strlen(object_key_str)) % (uint32_t)nlive;
    int got = 0;
    for (int i = 0; i < nlive && got < need; i++) {
        out[got++] = live[(start + (uint32_t)i) % (uint32_t)nlive];
    }
    *n_out = got;
    return S3DFS_OK;
}

typedef struct {
    block_node_t node;
    const char *key;
    const void *stored;
    size_t stored_len;
    compress_type_t applied;
    uint64_t orig_len;
    uint32_t digest;
    object_locator_t ev;
    int rc;
} put_job_t;

static void *put_job_run(void *arg)
{
    put_job_t *job = (put_job_t *)arg;
    job->rc = block_put(job->node.host, job->node.port, job->key, job->stored, job->stored_len, job->applied,
                        job->orig_len, job->digest, &job->ev);
    return NULL;
}

int cluster_put(cluster_t *c, const char *bucket, const char *key, const void *value, size_t len, uint32_t *crc_out)
{
    char ok[2048];
    object_key(bucket, key, ok, sizeof(ok));
    uint32_t digest = crc32_ieee(value, len);
    if (crc_out) {
        *crc_out = digest;
    }
    void *packed = NULL;
    size_t packed_len = 0;
    compress_type_t applied = COMPRESS_NONE;
    if (compress_value(value, len, c->compress_type, &packed, &packed_len, &applied) != S3DFS_OK) {
        return S3DFS_ERR;
    }
    const void *stored = packed ? packed : value;
    size_t stored_len = packed ? packed_len : len;

    block_node_t targets[MAX_REPLICAS];
    int nt = 0;
    if (pick_nodes(c, ok, c->data_replicas, targets, &nt) != S3DFS_OK) {
        free(packed);
        return S3DFS_ERR_UNAVAILABLE;
    }

    object_locator_t accepted[MAX_REPLICAS];
    int na = 0;
    put_job_t jobs[MAX_REPLICAS];
    pthread_t threads[MAX_REPLICAS];
    int started[MAX_REPLICAS];
    memset(started, 0, sizeof(started));
    for (int i = 0; i < nt; i++) {
        jobs[i].node = targets[i];
        jobs[i].key = ok;
        jobs[i].stored = stored;
        jobs[i].stored_len = stored_len;
        jobs[i].applied = applied;
        jobs[i].orig_len = (uint64_t)len;
        jobs[i].digest = digest;
        jobs[i].rc = S3DFS_ERR;
        if (pthread_create(&threads[i], NULL, put_job_run, &jobs[i]) == 0) {
            started[i] = 1;
        } else {
            jobs[i].rc = block_put(targets[i].host, targets[i].port, ok, stored, stored_len, applied, (uint64_t)len,
                                   digest, &jobs[i].ev);
        }
    }
    for (int i = 0; i < nt; i++) {
        if (started[i]) {
            pthread_join(threads[i], NULL);
        }
        if (jobs[i].rc == S3DFS_OK) {
            object_locator_t ev = jobs[i].ev;
            ev.replica = na;
            ev.replica_count = 0;
            snprintf(ev.node_id, sizeof(ev.node_id), "%s", jobs[i].node.node_id);
            snprintf(ev.address, sizeof(ev.address), "%s", jobs[i].node.address);
            ev.size = (uint64_t)len;
            ev.compress_type = applied;
            ev.crc = digest;
            accepted[na++] = ev;
        }
    }
    free(packed);
    if (na == 0) {
        return S3DFS_ERR_UNAVAILABLE;
    }
    buf_t js = {0};
    for (int i = 0; i < na; i++) {
        accepted[i].replica = i;
        accepted[i].replica_count = na;
        loc_to_json(&accepted[i], &js);
        char lkey[2100];
        locator_key(ok, i, lkey, sizeof(lkey));
        int rc = kv_put(c, lkey, js.data, js.len);
        if (rc != S3DFS_OK) {
            buf_free(&js);
            return rc;
        }
    }
    buf_free(&js);
    return S3DFS_OK;
}

static int load_locators(cluster_t *c, const char *object_key_str, object_locator_t *out, int *n_out)
{
    http_response_t r = {0};
    int rc = kv_get(c, object_key_str, &r);
    if (rc == S3DFS_ERR_NOT_FOUND) {
        http_response_free(&r);
        *n_out = 0;
        return S3DFS_ERR_NOT_FOUND;
    }
    if (rc != S3DFS_OK) {
        http_response_free(&r);
        return rc;
    }
    object_locator_t primary;
    if (loc_from_json(r.body, r.body_len, &primary) != S3DFS_OK) {
        /* bucket marker or other JSON */
        http_response_free(&r);
        *n_out = 0;
        return S3DFS_ERR_NOT_FOUND;
    }
    http_response_free(&r);
    out[0] = primary;
    int count = primary.replica_count > 0 ? primary.replica_count : 1;
    if (count > MAX_REPLICAS) {
        count = MAX_REPLICAS;
    }
    int n = 1;
    for (int i = 1; i < count; i++) {
        char lkey[2100];
        locator_key(object_key_str, i, lkey, sizeof(lkey));
        http_response_t rr = {0};
        if (kv_get(c, lkey, &rr) == S3DFS_OK) {
            if (loc_from_json(rr.body, rr.body_len, &out[n]) == S3DFS_OK) {
                n++;
            }
        }
        http_response_free(&rr);
    }
    /* prefer non-down, then replica index */
    for (int i = 0; i < n; i++) {
        for (int j = i + 1; j < n; j++) {
            int ad = is_down(c, out[i].node_id);
            int bd = is_down(c, out[j].node_id);
            if (bd < ad || (bd == ad && out[j].replica < out[i].replica)) {
                object_locator_t tmp = out[i];
                out[i] = out[j];
                out[j] = tmp;
            }
        }
    }
    *n_out = n;
    return S3DFS_OK;
}

int cluster_get(cluster_t *c, const char *bucket, const char *key, object_value_t *out)
{
    memset(out, 0, sizeof(*out));
    char ok[2048];
    object_key(bucket, key, ok, sizeof(ok));
    object_locator_t locs[MAX_REPLICAS];
    int n = 0;
    int rc = load_locators(c, ok, locs, &n);
    if (rc != S3DFS_OK) {
        return rc;
    }
    int saw_error = 0;
    for (int i = 0; i < n; i++) {
        http_response_t r = {0};
        char host[256];
        int port = 0;
        if (parse_address(locs[i].address, host, sizeof(host), &port) != S3DFS_OK) {
            continue;
        }
        int gr = block_get(host, port, ok, &locs[i], &r);
        if (gr != S3DFS_OK) {
            http_response_free(&r);
            if (gr != S3DFS_ERR_NOT_FOUND) {
                saw_error = 1;
            }
            continue;
        }
        void *plain = NULL;
        size_t plain_len = 0;
        if (decompress_value(r.body, r.body_len, locs[i].compress_type, (size_t)locs[i].size, &plain, &plain_len) !=
            S3DFS_OK) {
            http_response_free(&r);
            saw_error = 1;
            continue;
        }
        http_response_free(&r);
        if (locs[i].size && plain_len != (size_t)locs[i].size) {
            free(plain);
            saw_error = 1;
            continue;
        }
        if (locs[i].crc && crc32_ieee(plain, plain_len) != locs[i].crc) {
            free(plain);
            saw_error = 1;
            continue;
        }
        out->value = plain;
        out->size = plain_len;
        out->crc = locs[i].crc;
        out->mtime_ms = locs[i].mtime_ms;
        out->compress_type = locs[i].compress_type;
        out->total_size = plain_len;
        return S3DFS_OK;
    }
    if (n > 0 && saw_error) {
        return S3DFS_ERR_UNAVAILABLE;
    }
    return S3DFS_ERR_NOT_FOUND;
}

int cluster_get_range(cluster_t *c, const char *bucket, const char *key, uint64_t start, uint64_t end,
                      object_value_t *out)
{
    int rc = cluster_get(c, bucket, key, out);
    if (rc != S3DFS_OK) {
        return rc;
    }
    uint64_t total = out->size;
    out->total_size = total;
    if (total == 0 || start >= total || start > end) {
        free(out->value);
        out->value = malloc(1);
        if (out->value) {
            ((char *)out->value)[0] = '\0';
        }
        out->size = 0;
        return S3DFS_OK;
    }
    uint64_t from = start;
    uint64_t to = end < total - 1 ? end : total - 1;
    size_t n = (size_t)(to - from + 1);
    memmove(out->value, (char *)out->value + from, n);
    out->size = n;
    return S3DFS_OK;
}

int cluster_head(cluster_t *c, const char *bucket, const char *key, object_value_t *out)
{
    memset(out, 0, sizeof(*out));
    char ok[2048];
    object_key(bucket, key, ok, sizeof(ok));
    object_locator_t locs[MAX_REPLICAS];
    int n = 0;
    int rc = load_locators(c, ok, locs, &n);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (n == 0) {
        return S3DFS_ERR_NOT_FOUND;
    }
    out->size = (size_t)locs[0].size;
    out->crc = locs[0].crc;
    out->mtime_ms = locs[0].mtime_ms;
    out->compress_type = locs[0].compress_type;
    out->total_size = locs[0].size;
    return S3DFS_OK;
}

int cluster_delete(cluster_t *c, const char *bucket, const char *key)
{
    char ok[2048];
    object_key(bucket, key, ok, sizeof(ok));
    object_locator_t locs[MAX_REPLICAS];
    int n = 0;
    int rc = load_locators(c, ok, locs, &n);
    if (rc == S3DFS_ERR_NOT_FOUND) {
        return S3DFS_OK;
    }
    if (rc != S3DFS_OK) {
        return rc;
    }
    for (int i = 0; i < n; i++) {
        char host[256];
        int port = 0;
        if (parse_address(locs[i].address, host, sizeof(host), &port) == S3DFS_OK) {
            block_tombstone(host, port, ok);
        }
    }
    for (int i = 0; i < n; i++) {
        char lkey[2100];
        locator_key(ok, locs[i].replica, lkey, sizeof(lkey));
        kv_delete(c, lkey, NULL);
    }
    return S3DFS_OK;
}

int cluster_create_bucket(cluster_t *c, const char *bucket)
{
    char marker[512];
    object_key(bucket, NULL, marker, sizeof(marker));
    if (kv_head(c, marker) == S3DFS_OK) {
        return S3DFS_OK;
    }
    char body[128];
    int n = snprintf(body, sizeof(body), "{\"v\":1,\"kind\":\"bucket\",\"mtimeMs\":%" PRIu64 "}", now_ms());
    return kv_put(c, marker, body, (size_t)n);
}

int cluster_delete_bucket(cluster_t *c, const char *bucket)
{
    int ex = cluster_bucket_exists(c, bucket);
    if (ex != S3DFS_OK) {
        return ex;
    }
    list_result_t listed = {0};
    int rc = cluster_list(c, bucket, "", NULL, 1, "", &listed);
    if (rc != S3DFS_OK) {
        list_result_free(&listed);
        return rc;
    }
    int nonempty = listed.object_count > 0 || listed.prefix_count > 0 || listed.truncated;
    list_result_free(&listed);
    if (nonempty) {
        return S3DFS_ERR_CONFLICT;
    }
    char marker[512];
    object_key(bucket, NULL, marker, sizeof(marker));
    return kv_delete(c, marker, NULL);
}

int cluster_bucket_exists(cluster_t *c, const char *bucket)
{
    char marker[512];
    object_key(bucket, NULL, marker, sizeof(marker));
    if (kv_head(c, marker) == S3DFS_OK) {
        return S3DFS_OK;
    }
    char prefix[520];
    snprintf(prefix, sizeof(prefix), "%s/", bucket);
    kv_scan_t scan = {0};
    int rc = kv_scan(c, prefix, NULL, 8, &scan);
    if (rc != S3DFS_OK) {
        kv_scan_free(&scan);
        return rc;
    }
    int found = 0;
    for (size_t i = 0; i < scan.count; i++) {
        if (is_visible_object_key(scan.items[i].key)) {
            found = 1;
            break;
        }
    }
    kv_scan_free(&scan);
    return found ? S3DFS_OK : S3DFS_ERR_NOT_FOUND;
}

int cluster_list_buckets(cluster_t *c, bucket_info_t **out, size_t *n)
{
    *out = NULL;
    *n = 0;
    kv_scan_t scan = {0};
    int rc = kv_scan(c, "", NULL, 10000, &scan);
    if (rc != S3DFS_OK) {
        kv_scan_free(&scan);
        return rc;
    }
    bucket_info_t *items = NULL;
    size_t count = 0, cap = 0;
    for (size_t i = 0; i < scan.count; i++) {
        if (!is_visible_object_key(scan.items[i].key)) {
            continue;
        }
        const char *slash = strchr(scan.items[i].key, '/');
        if (!slash || slash == scan.items[i].key) {
            continue;
        }
        char name[256];
        size_t nl = (size_t)(slash - scan.items[i].key);
        if (nl >= sizeof(name)) {
            continue;
        }
        memcpy(name, scan.items[i].key, nl);
        name[nl] = '\0';
        size_t j;
        for (j = 0; j < count; j++) {
            if (strcmp(items[j].name, name) == 0) {
                if (scan.items[i].mtime_ms < items[j].mtime_ms) {
                    items[j].mtime_ms = scan.items[i].mtime_ms;
                }
                break;
            }
        }
        if (j < count) {
            continue;
        }
        if (count >= cap) {
            size_t ncap = cap ? cap * 2 : 8;
            bucket_info_t *ni = realloc(items, ncap * sizeof(*ni));
            if (!ni) {
                free(items);
                kv_scan_free(&scan);
                return S3DFS_ERR_NOMEM;
            }
            items = ni;
            cap = ncap;
        }
        snprintf(items[count].name, sizeof(items[count].name), "%s", name);
        items[count].mtime_ms = scan.items[i].mtime_ms;
        count++;
    }
    kv_scan_free(&scan);
    *out = items;
    *n = count;
    return S3DFS_OK;
}

void list_result_free(list_result_t *r)
{
    if (!r) {
        return;
    }
    free(r->objects);
    if (r->prefixes) {
        for (size_t i = 0; i < r->prefix_count; i++) {
            free(r->prefixes[i]);
        }
        free(r->prefixes);
    }
    memset(r, 0, sizeof(*r));
}

void object_value_free(object_value_t *v)
{
    if (!v) {
        return;
    }
    free(v->value);
    v->value = NULL;
    v->size = 0;
}

int cluster_list(cluster_t *c, const char *bucket, const char *prefix, const char *start_after, int max_keys,
                 const char *delimiter, list_result_t *out)
{
    memset(out, 0, sizeof(*out));
    int capn = max_keys > 0 ? max_keys : 1000;
    if (capn > MAX_LIST_OBJECTS) {
        capn = MAX_LIST_OBJECTS;
    }
    if (capn < 1) {
        capn = 1;
    }
    char full_prefix[2048];
    char bucket_prefix[512];
    snprintf(bucket_prefix, sizeof(bucket_prefix), "%s/", bucket);
    if (prefix && prefix[0]) {
        snprintf(full_prefix, sizeof(full_prefix), "%s/%s", bucket, prefix);
    } else {
        snprintf(full_prefix, sizeof(full_prefix), "%s/", bucket);
    }
    char scan_after[2100] = "";
    if (start_after && start_after[0]) {
        snprintf(scan_after, sizeof(scan_after), "%s/%s", bucket, start_after);
    }

    out->objects = calloc((size_t)capn, sizeof(list_obj_t));
    if (!out->objects) {
        return S3DFS_ERR_NOMEM;
    }
    char **prefs = NULL;
    size_t pref_cap = 0;
    char last_name[1024] = "";

    while ((int)(out->object_count + out->prefix_count) < capn) {
        kv_scan_t scan = {0};
        int batch = capn * 3;
        if (batch < 64) {
            batch = 64;
        }
        int rc = kv_scan(c, full_prefix, scan_after[0] ? scan_after : NULL, batch, &scan);
        if (rc != S3DFS_OK) {
            kv_scan_free(&scan);
            list_result_free(out);
            return rc;
        }
        if (scan.count == 0) {
            kv_scan_free(&scan);
            break;
        }
        int stopped = 0;
        for (size_t i = 0; i < scan.count; i++) {
            snprintf(scan_after, sizeof(scan_after), "%s", scan.items[i].key);
            if (!is_visible_object_key(scan.items[i].key)) {
                continue;
            }
            const char *bp = bucket_prefix;
            if (strncmp(scan.items[i].key, bp, strlen(bp)) != 0) {
                continue;
            }
            if (strcmp(scan.items[i].key, bp) == 0) {
                continue; /* bucket marker */
            }
            const char *rel = scan.items[i].key + strlen(bp);
            if (start_after && start_after[0] && strcmp(rel, start_after) <= 0) {
                continue;
            }
            if (delimiter && delimiter[0]) {
                const char *rest = rel;
                if (prefix && prefix[0] && !strncmp(rel, prefix, strlen(prefix))) {
                    rest = rel + strlen(prefix);
                }
                const char *cut = strstr(rest, delimiter);
                if (cut) {
                    size_t clen = (size_t)((cut - rel) + strlen(delimiter));
                    /* common = prefix + rest.slice(0, cut+delim) which is rel[0..clen) */
                    char common[1024];
                    if (clen >= sizeof(common)) {
                        continue;
                    }
                    memcpy(common, rel, clen);
                    common[clen] = '\0';
                    if (start_after && start_after[0] && strcmp(common, start_after) <= 0) {
                        continue;
                    }
                    int seen = 0;
                    for (size_t p = 0; p < out->prefix_count; p++) {
                        if (strcmp(prefs[p], common) == 0) {
                            seen = 1;
                            break;
                        }
                    }
                    if (seen) {
                        continue;
                    }
                    if (out->prefix_count >= pref_cap) {
                        size_t ncap = pref_cap ? pref_cap * 2 : 8;
                        char **np = realloc(prefs, ncap * sizeof(*np));
                        if (!np) {
                            kv_scan_free(&scan);
                            list_result_free(out);
                            return S3DFS_ERR_NOMEM;
                        }
                        prefs = np;
                        pref_cap = ncap;
                    }
                    prefs[out->prefix_count] = strdup(common);
                    out->prefix_count++;
                    snprintf(last_name, sizeof(last_name), "%s", common);
                    if ((int)(out->object_count + out->prefix_count) >= capn) {
                        stopped = 1;
                        break;
                    }
                    continue;
                }
            }
            list_obj_t *o = &out->objects[out->object_count++];
            snprintf(o->key, sizeof(o->key), "%s", rel);
            o->size = scan.items[i].size;
            o->crc = scan.items[i].crc;
            o->mtime_ms = scan.items[i].mtime_ms;
            snprintf(last_name, sizeof(last_name), "%s", rel);
            if ((int)(out->object_count + out->prefix_count) >= capn) {
                stopped = 1;
                break;
            }
        }
        int at_cap = (int)(out->object_count + out->prefix_count) >= capn;
        if (at_cap && (stopped || scan.truncated)) {
            out->truncated = 1;
            kv_scan_free(&scan);
            break;
        }
        int more = scan.truncated;
        kv_scan_free(&scan);
        if (!more) {
            break;
        }
    }
    out->prefixes = prefs;
    if (out->truncated) {
        snprintf(out->next_token, sizeof(out->next_token), "%s", last_name);
    }
    return S3DFS_OK;
}
