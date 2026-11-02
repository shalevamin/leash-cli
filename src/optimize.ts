import { createReadStream, writeFileSync } from "node:fs";
import {
  MAX_TOOL_OUTPUT_CHARS,
  optimizeToolOutput,
  type ToolCompressionMode,
} from "./core/index.js";

export async function optimize(
  file: string | undefined,
  options: { mode?: string; json?: boolean; output?: string },
) {
  if (options.mode && options.mode !== "off" && options.mode !== "lossless")
    throw new Error("--mode must be off or lossless");
  if ((!file || file === "-") && process.stdin.isTTY)
    throw new Error(
      "Pass a tool-output file or pipe UTF-8 text into leash optimize -",
    );
  const stream = file && file !== "-" ? createReadStream(file) : process.stdin;
  // Up to 4 UTF-8 bytes per code unit; the pure optimizer applies the char limit.
  const maxBytes = MAX_TOOL_OUTPUT_CHARS * 4;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      stream.destroy();
      throw new Error("Tool output exceeds the 4 MiB input byte limit");
    }
    chunks.push(buffer);
  }
  let input: string;
  try {
    input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new Error("Tool output must be valid UTF-8 text");
  }
  const result = optimizeToolOutput(input, {
    mode: options.mode as ToolCompressionMode | undefined,
  });
  if (options.output)
    writeFileSync(options.output, result.output, { mode: 0o600, flag: "wx" });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.error(
      `Leash local tool optimization · ${result.strategy} (${result.reason})\n${result.beforeChars} → ${result.afterChars} characters · ${result.savedPercent.toFixed(1)}% smaller\nEstimated tokens: ${result.estimatedTokensBefore} → ${result.estimatedTokensAfter}. ${result.estimateMethod}.`,
    );
    if (options.output) console.error(`Saved: ${options.output}`);
    else process.stdout.write(result.output);
  }
}
