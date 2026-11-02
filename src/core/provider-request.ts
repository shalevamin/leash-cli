export function isClientTool(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  if (tool.type === "namespace")
    return (
      Array.isArray(tool.tools) &&
      tool.tools.every(
        (child) =>
          child &&
          typeof child === "object" &&
          !Array.isArray(child) &&
          ["function", "custom"].includes(child.type),
      )
    );
  // Anthropic client tools omit type; OpenAI spells function/custom explicitly.
  return (
    tool.type === undefined ||
    (typeof tool.type === "string" &&
      ["function", "custom"].includes(tool.type))
  );
}

// Only inline requests at the snapshot's standard rates are supported. Provider
// account defaults must not silently select a premium tier or inference region.
export function standardProviderRequest(
  provider: string,
  body: Record<string, any>,
): Record<string, any> {
  if (body.background !== undefined && body.background !== false)
    throw new Error(
      "Background responses are not supported; use an inline request so Leash can stop its active stream",
    );
  const tier = provider === "anthropic" ? "standard_only" : "default";
  if (
    (body.service_tier !== undefined && body.service_tier !== tier) ||
    (body.speed !== undefined && body.speed !== "standard") ||
    (body.inference_geo !== undefined && body.inference_geo !== "global")
  )
    throw new Error(
      "Premium service tiers, fast mode and regional inference require explicit pricing support; use standard speed and global inference",
    );
  if (provider !== "openai" && provider !== "anthropic") return body;
  const result: Record<string, any> = { ...body, service_tier: tier };
  if (provider === "anthropic") {
    const version = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(
      body.model,
    );
    const regional = version
      ? Number(version[1]) > 4 ||
        (Number(version[1]) === 4 && Number(version[2]) >= 6)
      : /^claude-(?:fable|mythos)-/.test(body.model);
    // Older Claude models reject this field. Current models can inherit a paid
    // US-only workspace default, so explicitly request the supported global rate.
    // A workspace that forbids global inference rejects upstream; never retry in
    // another region or replace an explicit regional request.
    if (regional) result.inference_geo = "global";
  }
  return result;
}
