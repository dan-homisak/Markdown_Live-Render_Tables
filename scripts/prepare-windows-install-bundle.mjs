import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vsixPath = path.join(repoRoot, "markdown-live-render-tables-latest.vsix");
const legacyBundleDir = path.join(repoRoot, "install-bundles", "MarkdownLiveEditor-Windows");
const bundleDir = path.join(repoRoot, "install-bundles", "Copy_to_Windows");
const installerPath = path.join(bundleDir, "Install_Markdown_Live_Editor.cmd");

if (!existsSync(vsixPath)) {
  throw new Error(
    `Missing ${path.basename(vsixPath)}. Run ./Build_and_Install or npm run package before creating the Windows bundle.`,
  );
}

await rm(legacyBundleDir, { recursive: true, force: true });
await rm(bundleDir, { recursive: true, force: true });
await mkdir(bundleDir, { recursive: true });

await copyFile(vsixPath, path.join(bundleDir, path.basename(vsixPath)));
await writeFile(
  installerPath,
  `@echo off
setlocal

set "EXTENSION_ID=dan-homisak.markdown-live-render-tables"
set "SCRIPT_DIR=%~dp0"
set "VSIX_PATH=%SCRIPT_DIR%markdown-live-render-tables-latest.vsix"
set "CODE_CLI="

echo.
echo Markdown Live Editor - Windows installer
echo.

if not exist "%VSIX_PATH%" (
  echo Could not find "%VSIX_PATH%".
  echo Keep this installer next to markdown-live-render-tables-latest.vsix.
  goto :failed
)

call :find_code_cli
if not defined CODE_CLI (
  echo Could not find the VS Code command-line tool.
  echo.
  echo Try the manual VS Code install:
  echo   1. Open VS Code.
  echo   2. Open the Extensions view.
  echo   3. Choose the ... menu.
  echo   4. Choose Install from VSIX...
  echo   5. Pick markdown-live-render-tables-latest.vsix from this folder.
  echo.
  echo On managed work computers, IT may install VS Code without the command-line tool.
  goto :failed
)

echo Using VS Code CLI:
echo   %CODE_CLI%
echo.
"%CODE_CLI%" --version
if errorlevel 1 goto :failed

echo.
echo Removing any older local install...
"%CODE_CLI%" --uninstall-extension "%EXTENSION_ID%" >nul 2>nul

echo.
echo Installing latest VSIX...
"%CODE_CLI%" --install-extension "%VSIX_PATH%" --force
if errorlevel 1 goto :failed

echo.
echo Verifying install...
set "INSTALLED="
for /f "delims=" %%L in ('"%CODE_CLI%" --list-extensions --show-versions ^| findstr /I /B "%EXTENSION_ID%@"') do set "INSTALLED=%%L"
if not defined INSTALLED (
  echo VS Code did not report %EXTENSION_ID% after install.
  goto :failed
)

echo Verified: %INSTALLED%
echo.
echo Done. Restart VS Code, or run Developer: Reload Window in any open VS Code window.
echo.
pause
exit /b 0

:find_code_cli
for /f "delims=" %%P in ('where code.cmd 2^>nul') do (
  set "CODE_CLI=%%P"
  exit /b 0
)
for /f "delims=" %%P in ('where code-insiders.cmd 2^>nul') do (
  set "CODE_CLI=%%P"
  exit /b 0
)
call :try_code_path "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin\\code.cmd"
if defined CODE_CLI exit /b 0
call :try_code_path "%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd"
if defined CODE_CLI exit /b 0
call :try_code_path "%ProgramFiles%\\Microsoft VS Code\\bin\\code.cmd"
if defined CODE_CLI exit /b 0
call :try_code_path "%ProgramFiles%\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd"
if defined CODE_CLI exit /b 0
call :try_code_path "%ProgramFiles(x86)%\\Microsoft VS Code\\bin\\code.cmd"
if defined CODE_CLI exit /b 0
call :try_code_path "%ProgramFiles(x86)%\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd"
exit /b 0

:try_code_path
if exist "%~1" set "CODE_CLI=%~1"
exit /b 0

:failed
echo.
echo Install did not complete.
echo.
pause
exit /b 1
`,
  "utf8",
);

console.log(`Created Windows install folder: ${bundleDir}`);
console.log("Copy that folder to Windows, then double-click Install_Markdown_Live_Editor.cmd.");
