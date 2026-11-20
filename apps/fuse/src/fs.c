#include "fs.h"

#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

struct object_fs {
    s3_client *client;
    pthread_mutex_t mu;
    fs_file **open;
    size_t open_count;
};

struct fs_file {
    object_fs *fs;
    char *key;
    int dir;
    int dirty;
    int fd;
    char *tmp_path;
    pthread_mutex_t mu;
    fs_info info;
    int has_info;
    fs_info *dirents;
    size_t dir_count;
    size_t dir_off;
    int dir_loaded;
};

static void set_name(fs_info *info, const char *key, int dir) {
    const char *base = key;
    const char *slash = strrchr(key, '/');
    if (slash && slash[1]) {
        base = slash + 1;
    }
    if (dir && slash && slash[1] == '\0' && slash != key) {
        /* key "a/" -> name a */
        size_t n = (size_t)(slash - key);
        char tmp[1024];
        if (n >= sizeof(tmp)) {
            n = sizeof(tmp) - 1;
        }
        memcpy(tmp, key, n);
        tmp[n] = '\0';
        const char *b = strrchr(tmp, '/');
        snprintf(info->name, sizeof(info->name), "%s", b ? b + 1 : tmp);
        return;
    }
    snprintf(info->name, sizeof(info->name), "%s", base && base[0] ? base : key);
}

object_fs *fs_new(s3_client *client) {
    object_fs *fs = xmalloc(sizeof(*fs));
    fs->client = client;
    pthread_mutex_init(&fs->mu, NULL);
    return fs;
}

void fs_free(object_fs *fs) {
    if (!fs) {
        return;
    }
    pthread_mutex_destroy(&fs->mu);
    free(fs->open);
    free(fs);
}

s3_client *fs_client(object_fs *fs) { return fs->client; }

static fs_file *open_lookup(object_fs *fs, const char *key) {
    pthread_mutex_lock(&fs->mu);
    fs_file *found = NULL;
    for (size_t i = 0; i < fs->open_count; i++) {
        if (fs->open[i] && strcmp(fs->open[i]->key, key) == 0) {
            found = fs->open[i];
        }
    }
    pthread_mutex_unlock(&fs->mu);
    return found;
}

static void open_add(object_fs *fs, fs_file *f) {
    pthread_mutex_lock(&fs->mu);
    for (size_t i = 0; i < fs->open_count; i++) {
        if (fs->open[i] && strcmp(fs->open[i]->key, f->key) == 0) {
            fs->open[i] = f;
            pthread_mutex_unlock(&fs->mu);
            return;
        }
    }
    fs->open = xrealloc(fs->open, (fs->open_count + 1) * sizeof(fs_file *));
    fs->open[fs->open_count++] = f;
    pthread_mutex_unlock(&fs->mu);
}

static void open_del(object_fs *fs, fs_file *f) {
    pthread_mutex_lock(&fs->mu);
    for (size_t i = 0; i < fs->open_count; i++) {
        if (fs->open[i] == f) {
            fs->open[i] = NULL;
        }
    }
    pthread_mutex_unlock(&fs->mu);
}

static int s3err(char *err) {
    if (err[0]) {
        fprintf(stderr, "s3dfs-fuse: %s\n", err);
    }
    return EIO;
}

