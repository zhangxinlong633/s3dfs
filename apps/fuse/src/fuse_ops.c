#define FUSE_USE_VERSION 26

#include "fs.h"

#include <errno.h>
#include <fcntl.h>
#include <fuse.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static object_fs *fuse_fs(void) { return fuse_get_context()->private_data; }

static void fill_stat(struct stat *st, const fs_info *info) {
    memset(st, 0, sizeof(*st));
    if (info->is_dir) {
        st->st_mode = S_IFDIR | 0755;
        st->st_nlink = 2;
    } else {
        st->st_mode = S_IFREG | 0644;
        st->st_nlink = 1;
    }
    st->st_size = info->size;
    st->st_mtime = info->mtime ? info->mtime : time(NULL);
    st->st_atime = st->st_mtime;
    st->st_ctime = st->st_mtime;
    st->st_uid = getuid();
    st->st_gid = getgid();
}

static int fuse_getattr(const char *path, struct stat *st) {
    fs_info info;
    int rc = fs_stat(fuse_fs(), path, &info);
    if (rc != 0) {
        return -rc;
    }
    fill_stat(st, &info);
    return 0;
}

static int fuse_open(const char *path, struct fuse_file_info *fi) {
    fs_file *f = NULL;
    int rc = fs_open(fuse_fs(), path, fi->flags, &f);
    if (rc != 0) {
        return -rc;
    }
    fi->fh = (uint64_t)(uintptr_t)f;
    return 0;
}

static int fuse_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
    (void)mode;
    fs_file *f = NULL;
    int rc = fs_open(fuse_fs(), path, fi->flags | O_CREAT, &f);
    if (rc != 0) {
        return -rc;
    }
    fi->fh = (uint64_t)(uintptr_t)f;
    return 0;
}

static int fuse_read(const char *path, char *buf, size_t size, off_t off, struct fuse_file_info *fi) {
    (void)path;
    fs_file *f = (fs_file *)(uintptr_t)fi->fh;
    if (fs_seek(f, off, SEEK_SET, NULL) != 0) {
        return -EIO;
    }
    size_t got = 0;
    int rc = fs_read(f, buf, size, &got);
    if (rc != 0) {
        return -rc;
    }
    return (int)got;
}

static int fuse_write(const char *path, const char *buf, size_t size, off_t off, struct fuse_file_info *fi) {
    (void)path;
    fs_file *f = (fs_file *)(uintptr_t)fi->fh;
    if (fs_seek(f, off, SEEK_SET, NULL) != 0) {
        return -EIO;
    }
    size_t got = 0;
    int rc = fs_write(f, buf, size, &got);
    if (rc != 0) {
        return -rc;
    }
    return (int)got;
}

static int fuse_flush(const char *path, struct fuse_file_info *fi) {
    (void)path;
    fs_file *f = (fs_file *)(uintptr_t)fi->fh;
    int rc = fs_sync(f);
    return rc == 0 ? 0 : -rc;
}

static int fuse_release(const char *path, struct fuse_file_info *fi) {
    (void)path;
    fs_file *f = (fs_file *)(uintptr_t)fi->fh;
    int rc = fs_close(f);
    fi->fh = 0;
    return rc == 0 ? 0 : -rc;
}

static int fuse_readdir(const char *path, void *buf, fuse_fill_dir_t filler, off_t off, struct fuse_file_info *fi) {
    (void)fi;
    if (off > 0) {
        return 0;
    }
    filler(buf, ".", NULL, 0);
    filler(buf, "..", NULL, 0);
    fs_file *f = NULL;
    int rc = fs_open(fuse_fs(), path, O_RDONLY, &f);
    if (rc != 0) {
        return -rc;
    }
    fs_info *ents = NULL;
    size_t n = 0;
    rc = fs_readdir(f, &ents, &n);
    fs_close(f);
    if (rc != 0) {
        return -rc;
    }
    for (size_t i = 0; i < n; i++) {
        struct stat st;
        fill_stat(&st, &ents[i]);
        if (filler(buf, ents[i].name, &st, 0)) {
            break;
        }
    }
    free(ents);
    return 0;
}

