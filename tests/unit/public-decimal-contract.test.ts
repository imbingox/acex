import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";
import { toCanonical } from "../../src/internal/decimal.ts";

const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const TYPES_ROOT = path.join(PROJECT_ROOT, "src/types");
const INDEX_FILE = path.join(PROJECT_ROOT, "src/index.ts");
const BIGNUMBER_MODULE = "bignumber.js";

interface Binding {
  readonly localName: string;
  readonly isNamespace: boolean;
}

interface IllegalReference {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly binding: string;
  readonly context: string;
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return await listTypeScriptFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );

  return files.flat().sort((left, right) => left.localeCompare(right));
}

function moduleSpecifierText(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): string | undefined {
  const moduleSpecifier = node.moduleSpecifier;
  return moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)
    ? moduleSpecifier.text
    : undefined;
}

function importedBindings(sourceFile: ts.SourceFile): Binding[] {
  const bindings: Binding[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    if (moduleSpecifierText(statement) !== BIGNUMBER_MODULE) {
      continue;
    }

    const clause = statement.importClause;
    if (!clause?.isTypeOnly) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        statement.getStart(sourceFile),
      );
      throw new Error(
        `${sourceFile.fileName}:${line + 1}:${character + 1} imports ${BIGNUMBER_MODULE} without import type`,
      );
    }

    if (clause.name) {
      bindings.push({ localName: clause.name.text, isNamespace: false });
    }

    if (!clause.namedBindings) {
      continue;
    }

    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push({
        localName: clause.namedBindings.name.text,
        isNamespace: true,
      });
      continue;
    }

    for (const element of clause.namedBindings.elements) {
      bindings.push({ localName: element.name.text, isNamespace: false });
    }
  }

  return bindings;
}

function rootIdentifier(typeName: ts.EntityName): string {
  return ts.isIdentifier(typeName)
    ? typeName.text
    : rootIdentifier(typeName.left);
}

function describeNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ");
}

function isAllowedDecimalInputReference(
  file: string,
  node: ts.TypeReferenceNode,
): boolean {
  if (path.basename(file) !== "market.ts") {
    return false;
  }

  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isTypeAliasDeclaration(current) &&
      current.name.text === "DecimalInput"
    ) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function findIllegalReferences(
  file: string,
  sourceFile: ts.SourceFile,
  bindings: Binding[],
): { illegalReferences: IllegalReference[]; allowedReferenceCount: number } {
  const illegalReferences: IllegalReference[] = [];
  let allowedReferenceCount = 0;

  function visit(node: ts.Node): void {
    if (ts.isTypeReferenceNode(node)) {
      const binding = bindings.find(
        (candidate) =>
          rootIdentifier(node.typeName) === candidate.localName &&
          (!candidate.isNamespace || ts.isQualifiedName(node.typeName)),
      );

      if (binding) {
        if (isAllowedDecimalInputReference(file, node)) {
          allowedReferenceCount += 1;
        } else {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          illegalReferences.push({
            file: path.relative(PROJECT_ROOT, file),
            line: line + 1,
            column: character + 1,
            binding: binding.localName,
            context: describeNode(node, sourceFile),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { illegalReferences, allowedReferenceCount };
}

test("public output types do not expose BigNumber aliases", async () => {
  const files = await listTypeScriptFiles(TYPES_ROOT);
  const illegalImports: string[] = [];
  const illegalReferences: IllegalReference[] = [];
  let allowedReferenceCount = 0;

  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const bindings = importedBindings(sourceFile);

    if (bindings.length > 0 && path.basename(file) !== "market.ts") {
      illegalImports.push(path.relative(PROJECT_ROOT, file));
    }

    const result = findIllegalReferences(file, sourceFile, bindings);
    illegalReferences.push(...result.illegalReferences);
    allowedReferenceCount += result.allowedReferenceCount;
  }

  expect(illegalImports).toEqual([]);
  expect(illegalReferences).toEqual([]);
  expect(allowedReferenceCount).toBe(1);
});

test("toCanonical emits plain decimal strings without trailing zeros", () => {
  expect(toCanonical("1e-7")).toBe("0.0000001");
  expect(toCanonical("1e21")).toBe("1000000000000000000000");
  expect(toCanonical("-0.0100")).toBe("-0.01");
  expect(toCanonical("0.0000")).toBe("0");
  expect(toCanonical("0.1234567890123456789000")).toBe("0.1234567890123456789");
});

test("root entrypoint keeps the BigNumber utility re-export", async () => {
  const sourceText = await readFile(INDEX_FILE, "utf8");
  const sourceFile = ts.createSourceFile(
    INDEX_FILE,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const hasBigNumberReExport = sourceFile.statements.some((statement) => {
    if (!ts.isExportDeclaration(statement)) {
      return false;
    }

    if (moduleSpecifierText(statement) !== BIGNUMBER_MODULE) {
      return false;
    }

    const exportClause = statement.exportClause;
    return (
      exportClause !== undefined &&
      ts.isNamedExports(exportClause) &&
      exportClause.elements.some(
        (element) =>
          element.name.text === "BigNumber" &&
          element.propertyName === undefined,
      )
    );
  });

  expect(hasBigNumberReExport).toBe(true);
});
