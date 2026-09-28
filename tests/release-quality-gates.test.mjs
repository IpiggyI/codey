import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/build-desktop.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = fs.readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const macBuildScript = fs.readFileSync(
  new URL("../scripts/build.mjs", import.meta.url),
  "utf8",
);
const windowsInstallerScript = fs.readFileSync(
  new URL("../scripts/installer/windows/Codey.nsi", import.meta.url),
  "utf8",
);

function assertRustQualityGates(job) {
  assert.match(job, /components: rustfmt, clippy/);
  assert.match(job, /cargo fmt --all -- --check/);
  assert.match(job, /cargo test --workspace --locked/);
  assert.match(job, /cargo clippy --workspace --all-targets --locked -- -D warnings/);
}

function workflowStep(from, to) {
  const fromIndex = workflow.indexOf(from);
  assert.notEqual(fromIndex, -1);
  const toIndex = workflow.indexOf(to, fromIndex);
  assert.notEqual(toIndex, -1);
  return workflow.slice(fromIndex, toIndex);
}

test("pull requests enforce the unified Rust quality gate", () => {
  assert.match(ciWorkflow, /^\s*RUSTFLAGS: -D warnings$/m);
  assertRustQualityGates(ciWorkflow);
  const windowsJob = ciWorkflow.slice(ciWorkflow.indexOf("\n  windows-rust:"));
  assert.match(windowsJob, /runs-on: windows-latest/);
  assert.match(windowsJob, /components: clippy/);
  assert.match(windowsJob, /cargo test --workspace --locked/);
  assert.match(
    windowsJob,
    /cargo clippy --workspace --all-targets --locked -- -D warnings/,
  );
});

function workflowJob(name, until) {
  const fromIndex = workflow.indexOf(`\n  ${name}:`);
  assert.notEqual(fromIndex, -1, `missing job ${name}`);
  const toIndex = workflow.indexOf(`\n  ${until}:`, fromIndex);
  assert.notEqual(toIndex, -1, `missing job ${until} after ${name}`);
  return workflow.slice(fromIndex, toIndex);
}

test("tag-triggered desktop releases independently enforce Rust quality gates", () => {
  assert.match(workflow, /^\s*RUSTFLAGS: -D warnings$/m);
  const macosPackage = workflowJob("macos", "macos-check");
  const macosCheck = workflowJob("macos-check", "windows");
  const windowsPackage = workflowJob("windows", "publish");
  const publish = workflow.slice(workflow.indexOf("\n  publish:"));
  assertRustQualityGates(macosCheck);
  assert.match(macosCheck, /pnpm run check/);
  assert.match(macosCheck, /pnpm run test:js/);
  assert.match(publish, /- macos\n/);
  assert.match(publish, /- macos-check\n/);
  assert.match(publish, /- windows\n/);
  assert.doesNotMatch(macosPackage, /cargo test --workspace/);
  assert.doesNotMatch(macosPackage, /pnpm run test:js/);
  assert.doesNotMatch(windowsPackage, /cargo test --workspace/);
  assert.doesNotMatch(windowsPackage, /cargo clippy/);
  assert.doesNotMatch(windowsPackage, /pnpm run test:js/);
  assert.doesNotMatch(windowsPackage, /choco install/);
});

