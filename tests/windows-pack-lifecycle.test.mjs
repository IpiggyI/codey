import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packSource = readFileSync(new URL("../scripts/build-windows.ps1", import.meta.url), "utf8");
const helperUrl = new URL("../scripts/windows-pack-workspace.ps1", import.meta.url);
const powershell = process.env.CODEY_PACK_TEST_POWERSHELL || "powershell.exe";
const windowsOnly = { skip: process.platform !== "win32" && "Windows PowerShell filesystem fixture" };
const siblingName = `app-20000101-000000000-${"a".repeat(32)}`;
const uncCwd = process.env.CODEY_PACK_TEST_UNC_CWD || fileURLToPath(new URL("../", import.meta.url));
const uncOnly = {
  skip: windowsOnly.skip || !uncCwd.startsWith("\\\\") && "A real UNC checkout is required; set CODEY_PACK_TEST_UNC_CWD",
};

test("Windows pack source contract: every outcome reaches workspace cleanup before reporting", () => {
  assert.match(packSource, /finally\s*\{[\s\S]*Remove-WindowsPackDirectory/);
  const main = packSource.slice(packSource.indexOf("\ntry {\n"));
  assert.doesNotMatch(main.slice(0, main.indexOf("} catch {")), /\bexit\s+[01]/);
  assert.match(packSource, /AppCopyCreated\s*=\s*\$true/);
  assert.match(packSource, /Guid\]::NewGuid\(\)/);
});

