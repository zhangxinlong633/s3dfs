package main

import (
	"context"
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type memObj struct {
	body  []byte
	mtime time.Time
	etag  string
}

type memBucket struct {
	mu      sync.Mutex
	objects map[string]*memObj
}

func newMemBucket() *memBucket {
	return &memBucket{objects: map[string]*memObj{}}
}

func (b *memBucket) handler(bucket string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == bucket && r.Method == http.MethodGet {
			b.list(w, r)
			return
		}
		key := strings.TrimPrefix(p, bucket+"/")
		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			b.mu.Lock()
			b.objects[key] = &memObj{body: body, mtime: time.Now(), etag: `"abc"`}
			b.mu.Unlock()
			w.WriteHeader(http.StatusOK)
		case http.MethodHead, http.MethodGet:
			b.mu.Lock()
			obj, ok := b.objects[key]
			b.mu.Unlock()
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("ETag", obj.etag)
			w.Header().Set("Last-Modified", obj.mtime.UTC().Format(time.RFC1123))
			w.Header().Set("Accept-Ranges", "bytes")
			if r.Method == http.MethodGet && r.Header.Get("Range") != "" {
				start, end, ok := parseTestRange(r.Header.Get("Range"), int64(len(obj.body)))
				if !ok {
					w.Header().Set("Content-Range", "bytes */"+strconv.Itoa(len(obj.body)))
					w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
					return
				}
				w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.Itoa(len(obj.body)))
				w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
				w.WriteHeader(http.StatusPartialContent)
				w.Write(obj.body[start : end+1])
				return
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(obj.body)))
			if r.Method == http.MethodHead {
				w.WriteHeader(http.StatusOK)
				return
			}
			w.Write(obj.body)
		case http.MethodDelete:
			b.mu.Lock()
			delete(b.objects, key)
			b.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
}

func parseTestRange(h string, size int64) (int64, int64, bool) {
	h = strings.TrimPrefix(h, "bytes=")
	parts := strings.Split(h, "-")
	if len(parts) != 2 || size <= 0 {
		return 0, 0, false
	}
	start := int64(0)
	end := size - 1
	if parts[0] != "" {
		n, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil || n < 0 || n >= size {
			return 0, 0, false
		}
		start = n
	}
	if parts[1] != "" {
		n, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || n < start {
			return 0, 0, false
		}
		if n < end {
			end = n
		}
	}
	return start, end, true
}

func (b *memBucket) list(w http.ResponseWriter, r *http.Request) {
	prefix := r.URL.Query().Get("prefix")
	delim := r.URL.Query().Get("delimiter")
	b.mu.Lock()
	defer b.mu.Unlock()
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>`)
	seen := map[string]bool{}
	for key, obj := range b.objects {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		rest := strings.TrimPrefix(key, prefix)
		if delim != "" {
			if i := strings.Index(rest, delim); i >= 0 {
				common := prefix + rest[:i+len(delim)]
				if !seen[common] {
					seen[common] = true
					sb.WriteString("<CommonPrefixes><Prefix>")
					xml.EscapeText(&sb, []byte(common))
					sb.WriteString("</Prefix></CommonPrefixes>")
				}
				continue
			}
		}
		sb.WriteString("<Contents><Key>")
		xml.EscapeText(&sb, []byte(key))
		sb.WriteString("</Key><Size>")
		sb.WriteString(strconv.Itoa(len(obj.body)))
		sb.WriteString("</Size><LastModified>")
		sb.WriteString(obj.mtime.UTC().Format(time.RFC3339))
		sb.WriteString("</LastModified></Contents>")
	}
	sb.WriteString("</ListBucketResult>")
	w.Header().Set("Content-Type", "application/xml")
	w.Write([]byte(sb.String()))
}

func TestWriteOnCloseRoundTrip(t *testing.T) {
	mem := newMemBucket()
	srv := httptest.NewServer(mem.handler("demo"))
	defer srv.Close()
	fs := NewObjectFS(NewClient(srv.URL, "demo"))
	ctx := context.Background()

	if err := fs.Mkdir(ctx, "dir", 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	f, err := fs.OpenFile(ctx, "dir/hello.txt", os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o644)
	if err != nil {
		t.Fatalf("open write: %v", err)
	}
	if _, err := f.Write([]byte("hello-fuse")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	st, err := fs.Stat(ctx, "dir/hello.txt")
	if err != nil || st.IsDir() || st.Size() != 10 {
		t.Fatalf("stat file: %#v %v", st, err)
	}
	dst, err := fs.OpenFile(ctx, "dir/hello.txt", os.O_RDONLY, 0)
	if err != nil {
		t.Fatalf("open read: %v", err)
	}
	body, err := io.ReadAll(dst)
	dst.Close()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(body) != "hello-fuse" {
		t.Fatalf("got %q", body)
	}

	dir, err := fs.OpenFile(ctx, "dir", os.O_RDONLY, 0)
	if err != nil {
		t.Fatalf("open dir: %v", err)
	}
	ents, err := dir.Readdir(0)
	dir.Close()
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(ents) != 1 || ents[0].Name() != "hello.txt" || ents[0].IsDir() {
		t.Fatalf("readdir: %+v", ents)
	}

	if err := fs.Rename(ctx, "dir/hello.txt", "dir/renamed.txt"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if err := fs.RemoveAll(ctx, "dir/renamed.txt"); err != nil {
		t.Fatalf("unlink: %v", err)
	}
	if _, err := fs.Stat(ctx, "dir/renamed.txt"); !os.IsNotExist(err) {
		t.Fatalf("expected missing after delete, got %v", err)
	}
	if err := fs.RemoveAll(ctx, "dir"); err != nil {
		t.Fatalf("rmdir: %v", err)
	}
}

func TestGetRangeClient(t *testing.T) {
	mem := newMemBucket()
	srv := httptest.NewServer(mem.handler("demo"))
	defer srv.Close()
	c := NewClient(srv.URL, "demo")
	if err := c.Put("x.bin", strings.NewReader("abcdefghij")); err != nil {
		t.Fatalf("put: %v", err)
	}
	got, _, err := c.GetRange("x.bin", 2, 5)
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	if string(got) != "cdef" {
		t.Fatalf("range got %q", got)
	}
}
