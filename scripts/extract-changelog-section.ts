import { readFileSync } from "node:fs";

interface PackageJson {
  version?: unknown;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync("package.json", "utf8"),
  ) as PackageJson;

  if (typeof packageJson.version !== "string" || packageJson.version === "") {
    fail("package.json must contain a non-empty string version.");
  }

  return packageJson.version;
}

const version = process.argv[2] ?? readPackageVersion();
const changelog = readFileSync("CHANGELOG.md", "utf8");
const headingPattern = new RegExp(`^##\\s+${escapeRegExp(version)}\\s*$`, "m");
const headingMatch = headingPattern.exec(changelog);

if (!headingMatch) {
  fail(`CHANGELOG.md does not contain a section for version ${version}.`);
}

const sectionStart = headingMatch.index + headingMatch[0].length;
const sectionRemainder = changelog.slice(sectionStart);
const nextVersionHeading = /\n##\s+/.exec(sectionRemainder);
const sectionEnd =
  nextVersionHeading === null
    ? sectionRemainder.length
    : nextVersionHeading.index;
const section = sectionRemainder.slice(0, sectionEnd).trim();

if (section === "") {
  fail(`CHANGELOG.md section for version ${version} is empty.`);
}

process.stdout.write(`${section}\n`);
