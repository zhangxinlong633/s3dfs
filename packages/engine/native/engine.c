#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700

#include "s3dfs.h"

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

#include "leveldb/c.h"

#define S3DFS_HDR_MAGIC 0x5E /* '^' */
#define S3DFS_TAIL_MAGIC 0x24 /* '$' */
#define S3DFS_FLAG_TOMBSTONE 0x01
#define S3DFS_FLAG_EXTENT 0x02
#define S3DFS_FLAG_LAST 0x04
#define S3DFS_DEFAULT_BLOCK_SIZE (1024ull * 1024ull * 1024ull)
#define S3DFS_MAX_EXTENTS 1048576u
#define S3DFS_DEFAULT_BUFFER_SIZE (1024u * 1024u)
#define S3DFS_MIN_BUFFER_SIZE 4096u

#define OBJ_KEY_PREFIX ((char)0x01)
#define META_KEY "\x00head"
#define META_KEY_LEN 5
#define INDEX_MAGIC 0x58493353u /* 'S3IX' */
#define INDEX_VERSION 1u

typedef struct __attribute__((packed)) {
    uint8_t magic;
    uint8_t flags;
    uint16_t key_len;
    uint32_t value_len;
    uint32_t crc;
    uint64_t mtime_ms;
} s3dfs_rec_header;

typedef struct __attribute__((packed)) {
    uint32_t rec_len;
    uint8_t pad[3];
    uint8_t magic;
} s3dfs_rec_tail;

#define S3DFS_HEADER_LEN (sizeof(s3dfs_rec_header))
#define S3DFS_TAIL_LEN (sizeof(s3dfs_rec_tail))

typedef struct __attribute__((packed)) {
    uint64_t block_id;
    uint64_t offset;
    uint32_t size;
    uint32_t crc;
    uint64_t mtime_ms;
} idx_val;

#define IDX_V2_MAGIC 0x32583353u /* 'S3X2' */
#define IDX_V2_VERSION 2u

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t version;
    uint64_t mtime_ms;
    uint64_t total_size;
    uint32_t object_crc;
    uint32_t last_rec_len;
    uint64_t last_block_id;
    uint64_t last_offset;
    uint64_t generation;
    uint32_t extent_count;
    uint32_t pad;
} idx_val_v2;

/* The forward chain is stored in the block records themselves:
   each later extent points at the previous one (block_id, offset, rec_len).
   LevelDB only keeps the last extent. */
typedef struct __attribute__((packed)) {
    uint64_t prev_block_id;
    uint64_t prev_offset;
    uint32_t prev_rec_len;
    uint32_t seq;
    uint64_t generation;
    uint64_t total_size;
    uint32_t extent_count;
    uint32_t pad;
} s3dfs_ext_link;

#define S3DFS_EXT_LINK_LEN (sizeof(s3dfs_ext_link))

typedef struct {
    uint8_t chained;
    uint32_t crc;
    uint64_t mtime_ms;
    uint64_t total_size;
    uint64_t generation;
    uint32_t extent_count;
    uint64_t block_id;
    uint64_t offset;
    uint32_t rec_len;
} idx_loc;

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t version;
    uint64_t wr_block_id;
    uint64_t wr_size;
    uint64_t objects;
    uint64_t deleted;
    uint64_t bytes_logical;
    uint64_t bytes_on_disk;
    uint64_t block_files;
    uint64_t puts;
    uint64_t gets;
    uint64_t deletes;
    uint64_t flushes;
    uint64_t fsyncs;
} idx_meta;

typedef struct {
    char *key;
    uint32_t key_len;
    idx_loc val;
    uint8_t deleted;
} pend_ent;

struct s3dfs_store {
    char data_dir[4096];
    char blocks_dir[4096];
    char index_dir[4096];
    uint64_t block_size;
    uint32_t buffer_size;
    int fsync_on_flush;

    int wr_fd;
    uint64_t wr_block_id;
    uint64_t wr_size;
    uint8_t *buf;
    uint32_t buf_used;

    leveldb_t *db;
    leveldb_options_t *db_opt;
    leveldb_readoptions_t *db_ro;
    leveldb_writeoptions_t *db_wo;
    leveldb_writeoptions_t *db_wo_sync;

    pend_ent *pend;
    uint32_t pend_n;
    uint32_t pend_cap;
    uint64_t put_generation;

    char **list_keys;
    uint32_t list_keys_n;
    uint32_t list_keys_cap;

    s3dfs_stats stats;
    pthread_mutex_t mu;
};

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
    crc = crc ^ 0xFFFFFFFFu;
    for (uint32_t i = 0; i < len; i++) {
        crc = crc32_table[(crc ^ p[i]) & 0xFFu] ^ (crc >> 8);
    }
    return crc ^ 0xFFFFFFFFu;
}

static uint32_t crc32_key_value(const char *key, uint32_t key_len, const void *val, uint32_t val_len)
{
    uint32_t crc = crc32_update(0, key, key_len);
    if (val_len && val) {
        const uint8_t *p = (const uint8_t *)val;
        crc = crc ^ 0xFFFFFFFFu;
        for (uint32_t i = 0; i < val_len; i++) {
            crc = crc32_table[(crc ^ p[i]) & 0xFFu] ^ (crc >> 8);
        }
        crc = crc ^ 0xFFFFFFFFu;
    }
    return crc;
}

static uint64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)ts.tv_nsec / 1000000ull;
}

static int mkdir_p(const char *path)
{
    if (mkdir(path, 0755) == 0 || errno == EEXIST) {
        return 0;
    }
    return -1;
}

static void block_path(const s3dfs_store *s, uint64_t id, char *out, size_t out_len)
{
    snprintf(out, out_len, "%s/%020llu.blk", s->blocks_dir, (unsigned long long)id);
}

static uint32_t rec_total_len(uint32_t key_len, uint32_t value_len)
{
    return (uint32_t)(S3DFS_HEADER_LEN + key_len + value_len + S3DFS_TAIL_LEN);
}

static uint32_t rec_total_len_ex(uint32_t key_len, uint32_t value_len, int chained)
{
    uint32_t total = rec_total_len(key_len, value_len);
    if (chained) {
        total += (uint32_t)S3DFS_EXT_LINK_LEN;
    }
    return total;
}

static int write_fully(int fd, const void *data, uint32_t len)
{
    const uint8_t *p = (const uint8_t *)data;
    uint32_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, p + off, len - off);
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

static int idx_decode(const void *data, size_t len, idx_loc *out)
{
    memset(out, 0, sizeof(*out));
    if (len == sizeof(idx_val)) {
        idx_val v;
        memcpy(&v, data, sizeof(v));
        out->chained = 0;
        out->crc = v.crc;
        out->mtime_ms = v.mtime_ms;
        out->total_size = v.size;
        out->extent_count = 1;
        out->block_id = v.block_id;
        out->offset = v.offset;
        out->rec_len = 0;
        return S3DFS_OK;
    }
    if (len == sizeof(idx_val_v2)) {
        idx_val_v2 v;
        memcpy(&v, data, sizeof(v));
        if (v.magic != IDX_V2_MAGIC || v.version != IDX_V2_VERSION) {
            return S3DFS_ERR;
        }
        out->chained = 1;
        out->crc = v.object_crc;
        out->mtime_ms = v.mtime_ms;
        out->total_size = v.total_size;
        out->generation = v.generation;
        out->extent_count = v.extent_count;
        out->block_id = v.last_block_id;
        out->offset = v.last_offset;
        out->rec_len = v.last_rec_len;
        return S3DFS_OK;
    }
    return S3DFS_ERR;
}