static int stat_key(object_fs *fs, const char *key, fs_info *out) {
    char lookup[4096];
    snprintf(lookup, sizeof(lookup), "%s", key);
    size_t ln = strlen(lookup);
    while (ln > 0 && lookup[ln - 1] == '/') {
        lookup[--ln] = '\0';
    }
    fs_file *opened = open_lookup(fs, lookup);
    if (opened && !opened->dir) {
        return fs_fstat(opened, out);
    }
    if (key[0] == '\0') {
        memset(out, 0, sizeof(*out));
        snprintf(out->name, sizeof(out->name), "%s", fs->client->bucket);
        out->is_dir = 1;
        out->mode = 0755;
        out->mtime = time(NULL);
        return 0;
    }
    char err[256] = {0};
    if (key[strlen(key) - 1] != '/') {
        s3_meta head;
        if (s3_head(fs->client, lookup, &head, err, sizeof(err)) != 0) {
            return s3err(err);
        }
        if (head.found) {
            memset(out, 0, sizeof(*out));
            set_name(out, lookup, 0);
            out->size = head.size;
            out->mode = 0644;
            out->mtime = head.mtime ? head.mtime : time(NULL);
            out->is_dir = 0;
            return 0;
        }
    }
    char prefix[4096];
    snprintf(prefix, sizeof(prefix), "%s/", lookup);
    s3_meta head;
    err[0] = '\0';
    if (s3_head(fs->client, prefix, &head, err, sizeof(err)) != 0) {
        return s3err(err);
    }
    if (head.found) {
        memset(out, 0, sizeof(*out));
        set_name(out, prefix, 1);
        out->is_dir = 1;
        out->mode = 0755;
        out->mtime = head.mtime ? head.mtime : time(NULL);
        return 0;
    }
    s3_listing listed;
    err[0] = '\0';
    if (s3_list(fs->client, prefix, "/", "", 1, &listed, err, sizeof(err)) != 0) {
        return s3err(err);
    }
    int exists = listed.object_count > 0 || listed.prefix_count > 0;
    s3_list_free(&listed);
    if (!exists) {
        return ENOENT;
    }
    memset(out, 0, sizeof(*out));
    set_name(out, prefix, 1);
    out->is_dir = 1;
    out->mode = 0755;
    out->mtime = time(NULL);
    return 0;
}

int fs_stat(object_fs *fs, const char *name, fs_info *out) {
    char key[4096];
    object_key(name, key, sizeof(key));
    return stat_key(fs, key, out);
}

int fs_mkdir(object_fs *fs, const char *name) {
    char key[4096];
    object_key(name, key, sizeof(key));
    if (key[0] == '\0') {
        return EEXIST;
    }
    fs_info st;
    int rc = stat_key(fs, key, &st);
    if (rc == 0) {
        return EEXIST;
    }
    if (rc != ENOENT) {
        return rc;
    }
    char marker[4096];
    snprintf(marker, sizeof(marker), "%s/", key);
    char err[256] = {0};
    if (s3_put(fs->client, marker, "", 0, err, sizeof(err)) != 0) {
        return s3err(err);
    }
    return 0;
}

int fs_remove(object_fs *fs, const char *name) {
    char key[4096];
    object_key(name, key, sizeof(key));
    if (key[0] == '\0') {
        return EINVAL;
    }
    fs_info st;
    int rc = stat_key(fs, key, &st);
    if (rc != 0) {
        return rc;
    }
    char err[256] = {0};
    if (!st.is_dir) {
        if (s3_delete(fs->client, key, err, sizeof(err)) != 0) {
            return s3err(err);
        }
        return 0;
    }
    char prefix[4096];
    snprintf(prefix, sizeof(prefix), "%s/", key);
    s3_listing listed;
    if (s3_list(fs->client, prefix, "/", "", 16, &listed, err, sizeof(err)) != 0) {
        return s3err(err);
    }
    size_t children = listed.prefix_count;
    for (size_t i = 0; i < listed.object_count; i++) {
        if (strcmp(listed.objects[i].key, prefix) != 0) {
            children++;
        }
    }
    int truncated = listed.truncated;
    s3_list_free(&listed);
    if (children > 0 || truncated) {
        return ENOTEMPTY;
    }
    err[0] = '\0';
    if (s3_delete(fs->client, prefix, err, sizeof(err)) != 0) {
        return s3err(err);
    }
    return 0;
}

int fs_rename(object_fs *fs, const char *old_name, const char *new_name) {
    char src[4096], dst[4096];
    object_key(old_name, src, sizeof(src));
    object_key(new_name, dst, sizeof(dst));
    if (src[0] == '\0' || dst[0] == '\0') {
        return EINVAL;
    }
    fs_info st;
    int rc = stat_key(fs, src, &st);
    if (rc != 0) {
        return rc;
    }
    if (st.is_dir) {
        return ENOTSUP;
    }
    char err[256] = {0};
    uint8_t *body = NULL;
    size_t len = 0;
    if (s3_get(fs->client, src, NULL, &body, &len, NULL, err, sizeof(err)) != 0) {
        return s3err(err);
    }
    if (!body && len == 0) {
        /* missing */
        s3_meta head;
        err[0] = '\0';
        if (s3_head(fs->client, src, &head, err, sizeof(err)) != 0) {
            return s3err(err);
        }
        if (!head.found) {
            return ENOENT;
        }
    }
    err[0] = '\0';
    rc = s3_put(fs->client, dst, body ? body : (const uint8_t *)"", len, err, sizeof(err));
    free(body);
    if (rc != 0) {
        return s3err(err);
    }
    err[0] = '\0';
    if (s3_delete(fs->client, src, err, sizeof(err)) != 0) {
        return s3err(err);
    }
    return 0;
}

