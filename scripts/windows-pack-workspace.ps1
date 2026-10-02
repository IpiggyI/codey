#Requires -Version 5.1

function Assert-NoWindowsPackReparseAncestors {
    param([Parameter(Mandatory)][string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current -ErrorAction Stop) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing reparse path: $current"
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Assert-WindowsPackPath {
    param(
        [Parameter(Mandatory)][string]$WorkRoot,
        [Parameter(Mandatory)][string]$AppCopy
    )
    $root = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($AppCopy).TrimEnd('\')
    if ($root -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFileName($root) -ne 'codey-windows-pack') {
        throw "Refusing non-dedicated work root: $WorkRoot"
    }
    if ([IO.Path]::GetDirectoryName($target) -ne $root -or
        [IO.Path]::GetFileName($target) -notmatch '^app-\d{8}-\d{9}(-[a-f0-9]{32})?$') {
        throw "Refusing workspace outside the work root: $AppCopy"
    }
    Assert-NoWindowsPackReparseAncestors -Path $target
}

function Assert-WindowsPackNotInUse {
    param([Parameter(Mandatory)][string]$AppCopy)
    $target = [IO.Path]::GetFullPath($AppCopy).TrimEnd('\')
    $pattern = [regex]::Escape($target) + '(?:\\|["''\s]|$)'
    $processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ExecutablePath,CommandLine -ErrorAction Stop)
    foreach ($process in $processes) {
        if ($process.ProcessId -eq $PID) { continue }
        foreach ($value in @($process.ExecutablePath, $process.CommandLine)) {
            if ($value -and [regex]::IsMatch($value.Replace('/', '\'), $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
                throw "Workspace in use by process $($process.ProcessId): $AppCopy"
            }
        }
    }
}

function Remove-WindowsPackDirectory {
    param(
        [Parameter(Mandatory)][string]$WorkRoot,
        [Parameter(Mandatory)][string]$AppCopy
    )
    Assert-WindowsPackPath -WorkRoot $WorkRoot -AppCopy $AppCopy
    $target = [IO.Path]::GetFullPath($AppCopy).TrimEnd('\')
    $currentLocation = Get-Location
    if ($currentLocation.Provider.Name -ne 'FileSystem') {
        throw 'Workspace cleanup requires a filesystem working directory'
    }
    $location = [IO.Path]::GetFullPath($currentLocation.ProviderPath).TrimEnd('\')
    if ($location -eq $target -or $location.StartsWith("$target\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Exit the workspace before cleanup: $AppCopy"
    }
    Assert-WindowsPackNotInUse -AppCopy $AppCopy
    $remove = {
        param([string]$Path)
        Assert-NoWindowsPackReparseAncestors -Path $Path
        foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)) {
            Assert-NoWindowsPackReparseAncestors -Path $item.FullName
            if ($item.PSIsContainer) {
                & $remove $item.FullName
            } else {
                Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
            }
        }
        Assert-NoWindowsPackReparseAncestors -Path $Path
        [IO.Directory]::Delete($Path, $false)
    }
    if (Test-Path -LiteralPath $AppCopy -ErrorAction Stop) {
        & $remove $AppCopy
    }
}

function Write-WindowsPackSummary {
    param(
        [Parameter(Mandatory)][string]$WorkRoot,
        [Parameter(Mandatory)][string]$AppCopy,
        [Parameter(Mandatory)][string]$Message
    )
    Assert-WindowsPackPath -WorkRoot $WorkRoot -AppCopy $AppCopy
    $log = Join-Path $WorkRoot 'last-build.log'
    Assert-NoWindowsPackReparseAncestors -Path $log
    if ($Message.Length -gt 4096) { $Message = $Message.Substring(0, 4096) }
    [IO.File]::WriteAllText($log, $Message, (New-Object Text.UTF8Encoding($false)))
}
