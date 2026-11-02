import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveLocalCredential,
  loadLocalCredential,
  localCredentialMetadata,
  localCredentialReadiness,
  removeLocalCredential,
  localAgentEnvironment,
  localProviderRequest,
  LOCAL_CREDENTIAL_MARKER,
} from "./local-secrets.js";
import { detectAgents, resolveDetectedAgent } from "./detect.js";
import { Store } from "./state.js";
import { install, uninstall } from "./install.js";
import { createProxy } from "./proxy.js";
import { defaultPolicy } from "./core/index.js";
const paths: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "leash-vault-test-"));
  paths.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of paths.splice(0))
    rmSync(path, { recursive: true, force: true });
});
describe("local-only provider vault", () => {
  it("encrypts provider secrets, lists metadata only and decrypts after restart", () => {
    const dir = temp(),
      secret = "test-credential-value-never-in-output";
    saveLocalCredential(dir, "openai", secret, { backend: "file" });
    saveLocalCredential(dir, "anthropic", "test-anthropic-other-value", {
      backend: "file",
    });
    expect(loadLocalCredential(dir, "openai")).toBe(secret);
    expect(
      readFileSync(join(dir, "provider-secrets.vault"), "utf8"),
    ).not.toContain(secret);
    expect(statSync(join(dir, "provider-secrets.vault")).mode & 0o777).toBe(
      0o600,
    );
    expect(statSync(join(dir, "provider-secrets.key")).mode & 0o777).toBe(
      0o600,
    );
    expect(JSON.stringify(localCredentialMetadata(dir))).not.toContain(secret);
    expect(removeLocalCredential(dir, "openai")).toBe(true);
    expect(loadLocalCredential(dir, "openai")).toBeUndefined();
    expect(loadLocalCredential(dir, "anthropic")).toBe(
      "test-anthropic-other-value",
    );
  });
  it("fails closed on tampering or a missing master without overwriting the vault", () => {
    const dir = temp();
    saveLocalCredential(dir, "openai", "test-secret-value", {
      backend: "file",
    });
    const path = join(dir, "provider-secrets.vault"),
      data = JSON.parse(readFileSync(path, "utf8"));
    const bytes = Buffer.from(data.ciphertext, "base64");
    bytes[0] ^= 1;
    data.ciphertext = bytes.toString("base64");
    writeFileSync(path, JSON.stringify(data));
    expect(() => loadLocalCredential(dir, "openai")).toThrow(
      "authenticate/decrypt",
    );
    expect(() =>
      saveLocalCredential(dir, "openai", "test-new-secret", {
        backend: "file",
      }),
    ).toThrow("authenticate/decrypt");
    rmSync(join(dir, "provider-secrets.key"));
    expect(() => loadLocalCredential(dir, "openai")).toThrow(
      "authenticate/decrypt",
    );
  });
  it("strips actual secrets and custom aliases from agent environment while using harmless markers", () => {
    const dir = temp();
    saveLocalCredential(dir, "openai", "test-openai-secret", {
      backend: "file",
    });
    saveLocalCredential(dir, "anthropic", "test-claude-secret", {
      backend: "file",
    });
    saveLocalCredential(dir, "openrouter", "test-router-secret", {
      backend: "file",
    });
    const env = localAgentEnvironment(dir, {
      OPENAI_API_KEY: "test-openai-secret",
      MY_KEY: "test-openai-secret",
      ANTHROPIC_API_KEY: "other-ambient-key",
      ANTHROPIC_AUTH_TOKEN: "oauth-sensitive",
      OPENROUTER_API_KEY: "test-router-secret",
      PATH: "/bin",
    });
    expect(env).toEqual({
      OPENAI_API_KEY: LOCAL_CREDENTIAL_MARKER,
      ANTHROPIC_API_KEY: LOCAL_CREDENTIAL_MARKER,
      OPENROUTER_API_KEY: LOCAL_CREDENTIAL_MARKER,
      PATH: "/bin",
    });
    expect(JSON.stringify(env)).not.toContain("secret");
  });
  it("only substitutes the explicit marker and never sends a stored key to a custom upstream", () => {
    const dir = temp();
    saveLocalCredential(dir, "openai", "test-openai-secret", {
      backend: "file",
    });
    expect(
      localProviderRequest(
        dir,
        "openai",
        "foreign-key",
        "https://elsewhere.invalid",
      ),
    ).toBeUndefined();
    expect(() =>
      localProviderRequest(
        dir,
        "openai",
        LOCAL_CREDENTIAL_MARKER,
        "https://elsewhere.invalid",
      ),
    ).toThrow("official HTTPS");
    expect(
      localProviderRequest(
        dir,
        "openai",
        LOCAL_CREDENTIAL_MARKER,
        "https://api.openai.com",
      )?.secret,
    ).toBe("test-openai-secret");
  });
  it("proxy requires local auth before injecting and preserves a supplied foreign credential", async () => {
    const dir = temp(),
      store = new Store(dir);
    saveLocalCredential(dir, "openai", "test-vault-secret", {
      backend: "file",
    });
    const app = createProxy(store, {
        dir,
        path: "",
        token: "local-control",
        port: 8787,
        policy: defaultPolicy,
        prices: {},
      }),
      sid = store.create("codex", 10).id;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ usage: { input_tokens: 10, output_tokens: 1 } }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    const request = (key: string, auth?: string) =>
      app.request(`/s/${sid}/openai/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
          ...(auth ? { "x-leash-local-token": auth } : {}),
        },
        body: JSON.stringify({
          model: "gpt-4o",
          input: "hello",
          max_output_tokens: 10,
        }),
      });
    try {
      expect((await request(LOCAL_CREDENTIAL_MARKER)).status).toBe(401);
      expect(fetch).not.toHaveBeenCalled();
      const result = await request(LOCAL_CREDENTIAL_MARKER, "local-control");
      await result.text();
      expect(result.status).toBe(200);
      expect(
        new Headers(fetch.mock.calls[0][1]?.headers).get("authorization"),
      ).toBe("Bearer test-vault-secret");
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ usage: { input_tokens: 10, output_tokens: 1 } }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      await (await request("foreign-provider-key", "local-control")).text();
      expect(
        new Headers(fetch.mock.calls[1][1]?.headers).get("authorization"),
      ).toBe("Bearer foreign-provider-key");
      expect(JSON.stringify(store.all("event"))).not.toContain(
        "test-vault-secret",
      );
    } finally {
      store.db.close();
    }
  });
});
describe("provider readiness is explicit", () => {
  it("never claims a missing or untested provider is ready", () => {
    const dir = temp();
    expect(localCredentialReadiness(dir, "openai", {}).status).toBe("missing");
    expect(
      localCredentialReadiness(dir, "openai", {
        OPENAI_API_KEY: LOCAL_CREDENTIAL_MARKER,
      }).status,
    ).toBe("missing");
    expect(
      localCredentialReadiness(dir, "openrouter", {
        OPENROUTER_API_KEY: "test-private-key",
      }),
    ).toEqual({
      provider: "openrouter",
      status: "environment",
      environmentVariable: "OPENROUTER_API_KEY",
      connectionTested: false,
    });
    saveLocalCredential(dir, "openai", "test-local-key", { backend: "file" });
    expect(localCredentialReadiness(dir, "openai", {}).status).toBe(
      "local-vault",
    );
  });
});
describe("agent installer with a local vault", () => {
  it("stores only the marker in both agent configurations and restores original files", () => {
    const dir = temp(),
      home = temp(),
      original = process.env.LEASH_HOME;
    process.env.LEASH_HOME = dir;
    try {
      saveLocalCredential(dir, "openai", "test-installed-openai-secret", {
        backend: "file",
      });
      saveLocalCredential(dir, "anthropic", "test-installed-anthropic-secret", {
        backend: "file",
      });
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-4o"\n');
      mkdirSync(join(home, ".claude"));
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ env: { KEEP: "yes" } }),
      );
      const codex = install("codex", home),
        claude = install("claude-code", home);
      for (const result of [codex, claude]) {
        const text = readFileSync(result.path, "utf8");
        expect(text).toContain(LOCAL_CREDENTIAL_MARKER);
        expect(text).not.toContain("test-installed");
      }
      expect(JSON.parse(readFileSync(claude.path, "utf8")).env.KEEP).toBe(
        "yes",
      );
      uninstall("codex", home);
      uninstall("claude-code", home);
      expect(readFileSync(codex.path, "utf8")).toBe('model = "gpt-4o"\n');
      expect(JSON.parse(readFileSync(claude.path, "utf8"))).toEqual({
        env: { KEEP: "yes" },
      });
    } finally {
      if (original === undefined) delete process.env.LEASH_HOME;
      else process.env.LEASH_HOME = original;
    }
  });
});
describe("safe noninteractive agent detection", () => {
  it("does not let a learned proposal override explicit selection or observed adapter evidence", () => {
    const home = temp();
    const detected = detectAgents({
      home,
      env: { PATH: "", CODEX_THREAD_ID: "private-context" },
    });
    const contradicted = {
      ...detected,
      classification: {
        ...detected.classification,
        label: "claude-code" as const,
      },
    };
    expect(() => resolveDetectedAgent("auto", contradicted)).toThrow();
    expect(resolveDetectedAgent("codex", contradicted)).toBe("codex");
    expect(resolveDetectedAgent("auto", contradicted, "claude-code")).toBe(
      "claude-code",
    );
  });
  it("uses PATH/config existence without reading auth and returns booleans only", () => {
    const home = temp(),
      bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex"), 0o700);
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      "unparseable secret content",
    );
    const result = detectAgents({
      home,
      env: {
        PATH: bin,
        OPENAI_API_KEY: "test-secret",
        OPENROUTER_API_KEY: "another-secret",
      },
    });
    expect(result.agents.map((a) => a.installed)).toEqual([true, true]);
    expect(result.providers.openrouter.environmentPresent).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(() => resolveDetectedAgent("auto", result)).toThrow("Both");
    expect(resolveDetectedAgent("auto", result, "codex")).toBe("codex");
  });
  it("prefers the active execution context without exposing context values and keeps explicit plans authoritative", () => {
    const home = temp(),
      env = { PATH: "", CODEX_THREAD_ID: "private-thread-identity" };
    const detected = detectAgents({ home, env });
    expect(JSON.stringify(detected)).not.toContain("private-thread-identity");
    expect(resolveDetectedAgent("auto", detected)).toBe("codex");
    expect(resolveDetectedAgent("auto", detected, "claude-code")).toBe(
      "claude-code",
    );
    expect(
      resolveDetectedAgent(
        "auto",
        detectAgents({ home, env: { PATH: "", CLAUDECODE: "1" } }),
      ),
    ).toBe("claude-code");
    expect(() =>
      resolveDetectedAgent(
        "auto",
        detectAgents({ home, env: { ...env, CLAUDECODE: "1" } }),
      ),
    ).toThrow("No supported");
  });
  it("resolves one installed agent and fails clearly when none are installed", () => {
    const home = temp(),
      empty = detectAgents({ home, env: { PATH: "" } });
    expect(() => resolveDetectedAgent("auto", empty)).toThrow("No supported");
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), "not read");
    expect(
      resolveDetectedAgent("auto", detectAgents({ home, env: { PATH: "" } })),
    ).toBe("codex");
  });
});
