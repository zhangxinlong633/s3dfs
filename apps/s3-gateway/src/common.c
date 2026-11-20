#include "common.h"

#include <ctype.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#include <zlib.h>
#include <zstd.h>

void log_info(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    flockfile(stderr);
    fputs("[s3-gateway] ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    funlockfile(stderr);
    va_end(ap);
}

void log_error(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    flockfile(stderr);
    fputs("[s3-gateway] error: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    funlockfile(stderr);
    va_end(ap);
}

int buf_reserve(buf_t *b, size_t need)
{
    if (b->len + need <= b->cap) {
        return S3DFS_OK;
    }
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->len + need) {
        if (cap > (SIZE_MAX / 2)) {
            return S3DFS_ERR_NOMEM;
        }
        cap *= 2;
    }
    char *p = realloc(b->data, cap);
    if (!p) {
        return S3DFS_ERR_NOMEM;
    }
    b->data = p;
    b->cap = cap;
    return S3DFS_OK;
}

int buf_append(buf_t *b, const void *p, size_t n)
{
    if (n == 0) {
        return S3DFS_OK;
    }
    if (buf_reserve(b, n + 1) != S3DFS_OK) {
        return S3DFS_ERR_NOMEM;
    }
    memcpy(b->data + b->len, p, n);
    b->len += n;
    b->data[b->len] = '\0';
    return S3DFS_OK;
}

int buf_append_str(buf_t *b, const char *s)
{
    return buf_append(b, s, strlen(s));
}

int buf_printf(buf_t *b, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    va_list aq;
    va_copy(aq, ap);
    int n = vsnprintf(NULL, 0, fmt, aq);
    va_end(aq);
    if (n < 0) {
        va_end(ap);
        return S3DFS_ERR;
    }
    if (buf_reserve(b, (size_t)n + 1) != S3DFS_OK) {
        va_end(ap);
        return S3DFS_ERR_NOMEM;
    }
    vsnprintf(b->data + b->len, (size_t)n + 1, fmt, ap);
    b->len += (size_t)n;
    va_end(ap);
    return S3DFS_OK;
}

void buf_clear(buf_t *b)
{
    b->len = 0;
    if (b->data) {
        b->data[0] = '\0';
    }
}

void buf_free(buf_t *b)
{
    free(b->data);
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
}

uint64_t now_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint64_t)tv.tv_sec * 1000u + (uint64_t)(tv.tv_usec / 1000);
}

void format_iso8601(uint64_t ms, char *out, size_t cap)
{
    time_t sec = (time_t)(ms / 1000);
    int msec = (int)(ms % 1000);
    struct tm tm;
    gmtime_r(&sec, &tm);
    snprintf(out, cap, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
             tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
             tm.tm_hour, tm.tm_min, tm.tm_sec, msec);
}

void format_rfc1123(uint64_t ms, char *out, size_t cap)
{
    time_t sec = (time_t)(ms / 1000);
    struct tm tm;
    gmtime_r(&sec, &tm);
    strftime(out, cap, "%a, %d %b %Y %H:%M:%S GMT", &tm);
}

uint32_t crc32_ieee(const void *data, size_t n)
{
    return (uint32_t)crc32(0, (const Bytef *)data, (uInt)n);
}

/* Public-domain SHA-1 (Steve Reid / slightly compacted). */
typedef struct {
    uint32_t state[5];
    uint64_t count;
    unsigned char buffer[64];
} sha1_ctx;

static uint32_t rol(uint32_t v, int c)
{
    return (v << c) | (v >> (32 - c));
}