static uint32_t idx_encode(const idx_loc *loc, void *buf, uint32_t buf_len)
{
    if (!loc->chained) {
        if (buf_len < sizeof(idx_val) || loc->total_size > UINT32_MAX) {
            return 0;
        }
        idx_val v;
        memset(&v, 0, sizeof(v));
        v.block_id = loc->block_id;
        v.offset = loc->offset;
        v.size = (uint32_t)loc->total_size;
        v.crc = loc->crc;
        v.mtime_ms = loc->mtime_ms;
        memcpy(buf, &v, sizeof(v));
        return (uint32_t)sizeof(v);
    }
    if (buf_len < sizeof(idx_val_v2)) {
        return 0;
    }
    idx_val_v2 v;
    memset(&v, 0, sizeof(v));
    v.magic = IDX_V2_MAGIC;
    v.version = IDX_V2_VERSION;
    v.mtime_ms = loc->mtime_ms;
    v.total_size = loc->total_size;
    v.object_crc = loc->crc;
    v.last_rec_len = loc->rec_len;
    v.last_block_id = loc->block_id;
    v.last_offset = loc->offset;
    v.generation = loc->generation;
    v.extent_count = loc->extent_count;
    memcpy(buf, &v, sizeof(v));
    return (uint32_t)sizeof(v);
}

static int cmp_u64(const void *a, const void *b)
{
    uint64_t x = *(const uint64_t *)a;
    uint64_t y = *(const uint64_t *)b;
    return (x > y) - (x < y);
}

static int cmp_bytes(const char *a, uint32_t a_len, const char *b, uint32_t b_len)
{
    uint32_t n = a_len < b_len ? a_len : b_len;
    int c = memcmp(a, b, n);
    if (c != 0) {
        return c;
    }
    return (int)a_len - (int)b_len;
}

static void pend_clear(s3dfs_store *s)
{
    for (uint32_t i = 0; i < s->pend_n; i++) {
        free(s->pend[i].key);
    }
    s->pend_n = 0;
}

static void list_keys_reset(s3dfs_store *s)
{
    for (uint32_t i = 0; i < s->list_keys_n; i++) {
        free(s->list_keys[i]);
    }
    s->list_keys_n = 0;
}

static const char *list_keys_copy(s3dfs_store *s, const char *key, uint32_t key_len)
{
    if (s->list_keys_n == s->list_keys_cap) {
        uint32_t cap = s->list_keys_cap ? s->list_keys_cap * 2 : 64;
        char **p = (char **)realloc(s->list_keys, cap * sizeof(char *));
        if (!p) {
            return NULL;
        }
        s->list_keys = p;
        s->list_keys_cap = cap;
    }
    char *copy = (char *)malloc(key_len + 1);
    if (!copy) {
        return NULL;
    }
    memcpy(copy, key, key_len);
    copy[key_len] = 0;
    s->list_keys[s->list_keys_n++] = copy;
    return copy;
}

static int idx_lookup(s3dfs_store *s, const char *key, uint32_t key_len, idx_loc *out, int *found)
{
    for (uint32_t i = s->pend_n; i > 0; i--) {
        pend_ent *e = &s->pend[i - 1];
        if (e->key_len == key_len && memcmp(e->key, key, key_len) == 0) {
            if (e->deleted) {
                *found = 0;
                return S3DFS_OK;
            }
            *out = e->val;
            *found = 1;
            return S3DFS_OK;
        }
    }
    char kbuf[4096];
    char *k = kbuf;
    size_t klen = (size_t)key_len + 1;
    int heap = 0;
    if (klen > sizeof(kbuf)) {
        k = (char *)malloc(klen);
        if (!k) {
            return S3DFS_ERR_NOMEM;
        }
        heap = 1;
    }
    k[0] = OBJ_KEY_PREFIX;
    memcpy(k + 1, key, key_len);
    char *err = NULL;
    size_t vlen = 0;
    char *v = leveldb_get(s->db, s->db_ro, k, klen, &vlen, &err);
    if (heap) {
        free(k);
    }
    if (err) {
        leveldb_free(err);
        return S3DFS_ERR;
    }
    if (!v) {
        *found = 0;
        return S3DFS_OK;
    }
    int rc = idx_decode(v, vlen, out);
    leveldb_free(v);
    if (rc != S3DFS_OK) {
        return S3DFS_ERR;
    }
    *found = 1;
    return S3DFS_OK;
}


static int idx_upsert(s3dfs_store *s, const char *key, uint32_t key_len, const idx_loc *loc, int deleted)
{
    idx_loc old;
    int found = 0;
    int rc = idx_lookup(s, key, key_len, &old, &found);
    if (rc != S3DFS_OK) {
        return rc;
    }
    uint64_t new_size = loc ? loc->total_size : 0;
    if (found && deleted) {
        s->stats.objects--;
        s->stats.deleted++;
        if (s->stats.bytes_logical >= old.total_size) {
            s->stats.bytes_logical -= old.total_size;
        }
    } else if (found && !deleted) {
        if (s->stats.bytes_logical >= old.total_size) {
            s->stats.bytes_logical -= old.total_size;
        }
        s->stats.bytes_logical += new_size;
    } else if (!found && deleted) {
        s->stats.deleted++;
    } else {
        s->stats.objects++;
        s->stats.bytes_logical += new_size;
    }

    for (uint32_t i = 0; i < s->pend_n; i++) {
        if (s->pend[i].key_len == key_len && memcmp(s->pend[i].key, key, key_len) == 0) {
            if (loc) {
                s->pend[i].val = *loc;
            } else {
                memset(&s->pend[i].val, 0, sizeof(s->pend[i].val));
            }
            s->pend[i].deleted = deleted ? 1 : 0;
            return S3DFS_OK;
        }
    }
    if (s->pend_n == s->pend_cap) {
        uint32_t cap = s->pend_cap ? s->pend_cap * 2 : 64;
        pend_ent *p = (pend_ent *)realloc(s->pend, cap * sizeof(pend_ent));
        if (!p) {
            return S3DFS_ERR_NOMEM;
        }
        s->pend = p;
        s->pend_cap = cap;
    }
    pend_ent *e = &s->pend[s->pend_n];
    e->key = (char *)malloc(key_len + 1);
    if (!e->key) {
        return S3DFS_ERR_NOMEM;
    }
    memcpy(e->key, key, key_len);
    e->key[key_len] = 0;
    e->key_len = key_len;
    if (loc) {
        e->val = *loc;
    } else {
        memset(&e->val, 0, sizeof(e->val));
    }
    e->deleted = deleted ? 1 : 0;
    s->pend_n++;
    return S3DFS_OK;
}


