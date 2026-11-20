#include "util.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

void *xmalloc(size_t n) {
    void *p = calloc(1, n ? n : 1);
    if (!p) {
        fprintf(stderr, "s3dfs-fuse: out of memory\n");
        exit(1);
    }
    return p;
}

void *xrealloc(void *p, size_t n) {
    void *q = realloc(p, n ? n : 1);
    if (!q) {
        fprintf(stderr, "s3dfs-fuse: out of memory\n");
        exit(1);
    }
    return q;
}

char *xstrdup(const char *s) {
    size_t n = strlen(s) + 1;
    char *p = xmalloc(n);
    memcpy(p, s, n);
    return p;
}

char *url_escape(const char *s) {
    static const char hex[] = "0123456789ABCDEF";
    size_t n = strlen(s);
    char *out = xmalloc(n * 3 + 1);
    size_t j = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        int keep = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' ||
                   c == '_' || c == '.' || c == '~';
        if (keep) {
            out[j++] = (char)c;
        } else {
            out[j++] = '%';
            out[j++] = hex[c >> 4];
            out[j++] = hex[c & 0xf];
        }
    }
    out[j] = '\0';
    return out;
}

static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

int url_unescape(char *s) {
    char *w = s;
    for (char *r = s; *r; r++) {
        if (*r == '%' && hex_nibble(r[1]) >= 0 && hex_nibble(r[2]) >= 0) {
            *w++ = (char)((hex_nibble(r[1]) << 4) | hex_nibble(r[2]));
            r += 2;
        } else if (*r == '+') {
            *w++ = ' ';
        } else {
            *w++ = *r;
        }
    }
    *w = '\0';
    return 0;
}

void object_key(const char *name, char *out, size_t cap) {
    char raw[4096];
    size_t n = 0;
    raw[n++] = '/';
    for (const char *p = name ? name : ""; *p && n + 1 < sizeof(raw); p++) {
        raw[n++] = *p == '\\' ? '/' : *p;
    }
    raw[n] = '\0';

    char parts[64][256];
    int count = 0;
    char *save = NULL;
    for (char *tok = strtok_r(raw, "/", &save); tok; tok = strtok_r(NULL, "/", &save)) {
        if (strcmp(tok, ".") == 0 || tok[0] == '\0') {
            continue;
        }
        if (strcmp(tok, "..") == 0) {
            if (count > 0) {
                count--;
            }
            continue;
        }
        if (count < 64) {
            snprintf(parts[count], sizeof(parts[count]), "%s", tok);
            count++;
        }
    }
    if (cap == 0) {
        return;
    }
    out[0] = '\0';
    size_t used = 0;
    for (int i = 0; i < count; i++) {
        int wrote = snprintf(out + used, cap - used, "%s%s", i ? "/" : "", parts[i]);
        if (wrote < 0 || (size_t)wrote >= cap - used) {
            out[cap - 1] = '\0';
            return;
        }
        used += (size_t)wrote;
    }
}

static int month_index(const char *mon) {
    static const char *names[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    for (int i = 0; i < 12; i++) {
        if (strncmp(mon, names[i], 3) == 0) {
            return i;
        }
    }
    return -1;
}

int parse_rfc1123(const char *s, time_t *out) {
    char mon[8] = {0};
    int day = 0, year = 0, hour = 0, min = 0, sec = 0;
    if (sscanf(s, "%*s %d %7s %d %d:%d:%d", &day, mon, &year, &hour, &min, &sec) != 6) {
        return -1;
    }
    int mi = month_index(mon);
    if (mi < 0) {
        return -1;
    }
    struct tm tm;
    memset(&tm, 0, sizeof(tm));
    tm.tm_mday = day;
    tm.tm_mon = mi;
    tm.tm_year = year - 1900;
    tm.tm_hour = hour;
    tm.tm_min = min;
    tm.tm_sec = sec;
    *out = timegm(&tm);
    return *out == (time_t)-1 ? -1 : 0;
}

int parse_rfc3339(const char *s, time_t *out) {
    int year = 0, mon = 0, day = 0, hour = 0, min = 0, sec = 0;
    if (sscanf(s, "%d-%d-%dT%d:%d:%d", &year, &mon, &day, &hour, &min, &sec) != 6) {
        return -1;
    }
    struct tm tm;
    memset(&tm, 0, sizeof(tm));
    tm.tm_year = year - 1900;
    tm.tm_mon = mon - 1;
    tm.tm_mday = day;
    tm.tm_hour = hour;
    tm.tm_min = min;
    tm.tm_sec = sec;
    *out = timegm(&tm);
    return *out == (time_t)-1 ? -1 : 0;
}

void format_rfc1123(time_t t, char *out, size_t cap) {
    struct tm tm;
    gmtime_r(&t, &tm);
    strftime(out, cap, "%a, %d %b %Y %H:%M:%S GMT", &tm);
}

void xml_escape(const char *s, char *out, size_t cap) {
    size_t j = 0;
    for (size_t i = 0; s[i] && j + 6 < cap; i++) {
        const char *rep = NULL;
        char one[2] = {s[i], 0};
        if (s[i] == '&') {
            rep = "&amp;";
        } else if (s[i] == '<') {
            rep = "&lt;";
        } else if (s[i] == '>') {
            rep = "&gt;";
        } else if (s[i] == '"') {
            rep = "&quot;";
        } else if (s[i] == '\'') {
            rep = "&apos;";
        } else {
            rep = one;
        }
        size_t n = strlen(rep);
        memcpy(out + j, rep, n);
        j += n;
    }
    out[j] = '\0';
}

void xml_unescape(const char *s, char *out, size_t cap) {
    size_t j = 0;
    for (size_t i = 0; s[i] && j + 1 < cap; i++) {
        if (s[i] == '&') {
            if (strncmp(s + i, "&amp;", 5) == 0) {
                out[j++] = '&';
                i += 4;
            } else if (strncmp(s + i, "&lt;", 4) == 0) {
                out[j++] = '<';
                i += 3;
            } else if (strncmp(s + i, "&gt;", 4) == 0) {
                out[j++] = '>';
                i += 3;
            } else if (strncmp(s + i, "&quot;", 6) == 0) {
                out[j++] = '"';
                i += 5;
            } else if (strncmp(s + i, "&apos;", 6) == 0) {
                out[j++] = '\'';
                i += 5;
            } else {
                out[j++] = s[i];
            }
        } else {
            out[j++] = s[i];
        }
    }
    out[j] = '\0';
}

int header_value(const char *headers, const char *name, char *out, size_t cap) {
    size_t nlen = strlen(name);
    const char *p = headers;
    while (*p) {
        const char *nl = strstr(p, "\r\n");
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        if (len > nlen + 1 && strncasecmp(p, name, nlen) == 0 && p[nlen] == ':') {
            const char *v = p + nlen + 1;
            while (*v == ' ' || *v == '\t') {
                v++;
            }
            size_t vn = (p + len) - v;
            if (vn >= cap) {
                vn = cap - 1;
            }
            memcpy(out, v, vn);
            out[vn] = '\0';
            return 0;
        }
        if (!nl) {
            break;
        }
        p = nl + 2;
    }
    if (cap) {
        out[0] = '\0';
    }
    return -1;
}
