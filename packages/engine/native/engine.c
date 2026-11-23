#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700

#include "engine_int.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define S3DFS_REC_MAGIC 0x31523353u /* 'S3R1' little-endian */
#define S3DFS_DEFAULT_BLOCK_SIZE (1024ull * 1024ull * 1024ull)
#define S3DFS_MAX_EXTENTS 1048576u
#define S3DFS_DEFAULT_BUFFER_SIZE (1024u * 1024u)
#define S3DFS_MIN_BUFFER_SIZE 4096u
#define S3DFS_FRAME_OVERHEAD 20u

#define S3DFS_TAG_KEY 0x0001
#define S3DFS_TAG_VALUE 0x0002
#define S3DFS_TAG_MTIME 0x0003
#define S3DFS_TAG_CRC 0x0004
#define S3DFS_TAG_KIND 0x0005
#define S3DFS_TAG_PREV 0x0006
#define S3DFS_TAG_SEQ 0x0007
#define S3DFS_TAG_GENERATION 0x0008
#define S3DFS_TAG_TOTAL_SIZE 0x0009
#define S3DFS_TAG_EXTENT_CNT 0x000A
#define S3DFS_TAG_COMPRESS 0x000B
#define S3DFS_TAG_ORIG_SIZE 0x000C
#define S3DFS_TAG_ORIG_CRC 0x000D
#define S3DFS_TAG_REC_ID 0x000E
#define S3DFS_TAG_RECID_V1 0x000F

#define S3DFS_KIND_OBJECT 1
#define S3DFS_KIND_EXTENT 2
#define S3DFS_KIND_EXTENT_LAST 3
#define S3DFS_KIND_TOMBSTONE 4

typedef struct {
    const uint8_t *key;
    uint32_t key_len;
    const uint8_t *value;
    uint32_t value_len;
    uint64_t mtime_ms;
    uint32_t crc;
    uint8_t kind;
    int has_prev;
    uint64_t rec_id;
    uint64_t prev_rec_id;
    uint32_t seq;
    uint64_t generation;
    uint64_t total_size;
    uint32_t extent_count;
    uint8_t compress_type;
    uint64_t orig_size;
    uint32_t orig_crc;
    int has_meta;
} s3dfs_rec_view;

typedef struct {
    uint64_t prev_rec_id;
    uint32_t seq;
    uint64_t generation;
    uint64_t total_size;
    uint32_t extent_count;
} s3dfs_ext_link;

#define S3DFS_MAP_EMPTY 0
#define S3DFS_MAP_DEL 1
#define S3DFS_MAP_LIVE 2

typedef struct s3dfs_rec_ent {
    uint8_t state;
    uint64_t rec_id;
    uint64_t block_id;
    uint64_t offset;
    uint32_t rec_len;
} s3dfs_rec_ent;

typedef struct s3dfs_key_ent {
    uint8_t state;
    uint8_t kind;
    uint32_t key_len;
    char *key;
    uint64_t rec_id;
} s3dfs_key_ent;

static int load_record(s3dfs_store *s, uint64_t block_id, uint64_t offset, uint32_t rec_len, uint8_t **out,
                       s3dfs_rec_view *view);
static int page_reserve(s3dfs_store *s, uint64_t rec_id, uint32_t obj_total);
static int list_block_ids(s3dfs_store *s, uint64_t **ids_out, uint32_t *n_out);
static int page_flush_dirty(s3dfs_store *s);
static int page_note(s3dfs_store *s, uint64_t rec_id, uint64_t block, uint64_t off, uint32_t rec_len);
static int page_lookup(s3dfs_store *s, uint64_t rec_id, s3dfs_rec_ent *out);
static void page_clear(s3dfs_store *s, uint64_t rec_id);
static void retire_chain_unlocked(s3dfs_store *s, uint64_t rec_id);
static int maps_init(s3dfs_store *s);
static void maps_free(s3dfs_store *s);

static uint32_t hash_u64(uint64_t x)
{
    x ^= x >> 30;
    x *= 0xbf58476d1ce4e5b9ull;
    x ^= x >> 27;
    x *= 0x94d049bb133111ebull;
    x ^= x >> 31;
    return (uint32_t)x;
}

static uint32_t hash_key_bytes(const char *k, uint32_t n)
{
    uint32_t h = 2166136261u;
    for (uint32_t i = 0; i < n; i++) {
        h ^= (uint8_t)k[i];
        h *= 16777619u;
    }
    return h;
}

static int rec_map_init(s3dfs_store *s, uint32_t cap)
{
    if (cap < 8) {
        cap = 8;
    }
    s->rec_tab = (s3dfs_rec_ent *)calloc(cap, sizeof(s3dfs_rec_ent));
    if (!s->rec_tab) {
        return -1;
    }
    s->rec_cap = cap;
    s->rec_count = 0;
    return 0;
}

static int key_map_init(s3dfs_store *s, uint32_t cap)
{
    if (cap < 8) {
        cap = 8;
    }
    s->key_tab = (s3dfs_key_ent *)calloc(cap, sizeof(s3dfs_key_ent));
    if (!s->key_tab) {
        return -1;
    }
    s->key_cap = cap;
    s->key_count = 0;
    return 0;
}

static int maps_init(s3dfs_store *s)
{
    s->next_rec_id = 1;
    s->dead_bytes = 0;
    s->tickets = 0;
    if (rec_map_init(s, 64) != 0 || key_map_init(s, 64) != 0) {
        return -1;
    }
    return 0;
}

static void rec_map_free(s3dfs_store *s)
{
    free(s->rec_tab);
    s->rec_tab = NULL;
    s->rec_cap = 0;
    s->rec_count = 0;
}

static void key_map_free(s3dfs_store *s)
{
    if (s->key_tab) {
        for (uint32_t i = 0; i < s->key_cap; i++) {
            if (s->key_tab[i].state == S3DFS_MAP_LIVE) {
                free(s->key_tab[i].key);
            }
        }
    }
    free(s->key_tab);
    s->key_tab = NULL;
    s->key_cap = 0;
    s->key_count = 0;
}

static void maps_free(s3dfs_store *s)
{
    rec_map_free(s);
    key_map_free(s);
    if (s->compact_slots) {
        for (uint32_t i = 0; i < s->page_n; i++) {
            free(s->compact_slots[i]);
        }
        free(s->compact_slots);
        s->compact_slots = NULL;
    }
    free(s->pages);
    s->pages = NULL;
    s->page_n = 0;
    s->page_cap = 0;
}

static int rec_map_grow(s3dfs_store *s);

static int rec_map_put(s3dfs_store *s, uint64_t rec_id, uint64_t block, uint64_t off, uint32_t rec_len)
{
    if (!s->rec_tab || rec_id == 0) {
        return -1;
    }
    if (s->rec_count * 2 >= s->rec_cap) {
        if (rec_map_grow(s) != 0) {
            return -1;
        }
    }
    uint32_t mask = s->rec_cap - 1;
    uint32_t i = hash_u64(rec_id) & mask;
    int slot = -1;
    for (uint32_t n = 0; n < s->rec_cap; n++) {
        s3dfs_rec_ent *e = &s->rec_tab[i];
        if (e->state == S3DFS_MAP_LIVE && e->rec_id == rec_id) {
            e->block_id = block;
            e->offset = off;
            e->rec_len = rec_len;
            return 0;
        }
        if (e->state != S3DFS_MAP_LIVE && slot < 0) {
            slot = (int)i;
            if (e->state == S3DFS_MAP_EMPTY) {
                break;
            }
        }
        i = (i + 1) & mask;
    }
    if (slot < 0) {
        return -1;
    }
    s3dfs_rec_ent *e = &s->rec_tab[slot];
    e->state = S3DFS_MAP_LIVE;
    e->rec_id = rec_id;
    e->block_id = block;
    e->offset = off;
    e->rec_len = rec_len;
    s->rec_count++;
    return 0;
}

static int rec_map_grow(s3dfs_store *s)
{
    uint32_t old_cap = s->rec_cap;
    s3dfs_rec_ent *old = s->rec_tab;
    s->rec_tab = NULL;
    s->rec_cap = 0;
    s->rec_count = 0;
    if (rec_map_init(s, old_cap * 2) != 0) {
        s->rec_tab = old;
        s->rec_cap = old_cap;
        return -1;
    }
    for (uint32_t i = 0; i < old_cap; i++) {
        if (old[i].state == S3DFS_MAP_LIVE) {
            if (rec_map_put(s, old[i].rec_id, old[i].block_id, old[i].offset, old[i].rec_len) != 0) {
                rec_map_free(s);
                s->rec_tab = old;
                s->rec_cap = old_cap;
                return -1;
            }
        }
    }
    free(old);
    return 0;
}

static int rec_map_get(const s3dfs_store *s, uint64_t rec_id, s3dfs_rec_ent *out)
{
    return page_lookup((s3dfs_store *)s, rec_id, out);
}

static void rec_map_del(s3dfs_store *s, uint64_t rec_id)
{
    page_clear(s, rec_id);
    if (!s->rec_tab || rec_id == 0) {
        return;
    }
    uint32_t mask = s->rec_cap - 1;
    uint32_t i = hash_u64(rec_id) & mask;
    for (uint32_t n = 0; n < s->rec_cap; n++) {
        s3dfs_rec_ent *e = &s->rec_tab[i];
        if (e->state == S3DFS_MAP_EMPTY) {
            return;
        }
        if (e->state == S3DFS_MAP_LIVE && e->rec_id == rec_id) {
            e->state = S3DFS_MAP_DEL;
            s->rec_count--;
            return;
        }
        i = (i + 1) & mask;
    }
}

static int key_map_grow(s3dfs_store *s);

static int key_map_put(s3dfs_store *s, const char *key, uint32_t key_len, uint64_t rec_id, uint8_t kind)
{
    if (!s->key_tab || !key || key_len == 0) {
        return -1;
    }
    if (s->key_count * 2 >= s->key_cap) {
        if (key_map_grow(s) != 0) {
            return -1;
        }
    }
    uint32_t mask = s->key_cap - 1;
    uint32_t i = hash_key_bytes(key, key_len) & mask;
    int slot = -1;
    for (uint32_t n = 0; n < s->key_cap; n++) {
        s3dfs_key_ent *e = &s->key_tab[i];
        if (e->state == S3DFS_MAP_LIVE && e->key_len == key_len && memcmp(e->key, key, key_len) == 0) {
            e->rec_id = rec_id;
            e->kind = kind;
            return 0;
        }
        if (e->state != S3DFS_MAP_LIVE && slot < 0) {
            slot = (int)i;
            if (e->state == S3DFS_MAP_EMPTY) {
                break;
            }
        }
        i = (i + 1) & mask;
    }
    if (slot < 0) {
        return -1;
    }
    char *copy = (char *)malloc(key_len);
    if (!copy) {
        return -1;
    }
    memcpy(copy, key, key_len);
    s3dfs_key_ent *e = &s->key_tab[slot];
    if (e->state == S3DFS_MAP_LIVE) {
        free(e->key);
    }
    e->state = S3DFS_MAP_LIVE;
    e->kind = kind;
    e->key_len = key_len;
    e->key = copy;
    e->rec_id = rec_id;
    s->key_count++;
    return 0;
}

static int key_map_grow(s3dfs_store *s)
{
    uint32_t old_cap = s->key_cap;
    s3dfs_key_ent *old = s->key_tab;
    s->key_tab = NULL;
    s->key_cap = 0;
    s->key_count = 0;
    if (key_map_init(s, old_cap * 2) != 0) {
        s->key_tab = old;
        s->key_cap = old_cap;
        return -1;
    }
    for (uint32_t i = 0; i < old_cap; i++) {
        if (old[i].state == S3DFS_MAP_LIVE) {
            if (key_map_put(s, old[i].key, old[i].key_len, old[i].rec_id, old[i].kind) != 0) {
                key_map_free(s);
                s->key_tab = old;
                s->key_cap = old_cap;
                return -1;
            }
        }
    }
    for (uint32_t i = 0; i < old_cap; i++) {
        if (old[i].state == S3DFS_MAP_LIVE) {
            free(old[i].key);
        }
    }
    free(old);
    return 0;
}

static int key_map_get(const s3dfs_store *s, const char *key, uint32_t key_len, s3dfs_key_ent *out)
{
    if (!s->key_tab || !key || key_len == 0) {
        return -1;
    }
    uint32_t mask = s->key_cap - 1;
    uint32_t i = hash_key_bytes(key, key_len) & mask;
    for (uint32_t n = 0; n < s->key_cap; n++) {
        const s3dfs_key_ent *e = &s->key_tab[i];
        if (e->state == S3DFS_MAP_EMPTY) {
            return -1;
        }
        if (e->state == S3DFS_MAP_LIVE && e->key_len == key_len && memcmp(e->key, key, key_len) == 0) {
            if (out) {
                *out = *e;
            }
            return 0;
        }
        i = (i + 1) & mask;
    }
    return -1;
}


static uint32_t crc32_table[256];
static int crc32_ready = 0;

static void crc32_init(void)
{
    if (crc32_ready) {
        return;
    }
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        crc32_table[i] = c;
    }
    crc32_ready = 1;
}

static uint32_t crc32_update(uint32_t crc, const void *data, uint32_t len)
{
    const uint8_t *p = (const uint8_t *)data;
    crc = ~crc;
    for (uint32_t i = 0; i < len; i++) {
        crc = crc32_table[(crc ^ p[i]) & 0xff] ^ (crc >> 8);
    }
    return ~crc;
}

static uint32_t crc32_key_value(const char *key, uint32_t key_len, const void *val, uint32_t val_len)
{
    uint32_t crc = crc32_update(0, key, key_len);
    if (val_len && val) {
        crc = crc32_update(crc, val, val_len);
    }
    return crc;
}

static void wr_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static void wr_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static void wr_u64(uint8_t *p, uint64_t v)
{
    wr_u32(p, (uint32_t)v);
    wr_u32(p + 4, (uint32_t)(v >> 32));
}

