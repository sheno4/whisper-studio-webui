import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/bootstrap-windows.ps1', import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsOnly = { skip: process.platform !== 'win32' };

function runHelpers(source) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-bootstrap-test-'));
  try {
    const suite = path.join(fixture, 'suite.ps1');
    fs.writeFileSync(suite, '. $env:WHISPER_TEST_BOOTSTRAP\n' + source, 'utf8');
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', suite], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, WHISPER_TEST_BOOTSTRAP: script, WHISPER_TEST_FIXTURE: fixture }
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
    assert.match(result.stdout, /SUITE_OK/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

test('PowerShell 5.1 bootstrap chooses supported LTS and verifies archives before extraction', windowsOnly, () => {
  runHelpers([
    'function Assert([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }',
    '$tokens = $null; $parseErrors = $null',
    '[Management.Automation.Language.Parser]::ParseFile($env:WHISPER_TEST_BOOTSTRAP, [ref] $tokens, [ref] $parseErrors) > $null',
    'Assert ($parseErrors.Count -eq 0) "The bootstrap must parse on Windows PowerShell 5.1."',
    '$releases = @(',
    '    @{version="v28.0.0";lts=$false;files=@("win-x64-zip","win-arm64-zip")},',
    '    @{version="v24.2.0";lts="Krypton";files=@("win-x64-zip")},',
    '    @{version="v22.12.0";lts="Jod";files=@("win-x64-zip","win-arm64-zip")},',
    '    @{version="v22.11.0";lts="Jod";files=@("win-x64-zip","win-arm64-zip")}',
    ')',
    'Assert ((Get-LatestNodeRelease $releases "x64").version -eq "v24.2.0") "Latest compatible x64 LTS must win."',
    'Assert ((Get-LatestNodeRelease $releases "arm64").version -eq "v22.12.0") "ARM64 must have its own official archive."',
    '$archive = Join-Path $env:WHISPER_TEST_FIXTURE "node.zip"',
    '$sums = Join-Path $env:WHISPER_TEST_FIXTURE "SHASUMS256.txt"',
    '[IO.File]::WriteAllText($archive, "archive fixture")',
    '$digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash',
    '[IO.File]::WriteAllText($sums, "$digest  node.zip")',
    'Assert-NodeArchiveChecksum $archive $sums "node.zip"',
    '[IO.File]::WriteAllText($sums, ("0" * 64) + "  node.zip")',
    '$rejected = $false',
    'try { Assert-NodeArchiveChecksum $archive $sums "node.zip" } catch { $rejected = $_.Exception.Message -match "checksum mismatch" }',
    'Assert $rejected "A wrong checksum must fail."',
    'Remove-Item -LiteralPath $archive',
    'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
    '$zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)',
    '$zip.CreateEntry("node-v24.2.0-win-x64/../../outside.txt") > $null',
    '$zip.Dispose()',
    '$extract = Join-Path $env:WHISPER_TEST_FIXTURE "extract"',
    'New-Item -ItemType Directory -Path $extract > $null',
    '$rejected = $false',
    'try { Expand-NodeArchive $archive $extract "node-v24.2.0-win-x64" } catch { $rejected = $_.Exception.Message -match "Unsafe path" }',
    'Assert $rejected "Archive traversal must be refused before writing."',
    'Assert (-not (Test-Path (Join-Path $env:WHISPER_TEST_FIXTURE "outside.txt"))) "Extraction must stay inside the staging directory."',
    'Write-Host SUITE_OK'
  ].join('\n'));
});

test('portable installation preserves old runtime, releases locks on failure, and reuses success', windowsOnly, () => {
  runHelpers([
    'function Assert([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }',
    'function Get-NodeCandidates([string] $ProjectRoot) { Join-Path $ProjectRoot ".runtime\\node\\node.exe" }',
    'function Test-NodeRuntime([string] $Executable) {',
    '    return ((Test-Path -LiteralPath $Executable -PathType Leaf) -and',
    '        (Get-Content -LiteralPath $Executable -Raw) -eq "v24.2.0" -and',
    '        (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $Executable) "node_modules\\npm\\bin\\npm-cli.js")))',
    '}',
    'function Get-WindowsNodeArchitecture { return "x64" }',
    '$project = Join-Path $env:WHISPER_TEST_FIXTURE "project"',
    '$oldNode = Join-Path $project ".runtime\\node"',
    'New-Item -ItemType Directory -Path $oldNode -Force > $null',
    '[IO.File]::WriteAllText((Join-Path $oldNode "preserve.txt"), "existing user runtime")',
    '$source = Join-Path $env:WHISPER_TEST_FIXTURE "archive-source"',
    '$top = Join-Path $source "node-v24.2.0-win-x64"',
    'New-Item -ItemType Directory -Path (Join-Path $top "node_modules\\npm\\bin") -Force > $null',
    '[IO.File]::WriteAllText((Join-Path $top "node.exe"), "v24.2.0")',
    '[IO.File]::WriteAllText((Join-Path $top "node_modules\\npm\\bin\\npm-cli.js"), "npm fixture")',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$script:fixtureZip = Join-Path $env:WHISPER_TEST_FIXTURE "fixture.zip"',
    '[IO.Compression.ZipFile]::CreateFromDirectory($source, $fixtureZip)',
    '$script:downloadCount = 0',
    '$script:badChecksum = $true',
    'function Invoke-BootstrapDownload([string] $Url, [string] $Destination) {',
    '    $script:downloadCount++',
    '    if ($Url -eq "https://nodejs.org/dist/index.json") {',
    '        [IO.File]::WriteAllText($Destination, \'[{"version":"v24.2.0","lts":"Krypton","files":["win-x64-zip"]}]\')',
    '    } elseif ($Url.EndsWith("SHASUMS256.txt")) {',
    '        $digest = (Get-FileHash -LiteralPath $script:fixtureZip -Algorithm SHA256).Hash',
    '        if ($script:badChecksum) { $digest = "0" * 64 }',
    '        [IO.File]::WriteAllText($Destination, $digest + "  node-v24.2.0-win-x64.zip")',
    '    } elseif ($Url -eq "https://nodejs.org/dist/v24.2.0/node-v24.2.0-win-x64.zip") {',
    '        Copy-Item -LiteralPath $script:fixtureZip -Destination $Destination',
    '    } else { throw "Unexpected download: $Url" }',
    '}',
    '$rejected = $false',
    'try { Install-PortableNode $project > $null } catch { $rejected = $_.Exception.Message -match "checksum mismatch" }',
    'Assert $rejected "Checksum failure must stop installation."',
    'Assert (Test-Path -LiteralPath (Join-Path $oldNode "preserve.txt")) "Failure must preserve the existing runtime."',
    'Assert (@(Get-ChildItem -LiteralPath (Join-Path $project ".runtime") -Filter "node-bootstrap-*").Count -eq 0) "Failure must clean only its own staging directory."',
    '$lockPath = Join-Path $project ".runtime\\node-bootstrap.lock"',
    '$probeLock = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)',
    '$blocked = $false',
    'try { $secondLock = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $secondLock.Dispose() } catch [IO.IOException] { $blocked = $true }',
    '$probeLock.Dispose()',
    'Assert $blocked "The installation lock must exclude concurrent writers and release on failure."',
    '$script:badChecksum = $false',
    '$installed = Install-PortableNode $project',
    'Assert ($installed -eq (Join-Path $oldNode "node.exe")) "Node must install inside the project."',
    'Assert (Test-NodeRuntime $installed) "The installed runtime must be complete."',
    '$backups = @(Get-ChildItem -LiteralPath (Join-Path $project ".runtime") -Directory -Filter "node.backup-*")',
    'Assert ($backups.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $backups[0].FullName "preserve.txt"))) "The previous runtime must be backed up."',
    '$previousCount = $script:downloadCount',
    '$reused = Install-PortableNode $project',
    'Assert ($reused -eq $installed -and $script:downloadCount -eq $previousCount) "A valid runtime must skip every download."',
    'Write-Host SUITE_OK'
  ].join('\n'));
});

test('bootstrap forwards launch arguments and native exit status without swallowing stdout', windowsOnly, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-bootstrap-args-'));
  try {
    const nodeDir = path.join(fixture, '.runtime', 'node');
    fs.mkdirSync(path.join(nodeDir, 'node_modules', 'npm', 'bin'), { recursive: true });
    const nodeExe = path.join(nodeDir, 'node.exe');
    try { fs.linkSync(process.execPath, nodeExe); } catch { fs.copyFileSync(process.execPath, nodeExe); }
    fs.writeFileSync(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// present');
    fs.mkdirSync(path.join(fixture, 'scripts'));
    const entry = path.join(fixture, 'scripts', 'bootstrap-windows.ps1');
    fs.copyFileSync(script, entry);
    fs.writeFileSync(path.join(fixture, 'scripts', 'launch.mjs'), [
      "import fs from 'node:fs';",
      "console.log('LAUNCH_OUTPUT');",
      "fs.writeFileSync(new URL('../arguments.json', import.meta.url), JSON.stringify(process.argv.slice(2)));",
      'process.exit(23);'
    ].join('\n'));
    const args = ['--no-browser', 'two words', '中文路径', '--port=4317'];
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry, ...args], {
      encoding: 'utf8', timeout: 30_000
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 23, result.stdout + '\n' + result.stderr);
    assert.match(result.stdout, /LAUNCH_OUTPUT/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture, 'arguments.json'), 'utf8')), args);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('portable-only Node skips system candidates while reusing a valid project runtime', windowsOnly, () => {
  runHelpers([
    'function Assert([bool] $Condition, [string] $Message) { if (-not $Condition) { throw $Message } }',
    '$project = Join-Path $env:WHISPER_TEST_FIXTURE "project"',
    'New-Item -ItemType Directory -Path $project > $null',
    '$system = Join-Path $env:WHISPER_TEST_FIXTURE "system"',
    'New-Item -ItemType Directory -Path $system > $null',
    '$systemNode = Join-Path $system "node.exe"',
    '[IO.File]::WriteAllText($systemNode, "node fixture")',
    '$env:PATH = $system',
    '$env:ProgramFiles = ""; ${env:ProgramFiles(x86)} = ""; $env:LOCALAPPDATA = ""; $env:USERPROFILE = ""',
    'function Test-NodeRuntime([string] $Executable) { return (Test-Path -LiteralPath $Executable -PathType Leaf) }',
    '$env:WHISPER_PORTABLE_ONLY = "1"',
    'Assert ($null -eq (Find-NodeRuntime $project)) "Portable-only must ignore an available system Node."',
    'Assert (@(Get-NodeCandidates $project).Count -eq 1) "Only the project candidate should be considered."',
    '$env:WHISPER_PORTABLE_ONLY = "0"',
    'Assert ((Find-NodeRuntime $project) -eq $systemNode) "Normal startup should reuse a working system Node."',
    '$env:WHISPER_PORTABLE_ONLY = "1"',
    '$portable = Join-Path $project ".runtime\\node\\node.exe"',
    'New-Item -ItemType Directory -Path (Split-Path -Parent $portable) -Force > $null',
    '[IO.File]::WriteAllText($portable, "project node fixture")',
    'Assert ((Find-NodeRuntime $project) -eq $portable) "Portable-only must reuse its existing project runtime."',
    'Write-Host SUITE_OK'
  ].join('\n'));
});

test('PowerShell 5.1 JSON root arrays are expanded before selecting an official LTS archive', windowsOnly, () => {
  runHelpers([
    '$json = \'[{"version":"v24.21.0","lts":"Krypton","files":["win-x64-zip"]},{"version":"v26.8.1","lts":false,"files":["win-x64-zip"]}]\'',
    '$selected = Get-LatestNodeRelease -Releases @($json | ConvertFrom-Json) -Architecture x64',
    'if ($selected.version -ne "v24.21.0") { throw "A JSON root array wrapper must not hide compatible LTS releases." }',
    'Write-Host SUITE_OK'
  ].join('\n'));
});