static fs_file *file_new(object_fs *fs, const char *key, int dir) {
    fs_file *f = xmalloc(sizeof(*f));
    f->fs = fs;
    f->key = xstrdup(key);
    f->dir = dir;
    f->fd = -1;
    pthread_mutex_init(&f->mu, NULL);
    return f;
}

static void discard_tmp(fs_file *f) {
    if (f->fd >= 0) {
        close(f->fd);
        f->fd = -1;
    }
    if (f->tmp_path) {
        unlink(f->tmp_path);
        free(f->tmp_path);
        f->tmp_path = NULL;
    }
}

int fs_open(object_fs *fs, const char *name, int flags, fs_file **out) {
    char key[4096];
    object_key(name, key, sizeof(key));
    if (key[0] == '\0' || (name && name[0] && name[strlen(name) - 1] == '/')) {
        if ((flags & (O_WRONLY | O_RDWR)) && !(flags & O_CREAT)) {
            return EINVAL;
        }
        if (key[0] == '\0') {
            fs_info st;
            int rc = stat_key(fs, "", &st);
            if (rc != 0) {
                return rc;
            }
            fs_file *f = file_new(fs, "", 1);
            f->info = st;
            f->has_info = 1;
            *out = f;
            return 0;
        }
        fs_info st;
        int rc = stat_key(fs, key, &st);
        if (rc == 0 && st.is_dir) {
            char dkey[4096];
            snprintf(dkey, sizeof(dkey), "%s/", key);
            fs_file *f = file_new(fs, dkey, 1);
            f->info = st;
            f->has_info = 1;
            *out = f;
            return 0;
        }
        return rc == 0 ? ENOTDIR : rc;
    }

    fs_info st;
    int rc = stat_key(fs, key, &st);
    int exists = rc == 0;
    if (rc != 0 && rc != ENOENT) {
        return rc;
    }
    if (exists && st.is_dir) {
        if (flags & (O_WRONLY | O_RDWR)) {
            return EINVAL;
        }
        char dkey[4096];
        snprintf(dkey, sizeof(dkey), "%s/", key);
        fs_file *f = file_new(fs, dkey, 1);
        f->info = st;
        f->has_info = 1;
        *out = f;
        return 0;
    }
    if (!exists && !(flags & O_CREAT)) {
        return ENOENT;
    }

    fs_file *f = file_new(fs, key, 0);
    char tmpl[] = "/tmp/s3dfs-fuse-XXXXXX";
    int fd = mkstemp(tmpl);
    if (fd < 0) {
        free(f->key);
        free(f);
        return errno ? errno : EIO;
    }
    f->fd = fd;
    f->tmp_path = xstrdup(tmpl);
    if (exists && !(flags & O_TRUNC)) {
        char err[256] = {0};
        uint8_t *body = NULL;
        size_t len = 0;
        s3_meta head;
        if (s3_get(fs->client, key, NULL, &body, &len, &head, err, sizeof(err)) != 0) {
            discard_tmp(f);
            free(f->key);
            free(f);
            return s3err(err);
        }
        if (body && len) {
            size_t off = 0;
            while (off < len) {
                ssize_t w = write(fd, body + off, len - off);
                if (w < 0) {
                    if (errno == EINTR) {
                        continue;
                    }
                    free(body);
                    discard_tmp(f);
                    free(f->key);
                    free(f);
                    return errno;
                }
                off += (size_t)w;
            }
            if (!(flags & O_APPEND)) {
                lseek(fd, 0, SEEK_SET);
            }
            memset(&f->info, 0, sizeof(f->info));
            set_name(&f->info, key, 0);
            f->info.size = (int64_t)len;
            f->info.mode = 0644;
            f->info.mtime = head.mtime;
            f->has_info = 1;
        }
        free(body);
    }
    if ((!exists && (flags & O_CREAT)) || (flags & O_TRUNC)) {
        f->dirty = 1;
    }
    open_add(fs, f);
    *out = f;
    return 0;
}

