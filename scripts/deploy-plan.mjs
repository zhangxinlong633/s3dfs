export function assertReleaseAllowed({ testsOk, version }) {
  if (!testsOk) {
    throw new Error('测试没有通过，不打标签，也不发到环境');
  }
  if (!version || !/^[0-9]+(\.[0-9]+){1,2}$/.test(version)) {
    throw new Error('版本号要写成 0.1 或 0.1.1');
  }
  return { tag: `v${version}`, version };
}

export function releaseAssetName({ version, os, arch }) {
  return `s3dfs-${version}-${os}-${arch}.tar.gz`;
}

function list(value, label) {
  const items = (Array.isArray(value) ? value : String(value ?? '').split(',')).map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) {
    throw new Error(`${label} 不能为空`);
  }
  return items;
}

function portFor(hosts, index, base) {
  const host = hosts[index];
  const earlier = hosts.slice(0, index).filter((item) => item === host).length;
  return base + earlier;
}

export function planDeploy(input) {
  const replicas = Number(input.replicas);
  const indexes = Number(input.indexes);
  const apis = Number(input.apis);
  const zones = list(input.zones, 'zones');
  const blockHosts = list(input.blockHosts, 'blockHosts');
  const indexHosts = list(input.indexHosts, 'indexHosts');
  const apiHosts = list(input.apiHosts, 'apiHosts');
  if (blockHosts.length !== replicas) {
    throw new Error(`block 机器数要等于副本数 ${replicas}`);
  }
  if (indexHosts.length !== indexes) {
    throw new Error(`索引机器数要等于 ${indexes}`);
  }
  if (apiHosts.length !== apis) {
    throw new Error(`API 机器数要等于 ${apis}`);
  }
  if (replicas > 1 && zones.length < replicas) {
    throw new Error(`zone 只有 ${zones.length} 个，放不下 ${replicas} 份副本`);
  }
  const dataRoot = input.dataRoot ?? '/var/lib/s3dfs';
  const blockPort = Number(input.blockPort ?? 9100);
  const indexPort = Number(input.indexPort ?? 9800);
  const apiPort = Number(input.apiPort ?? 9000);
  const blocks = blockHosts.map((host, index) => ({
    id: `block${index + 1}`,
    host,
    port: portFor(blockHosts, index, blockPort),
    zone: zones[index % zones.length],
    dataDir: `${dataRoot}/block/block${index + 1}`,
  }));
  const indexNodes = indexHosts.map((host, index) => ({
    id: `index${index + 1}`,
    host,
    port: portFor(indexHosts, index, indexPort),
    dataDir: `${dataRoot}/index/index${index + 1}`,
  }));
  const apiNodes = apiHosts.map((host, index) => ({
    id: `api${index + 1}`,
    host,
    port: portFor(apiHosts, index, apiPort),
  }));
  const strict = input.strictLayout ?? (replicas > 1 ? '1' : '0');
  const blockNodes = blocks.map((node) => `${node.id}=${node.host}:${node.port}@${node.zone}`).join(',');
  const indexUrls = indexNodes.map((node) => `http://${node.host}:${node.port}`).join(',');
  return {
    name: input.name ?? 's3dfs',
    version: input.version ?? '',
    dataRoot,
    installRoot: input.installRoot ?? '/opt/s3dfs',
    indexRoot: input.indexRoot ?? '/opt/dleveldb',
    blocks,
    indexes: indexNodes,
    apis: apiNodes,
    volumeNames: [
      ...blocks.map((node) => `s3dfs-block-${node.id}`),
      ...indexNodes.map((node) => `s3dfs-index-${node.id}`),
    ],
    env: {
      S3DFS_DATA_REPLICAS: String(replicas),
      S3DFS_STRICT_LAYOUT: String(strict),
      S3DFS_BLOCK_NODES: blockNodes,
      S3DFS_INDEX_URLS: indexUrls,
      S3DFS_COMPRESS: input.compress ?? 'zstd',
    },
  };
}

function envFile(entries) {
  return `${Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

function unit(description, exec, extra) {
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${extra}
ExecStart=${exec}
Restart=on-failure
# 升级只换 /opt 里的程序。数据在 /var/lib/s3dfs 下，启动时不删除。

[Install]
WantedBy=multi-user.target
`;
}