static uint16_t rd_u16(const uint8_t *p)
{
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t rd_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t rd_u64(const uint8_t *p)
{
    return (uint64_t)rd_u32(p) | ((uint64_t)rd_u32(p + 4) << 32);
}

static uint8_t *write_tag(uint8_t *p, uint16_t type, const void *data, uint32_t len)
{
    wr_u16(p, type);
    wr_u32(p + 2, len);
    if (len && data) {
        memcpy(p + 6, data, len);
    }
    return p + 6 + len;
}

static uint32_t rec_overhead(uint32_t key_len, uint32_t value_len, int chained, int with_meta)
{
    uint32_t tags = 0;
    tags += 6 + key_len;
    tags += 6 + 1; /* KIND */
    tags += 6 + 8; /* REC_ID */
    tags += 6 + 8; /* MTIME */
    tags += 6 + 4; /* CRC */
    tags += 6 + value_len;
    if (chained) {
        tags += 6 + 8; /* PREV recId */
        tags += 6 + 4;  /* SEQ */
        tags += 6 + 8;  /* GENERATION */
        tags += 6 + 8;  /* TOTAL_SIZE */
        tags += 6 + 4;  /* EXTENT_CNT */
    }
    if (with_meta) {
        tags += 6 + 1; /* COMPRESS */
        tags += 6 + 8; /* ORIG_SIZE */
        tags += 6 + 4; /* ORIG_CRC */
    }
    return S3DFS_FRAME_OVERHEAD + tags;
}

static int parse_tags(const uint8_t *tags, uint32_t tags_len, s3dfs_rec_view *v)
{
    memset(v, 0, sizeof(*v));
    uint32_t i = 0;
    while (i + 6 <= tags_len) {
        uint16_t typ = rd_u16(tags + i);
        uint32_t len = rd_u32(tags + i + 2);
        if (i + 6 + len > tags_len) {
            return -1;
        }
        const uint8_t *val = tags + i + 6;
        switch (typ) {
        case S3DFS_TAG_KEY:
            v->key = val;
            v->key_len = len;
            break;
        case S3DFS_TAG_VALUE:
            v->value = val;
            v->value_len = len;
            break;
        case S3DFS_TAG_MTIME:
            if (len != 8) {
                return -1;
            }
            v->mtime_ms = rd_u64(val);
            break;
        case S3DFS_TAG_CRC:
            if (len != 4) {
                return -1;
            }
            v->crc = rd_u32(val);
            break;
        case S3DFS_TAG_KIND:
            if (len != 1) {
                return -1;
            }
            v->kind = val[0];
            break;
        case S3DFS_TAG_REC_ID:
            if (len != 8) {
                return -1;
            }
            v->rec_id = rd_u64(val);
            break;
        case S3DFS_TAG_PREV:
            if (len != 8) {
                return -1;
            }
            v->has_prev = 1;
            v->prev_rec_id = rd_u64(val);
            break;
        case S3DFS_TAG_SEQ:
            if (len != 4) {
                return -1;
            }
            v->seq = rd_u32(val);
            break;
        case S3DFS_TAG_GENERATION:
            if (len != 8) {
                return -1;
            }
            v->generation = rd_u64(val);
            break;
        case S3DFS_TAG_TOTAL_SIZE:
            if (len != 8) {
                return -1;
            }
            v->total_size = rd_u64(val);
            break;
        case S3DFS_TAG_EXTENT_CNT:
            if (len != 4) {
                return -1;
            }
            v->extent_count = rd_u32(val);
            break;
        case S3DFS_TAG_COMPRESS:
            if (len != 1) {
                return -1;
            }
            v->compress_type = val[0];
            v->has_meta = 1;
            break;
        case S3DFS_TAG_ORIG_SIZE:
            if (len != 8) {
                return -1;
            }
            v->orig_size = rd_u64(val);
            v->has_meta = 1;
            break;
        case S3DFS_TAG_ORIG_CRC:
            if (len != 4) {
                return -1;
            }
            v->orig_crc = rd_u32(val);
            v->has_meta = 1;
            break;
        default:
            break;
        }
        i += 6 + len;
    }
    return i == tags_len ? 0 : -1;
}

static int parse_record(const uint8_t *rec, uint32_t rec_len, s3dfs_rec_view *v)
{
    if (rec_len < S3DFS_FRAME_OVERHEAD) {
        return -1;
    }
    if (rd_u32(rec) != S3DFS_REC_MAGIC || rd_u32(rec + 4) != rec_len) {
        return -1;
    }
    if (rd_u32(rec + rec_len - 4) != S3DFS_REC_MAGIC || rd_u32(rec + rec_len - 8) != rec_len) {
        return -1;
    }
    uint32_t tags_len = rec_len - S3DFS_FRAME_OVERHEAD;
    uint32_t crc_got = rd_u32(rec + 8 + tags_len);
    if (crc_got != crc32_update(0, rec, 8 + tags_len)) {
        return -1;
    }
    return parse_tags(rec + 8, tags_len, v);
}

static int build_record(uint8_t *dst, uint32_t total, const char *key, uint32_t key_len, const void *value,
                        uint32_t value_len, uint8_t kind, uint64_t rec_id, uint32_t crc, uint64_t mtime_ms,
                        const s3dfs_ext_link *link, const s3dfs_put_meta *meta)
{
    int chained = (kind == S3DFS_KIND_EXTENT || kind == S3DFS_KIND_EXTENT_LAST);
    int with_meta = (meta && meta->has_meta && kind != S3DFS_KIND_EXTENT) ? 1 : 0;
    if (rec_overhead(key_len, value_len, chained, with_meta) != total) {
        return -1;
    }
    uint8_t *p = dst;
    wr_u32(p, S3DFS_REC_MAGIC);
    p += 4;
    wr_u32(p, total);
    p += 4;
    p = write_tag(p, S3DFS_TAG_KEY, key, key_len);
    p = write_tag(p, S3DFS_TAG_KIND, &kind, 1);
    uint8_t rid[8];
    wr_u64(rid, rec_id);
    p = write_tag(p, S3DFS_TAG_REC_ID, rid, 8);
    uint8_t mtime[8];
    wr_u64(mtime, mtime_ms);
    p = write_tag(p, S3DFS_TAG_MTIME, mtime, 8);
    uint8_t crc_buf[4];
    wr_u32(crc_buf, crc);
    p = write_tag(p, S3DFS_TAG_CRC, crc_buf, 4);
    if (chained) {
        uint8_t prev[8];
        uint64_t prid = 0;
        uint32_t seq = 0, ext = 0;
        uint64_t gen = 0, total_size = 0;
        if (link) {
            prid = link->prev_rec_id;
            seq = link->seq;
            gen = link->generation;
            total_size = link->total_size;
            ext = link->extent_count;
        }
        wr_u64(prev, prid);
        p = write_tag(p, S3DFS_TAG_PREV, prev, 8);
        uint8_t seqb[4], extb[4], genb[8], tsb[8];
        wr_u32(seqb, seq);
        wr_u64(genb, gen);
        wr_u64(tsb, total_size);
        wr_u32(extb, ext);
        p = write_tag(p, S3DFS_TAG_SEQ, seqb, 4);
        p = write_tag(p, S3DFS_TAG_GENERATION, genb, 8);
        p = write_tag(p, S3DFS_TAG_TOTAL_SIZE, tsb, 8);
        p = write_tag(p, S3DFS_TAG_EXTENT_CNT, extb, 4);
    }
    if (with_meta) {
        p = write_tag(p, S3DFS_TAG_COMPRESS, &meta->compress_type, 1);
        uint8_t os[8], oc[4];
        wr_u64(os, meta->orig_size);
        wr_u32(oc, meta->orig_crc);
        p = write_tag(p, S3DFS_TAG_ORIG_SIZE, os, 8);
        p = write_tag(p, S3DFS_TAG_ORIG_CRC, oc, 4);
    }
    p = write_tag(p, S3DFS_TAG_VALUE, value, value_len);
    uint32_t body_len = (uint32_t)(p - dst);
    wr_u32(p, crc32_update(0, dst, body_len));
    p += 4;
    wr_u32(p, total);
    p += 4;
    wr_u32(p, S3DFS_REC_MAGIC);
    p += 4;
    return p == dst + total ? 0 : -1;
}

static uint64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)ts.tv_nsec / 1000000ull;
}

static uint64_t mono_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ull + (uint64_t)ts.tv_nsec / 1000ull;
}

static void note_us(uint64_t *sum, uint64_t *max_us, uint64_t us)
{
    *sum += us;
    if (max_us && us > *max_us) {
        *max_us = us;
    }
}

void s3dfs_stat_add(uint64_t *sum, uint64_t *max_us, uint64_t *count, uint64_t value)
{
    if (sum) {
        __atomic_fetch_add(sum, value, __ATOMIC_RELAXED);
    }
    if (count) {
        __atomic_fetch_add(count, 1, __ATOMIC_RELAXED);
    }
    if (!max_us) {
        return;
    }
    uint64_t cur = __atomic_load_n(max_us, __ATOMIC_RELAXED);
    while (value > cur && !__atomic_compare_exchange_n(max_us, &cur, value, 1, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {
    }
}

void s3dfs_stat_max(uint64_t *max_value, uint64_t value)
{
    s3dfs_stat_add(NULL, max_value, NULL, value);
}

static int mkdir_p(const char *path)
{
    if (!path || !path[0]) {
        return -1;
    }
    char tmp[4096];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = 0;
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST) {
                return -1;
            }
            *p = '/';
        }
    }
    if (mkdir(tmp, 0755) != 0 && errno != EEXIST) {
        return -1;
    }
    return 0;
}

static void block_path(const s3dfs_store *s, uint64_t id, char *out, size_t out_len)
{
    snprintf(out, out_len, "%s/%020llu.blk", s->blocks_dir, (unsigned long long)id);
}

static int pwrite_fully(int fd, const void *data, uint32_t len, off_t at)
{
    const uint8_t *p = (const uint8_t *)data;
    uint32_t off = 0;
    while (off < len) {
        ssize_t n = pwrite(fd, p + off, len - off, at + (off_t)off);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (n == 0) {
            return -1;
        }
        off += (uint32_t)n;
    }
    return 0;
}

static int cmp_u64(const void *a, const void *b)
{
    uint64_t x = *(const uint64_t *)a;
    uint64_t y = *(const uint64_t *)b;
    return (x > y) - (x < y);
}

static int close_write_fd(s3dfs_store *s)
{
    if (lane_of(s)->fd >= 0) {
        if (s->fsync_on_flush && lane_of(s)->pending_sync) {
            if (fsync(lane_of(s)->fd) != 0) {
                close(lane_of(s)->fd);
                lane_of(s)->fd = -1;
                return S3DFS_ERR_IO;
            }
            s->stats.fsyncs++;
            lane_of(s)->pending_sync = 0;
        }
        close(lane_of(s)->fd);
        lane_of(s)->fd = -1;
    }
    return S3DFS_OK;
}

static int open_block_for_write(s3dfs_store *s, uint64_t id, uint64_t existing_size)
{
    char path[4096];
    block_path(s, id, path, sizeof(path));
    int fd = open(path, O_RDWR | O_CREAT, 0644);
    if (fd < 0) {
        return S3DFS_ERR_IO;
    }
    if (existing_size) {
        if (ftruncate(fd, (off_t)existing_size) != 0 || lseek(fd, (off_t)existing_size, SEEK_SET) < 0) {
            close(fd);
            return S3DFS_ERR_IO;
        }
    } else if (lseek(fd, 0, SEEK_END) < 0) {
        close(fd);
        return S3DFS_ERR_IO;
    }
    lane_of(s)->fd = fd;
    lane_of(s)->block_id = id;
    lane_of(s)->size = existing_size;
    return S3DFS_OK;
}

static int flush_bytes_unlocked(s3dfs_store *s)
{
    if (lane_of(s)->buf_used == 0) {
        return S3DFS_OK;
    }
    if (lane_of(s)->fd < 0) {
        return S3DFS_ERR_IO;
    }
    uint64_t body_t0 = mono_us();
    s3dfs_store_io_begin(s);
    int wrote = pwrite_fully(lane_of(s)->fd, lane_of(s)->buf, lane_of(s)->buf_used, (off_t)lane_of(s)->size);
    s3dfs_store_io_end(s);
    s3dfs_stat_add(&s->stats.body_us, &s->stats.body_max_us, &s->stats.body_writes, mono_us() - body_t0);
    if (wrote != 0) {
        return S3DFS_ERR_IO;
    }
    lane_of(s)->size += lane_of(s)->buf_used;
    s->stats.bytes_on_disk += lane_of(s)->buf_used;
    lane_of(s)->buf_used = 0;
    s->stats.flushes++;
    lane_of(s)->pending_sync = 1;
    if (lane_of(s)->size >= s->block_size) {
        return close_write_fd(s);
    }
    return S3DFS_OK;
}

static int flush_buffer_unlocked(s3dfs_store *s)
{
    int rc = flush_bytes_unlocked(s);
    if (rc != S3DFS_OK) {
        return rc;
    }
    return page_flush_dirty(s);
}

