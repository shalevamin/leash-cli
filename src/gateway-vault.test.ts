import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveGateway, loadGateway, removeGateway } from "./gateway-vault.js";
const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "leash-vault-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("encrypted local gateway credentials", () => {
  const connection = {
    url: "https://useleash.dev/gateway",
    token: "lsh_" + "a".repeat(43),
    userId: "user-1",
    orgId: "org-1",
    agent: "codex",
  };
  it("encrypts the token, preserves account scope and saves private files", () => {
    const dir = fresh();
    saveGateway(dir, connection);
    expect(loadGateway(dir)).toEqual(connection);
    expect(
      readFileSync(join(dir, "gateway.vault")).includes(
        Buffer.from(connection.token),
      ),
    ).toBe(false);
    expect(statSync(join(dir, "gateway.vault")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "gateway-vault.key")).mode & 0o777).toBe(0o600);
    const first = readFileSync(join(dir, "gateway.vault"));
    saveGateway(dir, connection);
    expect(readFileSync(join(dir, "gateway.vault")).equals(first)).toBe(false);
  });
  it("fails closed on ciphertext tampering or the wrong installation key", () => {
    const dir = fresh();
    saveGateway(dir, connection);
    const data = readFileSync(join(dir, "gateway.vault"));
    data[data.length - 1] ^= 1;
    writeFileSync(join(dir, "gateway.vault"), data);
    expect(() => loadGateway(dir)).toThrow();
    saveGateway(dir, connection);
    writeFileSync(join(dir, "gateway-vault.key"), Buffer.alloc(32));
    expect(() => loadGateway(dir)).toThrow();
  });
  it("retains legacy reads, migrates on save and removes both formats on disconnect", () => {
    const dir = fresh();
    writeFileSync(join(dir, "gateway.json"), JSON.stringify(connection));
    expect(loadGateway(dir)).toEqual(connection);
    saveGateway(dir, connection);
    expect(existsSync(join(dir, "gateway.json"))).toBe(false);
    removeGateway(dir);
    expect(loadGateway(dir)).toBeUndefined();
  });
});

it("rejects symlink masters without changing their targets", () => {
  const dir = fresh(),
    target = join(dir, "outside.key");
  writeFileSync(target, Buffer.alloc(32));
  chmodSync(target, 0o644);
  symlinkSync(target, join(dir, "gateway-vault.key"));
  expect(() =>
    saveGateway(dir, {
      url: "https://useleash.dev/gateway",
      token: "lsh_example",
    }),
  ).toThrow("symlink");
  expect(statSync(target).mode & 0o777).toBe(0o644);
});