function k8s(plan) {
  const blockList = plan.blocks
    .map((node, index) => `${node.id}=s3dfs-block-${index}.s3dfs-block.s3dfs.svc:${node.port}@${node.zone}`)
    .join(',');
  const indexList = plan.indexes.map((node, index) => `http://s3dfs-index-${index}.s3dfs-index.s3dfs.svc:${node.port}`).join(',');
  const peers = plan.indexes.map((node, index) => `s3dfs-index-${index}.s3dfs-index.s3dfs.svc:${node.port}`).join(',');
  return `apiVersion: v1
kind: Namespace
metadata:
  name: s3dfs
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: s3dfs
  namespace: s3dfs
data:
  S3DFS_DATA_REPLICAS: "${plan.env.S3DFS_DATA_REPLICAS}"
  S3DFS_STRICT_LAYOUT: "${plan.env.S3DFS_STRICT_LAYOUT}"
  S3DFS_BLOCK_NODES: "${blockList}"
  S3DFS_INDEX_URLS: "${indexList}"
  S3DFS_COMPRESS: "${plan.env.S3DFS_COMPRESS}"
  DLEVELDB_PEERS: "${peers}"
  DLEVELDB_REPLICAS: "${plan.indexes.length}"
---
apiVersion: v1
kind: Service
metadata:
  name: s3dfs-api
  namespace: s3dfs
spec:
  type: LoadBalancer
  selector:
    app: s3dfs-api
  ports:
    - port: 9000
      targetPort: 9000
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: s3dfs-api
  namespace: s3dfs
spec:
  replicas: ${plan.apis.length}
  selector:
    matchLabels:
      app: s3dfs-api
  template:
    metadata:
      labels:
        app: s3dfs-api
    spec:
      containers:
        - name: api
          image: s3dfs
          workingDir: /opt/s3dfs
          command: ["bun", "api/main.js"]
          ports:
            - containerPort: 9000
          envFrom:
            - configMapRef:
                name: s3dfs
            - secretRef:
                name: s3dfs
---
apiVersion: v1
kind: Service
metadata:
  name: s3dfs-block
  namespace: s3dfs
spec:
  clusterIP: None
  selector:
    app: s3dfs-block
  ports:
    - port: 9100
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: s3dfs-block
  namespace: s3dfs
spec:
  serviceName: s3dfs-block
  replicas: ${plan.blocks.length}
  selector:
    matchLabels:
      app: s3dfs-block
  template:
    metadata:
      labels:
        app: s3dfs-block
    spec:
      containers:
        - name: block
          image: s3dfs
          workingDir: /opt/s3dfs
          command: ["sh", "-c", "n=$((\${HOSTNAME##*-}+1)); export S3DFS_BLOCK_NODE_ID=block$n S3DFS_BLOCK_PORT=9100 S3DFS_ADVERTISE_ADDR=s3dfs-block-\${HOSTNAME##*-}.s3dfs-block.s3dfs.svc:9100 S3DFS_DATA_DIR=/var/lib/s3dfs/block; exec bun block/main.js"]
          envFrom:
            - configMapRef:
                name: s3dfs
          volumeMounts:
            - name: data
              mountPath: /var/lib/s3dfs/block
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 100Gi
---
apiVersion: v1
kind: Service
metadata:
  name: s3dfs-index
  namespace: s3dfs
spec:
  clusterIP: None
  selector:
    app: s3dfs-index
  ports:
    - port: 9800
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: s3dfs-index
  namespace: s3dfs
spec:
  serviceName: s3dfs-index
  replicas: ${plan.indexes.length}
  selector:
    matchLabels:
      app: s3dfs-index
  template:
    metadata:
      labels:
        app: s3dfs-index
    spec:
      containers:
        - name: index
          image: dleveldb
          workingDir: /opt/dleveldb
          command: ["sh", "-c", "n=$((\${HOSTNAME##*-}+1)); export DLEVELDB_NODE_ID=index$n DLEVELDB_PORT=9800 DLEVELDB_ADVERTISE_ADDR=s3dfs-index-\${HOSTNAME##*-}.s3dfs-index.s3dfs.svc:9800 DLEVELDB_DATA_DIR=/var/lib/s3dfs/index; exec bun packages/dleveldb/src/cli.ts"]
          envFrom:
            - configMapRef:
                name: s3dfs
          volumeMounts:
            - name: data
              mountPath: /var/lib/s3dfs/index
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 20Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: s3dfs-patrol
  namespace: s3dfs
spec:
  replicas: 1
  selector:
    matchLabels:
      app: s3dfs-patrol
  template:
    metadata:
      labels:
        app: s3dfs-patrol
    spec:
      containers:
        - name: patrol
          image: s3dfs
          workingDir: /opt/s3dfs
          command: ["bun", "patrol/main.js"]
          env:
            - name: S3DFS_PATROL_API_URL
              value: http://s3dfs-api:9000
            - name: S3DFS_PATROL_MODEL
              value: "off"
          envFrom:
            - secretRef:
                name: s3dfs
`;
}

