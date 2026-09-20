// Simple in-memory Launcher fake for unit tests (docs/control-plane.md §5.1). Records every call;
// `failWith` makes the next `launch()` reject the way `ec2-launcher.ts` does on a non-retryable
// error, so `start-stop-matrix.test.ts` can exercise the W4 rollback / 503 `launch_failed` path.
// `local.ts` uses the richer ticking fake in `src/local/fakeLauncher.ts`, not this one.
import type { LaunchInput, LaunchOutput, Launcher } from '../ports';

export class FakeLauncher implements Launcher {
  readonly calls: LaunchInput[] = [];
  private failNext: Error | null = null;
  private nextInstanceId = 1;

  failNextWith(err: Error): void {
    this.failNext = err;
  }

  async launch(input: LaunchInput): Promise<LaunchOutput> {
    this.calls.push(input);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return { instanceId: `i-fake-${this.nextInstanceId++}` };
  }
}
