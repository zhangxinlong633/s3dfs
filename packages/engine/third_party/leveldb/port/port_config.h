#ifndef STORAGE_LEVELDB_PORT_PORT_CONFIG_H_
#define STORAGE_LEVELDB_PORT_PORT_CONFIG_H_

#if defined(__APPLE__)
#define HAVE_FDATASYNC 0
#define HAVE_FULLFSYNC 1
#else
#define HAVE_FDATASYNC 1
#define HAVE_FULLFSYNC 0
#endif

#define HAVE_O_CLOEXEC 1
#define HAVE_CRC32C 0
#define HAVE_SNAPPY 0

#if defined(__BYTE_ORDER__) && defined(__ORDER_BIG_ENDIAN__) && \
    __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#define LEVELDB_IS_BIG_ENDIAN 1
#else
#define LEVELDB_IS_BIG_ENDIAN 0
#endif

#endif
