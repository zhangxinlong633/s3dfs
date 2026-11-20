# s3dfs bucket mount. The filesystem and HTTP client are C.
# Linux without libfuse talks to /dev/fuse directly (src/fuse_raw.c).
# macOS uses macFUSE when its headers are installed, otherwise a local WebDAV server.

UNAME := $(shell uname)
CC ?= clang
CFLAGS += -O2 -g -std=c11 -Wall -Wextra -Wshadow -D_GNU_SOURCE -D_FILE_OFFSET_BITS=64 -pthread -Isrc
LDFLAGS += -lpthread

CORE := src/util.c src/s3client.c src/fs.c src/webdav.c src/main.c
FUSE_SRC :=

ifeq ($(UNAME),Darwin)
  ifneq ($(wildcard /usr/local/include/fuse/fuse.h),)
    CFLAGS += -DHAVE_LIBFUSE -D_DARWIN_C_SOURCE -I/usr/local/include/fuse
    LDFLAGS += -L/usr/local/lib -lfuse
    FUSE_SRC := src/fuse_ops.c
  else
    CFLAGS += -D_DARWIN_C_SOURCE
  endif
else
  PKG_FUSE := $(shell pkg-config --exists fuse && echo yes)
  ifeq ($(PKG_FUSE),yes)
    CFLAGS += -DHAVE_LIBFUSE $(shell pkg-config --cflags fuse)
    LDFLAGS += $(shell pkg-config --libs fuse)
    FUSE_SRC := src/fuse_ops.c
  else
    FUSE_SRC := src/fuse_raw.c
  endif
endif

BIN := s3dfs-fuse
TEST := s3dfs-fuse-test

.PHONY: all test clean

all: $(BIN)

$(BIN): $(CORE) $(FUSE_SRC)
	$(CC) $(CFLAGS) -o $@ $(CORE) $(FUSE_SRC) $(LDFLAGS)

$(TEST): src/test_fs.c src/util.c src/s3client.c src/fs.c
	$(CC) $(CFLAGS) -o $@ src/test_fs.c src/util.c src/s3client.c src/fs.c $(LDFLAGS)

test: $(TEST)
	./$(TEST)

clean:
	rm -f $(BIN) $(TEST) src/*.o
