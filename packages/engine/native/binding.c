#define _GNU_SOURCE
#include <node_api.h>
#include <pthread.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "http.h"
#include "s3dfs.h"

typedef struct byte_part {
    napi_ref ref;
    const uint8_t *data;
    uint32_t len;
} byte_part;

typedef struct put_job {
    struct put_job *next;
    char *key;
    uint32_t key_len;
    byte_part *parts;
    uint32_t nparts;
    uint8_t *owned;
    s3dfs_put_meta meta;
    int has_meta;
    s3dfs_locator loc;
    int rc;
    napi_deferred deferred;
} put_job;

typedef struct writer_slot {
    uint64_t id;
    s3dfs_writer *writer;
    struct writer_slot *next;
} writer_slot;

typedef struct js_store {
    s3dfs_store *store;
    writer_slot *writers;
    uint64_t next_writer;
    int write_threads;
    pthread_t *threads;
    int nthreads;
    pthread_mutex_t qmu;
    pthread_cond_t qcv;
    put_job *qhead;
    put_job *qtail;
    int stop;
    int writers_started;
    napi_threadsafe_function completion;
    s3dfs_http *http;
    napi_threadsafe_function http_fallback;
} js_store;

typedef struct http_job {
    const char *method;
    const char *url;
    const char *const *names;
    const char *const *values;
    int nheaders;
    const uint8_t *body;
    size_t body_len;
    s3dfs_http_reply *reply;
    int rc;
    int done;
    pthread_mutex_t mu;
    pthread_cond_t cv;
} http_job;

static void finish_http_job(http_job *job)
{
    pthread_mutex_lock(&job->mu);
    job->done = 1;
    pthread_cond_signal(&job->cv);
    pthread_mutex_unlock(&job->mu);
}

static const char *err_msg(int rc)
{
    switch (rc) {
    case S3DFS_ERR_NOT_FOUND:
        return "not found";
    case S3DFS_ERR_IO:
        return "io error";
    case S3DFS_ERR_ARGS:
        return "invalid argument";
    case S3DFS_ERR_NOMEM:
        return "out of memory";
    default:
        return "s3dfs error";
    }
}

static napi_value throw_type(napi_env env, const char *msg)
{
    napi_throw_type_error(env, NULL, msg);
    return NULL;
}

static napi_value throw_rc(napi_env env, int rc)
{
    napi_throw_error(env, NULL, err_msg(rc));
    return NULL;
}

static napi_value undefined(napi_env env)
{
    napi_value v;
    napi_get_undefined(env, &v);
    return v;
}

static const char *compress_name(uint8_t t)
{
    if (t == 1) {
        return "zstd";
    }
    if (t == 2) {
        return "gzip";
    }
    return "none";
}

static uint8_t compress_code(const char *name)
{
    if (name && strcmp(name, "zstd") == 0) {
        return 1;
    }
    if (name && strcmp(name, "gzip") == 0) {
        return 2;
    }
    return 0;
}

static char *utf8_dup(napi_env env, napi_value v, uint32_t *out_len)
{
    size_t len = 0;
    if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) {
        return NULL;
    }
    char *s = (char *)malloc(len + 1);
    if (!s) {
        return NULL;
    }
    if (napi_get_value_string_utf8(env, v, s, len + 1, &len) != napi_ok) {
        free(s);
        return NULL;
    }
    if (out_len) {
        *out_len = (uint32_t)len;
    }
    return s;
}

static int named(napi_env env, napi_value obj, const char *name, napi_valuetype *type, napi_value *out)
{
    bool has = false;
    napi_has_named_property(env, obj, name, &has);
    if (!has) {
        return 0;
    }
    napi_get_named_property(env, obj, name, out);
    napi_typeof(env, *out, type);
    return 1;
}

static void set_bool(napi_env env, napi_value obj, const char *name, int on)
{
    napi_value v;
    napi_get_boolean(env, on ? true : false, &v);
    napi_set_named_property(env, obj, name, v);
}

static void set_num(napi_env env, napi_value obj, const char *name, double n)
{
    napi_value v;
    napi_create_double(env, n, &v);
    napi_set_named_property(env, obj, name, v);
}

static void set_str(napi_env env, napi_value obj, const char *name, const char *s, size_t len)
{
    napi_value v;
    napi_create_string_utf8(env, s, len, &v);
    napi_set_named_property(env, obj, name, v);
}

static napi_value loc_to_js(napi_env env, const s3dfs_locator *loc)
{
    napi_value o;
    napi_create_object(env, &o);
    set_bool(env, o, "chained", loc->chained != 0);
    set_bool(env, o, "tombstone", loc->tombstone != 0);
    set_num(env, o, "crc", loc->crc);
    set_num(env, o, "mtimeMs", (double)loc->mtime_ms);
    set_num(env, o, "size", (double)loc->size);
    set_num(env, o, "generation", (double)loc->generation);
    set_num(env, o, "extentCount", loc->extent_count);
    set_num(env, o, "recId", (double)loc->rec_id);
    set_str(env, o, "compressType", compress_name(loc->compress_type), NAPI_AUTO_LENGTH);
    set_num(env, o, "origSize", (double)loc->orig_size);
    set_num(env, o, "origCrc", loc->orig_crc);
    return o;
}

