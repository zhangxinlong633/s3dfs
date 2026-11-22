{
  "targets": [
    {
      "target_name": "s3dfs_engine",
      "sources": [
        "native/engine.c",
        "native/engine_lane.c",
        "native/http.c",
        "native/binding.c"
      ],
      "include_dirs": [
        "native"
      ],
      "defines": [
        "NAPI_VERSION=9"
      ],
      "cflags": ["-O2", "-Wall", "-fPIC"],
      "cflags_c": ["-std=c11"],
      "libraries": ["-lpthread"],
      "xcode_settings": {
        "GCC_C_LANGUAGE_STANDARD": "c11",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CFLAGS": ["-O2", "-Wall"]
      }
    }
  ]
}