test("Windows pack source contract: optional tests keep their selection and use a scoped small profile", () => {
  assert.match(packSource, /test -p codey computer_use::tests --locked/);
  assert.match(packSource, /CARGO_PROFILE_TEST_DEBUG\s*=\s*'0'/);
  assert.match(packSource, /CARGO_PROFILE_TEST_INCREMENTAL\s*=\s*'false'/);
  assert.match(packSource, /finally\s*\{\s*\$env:CARGO_PROFILE_TEST_DEBUG\s*=\s*\$testDebug\s*\$env:CARGO_PROFILE_TEST_INCREMENTAL\s*=\s*\$testIncremental/);
  assert.match(packSource, /\[IO\.File\]::Copy\(\$packed, \$OutputPath, \$false\)/);
});

test("Windows pack source contract: cleanup and location restoration require filesystem provider paths", () => {
  const helperSource = readFileSync(helperUrl, "utf8");
  assert.doesNotMatch(packSource, /\$InitialLocation\s*=\s*\(Get-Location\)\.Path/);
  assert.match(packSource, /\$InitialLocation\.Provider\.Name -ne 'FileSystem'/);
  assert.match(packSource, /Set-Location -LiteralPath \$InitialLocation\.ProviderPath/);
  assert.match(helperSource, /\$currentLocation\.Provider\.Name -ne 'FileSystem'/);
  assert.match(helperSource, /GetFullPath\(\$currentLocation\.ProviderPath\)/);
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "codey-pack-fixture-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const temporary = join(directory, "temp");
  const repository = join(directory, "repository");
  const profile = join(directory, "profile");
  for (const path of [temporary, profile, join(repository, "scripts")]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(repository, "scripts", "windows-pack-workspace.ps1"), readFileSync(helperUrl));
  return { directory, temporary, repository, profile, root: join(temporary, "codey-windows-pack") };
}

function invokePowerShell(command, options = {}) {
  const result = spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64"),
  ], { encoding: "utf8", timeout: 30_000, ...options });
  assert.ifError(result.error);
  return result;
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function mockPackSource() {
  let source = packSource;
  const mocks = new Map([
    ["Assert-WindowsRustc", "return 'fixture rustc'"],
    ["Import-VcVars64", "return 'fixture vcvars'"],
    ["Resolve-Makensis", "return 'Invoke-FixtureMakensis'"],
    ["Get-WindowsExePath", "param([string]$Name)\n    if ($Name -eq 'go.exe') { return (Join-Path $WindowsCargoBin 'go.exe') }\n    return 'fixture-link.exe'"],
  ]);
  for (const [name, body] of mocks) {
    const definition = new RegExp(`function ${name} \\{[\\s\\S]*?\\n\\}`);
    assert.match(source, definition);
    source = source.replace(definition, `function ${name} {\n    ${body}\n}`);
  }
  assert.ok(source.includes("$goVersion = & $go version"));
  source = source.replace("$goVersion = & $go version", "$goVersion = 'fixture go'; $global:LASTEXITCODE = 0");
  assert.ok(source.includes("& (Join-Path $WindowsCargoBin 'cargo.exe')"));
  source = source.replaceAll("& (Join-Path $WindowsCargoBin 'cargo.exe')", "Invoke-FixtureCargo");
  source = source.replaceAll("1MB", "1");
  const stubs = `
function Invoke-FixtureCargo {
    Add-Content -LiteralPath (Join-Path $env:TEMP 'cargo-trace.txt') -Value ($args[0] + '|' + $env:CARGO_PROFILE_TEST_DEBUG + '|' + $env:CARGO_PROFILE_TEST_INCREMENTAL)
    if ($env:CODEY_PACK_FIXTURE_MODE -in @('cleanup-failure', 'cleanup-delivery-failure')) {
        $outside = Join-Path $env:TEMP 'outside'
        New-Item -ItemType Directory -Force -Path $outside | Out-Null
        [IO.File]::WriteAllText((Join-Path $outside 'marker'), 'untouched')
        New-Item -ItemType Junction -Path (Join-Path $AppCopy 'redirect') -Target $outside | Out-Null
    }
    if ($env:CODEY_PACK_FIXTURE_MODE -in @('compile-failure', 'cleanup-failure')) {
        $global:LASTEXITCODE = 42
        return
    }
    $release = Join-Path $targetDir 'release'
    New-Item -ItemType Directory -Force -Path $release | Out-Null
    [IO.File]::WriteAllText((Join-Path $release 'codey.exe'), 'fixture')
    [IO.File]::WriteAllText((Join-Path $release 'codey-fastctx.exe'), 'fixture')
    $global:LASTEXITCODE = 0
}

function Invoke-FixtureMakensis {
    [IO.File]::WriteAllText((Join-Path $dist "Codey-$version-windows-x64-setup.exe"), 'fixture installer')
    if ($env:CODEY_PACK_FIXTURE_MODE -eq 'delivery-failure') {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
        [IO.File]::WriteAllText($OutputPath, 'existing installer')
    }
    $global:LASTEXITCODE = 0
}
`;
  assert.ok(source.includes("\ntry {\n"));
  return source.replace("\ntry {\n", `${stubs}\ntry {\n`);
}

function runPack(state, mode = "success", runTests = false, options = {}) {
  for (const name of [
    "Cargo.toml", "Cargo.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "vite.overlay.config.ts", "tsconfig.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md",
  ]) writeFileSync(join(state.repository, name), "fixture");
  writeFileSync(join(state.repository, "package.json"), '{"version":"1.2.3"}');
  for (const name of [".cargo", "backend", "vendor/CodeyRuntime", "vendor/ComputerUse", "src", "dist-overlay", "licenses"]) {
    mkdirSync(join(state.repository, name), { recursive: true });
  }
  if (mode !== "source-copy-failure") mkdirSync(join(state.repository, "public"), { recursive: true });
  writeFileSync(join(state.repository, "dist-overlay", "codey-overlay.js"), "fixture");
  mkdirSync(join(state.profile, ".cargo", "bin"), { recursive: true });
  writeFileSync(join(state.profile, ".cargo", "bin", "go.exe"), "fixture");
  const script = join(state.repository, "scripts", "build-windows.ps1");
  writeFileSync(script, mockPackSource());
  const result = spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    ...(runTests ? ["-RunComputerUseTests"] : []),
  ], {
    cwd: options.cwd || state.repository,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env, TEMP: state.temporary, USERPROFILE: state.profile,
      CODEY_PACK_FIXTURE_MODE: mode, CODEY_WINDOWS_PACKAGE_VERSION: "",
      CARGO_PROFILE_TEST_DEBUG: "2", CARGO_PROFILE_TEST_INCREMENTAL: "true",
    },
  });
  assert.ifError(result.error);
  return result;
}

function assertOnlySummary(state) {
  assert.deepEqual(readdirSync(state.root), ["last-build.log"]);
  assert.ok(readFileSync(join(state.root, "last-build.log"), "utf8").length <= 4096);
}

