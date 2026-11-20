#ifndef S3DFS_FUSE_WEBDAV_H
#define S3DFS_FUSE_WEBDAV_H

#include "fs.h"

int webdav_serve(object_fs *fs, const char *mountpoint, const char *listen);

#endif
