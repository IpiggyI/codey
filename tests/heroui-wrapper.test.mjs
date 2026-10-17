import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

import { readAppStyles } from "./helpers/read-app-styles.mjs";

const root = new URL("../", import.meta.url);

async function listFiles(dirUrl) {
  const files = [];
  for (const entry of await readdir(dirUrl, { withFileTypes: true })) {
    const next = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dirUrl);
    if (entry.isDirectory()) files.push(...(await listFiles(next)));
    else files.push(next);
  }
  return files;
}

test("shared controls are backed by HeroUI without Mantine remnants", async () => {
  const [wrapper, styles, packageSource] = await Promise.all([
    readFile(new URL("src/components/ui/index.tsx", root), "utf8"),
    readAppStyles(root),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  for (const component of [
    "export function Badge",
    "export function Button",
    "export function Checkbox",
    "export function Input",
    "export function PasswordInput",
    "export function Select",
    "export function Switch",
    "export function Tooltip",
    "export function Dialog",
  ]) {
    assert.match(wrapper, new RegExp(component.replaceAll(" ", "\\s+")));
  }
  assert.match(wrapper, /from "@heroui\/react"/);
  assert.doesNotMatch(wrapper, /@mantine\//);
  assert.doesNotMatch(wrapper, /from "@mantine\/core"/);
  assert.match(wrapper, /<Modal\.CloseTrigger aria-label="关闭" \/>/);
  assert.match(packageSource, /"@heroui\/react": "3\.2\.4"/);
  assert.doesNotMatch(packageSource, /@mantine\//);
  assert.doesNotMatch(`${wrapper}\n${styles}\n${packageSource}`, /@douyinfe|\.semi-|--semi-/);
});

test("src, package.json and the lockfile keep no Mantine remnants", async () => {
  const [packageSource, lockSource, srcFiles] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("pnpm-lock.yaml", root), "utf8"),
    listFiles(new URL("src/", root)),
  ]);

  assert.doesNotMatch(packageSource, /@mantine\//, "package.json must not reintroduce @mantine/*");
  assert.doesNotMatch(lockSource, /@mantine\//, "pnpm-lock.yaml must not reintroduce @mantine/*");

  for (const file of srcFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /mantine/i,
      `${file.pathname} must not mention Mantine after the library drop`,
    );
  }

  await assert.rejects(
    () => access(new URL("src/mantine.ts", root), constants.F_OK),
    { code: "ENOENT" },
  );
  await assert.rejects(
    () => access(new URL("src/components/mantine/index.tsx", root), constants.F_OK),
    { code: "ENOENT" },
  );
});

test("operations status details expand through HeroUI Disclosure", async () => {
  const source = await readFile(
    new URL("src/OperationsPanel.tsx", root),
    "utf8",
  );

  assert.match(source, /import \{ Card, Disclosure \} from "@heroui\/react"/);
  assert.match(source, /import \{ Badge, Button \} from "\.\/components\/ui"/);
  assert.match(source, /<Disclosure[\s\S]*isExpanded=\{Boolean\(activeCardTitle\)\}/);
  assert.match(source, /<Disclosure\.Content>/);
  assert.doesNotMatch(source, /\{activeCardTitle && \(\s*<div\s+className="operations-expanded-grid"/);
  assert.doesNotMatch(source, /from "\.\/components\/mantine"/);
  assert.doesNotMatch(source, /@mantine\/core/);
});

test("standard selects leave dropdown lifecycle and positioning to HeroUI", async () => {
  const wrapper = await readFile(
    new URL("src/components/ui/index.tsx", root),
    "utf8",
  );

  assert.doesNotMatch(wrapper, /useCloseSelectOnScroll|addEventListener\("scroll"/);
  assert.doesNotMatch(wrapper, /dropdownOpened=\{|onDropdownOpen=|onDropdownClose=/);
  assert.match(wrapper, /<HeroSelect[\s\S]*<HeroSelect\.Popover/);
});

test("console cards and settings shell use HeroUI without Mantine imports", async () => {
  const files = [
    "src/App.tsx",
    "src/AppDialogs.tsx",
    "src/SettingsModalShell.tsx",
    "src/OperationsPanel.tsx",
    "src/FeaturePolicyCard.tsx",
    "src/PromptOptimizationCard.tsx",
  ];
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, root), "utf8")),
  );
  for (const [file, source] of files.map((file, index) => [file, sources[index]])) {
    assert.doesNotMatch(source, /from "\.\/components\/mantine"/, file);
    assert.doesNotMatch(source, /from "\.\/mantine"/, file);
    assert.doesNotMatch(source, /@mantine\/core/, file);
    assert.doesNotMatch(source, /from "@mantine\//, file);
  }
  assert.match(sources[0], /from "\.\/components\/ui"/);
  assert.match(sources[1], /from "\.\/components\/ui"/);
  assert.match(sources[2], /from "@heroui\/react"/);
  assert.match(sources[2], /<Modal\.Backdrop/);
  assert.match(sources[3], /<Disclosure[\s\S]*isExpanded=\{Boolean\(activeCardTitle\)\}/);
  assert.match(sources[4], /<Table className="subagent-table"/);
  assert.match(sources[5], /<PasswordInput[\s\S]*onVisibilityChange=/);
});

test("notification channels, notices and trace log use HeroUI without Mantine imports", async () => {
  const files = [
    "src/notifications/NotificationChannelDialog.tsx",
    "src/notifications/NotificationChannelsCard.tsx",
    "src/notifications/TelegramChannelEditor.tsx",
    "src/notifications/WebhookChannelEditor.tsx",
    "src/notifications/WechatClawChannelEditor.tsx",
    "src/useAppNotice.tsx",
    "src/TraceLogModule.tsx",
  ];
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, root), "utf8")),
  );
  for (const [file, source] of files.map((file, index) => [file, sources[index]])) {
    assert.doesNotMatch(source, /from "\.\.\/components\/mantine"/, file);
    assert.doesNotMatch(source, /from "\.\/components\/mantine"/, file);
    assert.doesNotMatch(source, /from "\.\/mantine"/, file);
    assert.doesNotMatch(source, /@mantine\/core/, file);
  }
  assert.match(sources[0], /from "\.\.\/components\/ui"/);
  assert.match(sources[0], /<DialogContent[\s\S]*container=\{container \?\? popupContainer/);
  assert.match(sources[1], /import \{ Card \} from "@heroui\/react"/);
  assert.match(sources[1], /from "\.\.\/components\/ui"/);
  assert.match(sources[5], /from "\.\/components\/ui"/);
  assert.match(sources[5], /autoDismissEnabled/);
  assert.match(sources[6], /import \{ Card \} from "@heroui\/react"/);
  assert.match(sources[6], /from "\.\/components\/ui"/);
});

