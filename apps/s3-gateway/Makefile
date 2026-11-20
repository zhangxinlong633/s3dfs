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
  LDFLAGS += -lzstd -lcrypto
endif

BIN := s3dfs-s3-gateway
SRC := src/main.c src/s3.c src/sigv4.c src/cluster.c src/http.c src/common.c vendor/picohttpparser.c
OBJ := $(SRC:.c=.o)

.PHONY: all clean test

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(CFLAGS) -o $@ $(OBJ) $(LDFLAGS)

src/%.o: src/%.c src/common.h src/http.h src/cluster.h src/s3.h
	$(CC) $(CFLAGS) -c -o $@ $<

vendor/picohttpparser.o: vendor/picohttpparser.c vendor/picohttpparser.h
	$(CC) $(CFLAGS) -c -o $@ $<

src/sigv4_test: src/sigv4_test.c src/sigv4.c src/http.c src/common.c vendor/picohttpparser.o
	$(CC) $(CFLAGS) -o $@ src/sigv4_test.c src/sigv4.c src/http.c src/common.c vendor/picohttpparser.o $(LDFLAGS)

test: src/sigv4_test
	@c_sig=$$(./src/sigv4_test sign); \
	ts_sig=$$(cd ../.. && bun -e 'import { signRequest } from "./apps/api/src/s3/sigv4.ts"; const headers = { host: "127.0.0.1:9000", "x-amz-date": "20261120T120000Z", "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", authorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261120/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=00" }; const req = { method: "GET", path: "/logs/a.txt", query: new URLSearchParams(), headers, body: Buffer.alloc(0) }; process.stdout.write(signRequest("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", req, "20261120T120000Z", "20261120/us-east-1/s3/aws4_request"));'); \
	if [ "$$c_sig" != "$$ts_sig" ]; then echo "sigv4 mismatch c=$$c_sig ts=$$ts_sig"; exit 1; fi; \
	./src/sigv4_test check

clean:
	rm -f $(BIN) $(OBJ) src/sigv4_test
