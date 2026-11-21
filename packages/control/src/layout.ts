import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** On-disk contract for repair tools. Written as s3dfs-layout.json in block and index data directories. */
export const s3dfsLayout = {
  layoutVersion: 1,
  name: 's3dfs',
  readme:
    '本文件描述 block 目录和索引目录里的字节。修复程序先读它，再扫 blocks/*.blk 或索引键。recmap.s3m 只是重启缓存，校验失败就丢掉，改扫 .blk。',
  endian: 'little',
  crc32: {
    algorithm: 'CRC-32/ISO-HDLC',
    polynomialReflected: '0xEDB88320',
    note: '与 zlib.crc32 相同。记录头的 crc 覆盖 magic 和 rec_len 之后、尾部之前的全部字节，初值按 crc32_update(0, bytes) 计算。',
  },
  block: {
    directory: 'blocks',
    fileName: '20 位十进制块号加 .blk，例如 blocks/00000000000000000001.blk',
    defaultBlockBytes: 1073741824,
    record: {
      magic: 'S3R1',
      magicU32: '0x31523353',
      frame: 'magic u32 | rec_len u32 | tags | crc32 u32 | rec_len u32 | magic u32',
      overheadBytes: 20,
      tag: 'type u16 | length u32 | value[length]。不认识的 type 跳过。magic、两处 rec_len 或 crc 对不上的是写了一半，跳过。',
      tags: {
        '0x0001': 'KEY，对象键字节',
        '0x0002': 'VALUE，存在盘上的正文',
        '0x0003': 'MTIME，u64 毫秒',
        '0x0004': 'CRC，u32，键字节接正文的 CRC-32',
        '0x0005': 'KIND，u8',
        '0x0006': 'PREV，u64，上一条 extent 的 recId',
        '0x0007': 'SEQ，u32',
        '0x0008': 'GENERATION，u64',
        '0x0009': 'TOTAL_SIZE，u64，链式对象的总长度',
        '0x000A': 'EXTENT_CNT，u32',
        '0x000B': 'COMPRESS，u8。0=none，1=zstd，2=gzip',
        '0x000C': 'ORIG_SIZE，u64，压缩前长度',
        '0x000D': 'ORIG_CRC，u32，压缩前正文 CRC',
        '0x000E': 'REC_ID，u64。索引只存这个数。compact 可以改块号和偏移，不改 recId',
      },
      kinds: {
        '1': 'OBJECT，单条记录',
        '2': 'EXTENT，链式中间段',
        '3': 'EXTENT_LAST，链式最后一段',
        '4': 'TOMBSTONE，已删除。重建索引时不要把这个键救回来',
      },
    },
    recmap: {
      file: 'recmap.s3m',
      magic: 'S3M1',
      magicU32: '0x314d3353',
      version: 1,
      note: '启动时优先读它，再补扫快照之后的新字节。文件末尾 4 字节是前面内容的 CRC-32，对不上就全量扫 .blk。',
    },
  },
  index: {
    note: '值是 JSON，UTF-8。键是普通字符串，不是 TLV。dleveldb 自己的文件格式不在本文。本文只约束 s3dfs 写进去的键。',
    objectLocator: {
      v: 3,
      key: 'bucket/key 是第 0 份。第 i 份（i>=1）是 bucket/key:i',
      fields: ['v', 'replica', 'replicaCount', 'nodeId', 'address', 'recId', 'chained', 'generation', 'extentCount', 'size', 'storedSize', 'compressType', 'crc', 'mtimeMs'],
      compressType: ['none', 'zstd', 'gzip'],
      read: '用 nodeId、address、recId 向那台 block 取记录。size 是逻辑长度，storedSize 是盘上长度。crc 是压缩前正文的 CRC-32。',
    },
    bucketMarker: { key: 'bucket/', value: { v: 1, kind: 'bucket', mtimeMs: 0 } },
    hiddenPrefixes: {
      '$node/': 'block 节点注册，不是对象',
      '$upload/': '分片清单。正文在 block 的 bucket/$upload/<uploadId>/<part>',
      '$ver/': '版本清单。正文在 block 的 bucket/$ver/<encodeURIComponent(key)>/<versionId>',
      '$umeta/': '用户元数据',
    },
    visibleKey: '不以 $ 开头，不含 /$，也不是以 :正整数 结尾的副本键。修复对象时要另外纳入路径里含 /$ver/ 的键，那些是版本正文。',
  },
  repair: [
    'block 目录：按文件名顺序扫 blocks/*.blk。用 magic 和 rec_len 切出记录，crc 不对就跳过这个起点继续找下一个 magic。',
    '同一个 key 的 KIND 4 墓碑使更早的记录作废。活记录的 REC_ID 写回索引 locator 的 recId。',
    '索引目录：对象值必须是 v 为 3 的 JSON。replica 0 在 bucket/key，其余在 bucket/key:N。',
    '缺副本时从仍能按 recId 读到的那一份再写一份，然后改 locator。一份都读不到就标丢失，不要发明正文。',
    'recmap.s3m 和 recmap.s3m.tmp 可以删除。下次打开 block 会重新扫 .blk。',
  ],
} as const;

export const LAYOUT_FILE_NAME = 's3dfs-layout.json';

/** Put the layout next to block or index data so other programs can repair without the source tree. */
export function writeLayoutFile(dataDir: string): string {
  const dir = path.resolve(dataDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LAYOUT_FILE_NAME);
  writeFileSync(file, `${JSON.stringify(s3dfsLayout, null, 2)}\n`);
  return file;
}
