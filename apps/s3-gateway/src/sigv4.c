#include "s3.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#include <CommonCrypto/CommonHMAC.h>
#else
#include <openssl/evp.h>
#include <openssl/hmac.h>
#endif

static char g_access[128];
static char g_secret[256];
static int g_auth_on;

void s3_set_credentials(const char *access_key, const char *secret_key)
{
    g_auth_on = access_key && access_key[0] && secret_key && secret_key[0];
    snprintf(g_access, sizeof(g_access), "%s", g_auth_on ? access_key : "");
    snprintf(g_secret, sizeof(g_secret), "%s", g_auth_on ? secret_key : "");
}

static void sha256_hex(const void *data, size_t len, char out[65])
{
    unsigned char dig[32];
#if defined(__APPLE__)
    CC_SHA256(data, (CC_LONG)len, dig);
#else
    EVP_Digest(data, len, dig, NULL, EVP_sha256(), NULL);
#endif
    for (int i = 0; i < 32; i++) {
        sprintf(out + i * 2, "%02x", dig[i]);
    }
    out[64] = '\0';
}

static void hmac_sha256(const void *key, size_t key_len, const void *data, size_t data_len, unsigned char out[32])
{
#if defined(__APPLE__)
    CCHmac(kCCHmacAlgSHA256, key, key_len, data, data_len, out);
#else
    unsigned int n = 32;
    HMAC(EVP_sha256(), key, (int)key_len, data, data_len, out, &n);
#endif
}

static int aws_encode(const char *in, size_t n, char *out, size_t cap)
{
    static const char hex[] = "0123456789ABCDEF";
    size_t o = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)in[i];
        int plain = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
                    c == '.' || c == '~';
        if (plain) {
            if (o + 1 >= cap) {
                return -1;
            }
            out[o++] = (char)c;
        } else {
            if (o + 3 >= cap) {
                return -1;
            }
            out[o++] = '%';
            out[o++] = hex[c >> 4];
            out[o++] = hex[c & 15];
        }
    }
    if (o >= cap) {
        return -1;
    }
    out[o] = '\0';
    return (int)o;
}

static int encode_text(const char *text, char *out, size_t cap)
{
    return aws_encode(text, strlen(text), out, cap);
}

static int canonical_uri(const char *path, char *out, size_t cap)
{
    if (!path || !path[0] || strcmp(path, "/") == 0) {
        snprintf(out, cap, "/");
        return 0;
    }
    size_t o = 0;
    const char *p = path;
    while (*p) {
        const char *slash = strchr(p, '/');
        size_t n = slash ? (size_t)(slash - p) : strlen(p);
        char decoded[1024];
        char encoded[3072];
        buf_t tmp = {0};
        const char *src = p;
        size_t src_n = n;
        if (url_decode(p, n, &tmp) == S3DFS_OK) {
            snprintf(decoded, sizeof(decoded), "%s", tmp.data ? tmp.data : "");
            src = decoded;
            src_n = strlen(decoded);
        }
        buf_free(&tmp);
        if (aws_encode(src, src_n, encoded, sizeof(encoded)) < 0) {
            return -1;
        }
        size_t elen = strlen(encoded);
        if (o + elen + 2 >= cap) {
            return -1;
        }
        memcpy(out + o, encoded, elen);
        o += elen;
        if (slash) {
            out[o++] = '/';
            p = slash + 1;
        } else {
            break;
        }
    }
    out[o] = '\0';
    return 0;
}

typedef struct {
    char key[512];
    char value[2048];
} qpair_t;

static int query_value(const char *query, const char *name, char *out, size_t cap)
{
    const char *p = query ? query : "";
    while (*p) {
        const char *amp = strchr(p, '&');
        size_t n = amp ? (size_t)(amp - p) : strlen(p);
        const char *eq = memchr(p, '=', n);
        size_t klen = eq ? (size_t)(eq - p) : n;
        char key[512];
        buf_t decoded = {0};
        if (url_decode(p, klen, &decoded) == S3DFS_OK && decoded.data && strlen(decoded.data) < sizeof(key)) {
            snprintf(key, sizeof(key), "%s", decoded.data);
        } else if (klen < sizeof(key)) {
            memcpy(key, p, klen);
            key[klen] = '\0';
        } else {
            buf_free(&decoded);
            return -1;
        }
        buf_free(&decoded);
        if (strcasecmp(key, name) == 0) {
            const char *v = eq ? eq + 1 : p + n;
            size_t vlen = eq ? n - klen - 1 : 0;
            buf_t dv = {0};
            if (url_decode(v, vlen, &dv) == S3DFS_OK && dv.data) {
                snprintf(out, cap, "%s", dv.data);
            } else if (vlen < cap) {
                memcpy(out, v, vlen);
                out[vlen] = '\0';
            } else {
                buf_free(&dv);
                return -1;
            }
            buf_free(&dv);
            return 0;
        }
        p = amp ? amp + 1 : p + n;
    }
    out[0] = '\0';
    return -1;
}

