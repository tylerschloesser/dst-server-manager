// In-memory `ReaperDns` fake (docs/control-plane.md §5.1). Records every value written, newest
// last, and can be made to throw so the "reaping never fails because of DNS" path is exercised.
import type { ReaperDns } from '../reaper';

export class FakeDns implements ReaperDns {
  readonly writes: string[] = [];
  private failure: Error | null = null;

  failWith(err: Error): void {
    this.failure = err;
  }

  async setJoinRecord(ip: string): Promise<void> {
    this.writes.push(ip);
    if (this.failure !== null) throw this.failure;
  }
}