static int idx_commit(s3dfs_store *s)
{
    if (!s->db) {
        return S3DFS_ERR;
    }
    leveldb_writebatch_t *wb = leveldb_writebatch_create();
    if (!wb) {
        return S3DFS_ERR_NOMEM;
    }
    for (uint32_t i = 0; i < s->pend_n; i++) {
        pend_ent *e = &s->pend[i];
        size_t klen = (size_t)e->key_len + 1;
        char *k = (char *)malloc(klen);
        if (!k) {
            leveldb_writebatch_destroy(wb);
            return S3DFS_ERR_NOMEM;
        }
        k[0] = OBJ_KEY_PREFIX;
        memcpy(k + 1, e->key, e->key_len);
        if (e->deleted) {
            leveldb_writebatch_delete(wb, k, klen);
        } else {
            uint8_t enc[sizeof(idx_val_v2)];
            uint32_t enc_len = idx_encode(&e->val, enc, sizeof(enc));
            if (enc_len == 0) {
                free(k);
                leveldb_writebatch_destroy(wb);
                return S3DFS_ERR;
            }
            leveldb_writebatch_put(wb, k, klen, (const char *)enc, enc_len);
        }
        free(k);
    }
    idx_meta meta;
    memset(&meta, 0, sizeof(meta));
    meta.magic = INDEX_MAGIC;
    meta.version = INDEX_VERSION;
    meta.wr_block_id = s->wr_block_id;
    meta.wr_size = s->wr_size;
    meta.objects = s->stats.objects;
    meta.deleted = s->stats.deleted;
    meta.bytes_logical = s->stats.bytes_logical;
    meta.bytes_on_disk = s->stats.bytes_on_disk;
    meta.block_files = s->stats.block_files;
    meta.puts = s->stats.puts;
    meta.gets = s->stats.gets;
    meta.deletes = s->stats.deletes;
    meta.flushes = s->stats.flushes;
    meta.fsyncs = s->stats.fsyncs;
    leveldb_writebatch_put(wb, META_KEY, META_KEY_LEN, (const char *)&meta, sizeof(meta));

    char *err = NULL;
    leveldb_writeoptions_t *wo = s->fsync_on_flush ? s->db_wo_sync : s->db_wo;
    leveldb_write(s->db, wo, wb, &err);
    leveldb_writebatch_destroy(wb);
    if (err) {
        leveldb_free(err);
        return S3DFS_ERR_IO;
    }
    pend_clear(s);
    return S3DFS_OK;
}

static int idx_load_meta(s3dfs_store *s, int *present)
{
    *present = 0;
    char *err = NULL;
    size_t vlen = 0;
    char *v = leveldb_get(s->db, s->db_ro, META_KEY, META_KEY_LEN, &vlen, &err);
    if (err) {
        leveldb_free(err);
        return S3DFS_ERR;
    }
    if (!v) {
        return S3DFS_OK;
    }
    if (vlen != sizeof(idx_meta)) {
        leveldb_free(v);
        return S3DFS_OK;
    }
    idx_meta meta;
    memcpy(&meta, v, sizeof(meta));
    leveldb_free(v);
    if (meta.magic != INDEX_MAGIC || meta.version != INDEX_VERSION) {
        return S3DFS_OK;
    }
    s->wr_block_id = meta.wr_block_id;
    s->wr_size = meta.wr_size;
    s->stats.objects = meta.objects;
    s->stats.deleted = meta.deleted;
    s->stats.bytes_logical = meta.bytes_logical;
    s->stats.bytes_on_disk = meta.bytes_on_disk;
    s->stats.block_files = meta.block_files;
    s->stats.puts = meta.puts;
    s->stats.gets = meta.gets;
    s->stats.deletes = meta.deletes;
    s->stats.flushes = meta.flushes;
    s->stats.fsyncs = meta.fsyncs;
    *present = 1;
    return S3DFS_OK;
}

static int idx_open(s3dfs_store *s)
{
    s->db_opt = leveldb_options_create();
    leveldb_options_set_create_if_missing(s->db_opt, 1);
    leveldb_options_set_compression(s->db_opt, leveldb_no_compression);
    s->db_ro = leveldb_readoptions_create();
    s->db_wo = leveldb_writeoptions_create();
    s->db_wo_sync = leveldb_writeoptions_create();
    leveldb_writeoptions_set_sync(s->db_wo_sync, 1);
    char *err = NULL;
    s->db = leveldb_open(s->db_opt, s->index_dir, &err);
    if (err || !s->db) {
        if (err) {
            leveldb_free(err);
        }
        return S3DFS_ERR_IO;
    }
    return S3DFS_OK;
}

static void idx_close(s3dfs_store *s)
{
    if (s->db) {
        leveldb_close(s->db);
        s->db = NULL;
    }
    if (s->db_opt) {
        leveldb_options_destroy(s->db_opt);
        s->db_opt = NULL;
    }
    if (s->db_ro) {
        leveldb_readoptions_destroy(s->db_ro);
        s->db_ro = NULL;
    }
    if (s->db_wo) {
        leveldb_writeoptions_destroy(s->db_wo);
        s->db_wo = NULL;
    }
    if (s->db_wo_sync) {
        leveldb_writeoptions_destroy(s->db_wo_sync);
        s->db_wo_sync = NULL;
    }
}

static int close_write_fd(s3dfs_store *s)
{
    if (s->wr_fd >= 0) {
        if (s->fsync_on_flush) {
            if (fsync(s->wr_fd) != 0) {
                close(s->wr_fd);
                s->wr_fd = -1;
                return S3DFS_ERR_IO;
            }
            s->stats.fsyncs++;
        }
        close(s->wr_fd);
        s->wr_fd = -1;
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
        if (lseek(fd, (off_t)existing_size, SEEK_SET) < 0) {
            close(fd);
            return S3DFS_ERR_IO;
        }
    } else if (lseek(fd, 0, SEEK_END) < 0) {
        close(fd);
        return S3DFS_ERR_IO;
    }
    s->wr_fd = fd;
    s->wr_block_id = id;
    s->wr_size = existing_size;
    return S3DFS_OK;
}

static int flush_buffer_unlocked(s3dfs_store *s)
{
    if (s->buf_used == 0) {
        return s->pend_n ? idx_commit(s) : S3DFS_OK;
    }
    if (s->wr_fd < 0) {
        return S3DFS_ERR_IO;
    }
    uint32_t off = 0;
    while (off < s->buf_used) {
        ssize_t n = write(s->wr_fd, s->buf + off, s->buf_used - off);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return S3DFS_ERR_IO;
        }
        off += (uint32_t)n;
    }
    s->wr_size += s->buf_used;
    s->stats.bytes_on_disk += s->buf_used;
    s->buf_used = 0;
    s->stats.flushes++;
    if (s->fsync_on_flush) {
        if (fsync(s->wr_fd) != 0) {
            return S3DFS_ERR_IO;
        }
        s->stats.fsyncs++;
    }
    int rc = idx_commit(s);
    if (rc != S3DFS_OK) {
        return rc;
    }
    if (s->wr_size >= s->block_size) {
        return close_write_fd(s);
    }
    return S3DFS_OK;
}

