{
  "targets": [
    {
      "target_name": "s3dfs_engine",
      "sources": [
        "native/engine.c",
        "native/engine_lane.c",
        "native/http.c",
        "native/stage.c",
        "native/binding.c"
      ],
      "include_dirs": [
        "native"
      ],
      "defines": [
        "NAPI_VERSION=9"
      ],
      "cflags": ["-Wall", "-fPIC"],
      "cflags_c": ["-std=c11"],
      "libraries": ["-lpthread"],
      "conditions": [
        ["OS=='linux'", { "libraries": ["-lcrypto"] }]
      ],
      "xcode_settings": {
        "GCC_C_LANGUAGE_STANDARD": "c11",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CFLAGS": ["-Wall"]
      }
    }
  ]
}
