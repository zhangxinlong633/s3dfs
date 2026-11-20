#ifndef S3DFS_FUSE_UTIL_H
#define S3DFS_FUSE_UTIL_H

#include <stddef.h>
#include <stdint.h>
#include <time.h>

void *xmalloc(size_t n);
void *xrealloc(void *p, size_t n);
char *xstrdup(const char *s);

/* Percent-encode a path segment. Caller frees. */
char *url_escape(const char *s);

/* Decode %XX in place. Returns 0, or -1 if the encoding is broken. */
int url_unescape(char *s);

/* path.Clean("/" + name) with the leading slash removed. "." becomes "". */
void object_key(const char *name, char *out, size_t cap);

int parse_rfc1123(const char *s, time_t *out);
int parse_rfc3339(const char *s, time_t *out);
void format_rfc1123(time_t t, char *out, size_t cap);

void xml_escape(const char *s, char *out, size_t cap);
void xml_unescape(const char *s, char *out, size_t cap);

int header_value(const char *headers, const char *name, char *out, size_t cap);

#endif
