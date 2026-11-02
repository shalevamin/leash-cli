import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { config } from "./config.js";
export type LocalProvider = "openai" | "anthropic" | "openrouter";
export const LOCAL_CREDENTIAL_MARKER = "leash-local-managed";
const aad = Buffer.from("leash-local-provider-v1"),
  service = "dev.useleash.provider-vault";
type Backend = "keychain" | "file";
type Entry = { secret: string; updatedAt: string };
type Envelope = {
  version: 1;
  backend: Backend;
  nonce: string;
  tag: string;
  ciphertext: string;
};
const file = (dir: string) => join(dir, "provider-secrets.vault");
function providerName(value: string): LocalProvider {
  if (value !== "openai" && value !== "anthropic" && value !== "openrouter")
    throw new Error("Provider must be openai, anthropic or openrouter");
  return value;
}
function safeFile(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      "Local vault files must be owner-only regular files (0600); refusing unsafe credential storage",
    );
}
function keychainAccount(dir: string) {
  return createHash("sha256").update(realpathSync(dir)).digest("hex");
}
function keychainRead(dir: string): Buffer | undefined {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", keychainAccount(dir), "-s", service, "-w"],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) return;
  const value = result.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid keychain vault master key");
  return Buffer.from(value, "hex");
}
function keychainCreate(dir: string): Buffer | undefined {
  const old = keychainRead(dir);
  if (old) return old;
  const key = randomBytes(32);
  // security's interactive mode receives the master through stdin, never argv or shell history.
  // Neither stdout nor stderr is forwarded; it may contain sensitive diagnostics.
  const result = spawnSync("/usr/bin/security", ["-i"], {
    input: `add-generic-password -a ${keychainAccount(dir)} -s ${service} -w ${key.toString("hex")}\nexit\n`,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) return;
  const stored = keychainRead(dir);
  return stored?.equals(key) ? key : stored;
}
function master(dir: string, backend: Backend, create = false) {
  if (backend === "keychain") {
    if (process.platform !== "darwin")
      throw new Error(
        "This local vault needs its original macOS keychain; it cannot be decrypted on this machine",
      );
    const value = create ? keychainCreate(dir) : keychainRead(dir);
    if (!value)
      throw new Error(
        "The macOS keychain vault key is unavailable or locked; unlock the original keychain. Existing secrets were preserved",
      );
    return value;
  }
  const path = join(dir, "provider-secrets.key");
  if (create && !existsSync(path))
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  if (!existsSync(path))
    throw new Error(
      "Local vault master key is missing; restore your private backup. Existing secrets were preserved",
    );
  safeFile(path);
  const value = readFileSync(path);
  if (value.length !== 32) throw new Error("Invalid local vault master key");
  return value;
}
function readVault(
  dir: string,
):
  | { backend: Backend; entries: Partial<Record<LocalProvider, Entry>> }
  | undefined {
  if (!existsSync(file(dir))) return;
  try {
    safeFile(file(dir));
    const data = JSON.parse(readFileSync(file(dir), "utf8")) as Envelope;
    if (data.version !== 1 || !["keychain", "file"].includes(data.backend))
      throw new Error("format");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      master(dir, data.backend),
      Buffer.from(data.nonce, "base64"),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(data.tag, "base64"));
    const entries = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(data.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      throw new Error("entries");
    for (const [provider, entry] of Object.entries(entries)) {
      providerName(provider);
      if (
        !entry ||
        typeof (entry as Entry).secret !== "string" ||
        typeof (entry as Entry).updatedAt !== "string"
      )
        throw new Error("entry");
    }
    return { backend: data.backend, entries };
  } catch {
    throw new Error(
      "Cannot authenticate/decrypt the local provider vault. Unlock its original keychain or restore the matching private key and vault backup; no plaintext or replacement key was used",
    );
  }
}
function writeVault(
  dir: string,
  backend: Backend,
  entries: Partial<Record<LocalProvider, Entry>>,
) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", master(dir, backend), nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(entries), "utf8"),
    cipher.final(),
  ]);
  const envelope: Envelope = {
    version: 1,
    backend,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
  const temp = `${file(dir)}.${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(envelope) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, file(dir));
  } finally {
    rmSync(temp, { force: true });
  }
}
export function saveLocalCredential(
  dir: string,
  provider: LocalProvider,
  secret: string,
  options: { backend?: Backend } = {},
) {
  providerName(provider);
  if (
    typeof secret !== "string" ||
    secret.length < 8 ||
    secret.length > 4096 ||
    /[\s\x00-\x1f\x7f]/.test(secret) ||
    secret.startsWith("leash-")
  )
    throw new Error(
      "Provider credential must be a nonempty API token without whitespace; its value was not logged",
    );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.getuid && directory.uid !== process.getuid())
  )
    throw new Error(
      "Vault directory must be a directory owned by the current user",
    );
  chmodSync(dir, 0o700);
  const existing = readVault(dir);
  let backend = existing?.backend ?? options.backend;
  if (existing && options.backend && existing.backend !== options.backend)
    throw new Error("Existing vault backend cannot be replaced implicitly");
  if (!backend)
    backend =
      process.platform === "darwin" && keychainCreate(dir)
        ? "keychain"
        : "file";
  if (!existing) master(dir, backend, true);
  writeVault(dir, backend, {
    ...existing?.entries,
    [provider]: { secret, updatedAt: new Date().toISOString() },
  });
  return { provider, storage: backend, imported: true };
}
export function loadLocalCredential(
  dir: string,
  provider: LocalProvider,
): string | undefined {
  return readVault(dir)?.entries[providerName(provider)]?.secret;
}
export function localCredentialMetadata(dir: string) {
  const data = readVault(dir);
  return Object.entries(data?.entries ?? {}).map(([provider, entry]) => ({
    provider: provider as LocalProvider,
    updatedAt: entry!.updatedAt,
    storage: data!.backend,
  }));
}
export function removeLocalCredential(dir: string, provider: LocalProvider) {
  providerName(provider);
  const data = readVault(dir);
  if (!data) return false;
  const existed = !!data.entries[provider];
  delete data.entries[provider];
  writeVault(dir, data.backend, data.entries);
  return existed;
}
export function localCredentialReadiness(
  dir: string,
  provider: LocalProvider,
  env: NodeJS.ProcessEnv = process.env,
) {
  const variable =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "OPENROUTER_API_KEY";
  const status = localCredentialMetadata(dir).some(
    (entry) => entry.provider === provider,
  )
    ? "local-vault"
    : env[variable]?.trim() && !env[variable]!.startsWith("leash-")
      ? "environment"
      : "missing";
  return {
    provider,
    status,
    environmentVariable: variable,
    connectionTested: false,
  } as const;
}
export function localAgentEnvironment(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const { provider } of localCredentialMetadata(dir)) {
    if (provider === "openai") next.OPENAI_API_KEY = LOCAL_CREDENTIAL_MARKER;
    else if (provider === "openrouter")
      next.OPENROUTER_API_KEY = LOCAL_CREDENTIAL_MARKER;
    else {
      next.ANTHROPIC_API_KEY = LOCAL_CREDENTIAL_MARKER;
      delete next.ANTHROPIC_AUTH_TOKEN;
    }
  }
  // A caller may have imported from a custom variable. Never inherit a matching plaintext secret under another name.
  const values = new Set(
    localCredentialMetadata(dir).map((entry) =>
      loadLocalCredential(dir, entry.provider),
    ),
  );
  for (const [name, value] of Object.entries(next))
    if (value && values.has(value)) delete next[name];
  return next;
}
export function localProviderRequest(
  dir: string,
  provider: string,
  incoming: string | undefined,
  upstream: string,
) {
  if (incoming !== LOCAL_CREDENTIAL_MARKER) return undefined;
  providerName(provider);
  const expected =
    provider === "openai"
      ? "https://api.openai.com"
      : provider === "openrouter"
        ? "https://openrouter.ai/api"
        : "https://api.anthropic.com";
  if (upstream.replace(/\/$/, "") !== expected)
    throw new Error(
      "Stored provider credentials are restricted to the official HTTPS provider endpoint; remove the custom upstream override",
    );
  const secret = loadLocalCredential(dir, providerName(provider));
  if (!secret)
    throw new Error(
      `No local ${provider} credential. Import it with leash secrets import --provider ${provider} --from-env ${provider === "openai" ? "OPENAI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"}`,
    );
  return { secret, base: expected };
}
function assertOutsideProject(dir: string) {
  for (let current = process.cwd(); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      const rel = relative(realpathSync(current), resolve(dir));
      if (!rel || (!rel.startsWith("..") && !isAbsolute(rel)))
        throw new Error(
          "LEASH_HOME must be outside the project before importing credentials; use ~/.leash",
        );
      break;
    }
    if (dirname(current) === current) break;
  }
}
export function registerLocalSecretsCommands(program: Command) {
  const secrets = program
    .command("secrets")
    .description(
      "Manage encrypted provider credentials locally; never upload or print their values",
    );
  secrets
    .command("import")
    .requiredOption("--provider <provider>", "openai, anthropic or openrouter")
    .requiredOption(
      "--from-env <name>",
      "Read this environment variable in the current process",
    )
    .option(
      "--storage <backend>",
      "keychain or file; macOS keychain preferred automatically",
    )
    .action((options) => {
      const provider = providerName(options.provider);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.fromEnv))
        throw new Error("Invalid environment variable name");
      if (options.storage && !["keychain", "file"].includes(options.storage))
        throw new Error("Storage must be keychain or file");
      const secret = process.env[options.fromEnv];
      if (!secret)
        throw new Error(
          `Environment variable ${options.fromEnv} is absent; export it in your own terminal, then rerun. Do not paste secrets into chat`,
        );
      const dir = config().dir;
      assertOutsideProject(dir);
      const result = saveLocalCredential(dir, provider, secret, {
        backend: options.storage,
      });
      console.log(JSON.stringify(result));
      if (result.storage === "file")
        console.log(
          "Master key: private 0600 file on this machine. Encryption does not protect against another process running as your OS user; use the managed runtime boundary for agents. No key was uploaded.",
        );
    });
  secrets
    .command("list")
    .description("List provider names, update times and storage backend only")
    .action(() =>
      console.log(
        JSON.stringify(localCredentialMetadata(config().dir), null, 2),
      ),
    );
  secrets
    .command("delete")
    .requiredOption("--provider <provider>", "openai, anthropic or openrouter")
    .action((options) =>
      console.log(
        JSON.stringify({
          provider: providerName(options.provider),
          deleted: removeLocalCredential(
            config().dir,
            providerName(options.provider),
          ),
        }),
      ),
    );
}
