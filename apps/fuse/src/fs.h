#ifndef S3DFS_FUSE_FS_H
#define S3DFS_FUSE_FS_H

#include "s3client.h"

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#include <time.h>

typedef struct object_fs object_fs;
typedef struct fs_file fs_file;

typedef struct fs_info {
    char name[1024];
    int64_t size;
    time_t mtime;
    int is_dir;
    mode_t mode;
} fs_info;

object_fs *fs_new(s3_client *client);
void fs_free(object_fs *fs);
s3_client *fs_client(object_fs *fs);

int fs_mkdir(object_fs *fs, const char *name);
int fs_remove(object_fs *fs, const char *name);
int fs_rename(object_fs *fs, const char *old_name, const char *new_name);
int fs_stat(object_fs *fs, const char *name, fs_info *out);
int fs_truncate_path(object_fs *fs, const char *name, int64_t size);

int fs_open(object_fs *fs, const char *name, int flags, fs_file **out);
int fs_read(fs_file *f, void *buf, size_t n, size_t *got);
int fs_write(fs_file *f, const void *buf, size_t n, size_t *got);
int fs_seek(fs_file *f, int64_t off, int whence, int64_t *pos);
int fs_truncate_file(fs_file *f, int64_t size);
int fs_sync(fs_file *f);
int fs_close(fs_file *f);
int fs_fstat(fs_file *f, fs_info *out);
int fs_readdir(fs_file *f, fs_info **ents, size_t *count);

#endif
