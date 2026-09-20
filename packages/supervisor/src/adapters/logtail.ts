// @dst/supervisor adapters: log tailing (docs/game-server.md §7 "Log tailing"). One `LogTailer`
// per shard over `<cluster>/<Shard>/server_log.txt`: keeps a byte offset, reads new bytes on
// `poll()`, splits on `\n`, feeds each complete line to the callback. The shard truncates its log
// at start, so a shrinking file size resets the offset to 0 and re-reads from the top.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export class LogTailer {
  private offset = 0;
  private partial = '';

  constructor(
    private readonly path: string,
    private readonly onLine: (line: string) => void,
  ) {}

  /** Reads whatever is new since the last call. Never throws: a missing file (not created yet) is
   *  simply nothing to read this tick. */
  poll(): void {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // The shard truncated its log at start (docs/game-server.md §7): re-read from 0.
        this.offset = 0;
        this.partial = '';
      }
      if (size === this.offset) return;

      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, this.offset);
      this.offset = size;

      const text = this.partial + buffer.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      for (const line of lines) this.onLine(line);
    } finally {
      closeSync(fd);
    }
  }

  reset(): void {
    this.offset = 0;
    this.partial = '';
  }
}
