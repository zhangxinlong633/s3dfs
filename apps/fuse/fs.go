package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/webdav"
)

var errNotDir = errors.New("not a directory")
var errNotEmpty = errors.New("directory not empty")

// ObjectFS maps POSIX-like operations onto one s3dfs bucket.
// Writes are held in a local temp file and uploaded on close (write-on-close).
type ObjectFS struct {
	client *Client
	mu     sync.Mutex
	open   map[string]*openNode
}

func NewObjectFS(client *Client) *ObjectFS {
	return &ObjectFS{client: client, open: make(map[string]*openNode)}
}

func objectKey(name string) string {
	name = strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(name, "\\", "/")), "/")
	if name == "." {
		return ""
	}
	return name
}

func isDirMarker(key string) bool {
	return key == "" || strings.HasSuffix(key, "/")
}

func (f *ObjectFS) Mkdir(_ context.Context, name string, _ os.FileMode) error {
	key := objectKey(name)
	if key == "" {
		return os.ErrExist
	}
	st, err := f.stat(key)
	if err == nil {
		if st.IsDir() {
			return os.ErrExist
		}
		return os.ErrExist
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return f.client.Put(strings.TrimSuffix(key, "/")+"/", strings.NewReader(""))
}

func (f *ObjectFS) RemoveAll(_ context.Context, name string) error {
	key := objectKey(name)
	if key == "" {
		return os.ErrInvalid
	}
	st, err := f.stat(key)
	if errors.Is(err, os.ErrNotExist) {
		return os.ErrNotExist
	}
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return f.client.Delete(key)
	}
	prefix := strings.TrimSuffix(key, "/") + "/"
	listed, err := f.client.List(prefix, "/", "", 16)
	if err != nil {
		return err
	}
	children := 0
	for _, o := range listed.Objects {
		if o.Key == prefix {
			continue
		}
		children++
	}
	children += len(listed.Prefixes)
	if children > 0 {
		return errNotEmpty
	}
	return f.client.Delete(prefix)
}

func (f *ObjectFS) Rename(_ context.Context, oldName, newName string) error {
	src := objectKey(oldName)
	dst := objectKey(newName)
	if src == "" || dst == "" {
		return os.ErrInvalid
	}
	st, err := f.stat(src)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return errors.New("directory rename is not supported in this version")
	}
	body, _, err := f.client.Get(src)
	if err != nil {
		return err
	}
	if body == nil {
		return os.ErrNotExist
	}
	if err := f.client.Put(dst, bytes.NewReader(body)); err != nil {
		return err
	}
	return f.client.Delete(src)
}

func (f *ObjectFS) Stat(_ context.Context, name string) (os.FileInfo, error) {
	return f.stat(objectKey(name))
}

func (f *ObjectFS) stat(key string) (os.FileInfo, error) {
	// Write-on-close: a file may exist only as an open temp until Close.
	// FUSE Create does GetAttr by path before the object is uploaded.
	lookup := strings.TrimSuffix(key, "/")
	f.mu.Lock()
	opened := f.open[lookup]
	f.mu.Unlock()
	if opened != nil && !opened.dir {
		return opened.Stat()
	}

	if key == "" {
		return &nodeInfo{name: f.client.bucket, dir: true, mode: 0o755, mtime: time.Now()}, nil
	}
	fileKey := strings.TrimSuffix(key, "/")
	if !strings.HasSuffix(key, "/") {
		h, err := f.client.Head(fileKey)
		if err != nil {
			return nil, err
		}
		if h != nil {
			mtime := h.ModTime
			if mtime.IsZero() {
				mtime = time.Now()
			}
			return &nodeInfo{name: path.Base(fileKey), size: h.Size, mode: 0o644, mtime: mtime, dir: false}, nil
		}
	}
	prefix := strings.TrimSuffix(key, "/") + "/"
	if h, err := f.client.Head(prefix); err != nil {
		return nil, err
	} else if h != nil {
		mtime := h.ModTime
		if mtime.IsZero() {
			mtime = time.Now()
		}
		return &nodeInfo{name: path.Base(strings.TrimSuffix(key, "/")), dir: true, mode: 0o755, mtime: mtime}, nil
	}
	listed, err := f.client.List(prefix, "/", "", 1)
	if err != nil {
		return nil, err
	}
	if len(listed.Objects) == 0 && len(listed.Prefixes) == 0 {
		return nil, os.ErrNotExist
	}
	return &nodeInfo{name: path.Base(strings.TrimSuffix(key, "/")), dir: true, mode: 0o755, mtime: time.Now()}, nil
}

