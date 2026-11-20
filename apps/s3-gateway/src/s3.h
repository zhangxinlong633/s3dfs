#ifndef S3DFS_GATEWAY_S3_H
#define S3DFS_GATEWAY_S3_H

#include "cluster.h"
#include "http.h"

#ifdef __cplusplus
extern "C" {
#endif

int s3_handle(cluster_t *cluster, const http_in_t *in, http_out_t *out);

/* Empty keys leave the gateway open. Both must be set before requests are signed. */
void s3_set_credentials(const char *access_key, const char *secret_key);
int s3_sigv4_sign(const http_in_t *in, const char *secret, const char *amz_date, const char *scope, char out_hex[65]);
int s3_sigv4_verify(const http_in_t *in, int64_t now_ms, int *status, const char **code, const char **message);

#ifdef __cplusplus
}
#endif

#endif
