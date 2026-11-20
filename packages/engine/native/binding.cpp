#include <napi.h>
#include <cstring>
#include <string>
#include <vector>

#include "s3dfs.h"

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

static const char *CompressName(uint8_t t)
{
    if (t == 1) {
        return "zstd";
    }
    if (t == 2) {
        return "gzip";
    }
    return "none";
}

static uint8_t CompressCode(const std::string &name)
{
    if (name == "zstd") {
        return 1;
    }
    if (name == "gzip") {
        return 2;
    }
    return 0;
}

static Napi::Object LocToJs(Napi::Env env, const s3dfs_locator &loc)
{
    Napi::Object o = Napi::Object::New(env);
    o.Set("chained", Napi::Boolean::New(env, loc.chained != 0));
    o.Set("tombstone", Napi::Boolean::New(env, loc.tombstone != 0));
    o.Set("crc", Napi::Number::New(env, loc.crc));
    o.Set("mtimeMs", Napi::Number::New(env, (double)loc.mtime_ms));
    o.Set("size", Napi::Number::New(env, (double)loc.size));
    o.Set("generation", Napi::Number::New(env, (double)loc.generation));
    o.Set("extentCount", Napi::Number::New(env, loc.extent_count));
    o.Set("recId", Napi::Number::New(env, (double)loc.rec_id));
    o.Set("compressType", Napi::String::New(env, CompressName(loc.compress_type)));
    o.Set("origSize", Napi::Number::New(env, (double)loc.orig_size));
    o.Set("origCrc", Napi::Number::New(env, loc.orig_crc));
    return o;
}

static bool LocFromJs(Napi::Value value, s3dfs_locator *out)
{
    if (!value.IsObject()) {
        return false;
    }
    Napi::Object o = value.As<Napi::Object>();
    memset(out, 0, sizeof(*out));
    if (o.Has("chained")) {
        out->chained = o.Get("chained").ToBoolean().Value() ? 1 : 0;
    }
    if (o.Has("tombstone")) {
        out->tombstone = o.Get("tombstone").ToBoolean().Value() ? 1 : 0;
    }
    if (o.Has("crc") && o.Get("crc").IsNumber()) {
        out->crc = o.Get("crc").As<Napi::Number>().Uint32Value();
    }
    if (o.Has("mtimeMs") && o.Get("mtimeMs").IsNumber()) {
        out->mtime_ms = (uint64_t)o.Get("mtimeMs").As<Napi::Number>().Int64Value();
    }
    if (o.Has("size") && o.Get("size").IsNumber()) {
        out->size = (uint64_t)o.Get("size").As<Napi::Number>().Int64Value();
    }
    if (o.Has("generation") && o.Get("generation").IsNumber()) {
        out->generation = (uint64_t)o.Get("generation").As<Napi::Number>().Int64Value();
    }
    if (o.Has("extentCount") && o.Get("extentCount").IsNumber()) {
        out->extent_count = o.Get("extentCount").As<Napi::Number>().Uint32Value();
    }
    if (o.Has("recId") && o.Get("recId").IsNumber()) {
        out->rec_id = (uint64_t)o.Get("recId").As<Napi::Number>().Int64Value();
    }
    if (o.Has("compressType") && o.Get("compressType").IsString()) {
        out->compress_type = CompressCode(o.Get("compressType").As<Napi::String>().Utf8Value());
    }
    if (o.Has("origSize") && o.Get("origSize").IsNumber()) {
        out->orig_size = (uint64_t)o.Get("origSize").As<Napi::Number>().Int64Value();
    }
    if (o.Has("origCrc") && o.Get("origCrc").IsNumber()) {
        out->orig_crc = o.Get("origCrc").As<Napi::Number>().Uint32Value();
    }
    return out->rec_id != 0 || out->tombstone;
}

static bool MetaFromJs(Napi::Value value, s3dfs_put_meta *out)
{
    memset(out, 0, sizeof(*out));
    if (!value.IsObject()) {
        return false;
    }
    Napi::Object o = value.As<Napi::Object>();
    out->has_meta = 1;
    if (o.Has("compressType") && o.Get("compressType").IsString()) {
        out->compress_type = CompressCode(o.Get("compressType").As<Napi::String>().Utf8Value());
    }
    if (o.Has("origSize") && o.Get("origSize").IsNumber()) {
        out->orig_size = (uint64_t)o.Get("origSize").As<Napi::Number>().Int64Value();
    }
    if (o.Has("origCrc") && o.Get("origCrc").IsNumber()) {
        out->orig_crc = o.Get("origCrc").As<Napi::Number>().Uint32Value();
    }
    return true;
}

struct ScanCollect {
    std::vector<std::string> keys;
    std::vector<s3dfs_locator> locs;
};

