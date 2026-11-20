#include "s3.h"

#include <ctype.h>
#include <pthread.h>

static pthread_mutex_t upload_mu = PTHREAD_MUTEX_INITIALIZER;

typedef struct {
    int used;
    int number;
    uint32_t crc;
    void *body;
    size_t len;
} part_slot_t;

typedef struct {
    int used;
    char id[40];
    char bucket[256];
    char key[1024];
    part_slot_t parts[32];
} upload_slot_t;

static upload_slot_t g_uploads[64];

static int decode_aws_chunked(const char *body, size_t len, const char *expect_len, buf_t *out)
{
    size_t off = 0;
    while (off < len) {
        const char *nl = memchr(body + off, '\n', len - off);
        if (!nl) {
            return S3DFS_ERR_ARGS;
        }
        size_t line_end = (size_t)(nl - body);
        if (line_end > off && body[line_end - 1] == '\r') {
            line_end--;
        }
        char hex[32];
        size_t hex_n = 0;
        for (size_t i = off; i < line_end && body[i] != ';' && hex_n + 1 < sizeof(hex); i++) {
            hex[hex_n++] = body[i];
        }
        hex[hex_n] = '\0';
        char *end = NULL;
        unsigned long size = strtoul(hex, &end, 16);
        if (end == hex) {
            return S3DFS_ERR_ARGS;
        }
        off = (size_t)(nl - body) + 1;
        if (size == 0) {
            break;
        }
        if (off + size + 2 > len) {
            return S3DFS_ERR_ARGS;
        }
        if (buf_append(out, body + off, size) != S3DFS_OK) {
            return S3DFS_ERR_NOMEM;
        }
        off += size + 2;
    }
    if (expect_len && expect_len[0]) {
        unsigned long want = strtoul(expect_len, NULL, 10);
        if (want != out->len) {
            return S3DFS_ERR_ARGS;
        }
    }
    return S3DFS_OK;
}

static void etag_from_crc(uint32_t crc, char *out, size_t cap)
{
    snprintf(out, cap, "\"%08x\"", crc);
}

static int query_get(const char *query, const char *name, char *out, size_t cap)
{
    if (!query || !query[0]) {
        if (cap) {
            out[0] = '\0';
        }
        return S3DFS_ERR_NOT_FOUND;
    }
    size_t nlen = strlen(name);
    const char *p = query;
    while (*p) {
        const char *amp = strchr(p, '&');
        size_t n = amp ? (size_t)(amp - p) : strlen(p);
        const char *eq = memchr(p, '=', n);
        size_t kn = eq ? (size_t)(eq - p) : n;
        if (kn == nlen && !strncmp(p, name, nlen)) {
            buf_t dec = {0};
            if (eq) {
                url_decode(eq + 1, n - kn - 1, &dec);
            }
            snprintf(out, cap, "%s", dec.data ? dec.data : "");
            buf_free(&dec);
            return S3DFS_OK;
        }
        p = amp ? amp + 1 : p + n;
    }
    if (cap) {
        out[0] = '\0';
    }
    return S3DFS_ERR_NOT_FOUND;
}

static void parse_path(const char *url_path, char *bucket, size_t bcap, char *key, size_t kcap, int *has_key)
{
    bucket[0] = '\0';
    key[0] = '\0';
    *has_key = 0;
    int trailing = (url_path[0] && url_path[strlen(url_path) - 1] == '/' && strcmp(url_path, "/") != 0);
    char tmp[4096];
    snprintf(tmp, sizeof(tmp), "%s", url_path);
    char *parts[64];
    int n = 0;
    char *save = NULL;
    /* split on / and skip empties */
    for (char *p = tmp; *p && n < 64;) {
        while (*p == '/') {
            p++;
        }
        if (!*p) {
            break;
        }
        parts[n++] = p;
        while (*p && *p != '/') {
            p++;
        }
        if (*p == '/') {
            *p++ = '\0';
        }
    }
    (void)save;
    if (n == 0) {
        return;
    }
    if (strcmp(parts[0], "_s3dfs") == 0) {
        return;
    }
    snprintf(bucket, bcap, "%s", parts[0]);
    if (n == 1) {
        return;
    }
    buf_t k = {0};
    for (int i = 1; i < n; i++) {
        if (i > 1) {
            buf_append_str(&k, "/");
        }
        buf_append_str(&k, parts[i]);
    }
    if (trailing) {
        buf_append_str(&k, "/");
    }
    snprintf(key, kcap, "%s", k.data ? k.data : "");
    *has_key = 1;
    buf_free(&k);
}

