export function listenHost(env: Record<string, string | undefined>) {
  return env.LEASH_BIND?.trim() || "127.0.0.1";
}
