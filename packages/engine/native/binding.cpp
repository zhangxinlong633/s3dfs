#include <napi.h>
#include <string>
#include <vector>

extern "C" {
#include "s3dfs.h"
}

static Napi::Error ErrFrom(Napi::Env env, int rc)
{
    const char *msg = "s3dfs error";
    switch (rc) {
    case S3DFS_ERR_NOT_FOUND:
        msg = "not found";
        break;
    case S3DFS_ERR_IO:
        msg = "io error";
        break;
    case S3DFS_ERR_ARGS:
        msg = "invalid argument";
        break;
    case S3DFS_ERR_NOMEM:
        msg = "out of memory";
        break;
    default:
        break;
    }
    return Napi::Error::New(env, msg);
}

class Store : public Napi::ObjectWrap<Store> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports)
    {
        Napi::Function fn = DefineClass(env, "Store", {
            InstanceMethod("put", &Store::Put),
            InstanceMethod("putBatch", &Store::PutBatch),
            InstanceMethod("get", &Store::Get),
            InstanceMethod("head", &Store::Head),
            InstanceMethod("delete", &Store::Delete),
            InstanceMethod("list", &Store::List),
            InstanceMethod("flush", &Store::Flush),
            InstanceMethod("compact", &Store::Compact),
            InstanceMethod("stats", &Store::Stats),
            InstanceMethod("close", &Store::Close),
        });
        exports.Set("Store", fn);
        return exports;
    }

    Store(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Store>(info)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "dataDir required").ThrowAsJavaScriptException();
            return;
        }
        std::string dir = info[0].As<Napi::String>().Utf8Value();
        s3dfs_options opt{};
        opt.fsync_on_flush = 1;
        if (info.Length() >= 2 && info[1].IsObject()) {
            Napi::Object o = info[1].As<Napi::Object>();
            if (o.Has("blockSize") && o.Get("blockSize").IsNumber()) {
                opt.block_size = o.Get("blockSize").As<Napi::Number>().Int64Value();
            }
            if (o.Has("bufferSize") && o.Get("bufferSize").IsNumber()) {
                opt.buffer_size = o.Get("bufferSize").As<Napi::Number>().Uint32Value();
            }
            if (o.Has("fsyncOnFlush") && o.Get("fsyncOnFlush").IsBoolean()) {
                opt.fsync_on_flush = o.Get("fsyncOnFlush").As<Napi::Boolean>().Value() ? 1 : 0;
            }
        }
        store_ = s3dfs_open(dir.c_str(), &opt);
        if (!store_) {
            Napi::Error::New(env, "failed to open s3dfs store").ThrowAsJavaScriptException();
        }
    }

    ~Store() override
    {
        if (store_) {
            s3dfs_close(store_);
            store_ = nullptr;
        }
    }