static int ensure_writer(s3dfs_store *s, uint32_t need)
{
    if (lane_of(s)->fd >= 0 && lane_of(s)->size + lane_of(s)->buf_used + need > s->block_size) {
        int rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        rc = close_write_fd(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    if (lane_of(s)->fd < 0) {
        uint64_t id = s->next_block_id++;
        if (id == 0) {
            id = s->next_block_id++;
        }
        int rc = open_block_for_write(s, id, 0);
        if (rc != S3DFS_OK) {
            return rc;
        }
        s->stats.block_files++;
    }
    if (lane_of(s)->buf_used + need > s->buffer_size) {
        int rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    return S3DFS_OK;
}

static int page_pwrite(s3dfs_store *s, uint64_t block, uint64_t off, const void *data, uint32_t len)
{
    s3dfs_store_io_begin(s);
    int rc;
    if (lane_of(s)->fd >= 0 && block == lane_of(s)->block_id) {
        rc = pwrite(lane_of(s)->fd, data, len, (off_t)off) == (ssize_t)len ? S3DFS_OK : S3DFS_ERR_IO;
        s3dfs_store_io_end(s);
        return rc;
    }
    char path[4096];
    block_path(s, block, path, sizeof(path));
    int fd = open(path, O_RDWR);
    if (fd < 0) {
        s3dfs_store_io_end(s);
        return S3DFS_ERR_IO;
    }
    rc = pwrite(fd, data, len, (off_t)off) == (ssize_t)len ? S3DFS_OK : S3DFS_ERR_IO;
    close(fd);
    s3dfs_store_io_end(s);
    return rc;
}

static int page_pread(s3dfs_store *s, uint64_t block, uint64_t off, void *data, uint32_t len)
{
    if (lane_of(s)->fd >= 0 && block == lane_of(s)->block_id) {
        if (pread(lane_of(s)->fd, data, len, (off_t)off) != (ssize_t)len) {
            return S3DFS_ERR_IO;
        }
        return S3DFS_OK;
    }
    char path[4096];
    block_path(s, block, path, sizeof(path));
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        return S3DFS_ERR_IO;
    }
    int rc = pread(fd, data, len, (off_t)off) == (ssize_t)len ? S3DFS_OK : S3DFS_ERR_IO;
    close(fd);
    return rc;
}

static int page_prefix(const uint8_t *p, uint32_t n)
{
    return n >= S3DFS_PAGE_TLV && rd_u16(p) == S3DFS_TAG_RECID_V1 && rd_u32(p + 2) == S3DFS_PAGE_LEN;
}

static void page_fill_header(uint8_t *h, uint64_t first, uint64_t next_off)
{
    memset(h, 0, S3DFS_PAGE_HEADER);
    wr_u16(h, S3DFS_TAG_RECID_V1);
    wr_u32(h + 2, S3DFS_PAGE_LEN);
    wr_u64(h + 6, first);
    wr_u32(h + 14, (uint32_t)next_off);
}

static int page_header_ok(const uint8_t *h, uint64_t *first_out)
{
    if (!page_prefix(h, S3DFS_PAGE_HEADER)) {
        return 0;
    }
    if (first_out) {
        *first_out = rd_u64(h + 6);
    }
    return 1;
}

static int page_record_len(s3dfs_store *s, uint64_t block, uint64_t off, uint32_t *len_out)
{
    uint8_t head[8];
    if (!off || page_pread(s, block, off, head, 8) != S3DFS_OK) {
        return -1;
    }
    if (rd_u32(head) != S3DFS_REC_MAGIC) {
        return -1;
    }
    uint32_t total = rd_u32(head + 4);
    if (total < S3DFS_FRAME_OVERHEAD) {
        return -1;
    }
    *len_out = total;
    return 0;
}

static int page_flush_dirty(s3dfs_store *s)
{
    if (!lane_of(s)->page_dirty || !lane_of(s)->page_slots || lane_of(s)->page_cached >= s->page_n) {
        return S3DFS_OK;
    }
    s3dfs_page_ent *page = &s->pages[lane_of(s)->page_cached];
    uint8_t header[S3DFS_PAGE_HEADER];
    page_fill_header(header, page->first_rec_id, page->next_off);
    int rc = page_pwrite(s, page->block_id, page->file_off, header, S3DFS_PAGE_HEADER);
    if (rc != S3DFS_OK) {
        return rc;
    }
    rc = page_pwrite(s, page->block_id, page->file_off + S3DFS_PAGE_HEADER, lane_of(s)->page_slots, S3DFS_PAGE_VALUE);
    if (rc != S3DFS_OK) {
        return rc;
    }
    lane_of(s)->page_dirty = 0;
    lane_of(s)->pending_sync = 1;
    return S3DFS_OK;
}

static int page_cache(s3dfs_store *s, uint32_t index, const uint8_t *slots_or_null)
{
    if (lane_of(s)->page_cached == index && lane_of(s)->page_slots && !slots_or_null) {
        return S3DFS_OK;
    }
    int rc = page_flush_dirty(s);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (!lane_of(s)->page_slots) {
        lane_of(s)->page_slots = (uint8_t *)malloc(S3DFS_PAGE_VALUE);
        if (!lane_of(s)->page_slots) {
            return S3DFS_ERR_NOMEM;
        }
    }
    if (slots_or_null) {
        memcpy(lane_of(s)->page_slots, slots_or_null, S3DFS_PAGE_VALUE);
    } else {
        s3dfs_page_ent *page = &s->pages[index];
        rc = page_pread(s, page->block_id, page->file_off + S3DFS_PAGE_HEADER, lane_of(s)->page_slots, S3DFS_PAGE_VALUE);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    lane_of(s)->page_cached = index;
    lane_of(s)->page_dirty = 0;
    return S3DFS_OK;
}

static int page_push_image(s3dfs_store *s, uint64_t block, uint64_t first, uint64_t file_off, const uint8_t *slots, int dirty)
{
    if (s->page_n == s->page_cap) {
        uint32_t cap = s->page_cap ? s->page_cap * 2 : 8;
        s3dfs_page_ent *nbuf = (s3dfs_page_ent *)realloc(s->pages, cap * sizeof(s3dfs_page_ent));
        if (!nbuf) {
            return S3DFS_ERR_NOMEM;
        }
        s->pages = nbuf;
        s->page_cap = cap;
    }
    uint8_t *copy = (uint8_t *)malloc(S3DFS_PAGE_VALUE);
    if (!copy) {
        return S3DFS_ERR_NOMEM;
    }
    if (slots) {
        memcpy(copy, slots, S3DFS_PAGE_VALUE);
    } else {
        memset(copy, 0, S3DFS_PAGE_VALUE);
    }
    int rc = page_flush_dirty(s);
    if (rc != S3DFS_OK) {
        free(copy);
        return rc;
    }
    free(lane_of(s)->page_slots);
    lane_of(s)->page_slots = copy;
    s3dfs_page_ent *page = &s->pages[s->page_n];
    page->block_id = block;
    page->first_rec_id = first;
    page->file_off = file_off;
    page->next_off = 0;
    page->src_block = 0;
    page->filled = 0;
    if (slots) {
        for (uint32_t i = S3DFS_PAGE_DATA; i > 0; i--) {
            if (rd_u32(slots + (i - 1) * S3DFS_PAGE_SLOT) != 0) {
                page->filled = i;
                break;
            }
        }
    }
    lane_of(s)->page_cached = s->page_n;
    lane_of(s)->page_index = s->page_n;
    lane_of(s)->fresh_page = 0;
    s->page_n++;
    lane_of(s)->page_dirty = dirty;
    if (dirty) {
        return page_flush_dirty(s);
    }
    return S3DFS_OK;
}

static int page_write_new(s3dfs_store *s, uint64_t first, uint64_t at)
{
    uint8_t *image = (uint8_t *)calloc(1, S3DFS_PAGE_ON_DISK);
    if (!image) {
        return S3DFS_ERR_NOMEM;
    }
    page_fill_header(image, first, 0);
    int rc = page_pwrite(s, lane_of(s)->block_id, at, image, S3DFS_PAGE_ON_DISK);
    if (rc != S3DFS_OK) {
        free(image);
        return rc;
    }
    rc = page_push_image(s, lane_of(s)->block_id, first, at, image + S3DFS_PAGE_HEADER, 0);
    free(image);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (at == lane_of(s)->size) {
        lane_of(s)->size += S3DFS_PAGE_ON_DISK;
        s->stats.bytes_on_disk += S3DFS_PAGE_ON_DISK;
    }
    lane_of(s)->pending_sync = 1;
    return S3DFS_OK;
}

static int page_link_prev(s3dfs_store *s, uint32_t prev_index, uint64_t next_off)
{
    s3dfs_page_ent *prev = &s->pages[prev_index];
    if (next_off > UINT32_MAX) {
        return S3DFS_ERR_ARGS;
    }
    prev->next_off = next_off;
    uint8_t raw[4];
    wr_u32(raw, (uint32_t)next_off);
    return page_pwrite(s, prev->block_id, prev->file_off + 14, raw, 4);
}

static int page_reserve(s3dfs_store *s, uint64_t rec_id, uint32_t obj_total)
{
    s3dfs_lane *w = lane_of(s);
    s3dfs_page_ent *cur = (w->page_index != UINT32_MAX && w->page_index < s->page_n) ? &s->pages[w->page_index] : NULL;
    int reuse = !w->fresh_page && cur && w->fd >= 0 && cur->block_id == w->block_id && cur->filled < S3DFS_PAGE_DATA &&
                cur->first_rec_id + cur->filled == rec_id;
    if (reuse) {
        if (lane_of(s)->size + lane_of(s)->buf_used + obj_total <= s->block_size) {
            return S3DFS_OK;
        }
        int rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        rc = close_write_fd(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
    } else if (lane_of(s)->buf_used) {
        int rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    if (S3DFS_PAGE_ON_DISK + (uint64_t)obj_total > s->block_size) {
        return S3DFS_ERR_ARGS;
    }
    if (lane_of(s)->fd >= 0 && lane_of(s)->size + S3DFS_PAGE_ON_DISK + obj_total > s->block_size) {
        int rc = close_write_fd(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    if (lane_of(s)->fd < 0) {
        uint64_t id = s->next_block_id++;
        if (id == 0) {
            id = s->next_block_id++;
        }
        int rc = open_block_for_write(s, id, 0);
        if (rc != S3DFS_OK) {
            return rc;
        }
        s->stats.block_files++;
        return page_write_new(s, rec_id, 0);
    }
    uint64_t at = lane_of(s)->size;
    uint32_t prev = lane_of(s)->page_index;
    int rc = page_write_new(s, rec_id, at);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (prev != UINT32_MAX && s->pages[prev].block_id == lane_of(s)->block_id) {
        return page_link_prev(s, prev, at);
    }
    return S3DFS_OK;
}

static int page_find(s3dfs_store *s, uint64_t rec_id, uint32_t *index_out, uint32_t *slot_out)
{
    for (uint32_t i = s->page_n; i > 0; i--) {
        s3dfs_page_ent *page = &s->pages[i - 1];
        if (rec_id < page->first_rec_id) {
            continue;
        }
        uint64_t slot = rec_id - page->first_rec_id;
        if (slot < S3DFS_PAGE_DATA && slot < page->filled) {
            *index_out = i - 1;
            *slot_out = (uint32_t)slot;
            return 0;
        }
    }
    return -1;
}

static int page_store_slot(s3dfs_store *s, uint32_t index, uint32_t slot)
{
    if (!lane_of(s)->page_slots || lane_of(s)->page_cached != index || index >= s->page_n || slot >= S3DFS_PAGE_DATA) {
        return S3DFS_ERR_IO;
    }
    s3dfs_page_ent *page = &s->pages[index];
    uint8_t raw[4];
    memcpy(raw, lane_of(s)->page_slots + (size_t)slot * S3DFS_PAGE_SLOT, 4);
    uint64_t at = page->file_off + S3DFS_PAGE_HEADER + (uint64_t)slot * S3DFS_PAGE_SLOT;
    uint64_t slot_t0 = mono_us();
    int rc = page_pwrite(s, page->block_id, at, raw, 4);
    s3dfs_stat_add(&s->stats.slot_us, &s->stats.slot_max_us, &s->stats.slot_writes, mono_us() - slot_t0);
    if (rc != S3DFS_OK) {
        return rc;
    }
    lane_of(s)->page_dirty = 0;
    lane_of(s)->pending_sync = 1;
    return S3DFS_OK;
}

static int page_note(s3dfs_store *s, uint64_t rec_id, uint64_t block, uint64_t off, uint32_t rec_len)
{
    uint32_t index = 0, slot = 0;
    if (page_find(s, rec_id, &index, &slot) != 0) {
        if (lane_of(s)->page_index == UINT32_MAX || lane_of(s)->page_index >= s->page_n) {
            return S3DFS_ERR_IO;
        }
        s3dfs_page_ent *page = &s->pages[lane_of(s)->page_index];
        if (rec_id < page->first_rec_id || rec_id >= page->first_rec_id + S3DFS_PAGE_DATA) {
            return S3DFS_ERR_IO;
        }
        index = lane_of(s)->page_index;
        slot = (uint32_t)(rec_id - page->first_rec_id);
    }
    int rc = page_cache(s, index, NULL);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (off == 0 || off > UINT32_MAX || block != s->pages[index].block_id) {
        return S3DFS_ERR_IO;
    }
    (void)rec_len;
    wr_u32(lane_of(s)->page_slots + slot * S3DFS_PAGE_SLOT, (uint32_t)off);
    if (s->pages[index].filled < slot + 1) {
        s->pages[index].filled = slot + 1;
    }
    lane_of(s)->page_dirty = 1;
    s->stats.index_slots++;
    if (lane_of(s)->buf_used) {
        rc = flush_bytes_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    return page_store_slot(s, index, slot);
}

static int page_lookup(s3dfs_store *s, uint64_t rec_id, s3dfs_rec_ent *out)
{
    uint32_t index = 0, slot = 0;
    if (!rec_id || page_find(s, rec_id, &index, &slot) != 0) {
        return -1;
    }
    uint8_t raw[S3DFS_PAGE_SLOT];
    s3dfs_page_ent *page = &s->pages[index];
    uint64_t block = page->block_id;
    if (page->src_block && s->compact_slots && s->compact_slots[index]) {
        memcpy(raw, s->compact_slots[index] + slot * S3DFS_PAGE_SLOT, S3DFS_PAGE_SLOT);
        block = page->src_block;
    } else if (lane_of(s)->page_slots && lane_of(s)->page_cached == index) {
        memcpy(raw, lane_of(s)->page_slots + slot * S3DFS_PAGE_SLOT, S3DFS_PAGE_SLOT);
    } else if (page_pread(s, page->block_id, page->file_off + S3DFS_PAGE_HEADER + (uint64_t)slot * S3DFS_PAGE_SLOT, raw,
                          S3DFS_PAGE_SLOT) != S3DFS_OK) {
        return -1;
    }
    uint64_t off = rd_u32(raw);
    if (!off) {
        return -1;
    }
    uint32_t rec_len = 0;
    if (page_record_len(s, block, off, &rec_len) != 0) {
        return -1;
    }
    if (out) {
        out->state = S3DFS_MAP_LIVE;
        out->rec_id = rec_id;
        out->block_id = block;
        out->offset = off;
        out->rec_len = rec_len;
    }
    return 0;
}

static void page_clear(s3dfs_store *s, uint64_t rec_id)
{
    uint32_t index = 0, slot = 0;
    if (page_find(s, rec_id, &index, &slot) != 0) {
        return;
    }
    if (page_cache(s, index, NULL) != S3DFS_OK) {
        return;
    }
    uint32_t off = rd_u32(lane_of(s)->page_slots + slot * S3DFS_PAGE_SLOT);
    s3dfs_page_ent *page = &s->pages[index];
    uint64_t block = page->src_block ? page->src_block : page->block_id;
    uint32_t rec_len = 0;
    if (off) {
        page_record_len(s, block, off, &rec_len);
    }
    wr_u32(lane_of(s)->page_slots + slot * S3DFS_PAGE_SLOT, 0);
    lane_of(s)->page_dirty = 1;
    if (rec_len) {
        s->dead_bytes += rec_len;
    }
    page_store_slot(s, index, slot);
}

static int pages_load(s3dfs_store *s)
{
    uint64_t *ids = NULL;
    uint32_t n = 0;
    int rc = list_block_ids(s, &ids, &n);
    if (rc != S3DFS_OK) {
        return rc;
    }
    s->next_rec_id = 1;
    for (uint32_t i = 0; i < n; i++) {
        char path[4096];
        block_path(s, ids[i], path, sizeof(path));
        int fd = open(path, O_RDONLY);
        if (fd < 0) {
            free(ids);
            return S3DFS_ERR_IO;
        }
        struct stat st;
        if (fstat(fd, &st) != 0) {
            close(fd);
            free(ids);
            return S3DFS_ERR_IO;
        }
        uint64_t off = 0;
        while ((uint64_t)st.st_size >= off + S3DFS_PAGE_ON_DISK) {
            uint8_t header[S3DFS_PAGE_HEADER];
            if (pread(fd, header, S3DFS_PAGE_HEADER, (off_t)off) != S3DFS_PAGE_HEADER) {
                break;
            }
            uint64_t first = 0;
            if (!page_header_ok(header, &first)) {
                break;
            }
            uint8_t *slots = (uint8_t *)malloc(S3DFS_PAGE_VALUE);
            if (!slots) {
                close(fd);
                free(ids);
                return S3DFS_ERR_NOMEM;
            }
            if (pread(fd, slots, S3DFS_PAGE_VALUE, (off_t)(off + S3DFS_PAGE_HEADER)) != (ssize_t)S3DFS_PAGE_VALUE) {
                free(slots);
                break;
            }
            uint64_t next = rd_u32(header + 14);
            rc = page_push_image(s, ids[i], first, off, slots, 0);
            free(slots);
            if (rc == S3DFS_OK) {
                s->pages[s->page_n - 1].next_off = next;
            }
            if (rc != S3DFS_OK) {
                close(fd);
                free(ids);
                return rc;
            }
            if (s->pages[s->page_n - 1].first_rec_id + S3DFS_PAGE_DATA > s->next_rec_id) {
                s->next_rec_id = s->pages[s->page_n - 1].first_rec_id + S3DFS_PAGE_DATA;
            }
            if (!next || next <= off || next + S3DFS_PAGE_ON_DISK > (uint64_t)st.st_size) {
                break;
            }
            off = next;
        }
        close(fd);
    }
    free(ids);
    if (s->next_rec_id == 0) {
        s->next_rec_id = 1;
    }
    return S3DFS_OK;
}

static int append_raw_unlocked(s3dfs_store *s, const uint8_t *rec, uint32_t total, uint64_t *out_block,
                               uint64_t *out_off)
{
    if (!rec || total < S3DFS_FRAME_OVERHEAD || total > s->block_size) {
        return S3DFS_ERR_ARGS;
    }
    int rc = ensure_writer(s, total <= s->buffer_size ? total : 0);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (total > s->buffer_size) {
        rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        rc = ensure_writer(s, total);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    uint64_t offset = lane_of(s)->size + lane_of(s)->buf_used;
    if (total <= s->buffer_size - lane_of(s)->buf_used) {
        memcpy(lane_of(s)->buf + lane_of(s)->buf_used, rec, total);
        lane_of(s)->buf_used += total;
    } else {
        rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        rc = ensure_writer(s, total);
        if (rc != S3DFS_OK) {
            return rc;
        }
        offset = lane_of(s)->size + lane_of(s)->buf_used;
        if (total <= s->buffer_size - lane_of(s)->buf_used) {
            memcpy(lane_of(s)->buf + lane_of(s)->buf_used, rec, total);
            lane_of(s)->buf_used += total;
        } else {
            uint64_t body_t0 = mono_us();
            s3dfs_store_io_begin(s);
            int wrote = (lane_of(s)->fd < 0) ? -1 : pwrite_fully(lane_of(s)->fd, rec, total, (off_t)lane_of(s)->size);
            s3dfs_store_io_end(s);
            s3dfs_stat_add(&s->stats.body_us, &s->stats.body_max_us, &s->stats.body_writes, mono_us() - body_t0);
            if (wrote != 0) {
                return S3DFS_ERR_IO;
            }
            lane_of(s)->size += total;
            s->stats.bytes_on_disk += total;
            s->stats.flushes++;
            lane_of(s)->pending_sync = 1;
        }
    }
    if (out_block) {
        *out_block = lane_of(s)->block_id;
    }
    if (out_off) {
        *out_off = offset;
    }
    return S3DFS_OK;
}

static int append_record(s3dfs_store *s, const char *key, uint32_t key_len, const void *value,
                         uint32_t value_len, uint8_t kind, uint64_t rec_id, uint32_t crc, uint64_t mtime_ms,
                         const s3dfs_ext_link *link, const s3dfs_put_meta *meta, uint64_t *out_block,
                         uint64_t *out_off, uint32_t *out_rec_len)
{
    int chained = (kind == S3DFS_KIND_EXTENT || kind == S3DFS_KIND_EXTENT_LAST);
    int with_meta = (meta && meta->has_meta && kind != S3DFS_KIND_EXTENT) ? 1 : 0;
    if (chained && !link) {
        return S3DFS_ERR_ARGS;
    }
    uint32_t total = rec_overhead(key_len, value_len, chained, with_meta);
    if (total < rec_overhead(key_len, 0, chained, with_meta) || total > s->block_size) {
        return S3DFS_ERR_ARGS;
    }
    int rc = page_reserve(s, rec_id, total);
    if (rc != S3DFS_OK) {
        return rc;
    }
    rc = ensure_writer(s, total <= s->buffer_size ? total : 0);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (total > s->buffer_size) {
        rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        rc = ensure_writer(s, total);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }

    uint64_t offset = lane_of(s)->size + lane_of(s)->buf_used;
    if (total <= s->buffer_size - lane_of(s)->buf_used) {
        if (build_record(lane_of(s)->buf + lane_of(s)->buf_used, total, key, key_len, value, value_len, kind, rec_id, crc,
                         mtime_ms, link, meta) != 0) {
            return S3DFS_ERR;
        }
        lane_of(s)->buf_used += total;
    } else {
        uint8_t *tmp = (uint8_t *)malloc(total);
        if (!tmp) {
            return S3DFS_ERR_NOMEM;
        }
        if (build_record(tmp, total, key, key_len, value, value_len, kind, rec_id, crc, mtime_ms, link,
                         meta) != 0) {
            free(tmp);
            return S3DFS_ERR;
        }
        uint64_t body_t0 = mono_us();
        s3dfs_store_io_begin(s);
        int wrote = (lane_of(s)->fd < 0) ? -1 : pwrite_fully(lane_of(s)->fd, tmp, total, (off_t)lane_of(s)->size);
        s3dfs_store_io_end(s);
        s3dfs_stat_add(&s->stats.body_us, &s->stats.body_max_us, &s->stats.body_writes, mono_us() - body_t0);
        if (wrote != 0) {
            free(tmp);
            return S3DFS_ERR_IO;
        }
        free(tmp);
        lane_of(s)->size += total;
        s->stats.bytes_on_disk += total;
        s->stats.flushes++;
        lane_of(s)->pending_sync = 1;
    }

    if (out_block) {
        *out_block = lane_of(s)->block_id;
    }
    if (out_off) {
        *out_off = offset;
    }
    if (out_rec_len) {
        *out_rec_len = total;
    }
    if (rec_id) {
        rc = page_note(s, rec_id, lane_of(s)->block_id, offset, total);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    return S3DFS_OK;
}

static void fill_locator(s3dfs_locator *out, uint8_t kind, uint32_t crc, uint64_t mtime, uint64_t size,
                         uint64_t gen, uint32_t extent_count, uint64_t rec_id, uint64_t block, uint64_t off,
                         uint32_t rec_len, const s3dfs_put_meta *meta)
{
    memset(out, 0, sizeof(*out));
    out->chained = (kind == S3DFS_KIND_EXTENT || kind == S3DFS_KIND_EXTENT_LAST) ? 1 : 0;
    out->tombstone = (kind == S3DFS_KIND_TOMBSTONE) ? 1 : 0;
    out->crc = crc;
    out->mtime_ms = mtime;
    out->size = size;
    out->generation = gen;
    out->extent_count = extent_count ? extent_count : 1;
    out->rec_id = rec_id;
    out->block_id = block;
    out->offset = off;
    out->rec_len = rec_len;
    if (meta && meta->has_meta) {
        out->compress_type = meta->compress_type;
        out->orig_size = meta->orig_size;
        out->orig_crc = meta->orig_crc;
    }
}

static uint32_t count_extents(uint32_t value_len, uint32_t key_len, uint64_t remain, uint64_t block_size,
                              int with_meta)
{
    uint32_t mid = rec_overhead(key_len, 0, 1, 0);
    uint32_t last = rec_overhead(key_len, 0, 1, with_meta);
    if (block_size <= mid || block_size <= last) {
        return 0;
    }
    uint32_t n = 0;
    uint32_t left = value_len;
    uint64_t r = remain;
    while (left) {
        int is_last_candidate = 1;
        uint32_t overhead = is_last_candidate ? last : mid;
        if (r <= overhead) {
            r = block_size;
        }
        /* If the remaining payload plus last-record overhead fits, this is the last extent. */
        uint32_t oh = (left + last <= r || left + last <= block_size) ? last : mid;
        if (r <= oh) {
            r = block_size;
            oh = (left + last <= r) ? last : mid;
        }
        uint64_t room = r - oh;
        uint32_t chunk = left <= room ? left : (uint32_t)room;
        if (chunk == 0) {
            return 0;
        }
        left -= chunk;
        r = block_size;
        n++;
        if (n > S3DFS_MAX_EXTENTS) {
            return 0;
        }
    }
    return n;
}

static uint64_t lane_alloc_rec(s3dfs_store *s)
{
    s3dfs_lane *w = lane_of(s);
    if (w->rec_cursor && w->rec_cursor < w->rec_end) {
        return w->rec_cursor++;
    }
    uint64_t first = s->next_rec_id ? s->next_rec_id : 1;
    s->next_rec_id = first + S3DFS_PAGE_DATA;
    w->rec_cursor = first + 1;
    w->rec_end = first + S3DFS_PAGE_DATA;
    w->fresh_page = 1;
    return first;
}

static int put_object_unlocked(s3dfs_store *s, const char *key, uint32_t key_len, const void *value,
                               uint32_t value_len, uint32_t crc, uint64_t mtime, const s3dfs_put_meta *meta,
                               s3dfs_locator *out)
{
    s3dfs_key_ent existing;
    if (key_map_get(s, key, key_len, &existing) == 0 && existing.rec_id &&
        existing.kind != S3DFS_KIND_TOMBSTONE) {
        retire_chain_unlocked(s, existing.rec_id);
        s->tickets++;
    }
    int with_meta = (meta && meta->has_meta) ? 1 : 0;
    uint32_t simple = rec_overhead(key_len, value_len, 0, with_meta);
    int page_ready = 0;
    if (s->page_n && lane_of(s)->fd >= 0) {
        s3dfs_page_ent *tail = &s->pages[s->page_n - 1];
        page_ready = tail->block_id == lane_of(s)->block_id && tail->filled < S3DFS_PAGE_DATA;
    }
    uint64_t page_need = page_ready ? 0 : S3DFS_PAGE_ON_DISK;
    uint64_t used = (lane_of(s)->fd >= 0) ? (lane_of(s)->size + lane_of(s)->buf_used) : 0;
    uint64_t remain = 0;
    if (lane_of(s)->fd < 0) {
        remain = s->block_size > page_need ? s->block_size - page_need : 0;
    } else if (used + page_need < s->block_size) {
        remain = s->block_size - used - page_need;
    }

    if (simple <= s->block_size && simple <= remain) {
        uint64_t block = 0, off = 0;
        uint32_t rec_len = 0;
        uint64_t rec_id = lane_alloc_rec(s);
        int rc = append_record(s, key, key_len, value, value_len, S3DFS_KIND_OBJECT, rec_id, crc, mtime, NULL,
                               meta, &block, &off, &rec_len);
        if (rc != S3DFS_OK) {
            return rc;
        }
        if (key_map_put(s, key, key_len, rec_id, S3DFS_KIND_OBJECT) != 0) {
            return S3DFS_ERR_NOMEM;
        }
        fill_locator(out, S3DFS_KIND_OBJECT, crc, mtime, value_len, 0, 1, rec_id, block, off, rec_len, meta);
        return S3DFS_OK;
    }

    uint32_t mid_oh = rec_overhead(key_len, 0, 1, 0);
    if (s->block_size <= mid_oh) {
        return S3DFS_ERR_ARGS;
    }
    if (remain <= mid_oh) {
        int rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        rc = close_write_fd(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        remain = s->block_size > S3DFS_PAGE_ON_DISK ? s->block_size - S3DFS_PAGE_ON_DISK : 0;
        if (simple <= remain) {
            uint64_t block = 0, off = 0;
            uint32_t rec_len = 0;
            uint64_t rec_id = lane_alloc_rec(s);
            rc = append_record(s, key, key_len, value, value_len, S3DFS_KIND_OBJECT, rec_id, crc, mtime, NULL,
                               meta, &block, &off, &rec_len);
            if (rc != S3DFS_OK) {
                return rc;
            }
            if (key_map_put(s, key, key_len, rec_id, S3DFS_KIND_OBJECT) != 0) {
                return S3DFS_ERR_NOMEM;
            }
            fill_locator(out, S3DFS_KIND_OBJECT, crc, mtime, value_len, 0, 1, rec_id, block, off, rec_len, meta);
            return S3DFS_OK;
        }
    }

    uint32_t n_ext = count_extents(value_len, key_len, remain, s->block_size, with_meta);
    if (n_ext == 0) {
        return S3DFS_ERR_ARGS;
    }

    uint64_t gen = ++s->put_generation;
    s3dfs_ext_link prev;
    memset(&prev, 0, sizeof(prev));
    const uint8_t *src = (const uint8_t *)value;
    uint32_t left = value_len;
    uint32_t seq = 0;
    uint64_t last_block = 0, last_off = 0, last_rec_id = 0;
    uint32_t last_rec_len = 0;

    while (left) {
        used = (lane_of(s)->fd >= 0) ? (lane_of(s)->size + lane_of(s)->buf_used) : 0;
        page_ready = 0;
        if (s->page_n && lane_of(s)->fd >= 0) {
            s3dfs_page_ent *tail = &s->pages[s->page_n - 1];
            page_ready = tail->block_id == lane_of(s)->block_id && tail->filled < S3DFS_PAGE_DATA;
        }
        page_need = page_ready ? 0 : S3DFS_PAGE_ON_DISK;
        if (lane_of(s)->fd < 0) {
            remain = s->block_size > page_need ? s->block_size - page_need : 0;
        } else if (used + page_need < s->block_size) {
            remain = s->block_size - used - page_need;
        } else {
            remain = 0;
        }
        int is_last = 0;
        uint32_t last_oh = rec_overhead(key_len, left, 1, with_meta);
        uint32_t mid = rec_overhead(key_len, 0, 1, 0);
        if (remain >= last_oh) {
            is_last = 1;
        } else if (remain <= mid) {
            int rc = flush_buffer_unlocked(s);
            if (rc != S3DFS_OK) {
                return rc;
            }
            rc = close_write_fd(s);
            if (rc != S3DFS_OK) {
                return rc;
            }
            remain = s->block_size > S3DFS_PAGE_ON_DISK ? s->block_size - S3DFS_PAGE_ON_DISK : 0;
            is_last = (remain >= last_oh);
        }
        uint32_t oh = is_last ? rec_overhead(key_len, 0, 1, with_meta) : mid;
        if (remain <= oh) {
            int rc = flush_buffer_unlocked(s);
            if (rc != S3DFS_OK) {
                return rc;
            }
            rc = close_write_fd(s);
            if (rc != S3DFS_OK) {
                return rc;
            }
            remain = s->block_size > S3DFS_PAGE_ON_DISK ? s->block_size - S3DFS_PAGE_ON_DISK : 0;
            is_last = (remain >= last_oh);
            oh = is_last ? rec_overhead(key_len, 0, 1, with_meta) : mid;
        }
        uint64_t room = remain - oh;
        uint32_t chunk = left <= room ? left : (uint32_t)room;
        is_last = (chunk == left);
        s3dfs_ext_link link = prev;
        link.seq = seq;
        link.generation = gen;
        link.total_size = value_len;
        link.extent_count = n_ext;
        uint8_t kind = is_last ? (uint8_t)S3DFS_KIND_EXTENT_LAST : (uint8_t)S3DFS_KIND_EXTENT;
        uint64_t block = 0, off = 0;
        uint32_t rec_len = 0;
        uint64_t rec_id = lane_alloc_rec(s);
        int rc = append_record(s, key, key_len, src, chunk, kind, rec_id, is_last ? crc : 0, mtime, &link,
                               is_last ? meta : NULL, &block, &off, &rec_len);
        if (rc != S3DFS_OK) {
            return rc;
        }
        memset(&prev, 0, sizeof(prev));
        prev.prev_rec_id = rec_id;
        last_block = block;
        last_off = off;
        last_rec_len = rec_len;
        last_rec_id = rec_id;
        src += chunk;
        left -= chunk;
        seq++;
    }

    if (key_map_put(s, key, key_len, last_rec_id, S3DFS_KIND_EXTENT_LAST) != 0) {
        return S3DFS_ERR_NOMEM;
    }
    fill_locator(out, S3DFS_KIND_EXTENT_LAST, crc, mtime, value_len, gen, n_ext, last_rec_id, last_block,
                 last_off, last_rec_len, meta);
    return S3DFS_OK;
}

static int load_bytes(s3dfs_store *s, uint64_t block_id, uint64_t offset, uint32_t rec_len, uint8_t **out)
{
    if (rec_len < S3DFS_FRAME_OVERHEAD) {
        return S3DFS_ERR_IO;
    }
    uint8_t *tmp = (uint8_t *)malloc(rec_len);
    if (!tmp) {
        return S3DFS_ERR_NOMEM;
    }
    if (lane_of(s)->fd >= 0 && block_id == lane_of(s)->block_id && offset >= lane_of(s)->size) {
        uint64_t buf_off = offset - lane_of(s)->size;
        if (buf_off + rec_len <= lane_of(s)->buf_used) {
            memcpy(tmp, lane_of(s)->buf + buf_off, rec_len);
            *out = tmp;
            return S3DFS_OK;
        }
        free(tmp);
        return S3DFS_ERR_IO;
    }
    char path[4096];
    block_path(s, block_id, path, sizeof(path));
    int same = (lane_of(s)->fd >= 0 && block_id == lane_of(s)->block_id);
    int fd = same ? lane_of(s)->fd : open(path, O_RDONLY);
    if (fd < 0) {
        free(tmp);
        return S3DFS_ERR_IO;
    }
    if (pread(fd, tmp, rec_len, (off_t)offset) != (ssize_t)rec_len) {
        free(tmp);
        if (!same) {
            close(fd);
        }
        return S3DFS_ERR_IO;
    }
    if (!same) {
        close(fd);
    }
    *out = tmp;
    return S3DFS_OK;
}

static int load_record(s3dfs_store *s, uint64_t block_id, uint64_t offset, uint32_t rec_len, uint8_t **out,
                       s3dfs_rec_view *view)
{
    uint8_t *tmp = NULL;
    int rc = load_bytes(s, block_id, offset, rec_len, &tmp);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (parse_record(tmp, rec_len, view) != 0) {
        free(tmp);
        return S3DFS_ERR_IO;
    }
    *out = tmp;
    return S3DFS_OK;
}

static void retire_chain_unlocked(s3dfs_store *s, uint64_t rec_id)
{
    uint64_t cur = rec_id;
    uint32_t n = 0;
    while (cur && n < S3DFS_MAX_EXTENTS) {
        s3dfs_rec_ent e;
        if (rec_map_get(s, cur, &e) != 0) {
            break;
        }
        uint8_t *raw = NULL;
        s3dfs_rec_view view;
        uint64_t prev = 0;
        if (load_record(s, e.block_id, e.offset, e.rec_len, &raw, &view) == S3DFS_OK) {
            if (view.has_prev) {
                prev = view.prev_rec_id;
            }
            free(raw);
        }
        rec_map_del(s, cur);
        s->dead_bytes += e.rec_len;
        cur = prev;
        n++;
    }
}

static int scan_block_end(s3dfs_store *s, uint64_t id, uint64_t *size_out)
{
    char path[4096];
    block_path(s, id, path, sizeof(path));
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        return S3DFS_ERR_IO;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
        close(fd);
        return S3DFS_ERR_IO;
    }
    uint64_t size = (uint64_t)st.st_size;
    uint64_t off = 0;
    uint8_t *tmp = NULL;
    uint32_t tmp_cap = 0;
    while (off + S3DFS_FRAME_OVERHEAD <= size) {
        uint8_t probe[S3DFS_PAGE_TLV];
        if (off + S3DFS_PAGE_ON_DISK <= size && pread(fd, probe, S3DFS_PAGE_TLV, (off_t)off) == S3DFS_PAGE_TLV &&
            page_prefix(probe, S3DFS_PAGE_TLV)) {
            off += S3DFS_PAGE_ON_DISK;
            continue;
        }
        uint8_t head[8];
        if (pread(fd, head, 8, (off_t)off) != 8) {
            break;
        }
        if (rd_u32(head) != S3DFS_REC_MAGIC) {
            break;
        }
        uint32_t total = rd_u32(head + 4);
        if (total < S3DFS_FRAME_OVERHEAD || off + total > size) {
            break;
        }
        if (total > tmp_cap) {
            uint8_t *nbuf = (uint8_t *)realloc(tmp, total);
            if (!nbuf) {
                free(tmp);
                close(fd);
                return S3DFS_ERR_NOMEM;
            }
            tmp = nbuf;
            tmp_cap = total;
        }
        if (pread(fd, tmp, total, (off_t)off) != (ssize_t)total) {
            break;
        }
        s3dfs_rec_view view;
        if (parse_record(tmp, total, &view) != 0) {
            break;
        }
        off += total;
    }
    free(tmp);
    close(fd);
    *size_out = off;
    return S3DFS_OK;
}

static int recover_writer(s3dfs_store *s)
{
    DIR *d = opendir(s->blocks_dir);
    if (!d) {
        return S3DFS_ERR_IO;
    }
    uint64_t *ids = NULL;
    uint32_t n = 0, cap = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        unsigned long long id = 0;
        if (sscanf(de->d_name, "%020llu.blk", &id) != 1) {
            continue;
        }
        if (n == cap) {
            cap = cap ? cap * 2 : 16;
            uint64_t *p = (uint64_t *)realloc(ids, cap * sizeof(uint64_t));
            if (!p) {
                free(ids);
                closedir(d);
                return S3DFS_ERR_NOMEM;
            }
            ids = p;
        }
        ids[n++] = (uint64_t)id;
    }
    closedir(d);
    if (n > 1) {
        qsort(ids, n, sizeof(uint64_t), cmp_u64);
    }
    s->stats.block_files = n;
    s->stats.bytes_on_disk = 0;
    uint64_t last_id = 0, last_size = 0;
    for (uint32_t i = 0; i < n; i++) {
        char path[4096];
        block_path(s, ids[i], path, sizeof(path));
        struct stat st;
        if (stat(path, &st) != 0) {
            free(ids);
            return S3DFS_ERR_IO;
        }
        uint64_t sz = (uint64_t)st.st_size;
        s->stats.bytes_on_disk += sz;
        last_id = ids[i];
        last_size = sz;
    }
    free(ids);
    s->next_block_id = last_id ? last_id + 1 : 1;
    if (s->nlanes <= 1 && last_id && last_size > 0 && last_size < s->block_size) {
        return open_block_for_write(s, last_id, last_size);
    }
    return S3DFS_OK;
}

s3dfs_store *s3dfs_open(const char *data_dir, const s3dfs_options *opt)
{
    if (!data_dir || !data_dir[0]) {
        return NULL;
    }
    crc32_init();
    s3dfs_store *s = (s3dfs_store *)calloc(1, sizeof(*s));
    if (!s) {
        return NULL;
    }
    snprintf(s->data_dir, sizeof(s->data_dir), "%s", data_dir);
    snprintf(s->blocks_dir, sizeof(s->blocks_dir), "%s/blocks", data_dir);
    s->block_size = (opt && opt->block_size) ? opt->block_size : S3DFS_DEFAULT_BLOCK_SIZE;
    s->buffer_size = (opt && opt->buffer_size) ? opt->buffer_size : S3DFS_DEFAULT_BUFFER_SIZE;
    if (s->buffer_size < S3DFS_MIN_BUFFER_SIZE) {
        s->buffer_size = S3DFS_MIN_BUFFER_SIZE;
    }
    s->fsync_on_flush = (!opt || opt->fsync_on_flush) ? 1 : 0;
    s->next_rec_id = 1;
    s->next_block_id = 1;
    pthread_mutex_init(&s->mu, NULL);
    uint32_t writers = (opt && opt->writers > 0) ? (uint32_t)opt->writers : 8;
    if (s3dfs_lanes_init(s, writers) != 0 || maps_init(s) != 0 || mkdir_p(s->data_dir) != 0 ||
        mkdir_p(s->blocks_dir) != 0 || recover_writer(s) != S3DFS_OK || pages_load(s) != S3DFS_OK) {
        s3dfs_close(s);
        return NULL;
    }
    if (s->nlanes == 1 && s->lanes[0].fd >= 0) {
        s3dfs_lane *w = &s->lanes[0];
        for (uint32_t i = s->page_n; i > 0; i--) {
            if (s->pages[i - 1].block_id == w->block_id) {
                w->page_index = i - 1;
                w->rec_cursor = s->pages[i - 1].first_rec_id + s->pages[i - 1].filled;
                w->rec_end = s->pages[i - 1].first_rec_id + S3DFS_PAGE_DATA;
                if (w->rec_cursor == 0) {
                    w->rec_cursor = 1;
                }
                break;
            }
        }
    }
    if (s3dfs_lanes_start(s) != 0) {
        s3dfs_close(s);
        return NULL;
    }
    return s;
}

static void close_flush_job(void *arg)
{
    s3dfs_store *s = (s3dfs_store *)arg;
    s3dfs_store_lock(s);
    flush_buffer_unlocked(s);
    close_write_fd(s);
    s3dfs_store_unlock(s);
}

void s3dfs_close(s3dfs_store *s)
{
    if (!s) {
        return;
    }
    if (s->lanes && s->lanes[0].started) {
        s3dfs_lane_call_all(s, close_flush_job, s);
    }
    s3dfs_lanes_stop(s);
    maps_free(s);
    pthread_mutex_destroy(&s->mu);
    free(s);
}

typedef struct {
    s3dfs_store *s;
    const char *key;
    uint32_t key_len;
    const void *value;
    uint32_t value_len;
    const s3dfs_put_meta *meta;
    s3dfs_locator *out;
    int rc;
} put_job_arg;

static int put_on_lane(s3dfs_store *s, const char *key, uint32_t key_len, const void *value, uint32_t value_len,
                       const s3dfs_put_meta *meta, s3dfs_locator *out)
{
    uint64_t mtime = now_ms();
    uint32_t crc = crc32_key_value(key, key_len, value, value_len);
    s3dfs_locator loc;
    memset(&loc, 0, sizeof(loc));
    uint64_t t0 = mono_us();
    s3dfs_store_lock(s);
    uint64_t t1 = mono_us();
    int rc = put_object_unlocked(s, key, key_len, value, value_len, crc, mtime, meta, &loc);
    if (rc == S3DFS_OK) {
        s->stats.puts++;
        s->stats.bytes_logical += value_len;
    }
    note_us(&s->stats.put_wait_us, &s->stats.put_wait_max_us, t1 - t0);
    note_us(&s->stats.put_hold_us, &s->stats.put_hold_max_us, mono_us() - t1);
    s3dfs_store_unlock(s);
    if (rc == S3DFS_OK && out) {
        *out = loc;
    }
    return rc;
}

static void put_job(void *arg)
{
    put_job_arg *job = (put_job_arg *)arg;
    job->rc = put_on_lane(job->s, job->key, job->key_len, job->value, job->value_len, job->meta, job->out);
}

int s3dfs_put(s3dfs_store *s, const char *key, uint32_t key_len, const void *value, uint32_t value_len,
              const s3dfs_put_meta *meta, s3dfs_locator *out)
{
    if (!s || !key || key_len == 0) {
        return S3DFS_ERR_ARGS;
    }
    put_job_arg job;
    memset(&job, 0, sizeof(job));
    job.s = s;
    job.key = key;
    job.key_len = key_len;
    job.value = value;
    job.value_len = value_len;
    job.meta = meta;
    job.out = out;
    s3dfs_lane_call(s, key, key_len, put_job, &job);
    return job.rc;
}

int s3dfs_put_batch(s3dfs_store *s, const s3dfs_put_item *items, uint32_t n, const s3dfs_put_meta *meta,
                    s3dfs_locator *out)
{
    if (!s || (n > 0 && !items)) {
        return S3DFS_ERR_ARGS;
    }
    int rc = S3DFS_OK;
    for (uint32_t i = 0; i < n; i++) {
        if (!items[i].key || items[i].key_len == 0) {
            rc = S3DFS_ERR_ARGS;
            break;
        }
        s3dfs_locator loc;
        memset(&loc, 0, sizeof(loc));
        rc = s3dfs_put(s, items[i].key, items[i].key_len, items[i].value, items[i].value_len, meta, out ? &loc : NULL);
        if (rc != S3DFS_OK) {
            break;
        }
        if (out) {
            out[i] = loc;
        }
    }
    return rc;
}

typedef struct {
    s3dfs_store *s;
    const char *key;
    uint32_t key_len;
    int rc;
} tomb_job_arg;

static void tomb_job(void *arg)
{
    tomb_job_arg *job = (tomb_job_arg *)arg;
    job->rc = s3dfs_tombstone(job->s, job->key, job->key_len);
}

int s3dfs_tombstone(s3dfs_store *s, const char *key, uint32_t key_len)
{
    if (!s || !key || key_len == 0) {
        return S3DFS_ERR_ARGS;
    }
    if (!s3dfs_tls_lane) {
        tomb_job_arg job;
        job.s = s;
        job.key = key;
        job.key_len = key_len;
        job.rc = 0;
        s3dfs_lane_call(s, key, key_len, tomb_job, &job);
        return job.rc;
    }
    uint64_t mtime = now_ms();
    s3dfs_store_lock(s);
    s3dfs_key_ent existing;
    if (key_map_get(s, key, key_len, &existing) == 0 && existing.rec_id &&
        existing.kind != S3DFS_KIND_TOMBSTONE) {
        retire_chain_unlocked(s, existing.rec_id);
    }
    uint64_t rec_id = lane_alloc_rec(s);
    int rc = append_record(s, key, key_len, NULL, 0, S3DFS_KIND_TOMBSTONE, rec_id, 0, mtime, NULL, NULL, NULL,
                           NULL, NULL);
    if (rc == S3DFS_OK) {
        s->stats.deletes++;
        s->tickets++;
        /* The tombstone record itself is dead payload once compact runs. */
        if (key_map_put(s, key, key_len, rec_id, S3DFS_KIND_TOMBSTONE) != 0) {
            s3dfs_store_unlock(s);
            return S3DFS_ERR_NOMEM;
        }
    }
    s3dfs_store_unlock(s);
    return rc;
}
static int walk_chain(s3dfs_store *s, const s3dfs_locator *loc, const char *key, uint32_t key_len,
                      uint64_t **blocks_out, uint64_t **offs_out, uint32_t **rec_lens_out,
                      uint32_t **val_lens_out, uint32_t *n_out)
{
    uint32_t cap = loc->extent_count ? loc->extent_count : 8;
    if (cap > S3DFS_MAX_EXTENTS) {
        return S3DFS_ERR;
    }
    uint64_t *blocks = (uint64_t *)malloc(cap * sizeof(uint64_t));
    uint64_t *offs = (uint64_t *)malloc(cap * sizeof(uint64_t));
    uint32_t *rec_lens = (uint32_t *)malloc(cap * sizeof(uint32_t));
    uint32_t *val_lens = (uint32_t *)malloc(cap * sizeof(uint32_t));
    if (!blocks || !offs || !rec_lens || !val_lens) {
        free(blocks);
        free(offs);
        free(rec_lens);
        free(val_lens);
        return S3DFS_ERR_NOMEM;
    }

    if (!loc->rec_id) {
        free(blocks);
        free(offs);
        free(rec_lens);
        free(val_lens);
        return S3DFS_ERR_ARGS;
    }
    s3dfs_rec_ent ent;
    if (rec_map_get(s, loc->rec_id, &ent) != 0) {
        free(blocks);
        free(offs);
        free(rec_lens);
        free(val_lens);
        return S3DFS_ERR_NOT_FOUND;
    }
    uint64_t block = ent.block_id;
    uint64_t off = ent.offset;
    uint32_t rec_len = ent.rec_len;
    uint32_t n = 0;
    while (1) {
        if (n >= S3DFS_MAX_EXTENTS) {
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return S3DFS_ERR;
        }
        if (n == cap) {
            uint32_t ncap = cap * 2;
            uint64_t *nb = (uint64_t *)realloc(blocks, ncap * sizeof(uint64_t));
            uint64_t *no = (uint64_t *)realloc(offs, ncap * sizeof(uint64_t));
            uint32_t *nr = (uint32_t *)realloc(rec_lens, ncap * sizeof(uint32_t));
            uint32_t *nv = (uint32_t *)realloc(val_lens, ncap * sizeof(uint32_t));
            if (!nb || !no || !nr || !nv) {
                free(nb ? nb : blocks);
                free(no ? no : offs);
                free(nr ? nr : rec_lens);
                free(nv ? nv : val_lens);
                return S3DFS_ERR_NOMEM;
            }
            blocks = nb;
            offs = no;
            rec_lens = nr;
            val_lens = nv;
            cap = ncap;
        }
        uint8_t *rec = NULL;
        s3dfs_rec_view view;
        int rc = load_record(s, block, off, rec_len, &rec, &view);
        if (rc != S3DFS_OK) {
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return rc;
        }
        if ((view.kind != S3DFS_KIND_EXTENT && view.kind != S3DFS_KIND_EXTENT_LAST) || view.key_len != key_len ||
            memcmp(view.key, key, key_len) != 0) {
            free(rec);
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return S3DFS_ERR_IO;
        }
        if (loc->generation && view.generation != loc->generation) {
            free(rec);
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return S3DFS_ERR_IO;
        }
        blocks[n] = block;
        offs[n] = off;
        rec_lens[n] = rec_len;
        val_lens[n] = view.value_len;
        n++;
        uint64_t next_id = view.prev_rec_id;
        int has_prev = view.has_prev && view.prev_rec_id != 0;
        free(rec);
        if (!has_prev) {
            break;
        }
        if (rec_map_get(s, next_id, &ent) != 0) {
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return S3DFS_ERR_IO;
        }
        block = ent.block_id;
        off = ent.offset;
        rec_len = ent.rec_len;
    }
    if (loc->extent_count && n != loc->extent_count) {
        free(blocks);
        free(offs);
        free(rec_lens);
        free(val_lens);
        return S3DFS_ERR_IO;
    }
    for (uint32_t i = 0, j = n; i < j; i++, j--) {
        uint32_t b = j - 1;
        uint64_t tb = blocks[i];
        blocks[i] = blocks[b];
        blocks[b] = tb;
        uint64_t to = offs[i];
        offs[i] = offs[b];
        offs[b] = to;
        uint32_t tr = rec_lens[i];
        rec_lens[i] = rec_lens[b];
        rec_lens[b] = tr;
        uint32_t tv = val_lens[i];
        val_lens[i] = val_lens[b];
        val_lens[b] = tv;
    }
    *blocks_out = blocks;
    *offs_out = offs;
    *rec_lens_out = rec_lens;
    *val_lens_out = val_lens;
    *n_out = n;
    return S3DFS_OK;
}

static int read_value(s3dfs_store *s, const s3dfs_locator *e, const char *key, uint32_t key_len, void **out,
                      uint32_t *out_len)
{
    if (e->size > UINT32_MAX) {
        return S3DFS_ERR_ARGS;
    }
    if (!e->chained) {
        s3dfs_rec_ent ent;
        if (!e->rec_id || rec_map_get(s, e->rec_id, &ent) != 0) {
            return S3DFS_ERR_NOT_FOUND;
        }
        uint32_t rec_len = ent.rec_len;
        uint8_t *tmp = NULL;
        s3dfs_rec_view view;
        int rc = load_record(s, ent.block_id, ent.offset, rec_len, &tmp, &view);
        if (rc != S3DFS_OK) {
            return rc;
        }
        if (view.kind == S3DFS_KIND_TOMBSTONE || view.key_len != key_len || memcmp(view.key, key, key_len) != 0) {
            free(tmp);
            return S3DFS_ERR_NOT_FOUND;
        }
        uint32_t size = view.value_len;
        void *copy = malloc(size ? size : 1);
        if (!copy) {
            free(tmp);
            return S3DFS_ERR_NOMEM;
        }
        if (size && view.value) {
            memcpy(copy, view.value, size);
        }
        free(tmp);
        *out = copy;
        *out_len = size;
        return S3DFS_OK;
    }

    uint32_t size = (uint32_t)e->size;
    uint64_t *blocks = NULL, *offs = NULL;
    uint32_t *rec_lens = NULL, *val_lens = NULL, n = 0;
    int rc = walk_chain(s, e, key, key_len, &blocks, &offs, &rec_lens, &val_lens, &n);
    if (rc != S3DFS_OK) {
        return rc;
    }
    void *copy = malloc(size ? size : 1);
    if (!copy) {
        free(blocks);
        free(offs);
        free(rec_lens);
        free(val_lens);
        return S3DFS_ERR_NOMEM;
    }
    uint32_t copied = 0;
    for (uint32_t i = 0; i < n; i++) {
        uint8_t *rec = NULL;
        s3dfs_rec_view view;
        rc = load_record(s, blocks[i], offs[i], rec_lens[i], &rec, &view);
        if (rc != S3DFS_OK) {
            free(copy);
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return rc;
        }
        uint32_t payload = view.value_len;
        if ((uint64_t)copied + payload > size) {
            free(rec);
            free(copy);
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return S3DFS_ERR_IO;
        }
        if (payload && view.value) {
            memcpy((uint8_t *)copy + copied, view.value, payload);
        }
        copied += payload;
        free(rec);
    }
    free(blocks);
    free(offs);
    free(rec_lens);
    free(val_lens);
    if (copied != size) {
        free(copy);
        return S3DFS_ERR_IO;
    }
    *out = copy;
    *out_len = size;
    return S3DFS_OK;
}

struct s3dfs_writer {
    s3dfs_store *store;
    char *key;
    uint32_t key_len;
    uint32_t crc;
    uint64_t total;
    uint32_t extents;
    uint64_t prev_rec;
    uint32_t seq;
    uint64_t generation;
    uint64_t mtime;
    s3dfs_put_meta meta;
    int alive;
};

typedef struct {
    s3dfs_store *s;
    const char *key;
    uint32_t key_len;
    const s3dfs_put_meta *meta;
    s3dfs_writer *out;
} begin_job_arg;

static void begin_job(void *arg)
{
    begin_job_arg *job = (begin_job_arg *)arg;
    job->out = s3dfs_write_begin(job->s, job->key, job->key_len, job->meta);
}

s3dfs_writer *s3dfs_write_begin(s3dfs_store *s, const char *key, uint32_t key_len, const s3dfs_put_meta *meta)
{
    if (!s || !key || key_len == 0) {
        return NULL;
    }
    if (!s3dfs_tls_lane) {
        begin_job_arg job;
        job.s = s;
        job.key = key;
        job.key_len = key_len;
        job.meta = meta;
        job.out = NULL;
        s3dfs_lane_call(s, key, key_len, begin_job, &job);
        return job.out;
    }
    s3dfs_writer *w = (s3dfs_writer *)calloc(1, sizeof(*w));
    if (!w) {
        return NULL;
    }
    w->key = (char *)malloc(key_len);
    if (!w->key) {
        free(w);
        return NULL;
    }
    memcpy(w->key, key, key_len);
    w->store = s;
    w->key_len = key_len;
    w->crc = crc32_update(0, key, key_len);
    w->mtime = (uint64_t)time(NULL) * 1000;
    if (meta && meta->has_meta) {
        w->meta = *meta;
    }
    s3dfs_store_lock(s);
    s3dfs_key_ent existing;
    if (key_map_get(s, key, key_len, &existing) == 0 && existing.rec_id && existing.kind != S3DFS_KIND_TOMBSTONE) {
        retire_chain_unlocked(s, existing.rec_id);
        s->tickets++;
    }
    w->generation = ++s->put_generation;
    w->alive = 1;
    s3dfs_store_unlock(s);
    return w;
}

typedef struct {
    s3dfs_writer *w;
    const void *data;
    uint32_t len;
    int rc;
} write_job_arg;

static void write_job(void *arg)
{
    write_job_arg *job = (write_job_arg *)arg;
    job->rc = s3dfs_write(job->w, job->data, job->len);
}

int s3dfs_write(s3dfs_writer *w, const void *data, uint32_t len)
{
    if (!w || !w->alive || (!data && len)) {
        return S3DFS_ERR_ARGS;
    }
    if (len == 0) {
        return S3DFS_OK;
    }
    if (!s3dfs_tls_lane) {
        write_job_arg job;
        job.w = w;
        job.data = data;
        job.len = len;
        job.rc = 0;
        s3dfs_lane_call(w->store, w->key, w->key_len, write_job, &job);
        return job.rc;
    }
    s3dfs_store_lock(w->store);
    w->crc = crc32_update(w->crc, data, len);
    s3dfs_ext_link link;
    memset(&link, 0, sizeof(link));
    link.prev_rec_id = w->prev_rec;
    link.seq = w->seq;
    link.generation = w->generation;
    uint64_t block = 0, off = 0;
    uint32_t rec_len = 0;
    uint64_t rec_id = lane_alloc_rec(w->store);
    int rc = append_record(w->store, w->key, w->key_len, data, len, S3DFS_KIND_EXTENT, rec_id, 0, w->mtime, &link,
                           NULL, &block, &off, &rec_len);
    if (rc == S3DFS_OK) {
        w->prev_rec = rec_id;
        w->seq++;
        w->extents++;
        w->total += len;
    }
    s3dfs_store_unlock(w->store);
    return rc;
}

void s3dfs_write_set_meta(s3dfs_writer *w, const s3dfs_put_meta *meta)
{
    if (!w || !w->alive || !meta) {
        return;
    }
    w->meta = *meta;
}

typedef struct {
    s3dfs_writer *w;
    s3dfs_locator *out;
    int rc;
} finish_job_arg;

static void finish_job(void *arg)
{
    finish_job_arg *job = (finish_job_arg *)arg;
    job->rc = s3dfs_write_finish(job->w, job->out);
}

int s3dfs_write_finish(s3dfs_writer *w, s3dfs_locator *out)
{
    if (!w || !w->alive || !out) {
        return S3DFS_ERR_ARGS;
    }
    if (!s3dfs_tls_lane) {
        finish_job_arg job;
        job.w = w;
        job.out = out;
        job.rc = 0;
        s3dfs_lane_call(w->store, w->key, w->key_len, finish_job, &job);
        return job.rc;
    }
    s3dfs_store_lock(w->store);
    uint8_t empty = 0;
    s3dfs_ext_link link;
    memset(&link, 0, sizeof(link));
    link.prev_rec_id = w->prev_rec;
    link.seq = w->seq;
    link.generation = w->generation;
    link.total_size = w->total;
    link.extent_count = w->extents + 1;
    uint64_t block = 0, off = 0;
    uint32_t rec_len = 0;
    uint64_t rec_id = lane_alloc_rec(w->store);
    const s3dfs_put_meta *meta = w->meta.has_meta ? &w->meta : NULL;
    int rc = append_record(w->store, w->key, w->key_len, &empty, 0, S3DFS_KIND_EXTENT_LAST, rec_id, w->crc, w->mtime,
                           &link, meta, &block, &off, &rec_len);
    if (rc == S3DFS_OK) {
        if (key_map_put(w->store, w->key, w->key_len, rec_id, S3DFS_KIND_EXTENT_LAST) != 0) {
            rc = S3DFS_ERR_NOMEM;
        } else {
            w->store->stats.objects++;
            w->store->stats.puts++;
            w->store->stats.bytes_logical += w->total;
            fill_locator(out, S3DFS_KIND_EXTENT_LAST, w->crc, w->mtime, w->total, w->generation, link.extent_count,
                         rec_id, block, off, rec_len, meta);
        }
    }
    s3dfs_store_unlock(w->store);
    w->alive = 0;
    free(w->key);
    free(w);
    return rc;
}

void s3dfs_write_abort(s3dfs_writer *w)
{
    if (!w) {
        return;
    }
    if (w->alive) {
        s3dfs_tombstone(w->store, w->key, w->key_len);
    }
    free(w->key);
    free(w);
}

static int copy_overlap(const uint8_t *value, uint32_t value_len, uint64_t cursor, uint64_t start, uint64_t end,
                        uint8_t *dst)
{
    uint64_t ext_end = cursor + value_len;
    uint64_t from = cursor > start ? cursor : start;
    uint64_t to = ext_end < end ? ext_end : end;
    if (from >= to) {
        return 0;
    }
    memcpy(dst + (from - start), value + (from - cursor), (size_t)(to - from));
    return 1;
}

int s3dfs_read_span(s3dfs_store *s, const char *key, uint32_t key_len, const s3dfs_locator *loc, uint64_t start,
                    uint64_t len, void **out, uint32_t *out_len)
{
    if (!s || !key || !loc || !out || !out_len || loc->rec_id == 0 || loc->tombstone || len > UINT32_MAX) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    uint64_t obj = loc->size;
    if (start >= obj || len == 0) {
        void *empty = malloc(1);
        if (!empty) {
            pthread_mutex_unlock(&s->mu);
            return S3DFS_ERR_NOMEM;
        }
        *out = empty;
        *out_len = 0;
        pthread_mutex_unlock(&s->mu);
        return S3DFS_OK;
    }
    uint64_t end = start + len;
    if (end > obj) {
        end = obj;
    }
    uint32_t need = (uint32_t)(end - start);
    uint8_t *dst = (uint8_t *)malloc(need ? need : 1);
    if (!dst) {
        pthread_mutex_unlock(&s->mu);
        return S3DFS_ERR_NOMEM;
    }
    if (!loc->chained) {
        s3dfs_rec_ent ent;
        if (!loc->rec_id || rec_map_get(s, loc->rec_id, &ent) != 0) {
            free(dst);
            pthread_mutex_unlock(&s->mu);
            return S3DFS_ERR_NOT_FOUND;
        }
        uint8_t *tmp = NULL;
        s3dfs_rec_view view;
        int rc = load_record(s, ent.block_id, ent.offset, ent.rec_len, &tmp, &view);
        if (rc != S3DFS_OK) {
            free(dst);
            pthread_mutex_unlock(&s->mu);
            return rc;
        }
        copy_overlap(view.value, view.value_len, 0, start, end, dst);
        free(tmp);
        *out = dst;
        *out_len = need;
        s->stats.gets++;
        pthread_mutex_unlock(&s->mu);
        return S3DFS_OK;
    }
    uint64_t *blocks = NULL, *offs = NULL;
    uint32_t *rec_lens = NULL, *val_lens = NULL, n = 0;
    int rc = walk_chain(s, loc, key, key_len, &blocks, &offs, &rec_lens, &val_lens, &n);
    if (rc != S3DFS_OK) {
        free(dst);
        pthread_mutex_unlock(&s->mu);
        return rc;
    }
    uint64_t cursor = 0;
    for (uint32_t i = 0; i < n; i++) {
        uint64_t ext_end = cursor + val_lens[i];
        int overlap = ext_end > start && cursor < end;
        if (overlap && val_lens[i] > 0) {
            uint8_t *rec = NULL;
            s3dfs_rec_view view;
            rc = load_record(s, blocks[i], offs[i], rec_lens[i], &rec, &view);
            if (rc != S3DFS_OK) {
                free(dst);
                free(blocks);
                free(offs);
                free(rec_lens);
                free(val_lens);
                pthread_mutex_unlock(&s->mu);
                return rc;
            }
            copy_overlap(view.value, view.value_len, cursor, start, end, dst);
            free(rec);
        }
        cursor = ext_end;
    }
    free(blocks);
    free(offs);
    free(rec_lens);
    free(val_lens);
    *out = dst;
    *out_len = need;
    s->stats.gets++;
    pthread_mutex_unlock(&s->mu);
    return S3DFS_OK;
}

int s3dfs_get_at(s3dfs_store *s, const char *key, uint32_t key_len, const s3dfs_locator *loc, void **out,
                 uint32_t *out_len, uint32_t *crc, uint64_t *mtime_ms)
{
    if (!s || !key || !loc || !out || !out_len || loc->rec_id == 0 || loc->tombstone) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    int rc = read_value(s, loc, key, key_len, out, out_len);
    if (rc == S3DFS_OK) {
        if (crc) {
            *crc = loc->crc;
        }
        if (mtime_ms) {
            *mtime_ms = loc->mtime_ms;
        }
        s->stats.gets++;
    }
    pthread_mutex_unlock(&s->mu);
    return rc;
}

void s3dfs_free(void *p)
{
    free(p);
}

int s3dfs_head_at(s3dfs_store *s, const char *key, uint32_t key_len, const s3dfs_locator *loc, uint64_t *size,
                  uint32_t *crc, uint64_t *mtime_ms)
{
    if (!s || !key || !loc || loc->rec_id == 0 || loc->tombstone) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    s3dfs_rec_ent ent;
    if (rec_map_get(s, loc->rec_id, &ent) != 0) {
        pthread_mutex_unlock(&s->mu);
        return S3DFS_ERR_NOT_FOUND;
    }
    uint32_t rec_len = ent.rec_len;
    uint8_t *rec = NULL;
    s3dfs_rec_view view;
    int rc = load_record(s, ent.block_id, ent.offset, rec_len, &rec, &view);
    if (rc != S3DFS_OK) {
        pthread_mutex_unlock(&s->mu);
        return rc == S3DFS_ERR_IO ? S3DFS_ERR_NOT_FOUND : rc;
    }
    int bad = (view.kind == S3DFS_KIND_TOMBSTONE || view.key_len != key_len || memcmp(view.key, key, key_len) != 0);
    free(rec);
    if (bad) {
        pthread_mutex_unlock(&s->mu);
        return S3DFS_ERR_NOT_FOUND;
    }
    if (size) {
        uint64_t sz = loc->size ? loc->size : view.total_size ? view.total_size : view.value_len;
        *size = sz;
    }
    if (crc) {
        *crc = loc->crc ? loc->crc : view.crc;
    }
    if (mtime_ms) {
        *mtime_ms = loc->mtime_ms ? loc->mtime_ms : view.mtime_ms;
    }
    pthread_mutex_unlock(&s->mu);
    return S3DFS_OK;
}

static void locator_from_view(s3dfs_locator *out, const s3dfs_rec_view *view, uint64_t block, uint64_t off,
                              uint32_t rec_len)
{
    memset(out, 0, sizeof(*out));
    out->chained = (view->kind == S3DFS_KIND_EXTENT || view->kind == S3DFS_KIND_EXTENT_LAST) ? 1 : 0;
    out->tombstone = (view->kind == S3DFS_KIND_TOMBSTONE) ? 1 : 0;
    out->crc = view->crc;
    out->mtime_ms = view->mtime_ms;
    if (view->total_size) {
        out->size = view->total_size;
    } else {
        out->size = view->value_len;
    }
    out->generation = view->generation;
    out->extent_count = view->extent_count ? view->extent_count : 1;
    out->rec_id = view->rec_id;
    out->block_id = block;
    out->offset = off;
    out->rec_len = rec_len;
    if (view->has_meta) {
        out->compress_type = view->compress_type;
        out->orig_size = view->orig_size;
        out->orig_crc = view->orig_crc;
    }
}

static int scan_block_records(s3dfs_store *s, uint64_t id, uint64_t file_end, int include_buf, s3dfs_scan_cb cb,
                              void *user)
{
    uint64_t off = 0;
    while (off < file_end) {
        if (off + S3DFS_PAGE_ON_DISK <= file_end) {
            uint8_t probe[S3DFS_PAGE_TLV];
            int page = 0;
            if (include_buf && lane_of(s)->fd >= 0 && id == lane_of(s)->block_id && off >= lane_of(s)->size) {
                uint64_t buf_off = off - lane_of(s)->size;
                if (buf_off + S3DFS_PAGE_TLV <= lane_of(s)->buf_used) {
                    memcpy(probe, lane_of(s)->buf + buf_off, S3DFS_PAGE_TLV);
                    page = page_prefix(probe, S3DFS_PAGE_TLV);
                }
            } else {
                char path[4096];
                block_path(s, id, path, sizeof(path));
                int fd = open(path, O_RDONLY);
                if (fd >= 0) {
                    if (pread(fd, probe, S3DFS_PAGE_TLV, (off_t)off) == S3DFS_PAGE_TLV &&
                        page_prefix(probe, S3DFS_PAGE_TLV)) {
                        page = 1;
                    }
                    close(fd);
                }
            }
            if (page) {
                off += S3DFS_PAGE_ON_DISK;
                continue;
            }
        }
        uint32_t peek = 8;
        uint8_t head[8];
        uint8_t *raw = NULL;
        int from_buf = 0;
        if (include_buf && lane_of(s)->fd >= 0 && id == lane_of(s)->block_id && off >= lane_of(s)->size) {
            uint64_t buf_off = off - lane_of(s)->size;
            if (buf_off + 8 > lane_of(s)->buf_used) {
                break;
            }
            memcpy(head, lane_of(s)->buf + buf_off, 8);
            from_buf = 1;
        } else {
            char path[4096];
            block_path(s, id, path, sizeof(path));
            int same = (lane_of(s)->fd >= 0 && id == lane_of(s)->block_id);
            int fd = same ? lane_of(s)->fd : open(path, O_RDONLY);
            if (fd < 0) {
                return S3DFS_ERR_IO;
            }
            if (pread(fd, head, 8, (off_t)off) != 8) {
                if (!same) {
                    close(fd);
                }
                break;
            }
            if (!same) {
                close(fd);
            }
        }
        (void)peek;
        if (rd_u32(head) != S3DFS_REC_MAGIC) {
            break;
        }
        uint32_t total = rd_u32(head + 4);
        if (total < S3DFS_FRAME_OVERHEAD || off + total > file_end) {
            break;
        }
        s3dfs_rec_view view;
        if (from_buf) {
            uint64_t buf_off = off - lane_of(s)->size;
            if (buf_off + total > lane_of(s)->buf_used || parse_record(lane_of(s)->buf + buf_off, total, &view) != 0) {
                break;
            }
            if (view.kind == S3DFS_KIND_OBJECT || view.kind == S3DFS_KIND_EXTENT_LAST ||
                view.kind == S3DFS_KIND_TOMBSTONE) {
                s3dfs_locator loc;
                locator_from_view(&loc, &view, id, off, total);
                char *keycopy = NULL;
                const char *key = (const char *)view.key;
                if (cb) {
                    int cr = cb(user, key, view.key_len, &loc);
                    if (cr != 0) {
                        (void)keycopy;
                        return cr;
                    }
                }
            }
        } else {
            int rc = load_bytes(s, id, off, total, &raw);
            if (rc != S3DFS_OK) {
                return rc;
            }
            if (parse_record(raw, total, &view) != 0) {
                free(raw);
                break;
            }
            if (view.kind == S3DFS_KIND_OBJECT || view.kind == S3DFS_KIND_EXTENT_LAST ||
                view.kind == S3DFS_KIND_TOMBSTONE) {
                s3dfs_locator loc;
                locator_from_view(&loc, &view, id, off, total);
                if (cb) {
                    int cr = cb(user, (const char *)view.key, view.key_len, &loc);
                    if (cr != 0) {
                        free(raw);
                        return cr;
                    }
                }
            }
            free(raw);
        }
        off += total;
    }
    return S3DFS_OK;
}

static int list_block_ids(s3dfs_store *s, uint64_t **ids_out, uint32_t *n_out)
{
    DIR *d = opendir(s->blocks_dir);
    if (!d) {
        return S3DFS_ERR_IO;
    }
    uint64_t *ids = NULL;
    uint32_t n = 0, cap = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        unsigned long long id = 0;
        if (sscanf(de->d_name, "%020llu.blk", &id) != 1) {
            continue;
        }
        if (n == cap) {
            cap = cap ? cap * 2 : 16;
            uint64_t *p = (uint64_t *)realloc(ids, cap * sizeof(uint64_t));
            if (!p) {
                free(ids);
                closedir(d);
                return S3DFS_ERR_NOMEM;
            }
            ids = p;
        }
        ids[n++] = (uint64_t)id;
    }
    closedir(d);
    if (n > 1) {
        qsort(ids, n, sizeof(uint64_t), cmp_u64);
    }
    *ids_out = ids;
    *n_out = n;
    return S3DFS_OK;
}

static int copy_live_record(s3dfs_store *s, uint64_t rec_id)
{
    s3dfs_rec_ent e;
    if (rec_map_get(s, rec_id, &e) != 0) {
        return S3DFS_ERR_IO;
    }
    uint8_t *raw = NULL;
    int rc = load_bytes(s, e.block_id, e.offset, e.rec_len, &raw);
    if (rc != S3DFS_OK) {
        return rc;
    }
    uint64_t block = 0, off = 0;
    rc = append_raw_unlocked(s, raw, e.rec_len, &block, &off);
    free(raw);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (page_note(s, rec_id, block, off, e.rec_len) != S3DFS_OK) {
        return S3DFS_ERR_IO;
    }
    return S3DFS_OK;
}

static int collect_chain_ids(s3dfs_store *s, uint64_t last_id, uint64_t **ids_out, uint32_t *n_out)
{
    uint32_t cap = 8, n = 0;
    uint64_t *ids = (uint64_t *)malloc(cap * sizeof(uint64_t));
    if (!ids) {
        return S3DFS_ERR_NOMEM;
    }
    uint64_t cur = last_id;
    while (cur && n < S3DFS_MAX_EXTENTS) {
        if (n == cap) {
            cap *= 2;
            uint64_t *p = (uint64_t *)realloc(ids, cap * sizeof(uint64_t));
            if (!p) {
                free(ids);
                return S3DFS_ERR_NOMEM;
            }
            ids = p;
        }
        ids[n++] = cur;
        s3dfs_rec_ent e;
        if (rec_map_get(s, cur, &e) != 0) {
            free(ids);
            return S3DFS_ERR_IO;
        }
        uint8_t *raw = NULL;
        s3dfs_rec_view view;
        if (load_record(s, e.block_id, e.offset, e.rec_len, &raw, &view) != S3DFS_OK) {
            free(ids);
            return S3DFS_ERR_IO;
        }
        uint64_t prev = view.has_prev ? view.prev_rec_id : 0;
        free(raw);
        cur = prev;
    }
    for (uint32_t i = 0, j = n; i < j; i++, j--) {
        uint32_t b = j - 1;
        uint64_t tmp = ids[i];
        ids[i] = ids[b];
        ids[b] = tmp;
    }
    *ids_out = ids;
    *n_out = n;
    return S3DFS_OK;
}

static int compact_unlocked(s3dfs_store *s)
{
    int rc = flush_buffer_unlocked(s);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (s->dead_bytes == 0) {
        return S3DFS_OK;
    }
    uint64_t *old_ids = NULL;
    uint32_t n_old = 0;
    rc = list_block_ids(s, &old_ids, &n_old);
    if (rc != S3DFS_OK) {
        return rc;
    }
    rc = close_write_fd(s);
    if (rc != S3DFS_OK) {
        free(old_ids);
        return rc;
    }
    if (s->page_n) {
        uint8_t **images = (uint8_t **)calloc(s->page_n, sizeof(uint8_t *));
        if (!images) {
            free(old_ids);
            return S3DFS_ERR_NOMEM;
        }
        for (uint32_t pi = 0; pi < s->page_n; pi++) {
            images[pi] = (uint8_t *)malloc(S3DFS_PAGE_VALUE);
            if (!images[pi] ||
                page_pread(s, s->pages[pi].block_id, s->pages[pi].file_off + S3DFS_PAGE_HEADER, images[pi],
                           S3DFS_PAGE_VALUE) != S3DFS_OK) {
                for (uint32_t k = 0; k <= pi; k++) {
                    free(images[k]);
                }
                free(images);
                free(old_ids);
                return S3DFS_ERR_IO;
            }
        }
        uint64_t id = s->next_block_id++;
        if (id == 0) {
            id = s->next_block_id++;
        }
        rc = open_block_for_write(s, id, 0);
        if (rc != S3DFS_OK) {
            for (uint32_t pi = 0; pi < s->page_n; pi++) {
                free(images[pi]);
            }
            free(images);
            free(old_ids);
            return rc;
        }
        s->stats.block_files++;
        uint8_t *zeros = (uint8_t *)calloc(1, S3DFS_PAGE_VALUE);
        if (!zeros) {
            for (uint32_t pi = 0; pi < s->page_n; pi++) {
                free(images[pi]);
            }
            free(images);
            free(old_ids);
            return S3DFS_ERR_NOMEM;
        }
        uint64_t cursor = 0;
        for (uint32_t pi = 0; pi < s->page_n; pi++) {
            uint64_t next = (pi + 1 < s->page_n) ? cursor + S3DFS_PAGE_ON_DISK : 0;
            uint64_t old_block = s->pages[pi].block_id;
            uint8_t header[S3DFS_PAGE_HEADER];
            page_fill_header(header, s->pages[pi].first_rec_id, next);
            if (page_pwrite(s, lane_of(s)->block_id, cursor, header, S3DFS_PAGE_HEADER) != S3DFS_OK ||
                page_pwrite(s, lane_of(s)->block_id, cursor + S3DFS_PAGE_HEADER, zeros, S3DFS_PAGE_VALUE) != S3DFS_OK) {
                rc = S3DFS_ERR_IO;
                break;
            }
            s->pages[pi].src_block = old_block;
            s->pages[pi].block_id = lane_of(s)->block_id;
            s->pages[pi].file_off = cursor;
            s->pages[pi].next_off = next;
            cursor += S3DFS_PAGE_ON_DISK;
        }
        free(zeros);
        lane_of(s)->size = cursor;
        s->stats.bytes_on_disk = cursor;
        lane_of(s)->page_cached = UINT32_MAX;
        free(lane_of(s)->page_slots);
        lane_of(s)->page_slots = NULL;
        lane_of(s)->page_dirty = 0;
        s->compact_slots = images;
        if (rc != S3DFS_OK) {
            free(old_ids);
            return rc;
        }
    }

    if (s->key_tab) {
        for (uint32_t i = 0; i < s->key_cap; i++) {
            s3dfs_key_ent *e = &s->key_tab[i];
            if (e->state != S3DFS_MAP_LIVE || e->kind == S3DFS_KIND_TOMBSTONE || !e->rec_id) {
                continue;
            }
            uint64_t *chain = NULL;
            uint32_t cn = 0;
            rc = collect_chain_ids(s, e->rec_id, &chain, &cn);
            if (rc != S3DFS_OK) {
                free(old_ids);
                return rc;
            }
            for (uint32_t k = 0; k < cn; k++) {
                rc = copy_live_record(s, chain[k]);
                if (rc != S3DFS_OK) {
                    free(chain);
                    free(old_ids);
                    return rc;
                }
            }
            free(chain);
        }
    }
    rc = flush_buffer_unlocked(s);
    if (rc != S3DFS_OK) {
        free(old_ids);
        return rc;
    }

    if (s->compact_slots) {
        for (uint32_t pi = 0; pi < s->page_n; pi++) {
            s->pages[pi].src_block = 0;
            free(s->compact_slots[pi]);
        }
        free(s->compact_slots);
        s->compact_slots = NULL;
    }
    uint64_t new_id = lane_of(s)->block_id;
    for (uint32_t i = 0; i < n_old; i++) {
        if (lane_of(s)->fd >= 0 && old_ids[i] == new_id) {
            continue;
        }
        char path[4096];
        block_path(s, old_ids[i], path, sizeof(path));
        unlink(path);
    }
    free(old_ids);
    s->dead_bytes = 0;
    s->stats.bytes_on_disk = lane_of(s)->size;
    s->stats.block_files = lane_of(s)->fd >= 0 ? 1 : 0;
    return page_flush_dirty(s);
}

static void compact_job(void *arg)
{
    s3dfs_store *s = (s3dfs_store *)arg;
    s3dfs_store_lock(s);
    s->exclusive = 1;
    compact_unlocked(s);
    s->exclusive = 0;
    s3dfs_store_unlock(s);
}

int s3dfs_compact(s3dfs_store *s)
{
    if (!s) {
        return S3DFS_ERR_ARGS;
    }
    s3dfs_lane_call_all(s, close_flush_job, s);
    for (uint32_t i = 0; i < s->nlanes; i++) {
        s->lanes[i].page_index = UINT32_MAX;
        s->lanes[i].page_cached = UINT32_MAX;
        s->lanes[i].fresh_page = 1;
        s->lanes[i].rec_cursor = 0;
        s->lanes[i].rec_end = 0;
    }
    s3dfs_lane_call_at(s, 0, compact_job, s);
    return S3DFS_OK;
}


int s3dfs_scan(s3dfs_store *s, s3dfs_scan_cb cb, void *user)
{
    if (!s || !cb) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    uint64_t *ids = NULL;
    uint32_t n = 0;
    int rc = list_block_ids(s, &ids, &n);
    if (rc != S3DFS_OK) {
        pthread_mutex_unlock(&s->mu);
        return rc;
    }
    for (uint32_t i = 0; i < n; i++) {
        uint64_t end = 0;
        if (lane_of(s)->fd >= 0 && ids[i] == lane_of(s)->block_id) {
            end = lane_of(s)->size + lane_of(s)->buf_used;
        } else {
            rc = scan_block_end(s, ids[i], &end);
            if (rc != S3DFS_OK) {
                free(ids);
                pthread_mutex_unlock(&s->mu);
                return rc;
            }
        }
        int include_buf = (lane_of(s)->fd >= 0 && ids[i] == lane_of(s)->block_id);
        rc = scan_block_records(s, ids[i], end, include_buf, cb, user);
        if (rc != S3DFS_OK) {
            free(ids);
            pthread_mutex_unlock(&s->mu);
            return rc;
        }
    }
    /* A just-created block may only exist in the write buffer / wr_fd and already
       be in the directory after open_block_for_write. If the current writer is a
       new file not yet in the listing (shouldn't happen), scan it too. */
    if (lane_of(s)->fd >= 0 && lane_of(s)->buf_used + lane_of(s)->size > 0) {
        int seen = 0;
        for (uint32_t i = 0; i < n; i++) {
            if (ids[i] == lane_of(s)->block_id) {
                seen = 1;
                break;
            }
        }
        if (!seen) {
            rc = scan_block_records(s, lane_of(s)->block_id, lane_of(s)->size + lane_of(s)->buf_used, 1, cb, user);
        }
    }
    free(ids);
    pthread_mutex_unlock(&s->mu);
    return rc;
}

static int audit_block(s3dfs_store *s, uint64_t id, uint64_t file_end, s3dfs_audit_report *out)
{
    uint64_t off = 0;
    while (off + 8 <= file_end) {
        if (off + S3DFS_PAGE_ON_DISK <= file_end) {
            uint8_t header[S3DFS_PAGE_HEADER];
            char path[4096];
            block_path(s, id, path, sizeof(path));
            int fd = open(path, O_RDONLY);
            int is_page = 0;
            int header_bad = 0;
            if (fd >= 0 && pread(fd, header, S3DFS_PAGE_HEADER, (off_t)off) == S3DFS_PAGE_HEADER &&
                rd_u16(header) == S3DFS_TAG_RECID_V1) {
                is_page = 1;
                uint64_t first = 0;
                if (!page_header_ok(header, &first)) {
                    header_bad = 1;
                }
            }
            if (fd >= 0) {
                close(fd);
            }
            if (is_page) {
                if (header_bad) {
                    out->bad++;
                }
                off += S3DFS_PAGE_ON_DISK;
                continue;
            }
        }
        uint8_t head[8];
        char path[4096];
        block_path(s, id, path, sizeof(path));
        int same = (lane_of(s)->fd >= 0 && id == lane_of(s)->block_id);
        int fd = same ? lane_of(s)->fd : open(path, O_RDONLY);
        if (fd < 0) {
            return S3DFS_ERR_IO;
        }
        ssize_t nread = pread(fd, head, 8, (off_t)off);
        if (!same) {
            close(fd);
        }
        if (nread != 8) {
            out->bad++;
            break;
        }
        if (rd_u32(head) != S3DFS_REC_MAGIC) {
            out->bad++;
            break;
        }
        uint32_t total = rd_u32(head + 4);
        if (total < S3DFS_FRAME_OVERHEAD || off + total > file_end) {
            out->bad++;
            break;
        }
        uint8_t *raw = (uint8_t *)malloc(total);
        if (!raw) {
            return S3DFS_ERR_NOMEM;
        }
        int read_fd = same ? lane_of(s)->fd : open(path, O_RDONLY);
        if (read_fd < 0 || pread(read_fd, raw, total, (off_t)off) != (ssize_t)total) {
            free(raw);
            if (read_fd >= 0 && !same) {
                close(read_fd);
            }
            return S3DFS_ERR_IO;
        }
        if (!same) {
            close(read_fd);
        }
        s3dfs_rec_view view;
        if (parse_record(raw, total, &view) != 0) {
            out->bad++;
        } else if (view.kind == S3DFS_KIND_OBJECT || view.kind == S3DFS_KIND_EXTENT_LAST ||
                   view.kind == S3DFS_KIND_TOMBSTONE) {
            out->records++;
            out->bytes += total;
        }
        free(raw);
        off += total;
    }
    return S3DFS_OK;
}

int s3dfs_audit(s3dfs_store *s, s3dfs_audit_report *out)
{
    if (!s || !out) {
        return S3DFS_ERR_ARGS;
    }
    memset(out, 0, sizeof(*out));
    pthread_mutex_lock(&s->mu);
    uint64_t *ids = NULL;
    uint32_t n = 0;
    int rc = list_block_ids(s, &ids, &n);
    if (rc != S3DFS_OK) {
        pthread_mutex_unlock(&s->mu);
        return rc;
    }
    for (uint32_t i = 0; i < n; i++) {
        uint64_t end = 0;
        char path[4096];
        block_path(s, ids[i], path, sizeof(path));
        struct stat st;
        if (stat(path, &st) != 0) {
            rc = S3DFS_ERR_IO;
            break;
        }
        end = (uint64_t)st.st_size;
        if (lane_of(s)->fd >= 0 && ids[i] == lane_of(s)->block_id && lane_of(s)->size + lane_of(s)->buf_used > end) {
            end = lane_of(s)->size + lane_of(s)->buf_used;
        }
        rc = audit_block(s, ids[i], end, out);
        if (rc != S3DFS_OK) {
            break;
        }
    }
    free(ids);
    pthread_mutex_unlock(&s->mu);
    return rc;
}

static void flush_job(void *arg)
{
    s3dfs_store *s = (s3dfs_store *)arg;
    uint64_t t0 = mono_us();
    s3dfs_store_lock(s);
    uint64_t t1 = mono_us();
    flush_buffer_unlocked(s);
    note_us(&s->stats.flush_wait_us, NULL, t1 - t0);
    note_us(&s->stats.flush_hold_us, &s->stats.flush_hold_max_us, mono_us() - t1);
    s3dfs_store_unlock(s);
}

int s3dfs_flush(s3dfs_store *s)
{
    if (!s) {
        return S3DFS_ERR_ARGS;
    }
    s3dfs_lane_call_all(s, flush_job, s);
    return S3DFS_OK;
}

static void sync_job(void *arg)
{
    s3dfs_store *s = (s3dfs_store *)arg;
    uint64_t t0 = mono_us();
    s3dfs_store_lock(s);
    uint64_t t1 = mono_us();
    int rc = flush_buffer_unlocked(s);
    if (rc == S3DFS_OK && s->fsync_on_flush && lane_of(s)->pending_sync && lane_of(s)->fd >= 0) {
        uint64_t fs0 = mono_us();
        s3dfs_store_io_begin(s);
        int failed = fsync(lane_of(s)->fd) != 0;
        s3dfs_store_io_end(s);
        if (failed) {
            rc = S3DFS_ERR_IO;
        } else {
            s->stats.fsyncs++;
            lane_of(s)->pending_sync = 0;
        }
        note_us(&s->stats.fsync_us, &s->stats.fsync_max_us, mono_us() - fs0);
    }
    note_us(&s->stats.sync_wait_us, NULL, t1 - t0);
    note_us(&s->stats.sync_hold_us, &s->stats.sync_hold_max_us, mono_us() - t1);
    s3dfs_store_unlock(s);
    (void)rc;
}

int s3dfs_sync(s3dfs_store *s)
{
    if (!s) {
        return S3DFS_ERR_ARGS;
    }
    s3dfs_lane_call_all(s, sync_job, s);
    return S3DFS_OK;
}

void s3dfs_get_stats(s3dfs_store *s, s3dfs_stats *out)
{
    if (!s || !out) {
        return;
    }
    pthread_mutex_lock(&s->mu);
    s->stats.dead_bytes = s->dead_bytes;
    s->stats.tickets = s->tickets;
    s->stats.unflushed_bytes = 0;
    for (uint32_t i = 0; s->lanes && i < s->nlanes; i++) {
        s->stats.unflushed_bytes += s->lanes[i].buf_used;
    }
    *out = s->stats;
    out->lane_wait_us = __atomic_load_n(&s->stats.lane_wait_us, __ATOMIC_RELAXED);
    out->lane_wait_max_us = __atomic_load_n(&s->stats.lane_wait_max_us, __ATOMIC_RELAXED);
    out->lane_waits = __atomic_load_n(&s->stats.lane_waits, __ATOMIC_RELAXED);
    out->lane_depth_max = __atomic_load_n(&s->stats.lane_depth_max, __ATOMIC_RELAXED);
    out->body_us = __atomic_load_n(&s->stats.body_us, __ATOMIC_RELAXED);
    out->body_max_us = __atomic_load_n(&s->stats.body_max_us, __ATOMIC_RELAXED);
    out->body_writes = __atomic_load_n(&s->stats.body_writes, __ATOMIC_RELAXED);
    out->slot_us = __atomic_load_n(&s->stats.slot_us, __ATOMIC_RELAXED);
    out->slot_max_us = __atomic_load_n(&s->stats.slot_max_us, __ATOMIC_RELAXED);
    out->slot_writes = __atomic_load_n(&s->stats.slot_writes, __ATOMIC_RELAXED);
    pthread_mutex_unlock(&s->mu);
}
