import { localCredentialMetadata } from "./local-secrets.js";
import {
  relayCredential,
  startSandboxRelay,
  validateLocalProxyConnection,
  type LocalProxyConnection,
} from "./sandbox-relay.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { Command } from "commander";
import { config } from "./config.js";
import type { GatewayConnection } from "./gateway-vault.js";
import {
  defaultMemoryPolicy,
  nextMemoryLimit,
  parseDockerBytes,
  validateMemoryPolicy,
  type MemoryPolicy,
} from "./sandbox-memory.js";

const exec = promisify(execFile);
export const sandboxImage =
  "node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20";
const label = "dev.useleash.sandbox";
export type SandboxOptions = {
  command: string[];
  interactive?: boolean;
  image?: string;
  allowedHosts?: string[];
  project?: string;
  writableProject?: boolean;
  gatewayUrl?: string;
  gatewayKeyFile?: string;
  gatewayConnection?: { url: string; tokens: Record<string, string> };
  localProxyConnection?: LocalProxyConnection;
  memory?: Partial<MemoryPolicy>;
  onEvent?: (event: Record<string, unknown>) => void;
};
async function docker(args: string[], timeout = 30000) {
  const result = await exec("docker", args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}
export function validateSandboxHostname(value: string) {
  if (
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(
      value,
    ) ||
    /\.(localhost|local|internal)$/i.test(value)
  )
    throw new Error(
      "Allow hosts must be exact public DNS names; no IPs, ports or wildcards",
    );
  return value.toLowerCase();
}
function privateFile(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 65536 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      "Gateway key file must be owned by you, regular, not a symlink, and mode 0600 or stricter",
    );
  return readFileSync(path, "utf8").trim();
}
export function validateSandboxGateway(
  url: string,
  tokens: Record<string, string>,
) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (target.port && target.port !== "443") ||
    !/^\/gateway\/?$/.test(target.pathname)
  )
    throw new Error(
      "Managed sandboxes require a public HTTPS gateway on port443 ending /gateway. A local HTTP gateway cannot be used across the isolated boundary.",
    );
  validateSandboxHostname(target.hostname);
  if (
    !tokens ||
    !Object.keys(tokens).length ||
    Object.entries(tokens).some(
      ([provider, token]) =>
        !["openai", "anthropic"].includes(provider) ||
        typeof token !== "string" ||
        !/^lsh_[A-Za-z0-9_-]{40,}$/.test(token),
    )
  )
    throw new Error("Expected scoped lsh_ keys for openai and/or anthropic");
  return { url: target.toString(), tokens: { ...tokens } };
}
export function savedSandboxGateway(connection?: GatewayConnection) {
  if (!connection) return undefined;
  if (
    !connection.storedCredential ||
    !["openai", "anthropic"].includes(connection.provider ?? "")
  )
    throw new Error(
      "Reconnect with leash connect to provision a provider-scoped managed gateway, or pass an explicit --gateway-key-file",
    );
  return validateSandboxGateway(connection.url, {
    [connection.provider!]: connection.token,
  });
}
export function readSandboxGateway(url?: string, keyFile?: string) {
  if (!url && !keyFile) return undefined;
  if (!url || !keyFile)
    throw new Error("Both --gateway-url and --gateway-key-file are required");
  const content = privateFile(resolve(keyFile));
  const tokens: Record<string, string> = content.startsWith("{")
    ? JSON.parse(content)
    : { openai: content, anthropic: content };
  return validateSandboxGateway(url, tokens);
}
export function sandboxIdentity(
  callerUid = process.getuid?.() ?? 0,
  callerGid = process.getgid?.() ?? 0,
) {
  for (const value of [callerUid, callerGid])
    if (!Number.isInteger(value) || value < 0 || value > 2147483647)
      throw new Error("Invalid sandbox user identity");
  return { uid: callerUid || 65532, gid: callerGid || 65532 };
}
export function sandboxProject(path?: string) {
  if (!path) return undefined;
  const dir = realpathSync(resolve(path));
  const home = realpathSync(homedir());
  if (
    !lstatSync(dir).isDirectory() ||
    dir === sep ||
    dir === home ||
    home.startsWith(dir + sep) ||
    /(?:^|[\\/])(?:\.ssh|\.aws|\.leash|\.gnupg|\.config)(?:[\\/]|$)/.test(
      dir,
    ) ||
    dir.includes(",")
  )
    throw new Error(
      "Mount a specific project directory, never a home, system root, credential directory or parent of home",
    );
  return dir;
}
function egressSource() {
  const candidates = [
    new URL("./sandbox-egress.mjs", import.meta.url),
    new URL("../runtime/egress.mjs", import.meta.url),
  ];
  for (const path of candidates)
    if (existsSync(path)) return readFileSync(path, "utf8");
  throw new Error(
    "Sandbox broker is missing from this CLI distribution; reinstall the complete package",
  );
}
async function assertDocker() {
  const info = JSON.parse(await docker(["info", "--format", "{{json .}}"]));
  const version = JSON.parse(
    await docker(["version", "--format", "{{json .Server}}"]),
  );
  if (
    info.OSType !== "linux" ||
    info.CgroupVersion !== "2" ||
    !info.MemoryLimit ||
    !info.SwapLimit ||
    Number(version.Version.split(".")[0]) < 28
  )
    throw new Error(
      "Sandbox requires Docker Engine 28+, Linux containers, cgroup v2 and memory/swap limit support (Docker Desktop is supported)",
    );
  const context = JSON.parse(
    await docker([
      "context",
      "inspect",
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ]),
  );
  if (!context.startsWith("unix://"))
    throw new Error(
      "Sandbox currently requires a local Unix-socket Docker context for private scoped mounts",
    );
  return info;
}
export async function sandboxCapabilities() {
  try {
    const info = await assertDocker();
    return {
      supported: true as const,
      runtime: "Docker Linux / cgroup v2",
      availableMemoryMiB: Math.floor(info.MemTotal / 1024 ** 2),
      detail:
        "Each run verifies isolated network and actual memory settings before starting the agent",
    };
  } catch (error) {
    return {
      supported: false as const,
      detail:
        error instanceof Error
          ? error.message
          : "Docker capability check failed",
    };
  }
}
async function ensureImage(image: string) {
  if (!image || image.startsWith("-") || /\s/.test(image))
    throw new Error("Invalid image reference");
  try {
    await docker(["image", "inspect", image]);
  } catch {
    await docker(["pull", image], 180000);
  }
  const [metadata] = JSON.parse(await docker(["image", "inspect", image]));
  if (
    (metadata.Config?.Env ?? []).some((value: string) =>
      /^(?:.*_)?(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH)[^=]*=.+/i.test(
        value,
      ),
    )
  )
    throw new Error(
      "Runtime image contains credential-like environment variables; use a clean agent image",
    );
  return metadata.Id as string;
}
const hardened = [
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges=true",
  "--read-only",
  "--pids-limit",
  "256",
  "--init",
  "--log-driver",
  "local",
  "--log-opt",
  "max-size=5m",
  "--log-opt",
  "max-file=2",
];
export async function createManagedSandbox(options: SandboxOptions) {
  if (
    !options.command.length ||
    options.command.some(
      (part) => typeof part !== "string" || part.includes("\0"),
    )
  )
    throw new Error("Pass the agent command after --");
  const policy = validateMemoryPolicy({
    ...defaultMemoryPolicy,
    ...options.memory,
  });
  const hosts = [
    ...new Set((options.allowedHosts ?? []).map(validateSandboxHostname)),
  ];
  if (hosts.length > 64) throw new Error("At most 64 explicit outbound hosts");
  const project = sandboxProject(options.project),
    gateway = options.gatewayConnection
      ? validateSandboxGateway(
          options.gatewayConnection.url,
          options.gatewayConnection.tokens,
        )
      : readSandboxGateway(options.gatewayUrl, options.gatewayKeyFile);
  const localProxy = options.localProxyConnection
    ? validateLocalProxyConnection(options.localProxyConnection)
    : undefined;
  if (localProxy && gateway)
    throw new Error(
      "Choose local protected proxy or explicit cloud gateway, never both",
    );
  const relay = localProxy
    ? { token: relayCredential(), providers: localProxy.providers }
    : undefined;
  let relayController: ReturnType<typeof startSandboxRelay> | undefined;
  if (project && process.getuid?.() === 0)
    throw new Error(
      "Run project sandboxes as the non-root project owner; Leash never changes project ownership or runs an agent as root",
    );
  const info = await assertDocker();
  if (policy.maxMiB * 1024 ** 2 > info.MemTotal * 0.8)
    throw new Error(
      "Maximum sandbox memory must leave at least 20% of Docker VM memory for the host/control plane",
    );
  const agentImage = await ensureImage(options.image ?? sandboxImage),
    brokerImage = await ensureImage(sandboxImage);
  const id = "leash-sandbox-" + randomUUID().slice(0, 12),
    internal = id + "-isolated",
    external = id + "-egress",
    broker = id + "-broker";
  const runtimeHome = join(homedir(), ".leash", "runtimes");
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(runtimeHome, "leash-sandbox-"));
  chmodSync(temp, 0o700);
  const cfg = join(temp, "config.json"),
    source = join(temp, "egress.mjs"),
    heartbeat = join(temp, "heartbeat");
  writeFileSync(source, egressSource(), { mode: 0o444 });
  writeFileSync(cfg, JSON.stringify({ allowedHosts: hosts, gateway, relay }), {
    mode: 0o600,
  });
  writeFileSync(heartbeat, String(Date.now()), { mode: 0o600 });
  const heartbeatTimer = setInterval(() => {
    try {
      writeFileSync(heartbeat, String(Date.now()));
    } catch {
      clearInterval(heartbeatTimer);
    }
  }, 3000);
  heartbeatTimer.unref();
  const { uid, gid } = sandboxIdentity();
  if (process.getuid?.() === 0) {
    chownSync(cfg, uid, gid);
    chownSync(heartbeat, uid, gid);
  }
  const created: string[] = [],
    networks: string[] = [];
  let closed = false;
  const event = (value: Record<string, unknown>) =>
    options.onEvent?.({ sandbox: id, ...value });
  async function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    relayController?.stop();
    for (const container of created.reverse())
      await docker(["rm", "--force", "--volumes", container]).catch(() => {});
    for (const network of networks.reverse())
      await docker(["network", "rm", network]).catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
  try {
    await docker([
      "network",
      "create",
      "--internal",
      "--ipv6=false",
      "--opt",
      "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      "--label",
      label,
      internal,
    ]);
    networks.push(internal);
    const [network] = JSON.parse(
      await docker(["network", "inspect", internal]),
    );
    if (
      !network.Internal ||
      network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !==
        "isolated"
    )
      throw new Error("Docker failed to enforce isolated internal networking");
    await docker([
      "network",
      "create",
      "--ipv6=false",
      "--label",
      label,
      external,
    ]);
    networks.push(external);
    await docker([
      "create",
      "--name",
      broker,
      ...(relay ? ["--publish", "127.0.0.1::3128"] : []),
      "--label",
      label,
      ...hardened,
      "--user",
      `${uid}:${gid}`,
      "--memory",
      "128m",
      "--memory-swap",
      "128m",
      "--cpus",
      "0.5",
      "--network",
      external,
      "--sysctl",
      "net.ipv4.ip_forward=0",
      "--sysctl",
      "net.ipv6.conf.all.disable_ipv6=1",
      "--mount",
      `type=bind,src=${source},dst=/run/leash/egress.mjs,readonly`,
      "--mount",
      `type=bind,src=${cfg},dst=/run/leash/config.json,readonly`,
      "--mount",
      `type=bind,src=${heartbeat},dst=/run/leash/heartbeat,readonly`,
      "--entrypoint",
      "node",
      brokerImage,
      "/run/leash/egress.mjs",
    ]);
    created.push(broker);
    await docker(["network", "connect", internal, broker]);
    await docker(["start", broker]);
    const [b] = JSON.parse(await docker(["inspect", broker]));
    const ip = b.NetworkSettings.Networks[internal].IPAddress;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip))
      throw new Error("No isolated broker IPv4 address");
    let ready = false;
    for (let n = 0; n < 30; n++) {
      if ((await docker(["logs", broker])).includes("sandbox_egress_ready")) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error("Egress broker did not become ready");
    if (relay && localProxy) {
      const binding = b.NetworkSettings.Ports?.["3128/tcp"];
      if (
        binding?.length !== 1 ||
        binding[0].HostIp !== "127.0.0.1" ||
        !/^\d+$/.test(binding[0].HostPort)
      )
        throw new Error(
          "Private reverse relay was not bound exclusively to loopback",
        );
      relayController = startSandboxRelay(
        `http://127.0.0.1:${binding[0].HostPort}`,
        relay.token,
        localProxy,
        () => {
          void cleanup();
        },
      );
    }
    const proxy = `http://${ip}:3128`;
    const env = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
    ].flatMap((key) => ["--env", `${key}=${proxy}`]);
    env.push(
      "--env",
      "NO_PROXY=",
      "--env",
      "no_proxy=",
      "--env",
      "NODE_USE_ENV_PROXY=1",
      "--env",
      "HOME=/tmp/leash-home",
    );
    if (gateway || relay)
      env.push(
        "--env",
        `OPENAI_BASE_URL=${proxy}/llm/openai/v1`,
        "--env",
        `ANTHROPIC_BASE_URL=${proxy}/llm/anthropic`,
        "--env",
        "OPENAI_API_KEY=leash-sidecar-injects-credential",
        "--env",
        "ANTHROPIC_API_KEY=leash-sidecar-injects-credential",
        "--env",
        `OPENROUTER_BASE_URL=${proxy}/llm/openrouter/v1`,
        "--env",
        "OPENROUTER_API_KEY=leash-sidecar-injects-credential",
        "--env",
        `NO_PROXY=${ip}`,
        "--env",
        `no_proxy=${ip}`,
      );
    const mounts = project
      ? [
          "--mount",
          `type=bind,src=${project},dst=/workspace${options.writableProject ? "" : ",readonly"}`,
        ]
      : [
          "--tmpfs",
          `/workspace:rw,nosuid,nodev,size=268435456,uid=${uid},gid=${gid}`,
        ];
    await docker([
      "create",
      "--name",
      id,
      "--label",
      label,
      "--label",
      `${label}.role=agent`,
      "--label",
      `${label}.storage=${basename(temp)}`,
      ...(options.interactive ? ["--interactive", "--tty"] : []),
      ...hardened,
      "--user",
      `${uid}:${gid}`,
      "--memory",
      `${policy.minMiB}m`,
      "--memory-swap",
      `${policy.minMiB}m`,
      "--cpus",
      "2",
      "--network",
      internal,
      "--dns",
      "127.0.0.1",
      "--sysctl",
      "net.ipv4.ip_forward=0",
      "--sysctl",
      "net.ipv6.conf.all.disable_ipv6=1",
      "--tmpfs",
      `/tmp:rw,nosuid,nodev,size=134217728,uid=${uid},gid=${gid}`,
      "--workdir",
      "/workspace",
      ...mounts,
      ...env,
      "--entrypoint",
      options.command[0],
      agentImage,
      ...options.command.slice(1),
    ]);
    created.push(id);
    const inspect = async () => JSON.parse(await docker(["inspect", id]))[0];
    const state = await inspect();
    if (
      state.HostConfig.Memory !== policy.minMiB * 1024 ** 2 ||
      state.HostConfig.MemorySwap !== policy.minMiB * 1024 ** 2 ||
      Object.keys(state.NetworkSettings.Networks).length !== 1 ||
      !state.HostConfig.ReadonlyRootfs ||
      state.Config.User !== `${uid}:${gid}`
    )
      throw new Error(
        "Docker did not apply sandbox isolation or memory limits",
      );
    event({
      type: "sandbox_ready",
      allowedHosts: hosts,
      memoryMinMiB: policy.minMiB,
      memoryMaxMiB: policy.maxMiB,
      projectMode: project
        ? options.writableProject
          ? "writable"
          : "read-only"
        : "ephemeral",
      gateway: !!gateway,
      localProtectedRelay: !!relay,
    });
    return {
      id,
      broker,
      internalNetwork: internal,
      externalNetwork: external,
      policy,
      cleanup,
      inspect,
      brokerRunning: async () =>
        JSON.parse(await docker(["inspect", broker]))[0].State
          .Running as boolean,
      start: () => docker(["start", id]),
      logs: () => docker(["logs", id]),
      execute: (command: string[]) => docker(["exec", id, ...command]),
      pause: () => docker(["pause", id]),
      unpause: () => docker(["unpause", id]),
      stop: () => docker(["stop", "--time", "5", id]),
      stats: async () => {
        const raw = JSON.parse(
          await docker(["stats", "--no-stream", "--format", "{{json .}}", id]),
        );
        const [usage, limit] = String(raw.MemUsage).split("/");
        return {
          usedBytes: parseDockerBytes(usage),
          limitBytes: parseDockerBytes(limit),
        };
      },
      updateMemory: async (miB: number) => {
        if (
          !Number.isInteger(miB) ||
          miB < policy.minMiB ||
          miB > policy.maxMiB
        )
          throw new Error("Memory update exceeds sandbox bounds");
        const before = await inspect();
        if (miB * 1024 ** 2 < before.HostConfig.Memory)
          throw new Error(
            "Live shrinking is disabled to avoid killing active work",
          );
        await docker([
          "update",
          "--memory",
          `${miB}m`,
          "--memory-swap",
          `${miB}m`,
          id,
        ]);
        const after = await inspect();
        if (
          after.HostConfig.Memory !== miB * 1024 ** 2 ||
          after.HostConfig.MemorySwap !== miB * 1024 ** 2
        )
          throw new Error("Docker did not enforce requested memory update");
        event({
          type: "sandbox_memory_scaled",
          fromMiB: before.HostConfig.Memory / 1024 ** 2,
          toMiB: miB,
        });
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export async function runManagedSandbox(options: SandboxOptions) {
  const interactive = options.interactive ?? !!process.stdin.isTTY;
  const handle = await createManagedSandbox({ ...options, interactive });
  let stopped = false,
    currentMiB = handle.policy.minMiB,
    lastChangeAt = 0;
  const stop = () => {
    stopped = true;
    void handle.stop().catch(() => {});
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const attached = spawn(
      "docker",
      [
        "start",
        "--attach",
        ...(interactive ? ["--interactive"] : []),
        handle.id,
      ],
      { stdio: [interactive ? "inherit" : "ignore", "inherit", "inherit"] },
    );
    const completion = new Promise<number>((resolve, reject) => {
      attached.once("error", reject);
      attached.once("exit", (code) => {
        stopped = true;
        resolve(code ?? 1);
      });
    });
    let failure: unknown;
    const monitor = (async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 1500));
        if (stopped) break;
        try {
          const state = await handle.inspect();
          if (!state.State.Running) break;
          if (!(await handle.brokerRunning()))
            throw new Error("Sandbox network broker stopped");
          if (state.State.Paused) continue;
          const stats = await handle.stats();
          const now = Date.now(),
            next = nextMemoryLimit({
              usedBytes: stats.usedBytes,
              currentMiB,
              lastChangeAt,
              now,
              policy: handle.policy,
            });
          if (next) {
            await handle.updateMemory(next);
            currentMiB = next;
            lastChangeAt = now;
          }
        } catch (error) {
          if (!stopped) {
            failure = error;
            stop();
          }
        }
      }
    })();
    const code = await completion;
    await monitor;
    if (failure)
      throw new Error(
        "Sandbox monitoring failed; the agent was stopped instead of continuing without resource supervision",
        { cause: failure },
      );
    const state = await handle.inspect();
    options.onEvent?.({
      type: "sandbox_exit",
      exitCode: state.State.ExitCode,
      oomKilled: state.State.OOMKilled,
      restarted: false,
    });
    return state.State.ExitCode || code;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await handle.cleanup();
  }
}
async function managedAgent(id: string) {
  if (!/^leash-sandbox-[0-9a-f]{8}-[0-9a-f]{3}$/.test(id))
    throw new Error("Use a sandbox ID returned by leash sandbox list");
  const [state] = JSON.parse(await docker(["inspect", id]));
  if (state.Config.Labels?.[`${label}.role`] !== "agent")
    throw new Error("This is not a Leash-managed agent container");
  return state;
}
export async function stopManagedSandbox(id: string) {
  const state = await managedAgent(id);
  const remove = async (args: string[]) => {
    try {
      await docker(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/No such (?:container|network)|network .+ not found/.test(message))
        throw error;
    }
  };
  // Close egress first, then stop computation. Never report a failed Docker removal as success.
  for (const name of [id + "-broker", id])
    await remove(["rm", "--force", "--volumes", name]);
  for (const name of [id + "-isolated", id + "-egress"])
    await remove(["network", "rm", name]);
  const storage = state.Config.Labels?.[`${label}.storage`];
  if (
    typeof storage === "string" &&
    /^leash-sandbox-[A-Za-z0-9]+$/.test(storage)
  )
    rmSync(join(homedir(), ".leash", "runtimes", storage), {
      recursive: true,
      force: true,
    });
}
export function registerSandboxCommands(program: Command) {
  const sandbox = program
    .command("sandbox")
    .description(
      "Run a managed agent inside a governed Docker network with adaptive memory limits",
    );
  sandbox
    .command("list")
    .description("List managed agent containers, including interrupted runs")
    .action(async () => {
      console.log(
        await docker([
          "ps",
          "--all",
          "--filter",
          `label=${label}.role=agent`,
          "--format",
          "{{json .}}",
        ]),
      );
    });
  sandbox
    .command("stop <id>")
    .description("Stop and remove a managed run and its isolated networks")
    .action(async (id: string) => {
      await stopManagedSandbox(id);
    });
  for (const [name, dockerCommand] of [
    ["pause", "pause"],
    ["resume", "unpause"],
  ])
    sandbox
      .command(`${name} <id>`)
      .description(
        `${name} the same managed process without replaying any calls`,
      )
      .action(async (id: string) => {
        await managedAgent(id);
        await docker([dockerCommand, id]);
      });
  sandbox
    .command("run")
    .description(
      "Start a fresh isolated runtime; provider credentials stay in the egress sidecar",
    )
    .argument("<command...>", "Agent executable and arguments (after --)")
    .option("--image <image>", "Trusted Linux agent image", sandboxImage)
    .option(
      "--allow-host <hostname>",
      "Allow exact public outbound hostname (repeat)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--project <directory>",
      "Explicit project directory mounted read-only",
    )
    .option(
      "--writable-project",
      "Allow writes to the explicit project directory",
    )
    .option(
      "--gateway-url <url>",
      "Public HTTPS Leash gateway, ending /gateway",
    )
    .option(
      "--gateway-key-file <file>",
      "Private lsh_ key file or JSON openai/anthropic keys; mounted into sidecar only",
    )
    .option(
      "--no-gateway",
      "Run without a model gateway; do not load saved workspace credentials",
    )
    .option("--memory-min <MiB>", "Initial memory limit in MiB", "512")
    .option("--memory-max <MiB>", "Memory growth ceiling in MiB", "2048")
    .action(async (command: string[], opts) => {
      if (opts.writableProject && !opts.project)
        throw new Error("--writable-project requires --project");
      if (!opts.gateway && (opts.gatewayUrl || opts.gatewayKeyFile))
        throw new Error(
          "--no-gateway cannot be combined with explicit gateway flags",
        );
      const cfg = config();
      const gatewayConnection =
        opts.gateway && !opts.gatewayUrl && !opts.gatewayKeyFile
          ? savedSandboxGateway(cfg.gateway)
          : undefined;
      let localProxyConnection: LocalProxyConnection | undefined;
      if (
        !gatewayConnection &&
        !opts.gatewayUrl &&
        !opts.gatewayKeyFile &&
        opts.gateway
      ) {
        const providers = localCredentialMetadata(cfg.dir).map(
          (entry) => entry.provider,
        );
        if (providers.length) {
          const url = `http://127.0.0.1:${cfg.port}`,
            headers = {
              "content-type": "application/json",
              "x-leash-local-token": cfg.token,
            };
          const status = await fetch(`${url}/control/status`, {
            headers,
            signal: AbortSignal.timeout(3000),
          }).catch(() => {
            throw new Error(
              "Start the protected local proxy with leash start before launching a local-credential sandbox",
            );
          });
          if (
            !status.ok ||
            ((await status.json()) as any).transport === "gateway"
          )
            throw new Error(
              "The protected local proxy is unavailable or uses a cloud transport; local credentials remain local",
            );
          const created = await fetch(`${url}/control/sessions`, {
            method: "POST",
            headers,
            body: JSON.stringify({ agent: "managed-runtime" }),
            signal: AbortSignal.timeout(3000),
          });
          if (!created.ok)
            throw new Error(
              `Protected proxy refused sandbox session (${created.status}); existing caps and kill state remain enforced`,
            );
          const session = (await created.json()) as any;
          localProxyConnection = {
            url,
            token: cfg.token,
            sessionId: session.id,
            providers,
          };
        }
      }
      try {
        process.exitCode = await runManagedSandbox({
          command,
          image: opts.image,
          allowedHosts: opts.allowHost,
          project: opts.project,
          writableProject: opts.writableProject,
          gatewayUrl: opts.gatewayUrl,
          gatewayKeyFile: opts.gatewayKeyFile,
          gatewayConnection,
          localProxyConnection,
          memory: {
            minMiB: Number(opts.memoryMin),
            maxMiB: Number(opts.memoryMax),
          },
          onEvent: (event) =>
            process.stderr.write(JSON.stringify(event) + "\n"),
        });
      } finally {
        if (localProxyConnection)
          await fetch(
            `${localProxyConnection.url}/control/sessions/${localProxyConnection.sessionId}/end`,
            {
              method: "POST",
              headers: { "x-leash-local-token": localProxyConnection.token },
              signal: AbortSignal.timeout(3000),
            },
          ).catch(() => {
            process.stderr.write(
              "Sandbox stopped; session end metadata could not reach the local proxy. Existing spend and kill state remain saved.\n",
            );
          });
      }
    });
}
