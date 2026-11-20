# Thin C S3 HTTP gateway for s3dfs.
# Build:  make -C apps/s3-gateway
# Run:    S3DFS_INDEX_URLS=http://127.0.0.1:39100 S3DFS_S3_LISTEN=0.0.0.0:39102 \
#         S3DFS_COMPRESS=none S3DFS_DATA_REPLICAS=1 ./s3dfs-s3-gateway

UNAME := $(shell uname)
CC ?= clang
CFLAGS += -O2 -g -std=c11 -Wall -Wextra -Wshadow -pthread -Isrc -Ivendor
LDFLAGS += -lz -lpthread

ifeq ($(UNAME),Darwin)
  ZSTD_PREFIX ?= /opt/homebrew
  CFLAGS += -I$(ZSTD_PREFIX)/include
  LDFLAGS += -L$(ZSTD_PREFIX)/lib -lzstd
else
  LDFLAGS += -lzstd
endif

BIN := s3dfs-s3-gateway
SRC := src/main.c src/s3.c src/cluster.c src/http.c src/common.c vendor/picohttpparser.c
OBJ := $(SRC:.c=.o)

.PHONY: all clean

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(CFLAGS) -o $@ $(OBJ) $(LDFLAGS)

src/%.o: src/%.c src/common.h src/http.h src/cluster.h src/s3.h
	$(CC) $(CFLAGS) -c -o $@ $<

vendor/picohttpparser.o: vendor/picohttpparser.c vendor/picohttpparser.h
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(BIN) $(OBJ)
