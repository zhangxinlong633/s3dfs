import zlib from 'node:zlib';
import type { BlockPutMeta } from './block-client.js';
import type { ExtentLocator } from './types.js';

/** API and block keep one chunk of this size on the streamed put path. */
export const PUT_CHUNK_BYTES = 1024 * 1024;

export interface ChunkWriter {
  write(chunk: Buffer): Promise<void>;
  finish(meta: BlockPutMeta): Promise<ExtentLocator>;
  abort(): Promise<void>;
}

/** Send each chunk to every writer, then finish. A failed writer is aborted and left out. */
export async function relayChunks(
  chunks: AsyncIterable<Buffer>,
  writers: ChunkWriter[],
): Promise<{ size: number; crc: number; locs: (ExtentLocator | undefined)[] }> {
  const live = writers.map((writer) => ({ writer, ok: true }));
  let size = 0;
  let crc = 0;
  try {
    for await (const chunk of chunks) {
      crc = zlib.crc32(chunk, crc) >>> 0;
      size += chunk.length;
      await Promise.all(
        live.map(async (item) => {
          if (!item.ok) {
            return;
          }
          try {
            await item.writer.write(chunk);
          } catch {
            item.ok = false;
            await item.writer.abort().catch(() => undefined);
          }
        }),
      );
    }
  } catch (err) {
    await Promise.all(live.filter((item) => item.ok).map((item) => item.writer.abort().catch(() => undefined)));
    throw err;
  }
  const meta: BlockPutMeta = { compressType: 'none', origSize: size, origCrc: crc };
  const locs = await Promise.all(
    live.map(async (item) => {
      if (!item.ok) {
        return undefined;
      }
      try {
        return await item.writer.finish(meta);
      } catch {
        await item.writer.abort().catch(() => undefined);
        return undefined;
      }
    }),
  );
  return { size, crc, locs };
}
