export function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function errorXml(code: string, message: string, resource?: string): string {
  const res = resource ? `<Resource>${xmlEscape(resource)}</Resource>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${xmlEscape(code)}</Code>
  <Message>${xmlEscape(message)}</Message>
  ${res}
  <RequestId>s3dfs</RequestId>
</Error>
`;
}

export function listBucketsXml(buckets: { name: string; mtimeMs: number }[]): string {
  const items = buckets
    .map((b) => {
      const date = new Date(b.mtimeMs).toISOString();
      return `<Bucket><Name>${xmlEscape(b.name)}</Name><CreationDate>${date}</CreationDate></Bucket>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>s3dfs</ID><DisplayName>s3dfs</DisplayName></Owner>
  <Buckets>${items}</Buckets>
</ListAllMyBucketsResult>
`;
}

export function listObjectsXml(opts: {
  bucket: string;
  prefix: string;
  maxKeys: number;
  truncated: boolean;
  objects: { key: string; size: number; crc: number; mtimeMs: number }[];
}): string {
  const contents = opts.objects
    .map((o) => {
      const etag = o.crc.toString(16).padStart(8, '0');
      return `<Contents>
    <Key>${xmlEscape(o.key)}</Key>
    <LastModified>${new Date(o.mtimeMs).toISOString()}</LastModified>
    <ETag>"${etag}"</ETag>
    <Size>${o.size}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`;
    })
    .join('');
  const next = opts.truncated && opts.objects.length
    ? `<NextContinuationToken>${xmlEscape(opts.objects[opts.objects.length - 1]!.key)}</NextContinuationToken>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${xmlEscape(opts.bucket)}</Name>
  <Prefix>${xmlEscape(opts.prefix)}</Prefix>
  <MaxKeys>${opts.maxKeys}</MaxKeys>
  <KeyCount>${opts.objects.length}</KeyCount>
  <IsTruncated>${opts.truncated}</IsTruncated>
  ${contents}
  ${next}
</ListBucketResult>
`;
}

export function etagFromCrc(crc: number): string {
  return `"${crc.toString(16).padStart(8, '0')}"`;
}
