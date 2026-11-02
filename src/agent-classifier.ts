import artifact from "./agent-classifier-model.json" with { type: "json" };
export type AgentLabel = "codex" | "claude-code" | "needs-choice";
export type AgentSignals = {
  codexContext: boolean;
  claudeContext: boolean;
  codexExecutable: boolean;
  codexConfig: boolean;
  claudeExecutable: boolean;
  claudeConfig: boolean;
};
type Tree =
  | { label: AgentLabel; samples: number }
  | { feature: number; no: Tree; yes: Tree };
export const agentClassifierInfo = {
  version: artifact.version,
  kind: artifact.kind,
  datasetSha256: artifact.training.datasetSha256,
  heldoutAccuracy: artifact.training.heldoutAccuracy,
  scope: artifact.training.scope,
};
/** Entire inference is local on six booleans; no prompt, identifier or credential. */
export function classifyAgent(signals: AgentSignals): {
  label: AgentLabel;
  modelVersion: number;
  reason: "local-marker-model" | "invalid-markers";
} {
  const x = artifact.features.map(
    (name) => signals[name as keyof AgentSignals],
  );
  if (x.some((value) => typeof value !== "boolean"))
    return {
      label: "needs-choice",
      modelVersion: artifact.version,
      reason: "invalid-markers",
    };
  let node = artifact.tree as Tree;
  while ("feature" in node) node = x[node.feature] ? node.yes : node.no;
  return {
    label: node.label,
    modelVersion: artifact.version,
    reason: "local-marker-model",
  };
}
