#Requires -Version 5.1
<##
.SYNOPSIS
    Pack-only NSIS build for Codey.

.DESCRIPTION
    Copies the Codey sources onto NTFS under %TEMP%\codey-windows-pack,
    compiles the Windows MSVC release binaries, then runs makensis.
    Writes the installer to %USERPROFILE%\Downloads\Codey-windows-x64-setup.exe.

    Does not install, start, or stop Codey.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
$WorkRoot = Join-Path $env:TEMP 'codey-windows-pack'
$AppCopy = Join-Path $WorkRoot 'app'
$WindowsCargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$WindowsCargoHome = Join-Path $env:USERPROFILE '.cargo'
$WindowsRustupHome = Join-Path $env:USERPROFILE '.rustup'
$OutputPath = Join-Path $env:USERPROFILE 'Downloads\Codey-windows-x64-setup.exe'

function Write-NsisLog {
    param([string]$Message)
    Write-Host "[nsis] $Message"
}

function Fail-Nsis {
    param([string]$Message)
    Write-Output "NSIS_FAIL: $Message"
    exit 1
}

function Get-WindowsExePath {
    param([Parameter(Mandatory)][string]$Name)
    $cmds = @(Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)
    foreach ($cmd in $cmds) {
        $src = $cmd.Source
        if (-not $src) { continue }
        if ($src -match '(?i)wsl\.localhost' -or $src -match '(?i)wsl\$') { continue }
        return $src
    }
    return $null
}

function Remove-WslPathEntries {
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($part in @($env:PATH -split ';')) {
        if ([string]::IsNullOrWhiteSpace($part)) { continue }
        if ($part -match '(?i)wsl\.localhost' -or $part -match '(?i)wsl\$') { continue }
        $kept.Add($part)
    }
    $env:PATH = [string]::Join(';', $kept)
}

function Copy-SmallTree {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [string[]]$ExcludeDirNames = @()
    )
    $Source = [IO.Path]::GetFullPath($Source)
    if (-not (Test-Path -LiteralPath $Source)) {
        throw "copy source missing: $Source"
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $skip = @{}
    foreach ($name in $ExcludeDirNames) { $skip[$name] = $true }
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        if ($_.PSIsContainer -and $skip.ContainsKey($_.Name)) { return }
        $dest = Join-Path $Destination $_.Name
        if ($_.PSIsContainer) {
            Copy-SmallTree -Source $_.FullName -Destination $dest -ExcludeDirNames $ExcludeDirNames
        } else {
            Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
        }
    }
}