func (f *ObjectFS) OpenFile(ctx context.Context, name string, flag int, perm os.FileMode) (webdav.File, error) {
	key := objectKey(name)
	write := flag&(os.O_WRONLY|os.O_RDWR|os.O_APPEND|os.O_CREATE|os.O_TRUNC) != 0
	if isDirMarker(key) || strings.HasSuffix(name, "/") {
		if flag&(os.O_WRONLY|os.O_RDWR) != 0 && flag&os.O_CREATE == 0 {
			return nil, os.ErrInvalid
		}
		if key == "" {
			st, err := f.stat("")
			if err != nil {
				return nil, err
			}
			return &openNode{fs: f, key: "", dir: true, info: st}, nil
		}
		if st, err := f.stat(key); err == nil && st.IsDir() {
			return &openNode{fs: f, key: strings.TrimSuffix(key, "/") + "/", dir: true, info: st}, nil
		}
		return nil, os.ErrNotExist
	}

	st, err := f.stat(key)
	exists := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if exists && st.IsDir() {
		if flag&(os.O_WRONLY|os.O_RDWR) != 0 {
			return nil, os.ErrInvalid
		}
		return &openNode{fs: f, key: strings.TrimSuffix(key, "/") + "/", dir: true, info: st}, nil
	}
	if !exists && flag&os.O_CREATE == 0 {
		return nil, os.ErrNotExist
	}

	node := &openNode{fs: f, key: key, flag: flag, perm: perm}
	tmp, err := os.CreateTemp("", "s3dfs-fuse-*")
	if err != nil {
		return nil, err
	}
	node.tmp = tmp

	if exists && flag&os.O_TRUNC == 0 {
		body, h, gerr := f.client.Get(key)
		if gerr != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			return nil, gerr
		}
		if body != nil {
			if _, err := tmp.Write(body); err != nil {
				tmp.Close()
				os.Remove(tmp.Name())
				return nil, err
			}
			if flag&os.O_APPEND == 0 {
				if _, err := tmp.Seek(0, io.SeekStart); err != nil {
					tmp.Close()
					os.Remove(tmp.Name())
					return nil, err
				}
			}
			if h != nil {
				node.info = &nodeInfo{name: path.Base(key), size: int64(len(body)), mode: 0o644, mtime: h.ModTime}
			}
		}
	}
	if !exists || flag&os.O_TRUNC != 0 || write && !exists {
		node.dirty = flag&os.O_CREATE != 0 && !exists || flag&os.O_TRUNC != 0
	}
	if !exists && flag&os.O_CREATE != 0 {
		// Create an empty object only after close; keep dirty so close uploads.
		node.dirty = true
	}
	_ = ctx
	if !node.dir {
		f.mu.Lock()
		f.open[key] = node
		f.mu.Unlock()
	}
	return node, nil
}

type openNode struct {
	fs    *ObjectFS
	key   string
	dir   bool
	flag  int
	perm  os.FileMode
	info  os.FileInfo
	tmp   *os.File
	dirty bool
	mu    sync.Mutex
	dirOff int
	dirents []os.FileInfo
}

func (n *openNode) Close() error {
	n.mu.Lock()
	var err error
	if n.tmp != nil && n.dirty && !n.dir {
		if _, seekErr := n.tmp.Seek(0, io.SeekStart); seekErr != nil {
			err = seekErr
		} else if putErr := n.fs.client.Put(n.key, n.tmp); putErr != nil {
			err = putErr
		}
	}
	if n.tmp != nil {
		name := n.tmp.Name()
		cerr := n.tmp.Close()
		os.Remove(name)
		n.tmp = nil
		if err == nil {
			err = cerr
		}
	}
	n.mu.Unlock()
	if !n.dir {
		n.fs.mu.Lock()
		if n.fs.open[n.key] == n {
			delete(n.fs.open, n.key)
		}
		n.fs.mu.Unlock()
	}
	return err
}

