import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  parseLog,
  summarize,
  longestToolRepeat,
  type BurnEvent,
} from "./core/index.js";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "./state.js";
import { config } from "./config.js";
import { sync } from "./sync.js";
import { deviceCredentials, deviceRequest } from "./device.js";
import { validateURL } from "./auth.js";
function files(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
      e.isSymbolicLink()
        ? []
        : e.isDirectory()
          ? files(join(path, e.name))
          : e.name.endsWith(".jsonl")
            ? [join(path, e.name)]
            : [],
    );
  } catch {
    return [];
  }
}
export type ReportOptions = {
  claudeDir?: string;
  codexDir?: string;
  since?: string;
  json?: boolean;
  output?: string;
  share?: boolean;
};
export function collectReport(options: ReportOptions = {}) {
  const events: BurnEvent[] = [];
  const warnings: string[] = [];
  let longestRepeat = 0;
  const since = options.since ? Date.parse(options.since) : 0;
  if (Number.isNaN(since)) throw new Error("Invalid --since date");
  for (const [source, path] of [
    ["claude-code", options.claudeDir ?? join(homedir(), ".claude/projects")],
    ["codex", options.codexDir ?? join(homedir(), ".codex/sessions")],
  ] as const) {
    for (const file of files(path)) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        warnings.push("An unreadable log was skipped");
        continue;
      }
      longestRepeat = Math.max(
        longestRepeat,
        longestToolRepeat(text, source, since),
      );
      const r = parseLog(
        text,
        source,
        createHash("sha256").update(file).digest("hex"),
      );
      events.push(
        ...r.events.filter((e) => !since || Date.parse(e.timestamp) >= since),
      );
      warnings.push(...r.warnings);
    }
  }
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  const models = new Map<
    string,
    { model: string; cost: number; requests: number }
  >();
  const days = new Map<string, { day: string; cost: number }>();
  for (const e of unique) {
    const m = models.get(e.model) ?? { model: e.model, cost: 0, requests: 0 };
    m.cost += e.cost ?? 0;
    m.requests++;
    models.set(e.model, m);
    const day = e.timestamp.slice(0, 10) || "unknown";
    const d = days.get(day) ?? { day, cost: 0 };
    d.cost += e.cost ?? 0;
    days.set(day, d);
  }
  return {
    longestToolRepeat: longestRepeat,
    public: !!options.share,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    since: options.since ?? null,
    models: [...models.values()].sort((a, b) => b.cost - a.cost),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    ...summarize(events),
    warnings: [...new Set(warnings)],
    label: "Estimated API-equivalent value; not a subscription invoice",
  };
}
export async function report(options: ReportOptions) {
  const store = new Store(config().dir);
  const result = {
    ...collectReport(options),
    estimatedSaved: store
      .all<{ estimatedSaved?: number }>("kill")
      .reduce((n, k) => n + (k.estimatedSaved ?? 0), 0),
  };
  try {
    store.put("report", result.id, result);
    if (options.share) {
      try {
        await sync(store);
        const device = deviceCredentials();
        if (device) {
          const shared = await deviceRequest(
            device,
            `devices/me/reports/${result.id}/share`,
            { public: true },
          );
          console.error(
            `Share URL (aggregate numbers only): ${validateURL(shared.webURL)}${shared.path}`,
          );
        } else
          console.error(
            `Report ${result.id} saved locally. Run leash login to enroll this device, then share it from https://useleash.dev.`,
          );
      } catch {
        console.error(
          "Report retained locally; publishing failed. Check the transport, then share from the dashboard after sync.",
        );
      }
    }
  } finally {
    store.db.close();
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `\n LEASH / BURN REPORT\n\n $${result.cost.toFixed(4)} estimated API value\n ${result.requests} requests · ${result.sessions.length} sessions · ${result.unpriced} unpriced\n\n ${result.label}\n`,
    );
    console.table(
      result.sessions.slice(0, 10).map((s, i) => ({
        session: `Session ${i + 1}`,
        requests: s.requests,
        tokens: s.tokens,
        USD: s.cost.toFixed(4),
      })),
    );
    console.log(
      `Longest consecutive identical logged tool run: ${result.longestToolRepeat} (signal only, not proof of a loop)`,
    );
    for (const w of result.warnings) console.error(w);
    console.log("\nProtect the next session: leash run -- claude");
  }
  if (options.output || options.share) {
    let sharp: typeof import("sharp").default;
    try {
      sharp = (await import("sharp")).default;
    } catch {
      throw new Error(
        "PNG report rendering needs the optional sharp package for this platform. Reinstall Leash with optional dependencies enabled, or use leash report --json. The report remains in the local ledger.",
      );
    }
    const dir = resolve(options.output ?? "leash-report");
    mkdirSync(dir, { recursive: true });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#0c1715"/><text x="76" y="100" fill="#b5f36c" font-size="28" font-family="sans-serif">LEASH / BURN REPORT</text><text x="76" y="280" fill="#f1f3e9" font-size="110" font-family="sans-serif">$${result.cost.toFixed(2)}</text><text x="80" y="350" fill="#b5c3ba" font-size="30" font-family="sans-serif">Estimated API-equivalent value</text><text x="80" y="450" fill="#f1f3e9" font-size="28" font-family="sans-serif">${result.requests} requests · ${result.sessions.length} sessions</text><text x="80" y="555" fill="#b5f36c" font-size="23" font-family="sans-serif">Put your agents on a leash. / leash run -- claude</text></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(join(dir, "burn-report.png"));
    await sharp(
      Buffer.from(
        svg
          .replace("LEASH / BURN REPORT", "LEASH / ESTIMATED SAVED")
          .replace(result.cost.toFixed(2), result.estimatedSaved.toFixed(2))
          .replace(
            "Estimated API-equivalent value",
            "Counterfactual: 30 more minutes at the prior rate",
          ),
      ),
    )
      .png()
      .toFile(join(dir, "saved-card.png"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>Leash Burn Report</title><style>body{background:#0c1715;color:#fff;font:18px system-ui;margin:5vw}img{width:100%;max-width:1200px}a{color:#b5f36c}</style><img src="burn-report.png" alt="Burn report: $${result.cost.toFixed(2)} estimated API value"><p>API-equivalent estimate, not an invoice. ${result.unpriced} unpriced requests excluded. No prompts, paths or session IDs shared.</p>`,
    );
    console.error(
      `Report saved: ${join(dir, "index.html")} (local files; opt-in sharing publishes aggregate numbers only)`,
    );
  }
  return result;
}
