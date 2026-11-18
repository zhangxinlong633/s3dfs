//go:build linux

package main

import (
	"context"
	"errors"
	"bytes"
	"fmt"
	"log"
	"io"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"
	"github.com/hanwen/go-fuse/v2/fuse/nodefs"
	"github.com/hanwen/go-fuse/v2/fuse/pathfs"
	"golang.org/x/net/webdav"
)

func mountWithFUSE(ctx context.Context, ofs *ObjectFS, mountpoint string) error {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		return errFuseUnavailable
	}

	debug := os.Getenv("S3DFS_FUSE_DEBUG") != ""
	pnfs := pathfs.NewPathNodeFs(newS3PathFs(ofs), &pathfs.PathNodeFsOptions{Debug: debug})
	conn := nodefs.NewFileSystemConnector(pnfs.Root(), &nodefs.Options{
		AttrTimeout:     time.Second,
		EntryTimeout:    time.Second,
		NegativeTimeout: time.Second,
		Debug:           debug,
	})
	server, err := fuse.NewServer(conn.RawFS(), mountpoint, &fuse.MountOptions{
		FsName:  "s3dfs:" + ofs.client.bucket,
		Name:    "s3dfs",
		Debug:   debug,
	})
	if err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "s3dfs-fuse: mounted %s at %s via FUSE (press Ctrl-C to unmount)\n", ofs.client.bucket, mountpoint)
	go server.Serve()
	if err := server.WaitMount(); err != nil {
		return err
	}

	<-ctx.Done()
	_ = unmount(mountpoint)
	_ = server.Unmount()
	server.Wait()
	return nil
}

type s3PathFs struct {
	pathfs.FileSystem
	inner *ObjectFS
}

func newS3PathFs(inner *ObjectFS) *s3PathFs {
	return &s3PathFs{FileSystem: pathfs.NewDefaultFileSystem(), inner: inner}
}

func (p *s3PathFs) GetAttr(name string, _ *fuse.Context) (*fuse.Attr, fuse.Status) {
	st, err := p.inner.Stat(context.Background(), name)
	if err != nil {
		return nil, toStatus(err)
	}
	return attrFromInfo(st), fuse.OK
}

func (p *s3PathFs) OpenDir(name string, _ *fuse.Context) ([]fuse.DirEntry, fuse.Status) {
	f, err := p.inner.OpenFile(context.Background(), name, os.O_RDONLY, 0)
	if err != nil {
		log.Printf("OpenDir %q open: %v", name, err)
		return nil, toStatus(err)
	}
	defer f.Close()
	infos, err := f.Readdir(-1)
	if err != nil && !errors.Is(err, io.EOF) {
		log.Printf("OpenDir %q readdir: %v", name, err)
		return nil, toStatus(err)
	}
	log.Printf("OpenDir %q entries=%d err=%v", name, len(infos), err)
	out := make([]fuse.DirEntry, 0, len(infos))
	for _, info := range infos {
		mode := uint32(fuse.S_IFREG)
		if info.IsDir() {
			mode = uint32(fuse.S_IFDIR)
		}
		out = append(out, fuse.DirEntry{Name: info.Name(), Mode: mode})
	}
	return out, fuse.OK
}

func (p *s3PathFs) Open(name string, flags uint32, _ *fuse.Context) (nodefs.File, fuse.Status) {
	f, err := p.inner.OpenFile(context.Background(), name, int(flags), 0o644)
	if err != nil {
		return nil, toStatus(err)
	}
	return newFuseFile(f), fuse.OK
}

func (p *s3PathFs) Create(name string, flags uint32, mode uint32, _ *fuse.Context) (nodefs.File, fuse.Status) {
	f, err := p.inner.OpenFile(context.Background(), name, int(flags)|os.O_CREATE, os.FileMode(mode)&os.ModePerm)
	if err != nil {
		log.Printf("Create %q flags=%#x mode=%#o: %v", name, flags, mode, err)
		return nil, toStatus(err)
	}
	log.Printf("Create %q flags=%#x mode=%#o ok", name, flags, mode)
	return newFuseFile(f), fuse.OK
}

func (p *s3PathFs) Mkdir(name string, _ uint32, _ *fuse.Context) fuse.Status {
	err := p.inner.Mkdir(context.Background(), name, 0o755)
	log.Printf("Mkdir %q: %v", name, err)
	return toStatus(err)
}

func (p *s3PathFs) Unlink(name string, _ *fuse.Context) fuse.Status {
	return toStatus(p.inner.RemoveAll(context.Background(), name))
}

func (p *s3PathFs) Rmdir(name string, _ *fuse.Context) fuse.Status {
	return toStatus(p.inner.RemoveAll(context.Background(), name))
}