int fs_read(fs_file *f, void *buf, size_t n, size_t *got) {
    if (f->dir) {
        return ENOTDIR;
    }
    pthread_mutex_lock(&f->mu);
    ssize_t r = read(f->fd, buf, n);
    int err = r < 0 ? errno : 0;
    if (r < 0) {
        *got = 0;
    } else {
        *got = (size_t)r;
    }
    pthread_mutex_unlock(&f->mu);
    return err;
}

int fs_write(fs_file *f, const void *buf, size_t n, size_t *got) {
    if (f->dir) {
        return ENOTDIR;
    }
    pthread_mutex_lock(&f->mu);
    const char *p = buf;
    size_t off = 0;
    int err = 0;
    while (off < n) {
        ssize_t w = write(f->fd, p + off, n - off);
        if (w < 0) {
            if (errno == EINTR) {
                continue;
            }
            err = errno;
            break;
        }
        off += (size_t)w;
    }
    if (off > 0) {
        f->dirty = 1;
    }
    *got = off;
    pthread_mutex_unlock(&f->mu);
    return err;
}

int fs_seek(fs_file *f, int64_t off, int whence, int64_t *pos) {
    if (f->dir) {
        return ENOTDIR;
    }
    pthread_mutex_lock(&f->mu);
    off_t n = lseek(f->fd, (off_t)off, whence);
    int err = n < 0 ? errno : 0;
    if (pos) {
        *pos = n < 0 ? 0 : (int64_t)n;
    }
    pthread_mutex_unlock(&f->mu);
    return err;
}

int fs_truncate_file(fs_file *f, int64_t size) {
    if (f->dir) {
        return ENOTDIR;
    }
    pthread_mutex_lock(&f->mu);
    int rc = ftruncate(f->fd, (off_t)size);
    int err = rc < 0 ? errno : 0;
    if (rc == 0) {
        f->dirty = 1;
    }
    pthread_mutex_unlock(&f->mu);
    return err;
}

int fs_sync(fs_file *f) {
    pthread_mutex_lock(&f->mu);
    int err = 0;
    if (f->fd >= 0 && f->dirty && !f->dir) {
        char ebuf[256] = {0};
        if (s3_put_file(f->fs->client, f->key, f->fd, ebuf, sizeof(ebuf)) != 0) {
            err = s3err(ebuf);
        } else {
            f->dirty = 0;
            lseek(f->fd, 0, SEEK_SET);
        }
    }
    pthread_mutex_unlock(&f->mu);
    return err;
}

int fs_close(fs_file *f) {
    if (!f) {
        return 0;
    }
    int err = fs_sync(f);
    pthread_mutex_lock(&f->mu);
    discard_tmp(f);
    free(f->dirents);
    f->dirents = NULL;
    pthread_mutex_unlock(&f->mu);
    if (!f->dir) {
        open_del(f->fs, f);
    }
    pthread_mutex_destroy(&f->mu);
    free(f->key);
    free(f);
    return err;
}

int fs_fstat(fs_file *f, fs_info *out) {
    if (f->dir) {
        if (f->has_info) {
            *out = f->info;
            return 0;
        }
        return stat_key(f->fs, f->key, out);
    }
    pthread_mutex_lock(&f->mu);
    if (f->fd >= 0) {
        struct stat st;
        if (fstat(f->fd, &st) != 0) {
            int err = errno;
            pthread_mutex_unlock(&f->mu);
            return err;
        }
        memset(out, 0, sizeof(*out));
        set_name(out, f->key, 0);
        out->size = st.st_size;
        out->mode = 0644;
        out->mtime = st.st_mtime;
        pthread_mutex_unlock(&f->mu);
        return 0;
    }
    if (f->has_info) {
        *out = f->info;
        pthread_mutex_unlock(&f->mu);
        return 0;
    }
    pthread_mutex_unlock(&f->mu);
    memset(out, 0, sizeof(*out));
    set_name(out, f->key, 0);
    out->mode = 0644;
    out->mtime = time(NULL);
    return 0;
}

