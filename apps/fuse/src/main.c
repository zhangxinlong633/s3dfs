#include "fs.h"
#include "webdav.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef HAVE_LIBFUSE
int fuse_serve(object_fs *fs, const char *mountpoint);
int fuse_backend_available(void);
#endif

static void usage(void) {
    fprintf(stderr, "usage: s3dfs-fuse --endpoint http://127.0.0.1:9000 --bucket mybucket MOUNTPOINT\n");
    fprintf(stderr, "  --endpoint URL   s3dfs S3 API address (default http://127.0.0.1:9000)\n");
    fprintf(stderr, "  --bucket NAME    bucket to mount\n");
    fprintf(stderr, "  --listen ADDR    local WebDAV listen address when FUSE is unavailable (default 127.0.0.1:0)\n");
}

int main(int argc, char **argv) {
    const char *endpoint = "http://127.0.0.1:9000";
    const char *bucket = NULL;
    const char *listen = "127.0.0.1:0";
    const char *mountpoint = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--endpoint") == 0 && i + 1 < argc) {
            endpoint = argv[++i];
        } else if (strcmp(argv[i], "--bucket") == 0 && i + 1 < argc) {
            bucket = argv[++i];
        } else if (strcmp(argv[i], "--listen") == 0 && i + 1 < argc) {
            listen = argv[++i];
        } else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
            usage();
            return 2;
        } else if (argv[i][0] == '-') {
            fprintf(stderr, "s3dfs-fuse: unknown option %s\n", argv[i]);
            usage();
            return 2;
        } else if (!mountpoint) {
            mountpoint = argv[i];
        } else {
            usage();
            return 2;
        }
    }
    if (!bucket || !mountpoint) {
        usage();
        return 2;
    }
    struct stat st;
    if (stat(mountpoint, &st) != 0) {
        fprintf(stderr, "s3dfs-fuse: mountpoint: %s\n", mountpoint);
        return 1;
    }
    if (!S_ISDIR(st.st_mode)) {
        fprintf(stderr, "s3dfs-fuse: mountpoint is not a directory: %s\n", mountpoint);
        return 1;
    }
    s3_client *client = s3_client_new(endpoint, bucket);
    object_fs *fs = fs_new(client);
    int rc = 1;
#ifdef HAVE_LIBFUSE
    if (fuse_backend_available()) {
        rc = fuse_serve(fs, mountpoint);
        fs_free(fs);
        s3_client_free(client);
        return rc == 0 ? 0 : 1;
    }
#endif
    rc = webdav_serve(fs, mountpoint, listen);
    fs_free(fs);
    s3_client_free(client);
    return rc;
}
