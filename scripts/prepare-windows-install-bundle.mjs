import { copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vsixPath = path.join(repoRoot, "markdown-live-render-tables-latest.vsix");
const legacyBundleDir = path.join(repoRoot, "install-bundles", "MarkdownLiveEditor-Windows");
const bundleDir = path.join(repoRoot, "install-bundles", "Copy_to_Windows");

if (!existsSync(vsixPath)) {
  throw new Error(
    `Missing ${path.basename(vsixPath)}. Run ./Build_and_Install or npm run package before creating the Windows bundle.`,
  );
}

await rm(legacyBundleDir, { recursive: true, force: true });
await rm(bundleDir, { recursive: true, force: true });
await mkdir(bundleDir, { recursive: true });

await copyFile(vsixPath, path.join(bundleDir, path.basename(vsixPath)));

console.log(`Created Windows VSIX transfer folder: ${bundleDir}`);
console.log("Copy that folder to Windows, then install the VSIX from VS Code.");