static void sha1_transform(uint32_t state[5], const unsigned char buffer[64])
{
    uint32_t a, b, c, d, e, t, w[80];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)buffer[i * 4] << 24) | ((uint32_t)buffer[i * 4 + 1] << 16) |
               ((uint32_t)buffer[i * 4 + 2] << 8) | (uint32_t)buffer[i * 4 + 3];
    }
    for (int i = 16; i < 80; i++) {
        w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    a = state[0];
    b = state[1];
    c = state[2];
    d = state[3];
    e = state[4];
    for (int i = 0; i < 80; i++) {
        if (i < 20) {
            t = rol(a, 5) + ((b & c) | ((~b) & d)) + e + w[i] + 0x5A827999u;
        } else if (i < 40) {
            t = rol(a, 5) + (b ^ c ^ d) + e + w[i] + 0x6ED9EBA1u;
        } else if (i < 60) {
            t = rol(a, 5) + ((b & c) | (b & d) | (c & d)) + e + w[i] + 0x8F1BBCDCu;
        } else {
            t = rol(a, 5) + (b ^ c ^ d) + e + w[i] + 0xCA62C1D6u;
        }
        e = d;
        d = c;
        c = rol(b, 30);
        b = a;
        a = t;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
}

static void sha1_init(sha1_ctx *c)
{
    c->state[0] = 0x67452301u;
    c->state[1] = 0xEFCDAB89u;
    c->state[2] = 0x98BADCFEu;
    c->state[3] = 0x10325476u;
    c->state[4] = 0xC3D2E1F0u;
    c->count = 0;
}

static void sha1_update(sha1_ctx *c, const unsigned char *data, size_t len)
{
    size_t i = (size_t)(c->count & 63);
    c->count += len;
    if (i) {
        size_t n = 64 - i;
        if (len < n) {
            memcpy(c->buffer + i, data, len);
            return;
        }
        memcpy(c->buffer + i, data, n);
        sha1_transform(c->state, c->buffer);
        data += n;
        len -= n;
    }
    while (len >= 64) {
        sha1_transform(c->state, data);
        data += 64;
        len -= 64;
    }
    if (len) {
        memcpy(c->buffer, data, len);
    }
}

static void sha1_final(sha1_ctx *c, unsigned char out[20])
{
    unsigned char pad[72];
    uint64_t bits = c->count * 8;
    size_t i = (size_t)(c->count & 63);
    pad[0] = 0x80;
    size_t padn = (i < 56) ? (56 - i) : (120 - i);
    memset(pad + 1, 0, padn - 1);
    for (int j = 0; j < 8; j++) {
        pad[padn + j] = (unsigned char)(bits >> (56 - 8 * j));
    }
    sha1_update(c, pad, padn + 8);
    for (int j = 0; j < 5; j++) {
        out[j * 4] = (unsigned char)(c->state[j] >> 24);
        out[j * 4 + 1] = (unsigned char)(c->state[j] >> 16);
        out[j * 4 + 2] = (unsigned char)(c->state[j] >> 8);
        out[j * 4 + 3] = (unsigned char)c->state[j];
    }
}

void sha1_buf(const void *data, size_t n, unsigned char out[20])
{
    sha1_ctx c;
    sha1_init(&c);
    sha1_update(&c, (const unsigned char *)data, n);
    sha1_final(&c, out);
}

uint32_t sha1_u32be(const void *data, size_t n)
{
    unsigned char d[20];
    sha1_buf(data, n, d);
    return ((uint32_t)d[0] << 24) | ((uint32_t)d[1] << 16) | ((uint32_t)d[2] << 8) | (uint32_t)d[3];
}

static int is_unreserved_uri(unsigned char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
           c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' ||
           c == '(' || c == ')';
}

int url_encode(const char *in, size_t in_len, buf_t *out)
{
    static const char hex[] = "0123456789ABCDEF";
    if (buf_reserve(out, in_len * 3 + 1) != S3DFS_OK) {
        return S3DFS_ERR_NOMEM;
    }
    for (size_t i = 0; i < in_len; i++) {
        unsigned char c = (unsigned char)in[i];
        if (is_unreserved_uri(c)) {
            out->data[out->len++] = (char)c;
        } else {
            out->data[out->len++] = '%';
            out->data[out->len++] = hex[c >> 4];
            out->data[out->len++] = hex[c & 15];
        }
    }
    out->data[out->len] = '\0';
    return S3DFS_OK;
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    return -1;
}

int url_decode(const char *in, size_t in_len, buf_t *out)
{
    if (buf_reserve(out, in_len + 1) != S3DFS_OK) {
        return S3DFS_ERR_NOMEM;
    }
    for (size_t i = 0; i < in_len; i++) {
        if (in[i] == '%' && i + 2 < in_len) {
            int hi = hexval(in[i + 1]);
            int lo = hexval(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out->data[out->len++] = (char)((hi << 4) | lo);
                i += 2;
                continue;
            }
        }
        out->data[out->len++] = in[i];
    }
    out->data[out->len] = '\0';
    return S3DFS_OK;
}

int url_decode_str(const char *in, char *out, size_t cap)
{
    buf_t b = {0};
    int rc = url_decode(in, strlen(in), &b);
    if (rc == S3DFS_OK) {
        if (b.len + 1 > cap) {
            rc = S3DFS_ERR_ARGS;
        } else {
            memcpy(out, b.data ? b.data : "", b.len + 1);
        }
    }
    buf_free(&b);
    return rc;
}

int xml_escape(const char *in, buf_t *out)
{
    for (const unsigned char *p = (const unsigned char *)in; *p; p++) {
        const char *rep = NULL;
        switch (*p) {
        case '&':
            rep = "&amp;";
            break;
        case '<':
            rep = "&lt;";
            break;
        case '>':
            rep = "&gt;";
            break;
        case '"':
            rep = "&quot;";
            break;
        case '\'':
            rep = "&apos;";
            break;
        default:
            if (buf_append(out, p, 1) != S3DFS_OK) {
                return S3DFS_ERR_NOMEM;
            }
            continue;
        }
        if (buf_append_str(out, rep) != S3DFS_OK) {
            return S3DFS_ERR_NOMEM;
        }
    }
    return S3DFS_OK;
}

int json_escape(const char *in, buf_t *out)
{
    if (buf_append(out, "\"", 1) != S3DFS_OK) {
        return S3DFS_ERR_NOMEM;
    }
    for (const unsigned char *p = (const unsigned char *)in; *p; p++) {
        char tmp[8];
        const char *rep = NULL;
        size_t n = 0;
        switch (*p) {
        case '"':
            rep = "\\\"";
            n = 2;
            break;
        case '\\':
            rep = "\\\\";
            n = 2;
            break;
        case '\b':
            rep = "\\b";
            n = 2;
            break;
        case '\f':
            rep = "\\f";
            n = 2;
            break;
        case '\n':
            rep = "\\n";
            n = 2;
            break;
        case '\r':
            rep = "\\r";
            n = 2;
            break;
        case '\t':
            rep = "\\t";
            n = 2;
            break;
        default:
            if (*p < 0x20) {
                snprintf(tmp, sizeof(tmp), "\\u%04x", *p);
                rep = tmp;
                n = 6;
            } else {
                tmp[0] = (char)*p;
                rep = tmp;
                n = 1;
            }
            break;
        }
        if (buf_append(out, rep, n) != S3DFS_OK) {
            return S3DFS_ERR_NOMEM;
        }
    }
    return buf_append(out, "\"", 1);
}

const char *compress_name(compress_type_t t)
{
    if (t == COMPRESS_ZSTD) {
        return "zstd";
    }
    if (t == COMPRESS_GZIP) {
        return "gzip";
    }
    return "none";
}

compress_type_t parse_compress_type(const char *raw)
{
    const char *value = raw && raw[0] ? raw : "zstd";
    char tmp[32];
    size_t n = 0;
    while (value[n] && n + 1 < sizeof(tmp)) {
        tmp[n] = (char)tolower((unsigned char)value[n]);
        n++;
    }
    tmp[n] = '\0';
    /* trim */
    char *s = tmp;
    while (*s == ' ' || *s == '\t') {
        s++;
    }
    if (strcmp(s, "none") == 0 || strcmp(s, "off") == 0 || strcmp(s, "0") == 0 || strcmp(s, "false") == 0) {
        return COMPRESS_NONE;
    }
    if (strcmp(s, "gzip") == 0 || strcmp(s, "gz") == 0 || strcmp(s, "deflate") == 0) {
        return COMPRESS_GZIP;
    }
    return COMPRESS_ZSTD;
}

static int gzip_compress(const void *in, size_t in_len, void **out, size_t *out_len)
{
    z_stream strm;
    memset(&strm, 0, sizeof(strm));
    if (deflateInit2(&strm, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
        return S3DFS_ERR;
    }
    size_t cap = deflateBound(&strm, (uLong)in_len) + 32;
    unsigned char *buf = malloc(cap);
    if (!buf) {
        deflateEnd(&strm);
        return S3DFS_ERR_NOMEM;
    }
    strm.next_in = (Bytef *)in;
    strm.avail_in = (uInt)in_len;
    strm.next_out = buf;
    strm.avail_out = (uInt)cap;
    int rc = deflate(&strm, Z_FINISH);
    size_t n = cap - strm.avail_out;
    deflateEnd(&strm);
    if (rc != Z_STREAM_END) {
        free(buf);
        return S3DFS_ERR;
    }
    *out = buf;
    *out_len = n;
    return S3DFS_OK;
}

static int gzip_decompress(const void *in, size_t in_len, size_t orig_size, void **out, size_t *out_len)
{
    size_t cap = orig_size ? orig_size : in_len * 4 + 64;
    unsigned char *buf = malloc(cap ? cap : 1);
    if (!buf) {
        return S3DFS_ERR_NOMEM;
    }
    z_stream strm;
    memset(&strm, 0, sizeof(strm));
    if (inflateInit2(&strm, 15 + 16) != Z_OK) {
        free(buf);
        return S3DFS_ERR;
    }
    strm.next_in = (Bytef *)in;
    strm.avail_in = (uInt)in_len;
    for (;;) {
        strm.next_out = buf + strm.total_out;
        strm.avail_out = (uInt)(cap - strm.total_out);
        int rc = inflate(&strm, Z_NO_FLUSH);
        if (rc == Z_STREAM_END) {
            *out = buf;
            *out_len = (size_t)strm.total_out;
            inflateEnd(&strm);
            return S3DFS_OK;
        }
        if (rc != Z_OK && rc != Z_BUF_ERROR) {
            inflateEnd(&strm);
            free(buf);
            return S3DFS_ERR;
        }
        size_t ncap = cap * 2;
        unsigned char *nbuf = realloc(buf, ncap);
        if (!nbuf) {
            inflateEnd(&strm);
            free(buf);
            return S3DFS_ERR_NOMEM;
        }
        buf = nbuf;
        cap = ncap;
    }
}

int compress_value(const void *in, size_t in_len, compress_type_t prefer,
                   void **out, size_t *out_len, compress_type_t *applied)
{
    if (prefer == COMPRESS_NONE || in_len < MIN_COMPRESS_BYTES) {
        *out = NULL;
        *out_len = in_len;
        *applied = COMPRESS_NONE;
        return S3DFS_OK;
    }
    void *packed = NULL;
    size_t packed_len = 0;
    int rc = S3DFS_ERR;
    if (prefer == COMPRESS_GZIP) {
        rc = gzip_compress(in, in_len, &packed, &packed_len);
    } else {
        size_t bound = ZSTD_compressBound(in_len);
        packed = malloc(bound);
        if (!packed) {
            return S3DFS_ERR_NOMEM;
        }
        size_t n = ZSTD_compress(packed, bound, in, in_len, ZSTD_CLEVEL_DEFAULT);
        if (ZSTD_isError(n)) {
            free(packed);
            packed = NULL;
            rc = S3DFS_ERR;
        } else {
            packed_len = n;
            rc = S3DFS_OK;
        }
    }
    if (rc != S3DFS_OK || packed_len >= in_len) {
        free(packed);
        *out = NULL;
        *out_len = in_len;
        *applied = COMPRESS_NONE;
        return S3DFS_OK;
    }
    *out = packed;
    *out_len = packed_len;
    *applied = prefer;
    return S3DFS_OK;
}

int decompress_value(const void *in, size_t in_len, compress_type_t type,
                     size_t orig_size, void **out, size_t *out_len)
{
    if (type == COMPRESS_NONE) {
        void *copy = malloc(in_len ? in_len : 1);
        if (!copy) {
            return S3DFS_ERR_NOMEM;
        }
        if (in_len) {
            memcpy(copy, in, in_len);
        }
        *out = copy;
        *out_len = in_len;
        return S3DFS_OK;
    }
    if (type == COMPRESS_GZIP) {
        return gzip_decompress(in, in_len, orig_size, out, out_len);
    }
    size_t cap = orig_size ? orig_size : in_len * 4 + 64;
    void *buf = malloc(cap ? cap : 1);
    if (!buf) {
        return S3DFS_ERR_NOMEM;
    }
    size_t n = ZSTD_decompress(buf, cap, in, in_len);
    if (ZSTD_isError(n)) {
        free(buf);
        return S3DFS_ERR;
    }
    *out = buf;
    *out_len = n;
    return S3DFS_OK;
}

int parse_hostport(const char *s, char *host, size_t host_cap, int *port)
{
    const char *colon = strrchr(s, ':');
    if (!colon || colon == s) {
        snprintf(host, host_cap, "%s", s);
        *port = 80;
        return S3DFS_OK;
    }
    size_t n = (size_t)(colon - s);
    if (n >= host_cap) {
        return S3DFS_ERR_ARGS;
    }
    memcpy(host, s, n);
    host[n] = '\0';
    *port = atoi(colon + 1);
    if (*port <= 0 || *port > 65535) {
        return S3DFS_ERR_ARGS;
    }
    return S3DFS_OK;
}

int parse_listen(const char *s, char *host, size_t host_cap, int *port)
{
    if (!s || !s[0]) {
        snprintf(host, host_cap, "0.0.0.0");
        *port = 19002;
        return S3DFS_OK;
    }
    /* bare port */
    char *end = NULL;
    long p = strtol(s, &end, 10);
    if (end && *end == '\0' && p > 0 && p <= 65535) {
        snprintf(host, host_cap, "0.0.0.0");
        *port = (int)p;
        return S3DFS_OK;
    }
    return parse_hostport(s, host, host_cap, port);
}

int parse_http_url(const char *s, char *host, size_t host_cap, int *port, char *path, size_t path_cap)
{
    const char *p = s;
    if (!strncmp(p, "http://", 7)) {
        p += 7;
        *port = 80;
    } else if (!strncmp(p, "https://", 8)) {
        p += 8;
        *port = 443;
    } else {
        *port = 80;
    }
    const char *slash = strchr(p, '/');
    char hostport[256];
    size_t n = slash ? (size_t)(slash - p) : strlen(p);
    if (n >= sizeof(hostport) || n == 0) {
        return S3DFS_ERR_ARGS;
    }
    memcpy(hostport, p, n);
    hostport[n] = '\0';
    /* strip trailing colon-only */
    if (parse_hostport(hostport, host, host_cap, port) != S3DFS_OK) {
        /* no port in hostport */
        snprintf(host, host_cap, "%s", hostport);
    }
    if (path && path_cap) {
        snprintf(path, path_cap, "%s", slash ? slash : "/");
    }
    return S3DFS_OK;
}

void set_sock_opts(int fd, int timeout_ms)
{
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    if (timeout_ms > 0) {
        struct timeval tv;
        tv.tv_sec = timeout_ms / 1000;
        tv.tv_usec = (timeout_ms % 1000) * 1000;
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    }
}

int set_nonblock(int fd, int nb)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) {
        return S3DFS_ERR_IO;
    }
    if (nb) {
        flags |= O_NONBLOCK;
    } else {
        flags &= ~O_NONBLOCK;
    }
    return fcntl(fd, F_SETFL, flags) == 0 ? S3DFS_OK : S3DFS_ERR_IO;
}

