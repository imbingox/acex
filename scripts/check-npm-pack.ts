import { spawnSync } from "node:child_process";

interface PackFile {
  path?: unknown;
}

interface PackResult {
  filename?: unknown;
  files?: unknown;
}

const REQUIRED_FILES = ["README.md", "CHANGELOG.md"];

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const packResult = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
});

if (packResult.error) {
  fail(`npm pack --dry-run failed: ${packResult.error.message}`);
}

if (packResult.status !== 0) {
  if (packResult.stdout) {
    process.stdout.write(packResult.stdout);
  }
  if (packResult.stderr) {
    process.stderr.write(packResult.stderr);
  }
  process.exit(packResult.status ?? 1);
}

let parsed: unknown;

try {
  parsed = JSON.parse(packResult.stdout);
} catch (error) {
  fail(
    `npm pack --dry-run --json did not return valid JSON: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

if (!Array.isArray(parsed) || parsed.length !== 1) {
  fail("npm pack --dry-run --json must return exactly one package result.");
}

const packageResult = parsed[0] as PackResult;

if (!Array.isArray(packageResult.files)) {
  fail("npm pack --dry-run --json result must include a files array.");
}

const packedFiles = new Set(
  packageResult.files
    .map((file: PackFile) => file.path)
    .filter((path): path is string => typeof path === "string"),
);
const missingFiles = REQUIRED_FILES.filter((file) => !packedFiles.has(file));

if (missingFiles.length > 0) {
  fail(`npm package is missing required files: ${missingFiles.join(", ")}`);
}

const filename =
  typeof packageResult.filename === "string"
    ? packageResult.filename
    : "package tarball";

process.stdout.write(
  `${filename} includes required files: ${REQUIRED_FILES.join(", ")}\n`,
);
