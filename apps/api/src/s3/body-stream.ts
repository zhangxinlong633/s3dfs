export const PUT_CHUNK_BYTES = 1024 * 1024;

/** Buffer up to one chunk. A larger body is returned as a stream that starts with what was already read. */
export async function openRequestBody(
  source: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number,
  bufferBytes = PUT_CHUNK_BYTES,
): Promise<{ body: Buffer } | { stream: AsyncIterable<Buffer> }> {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: Buffer[] = [];
  let size = 0;
  let done = false;

  const pull = async (): Promise<Buffer | null> => {
    if (done) {
      return null;
    }
    const next = await iterator.next();
    if (next.done) {
      done = true;
      return null;
    }
    const buf = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    size += buf.length;
    if (maxBytes > 0 && size > maxBytes) {
      throw Object.assign(new Error('entity too large'), { code: 'ENTITY_TOO_LARGE' });
    }
    return buf;
  };

  for (;;) {
    const buf = await pull();
    if (!buf) {
      return { body: Buffer.concat(buffered) };
    }
    buffered.push(buf);
    if (size > bufferBytes) {
      break;
    }
  }

  async function* stream(): AsyncIterable<Buffer> {
    for (const part of buffered) {
      yield part;
    }
    for (;;) {
      const buf = await pull();
      if (!buf) {
        return;
      }
      yield buf;
    }
  }

  return { stream: stream() };
}

/** Read the whole body, still stopping at maxBytes. Used for aws-chunked, which is decoded after the read. */
export async function readAllBody(
  source: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number,
): Promise<Buffer> {
  const opened = await openRequestBody(source, maxBytes, Number.MAX_SAFE_INTEGER);
  if ('body' in opened) {
    return opened.body;
  }
  const parts: Buffer[] = [];
  for await (const chunk of opened.stream) {
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