static int reply_xml(http_out_t *out, int status, const buf_t *xml)
{
    return http_reply(out, status, "Content-Type: application/xml\r\n", xml->data, xml->len);
}

static int error_xml(http_out_t *out, int status, const char *code, const char *message, const char *resource)
{
    buf_t b = {0};
    buf_append_str(&b, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error>\n  <Code>");
    xml_escape(code, &b);
    buf_append_str(&b, "</Code>\n  <Message>");
    xml_escape(message, &b);
    buf_append_str(&b, "</Message>\n  ");
    if (resource && resource[0]) {
        buf_append_str(&b, "<Resource>");
        xml_escape(resource, &b);
        buf_append_str(&b, "</Resource>");
    }
    buf_append_str(&b, "\n  <RequestId>s3dfs</RequestId>\n</Error>\n");
    int rc = reply_xml(out, status, &b);
    buf_free(&b);
    return rc;
}

static int service_error(http_out_t *out, int rc, const char *what)
{
    if (rc == S3DFS_ERR_UNAVAILABLE || rc == S3DFS_ERR_IO) {
        return error_xml(out, 503, "ServiceUnavailable", what ? what : "backend unavailable", NULL);
    }
    return error_xml(out, 500, "InternalError", what ? what : "internal error", NULL);
}

static int list_buckets_xml(cluster_t *c, http_out_t *out)
{
    bucket_info_t *buckets = NULL;
    size_t n = 0;
    int rc = cluster_list_buckets(c, &buckets, &n);
    if (rc != S3DFS_OK) {
        return service_error(out, rc, "index unavailable");
    }
    buf_t b = {0};
    buf_append_str(&b,
                   "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                   "<ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\n"
                   "  <Owner><ID>s3dfs</ID><DisplayName>s3dfs</DisplayName></Owner>\n"
                   "  <Buckets>");
    for (size_t i = 0; i < n; i++) {
        char date[64];
        format_iso8601(buckets[i].mtime_ms, date, sizeof(date));
        buf_append_str(&b, "<Bucket><Name>");
        xml_escape(buckets[i].name, &b);
        buf_printf(&b, "</Name><CreationDate>%s</CreationDate></Bucket>", date);
    }
    buf_append_str(&b, "</Buckets>\n</ListAllMyBucketsResult>\n");
    free(buckets);
    rc = reply_xml(out, 200, &b);
    buf_free(&b);
    return rc;
}

static int list_objects_xml(http_out_t *out, const char *bucket, const char *prefix, int max_keys,
                            const char *delimiter, const list_result_t *listed)
{
    buf_t b = {0};
    buf_append_str(&b, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                       "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\n  <Name>");
    xml_escape(bucket, &b);
    buf_append_str(&b, "</Name>\n  <Prefix>");
    xml_escape(prefix ? prefix : "", &b);
    buf_append_str(&b, "</Prefix>\n  ");
    if (delimiter && delimiter[0]) {
        buf_append_str(&b, "<Delimiter>");
        xml_escape(delimiter, &b);
        buf_append_str(&b, "</Delimiter>");
    }
    buf_printf(&b, "\n  <MaxKeys>%d</MaxKeys>\n  <KeyCount>%zu</KeyCount>\n  <IsTruncated>%s</IsTruncated>\n  ", max_keys,
               listed->object_count + listed->prefix_count, listed->truncated ? "true" : "false");
    for (size_t i = 0; i < listed->object_count; i++) {
        char etag[20], date[64];
        etag_from_crc(listed->objects[i].crc, etag, sizeof(etag));
        /* etag_from_crc includes quotes; XML uses quoted etag inside element like "abcd" */
        format_iso8601(listed->objects[i].mtime_ms, date, sizeof(date));
        buf_append_str(&b, "<Contents>\n    <Key>");
        xml_escape(listed->objects[i].key, &b);
        buf_printf(&b, "</Key>\n    <LastModified>%s</LastModified>\n    <ETag>%s</ETag>\n    <Size>%" PRIu64
                       "</Size>\n    <StorageClass>STANDARD</StorageClass>\n  </Contents>",
                   date, etag, listed->objects[i].size);
    }
    for (size_t i = 0; i < listed->prefix_count; i++) {
        buf_append_str(&b, "<CommonPrefixes><Prefix>");
        xml_escape(listed->prefixes[i], &b);
        buf_append_str(&b, "</Prefix></CommonPrefixes>");
    }
    if (listed->truncated && listed->next_token[0]) {
        buf_append_str(&b, "\n  <NextContinuationToken>");
        xml_escape(listed->next_token, &b);
        buf_append_str(&b, "</NextContinuationToken>");
    }
    buf_append_str(&b, "\n</ListBucketResult>\n");
    int rc = reply_xml(out, 200, &b);
    buf_free(&b);
    return rc;
}

static int handle_bucket(cluster_t *c, const char *method, const char *bucket, const char *query, http_out_t *out)
{
    if (strcmp(method, "PUT") == 0) {
        int rc = cluster_create_bucket(c, bucket);
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "failed to create bucket");
        }
        return http_reply(out, 200, NULL, NULL, 0);
    }
    if (strcmp(method, "DELETE") == 0) {
        int rc = cluster_delete_bucket(c, bucket);
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return error_xml(out, 404, "NoSuchBucket", "The specified bucket does not exist", bucket);
        }
        if (rc == S3DFS_ERR_CONFLICT) {
            return error_xml(out, 409, "BucketNotEmpty", "The bucket you tried to delete is not empty", bucket);
        }
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "failed to delete bucket");
        }
        return http_reply(out, 204, NULL, NULL, 0);
    }
    if (strcmp(method, "GET") == 0 || strcmp(method, "HEAD") == 0) {
        int ex = cluster_bucket_exists(c, bucket);
        if (ex == S3DFS_ERR_NOT_FOUND) {
            return error_xml(out, 404, "NoSuchBucket", "The specified bucket does not exist", bucket);
        }
        if (ex != S3DFS_OK) {
            return service_error(out, ex, "index unavailable");
        }
        if (strcmp(method, "HEAD") == 0) {
            return http_reply(out, 200, NULL, NULL, 0);
        }
        char prefix[1024] = "", start_after[1024] = "", delimiter[64] = "", maxs[32] = "";
        query_get(query, "prefix", prefix, sizeof(prefix));
        if (query_get(query, "start-after", start_after, sizeof(start_after)) != S3DFS_OK) {
            query_get(query, "continuation-token", start_after, sizeof(start_after));
        }
        query_get(query, "delimiter", delimiter, sizeof(delimiter));
        query_get(query, "max-keys", maxs, sizeof(maxs));
        int max_keys = maxs[0] ? atoi(maxs) : 1000;
        list_result_t listed = {0};
        int rc = cluster_list(c, bucket, prefix, start_after[0] ? start_after : NULL, max_keys, delimiter, &listed);
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "list failed");
        }
        rc = list_objects_xml(out, bucket, prefix, max_keys, delimiter, &listed);
        list_result_free(&listed);
        return rc;
    }
    return error_xml(out, 405, "MethodNotAllowed", "Method not allowed", bucket);
}

