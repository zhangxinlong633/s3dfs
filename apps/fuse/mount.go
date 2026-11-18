package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"

	"golang.org/x/net/webdav"
)

func mount(ctx context.Context, fs *ObjectFS, mountpoint, listen string) error {
	if err := mountWithFUSE(ctx, fs, mountpoint); err == nil {
		return nil
	} else if err != errFuseUnavailable {
		return err
	}

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	handler := &webdav.Handler{
		Prefix:     "/",
		FileSystem: fs,
		LockSystem: webdav.NewMemLS(),
	}
	server := &http.Server{Handler: handler}
	errCh := make(chan error, 1)
	go func() {
		errCh <- server.Serve(ln)
	}()

	url := "http://" + ln.Addr().String() + "/"
	fmt.Fprintf(os.Stderr, "s3dfs-fuse: FUSE is not available on this machine; mounting via local WebDAV at %s\n", url)
	if err := mountWebDAV(url, mountpoint); err != nil {
		server.Close()
		ln.Close()
		return err
	}
	fmt.Fprintf(os.Stderr, "s3dfs-fuse: mounted %s at %s (press Ctrl-C to unmount)\n", fs.client.bucket, mountpoint)

	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-errCh:
	}
	_ = unmount(mountpoint)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	if serveErr != nil && serveErr != http.ErrServerClosed {
		return serveErr
	}
	return nil
}

func mountWebDAV(url, mountpoint string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("no FUSE device found; on Linux install libfuse3, or point a WebDAV client at %s", url)
	}
	cmd := exec.Command("mount_webdav", url, mountpoint)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("mount_webdav %s %s: %w\n%s", url, mountpoint, err, out)
	}
	return nil
}

func unmount(mountpoint string) error {
	cmds := []*exec.Cmd{exec.Command("umount", mountpoint)}
	if runtime.GOOS == "linux" {
		cmds = []*exec.Cmd{
			exec.Command("fusermount", "-u", mountpoint),
			exec.Command("umount", mountpoint),
		}
	}
	var last error
	for _, cmd := range cmds {
		out, err := cmd.CombinedOutput()
		if err == nil {
			return nil
		}
		last = fmt.Errorf("%s: %w\n%s", cmd.Path, err, out)
	}
	return fmt.Errorf("umount %s: %w", mountpoint, last)
}