test("subagent model picker uses HeroUI ComboBox primitives", async () => {
  const [wrapper, picker] = await Promise.all([
    readFile(new URL("src/components/ui/index.tsx", root), "utf8"),
    readFile(new URL("src/components/ModelCombobox.tsx", root), "utf8"),
  ]);

  assert.doesNotMatch(wrapper, /from "@mantine\/core"/);
  assert.doesNotMatch(wrapper, /export \{ Combobox, InputBase, useCombobox \}/);
  assert.match(picker, /from "@heroui\/react"/);
  assert.match(picker, /<ComboBox[\s\S]*selectedKey=\{selectedKey\}/);
  assert.match(picker, /<ListBox\.Section/);
  assert.match(picker, /<Virtualizer/);
  assert.match(picker, /UNSAFE_PortalProvider/);
  assert.doesNotMatch(picker, /from "\.\/mantine"/);
  assert.doesNotMatch(picker, /@mantine\/core/);
});

test("settings overlay stays inside body", async () => {
  const overlaySource = await readFile(
    new URL("src/overlay.tsx", root),
    "utf8",
  );

  assert.match(
    overlaySource,
    /function getOverlayMountTarget\(\) \{\s*return document\.body \?\? document\.documentElement;/,
  );
  assert.equal(
    overlaySource.match(/getOverlayMountTarget\(\)\.appendChild\(host\)/g)?.length,
    2,
  );
  assert.doesNotMatch(
    overlaySource,
    /document\.documentElement\.appendChild\(host\)/,
  );
});

test("official model editor dialog stays inside the settings overlay", async () => {
  const source = await readFile(
    new URL("src/ModelSection.tsx", root),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /getPopupContainer=\{\(\) => popupContainer \?\? document\.body\}/,
  );
  assert.equal(
    source.match(/zIndex=\{SETTINGS_OVERLAY_Z_INDEX\}/g)?.length,
    1,
  );
  assert.match(source, /<DialogContent[\s\S]{0,180}zIndex=\{SETTINGS_OVERLAY_Z_INDEX\}/);
});

test("Tailwind is compiled for both the page and Shadow DOM overlay", async () => {
  const [packageSource, viteSource, overlayViteSource, mainSource, overlaySource, tailwindSource] =
    await Promise.all([
      readFile(new URL("package.json", root), "utf8"),
      readFile(new URL("vite.config.ts", root), "utf8"),
      readFile(new URL("vite.overlay.config.ts", root), "utf8"),
      readFile(new URL("src/main.tsx", root), "utf8"),
      readFile(new URL("src/overlay.tsx", root), "utf8"),
      readFile(new URL("src/tailwind.css", root), "utf8"),
    ]);

  assert.match(packageSource, /"tailwindcss": "4\.3\.0"/);
  assert.match(packageSource, /"@tailwindcss\/vite": "4\.3\.0"/);
  assert.match(viteSource, /plugins: \[react\(\), tailwindcss\(\)\]/);
  assert.match(overlayViteSource, /plugins: \[react\(\), tailwindcss\(\)\]/);
  assert.match(mainSource, /import "\.\/tailwind\.css"/);
  assert.match(mainSource, /<UiProvider>/);
  assert.doesNotMatch(mainSource, /MantineProvider|@mantine\/core|codeyMantineTheme/);
  assert.match(overlaySource, /import tailwindStyles from "\.\/tailwind\.css\?inline"/);
  assert.match(overlaySource, /<UiProvider container=\{modalContainer\}>/);
  assert.match(
    overlaySource,
    /shadowStyleSheet\(\s*tailwindStyles,\s*coreStyles,/,
  );
  assert.doesNotMatch(
    overlaySource,
    /MantineProvider|@mantine\/core|codeyMantineTheme|mantineStyles|data-mantine-color-scheme/,
  );
  assert.match(overlaySource, /dataset\.theme = "light"/);
  assert.match(tailwindSource, /@import "tailwindcss"/);
});

test("legacy component-library CSS overrides stay removed", async () => {
  const [wrapper, styles, overlaySource] = await Promise.all([
    readFile(new URL("src/components/ui/index.tsx", root), "utf8"),
    readAppStyles(root),
    readFile(new URL("src/overlay.tsx", root), "utf8"),
  ]);

  assert.doesNotMatch(styles, /!important|\.codey-(?:button|input|select|switch|tag)/);
  assert.doesNotMatch(`${wrapper}\n${overlaySource}`, /styles\.components\.css|overlay\.css|all:\s*initial/);
});

test("console surfaces do not erase page spacing with inline padding", async () => {
  const [modalShell, appSource, styles, uiClasses] = await Promise.all([
    readFile(new URL("src/SettingsModalShell.tsx", root), "utf8"),
    readFile(new URL("src/App.tsx", root), "utf8"),
    readAppStyles(root),
    readFile(new URL("src/uiClasses.ts", root), "utf8"),
  ]);

  assert.match(uiClasses, /surfaceCardPaddingClass = "px-5! py-\[18px\]!"/);
  assert.match(uiClasses, /flushCardClass = "p-0!"/);
  assert.match(modalShell, /Modal\.Container[\s\S]*className="p-3 max-\[760px\]:p-1\.5"/);
  assert.match(modalShell, /settings-modal-header[\s\S]*px-5 py-2\.5/);
  assert.match(modalShell, /settings-modal-body relative flex min-h-0 flex-1/);
  assert.doesNotMatch(
    `${styles}\n${appSource}`,
    /\.config-header-(?:inner|right|actions)|\.config-brand(?:-|\s*\{)/,
  );
  assert.match(
    styles,
    /\.notification-channel-list\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
  );
  assert.doesNotMatch(
    styles,
    /\.notification-channel-list > li:only-child/,
  );
  assert.doesNotMatch(
    styles,
    /\.feature-grid > \.feature-card:last-child:nth-child\(odd\)/,
  );
});

test("notification channel select and input fields preserve proper icon gap and full width", async () => {
  const [dialogSource, uiClasses, wrapper] = await Promise.all([
    readFile(
      new URL("src/notifications/NotificationChannelDialog.tsx", root),
      "utf8",
    ),
    readFile(new URL("src/uiClasses.ts", root), "utf8"),
    readFile(new URL("src/components/ui/index.tsx", root), "utf8"),
  ]);

  assert.match(dialogSource, /prefix=\{/);
  assert.match(dialogSource, /SelectedChannelIcon size=\{20\}/);
  assert.doesNotMatch(dialogSource, /leftSectionWidth/);
  assert.doesNotMatch(dialogSource, /leftSectionPointerEvents/);
  assert.doesNotMatch(
    dialogSource,
    /data-\[position=left\]:ml-/,
    "Left section margin should not offset icon into select label text",
  );
  assert.match(
    uiClasses,
    /\[&_\[data-slot=input\]\]:flex-1/,
    "HeroUI inputs inside inputShellClass must flex to fill available width",
  );
  assert.match(
    wrapper,
    /<HeroInput fullWidth \{\.\.\.inputProps\} className=\{cn\("min-w-0", className\)\}/,
    "HeroUI Input must stretch horizontally by default",
  );
});
