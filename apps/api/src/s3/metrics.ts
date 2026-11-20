export class RequestMetrics {
  private readonly startedAt = Date.now();
  private total = 0;
  private readonly byStatus = new Map<number, number>();

  record(status: number): void {
    this.total += 1;
    this.byStatus.set(status, (this.byStatus.get(status) ?? 0) + 1);
  }

  snapshot(): { total: number; byStatus: Record<string, number>; uptimeMs: number } {
    return {
      total: this.total,
      byStatus: Object.fromEntries(this.byStatus),
      uptimeMs: Date.now() - this.startedAt,
    };
  }
}
