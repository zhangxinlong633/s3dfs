import { Controller, Get } from '@nestjs/common';
import { KvService } from '../kv/kv.service';

@Controller()
export class AdminController {
  constructor(private readonly kv: KvService) {}

  @Get('health')
  health() {
    const status = this.kv.status();
    return {
      ok: true,
      nodeId: status.nodeId,
      address: status.address,
      physicalNodes: status.physicalNodes,
    };
  }
}