function Import-VcVars64 {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        throw "vswhere.exe missing; Visual Studio Build Tools are required"
    }
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ([string]::IsNullOrWhiteSpace($vs)) {
        throw "VS 2022 MSVC tools not found"
    }
    $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path $vcvars)) {
        throw "vcvars64.bat missing at $vcvars"
    }
    $output = & cmd.exe /c "`"$vcvars`" && set"
    foreach ($line in $output) {
        if ($line -match '^(.*?)=(.*)$') {
            Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
        }
    }
    Write-NsisLog "imported vcvars64 from $vs"
    return $vs
}

function Assert-WindowsRustc {
    $rustc = Join-Path $WindowsCargoBin 'rustc.exe'
    $cargo = Join-Path $WindowsCargoBin 'cargo.exe'
    if (-not (Test-Path $rustc)) { throw "Windows rustc.exe missing at $rustc" }
    if (-not (Test-Path $cargo)) { throw "Windows cargo.exe missing at $cargo" }
    $vv = & $rustc -vV | Out-String
    if ($vv -notmatch 'host:\s*x86_64-pc-windows-msvc') {
        throw "Windows rustc host is not x86_64-pc-windows-msvc: $vv"
    }
    if ($rustc -notmatch '\.exe$') {
        throw "WSL rustc is a hard fail: $rustc"
    }
    return (& $rustc --version).Trim()
}

function Use-WindowsRustEnv {
    $env:CARGO_HOME = $WindowsCargoHome
    $env:RUSTUP_HOME = $WindowsRustupHome
    $env:PATH = "$WindowsCargoBin;$env:PATH"
}

function Resolve-Makensis {
    $found = Get-WindowsExePath 'makensis.exe'
    if ($found) { return $found }
    foreach ($candidate in @(
            (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
            (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'),
            (Join-Path $env:LOCALAPPDATA 'codey-tools\nsis\makensis.exe')
        )) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "makensis.exe was not found. Install NSIS or place makensis.exe at %LOCALAPPDATA%\codey-tools\nsis\"
}

try {
    $isWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [System.Runtime.InteropServices.OSPlatform]::Windows
    )
    if (-not $isWindows) {
        throw "This pack must run on Windows PowerShell, not WSL rustc."
    }

    Remove-WslPathEntries
    Use-WindowsRustEnv
    New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null
    Set-Location -LiteralPath $WorkRoot

    $rustcVersion = Assert-WindowsRustc
    $makensis = Resolve-Makensis
    Write-NsisLog "rustc=$rustcVersion; makensis=$makensis"
    $null = Import-VcVars64
    $link = Get-WindowsExePath 'link.exe'
    if (-not $link) { throw "link.exe missing after vcvars64" }

    $overlay = Join-Path $RepoRoot 'dist-overlay\codey-overlay.js'
    if (-not (Test-Path -LiteralPath $overlay)) {
        throw "dist-overlay\codey-overlay.js missing; run scripts/build-windows.sh or pnpm run vite:build first"
    }

    Write-NsisLog "refresh app from $RepoRoot into $AppCopy"
    if (Test-Path -LiteralPath $AppCopy) {
        Remove-Item -LiteralPath $AppCopy -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $AppCopy | Out-Null
    foreach ($name in @(
            'Cargo.toml', 'Cargo.lock', 'package.json', 'pnpm-lock.yaml',
            'pnpm-workspace.yaml', 'vite.overlay.config.ts', 'tsconfig.json',
            'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'
        )) {
        Copy-Item -LiteralPath (Join-Path $RepoRoot $name) -Destination (Join-Path $AppCopy $name) -Force
    }
    Copy-SmallTree -Source (Join-Path $RepoRoot '.cargo') -Destination (Join-Path $AppCopy '.cargo')
    Copy-SmallTree -Source (Join-Path $RepoRoot 'backend') -Destination (Join-Path $AppCopy 'backend') -ExcludeDirNames @('target')
    Copy-SmallTree -Source (Join-Path $RepoRoot 'vendor\CodeyRuntime') -Destination (Join-Path $AppCopy 'vendor\CodeyRuntime') -ExcludeDirNames @('target')
    Copy-SmallTree -Source (Join-Path $RepoRoot 'src') -Destination (Join-Path $AppCopy 'src')
    Copy-SmallTree -Source (Join-Path $RepoRoot 'public') -Destination (Join-Path $AppCopy 'public')
    Copy-SmallTree -Source (Join-Path $RepoRoot 'dist-overlay') -Destination (Join-Path $AppCopy 'dist-overlay')
    Copy-SmallTree -Source (Join-Path $RepoRoot 'scripts') -Destination (Join-Path $AppCopy 'scripts')
    Copy-SmallTree -Source (Join-Path $RepoRoot 'licenses') -Destination (Join-Path $AppCopy 'licenses')

    $pkg = Get-Content -LiteralPath (Join-Path $AppCopy 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $version = "$($pkg.version)-local"
    if (-not [string]::IsNullOrWhiteSpace($env:CODEY_WINDOWS_PACKAGE_VERSION)) {
        $version = $env:CODEY_WINDOWS_PACKAGE_VERSION
    }

    $targetDir = Join-Path $AppCopy 'target'
    $env:CODEY_SKIP_OVERLAY_BUILD = '1'
    $env:CARGO_BUILD_BUILD_DIR = $targetDir
    $env:CARGO_TARGET_DIR = $targetDir
    $env:CARGO_PROFILE_RELEASE_LTO = 'thin'
    $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'

    Write-NsisLog "cargo build --release in $AppCopy"
    Push-Location $AppCopy
    try {
        & (Join-Path $WindowsCargoBin 'cargo.exe') build --release --manifest-path (Join-Path $AppCopy 'Cargo.toml')
        if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $codey = Join-Path $targetDir 'release\codey.exe'
    $fastctx = Join-Path $targetDir 'release\codey-fastctx.exe'
    if (-not (Test-Path -LiteralPath $codey)) {
        $codey = Join-Path $targetDir 'x86_64-pc-windows-msvc\release\codey.exe'
        $fastctx = Join-Path $targetDir 'x86_64-pc-windows-msvc\release\codey-fastctx.exe'
    }
    if (-not (Test-Path -LiteralPath $codey) -or -not (Test-Path -LiteralPath $fastctx)) {
        throw "Windows release binaries were not found under $targetDir"
    }

    $dist = Join-Path $AppCopy 'dist\windows'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $installerScript = Join-Path $AppCopy 'scripts\installer\windows\Codey.nsi'
    Write-NsisLog "makensis VERSION=$version PROJECT_ROOT=$AppCopy"
    & $makensis '/INPUTCHARSET' 'UTF8' "/DVERSION=$version" "/DPROJECT_ROOT=$AppCopy" $installerScript
    if ($LASTEXITCODE -ne 0) { throw "makensis failed: $LASTEXITCODE" }

    $packed = Join-Path $dist "Codey-$version-windows-x64-setup.exe"
    if (-not (Test-Path -LiteralPath $packed)) { throw "NSIS installer was not created: $packed" }
    if ((Get-Item -LiteralPath $packed).Length -le 1MB) {
        throw "NSIS artifact too small: $((Get-Item -LiteralPath $packed).Length) bytes"
    }

    $downloads = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null
    Copy-Item -LiteralPath $packed -Destination $OutputPath -Force
    $written = Get-Item -LiteralPath $OutputPath
    if ($written.Length -le 1MB) { throw "copied installer too small: $($written.Length) bytes" }

    Write-Output "NSIS_OK: $OutputPath"
    exit 0
} catch {
    Fail-Nsis $_.Exception.Message
}
