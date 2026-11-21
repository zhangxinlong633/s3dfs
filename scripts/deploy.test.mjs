import { expect, test } from 'bun:test';
import { assertReleaseAllowed, planDeploy, releaseAssetName, renderDeploy } from './deploy-plan.mjs';

const prod = {
  name: 'prod',
  version: '0.1.0',
  replicas: 3,
  indexes: 3,
  apis: 2,
  zones: ['rack-a', 'rack-b', 'rack-c'],
  blockHosts: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
  indexHosts: ['10.0.1.1', '10.0.1.2', '10.0.1.3'],
  apiHosts: ['10.0.2.1', '10.0.2.2'],
  dataRoot: '/var/lib/s3dfs',
  installRoot: '/opt/s3dfs',
  indexRoot: '/opt/dleveldb',
};

test('release asset is a platform tar.gz', () => {
  expect(releaseAssetName({ version: '0.1', os: 'darwin', arch: 'arm64' })).toBe('s3dfs-0.1-darwin-arm64.tar.gz');
  expect(releaseAssetName({ version: '0.1.1', os: 'linux', arch: 'amd64' })).toBe('s3dfs-0.1.1-linux-amd64.tar.gz');
});

test('release stops when tests failed', () => {
  expect(() => assertReleaseAllowed({ testsOk: false })).toThrow(/测试/);
  expect(assertReleaseAllowed({ testsOk: true, version: '0.1.1' }).tag).toBe('v0.1.1');
});

test('production plan keeps data dirs and three zones', () => {
  const plan = planDeploy(prod);
  expect(plan.blocks).toHaveLength(3);
  expect(plan.blocks.map((node) => node.zone)).toEqual(['rack-a', 'rack-b', 'rack-c']);
  expect(plan.blocks.every((node) => node.dataDir.startsWith('/var/lib/s3dfs/block/'))).toBe(true);
  expect(plan.indexes.every((node) => node.dataDir.startsWith('/var/lib/s3dfs/index/'))).toBe(true);
  expect(plan.env.S3DFS_DATA_REPLICAS).toBe('3');
  expect(plan.env.S3DFS_STRICT_LAYOUT).toBe('1');
  expect(plan.env.S3DFS_BLOCK_NODES).toContain('10.0.0.1:9100@rack-a');
  expect(plan.apis).toHaveLength(2);
  expect(plan.volumeNames.join(' ')).not.toContain('0.1.0');
});

test('render writes systemd, compose, and kubernetes without wiping data', () => {
  const files = renderDeploy(prod);
  const blockUnit = files['systemd/s3dfs-block@.service'];
  const indexUnit = files['systemd/s3dfs-index@.service'];
  const compose = files['docker/compose.yaml'];
  const k8s = files['k8s/s3dfs.yaml'];
  expect(blockUnit).toContain('/var/lib/s3dfs/block');
  expect(indexUnit).toContain('/opt/dleveldb');
  expect(blockUnit).not.toContain('rm ');
  expect(compose).toContain('s3dfs-block-block1');
  expect(compose).not.toContain('0.1.0');
  expect(k8s).toContain('volumeClaimTemplates');
  expect(k8s).toContain('replicas: 2');
  expect(k8s).not.toContain('emptyDir');
  expect(k8s).toContain('kind: Service');
  expect(files['systemd/install.sh']).toContain('daemon-reload');
});

test('refuses a layout whose zones cannot hold the replicas', () => {
  expect(() => planDeploy({ ...prod, zones: ['rack-a'] })).toThrow(/zone/);
});
