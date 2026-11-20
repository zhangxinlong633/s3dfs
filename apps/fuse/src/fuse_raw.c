/* Linux /dev/fuse session, protocol 7.19. Used when libfuse is not installed.
 * Struct layout follows the libfuse 2.9 fuse_kernel.h interface, which that
 * header allows to be redistributed under the BSD licence. */

#include "fs.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <stdint.h>

#define FUSE_KERNEL_VERSION 7
#define FUSE_KERNEL_MINOR_VERSION 19
#define FUSE_ROOT_ID 1
#define FUSE_BIG_WRITES (1 << 5)

enum {
    FUSE_LOOKUP = 1,
    FUSE_FORGET = 2,
    FUSE_GETATTR = 3,
    FUSE_SETATTR = 4,
    FUSE_MKDIR = 9,
    FUSE_UNLINK = 10,
    FUSE_RMDIR = 11,
    FUSE_RENAME = 12,
    FUSE_OPEN = 14,
    FUSE_READ = 15,
    FUSE_WRITE = 16,
    FUSE_STATFS = 17,
    FUSE_RELEASE = 18,
    FUSE_FLUSH = 25,
    FUSE_INIT = 26,
    FUSE_OPENDIR = 27,
    FUSE_READDIR = 28,
    FUSE_RELEASEDIR = 29,
    FUSE_ACCESS = 34,
    FUSE_CREATE = 35,
    FUSE_DESTROY = 38,
    FUSE_BATCH_FORGET = 42
};

#define FATTR_SIZE (1 << 3)

struct fuse_attr {
    uint64_t ino, size, blocks, atime, mtime, ctime;
    uint32_t atimensec, mtimensec, ctimensec, mode, nlink, uid, gid, rdev, blksize, padding;
};
struct fuse_entry_out {
    uint64_t nodeid, generation, entry_valid, attr_valid;
    uint32_t entry_valid_nsec, attr_valid_nsec;
    struct fuse_attr attr;
};
struct fuse_attr_out {
    uint64_t attr_valid;
    uint32_t attr_valid_nsec, dummy;
    struct fuse_attr attr;
};
struct fuse_init_in {
    uint32_t major, minor, max_readahead, flags;
};
struct fuse_init_out {
    uint32_t major, minor, max_readahead, flags;
    uint16_t max_background, congestion_threshold;
    uint32_t max_write;
};
struct fuse_in_header {
    uint32_t len, opcode;
    uint64_t unique, nodeid;
    uint32_t uid, gid, pid, padding;
};
struct fuse_out_header {
    uint32_t len;
    int32_t error;
    uint64_t unique;
};
struct fuse_forget_in {
    uint64_t nlookup;
};
struct fuse_mkdir_in {
    uint32_t mode, umask;
};
struct fuse_rename_in {
    uint64_t newdir;
};
struct fuse_setattr_in {
    uint32_t valid, padding;
    uint64_t fh, size, lock_owner, atime, mtime, unused2;
    uint32_t atimensec, mtimensec, unused3, mode, unused4, uid, gid, unused5;
};
struct fuse_open_in {
    uint32_t flags, unused;
};
struct fuse_create_in {
    uint32_t flags, mode, umask, padding;
};
struct fuse_open_out {
    uint64_t fh;
    uint32_t open_flags, padding;
};
struct fuse_read_in {
    uint64_t fh, offset;
    uint32_t size, read_flags;
    uint64_t lock_owner;
    uint32_t flags, padding;
};
struct fuse_write_in {
    uint64_t fh, offset;
    uint32_t size, write_flags;
    uint64_t lock_owner;
    uint32_t flags, padding;
};
struct fuse_write_out {
    uint32_t size, padding;
};
struct fuse_release_in {
    uint64_t fh;
    uint32_t flags, release_flags;
    uint64_t lock_owner;
};
struct fuse_flush_in {
    uint64_t fh;
    uint32_t unused, padding;
    uint64_t lock_owner;
};
struct fuse_kstatfs {
    uint64_t blocks, bfree, bavail, files, ffree;
    uint32_t bsize, namelen, frsize, padding, spare[6];
};
struct fuse_dirent {
    uint64_t ino, off;
    uint32_t namelen, type;
    char name[];
};