static int handle_object(cluster_t *c, const http_in_t *in, const char *bucket, const char *key, http_out_t *out)
{
    const char *method = in->method;
    char upload_q[80] = "", uploads_flag[8] = "";
    int has_upload = query_get(in->query, "uploadId", upload_q, sizeof(upload_q)) == S3DFS_OK && upload_q[0];
    int has_uploads = query_get(in->query, "uploads", uploads_flag, sizeof(uploads_flag)) == S3DFS_OK;
    if (strcmp(method, "POST") == 0 && has_uploads && !has_upload) {
        int rc = cluster_create_bucket(c, bucket);
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "failed to create bucket");
        }
        pthread_mutex_lock(&upload_mu);
        upload_slot_t *slot = NULL;
        for (int i = 0; i < 64; i++) {
            if (!g_uploads[i].used) {
                slot = &g_uploads[i];
                memset(slot, 0, sizeof(*slot));
                slot->used = 1;
                snprintf(slot->id, sizeof(slot->id), "%08x%08x", (unsigned)now_ms(), (unsigned)i);
                snprintf(slot->bucket, sizeof(slot->bucket), "%s", bucket);
                snprintf(slot->key, sizeof(slot->key), "%s", key);
                break;
            }
        }
        char id[40] = "";
        if (slot) {
            snprintf(id, sizeof(id), "%s", slot->id);
        }
        pthread_mutex_unlock(&upload_mu);
        if (!id[0]) {
            return error_xml(out, 503, "ServiceUnavailable", "too many multipart uploads", NULL);
        }
        buf_t b = {0};
        buf_append_str(&b, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><InitiateMultipartUploadResult><Bucket>");
        xml_escape(bucket, &b);
        buf_append_str(&b, "</Bucket><Key>");
        xml_escape(key, &b);
        buf_append_str(&b, "</Key><UploadId>");
        xml_escape(id, &b);
        buf_append_str(&b, "</UploadId></InitiateMultipartUploadResult>");
        rc = reply_xml(out, 200, &b);
        buf_free(&b);
        return rc;
    }
    if (has_upload && strcmp(method, "DELETE") == 0) {
        pthread_mutex_lock(&upload_mu);
        int found = 0;
        for (int i = 0; i < 64; i++) {
            if (g_uploads[i].used && strcmp(g_uploads[i].id, upload_q) == 0) {
                for (int p = 0; p < 32; p++) {
                    free(g_uploads[i].parts[p].body);
                }
                memset(&g_uploads[i], 0, sizeof(g_uploads[i]));
                found = 1;
                break;
            }
        }
        pthread_mutex_unlock(&upload_mu);
        if (!found) {
            return error_xml(out, 404, "NoSuchUpload", "The specified multipart upload does not exist", NULL);
        }
        return http_reply(out, 204, NULL, NULL, 0);
    }
    if (has_upload && strcmp(method, "GET") == 0) {
        buf_t b = {0};
        pthread_mutex_lock(&upload_mu);
        upload_slot_t *slot = NULL;
        for (int i = 0; i < 64; i++) {
            if (g_uploads[i].used && strcmp(g_uploads[i].id, upload_q) == 0) {
                slot = &g_uploads[i];
                break;
            }
        }
        if (!slot) {
            pthread_mutex_unlock(&upload_mu);
            return error_xml(out, 404, "NoSuchUpload", "The specified multipart upload does not exist", NULL);
        }
        buf_append_str(&b, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListPartsResult><UploadId>");
        xml_escape(slot->id, &b);
        buf_append_str(&b, "</UploadId>");
        for (int p = 0; p < 32; p++) {
            if (!slot->parts[p].used) {
                continue;
            }
            char etag[24];
            etag_from_crc(slot->parts[p].crc, etag, sizeof(etag));
            buf_printf(&b, "<Part><PartNumber>%d</PartNumber><ETag>%s</ETag><Size>%zu</Size></Part>",
                       slot->parts[p].number, etag, slot->parts[p].len);
        }
        pthread_mutex_unlock(&upload_mu);
        buf_append_str(&b, "</ListPartsResult>");
        int rc = reply_xml(out, 200, &b);
        buf_free(&b);
        return rc;
    }
    if (has_upload && strcmp(method, "POST") == 0) {
        pthread_mutex_lock(&upload_mu);
        upload_slot_t *slot = NULL;
        for (int i = 0; i < 64; i++) {
            if (g_uploads[i].used && strcmp(g_uploads[i].id, upload_q) == 0) {
                slot = &g_uploads[i];
                break;
            }
        }
        if (!slot) {
            pthread_mutex_unlock(&upload_mu);
            return error_xml(out, 404, "NoSuchUpload", "The specified multipart upload does not exist", NULL);
        }
        size_t total = 0;
        for (int p = 0; p < 32; p++) {
            if (slot->parts[p].used) {
                total += slot->parts[p].len;
            }
        }
        char *joined = (char *)malloc(total ? total : 1);
        if (!joined) {
            pthread_mutex_unlock(&upload_mu);
            return error_xml(out, 500, "InternalError", "out of memory", NULL);
        }
        size_t used = 0;
        for (int number = 1; number <= 10000 && used < total; number++) {
            for (int p = 0; p < 32; p++) {
                if (slot->parts[p].used && slot->parts[p].number == number && slot->parts[p].body) {
                    memcpy(joined + used, slot->parts[p].body, slot->parts[p].len);
                    used += slot->parts[p].len;
                }
            }
        }
        for (int p = 0; p < 32; p++) {
            free(slot->parts[p].body);
        }
        memset(slot, 0, sizeof(*slot));
        pthread_mutex_unlock(&upload_mu);
        uint32_t crc = 0;
        int rc = cluster_put(c, bucket, key, joined, used, &crc);
        free(joined);
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "failed to complete upload");
        }
        char etag[24];
        etag_from_crc(crc, etag, sizeof(etag));
        buf_t b = {0};
        buf_printf(&b, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><CompleteMultipartUploadResult><ETag>%s</ETag></CompleteMultipartUploadResult>", etag);
        char extra[64];
        snprintf(extra, sizeof(extra), "ETag: %s\r\n", etag);
        rc = http_reply(out, 200, extra, b.data, b.len);
        buf_free(&b);
        return rc;
    }
    if (strcmp(method, "PUT") == 0) {
        int rc = cluster_create_bucket(c, bucket);
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "failed to create bucket");
        }
        char encoding[128] = "", sha[160] = "", decoded[32] = "", upload_id[80] = "", part_no[16] = "";
        http_in_header(in, "content-encoding", encoding, sizeof(encoding));
        http_in_header(in, "x-amz-content-sha256", sha, sizeof(sha));
        http_in_header(in, "x-amz-decoded-content-length", decoded, sizeof(decoded));
        int chunked = (strstr(encoding, "aws-chunked") != NULL) || (strncmp(sha, "STREAMING-", 10) == 0);
        const void *payload = in->body ? in->body : "";
        size_t payload_len = in->body ? in->body_len : 0;
        buf_t decoded_body = {0};
        if (chunked) {
            if (decode_aws_chunked(payload, payload_len, decoded, &decoded_body) != S3DFS_OK) {
                buf_free(&decoded_body);
                return error_xml(out, 400, "InvalidRequest", "aws-chunked body is invalid", NULL);
            }
            payload = decoded_body.data ? decoded_body.data : "";
            payload_len = decoded_body.len;
        }
        query_get(in->query, "uploadId", upload_id, sizeof(upload_id));
        query_get(in->query, "partNumber", part_no, sizeof(part_no));
        if (upload_id[0] && part_no[0]) {
            int number = atoi(part_no);
            uint32_t crc = crc32_ieee(payload, payload_len);
            pthread_mutex_lock(&upload_mu);
            upload_slot_t *slot = NULL;
            for (int i = 0; i < 64; i++) {
                if (g_uploads[i].used && strcmp(g_uploads[i].id, upload_id) == 0 &&
                    strcmp(g_uploads[i].bucket, bucket) == 0 && strcmp(g_uploads[i].key, key) == 0) {
                    slot = &g_uploads[i];
                    break;
                }
            }
            int stored = 0;
            if (slot && number >= 1) {
                for (int p = 0; p < 32; p++) {
                    if (!slot->parts[p].used || slot->parts[p].number == number) {
                        free(slot->parts[p].body);
                        slot->parts[p].used = 1;
                        slot->parts[p].number = number;
                        slot->parts[p].crc = crc;
                        slot->parts[p].body = malloc(payload_len ? payload_len : 1);
                        if (slot->parts[p].body && payload_len) {
                            memcpy(slot->parts[p].body, payload, payload_len);
                        }
                        slot->parts[p].len = payload_len;
                        stored = slot->parts[p].body != NULL;
                        break;
                    }
                }
            }
            pthread_mutex_unlock(&upload_mu);
            buf_free(&decoded_body);
            if (!stored) {
                return error_xml(out, 404, "NoSuchUpload", "The specified multipart upload does not exist", NULL);
            }
            char etag[24], extra[64];
            etag_from_crc(crc, etag, sizeof(etag));
            snprintf(extra, sizeof(extra), "ETag: %s\r\n", etag);
            return http_reply(out, 200, extra, NULL, 0);
        }
        uint32_t crc = 0;
        rc = cluster_put(c, bucket, key, payload, payload_len, &crc);
        buf_free(&decoded_body);
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "failed to write object");
        }
        char etag[24], extra[96];
        etag_from_crc(crc, etag, sizeof(etag));
        snprintf(extra, sizeof(extra), "ETag: %s\r\nx-s3dfs-etag-algorithm: crc32\r\n", etag);
        return http_reply(out, 200, extra, NULL, 0);
    }
    if (strcmp(method, "GET") == 0 || strcmp(method, "HEAD") == 0) {
        object_value_t meta = {0};
        int rc = cluster_head(c, bucket, key, &meta);
        char resource[2048];
        snprintf(resource, sizeof(resource), "/%s/%s", bucket, key);
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return error_xml(out, 404, "NoSuchKey", "The specified key does not exist", resource);
        }
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "failed to head object");
        }
        byte_range_t range = parse_byte_range(in->range[0] ? in->range : NULL, meta.size);
        char etag[24], lastmod[64], extra[512];
        etag_from_crc(meta.crc, etag, sizeof(etag));
        format_rfc1123(meta.mtime_ms, lastmod, sizeof(lastmod));
        if (range.kind == RANGE_UNSATISFIABLE) {
            snprintf(extra, sizeof(extra),
                     "Accept-Ranges: bytes\r\nETag: %s\r\nLast-Modified: %s\r\n"
                     "Content-Type: application/octet-stream\r\nContent-Range: bytes */%zu\r\n",
                     etag, lastmod, meta.size);
            return http_reply(out, 416, extra, NULL, 0);
        }
        int partial = (range.kind == RANGE_PARTIAL);
        uint64_t start = partial ? range.start : 0;
        uint64_t end = partial ? range.end : (meta.size == 0 ? 0 : (uint64_t)meta.size - 1);
        uint64_t length = meta.size == 0 ? 0 : (end - start + 1);
        if (partial) {
            snprintf(extra, sizeof(extra),
                     "Accept-Ranges: bytes\r\nETag: %s\r\nLast-Modified: %s\r\n"
                     "Content-Type: application/octet-stream\r\nContent-Range: bytes %" PRIu64 "-%" PRIu64
                     "/%zu\r\n",
                     etag, lastmod, start, end, meta.size);
        } else {
            snprintf(extra, sizeof(extra),
                     "Accept-Ranges: bytes\r\nETag: %s\r\nLast-Modified: %s\r\n"
                     "Content-Type: application/octet-stream\r\n",
                     etag, lastmod);
        }
        if (strcmp(method, "HEAD") == 0) {
            /* Content-Length is set by http_reply from body_len */
            char *body_placeholder = NULL;
            (void)body_placeholder;
            /* http_reply uses body_len for Content-Length, so pass length and NULL body */
            return http_reply(out, partial ? 206 : 200, extra, NULL, (size_t)length);
        }
        object_value_t obj = {0};
        if (partial) {
            rc = cluster_get_range(c, bucket, key, start, end, &obj);
        } else {
            rc = cluster_get(c, bucket, key, &obj);
        }
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return error_xml(out, 404, "NoSuchKey", "The specified key does not exist", resource);
        }
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "failed to read object");
        }
        rc = http_reply(out, partial ? 206 : 200, extra, obj.value, obj.size);
        object_value_free(&obj);
        return rc;
    }
    if (strcmp(method, "DELETE") == 0) {
        int rc = cluster_delete(c, bucket, key);
        if (rc != S3DFS_OK) {
            return service_error(out, rc, "failed to delete object");
        }
        return http_reply(out, 204, NULL, NULL, 0);
    }
    char resource[2048];
    snprintf(resource, sizeof(resource), "/%s/%s", bucket, key);
    return error_xml(out, 405, "MethodNotAllowed", "Method not allowed", resource);
}

int s3_handle(cluster_t *cluster, const http_in_t *in, http_out_t *out)
{
    int auth_status = 0;
    const char *auth_code = NULL;
    const char *auth_message = NULL;
    if (s3_sigv4_verify(in, (int64_t)time(NULL) * 1000, &auth_status, &auth_code, &auth_message) != 0) {
        return error_xml(out, auth_status, auth_code, auth_message, NULL);
    }
    if (!strncmp(in->path, "/_s3dfs", 7) && (in->path[7] == '\0' || in->path[7] == '/')) {
        return http_reply(out, 404, NULL, NULL, 0);
    }
    char bucket[512], key[3072];
    int has_key = 0;
    parse_path(in->path, bucket, sizeof(bucket), key, sizeof(key), &has_key);
    if (!bucket[0]) {
        if (strcmp(in->method, "GET") == 0) {
            return list_buckets_xml(cluster, out);
        }
        return error_xml(out, 405, "MethodNotAllowed", "Method not allowed", NULL);
    }
    if (!has_key) {
        return handle_bucket(cluster, in->method, bucket, in->query, out);
    }
    return handle_object(cluster, in, bucket, key, out);
}
