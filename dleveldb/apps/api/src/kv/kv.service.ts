import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import path from 'node:path';
import { DLevelDB, loadConfig, type DLevelDBStats, type DLevelDBStatus } from 'dleveldb';

@Injectable()
export class KvService implements OnModuleInit, OnModuleDestroy {
  private db!: DLevelDB;

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    config.dataDir = path.resolve(config.dataDir);
    this.db = await DLevelDB.open(config);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.flush();
    await this.db.close();
  }

  kv(): DLevelDB {
    return this.db;
  }

  stats(): DLevelDBStats {
    return this.db.stats();
  }

  status(): DLevelDBStatus {
    return this.db.status();
  }

  async flush(): Promise<void> {
    await this.db.flush();
  }

  async compact(): Promise<void> {
    await this.db.compact();
  }
}
