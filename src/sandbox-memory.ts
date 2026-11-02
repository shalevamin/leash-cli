export type MemoryPolicy = {
  minMiB: number;
  maxMiB: number;
  cooldownMs: number;
  threshold: number;
};
export const defaultMemoryPolicy: MemoryPolicy = {
  minMiB: 512,
  maxMiB: 2048,
  cooldownMs: 10000,
  threshold: 0.75,
};
export function validateMemoryPolicy(policy: MemoryPolicy) {
  if (
    !Number.isInteger(policy.minMiB) ||
    !Number.isInteger(policy.maxMiB) ||
    policy.minMiB < 64 ||
    policy.maxMiB < policy.minMiB ||
    policy.maxMiB > 65536 ||
    !Number.isFinite(policy.cooldownMs) ||
    policy.cooldownMs < 1000 ||
    !Number.isFinite(policy.threshold) ||
    policy.threshold < 0.5 ||
    policy.threshold > 0.9
  )
    throw new Error(
      "Invalid memory policy: use integer MiB, 64 <= min <= max <= 65536",
    );
  return policy;
}
export function parseDockerBytes(value: string) {
  const match =
    /^\s*(\d+(?:\.\d+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)\s*$/.exec(value);
  if (!match) throw new Error("Invalid Docker memory statistic");
  const units: Record<string, number> = {
    B: 1,
    kB: 1000,
    KB: 1000,
    KiB: 1024,
    MB: 1e6,
    MiB: 1024 ** 2,
    GB: 1e9,
    GiB: 1024 ** 3,
    TB: 1e12,
    TiB: 1024 ** 4,
  };
  const amount = Number(match[1]) * units[match[2]];
  if (!Number.isFinite(amount) || amount < 0)
    throw new Error("Invalid Docker memory statistic");
  return amount;
}
export function nextMemoryLimit({
  usedBytes,
  currentMiB,
  lastChangeAt,
  now,
  policy,
}: {
  usedBytes: number;
  currentMiB: number;
  lastChangeAt: number;
  now: number;
  policy: MemoryPolicy;
}): number | null {
  validateMemoryPolicy(policy);
  if (
    !Number.isFinite(usedBytes) ||
    usedBytes < 0 ||
    !Number.isInteger(currentMiB) ||
    currentMiB < policy.minMiB ||
    currentMiB > policy.maxMiB ||
    !Number.isFinite(now) ||
    !Number.isFinite(lastChangeAt)
  )
    throw new Error("Invalid memory sample");
  if (
    now - lastChangeAt < policy.cooldownMs ||
    usedBytes / (currentMiB * 1024 ** 2) < policy.threshold ||
    currentMiB >= policy.maxMiB
  )
    return null;
  return Math.min(
    policy.maxMiB,
    Math.ceil(Math.max(currentMiB * 1.5, usedBytes / 1024 ** 2 / 0.6) / 64) *
      64,
  );
}
