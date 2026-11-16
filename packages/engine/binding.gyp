{
  "targets": [
    {
      "target_name": "leveldb",
      "type": "static_library",
      "sources": [
        "third_party/leveldb/db/builder.cc",
        "third_party/leveldb/db/c.cc",
        "third_party/leveldb/db/db_impl.cc",
        "third_party/leveldb/db/db_iter.cc",
        "third_party/leveldb/db/dbformat.cc",
        "third_party/leveldb/db/dumpfile.cc",
        "third_party/leveldb/db/filename.cc",
        "third_party/leveldb/db/log_reader.cc",
        "third_party/leveldb/db/log_writer.cc",
        "third_party/leveldb/db/memtable.cc",
        "third_party/leveldb/db/repair.cc",
        "third_party/leveldb/db/table_cache.cc",
        "third_party/leveldb/db/version_edit.cc",
        "third_party/leveldb/db/version_set.cc",
        "third_party/leveldb/db/write_batch.cc",
        "third_party/leveldb/table/block.cc",
        "third_party/leveldb/table/block_builder.cc",
        "third_party/leveldb/table/filter_block.cc",
        "third_party/leveldb/table/format.cc",
        "third_party/leveldb/table/iterator.cc",
        "third_party/leveldb/table/merger.cc",
        "third_party/leveldb/table/table.cc",
        "third_party/leveldb/table/table_builder.cc",
        "third_party/leveldb/table/two_level_iterator.cc",
        "third_party/leveldb/util/arena.cc",
        "third_party/leveldb/util/bloom.cc",
        "third_party/leveldb/util/cache.cc",
        "third_party/leveldb/util/coding.cc",
        "third_party/leveldb/util/comparator.cc",
        "third_party/leveldb/util/crc32c.cc",
        "third_party/leveldb/util/env.cc",
        "third_party/leveldb/util/env_posix.cc",
        "third_party/leveldb/util/filter_policy.cc",
        "third_party/leveldb/util/hash.cc",
        "third_party/leveldb/util/histogram.cc",
        "third_party/leveldb/util/logging.cc",
        "third_party/leveldb/util/options.cc",
        "third_party/leveldb/util/status.cc"
      ],
      "include_dirs": [
        "third_party/leveldb",
        "third_party/leveldb/include"
      ],
      "defines": [
        "LEVELDB_PLATFORM_POSIX=1"
      ],
      "direct_dependent_settings": {
        "include_dirs": [
          "third_party/leveldb/include"
        ]
      },
      "cflags": ["-O2", "-fPIC"],
      "cflags_cc": ["-O2", "-fPIC", "-std=c++17"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CFLAGS": ["-O2"]
      }
    },
    {
      "target_name": "s3dfs_engine",
      "dependencies": ["leveldb"],
      "sources": [
        "native/engine.c",
        "native/binding.cpp"
      ],
      "include_dirs": [
        "native",
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NAPI_VERSION=9"
      ],
      "cflags": ["-O2", "-Wall"],
      "cflags_c": ["-std=c11"],
      "cflags_cc": ["-std=c++17"],
      "libraries": ["-lpthread"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_C_LANGUAGE_STANDARD": "c11",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CFLAGS": ["-O2", "-Wall"]
      },
      "conditions": [
        ["OS=='linux'", {
          "cflags": ["-fPIC"],
          "cflags_cc": ["-fPIC"]
        }]
      ]
    }
  ]
}