test("Windows pack cleans a successful workspace after delivering the installer", windowsOnly, (t) => {
  const state = fixture(t);
  const result = runPack(state);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NSIS_OK:/);
  const installers = readdirSync(join(state.profile, "Downloads"));
  assert.equal(installers.length, 1);
  assert.equal(readFileSync(join(state.profile, "Downloads", installers[0]), "utf8"), "fixture installer");
  assertOnlySummary(state);
});

for (const [mode, status] of [["success", 0], ["compile-failure", 1]]) {
  test(`Windows pack cleans the workspace when ${mode} starts from a real UNC directory`, uncOnly, (t) => {
    const state = fixture(t);
    const result = runPack(state, mode, false, { cwd: uncCwd });
    assert.equal(result.status, status, result.stdout + result.stderr);
    if (status === 0) assert.match(result.stdout, /NSIS_OK:/);
    else assert.match(result.stdout, /NSIS_FAIL: cargo build --release failed: 42/);
    assertOnlySummary(state);
    assert.match(readFileSync(join(state.root, "last-build.log"), "utf8"), /cleanup_error=$/);
  });
}

for (const [mode, message] of [
  ["source-copy-failure", /copy source missing:/],
  ["compile-failure", /cargo build --release failed: 42/],
  ["delivery-failure", /NSIS_FAIL:/],
]) {
  test(`Windows pack cleans the workspace after ${mode}`, windowsOnly, (t) => {
    const state = fixture(t);
    const result = runPack(state, mode);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /NSIS_FAIL:/);
    assert.match(result.stdout, message);
    assert.doesNotMatch(result.stdout, /NSIS_OK:/);
    assertOnlySummary(state);
    if (mode === "delivery-failure") {
      const installer = readdirSync(join(state.profile, "Downloads"))[0];
      assert.equal(readFileSync(join(state.profile, "Downloads", installer), "utf8"), "existing installer");
    }
  });
}

test("Windows pack leaves a concurrent workspace intact", windowsOnly, (t) => {
  const state = fixture(t);
  const sibling = join(state.root, siblingName);
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "marker"), "other build");
  const result = runPack(state);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(sibling, "marker"), "utf8"), "other build");
  assert.deepEqual(readdirSync(state.root).sort(), [siblingName, "last-build.log"].sort());
});

test("Windows pack restores the optional test profile before the release build", windowsOnly, (t) => {
  const state = fixture(t);
  const result = runPack(state, "success", true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readFileSync(join(state.temporary, "cargo-trace.txt"), "utf8").trim().split(/\r?\n/), [
    "test|0|false", "build|2|true",
  ]);
  assertOnlySummary(state);
});

test("Windows pack reports cleanup rejection without hiding the original compilation failure", windowsOnly, (t) => {
  const state = fixture(t);
  const result = runPack(state, "cleanup-failure");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /cargo build --release failed: 42/);
  assert.match(result.stdout + result.stderr, /cleanup failed/);
  assert.equal(readFileSync(join(state.temporary, "outside", "marker"), "utf8"), "untouched");
  assert.equal(readdirSync(state.root).filter((name) => name.startsWith("app-")).length, 1);
});

test("Windows pack returns failure after cleanup rejection and keeps an already delivered installer", windowsOnly, (t) => {
  const state = fixture(t);
  const result = runPack(state, "cleanup-delivery-failure");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /NSIS_FAIL: workspace cleanup failed:/);
  assert.match(result.stdout, /installer retained at:/);
  assert.doesNotMatch(result.stdout, /NSIS_OK:/);
  const installer = readdirSync(join(state.profile, "Downloads"))[0];
  assert.equal(readFileSync(join(state.profile, "Downloads", installer), "utf8"), "fixture installer");
});

function invokeCleanup(state, target, root = state.root, options = {}) {
  return invokePowerShell(`
    $ErrorActionPreference = 'Stop'
    . ${quotePowerShell(join(state.repository, "scripts", "windows-pack-workspace.ps1"))}
    try {
      Remove-WindowsPackDirectory -WorkRoot ${quotePowerShell(root)} -AppCopy ${quotePowerShell(target)}
      exit 0
    } catch {
      Write-Output $_.Exception.Message
      exit 1
    }
  `, { cwd: state.repository, ...options });
}

