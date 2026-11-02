/** Stable loop identity. Provider-generated IDs are deliberately excluded. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function requestFingerprint(body: Record<string, any>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = Array.isArray(body.input) ? body.input : [];
  const calls: Array<{ name: string; arguments: unknown }> = [];
  // Only the latest assistant tool turn; older calls should not mask a new action.
  for (const item of [...messages, ...input].reverse()) {
    if (
      item?.role === "user" &&
      !(
        Array.isArray(item.content) &&
        item.content.every((v: any) => v?.type === "tool_result")
      )
    )
      break;
    if (
      item?.role === "assistant" &&
      !item.tool_calls &&
      !Array.isArray(item.content)
    )
      break;
    const found: any[] = [];
    if (item?.type === "function_call") found.push(item);
    if (Array.isArray(item?.tool_calls)) found.push(...item.tool_calls);
    if (Array.isArray(item?.content))
      found.push(...item.content.filter((x: any) => x?.type === "tool_use"));
    for (const tool of found) {
      let args = tool.function?.arguments ?? tool.arguments ?? tool.input;
      try {
        if (typeof args === "string") args = JSON.parse(args);
      } catch {}
      calls.push({
        name: tool.function?.name ?? tool.name ?? "unknown",
        arguments: args,
      });
    }
    if (calls.length) break;
  }
  if (calls.length)
    return canonical({
      model: body.model,
      system: body.system ?? body.instructions,
      toolCalls: calls,
    });
  return canonical({
    model: body.model,
    system: body.system ?? body.instructions,
    messages: messages.slice(-3),
    input: input.length ? input.slice(-3) : body.input,
    tools: body.tools,
  });
}
