# Windows PowerShell 5.1 ships with Windows; Node is prepared before any JS runs.
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $LaunchArguments = @()
)

$ErrorActionPreference = 'Stop'
$minimumNodeVersion = [Version] '22.12.0'
# A launch from PowerShell 7 can inherit its incompatible module search paths.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath

function ConvertTo-NodeVersion {
    param([string] $Value)
    if ($Value -match '^v?(\d+)\.(\d+)\.(\d+)$') {
        return [Version] ('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
    }
    return $null
}

function Test-NodeRuntime {
    param([string] $Executable)
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    $npmCli = Join-Path (Split-Path -Parent $Executable) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { return $false }
    $process = New-Object System.Diagnostics.Process
    try {
        $process.StartInfo.FileName = $Executable
        $process.StartInfo.Arguments = '--version'
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        if (-not $process.Start()) { return $false }
        if (-not $process.WaitForExit(10000)) {
            $process.Kill()
            $process.WaitForExit()
            return $false
        }
        $version = ConvertTo-NodeVersion ($process.StandardOutput.ReadToEnd().Trim())
        return ($process.ExitCode -eq 0 -and $null -ne $version -and $version -ge $minimumNodeVersion)
    } catch {
        return $false
    } finally {
        $process.Dispose()
    }
}

function Get-NodeCandidates {
    param([string] $ProjectRoot)
    Join-Path $ProjectRoot '.runtime\node\node.exe'
    # Used by portable deployments and isolated first-install validation.
    if ($env:WHISPER_PORTABLE_ONLY -eq '1') { return }
    Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Source }
    foreach ($directory in @(
        $env:ProgramFiles, ${env:ProgramFiles(x86)},
        $(if ($env:LocalAppData) { Join-Path $env:LocalAppData 'Programs' })
    )) {
        if ($directory) { Join-Path $directory 'nodejs\node.exe' }
    }
    if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe' }
}

function Find-NodeRuntime {
    param([string] $ProjectRoot)
    foreach ($candidate in (Get-NodeCandidates $ProjectRoot | Select-Object -Unique)) {
        if (Test-NodeRuntime $candidate) { return [IO.Path]::GetFullPath($candidate) }
    }
    return $null
}

function Get-WindowsNodeArchitecture {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    switch ($architecture.ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { throw "Unsupported Windows architecture '$architecture'. This project requires 64-bit Windows (x64 or ARM64)." }
    }
}

function Assert-PathInside {
    param([string] $Path, [string] $Directory)
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside the runtime directory: $resolved"
    }
    return $resolved
}

function Assert-PlainDirectory {
    param([string] $Path)
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Runtime installation path must be a regular directory: $Path"
        }
    }
}

function Get-LatestNodeRelease {
    param([object[]] $Releases, [string] $Architecture)
    # Windows PowerShell 5.1 can emit a JSON root array as one pipeline item.
    # Flatten that wrapper before inspecting individual release records.
    $releaseItems = @(foreach ($item in $Releases) {
        if ($item -is [Array]) { foreach ($release in $item) { $release } }
        else { $item }
    })
    $eligible = @($releaseItems | Where-Object {
        $version = ConvertTo-NodeVersion ([string] $_.version)
        $_.lts -and $null -ne $version -and $version -ge $minimumNodeVersion -and
            $_.files -contains "win-$Architecture-zip"
    } | Sort-Object -Property @{ Expression = { ConvertTo-NodeVersion ([string] $_.version) }; Descending = $true })
    if ($eligible.Count -eq 0) { throw "No supported Node.js LTS Windows $Architecture release was found on nodejs.org." }
    return $eligible[0]
}

function Invoke-BootstrapDownload {
    param([string] $Url, [string] $Destination)
    $ProgressPreference = 'SilentlyContinue'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 120 -MaximumRedirection 3
            return
        } catch {
            if (Test-Path -LiteralPath $Destination -PathType Leaf) { Remove-Item -LiteralPath $Destination -Force }
            if ($attempt -eq 3) {
                throw "Download failed after 3 attempts: $Url. Check your network/proxy and start again. $($_.Exception.Message)"
            }
            Write-Host "[Whisper Studio] Download interrupted; retrying ($attempt/3)..."
            Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
        }
    }
}

function Assert-NodeArchiveChecksum {
    param([string] $Archive, [string] $Checksums, [string] $FileName)
    $pattern = '(?m)^([a-fA-F0-9]{64})\s+\*?' + [Regex]::Escape($FileName) + '\s*$'
    $matchesFound = [Regex]::Matches((Get-Content -LiteralPath $Checksums -Raw), $pattern)
    if ($matchesFound.Count -ne 1) { throw "The official SHASUMS256.txt does not identify $FileName exactly once." }
    $expected = $matchesFound[0].Groups[1].Value
    $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
    if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Node.js archive checksum mismatch. Start again to download a fresh copy."
    }
}

function Expand-NodeArchive {
    param([string] $Archive, [string] $Destination, [string] $TopDirectory)
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $relative = $entry.FullName.Replace('/', '\')
            if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or
                $relative -match '(^|\\)\.\.?($|\\)') {
                throw "Unsafe path in the Node.js archive: $($entry.FullName)"
            }
            if (-not $relative.StartsWith($TopDirectory + '\', [StringComparison]::Ordinal) -and
                $relative -ne $TopDirectory + '\') {
                throw "Unexpected path in the Node.js archive: $($entry.FullName)"
            }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw "Symbolic links are not permitted in the Node.js archive."
            }
            $target = Assert-PathInside (Join-Path $Destination $relative) $Destination
            if ($relative.EndsWith('\')) {
                New-Item -ItemType Directory -Path $target -Force | Out-Null
            } else {
                New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
            }
        }
    } finally {
        $zip.Dispose()
    }
}