func (p *s3PathFs) Rename(oldName string, newName string, _ *fuse.Context) fuse.Status {
	return toStatus(p.inner.Rename(context.Background(), oldName, newName))
}

func (p *s3PathFs) Access(name string, _ uint32, _ *fuse.Context) fuse.Status {
	_, err := p.inner.Stat(context.Background(), name)
	return toStatus(err)
}

func (p *s3PathFs) Truncate(name string, size uint64, _ *fuse.Context) fuse.Status {
	ctx := context.Background()
	if size == 0 {
		f, err := p.inner.OpenFile(ctx, name, os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return toStatus(err)
		}
		return toStatus(f.Close())
	}
	body, _, err := p.inner.client.Get(objectKey(name))
	if err != nil {
		return toStatus(err)
	}
	if body == nil {
		return fuse.ENOENT
	}
	if uint64(len(body)) > size {
		body = body[:size]
	} else if uint64(len(body)) < size {
		padded := make([]byte, size)
		copy(padded, body)
		body = padded
	}
	return toStatus(p.inner.client.Put(objectKey(name), bytes.NewReader(body)))
}

func (p *s3PathFs) Chmod(name string, _ uint32, _ *fuse.Context) fuse.Status {
	_, err := p.inner.Stat(context.Background(), name)
	return toStatus(err)
}

func (p *s3PathFs) Chown(name string, _ uint32, _ uint32, _ *fuse.Context) fuse.Status {
	_, err := p.inner.Stat(context.Background(), name)
	return toStatus(err)
}

func (p *s3PathFs) Utimens(name string, _ *time.Time, _ *time.Time, _ *fuse.Context) fuse.Status {
	_, err := p.inner.Stat(context.Background(), name)
	return toStatus(err)
}

type fuseFile struct {
	nodefs.File
	inner webdav.File
	mu    sync.Mutex
	closed bool
}

func newFuseFile(inner webdav.File) *fuseFile {
	return &fuseFile{File: nodefs.NewDefaultFile(), inner: inner}
}

func (f *fuseFile) GetAttr(out *fuse.Attr) fuse.Status {
	st, err := f.inner.Stat()
	if err != nil {
		return toStatus(err)
	}
	*out = *attrFromInfo(st)
	return fuse.OK
}

func (f *fuseFile) Read(dest []byte, off int64) (fuse.ReadResult, fuse.Status) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.inner.Seek(off, io.SeekStart); err != nil {
		return nil, toStatus(err)
	}
	n, err := f.inner.Read(dest)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, toStatus(err)
	}
	return fuse.ReadResultData(dest[:n]), fuse.OK
}

func (f *fuseFile) Write(data []byte, off int64) (uint32, fuse.Status) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.inner.Seek(off, io.SeekStart); err != nil {
		return 0, toStatus(err)
	}
	n, err := f.inner.Write(data)
	return uint32(n), toStatus(err)
}

func (f *fuseFile) Flush() fuse.Status { return fuse.OK }

func (f *fuseFile) Release() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		if err := f.inner.Close(); err != nil {
			log.Printf("Release close: %v", err)
		}
		f.closed = true
	}
}

func (f *fuseFile) Fsync(flags int) fuse.Status {
	_ = flags
	return fuse.OK
}

func attrFromInfo(st os.FileInfo) *fuse.Attr {
	if attr := fuse.ToAttr(st); attr != nil {
		return attr
	}
	mode := uint32(st.Mode().Perm())
	if st.IsDir() {
		mode |= uint32(syscall.S_IFDIR)
	} else {
		mode |= uint32(syscall.S_IFREG)
	}
	attr := &fuse.Attr{Size: uint64(st.Size()), Mode: mode, Nlink: 1}
	if st.IsDir() {
		attr.Nlink = 2
	}
	mt := st.ModTime()
	attr.SetTimes(&mt, &mt, &mt)
	if owner := fuse.CurrentOwner(); owner != nil {
		attr.Owner = *owner
	}
	return attr
}

func toStatus(err error) fuse.Status {
	if err == nil {
		return fuse.OK
	}
	if errors.Is(err, errNotDir) {
		return fuse.ENOTDIR
	}
	if errors.Is(err, errNotEmpty) {
		return fuse.Status(syscall.ENOTEMPTY)
	}
	if errors.Is(err, os.ErrExist) {
		return fuse.Status(syscall.EEXIST)
	}
	if errors.Is(err, os.ErrNotExist) {
		return fuse.ENOENT
	}
	if errors.Is(err, os.ErrPermission) {
		return fuse.EACCES
	}
	if errors.Is(err, os.ErrInvalid) {
		return fuse.EINVAL
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return fuse.Status(errno)
	}
	return fuse.ToStatus(err)
}
