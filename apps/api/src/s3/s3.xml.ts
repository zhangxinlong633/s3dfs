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
  delimiter?: string;
  prefixes?: string[];
  nextToken?: string;
}): string {
  const prefixes = opts.prefixes ?? [];
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
  const common = prefixes
    .map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`)
    .join('');
  const delim = opts.delimiter ? `<Delimiter>${xmlEscape(opts.delimiter)}</Delimiter>` : '';
  const token = opts.nextToken ?? (opts.truncated && opts.objects.length ? opts.objects[opts.objects.length - 1]!.key : undefined);
  const next = opts.truncated && token
    ? `<NextContinuationToken>${xmlEscape(token)}</NextContinuationToken>`
    : '';
  const keyCount = opts.objects.length + prefixes.length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${xmlEscape(opts.bucket)}</Name>
  <Prefix>${xmlEscape(opts.prefix)}</Prefix>
  ${delim}
  <MaxKeys>${opts.maxKeys}</MaxKeys>
  <KeyCount>${keyCount}</KeyCount>
  <IsTruncated>${opts.truncated}</IsTruncated>
  ${contents}
  ${common}
  ${next}
</ListBucketResult>
`;
}

export function etagFromCrc(crc: number): string {
  return `"${crc.toString(16).padStart(8, '0')}"`;
}

export function initiateMultipartXml(bucket: string, key: string, uploadId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${xmlEscape(bucket)}</Bucket>
  <Key>${xmlEscape(key)}</Key>
  <UploadId>${xmlEscape(uploadId)}</UploadId>
</InitiateMultipartUploadResult>
`;
}

export function listPartsXml(
  bucket: string,
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string; size: number }[],
): string {
  const body = parts
    .map(
      (part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag><Size>${part.size}</Size></Part>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${xmlEscape(bucket)}</Bucket>
  <Key>${xmlEscape(key)}</Key>
  <UploadId>${xmlEscape(uploadId)}</UploadId>
  ${body}
</ListPartsResult>
`;
}

export function copyObjectXml(etag: string, lastModified: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult>
  <LastModified>${xmlEscape(lastModified)}</LastModified>
  <ETag>${xmlEscape(etag)}</ETag>
</CopyObjectResult>
`;
}

export function listVersionsXml(
  bucket: string,
  key: string,
  versions: { id: string; deleteMarker: boolean; mtimeMs: number; body: Buffer | null }[],
): string {
  const rows = versions
    .map((version) => {
      const tag = version.deleteMarker ? 'DeleteMarker' : 'Version';
      return `<${tag}><Key>${xmlEscape(key)}</Key><VersionId>${xmlEscape(version.id)}</VersionId><IsLatest>false</IsLatest><LastModified>${new Date(version.mtimeMs).toISOString()}</LastModified><Size>${version.body?.length ?? 0}</Size></${tag}>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${xmlEscape(bucket)}</Name>
  <Prefix>${xmlEscape(key)}</Prefix>
  ${rows}
</ListVersionsResult>
`;
}

export function completeMultipartXml(opts: { location: string; bucket: string; key: string; etag: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>${xmlEscape(opts.location)}</Location>
  <Bucket>${xmlEscape(opts.bucket)}</Bucket>
  <Key>${xmlEscape(opts.key)}</Key>
  <ETag>${xmlEscape(opts.etag)}</ETag>
</CompleteMultipartUploadResult>
`;
}