static int loc_from_js(napi_env env, napi_value value, s3dfs_locator *out)
{
    napi_valuetype t;
    napi_typeof(env, value, &t);
    if (t != napi_object) {
        return 0;
    }
    memset(out, 0, sizeof(*out));
    napi_value prop;
    napi_valuetype pt;
    if (named(env, value, "chained", &pt, &prop) && pt == napi_boolean) {
        bool b = false;
        napi_get_value_bool(env, prop, &b);
        out->chained = b ? 1 : 0;
    }
    if (named(env, value, "tombstone", &pt, &prop) && pt == napi_boolean) {
        bool b = false;
        napi_get_value_bool(env, prop, &b);
        out->tombstone = b ? 1 : 0;
    }
    if (named(env, value, "crc", &pt, &prop) && pt == napi_number) {
        uint32_t n = 0;
        napi_get_value_uint32(env, prop, &n);
        out->crc = n;
    }
    if (named(env, value, "mtimeMs", &pt, &prop) && pt == napi_number) {
        int64_t n = 0;
        napi_get_value_int64(env, prop, &n);
        out->mtime_ms = (uint64_t)n;
    }
    if (named(env, value, "size", &pt, &prop) && pt == napi_number) {
        int64_t n = 0;
        napi_get_value_int64(env, prop, &n);
        out->size = (uint64_t)n;
    }
    if (named(env, value, "generation", &pt, &prop) && pt == napi_number) {
        int64_t n = 0;
        napi_get_value_int64(env, prop, &n);
        out->generation = (uint64_t)n;
    }
    if (named(env, value, "extentCount", &pt, &prop) && pt == napi_number) {
        uint32_t n = 0;
        napi_get_value_uint32(env, prop, &n);
        out->extent_count = n;
    }
    if (named(env, value, "recId", &pt, &prop) && pt == napi_number) {
        int64_t n = 0;
        napi_get_value_int64(env, prop, &n);
        out->rec_id = (uint64_t)n;
    }
    if (named(env, value, "compressType", &pt, &prop) && pt == napi_string) {
        char *s = utf8_dup(env, prop, NULL);
        out->compress_type = compress_code(s);
        free(s);
    }
    if (named(env, value, "origSize", &pt, &prop) && pt == napi_number) {
        int64_t n = 0;
        napi_get_value_int64(env, prop, &n);
        out->orig_size = (uint64_t)n;
    }
    if (named(env, value, "origCrc", &pt, &prop) && pt == napi_number) {
        uint32_t n = 0;
        napi_get_value_uint32(env, prop, &n);
        out->orig_crc = n;
    }
    return out->rec_id != 0 || out->tombstone;
}

static int meta_from_js(napi_env env, napi_value value, s3dfs_put_meta *out)
{
    napi_valuetype t;
    napi_typeof(env, value, &t);
    memset(out, 0, sizeof(*out));
    if (t != napi_object) {
        return 0;
    }
    out->has_meta = 1;
    napi_value prop;
    napi_valuetype pt;
    if (named(env, value, "compressType", &pt, &prop) && pt == napi_string) {
        char *s = utf8_dup(env, prop, NULL);
        out->compress_type = compress_code(s);
        free(s);
    }
    if (named(env, value, "origSize", &pt, &prop) && pt == napi_number) {
        int64_t n = 0;
        napi_get_value_int64(env, prop, &n);
        out->orig_size = (uint64_t)n;
    }
    if (named(env, value, "origCrc", &pt, &prop) && pt == napi_number) {
        uint32_t n = 0;
        napi_get_value_uint32(env, prop, &n);
        out->orig_crc = n;
    }
    return 1;
}

static int is_buffer(napi_env env, napi_value v)
{
    bool yes = false;
    napi_is_buffer(env, v, &yes);
    return yes;
}

static int buffer_info(napi_env env, napi_value v, const uint8_t **data, uint32_t *len)
{
    void *p = NULL;
    size_t n = 0;
    if (!is_buffer(env, v) || napi_get_buffer_info(env, v, &p, &n) != napi_ok) {
        return -1;
    }
    *data = (const uint8_t *)p;
    *len = (uint32_t)n;
    return 0;
}

static js_store *unwrap(napi_env env, napi_callback_info info, size_t *argc, napi_value *args)
{
    napi_value jsthis;
    napi_get_cb_info(env, info, argc, args, &jsthis, NULL);
    js_store *st = NULL;
    if (napi_unwrap(env, jsthis, (void **)&st) != napi_ok || !st || !st->store) {
        napi_throw_error(env, NULL, "store is closed");
        return NULL;
    }
    return st;
}

static void release_job_refs(napi_env env, put_job *job)
{
    uint32_t i;
    for (i = 0; i < job->nparts; i++) {
        if (job->parts[i].ref) {
            napi_delete_reference(env, job->parts[i].ref);
            job->parts[i].ref = NULL;
        }
    }
}

static void free_job(put_job *job)
{
    free(job->parts);
    free(job->owned);
    free(job->key);
    free(job);
}

static void finish_put(napi_env env, napi_value js_cb, void *context, void *data)
{
    (void)js_cb;
    (void)context;
    put_job *job = (put_job *)data;
    if (!env) {
        free(job->parts);
        free(job->owned);
        free(job->key);
        free(job);
        return;
    }
    release_job_refs(env, job);
    if (job->rc != S3DFS_OK) {
        napi_value err;
        napi_value msg;
        napi_create_string_utf8(env, err_msg(job->rc), NAPI_AUTO_LENGTH, &msg);
        napi_create_error(env, NULL, msg, &err);
        napi_reject_deferred(env, job->deferred, err);
    } else {
        napi_resolve_deferred(env, job->deferred, loc_to_js(env, &job->loc));
    }
    free_job(job);
}

static void *write_loop(void *arg)
{
    js_store *st = (js_store *)arg;
#if defined(__APPLE__)
    pthread_setname_np("s3dfs-put");
#else
    pthread_setname_np(pthread_self(), "s3dfs-put");
#endif
    for (;;) {
        put_job *job = NULL;
        pthread_mutex_lock(&st->qmu);
        while (!st->stop && !st->qhead) {
            pthread_cond_wait(&st->qcv, &st->qmu);
        }
        if (st->stop && !st->qhead) {
            pthread_mutex_unlock(&st->qmu);
            return NULL;
        }
        job = st->qhead;
        st->qhead = job->next;
        if (!st->qhead) {
            st->qtail = NULL;
        }
        pthread_mutex_unlock(&st->qmu);

        const uint8_t *bytes = NULL;
        uint32_t len = 0;
        if (job->nparts == 1) {
            bytes = job->parts[0].data;
            len = job->parts[0].len;
        } else if (job->nparts > 1) {
            size_t total = 0;
            uint32_t i;
            size_t off = 0;
            for (i = 0; i < job->nparts; i++) {
                total += job->parts[i].len;
            }
            job->owned = (uint8_t *)malloc(total ? total : 1);
            if (!job->owned) {
                job->rc = S3DFS_ERR_NOMEM;
            } else {
                for (i = 0; i < job->nparts; i++) {
                    if (job->parts[i].len && job->parts[i].data) {
                        memcpy(job->owned + off, job->parts[i].data, job->parts[i].len);
                    }
                    off += job->parts[i].len;
                }
                bytes = job->owned;
                len = (uint32_t)total;
            }
        }
        if (job->rc == 0) {
            job->rc = s3dfs_put(st->store, job->key, job->key_len, bytes, len, job->has_meta ? &job->meta : NULL, &job->loc);
        }
        napi_call_threadsafe_function(st->completion, job, napi_tsfn_nonblocking);
    }
}