static int canonical_query(const char *query, char *out, size_t cap)
{
    qpair_t pairs[48];
    int count = 0;
    const char *p = query ? query : "";
    while (*p) {
        const char *amp = strchr(p, '&');
        size_t n = amp ? (size_t)(amp - p) : strlen(p);
        if (n > 0 && count < 48) {
            const char *eq = memchr(p, '=', n);
            size_t klen = eq ? (size_t)(eq - p) : n;
            size_t vlen = eq ? n - klen - 1 : 0;
            char key[256];
            char value[1024];
            buf_t dk = {0};
            buf_t dv = {0};
            if (url_decode(p, klen, &dk) != S3DFS_OK || !dk.data) {
                buf_free(&dk);
                return -1;
            }
            snprintf(key, sizeof(key), "%s", dk.data);
            buf_free(&dk);
            if (eq && url_decode(eq + 1, vlen, &dv) == S3DFS_OK && dv.data) {
                snprintf(value, sizeof(value), "%s", dv.data);
            } else {
                value[0] = '\0';
            }
            buf_free(&dv);
            if (strcasecmp(key, "x-amz-signature") != 0) {
                if (encode_text(key, pairs[count].key, sizeof(pairs[count].key)) < 0 ||
                    encode_text(value, pairs[count].value, sizeof(pairs[count].value)) < 0) {
                    return -1;
                }
                count++;
            }
        }
        p = amp ? amp + 1 : p + n;
    }
    for (int i = 1; i < count; i++) {
        qpair_t cur = pairs[i];
        int j = i;
        while (j > 0) {
            int cmp = strcmp(pairs[j - 1].key, cur.key);
            if (cmp < 0 || (cmp == 0 && strcmp(pairs[j - 1].value, cur.value) <= 0)) {
                break;
            }
            pairs[j] = pairs[j - 1];
            j--;
        }
        pairs[j] = cur;
    }
    size_t o = 0;
    out[0] = '\0';
    for (int i = 0; i < count; i++) {
        int wrote = snprintf(out + o, cap - o, "%s%s=%s", i ? "&" : "", pairs[i].key, pairs[i].value);
        if (wrote < 0 || (size_t)wrote >= cap - o) {
            return -1;
        }
        o += (size_t)wrote;
    }
    return 0;
}

static void collapse_ws(const char *in, char *out, size_t cap)
{
    size_t o = 0;
    int space = 0;
    while (*in == ' ' || *in == '\t') {
        in++;
    }
    for (; *in && o + 1 < cap; in++) {
        if (*in == ' ' || *in == '\t') {
            space = 1;
            continue;
        }
        if (space && o + 1 < cap) {
            out[o++] = ' ';
            space = 0;
        }
        out[o++] = *in;
    }
    while (o > 0 && out[o - 1] == ' ') {
        o--;
    }
    out[o] = '\0';
}

static int payload_hash(const http_in_t *in, char out[80])
{
    char declared[128];
    if (http_in_header(in, "x-amz-content-sha256", declared, sizeof(declared)) == S3DFS_OK && declared[0]) {
        snprintf(out, 80, "%s", declared);
        return 0;
    }
    char algo[64];
    char sig[128];
    if (query_value(in->query, "X-Amz-Algorithm", algo, sizeof(algo)) == 0 ||
        query_value(in->query, "X-Amz-Signature", sig, sizeof(sig)) == 0) {
        snprintf(out, 80, "UNSIGNED-PAYLOAD");
        return 0;
    }
    sha256_hex(in->body ? in->body : "", in->body ? in->body_len : 0, out);
    return 0;
}

static int canonical_request(const http_in_t *in, const char *signed_headers, char *out, size_t cap)
{
    char uri[4096];
    char query[8192];
    char hash[80];
    char headers[8192];
    if (canonical_uri(in->path, uri, sizeof(uri)) != 0 || canonical_query(in->query, query, sizeof(query)) != 0 ||
        payload_hash(in, hash) != 0) {
        return -1;
    }
    size_t ho = 0;
    headers[0] = '\0';
    char names[1024];
    snprintf(names, sizeof(names), "%s", signed_headers ? signed_headers : "");
    char *save = NULL;
    for (char *name = strtok_r(names, ";", &save); name; name = strtok_r(NULL, ";", &save)) {
        char raw[1024];
        char folded[1024];
        if (http_in_header(in, name, raw, sizeof(raw)) != S3DFS_OK) {
            raw[0] = '\0';
        }
        collapse_ws(raw, folded, sizeof(folded));
        int wrote = snprintf(headers + ho, sizeof(headers) - ho, "%s:%s\n", name, folded);
        if (wrote < 0 || (size_t)wrote >= sizeof(headers) - ho) {
            return -1;
        }
        ho += (size_t)wrote;
    }
    int wrote = snprintf(out, cap, "%s\n%s\n%s\n%s\n%s\n%s", in->method, uri, query, headers, signed_headers ? signed_headers : "", hash);
    return wrote > 0 && (size_t)wrote < cap ? 0 : -1;
}