int header_ieq(const char *a, size_t a_len, const char *name)
{
    size_t n = strlen(name);
    if (a_len != n) {
        return 0;
    }
    for (size_t i = 0; i < n; i++) {
        if (tolower((unsigned char)a[i]) != tolower((unsigned char)name[i])) {
            return 0;
        }
    }
    return 1;
}

byte_range_t parse_byte_range(const char *header, uint64_t size)
{
    byte_range_t r = {RANGE_ALL, 0, 0};
    if (!header || !header[0]) {
        return r;
    }
    while (*header == ' ' || *header == '\t') {
        header++;
    }
    if (strncasecmp(header, "bytes=", 6) != 0) {
        return r;
    }
    const char *first = header + 6;
    while (*first == ' ' || *first == '\t') {
        first++;
    }
    char tmp[128];
    size_t n = 0;
    while (first[n] && first[n] != ',' && n + 1 < sizeof(tmp)) {
        tmp[n] = first[n];
        n++;
    }
    tmp[n] = '\0';
    /* trim */
    while (n && (tmp[n - 1] == ' ' || tmp[n - 1] == '\t')) {
        tmp[--n] = '\0';
    }
    if (n == 0) {
        r.kind = RANGE_UNSATISFIABLE;
        return r;
    }
    if (size == 0) {
        r.kind = RANGE_UNSATISFIABLE;
        return r;
    }
    if (tmp[0] == '-') {
        char *end = NULL;
        long suffix = strtol(tmp + 1, &end, 10);
        if (!end || *end || suffix <= 0) {
            r.kind = RANGE_UNSATISFIABLE;
            return r;
        }
        uint64_t su = (uint64_t)suffix;
        r.kind = RANGE_PARTIAL;
        r.start = size > su ? size - su : 0;
        r.end = size - 1;
        return r;
    }
    char *dash = strchr(tmp, '-');
    if (!dash) {
        r.kind = RANGE_UNSATISFIABLE;
        return r;
    }
    *dash = '\0';
    char *end = NULL;
    long start = strtol(tmp, &end, 10);
    if (!end || *end || start < 0 || (uint64_t)start >= size) {
        r.kind = RANGE_UNSATISFIABLE;
        return r;
    }
    if (dash[1] == '\0') {
        r.kind = RANGE_PARTIAL;
        r.start = (uint64_t)start;
        r.end = size - 1;
        return r;
    }
    char *end2 = NULL;
    long last = strtol(dash + 1, &end2, 10);
    if (!end2 || *end2 || last < start) {
        r.kind = RANGE_UNSATISFIABLE;
        return r;
    }
    r.kind = RANGE_PARTIAL;
    r.start = (uint64_t)start;
    r.end = (uint64_t)last < size ? (uint64_t)last : size - 1;
    return r;
}

