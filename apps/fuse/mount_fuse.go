package main

import "errors"

// errFuseUnavailable means this build or machine has no FUSE kernel interface.
// The process then falls back to a local WebDAV server plus the system mount helper.
var errFuseUnavailable = errors.New("fuse unavailable")
