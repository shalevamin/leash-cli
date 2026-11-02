import { afterEach, expect, it, vi } from "vitest";
import { sync } from "./sync.js";
import type { Store } from "./state.js";
import { deviceCredentials, syncDevice } from "./device.js";

vi.mock("./device.js", () => ({
  deviceCredentials: vi.fn(),
  syncDevice: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const snapshot = { sessions: [], events: [] };
const store = { snapshot: () => snapshot } as unknown as Store;
it("never opens a database transport when only a legacy URL is configured", async () => {
  vi.stubEnv("DATABASE_URL", "postgres://example.invalid/unused");
  vi.stubGlobal("fetch", vi.fn());
  try {
    expect(await sync(store)).toBeUndefined();
    expect(syncDevice).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("uses device sync only when enrolled and enabled", async () => {
  vi.mocked(deviceCredentials).mockReturnValue({
    token: "fixture-device",
  } as ReturnType<typeof deviceCredentials>);
  await sync(store);
  expect(syncDevice).toHaveBeenCalledWith(store);
  vi.mocked(syncDevice).mockClear();
  vi.stubEnv("LEASH_OFFLINE", "1");
  await sync(store);
  expect(syncDevice).not.toHaveBeenCalled();
  vi.stubEnv("LEASH_OFFLINE", "0");
  vi.stubEnv("LEASH_SYNC", "0");
  await sync(store);
  expect(syncDevice).not.toHaveBeenCalled();
});
it("returns a dry-run snapshot without contacting the API", async () => {
  expect(await sync(store, true)).toEqual(snapshot);
  expect(syncDevice).not.toHaveBeenCalled();
});