static const char *skip_ws(const char *p, const char *end)
{
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) {
        p++;
    }
    return p;
}


static const char *json_skip_string(const char *p, const char *end)
{
    if (p >= end || *p != '"') {
        return p;
    }
    p++;
    while (p < end && *p != '"') {
        if (*p == '\\' && p + 1 < end) {
            p += 2;
        } else {
            p++;
        }
    }
    if (p < end) {
        p++;
    }
    return p;
}

static const char *json_skip_value(const char *p, const char *end)
{
    p = skip_ws(p, end);
    if (p >= end) {
        return p;
    }
    if (*p == '"') {
        return json_skip_string(p, end);
    }
    if (*p == '{' || *p == '[') {
        char open = *p;
        char close = (open == '{') ? '}' : ']';
        int d = 1;
        p++;
        while (p < end && d > 0) {
            if (*p == '"') {
                p = json_skip_string(p, end);
                continue;
            }
            if (*p == open) {
                d++;
            } else if (*p == close) {
                d--;
            }
            p++;
        }
        return p;
    }
    while (p < end && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\n' && *p != '\r' && *p != '\t') {
        p++;
    }
    return p;
}

int json_find_key(const char *json, size_t len, const char *key, const char **val, size_t *val_len)
{
    if (!json) {
        return S3DFS_ERR_NOT_FOUND;
    }
    const char *end = json + len;
    const char *p = skip_ws(json, end);
    /* Walk only the top-level object (or the object slice passed in). */
    if (p < end && *p == '{') {
        p++;
    }
    size_t klen = strlen(key);
    while (p < end) {
        p = skip_ws(p, end);
        if (p >= end || *p == '}') {
            break;
        }
        if (*p == ',') {
            p++;
            continue;
        }
        if (*p != '"') {
            p++;
            continue;
        }
        const char *start = p + 1;
        p = json_skip_string(p, end);
        size_t slen = (p > start + 1) ? (size_t)(p - start - 1) : 0;
        /* start points at first char inside quotes; p is after closing quote. */
        if (p > start && p[-1] == '"') {
            slen = (size_t)((p - 1) - start);
        }
        p = skip_ws(p, end);
        if (p >= end || *p != ':') {
            continue;
        }
        p++;
        p = skip_ws(p, end);
        if (slen == klen && memcmp(start, key, klen) == 0) {
            *val = p;
            const char *after = json_skip_value(p, end);
            *val_len = (size_t)(after - p);
            return S3DFS_OK;
        }
        p = json_skip_value(p, end);
    }
    return S3DFS_ERR_NOT_FOUND;
}