#define FUSE_NAME_OFFSET offsetof(struct fuse_dirent, name)
#define FUSE_DIRENT_ALIGN(x) (((x) + 7) & ~7u)

typedef struct raw_node {
    uint64_t id;
    int ref;
    char *path;
} raw_node;

typedef struct raw_fh {
    uint64_t fh;
    fs_file *file;
} raw_fh;

static raw_node *nodes;
static size_t node_count;
static uint64_t next_id = 2;
static raw_fh *fhs;
static size_t fh_count;
static uint64_t next_fh = 1;

static raw_node *node_by_id(uint64_t id) {
    for (size_t i = 0; i < node_count; i++) {
        if (nodes[i].id == id) {
            return &nodes[i];
        }
    }
    return NULL;
}

static raw_node *node_intern(const char *path) {
    for (size_t i = 0; i < node_count; i++) {
        if (nodes[i].id && strcmp(nodes[i].path, path) == 0) {
            nodes[i].ref++;
            return &nodes[i];
        }
    }
    nodes = realloc(nodes, (node_count + 1) * sizeof(*nodes));
    raw_node *n = &nodes[node_count++];
    memset(n, 0, sizeof(*n));
    n->id = path[0] == '\0' ? FUSE_ROOT_ID : next_id++;
    n->ref = 1;
    n->path = strdup(path);
    return n;
}

static void fill_attr(struct fuse_attr *a, uint64_t ino, const fs_info *info) {
    memset(a, 0, sizeof(*a));
    a->ino = ino;
    a->size = (uint64_t)(info->size < 0 ? 0 : info->size);
    a->blocks = (a->size + 511) / 512;
    a->mtime = a->atime = a->ctime = (uint64_t)(info->mtime ? info->mtime : time(NULL));
    a->mode = info->is_dir ? (S_IFDIR | 0755) : (S_IFREG | 0644);
    a->nlink = info->is_dir ? 2 : 1;
    a->uid = getuid();
    a->gid = getgid();
    a->blksize = 4096;
}

static int reply(int dev, uint64_t unique, int err, const void *data, size_t n) {
    struct fuse_out_header h;
    h.len = (uint32_t)(sizeof(h) + (err ? 0 : n));
    h.error = err ? -err : 0;
    h.unique = unique;
    if (write(dev, &h, sizeof(h)) != (ssize_t)sizeof(h)) {
        return -1;
    }
    if (!err && n && write(dev, data, n) != (ssize_t)n) {
        return -1;
    }
    return 0;
}

static int entry_reply(int dev, uint64_t unique, object_fs *fs, const char *path) {
    fs_info info;
    int rc = fs_stat(fs, path[0] ? path : "/", &info);
    if (rc != 0) {
        return reply(dev, unique, rc, NULL, 0);
    }
    raw_node *n = node_intern(path);
    struct fuse_entry_out out;
    memset(&out, 0, sizeof(out));
    out.nodeid = n->id;
    out.generation = 1;
    out.entry_valid = 1;
    out.attr_valid = 1;
    fill_attr(&out.attr, n->id, &info);
    return reply(dev, unique, 0, &out, sizeof(out));
}

static const char *arg_str(const uint8_t *p, size_t n, size_t off) {
    if (off >= n) {
        return "";
    }
    return (const char *)p + off;
}