test("desktop release jobs reuse prebuilt assets and compile only release binaries", () => {
  for (const job of [
    workflowJob("macos", "macos-check"),
    workflowJob("macos-check", "windows"),
    workflowJob("windows", "publish"),
  ]) {
    assert.match(job, /- name: Build embedded frontend assets\s+run: pnpm run vite:build/);
    assert.match(job, /CODEY_SKIP_OVERLAY_BUILD: "1"/);
  }
  for (const job of [
    workflowJob("macos", "macos-check"),
    workflowJob("windows", "publish"),
  ]) {
    assert.match(job, /CODEY_SKIP_OVERLAY_BUILD: "1"\s+run: pnpm run build/);
    assert.match(job, /CARGO_PROFILE_RELEASE_LTO: thin/);
    assert.match(job, /CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16"/);
  }
  const macosCheck = workflowJob("macos-check", "windows");
  assert.match(macosCheck, /cargo test --workspace --locked\s+env:\s+CODEY_SKIP_OVERLAY_BUILD: "1"/);
  assert.match(
    macosCheck,
    /cargo clippy --workspace --all-targets --locked -- -D warnings\s+env:\s+CODEY_SKIP_OVERLAY_BUILD: "1"/,
  );
  assert.match(workflowJob("windows", "publish"), /linker=rust-lld\.exe/);
  assert.doesNotMatch(workflow, /macos-15-intel/);
  assert.doesNotMatch(workflow, /arch: x64/);
  assert.match(macBuildScript, /CODEY_SKIP_OVERLAY_BUILD === "1"/);
  assert.match(macBuildScript, /dist-overlay\/codey-overlay\.js 不存在/);
  assert.match(
    macBuildScript,
    /"build",\s+"--release",\s+"-p",\s+"codey",\s+"--bins",/,
  );
});

test("local releases run the same locked Rust checks", () => {
  const releaseScript = fs.readFileSync(new URL("../scripts/release.mjs", import.meta.url), "utf8");
  assert.match(releaseScript, /\["fmt", "--all", "--", "--check"\]/);
  assert.match(releaseScript, /\["test", "--workspace", "--locked"\]/);
  assert.match(releaseScript, /\["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"\]/);
});

test("desktop builds generate embedded overlay assets before Cargo compiles", () => {
  const overlayBuild = macBuildScript.indexOf("build-overlay.mjs");
  const cargoBuild = macBuildScript.indexOf('"cargo"');
  assert.notEqual(overlayBuild, -1);
  assert.notEqual(cargoBuild, -1);
  assert.ok(
    overlayBuild < cargoBuild,
    "the ignored dist-overlay directory must be generated before include_str! is compiled",
  );
});

test("desktop release does not ship a client updater or update feed", () => {
  assert.equal(
    fs.existsSync(new URL("../backend/src/commands/updates.rs", import.meta.url)),
    false,
  );
  assert.doesNotMatch(workflow, /CODEY_UPDATE_BASE_URL|latest\.json/);
  assert.match(workflow, /name: Attach packages to GitHub Release/);
});

test("desktop packages include FastCtx license and notice files", () => {
  for (const expected of [
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "licenses/FastCtx/LICENSE-APACHE",
    "licenses/FastCtx/NOTICE",
  ]) {
    assert.match(macBuildScript, new RegExp(expected.replaceAll("/", "\\/")));
  }

  assert.match(workflow, /Contents\/Resources\/licenses\/FastCtx\/LICENSE-APACHE/);
  assert.match(workflow, /Contents\/Resources\/licenses\/FastCtx\/NOTICE/);
  assert.match(windowsInstallerScript, /licenses\\FastCtx\\LICENSE-APACHE/);
  assert.match(windowsInstallerScript, /licenses\\FastCtx\\NOTICE/);
});

test("Git Bash and WSL can package uniquely named Windows installers without pushing a tag", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.scripts["build:windows"], "bash scripts/build-windows.sh");
  const localWindowsBuild = fs.readFileSync(
    new URL("../scripts/build-windows.sh", import.meta.url),
    "utf8",
  );
  const windowsHost = fs.readFileSync(
    new URL("../scripts/build-windows.ps1", import.meta.url),
    "utf8",
  );
  assert.match(localWindowsBuild, /wslpath -w .*build-windows\.ps1/);
  assert.match(localWindowsBuild, /cygpath -w .*build-windows\.ps1/);
  assert.match(localWindowsBuild, /powershell\.exe -NoProfile -ExecutionPolicy Bypass -File/);
  assert.match(windowsHost, /Remove-WslPathEntries/);
  assert.match(windowsHost, /codey-windows-pack/);
  assert.match(windowsHost, /\$BuildStamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'/);
  assert.match(windowsHost, /Downloads\\Codey-\$version-\$BuildStamp-windows-x64-setup\.exe/);
  assert.match(windowsHost, /\[IO\.File\]::Copy\(\$packed, \$OutputPath, \$false\)/);
  assert.match(windowsHost, /NSIS_OK:/);
  assert.doesNotMatch(windowsHost, /wsl\.localhost.*cargo/i);
  const agents = fs.readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.match(agents, /scripts\/build-windows\.sh/);
  assert.match(agents, /docs\/agents\/windows-pack\.md/);
});

test("Windows release publishes the installer without a portable zip", () => {
  const nsisInstallStep = workflowStep(
    "- name: Install NSIS",
    "- name: Install frontend dependencies",
  );
  const windowsPackageStep = workflowStep(
    "- name: Build Windows packages",
    "- name: Upload Windows installer",
  );

  assert.match(workflow, /name: codey-windows-x64-installer/);
  assert.match(workflow, /windows-x64-setup\.exe/);
  assert.match(nsisInstallStep, /nsis-\$version\.zip/);
  assert.match(nsisInstallStep, /nsis-\$version\/nsis-\$version\.zip/);
  assert.match(
    nsisInstallStep,
    /c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1/,
  );
  assert.match(nsisInstallStep, /curl\.exe -fL --retry 3 --retry-all-errors/);
  assert.match(nsisInstallStep, /NSIS archive hash mismatch/);
  assert.match(nsisInstallStep, /Join-Path \$nsisHome "Bin" "makensis\.exe"/);
  assert.match(nsisInstallStep, /MAKENSIS=/);
  assert.doesNotMatch(nsisInstallStep, /choco install nsis/);
  assert.match(
    windowsPackageStep,
    /New-Item -ItemType Directory -Force "dist\\windows" \| Out-Null/,
  );
  assert.ok(
    windowsPackageStep.indexOf('New-Item -ItemType Directory -Force "dist\\windows"') <
      windowsPackageStep.indexOf("& $makensis"),
  );
  assert.match(windowsPackageStep, /\$makensis = \$env:MAKENSIS/);
  assert.match(
    windowsPackageStep,
    /Get-Command makensis -ErrorAction SilentlyContinue/,
  );
  assert.doesNotMatch(windowsPackageStep, /\$makensis = "makensis"/);
  assert.doesNotMatch(workflow, /windows-x64-portable\.zip/);
  assert.doesNotMatch(workflow, /codey-windows-x64-portable/);
});
