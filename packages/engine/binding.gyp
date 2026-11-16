{
  "targets": [
    {
      "target_name": "s3dfs_engine",
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