int fuse_raw_serve(object_fs *fs, const char *mountpoint) {
    int dev = open("/dev/fuse", O_RDWR);
    if (dev < 0) {
        fprintf(stderr, "s3dfs-fuse: open /dev/fuse: %s\n", strerror(errno));
        return 1;
    }
    struct stat st;
    if (stat(mountpoint, &st) != 0) {
        close(dev);
        return 1;
    }
    char opts[256];
    snprintf(opts, sizeof(opts), "fd=%d,rootmode=%o,user_id=%d,group_id=%d", dev, st.st_mode, getuid(), getgid());
    if (mount("s3dfs", mountpoint, "fuse", MS_NOSUID | MS_NODEV, opts) != 0) {
        fprintf(stderr, "s3dfs-fuse: mount: %s\n", strerror(errno));
        close(dev);
        return 1;
    }
    node_intern("");
    fprintf(stderr, "s3dfs-fuse: mounted %s at %s via /dev/fuse (press Ctrl-C to unmount)\n", fs_client(fs)->bucket,
            mountpoint);
    uint8_t buf[256 * 1024];
    for (;;) {
        ssize_t n = read(dev, buf, sizeof(buf));
        if (n < 0) {
            if (errno == EINTR) {
                break;
            }
            break;
        }
        if (n < (ssize_t)sizeof(struct fuse_in_header)) {
            break;
        }
        struct fuse_in_header *in = (struct fuse_in_header *)buf;
        uint8_t *arg = buf + sizeof(*in);
        size_t argn = (size_t)n - sizeof(*in);
        raw_node *self = node_by_id(in->nodeid);
        const char *self_path = self ? self->path : "";
        switch (in->opcode) {
        case FUSE_INIT: {
            struct fuse_init_in *ini = (struct fuse_init_in *)arg;
            struct fuse_init_out out;
            memset(&out, 0, sizeof(out));
            out.major = FUSE_KERNEL_VERSION;
            out.minor = ini->minor < FUSE_KERNEL_MINOR_VERSION ? ini->minor : FUSE_KERNEL_MINOR_VERSION;
            out.max_readahead = ini->max_readahead;
            out.flags = FUSE_BIG_WRITES;
            out.max_background = 16;
            out.congestion_threshold = 12;
            out.max_write = 65536;
            reply(dev, in->unique, 0, &out, sizeof(out));
            break;
        }
        case FUSE_DESTROY:
            reply(dev, in->unique, 0, NULL, 0);
            goto done;
        case FUSE_FORGET:
            if (self && self->id != FUSE_ROOT_ID) {
                struct fuse_forget_in *f = (struct fuse_forget_in *)arg;
                self->ref -= (int)f->nlookup;
            }
            break;
        case FUSE_LOOKUP: {
            char path[4096];
            const char *name = arg_str(arg, argn, 0);
            if (strcmp(name, ".") == 0) {
                snprintf(path, sizeof(path), "%s", self_path);
            } else if (strcmp(name, "..") == 0) {
                snprintf(path, sizeof(path), "%s", self_path);
                char *slash = strrchr(path, '/');
                if (slash) {
                    *slash = '\0';
                } else {
                    path[0] = '\0';
                }
            } else if (self_path[0] == '\0') {
                snprintf(path, sizeof(path), "%s", name);
            } else {
                snprintf(path, sizeof(path), "%s/%s", self_path, name);
            }
            entry_reply(dev, in->unique, fs, path);
            break;
        }
        case FUSE_GETATTR: {
            fs_info info;
            int rc = fs_stat(fs, self_path[0] ? self_path : "/", &info);
            if (rc != 0) {
                reply(dev, in->unique, rc, NULL, 0);
                break;
            }
            struct fuse_attr_out out;
            memset(&out, 0, sizeof(out));
            out.attr_valid = 1;
            fill_attr(&out.attr, in->nodeid, &info);
            reply(dev, in->unique, 0, &out, sizeof(out));
            break;
        }
        case FUSE_SETATTR: {
            struct fuse_setattr_in *sa = (struct fuse_setattr_in *)arg;
            if (sa->valid & FATTR_SIZE) {
                int rc = fs_truncate_path(fs, self_path, (int64_t)sa->size);
                if (rc != 0) {
                    reply(dev, in->unique, rc, NULL, 0);
                    break;
                }
            }
            fs_info info;
            int rc = fs_stat(fs, self_path[0] ? self_path : "/", &info);
            if (rc != 0) {
                reply(dev, in->unique, rc, NULL, 0);
                break;
            }
            struct fuse_attr_out out;
            memset(&out, 0, sizeof(out));
            out.attr_valid = 1;
            fill_attr(&out.attr, in->nodeid, &info);
            reply(dev, in->unique, 0, &out, sizeof(out));
            break;
        }
        case FUSE_MKDIR: {
            const char *name = arg_str(arg, argn, sizeof(struct fuse_mkdir_in));
            char path[4096];
            snprintf(path, sizeof(path), "%s%s%s", self_path, self_path[0] ? "/" : "", name);
            int rc = fs_mkdir(fs, path);
            if (rc != 0) {
                reply(dev, in->unique, rc, NULL, 0);
            } else {
                entry_reply(dev, in->unique, fs, path);
            }
            break;
        }
        case FUSE_UNLINK:
        case FUSE_RMDIR: {
            const char *name = arg_str(arg, argn, 0);
            char path[4096];
            snprintf(path, sizeof(path), "%s%s%s", self_path, self_path[0] ? "/" : "", name);
            int rc = fs_remove(fs, path);
            reply(dev, in->unique, rc, NULL, 0);
            break;
        }
        case FUSE_RENAME: {
            struct fuse_rename_in *rn = (struct fuse_rename_in *)arg;
            const char *oldn = arg_str(arg, argn, sizeof(*rn));
            const char *newn = oldn + strlen(oldn) + 1;
            raw_node *dest = node_by_id(rn->newdir);
            char from[4096], to[4096];
            snprintf(from, sizeof(from), "%s%s%s", self_path, self_path[0] ? "/" : "", oldn);
            const char *dp = dest ? dest->path : "";
            snprintf(to, sizeof(to), "%s%s%s", dp, dp[0] ? "/" : "", newn);
            int rc = fs_rename(fs, from, to);
            reply(dev, in->unique, rc, NULL, 0);
            break;
        }
        case FUSE_OPEN:
        case FUSE_OPENDIR:
        case FUSE_CREATE: {
            int flags = 0;
            const char *name = self_path;
            char path[4096];
            if (in->opcode == FUSE_CREATE) {
                struct fuse_create_in *cr = (struct fuse_create_in *)arg;
                flags = (int)cr->flags | O_CREAT;
                const char *cn = arg_str(arg, argn, sizeof(*cr));
                snprintf(path, sizeof(path), "%s%s%s", self_path, self_path[0] ? "/" : "", cn);
                name = path;
            } else {
                flags = (int)((struct fuse_open_in *)arg)->flags;
                snprintf(path, sizeof(path), "%s", self_path[0] ? self_path : "/");
                name = path;
            }
            fs_file *file = NULL;
            int rc = fs_open(fs, name, flags, &file);
            if (rc != 0) {
                reply(dev, in->unique, rc, NULL, 0);
                break;
            }
            fhs = realloc(fhs, (fh_count + 1) * sizeof(*fhs));
            fhs[fh_count].fh = next_fh++;
            fhs[fh_count].file = file;
            struct fuse_open_out oo;
            memset(&oo, 0, sizeof(oo));
            oo.fh = fhs[fh_count].fh;
            fh_count++;
            if (in->opcode == FUSE_CREATE) {
                uint8_t both[sizeof(struct fuse_entry_out) + sizeof(oo)];
                fs_info info;
                fs_stat(fs, name, &info);
                raw_node *nn = node_intern(name[0] == '/' ? name + 1 : name);
                struct fuse_entry_out eo;
                memset(&eo, 0, sizeof(eo));
                eo.nodeid = nn->id;
                eo.generation = 1;
                eo.entry_valid = 1;
                eo.attr_valid = 1;
                fill_attr(&eo.attr, nn->id, &info);
                memcpy(both, &eo, sizeof(eo));
                memcpy(both + sizeof(eo), &oo, sizeof(oo));
                reply(dev, in->unique, 0, both, sizeof(both));
            } else {
                reply(dev, in->unique, 0, &oo, sizeof(oo));
            }
            break;
        }
        case FUSE_READ:
        case FUSE_READDIR: {
            struct fuse_read_in *rd = (struct fuse_read_in *)arg;
            fs_file *file = NULL;
            for (size_t i = 0; i < fh_count; i++) {
                if (fhs[i].fh == rd->fh) {
                    file = fhs[i].file;
                }
            }
            if (!file) {
                reply(dev, in->unique, EBADF, NULL, 0);
                break;
            }
            if (in->opcode == FUSE_READ) {
                uint8_t *data = malloc(rd->size ? rd->size : 1);
                fs_seek(file, (int64_t)rd->offset, SEEK_SET, NULL);
                size_t got = 0;
                int rc = fs_read(file, data, rd->size, &got);
                if (rc != 0) {
                    free(data);
                    reply(dev, in->unique, rc, NULL, 0);
                } else {
                    reply(dev, in->unique, 0, data, got);
                    free(data);
                }
            } else {
                fs_info *ents = NULL;
                size_t count = 0;
                int rc = fs_readdir(file, &ents, &count);
                if (rc != 0) {
                    reply(dev, in->unique, rc, NULL, 0);
                    break;
                }
                uint8_t *out = calloc(1, rd->size ? rd->size : 1);
                size_t used = 0;
                for (size_t i = 0; i < count; i++) {
                    uint64_t off = i + 1;
                    if (off <= rd->offset) {
                        continue;
                    }
                    uint32_t namelen = (uint32_t)strlen(ents[i].name);
                    size_t need = FUSE_DIRENT_ALIGN(FUSE_NAME_OFFSET + namelen);
                    if (used + need > rd->size) {
                        break;
                    }
                    struct fuse_dirent *de = (struct fuse_dirent *)(out + used);
                    de->ino = 1;
                    de->off = off;
                    de->namelen = namelen;
                    de->type = ents[i].is_dir ? 4 : 8;
                    memcpy(de->name, ents[i].name, namelen);
                    used += need;
                }
                free(ents);
                reply(dev, in->unique, 0, out, used);
                free(out);
            }
            break;
        }
        case FUSE_WRITE: {
            struct fuse_write_in *wr = (struct fuse_write_in *)arg;
            fs_file *file = NULL;
            for (size_t i = 0; i < fh_count; i++) {
                if (fhs[i].fh == wr->fh) {
                    file = fhs[i].file;
                }
            }
            if (!file) {
                reply(dev, in->unique, EBADF, NULL, 0);
                break;
            }
            const uint8_t *data = arg + sizeof(*wr);
            fs_seek(file, (int64_t)wr->offset, SEEK_SET, NULL);
            size_t got = 0;
            int rc = fs_write(file, data, wr->size, &got);
            if (rc != 0) {
                reply(dev, in->unique, rc, NULL, 0);
            } else {
                struct fuse_write_out wo = {(uint32_t)got, 0};
                reply(dev, in->unique, 0, &wo, sizeof(wo));
            }
            break;
        }
        case FUSE_FLUSH: {
            struct fuse_flush_in *fl = (struct fuse_flush_in *)arg;
            int rc = 0;
            for (size_t i = 0; i < fh_count; i++) {
                if (fhs[i].fh == fl->fh && fhs[i].file) {
                    rc = fs_sync(fhs[i].file);
                }
            }
            reply(dev, in->unique, rc, NULL, 0);
            break;
        }
        case FUSE_RELEASE:
        case FUSE_RELEASEDIR: {
            struct fuse_release_in *rel = (struct fuse_release_in *)arg;
            int rc = 0;
            for (size_t i = 0; i < fh_count; i++) {
                if (fhs[i].fh == rel->fh && fhs[i].file) {
                    rc = fs_close(fhs[i].file);
                    fhs[i].file = NULL;
                }
            }
            reply(dev, in->unique, rc, NULL, 0);
            break;
        }
        case FUSE_ACCESS:
            reply(dev, in->unique, self ? 0 : ENOENT, NULL, 0);
            break;
        case FUSE_STATFS: {
            struct fuse_kstatfs stfs;
            memset(&stfs, 0, sizeof(stfs));
            stfs.bsize = 4096;
            stfs.frsize = 4096;
            stfs.namelen = 255;
            stfs.blocks = stfs.bfree = stfs.bavail = 1 << 20;
            reply(dev, in->unique, 0, &stfs, sizeof(stfs));
            break;
        }
        case FUSE_BATCH_FORGET:
            break;
        default:
            reply(dev, in->unique, ENOSYS, NULL, 0);
            break;
        }
    }
done:
    umount(mountpoint);
    close(dev);
    return 0;
}