static void signing_key(const char *secret, const char *date, const char *region, const char *service, unsigned char out[32])
{
    char seed[300];
    snprintf(seed, sizeof(seed), "AWS4%s", secret);
    unsigned char k_date[32];
    unsigned char k_region[32];
    unsigned char k_service[32];
    hmac_sha256(seed, strlen(seed), date, strlen(date), k_date);
    hmac_sha256(k_date, 32, region, strlen(region), k_region);
    hmac_sha256(k_region, 32, service, strlen(service), k_service);
    hmac_sha256(k_service, 32, "aws4_request", strlen("aws4_request"), out);
}

static int sign_hex(const char *secret, const http_in_t *in, const char *amz_date, const char *scope, const char *signed_headers,
                    char out_hex[65])
{
    char date[16];
    char region[64];
    char service[32];
    if (sscanf(scope, "%15[^/]/%63[^/]/%31[^/]/aws4_request", date, region, service) != 3) {
        return -1;
    }
    char canonical[16384];
    if (canonical_request(in, signed_headers, canonical, sizeof(canonical)) != 0) {
        return -1;
    }
    char hashed[65];
    sha256_hex(canonical, strlen(canonical), hashed);
    char to_sign[512];
    snprintf(to_sign, sizeof(to_sign), "AWS4-HMAC-SHA256\n%s\n%s\n%s", amz_date, scope, hashed);
    unsigned char key[32];
    unsigned char mac[32];
    signing_key(secret, date, region, service, key);
    hmac_sha256(key, 32, to_sign, strlen(to_sign), mac);
    for (int i = 0; i < 32; i++) {
        sprintf(out_hex + i * 2, "%02x", mac[i]);
    }
    out_hex[64] = '\0';
    return 0;
}

int s3_sigv4_sign(const http_in_t *in, const char *secret, const char *amz_date, const char *scope, char out_hex[65])
{
    char auth[2048];
    char signed_headers[512];
    if (http_in_header(in, "authorization", auth, sizeof(auth)) == S3DFS_OK) {
        const char *mark = strstr(auth, "SignedHeaders=");
        if (!mark) {
            return -1;
        }
        mark += strlen("SignedHeaders=");
        size_t n = strcspn(mark, ", ");
        if (n >= sizeof(signed_headers)) {
            return -1;
        }
        memcpy(signed_headers, mark, n);
        signed_headers[n] = '\0';
    } else if (query_value(in->query, "X-Amz-SignedHeaders", signed_headers, sizeof(signed_headers)) != 0) {
        return -1;
    }
    return sign_hex(secret, in, amz_date, scope, signed_headers, out_hex);
}

static int parse_amz_date(const char *value, int64_t *out_ms)
{
    int year, month, day, hour, minute, second;
    if (sscanf(value, "%4d%2d%2dT%2d%2d%2dZ", &year, &month, &day, &hour, &minute, &second) != 6) {
        return -1;
    }
    struct tm tm;
    memset(&tm, 0, sizeof(tm));
    tm.tm_year = year - 1900;
    tm.tm_mon = month - 1;
    tm.tm_mday = day;
    tm.tm_hour = hour;
    tm.tm_min = minute;
    tm.tm_sec = second;
#if defined(__APPLE__)
    time_t sec = timegm(&tm);
#else
    time_t sec = timegm(&tm);
#endif
    if (sec < 0) {
        return -1;
    }
    *out_ms = (int64_t)sec * 1000;
    return 0;
}

static int fail(int *status, const char **code, const char **message, int http, const char *c, const char *m)
{
    *status = http;
    *code = c;
    *message = m;
    return -1;
}