static void stop_writers(js_store *st)
{
    int i;
    pthread_mutex_lock(&st->qmu);
    st->stop = 1;
    pthread_cond_broadcast(&st->qcv);
    pthread_mutex_unlock(&st->qmu);
    for (i = 0; i < st->nthreads; i++) {
        pthread_join(st->threads[i], NULL);
    }
    free(st->threads);
    st->threads = NULL;
    st->nthreads = 0;
    if (st->completion) {
        napi_release_threadsafe_function(st->completion, napi_tsfn_release);
        st->completion = NULL;
    }
}

static int ensure_writers(napi_env env, js_store *st)
{
    napi_value name;
    int i;
    int n;
    if (st->writers_started) {
        return st->completion ? 0 : -1;
    }
    napi_create_string_utf8(env, "s3dfs-put", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, NULL, finish_put, &st->completion) != napi_ok) {
        return -1;
    }
    n = st->write_threads > 0 ? st->write_threads : 32;
    st->threads = (pthread_t *)calloc((size_t)n, sizeof(pthread_t));
    if (!st->threads) {
        return -1;
    }
    st->nthreads = n;
    st->writers_started = 1;
    for (i = 0; i < n; i++) {
        pthread_create(&st->threads[i], NULL, write_loop, st);
    }
    return 0;
}

static int hold_buffer(napi_env env, napi_value item, byte_part *part)
{
    void *data = NULL;
    size_t len = 0;
    memset(part, 0, sizeof(*part));
    if (!is_buffer(env, item) || napi_get_buffer_info(env, item, &data, &len) != napi_ok) {
        return -1;
    }
    if (napi_create_reference(env, item, 1, &part->ref) != napi_ok) {
        return -1;
    }
    part->data = (const uint8_t *)data;
    part->len = (uint32_t)len;
    return 0;
}

static void enqueue(js_store *st, put_job *job)
{
    pthread_mutex_lock(&st->qmu);
    if (st->qtail) {
        st->qtail->next = job;
    } else {
        st->qhead = job;
    }
    st->qtail = job;
    pthread_cond_signal(&st->qcv);
    pthread_mutex_unlock(&st->qmu);
}

static writer_slot *find_writer(js_store *st, uint64_t id)
{
    writer_slot *slot = st->writers;
    while (slot) {
        if (slot->id == id) {
            return slot;
        }
        slot = slot->next;
    }
    return NULL;
}

static void drop_writer(js_store *st, uint64_t id)
{
    writer_slot **prev = &st->writers;
    while (*prev) {
        if ((*prev)->id == id) {
            writer_slot *gone = *prev;
            *prev = gone->next;
            free(gone);
            return;
        }
        prev = &(*prev)->next;
    }
}

static napi_value Put(napi_env env, napi_callback_info info)
{
    size_t argc = 3;
    napi_value args[3];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    char *key;
    uint32_t key_len = 0;
    const uint8_t *data = NULL;
    uint32_t len = 0;
    s3dfs_put_meta meta;
    s3dfs_locator loc;
    int rc;
    if (argc < 2) {
        return throw_type(env, "put(key, buffer, meta?)");
    }
    napi_typeof(env, args[0], &t0);
    if (t0 != napi_string || buffer_info(env, args[1], &data, &len) != 0) {
        return throw_type(env, "put(key, buffer, meta?)");
    }
    key = utf8_dup(env, args[0], &key_len);
    if (!key) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    memset(&loc, 0, sizeof(loc));
    rc = s3dfs_put(st->store, key, key_len, data, len, (argc > 2 && meta_from_js(env, args[2], &meta)) ? &meta : NULL, &loc);
    free(key);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    return loc_to_js(env, &loc);
}