private:
    s3dfs_store *store_ = nullptr;

    Napi::Value Put(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (!store_ || info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
            Napi::TypeError::New(env, "put(key, buffer)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        auto buf = info[1].As<Napi::Buffer<uint8_t>>();
        int rc = s3dfs_put(store_, key.data(), (uint32_t)key.size(), buf.Data(), (uint32_t)buf.Length());
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value PutBatch(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (!store_ || info.Length() < 1 || !info[0].IsArray()) {
            Napi::TypeError::New(env, "putBatch([{key, value}])").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        Napi::Array arr = info[0].As<Napi::Array>();
        uint32_t n = arr.Length();
        std::vector<std::string> keys(n);
        std::vector<s3dfs_put_item> items(n);
        for (uint32_t i = 0; i < n; i++) {
            Napi::Value v = arr.Get(i);
            if (!v.IsObject()) {
                Napi::TypeError::New(env, "batch item must be object").ThrowAsJavaScriptException();
                return env.Undefined();
            }
            Napi::Object o = v.As<Napi::Object>();
            keys[i] = o.Get("key").As<Napi::String>().Utf8Value();
            auto buf = o.Get("value").As<Napi::Buffer<uint8_t>>();
            items[i].key = keys[i].data();
            items[i].key_len = (uint32_t)keys[i].size();
            items[i].value = buf.Data();
            items[i].value_len = (uint32_t)buf.Length();
        }
        int rc = s3dfs_put_batch(store_, items.data(), n);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value Get(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (!store_ || info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "get(key)").ThrowAsJavaScriptException();
            return env.Null();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        void *data = nullptr;
        uint32_t len = 0, crc = 0;
        uint64_t mtime = 0;
        int rc = s3dfs_get(store_, key.data(), (uint32_t)key.size(), &data, &len, &crc, &mtime);
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return env.Null();
        }
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Null();
        }
        Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::Copy(env, (uint8_t *)data, len);
        s3dfs_free(data);
        Napi::Object o = Napi::Object::New(env);
        o.Set("value", buf);
        o.Set("crc", Napi::Number::New(env, crc));
        o.Set("mtimeMs", Napi::Number::New(env, (double)mtime));
        o.Set("size", Napi::Number::New(env, len));
        return o;
    }

    Napi::Value Head(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (!store_ || info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "head(key)").ThrowAsJavaScriptException();
            return env.Null();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        uint32_t size = 0, crc = 0;
        uint64_t mtime = 0;
        int rc = s3dfs_head(store_, key.data(), (uint32_t)key.size(), &size, &crc, &mtime);
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return env.Null();
        }
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Null();
        }
        Napi::Object o = Napi::Object::New(env);
        o.Set("size", Napi::Number::New(env, size));
        o.Set("crc", Napi::Number::New(env, crc));
        o.Set("mtimeMs", Napi::Number::New(env, (double)mtime));
        return o;
    }

    Napi::Value Delete(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (!store_ || info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "delete(key)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        int rc = s3dfs_delete(store_, key.data(), (uint32_t)key.size());
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return Napi::Boolean::New(env, false);
        }
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        return Napi::Boolean::New(env, true);
    }

    Napi::Value List(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (!store_) {
            return env.Undefined();
        }
        std::string prefix, startAfter;
        uint32_t maxKeys = 1000;
        if (info.Length() >= 1 && info[0].IsObject()) {
            Napi::Object o = info[0].As<Napi::Object>();
            if (o.Has("prefix") && o.Get("prefix").IsString()) {
                prefix = o.Get("prefix").As<Napi::String>().Utf8Value();
            }
            if (o.Has("startAfter") && o.Get("startAfter").IsString()) {
                startAfter = o.Get("startAfter").As<Napi::String>().Utf8Value();
            }
            if (o.Has("maxKeys") && o.Get("maxKeys").IsNumber()) {
                maxKeys = o.Get("maxKeys").As<Napi::Number>().Uint32Value();
            }
        }
        if (maxKeys == 0 || maxKeys > 10000) {
            maxKeys = 1000;
        }
        std::vector<s3dfs_object_info> items(maxKeys);
        uint32_t n = 0;
        int truncated = 0;
        int rc = s3dfs_list(store_, prefix.empty() ? nullptr : prefix.data(),
                            (uint32_t)prefix.size(), startAfter.empty() ? nullptr : startAfter.data(),
                            (uint32_t)startAfter.size(), maxKeys, items.data(), &n, &truncated);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        Napi::Array arr = Napi::Array::New(env, n);
        for (uint32_t i = 0; i < n; i++) {
            Napi::Object o = Napi::Object::New(env);
            o.Set("key", Napi::String::New(env, items[i].key, items[i].key_len));
            o.Set("size", Napi::Number::New(env, items[i].size));
            o.Set("crc", Napi::Number::New(env, items[i].crc));
            o.Set("mtimeMs", Napi::Number::New(env, (double)items[i].mtime_ms));
            arr.Set(i, o);
        }
        Napi::Object out = Napi::Object::New(env);
        out.Set("objects", arr);
        out.Set("truncated", Napi::Boolean::New(env, truncated != 0));
        return out;
    }

    Napi::Value Flush(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (!store_) {
            return env.Undefined();
        }
        int rc = s3dfs_flush(store_);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value Compact(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (!store_) {
            return env.Undefined();
        }
        int rc = s3dfs_compact(store_);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value Stats(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        s3dfs_stats st{};
        if (store_) {
            s3dfs_get_stats(store_, &st);
        }
        Napi::Object o = Napi::Object::New(env);
        o.Set("objects", Napi::Number::New(env, (double)st.objects));
        o.Set("deleted", Napi::Number::New(env, (double)st.deleted));
        o.Set("bytesLogical", Napi::Number::New(env, (double)st.bytes_logical));
        o.Set("bytesOnDisk", Napi::Number::New(env, (double)st.bytes_on_disk));
        o.Set("blockFiles", Napi::Number::New(env, (double)st.block_files));
        o.Set("puts", Napi::Number::New(env, (double)st.puts));
        o.Set("gets", Napi::Number::New(env, (double)st.gets));
        o.Set("deletes", Napi::Number::New(env, (double)st.deletes));
        o.Set("flushes", Napi::Number::New(env, (double)st.flushes));
        o.Set("fsyncs", Napi::Number::New(env, (double)st.fsyncs));
        o.Set("indexSlots", Napi::Number::New(env, (double)st.index_slots));
        return o;
    }

    Napi::Value Close(const Napi::CallbackInfo &info)
    {
        if (store_) {
            s3dfs_close(store_);
            store_ = nullptr;
        }
        return info.Env().Undefined();
    }
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports)
{
    return Store::Init(env, exports);
}

NODE_API_MODULE(s3dfs_engine, InitAll)
