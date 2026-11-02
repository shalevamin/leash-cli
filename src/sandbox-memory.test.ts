import { describe, it, expect } from "vitest";
import {
  defaultMemoryPolicy,
  nextMemoryLimit,
  parseDockerBytes,
  validateMemoryPolicy,
} from "./sandbox-memory.js";
import {
  sandboxProject,
  sandboxIdentity,
  validateSandboxHostname,
  readSandboxGateway,
  savedSandboxGateway,
} from "./sandbox.js";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
const policy = { ...defaultMemoryPolicy, minMiB: 128, maxMiB: 512 };
const sample = {
  usedBytes: 100 * 1024 ** 2,
  currentMiB: 128,
  lastChangeAt: 0,
  now: 20000,
  policy,
};
describe("managed sandbox memory controller", () => {
  it("grows real cgroup limit in bounded steps under pressure", () =>
    expect(nextMemoryLimit(sample)).toBe(192));
  it("respects cooldown and ignores stable low usage", () => {
    expect(nextMemoryLimit({ ...sample, now: 5000 })).toBeNull();
    expect(
      nextMemoryLimit({ ...sample, usedBytes: 40 * 1024 ** 2 }),
    ).toBeNull();
  });
  it("never exceeds ceiling or shrinks a live process", () => {
    expect(
      nextMemoryLimit({
        ...sample,
        currentMiB: 448,
        usedBytes: 400 * 1024 ** 2,
      }),
    ).toBe(512);
    expect(
      nextMemoryLimit({
        ...sample,
        currentMiB: 512,
        usedBytes: 500 * 1024 ** 2,
      }),
    ).toBeNull();
    expect(
      nextMemoryLimit({ ...sample, currentMiB: 512, usedBytes: 10 }),
    ).toBeNull();
  });
  it("rejects unsupported values instead of silently lifting limits", () => {
    expect(() => validateMemoryPolicy({ ...policy, minMiB: 0 })).toThrow();
    expect(() => validateMemoryPolicy({ ...policy, maxMiB: 100 })).toThrow();
    expect(() => nextMemoryLimit({ ...sample, usedBytes: NaN })).toThrow();
    expect(() => nextMemoryLimit({ ...sample, currentMiB: 600 })).toThrow();
  });
  it("parses Docker stats binary and decimal units", () => {
    expect(parseDockerBytes("100.5MiB")).toBe(100.5 * 1024 ** 2);
    expect(parseDockerBytes("1.2GB")).toBe(1.2e9);
    expect(parseDockerBytes("0B")).toBe(0);
    expect(() => parseDockerBytes("N/A")).toThrow();
  });
});
describe("sandbox configuration boundary", () => {
  it("matches a non-root project owner's identity without ever granting root", () => {
    expect(sandboxIdentity(1000, 1000)).toEqual({ uid: 1000, gid: 1000 });
    expect(sandboxIdentity(501, 20)).toEqual({ uid: 501, gid: 20 });
    expect(sandboxIdentity(0, 0)).toEqual({ uid: 65532, gid: 65532 });
    expect(sandboxIdentity(1000, 0)).toEqual({ uid: 1000, gid: 65532 });
    expect(() => sandboxIdentity(-1, 1000)).toThrow();
    expect(() => sandboxIdentity(1.5, 1000)).toThrow();
  });
  it("inherits only the connected provider key, with the same HTTPS policy", () => {
    const connection = {
      url: "https://gateway.example.com/gateway",
      token: "lsh_" + "a".repeat(48),
      provider: "openai",
      storedCredential: true,
    };
    expect(savedSandboxGateway(connection)?.tokens).toEqual({
      openai: connection.token,
    });
    expect(savedSandboxGateway()).toBeUndefined();
    expect(() =>
      savedSandboxGateway({
        ...connection,
        url: "http://127.0.0.1:8789/gateway",
      }),
    ).toThrow("public HTTPS");
    expect(() =>
      savedSandboxGateway({ ...connection, provider: undefined }),
    ).toThrow("provider-scoped");
  });
  it("accepts only exact public hostnames", () => {
    expect(validateSandboxHostname("Docs.Docker.com")).toBe("docs.docker.com");
    for (const host of [
      "*",
      "*.example.com",
      "127.0.0.1",
      "localhost",
      "foo.local",
      "http://example.com",
      "example.com:443",
      "example.com.",
    ])
      expect(() => validateSandboxHostname(host)).toThrow();
  });
  it("rejects implicit broad host mounts", () => {
    for (const path of ["/", homedir()])
      expect(() => sandboxProject(path)).toThrow();
    expect(sandboxProject()).toBeUndefined();
  });
  it("requires private gateway keys and verified HTTPS destination", () => {
    const dir = mkdtempSync(join(tmpdir(), "leash-sandbox-test-"));
    try {
      const path = join(dir, "key"),
        token = "lsh_" + "a".repeat(48);
      writeFileSync(path, token, { mode: 0o600 });
      expect(
        readSandboxGateway("https://gateway.example.com/gateway", path)?.tokens
          .openai,
      ).toBe(token);
      expect(() =>
        readSandboxGateway("http://gateway.example.com/gateway", path),
      ).toThrow();
      chmodSync(path, 0o644);
      expect(() =>
        readSandboxGateway("https://gateway.example.com/gateway", path),
      ).toThrow();
      chmodSync(path, 0o600);
      symlinkSync(path, join(dir, "alias"));
      expect(() =>
        readSandboxGateway(
          "https://gateway.example.com/gateway",
          join(dir, "alias"),
        ),
      ).toThrow();
      writeFileSync(path, JSON.stringify({ openai: token }));
      expect(
        readSandboxGateway("https://gateway.example.com/gateway", path)?.tokens
          .anthropic,
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
