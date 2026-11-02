import ts from "typescript";
export type MemorySymbol = {
  name: string;
  kind: string;
  start: number;
  end: number;
  line: number;
  exported: boolean;
};
export type MemoryReference = {
  name: string;
  kind: "import" | "call";
  target: string | null;
  line: number;
};
export function outlineCode(path: string, text: string) {
  const ast = /\.[cm]?[jt]sx?$/.test(path);
  const symbols: MemorySymbol[] = [],
    refs: MemoryReference[] = [];
  if (!ast) {
    let offset = 0;
    for (const [i, line] of text.split("\n").entries()) {
      const match =
        /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|fn|func|function|struct|interface|enum|type)\s+([\p{L}_$][\p{L}\p{N}_$]*)/u.exec(
          line,
        );
      if (match && symbols.length < 200)
        symbols.push({
          name: match[1],
          kind: "text-outline",
          start: offset,
          end: offset + line.length,
          line: i + 1,
          exported: false,
        });
      offset += line.length + 1;
    }
    return { parser: "text-outline", symbols, refs };
  }
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if (symbols.length >= 2000 || refs.length >= 4000) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isVariableDeclaration(node)
    ) {
      if (
        node.name &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      ) {
        const start = node.getStart(source),
          line = source.getLineAndCharacterOfPosition(start).line + 1;
        const owner = ts.isVariableDeclaration(node)
          ? node.parent.parent
          : node;
        const exported =
          ts.canHaveModifiers(owner) &&
          !!ts
            .getModifiers(owner)
            ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        symbols.push({
          name: node.name.text,
          kind: ts.SyntaxKind[node.kind],
          start,
          end: node.getEnd(),
          line,
          exported,
        });
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const clause = node.importClause;
      const names =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.map((x) => x.name.text)
          : [];
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        names.push(clause.namedBindings.name.text);
      for (const name of names.length ? names : [node.moduleSpecifier.text])
        refs.push({
          name,
          kind: "import",
          target: node.moduleSpecifier.text,
          line,
        });
    }
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const name = ts.isIdentifier(expr)
        ? expr.text
        : ts.isPropertyAccessExpression(expr)
          ? expr.name.text
          : null;
      if (name)
        refs.push({
          name,
          kind: "call",
          target: null,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { parser: "typescript-ast", symbols, refs };
}