static int fuse_mkdir(const char *path, mode_t mode) {
    (void)mode;
    int rc = fs_mkdir(fuse_fs(), path);
    return rc == 0 ? 0 : -rc;
}

static int fuse_unlink(const char *path) {
    int rc = fs_remove(fuse_fs(), path);
    return rc == 0 ? 0 : -rc;
}

static int fuse_rmdir(const char *path) {
    int rc = fs_remove(fuse_fs(), path);
    return rc == 0 ? 0 : -rc;
}

static int fuse_rename(const char *from, const char *to) {
    int rc = fs_rename(fuse_fs(), from, to);
    return rc == 0 ? 0 : -rc;
}

static int fuse_truncate(const char *path, off_t size) {
    int rc = fs_truncate_path(fuse_fs(), path, size);
    return rc == 0 ? 0 : -rc;
}

static int fuse_access(const char *path, int mask) {
    (void)mask;
    fs_info info;
    int rc = fs_stat(fuse_fs(), path, &info);
    return rc == 0 ? 0 : -rc;
}

static int fuse_chmod(const char *path, mode_t mode) {
    (void)mode;
    return fuse_access(path, 0);
}

static int fuse_chown(const char *path, uid_t uid, gid_t gid) {
    (void)uid;
    (void)gid;
    return fuse_access(path, 0);
}

static int fuse_utime(const char *path, struct utimbuf *buf) {
    (void)buf;
    return fuse_access(path, 0);
}

static void *fuse_init(struct fuse_conn_info *conn) {
    (void)conn;
    return fuse_get_context()->private_data;
}

static const struct fuse_operations fuse_ops = {
    .getattr = fuse_getattr,
    .open = fuse_open,
    .read = fuse_read,
    .write = fuse_write,
    .flush = fuse_flush,
    .release = fuse_release,
    .readdir = fuse_readdir,
    .mkdir = fuse_mkdir,
    .unlink = fuse_unlink,
    .rmdir = fuse_rmdir,
    .rename = fuse_rename,
    .truncate = fuse_truncate,
    .access = fuse_access,
    .create = fuse_create,
    .chmod = fuse_chmod,
    .chown = fuse_chown,
    .utime = fuse_utime,
    .init = fuse_init,
};

int fuse_backend_available(void) {
#ifdef __APPLE__
    struct stat st;
    if (stat("/Library/Filesystems/macfuse.fs", &st) == 0 && S_ISDIR(st.st_mode)) {
        return 1;
    }
    const char *libs[] = {"/usr/local/lib/libfuse.dylib", "/usr/local/lib/libfuse.2.dylib",
                          "/opt/homebrew/lib/libfuse.dylib", NULL};
    for (int i = 0; libs[i]; i++) {
        if (stat(libs[i], &st) == 0) {
            return 1;
        }
    }
    return 0;
#else
    return access("/dev/fuse", R_OK | W_OK) == 0;
#endif
}

int fuse_serve(object_fs *fs, const char *mountpoint) {
    char vol[256], fsname[256];
    snprintf(vol, sizeof(vol), "volname=%s", fs_client(fs)->bucket);
    snprintf(fsname, sizeof(fsname), "fsname=s3dfs:%s", fs_client(fs)->bucket);
#ifdef __APPLE__
    char *argv[] = {"s3dfs-fuse", "-f", "-o", "backend=fskit", "-o", "local", "-o", vol, "-o", fsname,
                    (char *)mountpoint, NULL};
#else
    char *argv[] = {"s3dfs-fuse", "-f", "-o", "local", "-o", vol, "-o", fsname, (char *)mountpoint, NULL};
#endif
    int argc = (int)(sizeof(argv) / sizeof(argv[0])) - 1;
    fprintf(stderr, "s3dfs-fuse: mounted %s at %s via FUSE (press Ctrl-C to unmount)\n", fs_client(fs)->bucket,
            mountpoint);
    return fuse_main(argc, argv, &fuse_ops, fs);
}