int s3_sigv4_verify(const http_in_t *in, int64_t now_ms, int *status, const char **code, const char **message)
{
    *status = 200;
    *code = "";
    *message = "";
    if (!g_auth_on) {
        return 0;
    }
    char auth[2048];
    char credential[512];
    char signature[128];
    char amz_date[64];
    int presign = 0;
    int has_auth = http_in_header(in, "authorization", auth, sizeof(auth)) == S3DFS_OK && auth[0];
    if (has_auth) {
        if (strncmp(auth, "AWS4-HMAC-SHA256 ", 17) != 0) {
            return fail(status, code, message, 400, "AuthorizationHeaderMalformed", "Only AWS4-HMAC-SHA256 is supported");
        }
        const char *cred = strstr(auth, "Credential=");
        const char *sig = strstr(auth, "Signature=");
        if (!cred || !sig) {
            return fail(status, code, message, 400, "AuthorizationHeaderMalformed", "Credential or Signature is missing");
        }
        cred += strlen("Credential=");
        sig += strlen("Signature=");
        size_t cn = strcspn(cred, ", ");
        size_t sn = strcspn(sig, ", ");
        if (cn >= sizeof(credential) || sn >= sizeof(signature) || cn == 0 || sn == 0) {
            return fail(status, code, message, 400, "AuthorizationHeaderMalformed", "Credential or Signature is missing");
        }
        memcpy(credential, cred, cn);
        credential[cn] = '\0';
        memcpy(signature, sig, sn);
        signature[sn] = '\0';
        if (http_in_header(in, "x-amz-date", amz_date, sizeof(amz_date)) != S3DFS_OK || !amz_date[0]) {
            return fail(status, code, message, 403, "AccessDenied", "Missing X-Amz-Date");
        }
    } else {
        char algo[64];
        if (query_value(in->query, "X-Amz-Algorithm", algo, sizeof(algo)) != 0 || strcmp(algo, "AWS4-HMAC-SHA256") != 0) {
            return fail(status, code, message, 403, "AccessDenied", "Missing Authentication Token");
        }
        if (query_value(in->query, "X-Amz-Credential", credential, sizeof(credential)) != 0 ||
            query_value(in->query, "X-Amz-Signature", signature, sizeof(signature)) != 0 ||
            query_value(in->query, "X-Amz-Date", amz_date, sizeof(amz_date)) != 0 || !credential[0] || !signature[0] || !amz_date[0]) {
            return fail(status, code, message, 403, "AccessDenied", "Presigned request is missing credential fields");
        }
        presign = 1;
    }

    char access[128];
    char date[16];
    char region[64];
    char service[32];
    char tail[32];
    if (sscanf(credential, "%127[^/]/%15[^/]/%63[^/]/%31[^/]/%31s", access, date, region, service, tail) != 5 ||
        strcmp(tail, "aws4_request") != 0) {
        return fail(status, code, message, 400, "AuthorizationHeaderMalformed", "Credential scope is malformed");
    }
    if (strcmp(service, "s3") != 0) {
        return fail(status, code, message, 403, "AccessDenied", "Credential service must be s3");
    }
    if (strcmp(access, g_access) != 0) {
        return fail(status, code, message, 403, "InvalidAccessKeyId", "The access key id does not match");
    }
    if (strncmp(amz_date, date, strlen(date)) != 0) {
        return fail(status, code, message, 403, "AccessDenied", "X-Amz-Date does not match the credential date");
    }
    int64_t signed_at = 0;
    if (parse_amz_date(amz_date, &signed_at) != 0) {
        return fail(status, code, message, 403, "AccessDenied", "X-Amz-Date is not a valid ISO8601 timestamp");
    }
    if (presign) {
        char expires_text[32];
        if (query_value(in->query, "X-Amz-Expires", expires_text, sizeof(expires_text)) != 0) {
            return fail(status, code, message, 403, "AccessDenied", "X-Amz-Expires is invalid");
        }
        char *end = NULL;
        long expires = strtol(expires_text, &end, 10);
        if (!end || *end || expires < 1 || expires > 604800) {
            return fail(status, code, message, 403, "AccessDenied", "X-Amz-Expires is invalid");
        }
        if (now_ms > signed_at + expires * 1000) {
            return fail(status, code, message, 403, "AccessDenied", "Request has expired");
        }
    } else if (now_ms > signed_at + 15LL * 60 * 1000 || signed_at > now_ms + 15LL * 60 * 1000) {
        return fail(status, code, message, 403, "RequestTimeTooSkewed",
                    "The difference between the request time and the server time is too large");
    }

    char scope[160];
    snprintf(scope, sizeof(scope), "%s/%s/%s/aws4_request", date, region, service);
    char expected[65];
    if (s3_sigv4_sign(in, g_secret, amz_date, scope, expected) != 0) {
        return fail(status, code, message, 400, "AuthorizationHeaderMalformed", "SignedHeaders is missing");
    }
    if (strlen(expected) != strlen(signature) || strcasecmp(expected, signature) != 0) {
        return fail(status, code, message, 403, "SignatureDoesNotMatch",
                    "The request signature we calculated does not match the signature you provided");
    }
    return 0;
}
