/** Parse a single HTTP Range header against a known object size. */
export type ByteRange =
  | { kind: 'all' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (!header || !header.trim()) {
    return { kind: 'all' };
  }
  const trimmed = header.trim();
  const match = /^bytes=\s*(.*)$/i.exec(trimmed);
  if (!match) {
    // Unknown unit: ignore the header and send the whole object.
    return { kind: 'all' };
  }
  const first = match[1]!.split(',')[0]!.trim();
  if (!first) {
    return { kind: 'unsatisfiable' };
  }
  if (size <= 0) {
    return { kind: 'unsatisfiable' };
  }
  if (first.startsWith('-')) {
    const suffix = Number(first.slice(1));
    if (!Number.isInteger(suffix) || suffix <= 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, size - suffix);
    return { kind: 'partial', start, end: size - 1 };
  }
  const dash = first.indexOf('-');
  if (dash < 0) {
    return { kind: 'unsatisfiable' };
  }
  const start = Number(first.slice(0, dash));
  const tail = first.slice(dash + 1);
  if (!Number.isInteger(start) || start < 0 || start >= size) {
    return { kind: 'unsatisfiable' };
  }
  if (tail === '') {
    return { kind: 'partial', start, end: size - 1 };
  }
  const end = Number(tail);
  if (!Number.isInteger(end) || end < start) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}