static int json_unescape(const char *s, size_t n, char *out, size_t cap)
{
    if (n < 2 || s[0] != '"') {
        return S3DFS_ERR;
    }
    const char *p = s + 1;
    const char *end = s + n;
    if (end > s && end[-1] == '"') {
        end--;
    }
    size_t o = 0;
    while (p < end) {
        if (o + 1 >= cap) {
            return S3DFS_ERR_ARGS;
        }
        if (*p == '\\' && p + 1 < end) {
            p++;
            switch (*p) {
            case '"':
            case '\\':
            case '/':
                out[o++] = *p;
                break;
            case 'b':
                out[o++] = '\b';
                break;
            case 'f':
                out[o++] = '\f';
                break;
            case 'n':
                out[o++] = '\n';
                break;
            case 'r':
                out[o++] = '\r';
                break;
            case 't':
                out[o++] = '\t';
                break;
            case 'u':
                if (p + 4 >= end) {
                    return S3DFS_ERR;
                }
                {
                    int cp = 0;
                    for (int i = 1; i <= 4; i++) {
                        int h = hexval(p[i]);
                        if (h < 0) {
                            return S3DFS_ERR;
                        }
                        cp = (cp << 4) | h;
                    }
                    p += 4;
                    if (cp < 0x80) {
                        out[o++] = (char)cp;
                    } else if (cp < 0x800) {
                        if (o + 2 >= cap) {
                            return S3DFS_ERR_ARGS;
                        }
                        out[o++] = (char)(0xC0 | (cp >> 6));
                        out[o++] = (char)(0x80 | (cp & 0x3F));
                    } else {
                        if (o + 3 >= cap) {
                            return S3DFS_ERR_ARGS;
                        }
                        out[o++] = (char)(0xE0 | (cp >> 12));
                        out[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                        out[o++] = (char)(0x80 | (cp & 0x3F));
                    }
                }
                break;
            default:
                out[o++] = *p;
                break;
            }
            p++;
        } else {
            out[o++] = *p++;
        }
    }
    out[o] = '\0';
    return S3DFS_OK;
}

int json_get_string(const char *json, size_t len, const char *key, char *out, size_t cap)
{
    const char *v;
    size_t n;
    if (json_find_key(json, len, key, &v, &n) != S3DFS_OK) {
        return S3DFS_ERR_NOT_FOUND;
    }
    return json_unescape(v, n, out, cap);
}

int json_get_i64(const char *json, size_t len, const char *key, int64_t *out)
{
    const char *v;
    size_t n;
    if (json_find_key(json, len, key, &v, &n) != S3DFS_OK) {
        return S3DFS_ERR_NOT_FOUND;
    }
    char tmp[64];
    if (n >= sizeof(tmp)) {
        return S3DFS_ERR;
    }
    memcpy(tmp, v, n);
    tmp[n] = '\0';
    char *end = NULL;
    *out = (int64_t)strtoll(tmp, &end, 10);
    return S3DFS_OK;
}

int json_get_u64(const char *json, size_t len, const char *key, uint64_t *out)
{
    int64_t v;
    if (json_get_i64(json, len, key, &v) != S3DFS_OK) {
        return S3DFS_ERR_NOT_FOUND;
    }
    *out = (uint64_t)v;
    return S3DFS_OK;
}

int json_get_u32(const char *json, size_t len, const char *key, uint32_t *out)
{
    int64_t v;
    if (json_get_i64(json, len, key, &v) != S3DFS_OK) {
        return S3DFS_ERR_NOT_FOUND;
    }
    *out = (uint32_t)v;
    return S3DFS_OK;
}

int json_get_bool(const char *json, size_t len, const char *key, int *out)
{
    const char *v;
    size_t n;
    if (json_find_key(json, len, key, &v, &n) != S3DFS_OK) {
        return S3DFS_ERR_NOT_FOUND;
    }
    if (n == 4 && !memcmp(v, "true", 4)) {
        *out = 1;
        return S3DFS_OK;
    }
    if (n == 5 && !memcmp(v, "false", 5)) {
        *out = 0;
        return S3DFS_OK;
    }
    if (n == 1 && v[0] == '1') {
        *out = 1;
        return S3DFS_OK;
    }
    if (n == 1 && v[0] == '0') {
        *out = 0;
        return S3DFS_OK;
    }
    return S3DFS_ERR;
}

int json_get_bool_or(const char *json, size_t len, const char *key, int default_val)
{
    int v;
    if (json_get_bool(json, len, key, &v) == S3DFS_OK) {
        return v;
    }
    return default_val;
}

int json_array_objects(const char *json, size_t len, const char *array_key, json_obj_cb cb, void *ud)
{
    const char *v;
    size_t n;
    if (json_find_key(json, len, array_key, &v, &n) != S3DFS_OK) {
        return S3DFS_ERR_NOT_FOUND;
    }
    const char *p = v;
    const char *end = v + n;
    p = skip_ws(p, end);
    if (p >= end || *p != '[') {
        return S3DFS_ERR;
    }
    p++;
    while (p < end) {
        p = skip_ws(p, end);
        if (p < end && *p == ']') {
            return S3DFS_OK;
        }
        if (p < end && *p == ',') {
            p++;
            continue;
        }
        if (p >= end || *p != '{') {
            return S3DFS_ERR;
        }
        const char *obj = p;
        int d = 1;
        p++;
        while (p < end && d > 0) {
            if (*p == '"') {
                p++;
                while (p < end && *p != '"') {
                    if (*p == '\\' && p + 1 < end) {
                        p += 2;
                    } else {
                        p++;
                    }
                }
                if (p < end) {
                    p++;
                }
                continue;
            }
            if (*p == '{') {
                d++;
            } else if (*p == '}') {
                d--;
            }
            p++;
        }
        if (cb(obj, (size_t)(p - obj), ud) != 0) {
            return S3DFS_ERR;
        }
    }
    return S3DFS_OK;
}

int is_node_key(const char *key)
{
    return strncmp(key, "$node/", 6) == 0;
}

int is_replica_locator_key(const char *key)
{
    const char *colon = strrchr(key, ':');
    if (!colon || colon[1] == '\0') {
        return 0;
    }
    if (colon[1] < '1' || colon[1] > '9') {
        return 0;
    }
    for (const char *p = colon + 2; *p; p++) {
        if (*p < '0' || *p > '9') {
            return 0;
        }
    }
    return 1;
}

int is_visible_object_key(const char *key)
{
    return !is_node_key(key) && !is_replica_locator_key(key);
}

void locator_key(const char *object_key, int replica, char *out, size_t cap)
{
    if (replica <= 0) {
        snprintf(out, cap, "%s", object_key);
    } else {
        snprintf(out, cap, "%s:%d", object_key, replica);
    }
}