function Enter-NodeBootstrapLock {
    param([string] $LockPath)
    $deadline = [DateTime]::UtcNow.AddMinutes(15)
    $reported = $false
    while ($true) {
        try {
            return [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for another Node.js installer. Close the other startup window and try again." }
            if (-not $reported) {
                Write-Host '[Whisper Studio] Another startup is preparing Node.js; waiting...'
                $reported = $true
            }
            Start-Sleep -Milliseconds 500
        }
    }
}

function Install-PortableNode {
    param([string] $ProjectRoot)
    $runtimeRoot = Assert-PathInside (Join-Path $ProjectRoot '.runtime') $ProjectRoot
    Assert-PlainDirectory $runtimeRoot
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $lockPath = Assert-PathInside (Join-Path $runtimeRoot 'node-bootstrap.lock') $runtimeRoot
    if ((Test-Path -LiteralPath $lockPath) -and
        ((Get-Item -LiteralPath $lockPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "The Node.js bootstrap lock must not be a symbolic link."
    }
    $lock = Enter-NodeBootstrapLock $lockPath
    $staging = $null
    try {
        # A concurrent starter may have completed the installation while we waited.
        $available = Find-NodeRuntime $ProjectRoot
        if ($available) { return $available }
        $architecture = Get-WindowsNodeArchitecture
        $staging = Assert-PathInside (Join-Path $runtimeRoot ('node-bootstrap-' + [Guid]::NewGuid().ToString('N'))) $runtimeRoot
        New-Item -ItemType Directory -Path $staging | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Write-Host '[Whisper Studio] Node.js 22.12+ with npm is missing. Preparing a portable LTS runtime...'
        $indexPath = Join-Path $staging 'index.json'
        Invoke-BootstrapDownload 'https://nodejs.org/dist/index.json' $indexPath
        $releaseIndex = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
        $release = Get-LatestNodeRelease -Releases $releaseIndex -Architecture $architecture
        $topDirectory = 'node-{0}-win-{1}' -f $release.version, $architecture
        $fileName = $topDirectory + '.zip'
        $archive = Join-Path $staging $fileName
        $checksums = Join-Path $staging 'SHASUMS256.txt'
        $releaseUrl = 'https://nodejs.org/dist/' + $release.version
        Write-Host "[Whisper Studio] Downloading Node.js $($release.version) ($architecture) from nodejs.org..."
        Invoke-BootstrapDownload ($releaseUrl + '/SHASUMS256.txt') $checksums
        Invoke-BootstrapDownload ($releaseUrl + '/' + $fileName) $archive
        Assert-NodeArchiveChecksum $archive $checksums $fileName
        Expand-NodeArchive $archive $staging $topDirectory
        $extracted = Assert-PathInside (Join-Path $staging $topDirectory) $staging
        $nodePath = Join-Path $extracted 'node.exe'
        if (-not (Test-NodeRuntime $nodePath)) { throw 'The verified Node.js archive did not provide a working Node.js and npm runtime.' }
        $destination = Assert-PathInside (Join-Path $runtimeRoot 'node') $runtimeRoot
        Assert-PlainDirectory $destination
        $backup = $null
        if (Test-Path -LiteralPath $destination) {
            $backup = Assert-PathInside (Join-Path $runtimeRoot ('node.backup-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))) $runtimeRoot
            Move-Item -LiteralPath $destination -Destination $backup
            Write-Host "[Whisper Studio] Previous unusable Node.js runtime preserved at $backup"
        }
        try {
            Move-Item -LiteralPath $extracted -Destination $destination
        } catch {
            if ($backup -and -not (Test-Path -LiteralPath $destination)) { Move-Item -LiteralPath $backup -Destination $destination }
            throw
        }
        return (Join-Path $destination 'node.exe')
    } finally {
        try {
            if ($staging -and (Test-Path -LiteralPath $staging)) {
                $safeStaging = Assert-PathInside $staging $runtimeRoot
                Assert-PlainDirectory $safeStaging
                Remove-Item -LiteralPath $safeStaging -Recurse -Force
            }
        } finally {
            $lock.Dispose()
        }
    }
}

function Invoke-WhisperBootstrap {
    param([string] $ProjectRoot, [string[]] $Arguments = @())
    $nodePath = Find-NodeRuntime $ProjectRoot
    if (-not $nodePath) { $nodePath = Install-PortableNode $ProjectRoot }
    Write-Host "[Whisper Studio] Using Node.js: $nodePath"
    # This process-local PATH change also lets npm and yt-dlp find the same Node.
    $env:PATH = (Split-Path -Parent $nodePath) + [IO.Path]::PathSeparator + $env:PATH
    Push-Location -LiteralPath $ProjectRoot
    try {
        & $nodePath (Join-Path $ProjectRoot 'scripts\launch.mjs') @Arguments | Out-Host
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

# Dot-sourcing exposes the pure helpers for targeted tests without starting the app.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
        $exitCode = Invoke-WhisperBootstrap $projectRoot $LaunchArguments
        exit $exitCode
    } catch {
        [Console]::Error.WriteLine('[Whisper Studio] Startup failed: ' + $_.Exception.Message)
        exit 1
    }
}