static int ensure_writer(s3dfs_store *s, uint32_t need)
{
    if (s->wr_fd >= 0 && s->wr_size + s->buf_used + need > s->block_size) {
        int rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        rc = close_write_fd(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    if (s->wr_fd < 0) {
        uint64_t id = s->wr_block_id + 1;
        if (id == 0) {
            id = 1;
        }
        int rc = open_block_for_write(s, id, 0);
        if (rc != S3DFS_OK) {
            return rc;
        }
        s->stats.block_files++;
    }
    if (s->buf_used + need > s->buffer_size) {
        int rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }
    return S3DFS_OK;
}

static int append_record(s3dfs_store *s, const char *key, uint32_t key_len, const void *value,
                         uint32_t value_len, uint8_t flags, uint32_t crc, uint64_t mtime_ms,
                         const s3dfs_ext_link *link, uint64_t *out_block, uint64_t *out_off,
                         uint32_t *out_rec_len)
{
    int chained = (flags & S3DFS_FLAG_EXTENT) ? 1 : 0;
    if (chained && !link) {
        return S3DFS_ERR_ARGS;
    }
    uint32_t total = rec_total_len_ex(key_len, value_len, chained);
    if (total < rec_total_len_ex(key_len, 0, chained) || total > s->block_size) {
        return S3DFS_ERR_ARGS;
    }
    if (total > s->buffer_size) {
        int rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        rc = ensure_writer(s, total);
        if (rc != S3DFS_OK) {
            return rc;
        }
    } else {
        int rc = ensure_writer(s, total);
        if (rc != S3DFS_OK) {
            return rc;
        }
    }

    uint64_t offset = s->wr_size + s->buf_used;
    s3dfs_rec_header hdr;
    memset(&hdr, 0, sizeof(hdr));
    hdr.magic = S3DFS_HDR_MAGIC;
    hdr.flags = flags;
    hdr.key_len = (uint16_t)key_len;
    hdr.value_len = value_len;
    hdr.crc = crc;
    hdr.mtime_ms = mtime_ms;
    s3dfs_rec_tail tail;
    memset(&tail, 0, sizeof(tail));
    tail.rec_len = total;
    tail.magic = S3DFS_TAIL_MAGIC;

    if (total <= s->buffer_size - s->buf_used) {
        uint8_t *p = s->buf + s->buf_used;
        memcpy(p, &hdr, S3DFS_HEADER_LEN);
        p += S3DFS_HEADER_LEN;
        if (chained) {
            memcpy(p, link, S3DFS_EXT_LINK_LEN);
            p += S3DFS_EXT_LINK_LEN;
        }
        memcpy(p, key, key_len);
        p += key_len;
        if (value_len && value) {
            memcpy(p, value, value_len);
            p += value_len;
        }
        memcpy(p, &tail, S3DFS_TAIL_LEN);
        s->buf_used += total;
    } else {
        if (s->wr_fd < 0) {
            return S3DFS_ERR_IO;
        }
        if (write_fully(s->wr_fd, &hdr, (uint32_t)S3DFS_HEADER_LEN) != 0 ||
            (chained && write_fully(s->wr_fd, link, (uint32_t)S3DFS_EXT_LINK_LEN) != 0) ||
            write_fully(s->wr_fd, key, key_len) != 0 ||
            (value_len && value && write_fully(s->wr_fd, value, value_len) != 0) ||
            write_fully(s->wr_fd, &tail, (uint32_t)S3DFS_TAIL_LEN) != 0) {
            return S3DFS_ERR_IO;
        }
        s->wr_size += total;
        s->stats.bytes_on_disk += total;
        s->stats.flushes++;
        if (s->fsync_on_flush) {
            if (fsync(s->wr_fd) != 0) {
                return S3DFS_ERR_IO;
            }
            s->stats.fsyncs++;
        }
    }

    *out_block = s->wr_block_id;
    *out_off = offset;
    if (out_rec_len) {
        *out_rec_len = total;
    }
    return S3DFS_OK;
}

static uint32_t count_extents(uint32_t value_len, uint32_t key_len, uint64_t remain, uint64_t block_size)
{
    uint32_t overhead = rec_total_len_ex(key_len, 0, 1);
    if (block_size <= overhead) {
        return 0;
    }
    uint32_t n = 0;
    uint32_t left = value_len;
    uint64_t r = remain;
    while (left) {
        if (r <= overhead) {
            r = block_size;
        }
        uint64_t room = r - overhead;
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

static int put_object_unlocked(s3dfs_store *s, const char *key, uint32_t key_len, const void *value,
                               uint32_t value_len, uint32_t crc, uint64_t mtime)
{
    uint32_t v1_total = rec_total_len(key_len, value_len);
    uint64_t used = (s->wr_fd >= 0) ? (s->wr_size + s->buf_used) : 0;
    uint64_t remain = (s->wr_fd >= 0 && used < s->block_size) ? (s->block_size - used) : s->block_size;

    if (v1_total <= s->block_size && v1_total <= remain) {
        uint64_t block = 0, off = 0;
        int rc = append_record(s, key, key_len, value, value_len, 0, crc, mtime, NULL, &block, &off, NULL);
        if (rc != S3DFS_OK) {
            return rc;
        }
        idx_loc loc;
        memset(&loc, 0, sizeof(loc));
        loc.chained = 0;
        loc.crc = crc;
        loc.mtime_ms = mtime;
        loc.total_size = value_len;
        loc.extent_count = 1;
        loc.block_id = block;
        loc.offset = off;
        return idx_upsert(s, key, key_len, &loc, 0);
    }

    uint32_t overhead = rec_total_len_ex(key_len, 0, 1);
    if (s->block_size <= overhead) {
        return S3DFS_ERR_ARGS;
    }
    if (remain <= overhead) {
        int rc = flush_buffer_unlocked(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        rc = close_write_fd(s);
        if (rc != S3DFS_OK) {
            return rc;
        }
        remain = s->block_size;
        if (v1_total <= s->block_size) {
            uint64_t block = 0, off = 0;
            rc = append_record(s, key, key_len, value, value_len, 0, crc, mtime, NULL, &block, &off, NULL);
            if (rc != S3DFS_OK) {
                return rc;
            }
            idx_loc loc;
            memset(&loc, 0, sizeof(loc));
            loc.chained = 0;
            loc.crc = crc;
            loc.mtime_ms = mtime;
            loc.total_size = value_len;
            loc.extent_count = 1;
            loc.block_id = block;
            loc.offset = off;
            return idx_upsert(s, key, key_len, &loc, 0);
        }
    }

    uint32_t n_ext = count_extents(value_len, key_len, remain, s->block_size);
    if (n_ext == 0) {
        return S3DFS_ERR_ARGS;
    }

    uint64_t gen = ++s->put_generation;
    s3dfs_ext_link prev;
    memset(&prev, 0, sizeof(prev));
    const uint8_t *src = (const uint8_t *)value;
    uint32_t left = value_len;
    uint32_t seq = 0;
    uint64_t last_block = 0, last_off = 0;
    uint32_t last_rec_len = 0;

    while (left) {
        used = (s->wr_fd >= 0) ? (s->wr_size + s->buf_used) : 0;
        remain = (s->wr_fd >= 0 && used < s->block_size) ? (s->block_size - used) : s->block_size;
        if (remain <= overhead) {
            int rc = flush_buffer_unlocked(s);
            if (rc != S3DFS_OK) {
                return rc;
            }
            rc = close_write_fd(s);
            if (rc != S3DFS_OK) {
                return rc;
            }
            remain = s->block_size;
        }
        uint64_t room = remain - overhead;
        uint32_t chunk = left <= room ? left : (uint32_t)room;
        int is_last = (chunk == left);
        s3dfs_ext_link link = prev;
        link.seq = seq;
        link.generation = gen;
        link.total_size = value_len;
        link.extent_count = n_ext;
        uint8_t flags = (uint8_t)(S3DFS_FLAG_EXTENT | (is_last ? S3DFS_FLAG_LAST : 0));
        uint64_t block = 0, off = 0;
        uint32_t rec_len = 0;
        int rc = append_record(s, key, key_len, src, chunk, flags, is_last ? crc : 0, mtime, &link, &block,
                               &off, &rec_len);
        if (rc != S3DFS_OK) {
            return rc;
        }
        memset(&prev, 0, sizeof(prev));
        prev.prev_block_id = block;
        prev.prev_offset = off;
        prev.prev_rec_len = rec_len;
        last_block = block;
        last_off = off;
        last_rec_len = rec_len;
        src += chunk;
        left -= chunk;
        seq++;
    }

    idx_loc loc;
    memset(&loc, 0, sizeof(loc));
    loc.chained = 1;
    loc.crc = crc;
    loc.mtime_ms = mtime;
    loc.total_size = value_len;
    loc.generation = gen;
    loc.extent_count = n_ext;
    loc.block_id = last_block;
    loc.offset = last_off;
    loc.rec_len = last_rec_len;
    return idx_upsert(s, key, key_len, &loc, 0);
}


static int replay_block_from(s3dfs_store *s, uint64_t id, uint64_t start_off, uint64_t *size_out,
                             int add_disk_bytes)
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
    uint64_t off = start_off;
    uint8_t *tmp = NULL;
    uint32_t tmp_cap = 0;
    while (off + S3DFS_HEADER_LEN + S3DFS_TAIL_LEN <= size) {
        s3dfs_rec_header hdr;
        if (pread(fd, &hdr, S3DFS_HEADER_LEN, (off_t)off) != (ssize_t)S3DFS_HEADER_LEN) {
            break;
        }
        if (hdr.magic != S3DFS_HDR_MAGIC) {
            break;
        }
        int chained = (hdr.flags & S3DFS_FLAG_EXTENT) ? 1 : 0;
        uint32_t total = rec_total_len_ex(hdr.key_len, hdr.value_len, chained);
        if (total < rec_total_len_ex(hdr.key_len, 0, chained) || off + total > size) {
            break;
        }
        if (total > tmp_cap) {
            free(tmp);
            tmp = (uint8_t *)malloc(total);
            if (!tmp) {
                close(fd);
                return S3DFS_ERR_NOMEM;
            }
            tmp_cap = total;
        }
        if (pread(fd, tmp, total, (off_t)off) != (ssize_t)total) {
            break;
        }
        s3dfs_rec_tail tail;
        memcpy(&tail, tmp + total - S3DFS_TAIL_LEN, S3DFS_TAIL_LEN);
        if (tail.magic != S3DFS_TAIL_MAGIC || tail.rec_len != total) {
            break;
        }
        const char *key = (const char *)(tmp + S3DFS_HEADER_LEN + (chained ? S3DFS_EXT_LINK_LEN : 0));
        if (hdr.flags & S3DFS_FLAG_TOMBSTONE) {
            if (idx_upsert(s, key, hdr.key_len, NULL, 1) != S3DFS_OK) {
                free(tmp);
                close(fd);
                return S3DFS_ERR;
            }
        } else if (chained) {
            if (hdr.flags & S3DFS_FLAG_LAST) {
                s3dfs_ext_link link;
                memcpy(&link, tmp + S3DFS_HEADER_LEN, S3DFS_EXT_LINK_LEN);
                idx_loc loc;
                memset(&loc, 0, sizeof(loc));
                loc.chained = 1;
                loc.crc = hdr.crc;
                loc.mtime_ms = hdr.mtime_ms;
                loc.total_size = link.total_size;
                loc.generation = link.generation;
                loc.extent_count = link.extent_count;
                loc.block_id = id;
                loc.offset = off;
                loc.rec_len = total;
                if (idx_upsert(s, key, hdr.key_len, &loc, 0) != S3DFS_OK) {
                    free(tmp);
                    close(fd);
                    return S3DFS_ERR;
                }
            }
            /* intermediate extents are reached by walking prev from the last record */
        } else {
            idx_loc loc;
            memset(&loc, 0, sizeof(loc));
            loc.chained = 0;
            loc.crc = hdr.crc;
            loc.mtime_ms = hdr.mtime_ms;
            loc.total_size = hdr.value_len;
            loc.extent_count = 1;
            loc.block_id = id;
            loc.offset = off;
            if (idx_upsert(s, key, hdr.key_len, &loc, 0) != S3DFS_OK) {
                free(tmp);
                close(fd);
                return S3DFS_ERR;
            }
        }
        off += total;
    }
    free(tmp);
    close(fd);
    *size_out = off;
    if (add_disk_bytes) {
        s->stats.bytes_on_disk += off;
    } else if (off > start_off) {
        s->stats.bytes_on_disk += (off - start_off);
    }
    return S3DFS_OK;
}


static int replay_all(s3dfs_store *s)
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
    memset(&s->stats, 0, sizeof(s->stats));
    s->stats.block_files = n;
    s->wr_block_id = 0;
    s->wr_size = 0;
    uint64_t last_size = 0;
    uint64_t last_id = 0;
    for (uint32_t i = 0; i < n; i++) {
        uint64_t sz = 0;
        int rc = replay_block_from(s, ids[i], 0, &sz, 1);
        if (rc != S3DFS_OK) {
            free(ids);
            return rc;
        }
        last_id = ids[i];
        last_size = sz;
    }
    free(ids);
    if (last_id && last_size < s->block_size) {
        if (open_block_for_write(s, last_id, last_size) != S3DFS_OK) {
            return S3DFS_ERR_IO;
        }
    } else {
        s->wr_block_id = last_id;
        s->wr_size = last_size;
    }
    return idx_commit(s);
}

static int recover_from_meta(s3dfs_store *s)
{
    if (s->wr_block_id == 0) {
        return S3DFS_OK;
    }
    char path[4096];
    block_path(s, s->wr_block_id, path, sizeof(path));
    struct stat st;
    if (stat(path, &st) != 0) {
        /* committed file missing; fall back to a full rebuild */
        return replay_all(s);
    }
    uint64_t file_size = (uint64_t)st.st_size;
    uint64_t committed = s->wr_size;
    if (file_size > committed) {
        uint64_t sz = 0;
        int rc = replay_block_from(s, s->wr_block_id, committed, &sz, 0);
        if (rc != S3DFS_OK) {
            return rc;
        }
        committed = sz;
    }

    /* A multi-block put may have rotated into newer files before the index commit. */
    DIR *d = opendir(s->blocks_dir);
    uint64_t *ids = NULL;
    uint32_t n = 0, cap = 0;
    if (d) {
        struct dirent *de;
        while ((de = readdir(d)) != NULL) {
            unsigned long long id = 0;
            if (sscanf(de->d_name, "%020llu.blk", &id) != 1) {
                continue;
            }
            if ((uint64_t)id <= s->wr_block_id) {
                continue;
            }
            if (n == cap) {
                cap = cap ? cap * 2 : 8;
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
    }
    if (n > 1) {
        qsort(ids, n, sizeof(uint64_t), cmp_u64);
    }
    uint64_t last_id = s->wr_block_id;
    uint64_t last_size = committed;
    for (uint32_t i = 0; i < n; i++) {
        uint64_t sz = 0;
        int rc = replay_block_from(s, ids[i], 0, &sz, 1);
        if (rc != S3DFS_OK) {
            free(ids);
            return rc;
        }
        last_id = ids[i];
        last_size = sz;
    }
    free(ids);

    if (last_size < s->block_size) {
        if (open_block_for_write(s, last_id, last_size) != S3DFS_OK) {
            return S3DFS_ERR_IO;
        }
    } else {
        s->wr_block_id = last_id;
        s->wr_size = last_size;
    }
    return idx_commit(s);
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
    snprintf(s->index_dir, sizeof(s->index_dir), "%s/index", data_dir);
    s->block_size = (opt && opt->block_size) ? opt->block_size : S3DFS_DEFAULT_BLOCK_SIZE;
    s->buffer_size = (opt && opt->buffer_size) ? opt->buffer_size : S3DFS_DEFAULT_BUFFER_SIZE;
    if (s->buffer_size < S3DFS_MIN_BUFFER_SIZE) {
        s->buffer_size = S3DFS_MIN_BUFFER_SIZE;
    }
    s->fsync_on_flush = (!opt || opt->fsync_on_flush) ? 1 : 0;
    s->wr_fd = -1;
    s->buf = (uint8_t *)malloc(s->buffer_size);
    pthread_mutex_init(&s->mu, NULL);
    if (!s->buf || mkdir_p(s->data_dir) != 0 || mkdir_p(s->blocks_dir) != 0 ||
        mkdir_p(s->index_dir) != 0 || idx_open(s) != S3DFS_OK) {
        s3dfs_close(s);
        return NULL;
    }
    int has_meta = 0;
    if (idx_load_meta(s, &has_meta) != S3DFS_OK) {
        s3dfs_close(s);
        return NULL;
    }
    int rc = has_meta ? recover_from_meta(s) : replay_all(s);
    if (rc != S3DFS_OK) {
        s3dfs_close(s);
        return NULL;
    }
    return s;
}

void s3dfs_close(s3dfs_store *s)
{
    if (!s) {
        return;
    }
    pthread_mutex_lock(&s->mu);
    flush_buffer_unlocked(s);
    close_write_fd(s);
    idx_close(s);
    pend_clear(s);
    free(s->pend);
    list_keys_reset(s);
    free(s->list_keys);
    free(s->buf);
    pthread_mutex_unlock(&s->mu);
    pthread_mutex_destroy(&s->mu);
    free(s);
}

int s3dfs_put(s3dfs_store *s, const char *key, uint32_t key_len, const void *value, uint32_t value_len)
{
    if (!s || !key || key_len == 0) {
        return S3DFS_ERR_ARGS;
    }
    uint64_t mtime = now_ms();
    uint32_t crc = crc32_key_value(key, key_len, value, value_len);
    pthread_mutex_lock(&s->mu);
    int rc = put_object_unlocked(s, key, key_len, value, value_len, crc, mtime);
    if (rc == S3DFS_OK) {
        s->stats.puts++;
    }
    pthread_mutex_unlock(&s->mu);
    return rc;
}


int s3dfs_put_batch(s3dfs_store *s, const s3dfs_put_item *items, uint32_t n)
{
    if (!s || (n > 0 && !items)) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    int rc = S3DFS_OK;
    for (uint32_t i = 0; i < n; i++) {
        if (!items[i].key || items[i].key_len == 0) {
            rc = S3DFS_ERR_ARGS;
            break;
        }
        uint64_t mtime = now_ms();
        uint32_t crc = crc32_key_value(items[i].key, items[i].key_len, items[i].value, items[i].value_len);
        rc = put_object_unlocked(s, items[i].key, items[i].key_len, items[i].value, items[i].value_len, crc,
                                 mtime);
        if (rc != S3DFS_OK) {
            break;
        }
        s->stats.puts++;
    }
    if (rc == S3DFS_OK) {
        rc = flush_buffer_unlocked(s);
    }
    pthread_mutex_unlock(&s->mu);
    return rc;
}


static int load_record(s3dfs_store *s, uint64_t block_id, uint64_t offset, uint32_t rec_len, uint8_t **out)
{
    if (rec_len == 0) {
        return S3DFS_ERR_IO;
    }
    uint8_t *tmp = (uint8_t *)malloc(rec_len);
    if (!tmp) {
        return S3DFS_ERR_NOMEM;
    }
    if (s->wr_fd >= 0 && block_id == s->wr_block_id && offset >= s->wr_size) {
        uint64_t buf_off = offset - s->wr_size;
        if (buf_off + rec_len <= s->buf_used) {
            memcpy(tmp, s->buf + buf_off, rec_len);
            *out = tmp;
            return S3DFS_OK;
        }
        free(tmp);
        return S3DFS_ERR_IO;
    }
    char path[4096];
    block_path(s, block_id, path, sizeof(path));
    int same = (s->wr_fd >= 0 && block_id == s->wr_block_id);
    int fd = same ? s->wr_fd : open(path, O_RDONLY);
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

static int walk_chain(s3dfs_store *s, const idx_loc *loc, uint32_t key_len, uint64_t **blocks_out,
                      uint64_t **offs_out, uint32_t **rec_lens_out, uint32_t **val_lens_out, uint32_t *n_out)
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

    uint64_t block = loc->block_id;
    uint64_t off = loc->offset;
    uint32_t rec_len = loc->rec_len;
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
        int rc = load_record(s, block, off, rec_len, &rec);
        if (rc != S3DFS_OK) {
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return rc;
        }
        s3dfs_rec_header hdr;
        memcpy(&hdr, rec, S3DFS_HEADER_LEN);
        if (hdr.magic != S3DFS_HDR_MAGIC || !(hdr.flags & S3DFS_FLAG_EXTENT) || hdr.key_len != key_len) {
            free(rec);
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return S3DFS_ERR_IO;
        }
        s3dfs_ext_link link;
        memcpy(&link, rec + S3DFS_HEADER_LEN, S3DFS_EXT_LINK_LEN);
        free(rec);
        if (loc->generation && link.generation != loc->generation) {
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return S3DFS_ERR_IO;
        }
        blocks[n] = block;
        offs[n] = off;
        rec_lens[n] = rec_len;
        val_lens[n] = hdr.value_len;
        n++;
        if (link.prev_rec_len == 0) {
            break;
        }
        block = link.prev_block_id;
        off = link.prev_offset;
        rec_len = link.prev_rec_len;
    }
    if (loc->extent_count && n != loc->extent_count) {
        free(blocks);
        free(offs);
        free(rec_lens);
        free(val_lens);
        return S3DFS_ERR_IO;
    }
    /* records were collected last-to-first; reverse so callers read front to back */
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

static int read_value(s3dfs_store *s, const idx_loc *e, uint32_t key_len, void **out, uint32_t *out_len)
{
    if (e->total_size > UINT32_MAX) {
        return S3DFS_ERR_ARGS;
    }
    uint32_t size = (uint32_t)e->total_size;
    if (!e->chained) {
        uint32_t total = rec_total_len(key_len, size);
        uint8_t *tmp = NULL;
        int rc;
        if (s->wr_fd >= 0 && e->block_id == s->wr_block_id && e->offset >= s->wr_size) {
            uint64_t buf_off = e->offset - s->wr_size;
            if (buf_off + total > s->buf_used) {
                return S3DFS_ERR_IO;
            }
            const uint8_t *p = s->buf + buf_off + S3DFS_HEADER_LEN + key_len;
            void *copy = malloc(size ? size : 1);
            if (!copy) {
                return S3DFS_ERR_NOMEM;
            }
            if (size) {
                memcpy(copy, p, size);
            }
            *out = copy;
            *out_len = size;
            return S3DFS_OK;
        }
        rc = load_record(s, e->block_id, e->offset, total, &tmp);
        if (rc != S3DFS_OK) {
            return rc;
        }
        void *copy = malloc(size ? size : 1);
        if (!copy) {
            free(tmp);
            return S3DFS_ERR_NOMEM;
        }
        if (size) {
            memcpy(copy, tmp + S3DFS_HEADER_LEN + key_len, size);
        }
        free(tmp);
        *out = copy;
        *out_len = size;
        return S3DFS_OK;
    }

    uint64_t *blocks = NULL, *offs = NULL;
    uint32_t *rec_lens = NULL, *val_lens = NULL, n = 0;
    int rc = walk_chain(s, e, key_len, &blocks, &offs, &rec_lens, &val_lens, &n);
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
        rc = load_record(s, blocks[i], offs[i], rec_lens[i], &rec);
        if (rc != S3DFS_OK) {
            free(copy);
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return rc;
        }
        uint32_t payload = val_lens[i];
        if ((uint64_t)copied + payload > size) {
            free(rec);
            free(copy);
            free(blocks);
            free(offs);
            free(rec_lens);
            free(val_lens);
            return S3DFS_ERR_IO;
        }
        if (payload) {
            memcpy((uint8_t *)copy + copied, rec + S3DFS_HEADER_LEN + S3DFS_EXT_LINK_LEN + key_len, payload);
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


int s3dfs_get(s3dfs_store *s, const char *key, uint32_t key_len, void **out, uint32_t *out_len,
              uint32_t *crc, uint64_t *mtime_ms)
{
    if (!s || !key || !out || !out_len) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    idx_loc e;
    int found = 0;
    int rc = idx_lookup(s, key, key_len, &e, &found);
    if (rc != S3DFS_OK || !found) {
        pthread_mutex_unlock(&s->mu);
        return S3DFS_ERR_NOT_FOUND;
    }
    rc = read_value(s, &e, key_len, out, out_len);
    if (rc == S3DFS_OK) {
        if (crc) {
            *crc = e.crc;
        }
        if (mtime_ms) {
            *mtime_ms = e.mtime_ms;
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

int s3dfs_head(s3dfs_store *s, const char *key, uint32_t key_len, uint32_t *size, uint32_t *crc,
               uint64_t *mtime_ms)
{
    if (!s || !key) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    idx_loc e;
    int found = 0;
    int rc = idx_lookup(s, key, key_len, &e, &found);
    if (rc != S3DFS_OK || !found) {
        pthread_mutex_unlock(&s->mu);
        return S3DFS_ERR_NOT_FOUND;
    }
    if (size) {
        *size = e.total_size > UINT32_MAX ? UINT32_MAX : (uint32_t)e.total_size;
    }
    if (crc) {
        *crc = e.crc;
    }
    if (mtime_ms) {
        *mtime_ms = e.mtime_ms;
    }
    pthread_mutex_unlock(&s->mu);
    return S3DFS_OK;
}


int s3dfs_delete(s3dfs_store *s, const char *key, uint32_t key_len)
{
    if (!s || !key || key_len == 0) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    idx_loc e;
    int found = 0;
    int rc = idx_lookup(s, key, key_len, &e, &found);
    if (rc != S3DFS_OK || !found) {
        pthread_mutex_unlock(&s->mu);
        return S3DFS_ERR_NOT_FOUND;
    }
    uint64_t mtime = now_ms();
    uint64_t block = 0, off = 0;
    rc = append_record(s, key, key_len, NULL, 0, S3DFS_FLAG_TOMBSTONE, 0, mtime, NULL, &block, &off, NULL);
    if (rc == S3DFS_OK) {
        rc = idx_upsert(s, key, key_len, NULL, 1);
        s->stats.deletes++;
    }
    pthread_mutex_unlock(&s->mu);
    return rc;
}


int s3dfs_flush(s3dfs_store *s)
{
    if (!s) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    int rc = flush_buffer_unlocked(s);
    pthread_mutex_unlock(&s->mu);
    return rc;
}

int s3dfs_list(s3dfs_store *s, const char *prefix, uint32_t prefix_len, const char *start_after,
               uint32_t start_after_len, uint32_t max_keys, s3dfs_object_info *out, uint32_t *out_n,
               int *truncated)
{
    if (!s || !out || !out_n) {
        return S3DFS_ERR_ARGS;
    }
    if (max_keys == 0) {
        max_keys = 1000;
    }
    pthread_mutex_lock(&s->mu);
    list_keys_reset(s);

    /* Commit pending so list can scan LevelDB in key order. Unflushed data
       stays readable from the write buffer; a crash still recovers via tail replay. */
    if (s->pend_n && idx_commit(s) != S3DFS_OK) {
        pthread_mutex_unlock(&s->mu);
        return S3DFS_ERR_IO;
    }

    char seek_buf[4096];
    char *seek = seek_buf;
    size_t seek_len = 1;
    int heap = 0;
    const char *seek_key = prefix;
    uint32_t seek_key_len = prefix_len;
    if (start_after && start_after_len) {
        if (!prefix_len || (start_after_len >= prefix_len && memcmp(start_after, prefix, prefix_len) == 0 &&
                            cmp_bytes(start_after, start_after_len, prefix, prefix_len) > 0)) {
            seek_key = start_after;
            seek_key_len = start_after_len;
        }
    }
    seek_len = (size_t)seek_key_len + 1;
    if (seek_len > sizeof(seek_buf)) {
        seek = (char *)malloc(seek_len);
        if (!seek) {
            pthread_mutex_unlock(&s->mu);
            return S3DFS_ERR_NOMEM;
        }
        heap = 1;
    }
    seek[0] = OBJ_KEY_PREFIX;
    if (seek_key_len) {
        memcpy(seek + 1, seek_key, seek_key_len);
    }

    leveldb_iterator_t *it = leveldb_create_iterator(s->db, s->db_ro);
    if (seek_key_len == 0 && !(start_after && start_after_len)) {
        char start[1] = {OBJ_KEY_PREFIX};
        leveldb_iter_seek(it, start, 1);
    } else {
        leveldb_iter_seek(it, seek, seek_len);
        if (start_after && start_after_len && leveldb_iter_valid(it)) {
            size_t klen = 0;
            const char *k = leveldb_iter_key(it, &klen);
            if (klen == seek_len && memcmp(k, seek, seek_len) == 0) {
                leveldb_iter_next(it);
            }
        }
    }
    if (heap) {
        free(seek);
    }

    uint32_t n = 0;
    int trunc = 0;
    for (; leveldb_iter_valid(it); leveldb_iter_next(it)) {
        size_t klen = 0, vlen = 0;
        const char *k = leveldb_iter_key(it, &klen);
        const char *v = leveldb_iter_value(it, &vlen);
        if (!k || klen == 0 || k[0] != OBJ_KEY_PREFIX) {
            break;
        }
        const char *okey = k + 1;
        uint32_t olen = (uint32_t)(klen - 1);
        if (prefix && prefix_len) {
            if (olen < prefix_len || memcmp(okey, prefix, prefix_len) != 0) {
                break;
            }
        }
        idx_loc val;
        if (idx_decode(v, vlen, &val) != S3DFS_OK) {
            continue;
        }
        if (n == max_keys) {
            trunc = 1;
            break;
        }
        const char *copy = list_keys_copy(s, okey, olen);
        if (!copy) {
            leveldb_iter_destroy(it);
            pthread_mutex_unlock(&s->mu);
            return S3DFS_ERR_NOMEM;
        }
        out[n].key = copy;
        out[n].key_len = olen;
        out[n].size = val.total_size > UINT32_MAX ? UINT32_MAX : (uint32_t)val.total_size;
        out[n].crc = val.crc;
        out[n].mtime_ms = val.mtime_ms;
        n++;
    }
    leveldb_iter_destroy(it);
    *out_n = n;
    if (truncated) {
        *truncated = trunc;
    }
    pthread_mutex_unlock(&s->mu);
    return S3DFS_OK;
}

typedef struct {
    char *key;
    uint32_t key_len;
    idx_loc val;
} live_ent;

int s3dfs_compact(s3dfs_store *s)
{
    if (!s) {
        return S3DFS_ERR_ARGS;
    }
    pthread_mutex_lock(&s->mu);
    int rc = flush_buffer_unlocked(s);
    if (rc != S3DFS_OK) {
        pthread_mutex_unlock(&s->mu);
        return rc;
    }
    rc = close_write_fd(s);
    if (rc != S3DFS_OK) {
        pthread_mutex_unlock(&s->mu);
        return rc;
    }

    live_ent *ents = NULL;
    uint32_t n = 0, cap = 0;
    leveldb_iterator_t *it = leveldb_create_iterator(s->db, s->db_ro);
    char start[1] = {OBJ_KEY_PREFIX};
    leveldb_iter_seek(it, start, 1);
    for (; leveldb_iter_valid(it); leveldb_iter_next(it)) {
        size_t klen = 0, vlen = 0;
        const char *k = leveldb_iter_key(it, &klen);
        const char *v = leveldb_iter_value(it, &vlen);
        if (!k || klen == 0 || k[0] != OBJ_KEY_PREFIX) {
            break;
        }
        idx_loc val;
        if (idx_decode(v, vlen, &val) != S3DFS_OK) {
            continue;
        }
        if (n == cap) {
            cap = cap ? cap * 2 : 64;
            live_ent *p = (live_ent *)realloc(ents, cap * sizeof(live_ent));
            if (!p) {
                rc = S3DFS_ERR_NOMEM;
                break;
            }
            ents = p;
        }
        ents[n].key_len = (uint32_t)(klen - 1);
        ents[n].key = (char *)malloc(ents[n].key_len + 1);
        if (!ents[n].key) {
            rc = S3DFS_ERR_NOMEM;
            break;
        }
        memcpy(ents[n].key, k + 1, ents[n].key_len);
        ents[n].key[ents[n].key_len] = 0;
        ents[n].val = val;
        n++;
    }
    leveldb_iter_destroy(it);
    if (rc != S3DFS_OK) {
        for (uint32_t i = 0; i < n; i++) {
            free(ents[i].key);
        }
        free(ents);
        pthread_mutex_unlock(&s->mu);
        return rc;
    }

    uint64_t *old_ids = NULL;
    uint32_t old_n = 0, old_cap = 0;
    DIR *d = opendir(s->blocks_dir);
    if (d) {
        struct dirent *de;
        while ((de = readdir(d)) != NULL) {
            unsigned long long id = 0;
            if (sscanf(de->d_name, "%020llu.blk", &id) != 1) {
                continue;
            }
            if (old_n == old_cap) {
                old_cap = old_cap ? old_cap * 2 : 16;
                uint64_t *p = (uint64_t *)realloc(old_ids, old_cap * sizeof(uint64_t));
                if (!p) {
                    rc = S3DFS_ERR_NOMEM;
                    break;
                }
                old_ids = p;
            }
            old_ids[old_n++] = (uint64_t)id;
        }
        closedir(d);
    }
    if (rc != S3DFS_OK) {
        for (uint32_t i = 0; i < n; i++) {
            free(ents[i].key);
        }
        free(ents);
        free(old_ids);
        pthread_mutex_unlock(&s->mu);
        return rc;
    }

    uint64_t next_id = 1;
    for (uint32_t i = 0; i < old_n; i++) {
        if (old_ids[i] + 1 > next_id) {
            next_id = old_ids[i] + 1;
        }
    }
    s->wr_block_id = next_id - 1;
    s->stats.bytes_on_disk = 0;

    for (uint32_t i = 0; i < n; i++) {
        void *val = NULL;
        uint32_t len = 0;
        rc = read_value(s, &ents[i].val, ents[i].key_len, &val, &len);
        if (rc != S3DFS_OK) {
            break;
        }
        rc = put_object_unlocked(s, ents[i].key, ents[i].key_len, val, len, ents[i].val.crc,
                                 ents[i].val.mtime_ms);
        free(val);
        if (rc != S3DFS_OK) {
            break;
        }
    }
    if (rc == S3DFS_OK) {
        rc = flush_buffer_unlocked(s);
    }
    if (rc == S3DFS_OK) {
        /* New objects were written starting at next_id. Only remove pre-compaction files. */
        for (uint32_t i = 0; i < old_n; i++) {
            if (old_ids[i] >= next_id) {
                continue;
            }
            if (s->wr_fd >= 0 && old_ids[i] == s->wr_block_id) {
                continue;
            }
            char path[4096];
            block_path(s, old_ids[i], path, sizeof(path));
            unlink(path);
        }
        uint64_t files = 0;
        DIR *d2 = opendir(s->blocks_dir);
        if (d2) {
            struct dirent *de;
            while ((de = readdir(d2)) != NULL) {
                unsigned long long id = 0;
                if (sscanf(de->d_name, "%020llu.blk", &id) == 1) {
                    files++;
                }
            }
            closedir(d2);
        }
        s->stats.block_files = files;
        s->stats.deleted = 0;
        rc = idx_commit(s);
    }
    for (uint32_t i = 0; i < n; i++) {
        free(ents[i].key);
    }
    free(ents);
    free(old_ids);
    pthread_mutex_unlock(&s->mu);
    return rc;
}

void s3dfs_get_stats(s3dfs_store *s, s3dfs_stats *out)
{
    if (!s || !out) {
        return;
    }
    pthread_mutex_lock(&s->mu);
    *out = s->stats;
    out->index_slots = s->stats.objects;
    if (s->db) {
        char *prop = leveldb_property_value(s->db, "leveldb.estimate-num-keys");
        if (prop) {
            unsigned long long est = 0;
            if (sscanf(prop, "%llu", &est) == 1) {
                out->index_slots = (uint64_t)est;
            }
            leveldb_free(prop);
        }
    }
    pthread_mutex_unlock(&s->mu);
}