test("Windows pack requires leaving the workspace before cleanup", windowsOnly, (t) => {
  const state = fixture(t);
  const workspace = join(state.root, siblingName);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "marker"), "untouched");
  const result = invokeCleanup(state, workspace, state.root, { cwd: workspace });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Exit the workspace/);
  assert.equal(readFileSync(join(workspace, "marker"), "utf8"), "untouched");
});

test("Windows pack cleans from a provider-qualified filesystem location", windowsOnly, (t) => {
  const state = fixture(t);
  const workspace = join(state.root, siblingName);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "marker"), "fixture");
  const result = invokePowerShell(`
    $ErrorActionPreference = 'Stop'
    . ${quotePowerShell(join(state.repository, "scripts", "windows-pack-workspace.ps1"))}
    function Get-Location {
      [PSCustomObject]@{
        Path = ${quotePowerShell(`Microsoft.PowerShell.Core\\FileSystem::${state.repository}`)}
        ProviderPath = ${quotePowerShell(state.repository)}
        Provider = [PSCustomObject]@{ Name = 'FileSystem' }
      }
    }
    Remove-WindowsPackDirectory -WorkRoot ${quotePowerShell(state.root)} -AppCopy ${quotePowerShell(workspace)}
  `, { cwd: state.repository });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(workspace), false);
});

test("Windows pack refuses an active process reference and excludes the caller", windowsOnly, (t) => {
  const state = fixture(t);
  const workspace = join(state.root, siblingName);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "marker"), "untouched");
  for (const property of ["ExecutablePath", "CommandLine"]) {
    const result = invokePowerShell(`
      $ErrorActionPreference = 'Stop'
      . ${quotePowerShell(join(state.repository, "scripts", "windows-pack-workspace.ps1"))}
      $target = ${quotePowerShell(workspace)}
      function Get-CimInstance {
        [PSCustomObject]@{ ProcessId = $PID; ExecutablePath = "$target\\caller.exe"; CommandLine = '' }
      }
      Assert-WindowsPackNotInUse -AppCopy $target
      function Get-CimInstance {
        $process = [PSCustomObject]@{ ProcessId = ($PID + 1000); ExecutablePath = ''; CommandLine = '' }
        $process.${property} = "$target\\cargo.exe"
        $process
      }
      try {
        Remove-WindowsPackDirectory -WorkRoot ${quotePowerShell(state.root)} -AppCopy $target
        exit 0
      } catch {
        Write-Output $_.Exception.Message
        exit 1
      }
    `, { cwd: state.repository });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Workspace in use by process/);
    assert.equal(readFileSync(join(workspace, "marker"), "utf8"), "untouched");
  }
});

test("Windows pack refuses root and neighboring directory cleanup", windowsOnly, (t) => {
  const state = fixture(t);
  const outside = join(state.temporary, "outside");
  mkdirSync(outside);
  mkdirSync(state.root);
  writeFileSync(join(outside, "marker"), "untouched");
  for (const target of [state.root, state.temporary, outside, `${state.root}-neighbor`]) {
    const result = invokeCleanup(state, target);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
  assert.ok(existsSync(state.root));
  assert.equal(readFileSync(join(outside, "marker"), "utf8"), "untouched");
});

for (const boundary of ["root", "ancestor", "workspace", "nested"]) {
  test(`Windows pack refuses a ${boundary} junction without following its target`, windowsOnly, (t) => {
    const state = fixture(t);
    const outside = join(state.directory, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "marker"), "untouched");
    let root = state.root;
    let workspace = join(root, siblingName);
    if (boundary === "root") symlinkSync(outside, root, "junction");
    if (boundary === "ancestor") {
      const alias = join(state.directory, "alias");
      symlinkSync(state.temporary, alias, "junction");
      root = join(alias, "codey-windows-pack");
      workspace = join(root, siblingName);
      mkdirSync(workspace, { recursive: true });
    }
    if (boundary === "workspace") {
      mkdirSync(root);
      symlinkSync(outside, workspace, "junction");
    }
    if (boundary === "nested") {
      mkdirSync(workspace, { recursive: true });
      symlinkSync(outside, join(workspace, "redirect"), "junction");
    }
    const result = invokeCleanup(state, workspace, root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /reparse/i);
    assert.equal(readFileSync(join(outside, "marker"), "utf8"), "untouched");
  });
}