static int ScanCollectCb(void *user, const char *key, uint32_t key_len, const s3dfs_locator *loc)
{
    auto *out = static_cast<ScanCollect *>(user);
    out->keys.emplace_back(key, key_len);
    out->locs.push_back(*loc);
    return 0;
}

class Store : public Napi::ObjectWrap<Store> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports)
    {
        Napi::Function fn = DefineClass(env, "Store", {
            InstanceMethod("put", &Store::Put),
            InstanceMethod("putBatch", &Store::PutBatch),
            InstanceMethod("get", &Store::Get),
            InstanceMethod("getSpan", &Store::GetSpan),
            InstanceMethod("putChunks", &Store::PutChunks),
            InstanceMethod("head", &Store::Head),
            InstanceMethod("tombstone", &Store::Tombstone),
            InstanceMethod("scan", &Store::Scan),
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
        s3dfs_options opt;
        memset(&opt, 0, sizeof(opt));
        if (info.Length() > 1 && info[1].IsObject()) {
            Napi::Object o = info[1].As<Napi::Object>();
            if (o.Has("blockSize") && o.Get("blockSize").IsNumber()) {
                opt.block_size = (uint64_t)o.Get("blockSize").As<Napi::Number>().Int64Value();
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

    ~Store()
    {
        if (store_) {
            s3dfs_close(store_);
            store_ = nullptr;
        }
    }

private:
    Napi::Value Put(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBuffer()) {
            Napi::TypeError::New(env, "put(key, buffer, meta?)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        auto buf = info[1].As<Napi::Buffer<uint8_t>>();
        s3dfs_put_meta meta;
        memset(&meta, 0, sizeof(meta));
        const s3dfs_put_meta *meta_ptr = nullptr;
        if (info.Length() > 2 && info[2].IsObject() && MetaFromJs(info[2], &meta)) {
            meta_ptr = &meta;
        }
        s3dfs_locator loc;
        memset(&loc, 0, sizeof(loc));
        int rc = s3dfs_put(store_, key.c_str(), (uint32_t)key.size(), buf.Data(), (uint32_t)buf.Length(),
                           meta_ptr, &loc);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        return LocToJs(env, loc);
    }

    Napi::Value PutBatch(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsArray()) {
            Napi::TypeError::New(env, "putBatch([{key, value}])").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        Napi::Array arr = info[0].As<Napi::Array>();
        uint32_t n = arr.Length();
        std::vector<std::string> keys(n);
        std::vector<s3dfs_put_item> items(n);
        std::vector<s3dfs_locator> locs(n);
        for (uint32_t i = 0; i < n; i++) {
            Napi::Value v = arr.Get(i);
            if (!v.IsObject()) {
                Napi::TypeError::New(env, "batch item must be object").ThrowAsJavaScriptException();
                return env.Undefined();
            }
            Napi::Object o = v.As<Napi::Object>();
            keys[i] = o.Get("key").As<Napi::String>().Utf8Value();
            auto buf = o.Get("value").As<Napi::Buffer<uint8_t>>();
            items[i].key = keys[i].c_str();
            items[i].key_len = (uint32_t)keys[i].size();
            items[i].value = buf.Data();
            items[i].value_len = (uint32_t)buf.Length();
        }
        int rc = s3dfs_put_batch(store_, items.data(), n, nullptr, locs.data());
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        Napi::Array out = Napi::Array::New(env, n);
        for (uint32_t i = 0; i < n; i++) {
            out.Set(i, LocToJs(env, locs[i]));
        }
        return out;
    }

    Napi::Value Get(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 2 || !info[0].IsString()) {
            Napi::TypeError::New(env, "get(key, locator)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        s3dfs_locator loc;
        if (!LocFromJs(info[1], &loc)) {
            Napi::TypeError::New(env, "get(key, locator)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        void *data = nullptr;
        uint32_t len = 0, crc = 0;
        uint64_t mtime = 0;
        int rc = s3dfs_get_at(store_, key.c_str(), (uint32_t)key.size(), &loc, &data, &len, &crc, &mtime);
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return env.Null();
        }
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
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

    Napi::Value GetSpan(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 4 || !info[0].IsString() || !info[2].IsNumber() || !info[3].IsNumber()) {
            Napi::TypeError::New(env, "getSpan(key, locator, start, len)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        s3dfs_locator loc;
        if (!LocFromJs(info[1], &loc)) {
            Napi::TypeError::New(env, "getSpan(key, locator, start, len)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        uint64_t start = (uint64_t)info[2].As<Napi::Number>().DoubleValue();
        uint64_t len = (uint64_t)info[3].As<Napi::Number>().DoubleValue();
        void *data = nullptr;
        uint32_t out_len = 0;
        int rc = s3dfs_read_span(store_, key.c_str(), (uint32_t)key.size(), &loc, start, len, &data, &out_len);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::Copy(env, (uint8_t *)data, out_len);
        s3dfs_free(data);
        return buf;
    }

    Napi::Value PutChunks(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 2 || !info[0].IsString() || !info[1].IsArray()) {
            Napi::TypeError::New(env, "putChunks(key, buffers)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        Napi::Array arr = info[1].As<Napi::Array>();
        s3dfs_writer *writer = s3dfs_write_begin(store_, key.c_str(), (uint32_t)key.size(), nullptr);
        if (!writer) {
            ErrFrom(env, S3DFS_ERR_NOMEM).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        for (uint32_t i = 0; i < arr.Length(); i++) {
            auto buf = arr.Get(i).As<Napi::Buffer<uint8_t>>();
            int rc = s3dfs_write(writer, buf.Data(), (uint32_t)buf.Length());
            if (rc != S3DFS_OK) {
                s3dfs_write_abort(writer);
                ErrFrom(env, rc).ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
        s3dfs_locator loc;
        memset(&loc, 0, sizeof(loc));
        int rc = s3dfs_write_finish(writer, &loc);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        return LocToJs(env, loc);
    }

    Napi::Value Head(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 2 || !info[0].IsString()) {
            Napi::TypeError::New(env, "head(key, locator)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        s3dfs_locator loc;
        if (!LocFromJs(info[1], &loc)) {
            Napi::TypeError::New(env, "head(key, locator)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        uint64_t size = 0;
        uint32_t crc = 0;
        uint64_t mtime = 0;
        int rc = s3dfs_head_at(store_, key.c_str(), (uint32_t)key.size(), &loc, &size, &crc, &mtime);
        if (rc == S3DFS_ERR_NOT_FOUND) {
            return env.Null();
        }
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        Napi::Object o = Napi::Object::New(env);
        o.Set("size", Napi::Number::New(env, (double)size));
        o.Set("crc", Napi::Number::New(env, crc));
        o.Set("mtimeMs", Napi::Number::New(env, (double)mtime));
        return o;
    }

    Napi::Value Tombstone(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "tombstone(key)").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        std::string key = info[0].As<Napi::String>().Utf8Value();
        int rc = s3dfs_tombstone(store_, key.c_str(), (uint32_t)key.size());
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value Scan(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        ScanCollect collected;
        int rc = s3dfs_scan(store_, ScanCollectCb, &collected);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        // Later records for the same key win; a trailing tombstone drops the key.
        std::vector<std::string> order;
        std::vector<size_t> index;
        // Use a simple last-write-wins fold while preserving first-seen order of live keys.
        struct Last { size_t i; bool live; };
        // linear fold is enough here; Node will see the already-folded list.
        Napi::Array out = Napi::Array::New(env);
        std::vector<std::string> keys;
        std::vector<s3dfs_locator> locs;
        std::vector<int> live;
        for (size_t i = 0; i < collected.keys.size(); i++) {
            const std::string &k = collected.keys[i];
            size_t found = keys.size();
            for (size_t j = 0; j < keys.size(); j++) {
                if (keys[j] == k) {
                    found = j;
                    break;
                }
            }
            if (found == keys.size()) {
                keys.push_back(k);
                locs.push_back(collected.locs[i]);
                live.push_back(collected.locs[i].tombstone ? 0 : 1);
            } else {
                locs[found] = collected.locs[i];
                live[found] = collected.locs[i].tombstone ? 0 : 1;
            }
        }
        uint32_t n = 0;
        for (size_t i = 0; i < keys.size(); i++) {
            if (!live[i]) {
                continue;
            }
            Napi::Object o = Napi::Object::New(env);
            o.Set("key", Napi::String::New(env, keys[i]));
            o.Set("locator", LocToJs(env, locs[i]));
            out.Set(n++, o);
        }
        return out;
    }

    Napi::Value Flush(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        int rc = s3dfs_flush(store_);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
        }
        return env.Undefined();
    }

    Napi::Value Compact(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        int rc = s3dfs_compact(store_);
        if (rc != S3DFS_OK) {
            ErrFrom(env, rc).ThrowAsJavaScriptException();
            return env.Undefined();
        }
        return Stats(info);
    }

    Napi::Value Stats(const Napi::CallbackInfo &info)
    {
        Napi::Env env = info.Env();
        s3dfs_stats st;
        memset(&st, 0, sizeof(st));
        s3dfs_get_stats(store_, &st);
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
        o.Set("deadBytes", Napi::Number::New(env, (double)st.dead_bytes));
        o.Set("tickets", Napi::Number::New(env, (double)st.tickets));
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

    s3dfs_store *store_ = nullptr;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports)
{
    return Store::Init(env, exports);
}

NODE_API_MODULE(s3dfs_engine, InitAll)
