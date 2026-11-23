#define _POSIX_C_SOURCE 200809L

#include "engine_int.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static uint64_t mono_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ull + (uint64_t)ts.tv_nsec / 1000ull;
}

__thread s3dfs_lane *s3dfs_tls_lane;
__thread int s3dfs_hold_depth;

void s3dfs_store_lock(s3dfs_store *s)
{
    if (s3dfs_hold_depth++ == 0) {
        pthread_mutex_lock(&s->mu);
    }
}

void s3dfs_store_unlock(s3dfs_store *s)
{
    if (s3dfs_hold_depth == 0) {
        return;
    }
    if (--s3dfs_hold_depth == 0) {
        pthread_mutex_unlock(&s->mu);
    }
}

void s3dfs_store_io_begin(s3dfs_store *s)
{
    if (s->exclusive || s3dfs_hold_depth == 0) {
        return;
    }
    pthread_mutex_unlock(&s->mu);
}

void s3dfs_store_io_end(s3dfs_store *s)
{
    if (s->exclusive || s3dfs_hold_depth == 0) {
        return;
    }
    pthread_mutex_lock(&s->mu);
}

static uint32_t lane_index(const s3dfs_store *s, const char *key, uint32_t key_len)
{
    uint32_t h = 2166136261u;
    uint32_t i;
    if (!s->nlanes) {
        return 0;
    }
    for (i = 0; i < key_len; i++) {
        h ^= (uint8_t)key[i];
        h *= 16777619u;
    }
    return h % s->nlanes;
}

static void *lane_main(void *arg)
{
    s3dfs_lane *lane = (s3dfs_lane *)arg;
    s3dfs_tls_lane = lane;
    for (;;) {
        s3dfs_job *job;
        pthread_mutex_lock(&lane->qmu);
        while (!lane->stop && !lane->qhead) {
            pthread_cond_wait(&lane->qcv, &lane->qmu);
        }
        if (lane->stop && !lane->qhead) {
            pthread_mutex_unlock(&lane->qmu);
            break;
        }
        job = lane->qhead;
        lane->qhead = job->next;
        if (!lane->qhead) {
            lane->qtail = NULL;
        }
        pthread_mutex_unlock(&lane->qmu);
        s3dfs_stat_add(&lane->store->stats.lane_wait_us, &lane->store->stats.lane_wait_max_us, &lane->store->stats.lane_waits,
                       mono_us() - job->queued_us);
        job->fn(job->arg);
        pthread_mutex_lock(&lane->qmu);
        job->done = 1;
        pthread_cond_signal(&job->cv);
        pthread_mutex_unlock(&lane->qmu);
    }
    s3dfs_tls_lane = NULL;
    return NULL;
}

static void lane_call_one(s3dfs_lane *lane, void (*fn)(void *), void *arg)
{
    s3dfs_job job;
    if (s3dfs_tls_lane == lane) {
        fn(arg);
        return;
    }
    memset(&job, 0, sizeof(job));
    job.fn = fn;
    job.arg = arg;
    job.queued_us = mono_us();
    pthread_cond_init(&job.cv, NULL);
    pthread_mutex_lock(&lane->qmu);
    if (lane->qtail) {
        lane->qtail->next = &job;
    } else {
        lane->qhead = &job;
    }
    lane->qtail = &job;
    uint64_t depth = 0;
    for (s3dfs_job *queued = lane->qhead; queued; queued = queued->next) {
        depth++;
    }
    s3dfs_stat_max(&lane->store->stats.lane_depth_max, depth);
    pthread_cond_signal(&lane->qcv);
    while (!job.done) {
        pthread_cond_wait(&job.cv, &lane->qmu);
    }
    pthread_mutex_unlock(&lane->qmu);
    pthread_cond_destroy(&job.cv);
}

int s3dfs_lanes_init(s3dfs_store *s, uint32_t n)
{
    uint32_t i;
    if (n < 1) {
        n = 1;
    }
    if (n > 32) {
        n = 32;
    }
    s->lanes = (s3dfs_lane *)calloc(n, sizeof(s3dfs_lane));
    if (!s->lanes) {
        return -1;
    }
    s->nlanes = n;
    for (i = 0; i < n; i++) {
        s3dfs_lane *lane = &s->lanes[i];
        lane->store = s;
        lane->fd = -1;
        lane->page_cached = UINT32_MAX;
        lane->page_index = UINT32_MAX;
        lane->buf = (uint8_t *)malloc(s->buffer_size);
        if (!lane->buf) {
            return -1;
        }
        pthread_mutex_init(&lane->qmu, NULL);
        pthread_cond_init(&lane->qcv, NULL);
    }
    return 0;
}

int s3dfs_lanes_start(s3dfs_store *s)
{
    uint32_t i;
    if (!s->lanes) {
        return -1;
    }
    for (i = 0; i < s->nlanes; i++) {
        s->lanes[i].started = 1;
        if (pthread_create(&s->lanes[i].thread, NULL, lane_main, &s->lanes[i]) != 0) {
            s->lanes[i].started = 0;
            return -1;
        }
    }
    return 0;
}

void s3dfs_lanes_stop(s3dfs_store *s)
{
    uint32_t i;
    if (!s->lanes) {
        return;
    }
    for (i = 0; i < s->nlanes; i++) {
        s3dfs_lane *lane = &s->lanes[i];
        if (!lane->started) {
            continue;
        }
        pthread_mutex_lock(&lane->qmu);
        lane->stop = 1;
        pthread_cond_signal(&lane->qcv);
        pthread_mutex_unlock(&lane->qmu);
        pthread_join(lane->thread, NULL);
        lane->started = 0;
    }
    for (i = 0; i < s->nlanes; i++) {
        s3dfs_lane *lane = &s->lanes[i];
        if (lane->fd >= 0) {
            close(lane->fd);
            lane->fd = -1;
        }
        free(lane->buf);
        free(lane->page_slots);
        pthread_mutex_destroy(&lane->qmu);
        pthread_cond_destroy(&lane->qcv);
    }
    free(s->lanes);
    s->lanes = NULL;
    s->nlanes = 0;
}

void s3dfs_lane_call_at(s3dfs_store *s, uint32_t index, void (*fn)(void *), void *arg)
{
    if (!s->lanes || !s->nlanes || !fn) {
        if (fn) {
            fn(arg);
        }
        return;
    }
    if (index >= s->nlanes) {
        index = 0;
    }
    lane_call_one(&s->lanes[index], fn, arg);
}

void s3dfs_lane_call(s3dfs_store *s, const char *key, uint32_t key_len, void (*fn)(void *), void *arg)
{
    s3dfs_lane_call_at(s, lane_index(s, key, key_len), fn, arg);
}

void s3dfs_lane_call_all(s3dfs_store *s, void (*fn)(void *), void *arg)
{
    uint32_t i;
    if (!s->lanes) {
        if (fn) {
            fn(arg);
        }
        return;
    }
    for (i = 0; i < s->nlanes; i++) {
        lane_call_one(&s->lanes[i], fn, arg);
    }
}
