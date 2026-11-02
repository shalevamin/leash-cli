import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
export type GatewayConnection = {
  setupId?: string;
  url: string;
  token: string;
  orgId?: string;
  userId?: string;
  projectId?: string | null;
  keyId?: string;
  agent?: string;
  provider?: string;
  storedCredential?: boolean;
};
function assertPrivateFile(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      "Gateway vault must be an owned regular file, never a symlink",
    );
}
function master(dir: string, create: boolean) {
  const path = join(dir, "gateway-vault.key");
  if (create && !existsSync(path))
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  assertPrivateFile(path);
  const value = readFileSync(path);
  if (value.length !== 32)
    throw new Error(
      "Invalid gateway vault key. Restore the private key from backup; do not reset the ledger.",
    );
  chmodSync(path, 0o600);
  return value;
}
export function saveGateway(dir: string, connection: GatewayConnection) {
  const key = master(dir, true),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("leash-gateway-v1"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(connection), "utf8"),
    cipher.final(),
  ]);
  const path = join(dir, "gateway.vault"),
    temp = path + "." + randomUUID();
  writeFileSync(temp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, path);
  const old = join(dir, "gateway.json");
  if (existsSync(old)) unlinkSync(old);
}
export function loadGateway(dir: string): GatewayConnection | undefined {
  const path = join(dir, "gateway.vault");
  if (!existsSync(path)) {
    const legacy = join(dir, "gateway.json");
    if (!existsSync(legacy)) return;
    assertPrivateFile(legacy);
    return JSON.parse(readFileSync(legacy, "utf8"));
  }
  assertPrivateFile(path);
  const data = readFileSync(path);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    master(dir, false),
    data.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from("leash-gateway-v1"));
  decipher.setAuthTag(data.subarray(12, 28));
  const connection = JSON.parse(
    Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  );
  if (!connection.token?.startsWith("lsh_") || !connection.url)
    throw new Error("Invalid gateway vault");
  return connection;
}
export function removeGateway(dir: string) {
  for (const name of ["gateway.vault", "gateway.json"]) {
    const path = join(dir, name);
    if (existsSync(path)) unlinkSync(path);
  }
}