func (n *openNode) Read(p []byte) (int, error) {
	if n.dir {
		return 0, errNotDir
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.tmp.Read(p)
}

func (n *openNode) Write(p []byte) (int, error) {
	if n.dir {
		return 0, errNotDir
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	w, err := n.tmp.Write(p)
	if w > 0 {
		n.dirty = true
	}
	return w, err
}

func (n *openNode) Seek(offset int64, whence int) (int64, error) {
	if n.dir {
		return 0, errNotDir
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.tmp.Seek(offset, whence)
}

func (n *openNode) Stat() (os.FileInfo, error) {
	if n.dir {
		if n.info != nil {
			return n.info, nil
		}
		return n.fs.stat(n.key)
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.tmp != nil {
		st, err := n.tmp.Stat()
		if err != nil {
			return nil, err
		}
		return &nodeInfo{name: path.Base(n.key), size: st.Size(), mode: 0o644, mtime: st.ModTime()}, nil
	}
	if n.info != nil {
		return n.info, nil
	}
	return &nodeInfo{name: path.Base(n.key), size: 0, mode: 0o644, mtime: time.Now()}, nil
}

func (n *openNode) Readdir(count int) ([]os.FileInfo, error) {
	if !n.dir {
		return nil, errNotDir
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.dirents == nil {
		ents, err := n.fs.readDir(n.key)
		if err != nil {
			return nil, err
		}
		n.dirents = ents
		n.dirOff = 0
	}
	if n.dirOff >= len(n.dirents) {
		if count > 0 {
			return nil, io.EOF
		}
		return []os.FileInfo{}, nil
	}
	if count <= 0 {
		out := n.dirents[n.dirOff:]
		n.dirOff = len(n.dirents)
		return out, nil
	}
	end := n.dirOff + count
	if end > len(n.dirents) {
		end = len(n.dirents)
	}
	out := n.dirents[n.dirOff:end]
	n.dirOff = end
	if n.dirOff >= len(n.dirents) && len(out) == 0 {
		return nil, io.EOF
	}
	return out, nil
}

func (f *ObjectFS) readDir(key string) ([]os.FileInfo, error) {
	prefix := key
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	var ents []os.FileInfo
	startAfter := ""
	for {
		listed, err := f.client.List(prefix, "/", startAfter, 1000)
		if err != nil {
			return nil, err
		}
		for _, pfx := range listed.Prefixes {
			name := strings.TrimSuffix(strings.TrimPrefix(pfx, prefix), "/")
			if name == "" {
				continue
			}
			ents = append(ents, &nodeInfo{name: name, dir: true, mode: 0o755, mtime: time.Now()})
		}
		for _, o := range listed.Objects {
			rel := strings.TrimPrefix(o.Key, prefix)
			if rel == "" {
				continue
			}
			ents = append(ents, &nodeInfo{name: rel, size: o.Size, mode: 0o644, mtime: o.ModTime})
		}
		if !listed.Truncated || listed.NextToken == "" {
			break
		}
		startAfter = listed.NextToken
	}
	return ents, nil
}

type nodeInfo struct {
	name  string
	size  int64
	mode  os.FileMode
	mtime time.Time
	dir   bool
}

func (i *nodeInfo) Name() string { return i.name }
func (i *nodeInfo) Size() int64  { return i.size }
func (i *nodeInfo) Mode() os.FileMode {
	if i.dir {
		return os.ModeDir | i.mode
	}
	return i.mode
}
func (i *nodeInfo) ModTime() time.Time { return i.mtime }
func (i *nodeInfo) IsDir() bool        { return i.dir }
func (i *nodeInfo) Sys() any           { return nil }
