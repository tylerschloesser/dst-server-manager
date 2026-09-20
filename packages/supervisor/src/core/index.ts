// @dst/supervisor core: pure, I/O-free supervisor logic (docs/game-server.md §1, §8, §12).
// Re-exported as one module so src/index.ts / src/tasks/ (a later task) import from `./core`.
export * from './types';
export * from './count';
export * from './parse';
export * from './idle';
export * from './ini';
export * from './templates';
export * from './manifest';
export * from './reduce';