function compose(plan) {
  const blockNodes = plan.blocks.map((node) => `${node.id}=${node.id}:9100@${node.zone}`).join(',');
  const indexUrls = plan.indexes.map((node) => `http://${node.id}:9800`).join(',');
  const peers = plan.indexes.map((node) => `${node.id}:9800`).join(',');
  const services = [];
  for (const node of plan.indexes) {
    services.push(`  ${node.id}:
    image: dleveldb
    environment:
      DLEVELDB_NODE_ID: ${node.id}
      DLEVELDB_PORT: "9800"
      DLEVELDB_ADVERTISE_ADDR: ${node.id}:9800
      DLEVELDB_DATA_DIR: /var/lib/s3dfs/index
      DLEVELDB_PEERS: ${peers}
      DLEVELDB_REPLICAS: "${plan.indexes.length}"
    volumes:
      - s3dfs-index-${node.id}:/var/lib/s3dfs/index
`);
  }
  for (const node of plan.blocks) {
    services.push(`  ${node.id}:
    image: s3dfs
    working_dir: /opt/s3dfs
    command: ["bun", "block/main.js"]
    environment:
      S3DFS_BLOCK_NODE_ID: ${node.id}
      S3DFS_BLOCK_PORT: "9100"
      S3DFS_ADVERTISE_ADDR: ${node.id}:9100
      S3DFS_DATA_DIR: /var/lib/s3dfs/block
      S3DFS_DATA_REPLICAS: "${plan.env.S3DFS_DATA_REPLICAS}"
      S3DFS_INDEX_URLS: ${indexUrls}
      S3DFS_BLOCK_NODES: ${blockNodes}
    volumes:
      - s3dfs-block-${node.id}:/var/lib/s3dfs/block
`);
  }
  services.push(`  api:
    image: s3dfs
    working_dir: /opt/s3dfs
    command: ["bun", "api/main.js"]
    ports:
      - "9000:9000"
    environment:
      S3DFS_DATA_REPLICAS: "${plan.env.S3DFS_DATA_REPLICAS}"
      S3DFS_STRICT_LAYOUT: "${plan.env.S3DFS_STRICT_LAYOUT}"
      S3DFS_BLOCK_NODES: ${blockNodes}
      S3DFS_INDEX_URLS: ${indexUrls}
      S3DFS_COMPRESS: ${plan.env.S3DFS_COMPRESS}
    env_file:
      - secret.env
`);
  if (plan.apis.length > 1) {
    services.push(`  api-2:
    image: s3dfs
    working_dir: /opt/s3dfs
    command: ["bun", "api/main.js"]
    environment:
      S3DFS_API_PORT: "9000"
      S3DFS_DATA_REPLICAS: "${plan.env.S3DFS_DATA_REPLICAS}"
      S3DFS_STRICT_LAYOUT: "${plan.env.S3DFS_STRICT_LAYOUT}"
      S3DFS_BLOCK_NODES: ${blockNodes}
      S3DFS_INDEX_URLS: ${indexUrls}
    env_file:
      - secret.env
`);
  }
  services.push(`  patrol:
    image: s3dfs
    working_dir: /opt/s3dfs
    command: ["bun", "patrol/main.js"]
    environment:
      S3DFS_PATROL_API_URL: http://api:9000
      S3DFS_PATROL_MODEL: "off"
    env_file:
      - secret.env
`);
  const volumes = plan.volumeNames.map((name) => `  ${name}:`).join('\n');
  return `services:
${services.join('\n')}
volumes:
${volumes}
`;
}

