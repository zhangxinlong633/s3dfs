#ifndef S3DFS_GATEWAY_S3_H
#define S3DFS_GATEWAY_S3_H

#include "cluster.h"
#include "http.h"

#ifdef __cplusplus
extern "C" {
#endif

int s3_handle(cluster_t *cluster, const http_in_t *in, http_out_t *out);

#ifdef __cplusplus
}
#endif

#endif
