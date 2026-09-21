// Barrel for the in-memory fakes shared by `local.ts` and the unit tests (docs/control-plane.md
// §5.1).
export { FakeClock } from './fake-clock';
export { FakeStateStore } from './fake-state-store';
export { FakeWorldRegistry, testWorld } from './fake-world-registry';
export { FakeParameterStore } from './fake-parameter-store';
export { FakeLauncher } from './fake-launcher';
export { FakeDns } from './fake-dns';
