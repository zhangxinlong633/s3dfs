#!/usr/bin/env node
import { DLevelDB, loadConfig, listenDLevelDB } from './index.js';

const config = loadConfig();
const db = await DLevelDB.open(config);
const server = await listenDLevelDB(db);
console.log(`dleveldb ${config.nodeId} listening on ${config.advertiseAddr} (${config.dataDir})`);

const shutdown = async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
