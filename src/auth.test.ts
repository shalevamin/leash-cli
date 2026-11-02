import { afterEach, expect, it, vi } from "vitest";
import { login, validateURL } from "./auth.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("starts login at the hosted HTTPS API by default", async () => {
  vi.stubEnv("LEASH_API_URL", undefined);
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "fixture stop" }), { status: 503 }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(login({ browser: false })).rejects.toThrow("fixture stop");
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.useleash.dev/auth/device/start",
    expect.objectContaining({ redirect: "error", method: "POST" }),
  );
});
it("rejects remote HTTP and credential-bearing API URLs", () => {
  for (const url of [
    "http://api.example.com",
    "https://user:password@example.com",
    "https://example.com?token=fixture",
    "https://example.com#fragment",
  ])
    expect(() => validateURL(url)).toThrow();
  expect(validateURL("http://127.0.0.1:8788/")).toBe("http://127.0.0.1:8788");
});