static napi_value PutAsync(napi_env env, napi_callback_info info)
{
    size_t argc = 3;
    napi_value args[3];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    bool is_arr = false;
    put_job *job;
    napi_value promise;
    uint32_t i;
    uint32_t n = 0;
    if (!st || !st->store || argc < 2) {
        return throw_type(env, "putAsync(key, buffer | buffer[], meta?)");
    }
    napi_typeof(env, args[0], &t0);
    napi_is_array(env, args[1], &is_arr);
    if (t0 != napi_string || (!is_buffer(env, args[1]) && !is_arr)) {
        return throw_type(env, "putAsync(key, buffer | buffer[], meta?)");
    }
    job = (put_job *)calloc(1, sizeof(*job));
    if (!job) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    job->key = utf8_dup(env, args[0], &job->key_len);
    if (!job->key) {
        free_job(job);
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    if (is_arr) {
        napi_get_array_length(env, args[1], &n);
    } else {
        n = 1;
    }
    if (n > 0) {
        job->parts = (byte_part *)calloc(n, sizeof(byte_part));
        if (!job->parts) {
            free_job(job);
            return throw_rc(env, S3DFS_ERR_NOMEM);
        }
    }
    for (i = 0; i < n; i++) {
        napi_value item = args[1];
        if (is_arr) {
            napi_get_element(env, args[1], i, &item);
        }
        if (hold_buffer(env, item, &job->parts[i]) != 0) {
            job->nparts = i;
            release_job_refs(env, job);
            free_job(job);
            return throw_type(env, "putAsync(key, buffer | buffer[], meta?)");
        }
        job->nparts = i + 1;
    }
    if (argc > 2 && meta_from_js(env, args[2], &job->meta)) {
        job->has_meta = 1;
    }
    napi_create_promise(env, &job->deferred, &promise);
    if (ensure_writers(env, st) != 0) {
        release_job_refs(env, job);
        free_job(job);
        napi_throw_error(env, NULL, "failed to queue put");
        return NULL;
    }
    enqueue(st, job);
    return promise;
}

static napi_value PutBatch(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    bool is_arr = false;
    uint32_t n = 0;
    uint32_t i;
    char **keys = NULL;
    s3dfs_put_item *items = NULL;
    s3dfs_locator *locs = NULL;
    napi_value out;
    int rc;
    if (argc < 1) {
        return throw_type(env, "putBatch([{key, value}])");
    }
    napi_is_array(env, args[0], &is_arr);
    if (!is_arr) {
        return throw_type(env, "putBatch([{key, value}])");
    }
    napi_get_array_length(env, args[0], &n);
    keys = (char **)calloc(n ? n : 1, sizeof(char *));
    items = (s3dfs_put_item *)calloc(n ? n : 1, sizeof(s3dfs_put_item));
    locs = (s3dfs_locator *)calloc(n ? n : 1, sizeof(s3dfs_locator));
    if (!keys || !items || !locs) {
        free(keys);
        free(items);
        free(locs);
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    for (i = 0; i < n; i++) {
        napi_value item;
        napi_value keyv;
        napi_value valv;
        napi_valuetype t;
        const uint8_t *data = NULL;
        uint32_t len = 0;
        napi_get_element(env, args[0], i, &item);
        napi_typeof(env, item, &t);
        if (t != napi_object) {
            rc = -1;
            goto fail_type;
        }
        napi_get_named_property(env, item, "key", &keyv);
        napi_get_named_property(env, item, "value", &valv);
        keys[i] = utf8_dup(env, keyv, &items[i].key_len);
        if (!keys[i] || buffer_info(env, valv, &data, &len) != 0) {
            rc = -1;
            goto fail_type;
        }
        items[i].key = keys[i];
        items[i].value = data;
        items[i].value_len = len;
    }
    rc = s3dfs_put_batch(st->store, items, n, NULL, locs);
    if (rc != S3DFS_OK) {
        for (i = 0; i < n; i++) {
            free(keys[i]);
        }
        free(keys);
        free(items);
        free(locs);
        return throw_rc(env, rc);
    }
    napi_create_array_with_length(env, n, &out);
    for (i = 0; i < n; i++) {
        napi_set_element(env, out, i, loc_to_js(env, &locs[i]));
        free(keys[i]);
    }
    free(keys);
    free(items);
    free(locs);
    return out;
fail_type:
    for (i = 0; i < n; i++) {
        free(keys[i]);
    }
    free(keys);
    free(items);
    free(locs);
    (void)rc;
    return throw_type(env, "batch item must be object");
}

static napi_value Get(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    char *key;
    uint32_t key_len = 0;
    s3dfs_locator loc;
    void *data = NULL;
    uint32_t len = 0;
    uint32_t crc = 0;
    uint64_t mtime = 0;
    int rc;
    napi_value buf;
    napi_value o;
    if (argc < 2) {
        return throw_type(env, "get(key, locator)");
    }
    napi_typeof(env, args[0], &t0);
    if (t0 != napi_string || !loc_from_js(env, args[1], &loc)) {
        return throw_type(env, "get(key, locator)");
    }
    key = utf8_dup(env, args[0], &key_len);
    if (!key) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    rc = s3dfs_get_at(st->store, key, key_len, &loc, &data, &len, &crc, &mtime);
    free(key);
    if (rc == S3DFS_ERR_NOT_FOUND) {
        napi_value n;
        napi_get_null(env, &n);
        return n;
    }
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    napi_create_buffer_copy(env, len, data, NULL, &buf);
    s3dfs_free(data);
    napi_create_object(env, &o);
    napi_set_named_property(env, o, "value", buf);
    set_num(env, o, "crc", crc);
    set_num(env, o, "mtimeMs", (double)mtime);
    set_num(env, o, "size", len);
    return o;
}

static napi_value GetSpan(napi_env env, napi_callback_info info)
{
    size_t argc = 4;
    napi_value args[4];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0, t2, t3;
    char *key;
    uint32_t key_len = 0;
    s3dfs_locator loc;
    double start = 0;
    double len = 0;
    void *data = NULL;
    uint32_t out_len = 0;
    int rc;
    napi_value buf;
    if (argc < 4) {
        return throw_type(env, "getSpan(key, locator, start, len)");
    }
    napi_typeof(env, args[0], &t0);
    napi_typeof(env, args[2], &t2);
    napi_typeof(env, args[3], &t3);
    if (t0 != napi_string || t2 != napi_number || t3 != napi_number || !loc_from_js(env, args[1], &loc)) {
        return throw_type(env, "getSpan(key, locator, start, len)");
    }
    key = utf8_dup(env, args[0], &key_len);
    if (!key) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    napi_get_value_double(env, args[2], &start);
    napi_get_value_double(env, args[3], &len);
    rc = s3dfs_read_span(st->store, key, key_len, &loc, (uint64_t)start, (uint64_t)len, &data, &out_len);
    free(key);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    napi_create_buffer_copy(env, out_len, data, NULL, &buf);
    s3dfs_free(data);
    return buf;
}

static napi_value PutChunks(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    bool is_arr = false;
    char *key;
    uint32_t key_len = 0;
    uint32_t n = 0;
    uint32_t i;
    s3dfs_writer *writer;
    s3dfs_locator loc;
    int rc;
    if (argc < 2) {
        return throw_type(env, "putChunks(key, buffers)");
    }
    napi_typeof(env, args[0], &t0);
    napi_is_array(env, args[1], &is_arr);
    if (t0 != napi_string || !is_arr) {
        return throw_type(env, "putChunks(key, buffers)");
    }
    key = utf8_dup(env, args[0], &key_len);
    if (!key) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    writer = s3dfs_write_begin(st->store, key, key_len, NULL);
    free(key);
    if (!writer) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    napi_get_array_length(env, args[1], &n);
    for (i = 0; i < n; i++) {
        napi_value item;
        const uint8_t *data = NULL;
        uint32_t len = 0;
        napi_get_element(env, args[1], i, &item);
        if (buffer_info(env, item, &data, &len) != 0) {
            s3dfs_write_abort(writer);
            return throw_type(env, "putChunks(key, buffers)");
        }
        rc = s3dfs_write(writer, data, len);
        if (rc != S3DFS_OK) {
            s3dfs_write_abort(writer);
            return throw_rc(env, rc);
        }
    }
    memset(&loc, 0, sizeof(loc));
    rc = s3dfs_write_finish(writer, &loc);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    return loc_to_js(env, &loc);
}

static napi_value WriteBegin(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    char *key;
    uint32_t key_len = 0;
    s3dfs_writer *writer;
    writer_slot *slot;
    napi_value idv;
    if (argc < 1) {
        return throw_type(env, "writeBegin(key)");
    }
    napi_typeof(env, args[0], &t0);
    if (t0 != napi_string) {
        return throw_type(env, "writeBegin(key)");
    }
    key = utf8_dup(env, args[0], &key_len);
    if (!key) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    writer = s3dfs_write_begin(st->store, key, key_len, NULL);
    free(key);
    if (!writer) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    slot = (writer_slot *)calloc(1, sizeof(*slot));
    if (!slot) {
        s3dfs_write_abort(writer);
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    slot->id = st->next_writer++;
    slot->writer = writer;
    slot->next = st->writers;
    st->writers = slot;
    napi_create_double(env, (double)slot->id, &idv);
    return idv;
}

static napi_value Write(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    int64_t id = 0;
    writer_slot *slot;
    const uint8_t *data = NULL;
    uint32_t len = 0;
    int rc;
    if (argc < 2) {
        return throw_type(env, "write(id, buffer)");
    }
    napi_typeof(env, args[0], &t0);
    if (t0 != napi_number || buffer_info(env, args[1], &data, &len) != 0) {
        return throw_type(env, "write(id, buffer)");
    }
    napi_get_value_int64(env, args[0], &id);
    slot = find_writer(st, (uint64_t)id);
    if (!slot) {
        napi_throw_error(env, NULL, "unknown writer");
        return NULL;
    }
    rc = s3dfs_write(slot->writer, data, len);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    return undefined(env);
}

static napi_value WriteFinish(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    int64_t id = 0;
    writer_slot *slot;
    s3dfs_writer *writer;
    s3dfs_locator loc;
    int rc;
    if (argc < 1) {
        return throw_type(env, "writeFinish(id, meta)");
    }
    napi_typeof(env, args[0], &t0);
    if (t0 != napi_number) {
        return throw_type(env, "writeFinish(id, meta)");
    }
    napi_get_value_int64(env, args[0], &id);
    slot = find_writer(st, (uint64_t)id);
    if (!slot) {
        napi_throw_error(env, NULL, "unknown writer");
        return NULL;
    }
    writer = slot->writer;
    drop_writer(st, (uint64_t)id);
    if (argc >= 2) {
        s3dfs_put_meta meta;
        if (meta_from_js(env, args[1], &meta)) {
            s3dfs_write_set_meta(writer, &meta);
        }
    }
    memset(&loc, 0, sizeof(loc));
    rc = s3dfs_write_finish(writer, &loc);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    return loc_to_js(env, &loc);
}

static napi_value WriteAbort(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    int64_t id = 0;
    writer_slot *slot;
    if (argc < 1) {
        return throw_type(env, "writeAbort(id)");
    }
    napi_typeof(env, args[0], &t0);
    if (t0 != napi_number) {
        return throw_type(env, "writeAbort(id)");
    }
    napi_get_value_int64(env, args[0], &id);
    slot = find_writer(st, (uint64_t)id);
    if (!slot) {
        return undefined(env);
    }
    s3dfs_write_abort(slot->writer);
    drop_writer(st, (uint64_t)id);
    return undefined(env);
}

static napi_value Head(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    char *key;
    uint32_t key_len = 0;
    s3dfs_locator loc;
    uint64_t size = 0;
    uint32_t crc = 0;
    uint64_t mtime = 0;
    int rc;
    napi_value o;
    if (argc < 2) {
        return throw_type(env, "head(key, locator)");
    }
    napi_typeof(env, args[0], &t0);
    if (t0 != napi_string || !loc_from_js(env, args[1], &loc)) {
        return throw_type(env, "head(key, locator)");
    }
    key = utf8_dup(env, args[0], &key_len);
    if (!key) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    rc = s3dfs_head_at(st->store, key, key_len, &loc, &size, &crc, &mtime);
    free(key);
    if (rc == S3DFS_ERR_NOT_FOUND) {
        napi_value n;
        napi_get_null(env, &n);
        return n;
    }
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    napi_create_object(env, &o);
    set_num(env, o, "size", (double)size);
    set_num(env, o, "crc", crc);
    set_num(env, o, "mtimeMs", (double)mtime);
    return o;
}

static napi_value Tombstone(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1];
    js_store *st = unwrap(env, info, &argc, args);
    if (!st) {
        return NULL;
    }
    napi_valuetype t0;
    char *key;
    uint32_t key_len = 0;
    int rc;
    if (argc < 1) {
        return throw_type(env, "tombstone(key)");
    }
    napi_typeof(env, args[0], &t0);
    if (t0 != napi_string) {
        return throw_type(env, "tombstone(key)");
    }
    key = utf8_dup(env, args[0], &key_len);
    if (!key) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    rc = s3dfs_tombstone(st->store, key, key_len);
    free(key);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    return undefined(env);
}

typedef struct scan_item {
    char *key;
    uint32_t key_len;
    s3dfs_locator loc;
} scan_item;

typedef struct scan_collect {
    scan_item *items;
    size_t n;
    size_t cap;
} scan_collect;

static int scan_cb(void *user, const char *key, uint32_t key_len, const s3dfs_locator *loc)
{
    scan_collect *out = (scan_collect *)user;
    scan_item *grown;
    char *copy;
    if (out->n == out->cap) {
        size_t cap = out->cap ? out->cap * 2 : 64;
        grown = (scan_item *)realloc(out->items, cap * sizeof(scan_item));
        if (!grown) {
            return -1;
        }
        out->items = grown;
        out->cap = cap;
    }
    copy = (char *)malloc((size_t)key_len + 1);
    if (!copy) {
        return -1;
    }
    memcpy(copy, key, key_len);
    copy[key_len] = 0;
    out->items[out->n].key = copy;
    out->items[out->n].key_len = key_len;
    out->items[out->n].loc = *loc;
    out->n++;
    return 0;
}

static napi_value Scan(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    js_store *st = unwrap(env, info, &argc, NULL);
    if (!st) {
        return NULL;
    }
    scan_collect collected;
    size_t i;
    size_t j;
    size_t nlive = 0;
    int *live = NULL;
    size_t *index = NULL;
    size_t folded = 0;
    napi_value out;
    int rc;
    memset(&collected, 0, sizeof(collected));
    rc = s3dfs_scan(st->store, scan_cb, &collected);
    if (rc != S3DFS_OK) {
        for (i = 0; i < collected.n; i++) {
            free(collected.items[i].key);
        }
        free(collected.items);
        return throw_rc(env, rc);
    }
    live = (int *)calloc(collected.n ? collected.n : 1, sizeof(int));
    index = (size_t *)calloc(collected.n ? collected.n : 1, sizeof(size_t));
    if (!live || !index) {
        free(live);
        free(index);
        for (i = 0; i < collected.n; i++) {
            free(collected.items[i].key);
        }
        free(collected.items);
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    for (i = 0; i < collected.n; i++) {
        size_t found = folded;
        for (j = 0; j < folded; j++) {
            if (collected.items[index[j]].key_len == collected.items[i].key_len &&
                memcmp(collected.items[index[j]].key, collected.items[i].key, collected.items[i].key_len) == 0) {
                found = j;
                break;
            }
        }
        if (found == folded) {
            index[folded] = i;
            live[folded] = collected.items[i].loc.tombstone ? 0 : 1;
            folded++;
        } else {
            index[found] = i;
            live[found] = collected.items[i].loc.tombstone ? 0 : 1;
        }
    }
    for (i = 0; i < folded; i++) {
        if (live[i]) {
            nlive++;
        }
    }
    napi_create_array_with_length(env, (uint32_t)nlive, &out);
    nlive = 0;
    for (i = 0; i < folded; i++) {
        napi_value row;
        napi_value keyv;
        if (!live[i]) {
            continue;
        }
        napi_create_object(env, &row);
        napi_create_string_utf8(env, collected.items[index[i]].key, collected.items[index[i]].key_len, &keyv);
        napi_set_named_property(env, row, "key", keyv);
        napi_set_named_property(env, row, "locator", loc_to_js(env, &collected.items[index[i]].loc));
        napi_set_element(env, out, (uint32_t)nlive, row);
        nlive++;
    }
    for (i = 0; i < collected.n; i++) {
        free(collected.items[i].key);
    }
    free(collected.items);
    free(live);
    free(index);
    return out;
}

static napi_value Audit(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    js_store *st = unwrap(env, info, &argc, NULL);
    if (!st) {
        return NULL;
    }
    s3dfs_audit_report report;
    napi_value out;
    int rc = s3dfs_audit(st->store, &report);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    napi_create_object(env, &out);
    set_num(env, out, "records", (double)report.records);
    set_num(env, out, "bad", (double)report.bad);
    set_num(env, out, "bytes", (double)report.bytes);
    return out;
}

static napi_value Flush(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    js_store *st = unwrap(env, info, &argc, NULL);
    if (!st) {
        return NULL;
    }
    int rc = s3dfs_flush(st->store);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    return undefined(env);
}

static napi_value Sync(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    js_store *st = unwrap(env, info, &argc, NULL);
    if (!st) {
        return NULL;
    }
    int rc = s3dfs_sync(st->store);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    return undefined(env);
}

static napi_value Stats(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    js_store *st = unwrap(env, info, &argc, NULL);
    if (!st) {
        return NULL;
    }
    s3dfs_stats s;
    napi_value o;
    memset(&s, 0, sizeof(s));
    s3dfs_get_stats(st->store, &s);
    napi_create_object(env, &o);
    set_num(env, o, "objects", (double)s.objects);
    set_num(env, o, "deleted", (double)s.deleted);
    set_num(env, o, "bytesLogical", (double)s.bytes_logical);
    set_num(env, o, "bytesOnDisk", (double)s.bytes_on_disk);
    set_num(env, o, "blockFiles", (double)s.block_files);
    set_num(env, o, "puts", (double)s.puts);
    set_num(env, o, "gets", (double)s.gets);
    set_num(env, o, "deletes", (double)s.deletes);
    set_num(env, o, "flushes", (double)s.flushes);
    set_num(env, o, "fsyncs", (double)s.fsyncs);
    set_num(env, o, "indexSlots", (double)s.index_slots);
    set_num(env, o, "deadBytes", (double)s.dead_bytes);
    set_num(env, o, "tickets", (double)s.tickets);
    set_num(env, o, "unflushedBytes", (double)s.unflushed_bytes);
    set_num(env, o, "putWaitUs", (double)s.put_wait_us);
    set_num(env, o, "putHoldUs", (double)s.put_hold_us);
    set_num(env, o, "putWaitMaxUs", (double)s.put_wait_max_us);
    set_num(env, o, "putHoldMaxUs", (double)s.put_hold_max_us);
    set_num(env, o, "flushWaitUs", (double)s.flush_wait_us);
    set_num(env, o, "flushHoldUs", (double)s.flush_hold_us);
    set_num(env, o, "flushHoldMaxUs", (double)s.flush_hold_max_us);
    set_num(env, o, "syncWaitUs", (double)s.sync_wait_us);
    set_num(env, o, "syncHoldUs", (double)s.sync_hold_us);
    set_num(env, o, "syncHoldMaxUs", (double)s.sync_hold_max_us);
    set_num(env, o, "fsyncUs", (double)s.fsync_us);
    set_num(env, o, "fsyncMaxUs", (double)s.fsync_max_us);
    if (st->http) {
        s3dfs_http_stats hs;
        s3dfs_http_get_stats(st->http, &hs);
        set_num(env, o, "httpAccepted", (double)hs.accepted);
        set_num(env, o, "httpPuts", (double)hs.puts);
        set_num(env, o, "httpGets", (double)hs.gets);
        set_num(env, o, "httpOthers", (double)hs.others);
        set_num(env, o, "httpPutUs", (double)hs.put_us);
        set_num(env, o, "httpGetUs", (double)hs.get_us);
        set_num(env, o, "httpPutMaxUs", (double)hs.put_max_us);
        set_num(env, o, "httpGetMaxUs", (double)hs.get_max_us);
        set_num(env, o, "httpQueueWaitUs", (double)hs.queue_wait_us);
        set_num(env, o, "httpQueueWaitMaxUs", (double)hs.queue_wait_max_us);
        set_num(env, o, "httpReadyMax", (double)hs.ready_max);
        set_num(env, o, "httpIdleMax", (double)hs.idle_max);
        set_num(env, o, "httpReadyNow", (double)hs.ready_now);
        set_num(env, o, "httpIdleNow", (double)hs.idle_now);
    }
    return o;
}

static napi_value Compact(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    js_store *st = unwrap(env, info, &argc, NULL);
    if (!st) {
        return NULL;
    }
    int rc = s3dfs_compact(st->store);
    if (rc != S3DFS_OK) {
        return throw_rc(env, rc);
    }
    return Stats(env, info);
}

static void append_header(char **extra, const char *name, const char *value)
{
    size_t old = *extra ? strlen(*extra) : 0;
    size_t need = old + strlen(name) + strlen(value) + 5;
    char *next = (char *)realloc(*extra, need);
    if (!next) {
        return;
    }
    snprintf(next + old, need - old, "%s: %s\r\n", name, value);
    *extra = next;
}

static void http_fallback_js(napi_env env, napi_value fn, void *context, void *data)
{
    http_job *job = (http_job *)data;
    napi_value req;
    if (!job) {
        return;
    }
    napi_value headers;
    napi_value argv[1];
    napi_value global;
    napi_value result;
    napi_status call;
    uint32_t i;
    (void)context;
    job->rc = -1;
    if (!env || !fn || !job->method || !job->url) {
        finish_http_job(job);
        return;
    }
    napi_create_object(env, &req);
    set_str(env, req, "method", job->method, NAPI_AUTO_LENGTH);
    set_str(env, req, "url", job->url, NAPI_AUTO_LENGTH);
    napi_create_object(env, &headers);
    for (i = 0; i < (uint32_t)job->nheaders; i++) {
        set_str(env, headers, job->names[i], job->values[i], NAPI_AUTO_LENGTH);
    }
    napi_set_named_property(env, req, "headers", headers);
    {
        napi_value body;
        napi_create_buffer_copy(env, job->body_len, job->body ? job->body : (const uint8_t *)"", NULL, &body);
        napi_set_named_property(env, req, "body", body);
    }
    argv[0] = req;
    napi_get_global(env, &global);
    call = napi_call_function(env, global, fn, 1, argv, &result);
    if (call != napi_ok) {
        napi_value exception;
        napi_get_and_clear_last_exception(env, &exception);
        finish_http_job(job);
        return;
    }
    {
        napi_valuetype t;
        napi_typeof(env, result, &t);
        if (t != napi_object) {
            finish_http_job(job);
            return;
        }
    }
    {
        napi_value status;
        napi_valuetype st;
        if (named(env, result, "status", &st, &status) && st == napi_number) {
            int32_t code = 200;
            napi_get_value_int32(env, status, &code);
            job->reply->status = code;
        } else {
            job->reply->status = 200;
        }
    }
    {
        napi_value body;
        napi_valuetype bt;
        if (named(env, result, "body", &bt, &body)) {
            if (bt == napi_string) {
                job->reply->body = (uint8_t *)utf8_dup(env, body, NULL);
                job->reply->body_len = job->reply->body ? strlen((char *)job->reply->body) : 0;
            } else if (is_buffer(env, body)) {
                const uint8_t *data_ptr = NULL;
                uint32_t len = 0;
                if (buffer_info(env, body, &data_ptr, &len) == 0) {
                    job->reply->body = (uint8_t *)malloc(len ? len : 1);
                    if (job->reply->body && len && data_ptr) {
                        memcpy(job->reply->body, data_ptr, len);
                    }
                    job->reply->body_len = len;
                }
            }
        }
    }
    {
        napi_value headers_out;
        napi_valuetype ht;
        if (named(env, result, "headers", &ht, &headers_out) && ht == napi_object) {
            napi_value keys;
            uint32_t n = 0;
            uint32_t k;
            napi_get_property_names(env, headers_out, &keys);
            napi_get_array_length(env, keys, &n);
            for (k = 0; k < n; k++) {
                napi_value keyv;
                napi_value valv;
                char *key = NULL;
                char *val = NULL;
                napi_get_element(env, keys, k, &keyv);
                napi_get_property(env, headers_out, keyv, &valv);
                key = utf8_dup(env, keyv, NULL);
                val = utf8_dup(env, valv, NULL);
                if (key && val) {
                    if (strcasecmp(key, "content-type") == 0) {
                        free(job->reply->content_type);
                        job->reply->content_type = val;
                        val = NULL;
                    } else {
                        append_header(&job->reply->extra_headers, key, val);
                    }
                }
                free(key);
                free(val);
            }
        }
    }
    job->rc = 0;
    finish_http_job(job);
}

static int http_fallback_bridge(void *user, const char *method, const char *url, const char *const *names, const char *const *values,
                                int nheaders, const uint8_t *body, size_t body_len, s3dfs_http_reply *reply)
{
    js_store *st = (js_store *)user;
    http_job *job;
    napi_status status;
    int rc;
    if (!st || !st->http_fallback) {
        return -1;
    }
    job = (http_job *)calloc(1, sizeof(*job));
    if (!job) {
        return -1;
    }
    pthread_mutex_init(&job->mu, NULL);
    pthread_cond_init(&job->cv, NULL);
    job->method = method;
    job->url = url;
    job->names = names;
    job->values = values;
    job->nheaders = nheaders;
    job->body = body;
    job->body_len = body_len;
    job->reply = reply;
    job->rc = -1;
    status = napi_call_threadsafe_function(st->http_fallback, job, napi_tsfn_nonblocking);
    if (status != napi_ok) {
        pthread_mutex_destroy(&job->mu);
        pthread_cond_destroy(&job->cv);
        free(job);
        return -1;
    }
    pthread_mutex_lock(&job->mu);
    while (!job->done) {
        pthread_cond_wait(&job->cv, &job->mu);
    }
    rc = job->rc;
    pthread_mutex_unlock(&job->mu);
    pthread_mutex_destroy(&job->mu);
    pthread_cond_destroy(&job->cv);
    free(job);
    return rc;
}

static void stop_http(js_store *st)
{
    if (!st) {
        return;
    }
    if (st->http) {
        s3dfs_http_shutdown(st->http);
    }
    if (st->http_fallback) {
        napi_release_threadsafe_function(st->http_fallback, napi_tsfn_abort);
        st->http_fallback = NULL;
    }
    if (st->http) {
        s3dfs_http_join(st->http);
        st->http = NULL;
    }
}

static napi_value Serve(napi_env env, napi_callback_info info)
{
    size_t argc = 3;
    napi_value args[3];
    js_store *st = unwrap(env, info, &argc, args);
    napi_valuetype host_type;
    napi_valuetype port_type;
    napi_valuetype fn_type;
    char *host;
    int32_t port = 0;
    int bound = 0;
    napi_value name;
    napi_value out;
    if (!st) {
        return NULL;
    }
    if (argc < 3) {
        return throw_type(env, "serve(host, port, onRequest)");
    }
    napi_typeof(env, args[0], &host_type);
    napi_typeof(env, args[1], &port_type);
    napi_typeof(env, args[2], &fn_type);
    if (host_type != napi_string || port_type != napi_number || fn_type != napi_function) {
        return throw_type(env, "serve(host, port, onRequest)");
    }
    if (st->http) {
        napi_throw_error(env, NULL, "already listening");
        return NULL;
    }
    host = utf8_dup(env, args[0], NULL);
    napi_get_value_int32(env, args[1], &port);
    if (!host) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    napi_create_string_utf8(env, "s3dfs-http", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, args[2], NULL, name, 0, 1, NULL, NULL, NULL, http_fallback_js, &st->http_fallback) != napi_ok) {
        free(host);
        napi_throw_error(env, NULL, "failed to listen");
        return NULL;
    }
    if (s3dfs_http_listen(st->store, host, port, st->write_threads, http_fallback_bridge, st, &st->http, &bound) != 0) {
        napi_release_threadsafe_function(st->http_fallback, napi_tsfn_abort);
        st->http_fallback = NULL;
        free(host);
        napi_throw_error(env, NULL, "failed to listen");
        return NULL;
    }
    free(host);
    napi_create_int32(env, bound, &out);
    return out;
}

static void store_finalize(napi_env env, void *data, void *hint)
{
    js_store *st = (js_store *)data;
    writer_slot *slot;
    (void)env;
    (void)hint;
    stop_http(st);
    stop_writers(st);
    slot = st->writers;
    while (slot) {
        writer_slot *next = slot->next;
        s3dfs_write_abort(slot->writer);
        free(slot);
        slot = next;
    }
    if (st->store) {
        s3dfs_close(st->store);
    }
    pthread_mutex_destroy(&st->qmu);
    pthread_cond_destroy(&st->qcv);
    free(st);
}

static napi_value Close(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    napi_value args[1];
    napi_value jsthis;
    js_store *st;
    napi_get_cb_info(env, info, &argc, args, &jsthis, NULL);
    napi_unwrap(env, jsthis, (void **)&st);
    if (st) {
        stop_http(st);
        stop_writers(st);
        while (st->writers) {
            writer_slot *slot = st->writers;
            st->writers = slot->next;
            s3dfs_write_abort(slot->writer);
            free(slot);
        }
        if (st->store) {
            s3dfs_close(st->store);
            st->store = NULL;
        }
    }
    return undefined(env);
}

static napi_value StoreCtor(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2];
    napi_value jsthis;
    napi_valuetype t0;
    js_store *st;
    char *dir;
    s3dfs_options opt;
    napi_get_cb_info(env, info, &argc, args, &jsthis, NULL);
    if (argc < 1) {
        return throw_type(env, "dataDir required");
    }
    napi_typeof(env, args[0], &t0);
    if (t0 != napi_string) {
        return throw_type(env, "dataDir required");
    }
    st = (js_store *)calloc(1, sizeof(*st));
    if (!st) {
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    pthread_mutex_init(&st->qmu, NULL);
    pthread_cond_init(&st->qcv, NULL);
    st->write_threads = 32;
    st->next_writer = 1;
    dir = utf8_dup(env, args[0], NULL);
    if (!dir) {
        free(st);
        return throw_rc(env, S3DFS_ERR_NOMEM);
    }
    memset(&opt, 0, sizeof(opt));
    if (argc > 1) {
        napi_valuetype ot;
        napi_typeof(env, args[1], &ot);
        if (ot == napi_object) {
            napi_value prop;
            napi_valuetype pt;
            if (named(env, args[1], "blockSize", &pt, &prop) && pt == napi_number) {
                int64_t n = 0;
                napi_get_value_int64(env, prop, &n);
                opt.block_size = (uint64_t)n;
            }
            if (named(env, args[1], "bufferSize", &pt, &prop) && pt == napi_number) {
                uint32_t n = 0;
                napi_get_value_uint32(env, prop, &n);
                opt.buffer_size = n;
            }
            if (named(env, args[1], "fsyncOnFlush", &pt, &prop) && pt == napi_boolean) {
                bool b = false;
                napi_get_value_bool(env, prop, &b);
                opt.fsync_on_flush = b ? 1 : 0;
            }
            if (named(env, args[1], "writeBlocks", &pt, &prop) && pt == napi_number) {
                int32_t n = 0;
                napi_get_value_int32(env, prop, &n);
                if (n > 0 && n <= 16) {
                    opt.writers = n;
                }
            }
            if (named(env, args[1], "writeThreads", &pt, &prop) && pt == napi_number) {
                int32_t n = 0;
                napi_get_value_int32(env, prop, &n);
                if (n > 0 && n <= 32) {
                    st->write_threads = n;
                }
            }
        }
    }
    st->store = s3dfs_open(dir, &opt);
    free(dir);
    if (!st->store) {
        pthread_mutex_destroy(&st->qmu);
        pthread_cond_destroy(&st->qcv);
        free(st);
        napi_throw_error(env, NULL, "failed to open s3dfs store");
        return NULL;
    }
    napi_wrap(env, jsthis, st, store_finalize, NULL, NULL);
    return jsthis;
}

static napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor props[] = {
        {"put", NULL, Put, NULL, NULL, NULL, napi_default, NULL},
        {"putAsync", NULL, PutAsync, NULL, NULL, NULL, napi_default, NULL},
        {"putBatch", NULL, PutBatch, NULL, NULL, NULL, napi_default, NULL},
        {"get", NULL, Get, NULL, NULL, NULL, napi_default, NULL},
        {"getSpan", NULL, GetSpan, NULL, NULL, NULL, napi_default, NULL},
        {"putChunks", NULL, PutChunks, NULL, NULL, NULL, napi_default, NULL},
        {"writeBegin", NULL, WriteBegin, NULL, NULL, NULL, napi_default, NULL},
        {"write", NULL, Write, NULL, NULL, NULL, napi_default, NULL},
        {"writeFinish", NULL, WriteFinish, NULL, NULL, NULL, napi_default, NULL},
        {"writeAbort", NULL, WriteAbort, NULL, NULL, NULL, napi_default, NULL},
        {"head", NULL, Head, NULL, NULL, NULL, napi_default, NULL},
        {"tombstone", NULL, Tombstone, NULL, NULL, NULL, napi_default, NULL},
        {"scan", NULL, Scan, NULL, NULL, NULL, napi_default, NULL},
        {"audit", NULL, Audit, NULL, NULL, NULL, napi_default, NULL},
        {"flush", NULL, Flush, NULL, NULL, NULL, napi_default, NULL},
        {"sync", NULL, Sync, NULL, NULL, NULL, napi_default, NULL},
        {"compact", NULL, Compact, NULL, NULL, NULL, napi_default, NULL},
        {"stats", NULL, Stats, NULL, NULL, NULL, napi_default, NULL},
        {"serve", NULL, Serve, NULL, NULL, NULL, napi_default, NULL},
        {"close", NULL, Close, NULL, NULL, NULL, napi_default, NULL},
    };
    napi_value cls;
    napi_define_class(env, "Store", NAPI_AUTO_LENGTH, StoreCtor, NULL, sizeof(props) / sizeof(props[0]), props, &cls);
    napi_set_named_property(env, exports, "Store", cls);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
