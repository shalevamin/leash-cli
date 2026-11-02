import { describe, expect, it } from "vitest";
import { connectMode, validateExistingDevice } from "./connect.js";
describe("transport selection keeps ledger identity stable", () => {
  it("defaults new connections to local devices even if a cloud provider exists", () => {
    expect(connectMode("auto", false, false, 1)).toBe("device");
    expect(connectMode("auto", false, false, 0)).toBe("device");
    expect(connectMode("auto", true, false, 1)).toBe("device");
    expect(connectMode("auto", false, true, 0)).toBe("gateway");
  });
  it("refuses switching an existing ledger to another transport", () => {
    expect(() => connectMode("gateway", true, false, 1)).toThrow(
      "fresh LEASH_HOME",
    );
    expect(() => connectMode("device", false, true, 1)).toThrow(
      "fresh LEASH_HOME",
    );
    expect(() => connectMode("surprise", false, false, 1)).toThrow("Mode");
  });
});

it("requires active device owned by the approved human, including on reconnect", () => {
  const device = {
    id: "device",
    orgId: "org",
    userId: "alice",
    status: "active",
  };
  const account = { deviceId: "device", orgId: "org", userId: "alice" };
  expect(() => validateExistingDevice(device, account)).not.toThrow();
  for (const change of [
    { status: "revoked" },
    { userId: "bob" },
    { userId: null },
    { orgId: "other" },
    { id: "other" },
  ])
    expect(() =>
      validateExistingDevice({ ...device, ...change }, account),
    ).toThrow("fresh LEASH_HOME");
});
