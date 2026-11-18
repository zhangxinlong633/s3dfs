package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	endpoint := flag.String("endpoint", "http://127.0.0.1:9000", "s3dfs S3 API address")
	bucket := flag.String("bucket", "", "bucket to mount")
	listen := flag.String("listen", "127.0.0.1:0", "local WebDAV listen address (used when FUSE is unavailable)")
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: s3dfs-fuse --endpoint http://127.0.0.1:9000 --bucket mybucket MOUNTPOINT\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *bucket == "" || flag.NArg() != 1 {
		flag.Usage()
		os.Exit(2)
	}
	mountpoint := flag.Arg(0)
	if st, err := os.Stat(mountpoint); err != nil {
		fmt.Fprintf(os.Stderr, "s3dfs-fuse: mountpoint: %v\n", err)
		os.Exit(1)
	} else if !st.IsDir() {
		fmt.Fprintf(os.Stderr, "s3dfs-fuse: mountpoint is not a directory: %s\n", mountpoint)
		os.Exit(1)
	}

	fs := NewObjectFS(NewClient(*endpoint, *bucket))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := mount(ctx, fs, mountpoint, *listen); err != nil {
		fmt.Fprintf(os.Stderr, "s3dfs-fuse: %v\n", err)
		os.Exit(1)
	}
}
