//go:build !linux

package main

import "context"

func mountWithFUSE(context.Context, *ObjectFS, string) error {
	return errFuseUnavailable
}