export function renderDeploy(input) {
  const plan = planDeploy(input);
  const files = {};
  files['systemd/s3dfs-block@.service'] = unit(
    's3dfs block %i',
    '/usr/bin/bun block/main.js',
    `WorkingDirectory=${plan.installRoot}
EnvironmentFile=/etc/s3dfs/block-%i.env
EnvironmentFile=-/etc/s3dfs/secret.env`,
  ).replace('数据在 /var/lib/s3dfs 下', '数据在 /var/lib/s3dfs/block 下');
  files['systemd/s3dfs-index@.service'] = unit(
    's3dfs index %i',
    '/usr/bin/bun packages/dleveldb/src/cli.ts',
    `WorkingDirectory=${plan.indexRoot}
EnvironmentFile=/etc/s3dfs/index-%i.env`,
  );
  files['systemd/s3dfs-api@.service'] = unit(
    's3dfs api %i',
    '/usr/bin/bun api/main.js',
    `WorkingDirectory=${plan.installRoot}
EnvironmentFile=/etc/s3dfs/api-%i.env
EnvironmentFile=-/etc/s3dfs/secret.env`,
  );
  files['systemd/s3dfs-patrol.service'] = unit(
    's3dfs patrol',
    '/usr/bin/bun patrol/main.js',
    `WorkingDirectory=${plan.installRoot}
EnvironmentFile=/etc/s3dfs/patrol.env
EnvironmentFile=-/etc/s3dfs/secret.env`,
  );
  const shared = {
    ...plan.env,
    S3DFS_PATROL_API_URL: `http://${plan.apis[0].host}:${plan.apis[0].port}`,
    S3DFS_PATROL_MODEL: 'off',
  };
  for (const node of plan.blocks) {
    files[`systemd/nodes/block-${node.id}.env`] = envFile({
      S3DFS_BLOCK_NODE_ID: node.id,
      S3DFS_BLOCK_PORT: String(node.port),
      S3DFS_ADVERTISE_ADDR: `${node.host}:${node.port}`,
      S3DFS_DATA_DIR: node.dataDir,
      S3DFS_INDEX_URLS: plan.env.S3DFS_INDEX_URLS,
    });
  }
  for (const node of plan.indexes) {
    const peers = plan.indexes
      .filter((item) => item.id !== node.id)
      .map((item) => `${item.host}:${item.port}`)
      .join(',');
    files[`systemd/nodes/index-${node.id}.env`] = envFile({
      DLEVELDB_NODE_ID: node.id,
      DLEVELDB_PORT: String(node.port),
      DLEVELDB_ADVERTISE_ADDR: `${node.host}:${node.port}`,
      DLEVELDB_DATA_DIR: node.dataDir,
      DLEVELDB_PEERS: peers,
      DLEVELDB_REPLICAS: String(plan.indexes.length),
    });
  }
  for (const node of plan.apis) {
    files[`systemd/nodes/api-${node.id}.env`] = envFile({
      S3DFS_API_PORT: String(node.port),
      ...plan.env,
    });
  }
  files['systemd/nodes/patrol.env'] = envFile(shared);
  files['systemd/secret.env.example'] = envFile({
    S3DFS_ACCESS_KEY: '',
    S3DFS_SECRET_KEY: '',
    S3DFS_PATROL_TOKEN: '',
  });
  files['systemd/install.sh'] = `#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
install -d /etc/s3dfs ${plan.dataRoot}/block ${plan.dataRoot}/index
# 不删除 ${plan.dataRoot}。换版本只覆盖 ${plan.installRoot}。
cp "$here"/*.service /etc/systemd/system/
cp "$here"/nodes/*.env /etc/s3dfs/
if [ ! -f /etc/s3dfs/secret.env ]; then
  cp "$here"/secret.env.example /etc/s3dfs/secret.env
  echo "填好 /etc/s3dfs/secret.env 里的密钥后再启动 API" >&2
fi
systemctl daemon-reload
echo "启用示例: systemctl enable --now s3dfs-index@index1 s3dfs-block@block1 s3dfs-api@api1 s3dfs-patrol"
`;
  files['docker/compose.yaml'] = compose(plan);
  files['docker/secret.env.example'] = files['systemd/secret.env.example'];
  files['k8s/s3dfs.yaml'] = k8s(plan);
  files['k8s/secret.env.example'] = `apiVersion: v1
kind: Secret
metadata:
  name: s3dfs
  namespace: s3dfs
type: Opaque
stringData:
  S3DFS_ACCESS_KEY: ""
  S3DFS_SECRET_KEY: ""
  S3DFS_PATROL_TOKEN: ""
`;
  return files;
}

export function configFromEnvText(text) {
  const raw = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cut = trimmed.indexOf('=');
    if (cut < 1) continue;
    raw[trimmed.slice(0, cut)] = trimmed.slice(cut + 1);
  }
  return {
    name: raw.name,
    version: raw.version,
    replicas: Number(raw.replicas),
    indexes: Number(raw.indexes),
    apis: Number(raw.apis),
    zones: raw.zones,
    blockHosts: raw.blockHosts,
    indexHosts: raw.indexHosts,
    apiHosts: raw.apiHosts,
    dataRoot: raw.dataRoot,
    installRoot: raw.installRoot,
    indexRoot: raw.indexRoot,
    strictLayout: raw.strictLayout,
    compress: raw.compress,
  };
}