static int load_dir(fs_file *f) {
    char prefix[4096];
    snprintf(prefix, sizeof(prefix), "%s", f->key);
    if (prefix[0] && prefix[strlen(prefix) - 1] != '/') {
        snprintf(prefix, sizeof(prefix), "%s/", f->key);
    }
    char start[4096] = {0};
    for (;;) {
        char err[256] = {0};
        s3_listing listed;
        if (s3_list(f->fs->client, prefix, "/", start, 1000, &listed, err, sizeof(err)) != 0) {
            return s3err(err);
        }
        for (size_t i = 0; i < listed.prefix_count; i++) {
            const char *pfx = listed.prefixes[i];
            const char *rel = pfx;
            if (strncmp(rel, prefix, strlen(prefix)) == 0) {
                rel += strlen(prefix);
            }
            size_t n = strlen(rel);
            if (n > 0 && rel[n - 1] == '/') {
                n--;
            }
            if (n == 0) {
                continue;
            }
            f->dirents = xrealloc(f->dirents, (f->dir_count + 1) * sizeof(fs_info));
            fs_info *info = &f->dirents[f->dir_count++];
            memset(info, 0, sizeof(*info));
            if (n >= sizeof(info->name)) {
                n = sizeof(info->name) - 1;
            }
            memcpy(info->name, rel, n);
            info->name[n] = '\0';
            info->is_dir = 1;
            info->mode = 0755;
            info->mtime = time(NULL);
        }
        for (size_t i = 0; i < listed.object_count; i++) {
            const char *rel = listed.objects[i].key;
            if (strncmp(rel, prefix, strlen(prefix)) == 0) {
                rel += strlen(prefix);
            }
            if (rel[0] == '\0') {
                continue;
            }
            f->dirents = xrealloc(f->dirents, (f->dir_count + 1) * sizeof(fs_info));
            fs_info *info = &f->dirents[f->dir_count++];
            memset(info, 0, sizeof(*info));
            snprintf(info->name, sizeof(info->name), "%s", rel);
            info->size = listed.objects[i].size;
            info->mode = 0644;
            info->mtime = listed.objects[i].mtime;
        }
        int more = listed.truncated && listed.next_token && listed.next_token[0];
        if (more) {
            snprintf(start, sizeof(start), "%s", listed.next_token);
        }
        s3_list_free(&listed);
        if (!more) {
            break;
        }
    }
    f->dir_loaded = 1;
    f->dir_off = 0;
    return 0;
}

int fs_readdir(fs_file *f, fs_info **ents, size_t *count) {
    if (!f->dir) {
        return ENOTDIR;
    }
    pthread_mutex_lock(&f->mu);
    if (!f->dir_loaded) {
        int rc = load_dir(f);
        if (rc != 0) {
            pthread_mutex_unlock(&f->mu);
            return rc;
        }
    }
    if (f->dir_off >= f->dir_count) {
        *ents = NULL;
        *count = 0;
        pthread_mutex_unlock(&f->mu);
        return 0;
    }
    size_t n = f->dir_count - f->dir_off;
    fs_info *copy = xmalloc(n * sizeof(fs_info));
    memcpy(copy, f->dirents + f->dir_off, n * sizeof(fs_info));
    f->dir_off = f->dir_count;
    *ents = copy;
    *count = n;
    pthread_mutex_unlock(&f->mu);
    return 0;
}

int fs_truncate_path(object_fs *fs, const char *name, int64_t size) {
    int flags = O_RDWR;
    if (size == 0) {
        flags = O_WRONLY | O_CREAT | O_TRUNC;
    }
    fs_file *f = NULL;
    int rc = fs_open(fs, name, flags, &f);
    if (rc != 0) {
        return rc;
    }
    if (size != 0) {
        rc = fs_truncate_file(f, size);
    }
    int cerr = fs_close(f);
    return rc != 0 ? rc : cerr;
}
