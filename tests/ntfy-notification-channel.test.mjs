import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

const typesSource = read("src/notifications/types.ts");
const registrySource = read("src/notifications/channelRegistry.tsx");
const editorSource = read("src/notifications/NtfyChannelEditor.tsx");
const cardSource = read("src/notifications/NotificationChannelsCard.tsx");
const styleSource = read("src/styles.features.css");
const mockSource = read("src/dev/mockApi.ts");
const { validateNtfyChannel } = await loadTypeScriptModule(
  new URL("../src/notifications/types.ts", import.meta.url),
);

test("ntfy is a server plus topic notification channel", () => {
  assert.match(typesSource, /"ntfy"/);
  assert.match(registrySource, /ntfy:\s*\{[\s\S]*?Editor: NtfyChannelEditor/);
  assert.match(registrySource, /displayName: "ntfy"/);
  assert.match(registrySource, /iconClassName: "ntfy"/);
  assert.match(editorSource, /https:\/\/ntfy\.sh/);
  assert.match(editorSource, /服务器地址/);
  assert.match(editorSource, /主题/);
  assert.match(editorSource, /访问令牌/);
  assert.match(editorSource, /公开主题可留空/);
  assert.match(editorSource, /clearBotToken: false/);
  assert.doesNotMatch(editorSource, /clearBotToken: true|clearUrl: true/);
  assert.match(styleSource, /\.notification-title span\.ntfy \{/);
  assert.doesNotMatch(cardSource, /ntfy/);
});

test("ntfy participates in the preview fixtures and runtime status count", () => {
  assert.match(
    mockSource,
    /kind: "ntfy" as const[\s\S]*?chatId: "preview-ntfy-topic"/,
  );
  assert.match(
    mockSource,
    /channel\.kind === "ntfy"[\s\S]*?channel\.urlConfigured && !validateNtfyTopic\(channel\.chatId\)/,
  );
  assert.match(
    mockSource,
    /channel\?\.kind === "ntfy"[\s\S]*?channel\.url\?\.trim\(\)\) && !validateNtfyTopic\(channel\.chatId \?\? ""\)/,
  );
});

const draft = (patch = {}) => ({
  url: "https://ntfy.sh",
  urlConfigured: false,
  chatId: "codey-notify",
  ...patch,
});

test("ntfy editor asks for a missing server address or topic", () => {
  assert.equal(
    validateNtfyChannel(draft({ url: "  " })).url,
    "请先填写 ntfy 服务器地址",
  );
  assert.equal(
    validateNtfyChannel(draft({ chatId: "  " })).topic,
    "请先填写 ntfy 主题",
  );
  assert.deepEqual(validateNtfyChannel(draft()), { url: "", topic: "" });
  assert.deepEqual(
    validateNtfyChannel(draft({ url: "https://ntfy.example.com:8443/" })),
    { url: "", topic: "" },
  );
  // 已保存的地址不回显，留空表示沿用。
  assert.equal(
    validateNtfyChannel(draft({ url: "", urlConfigured: true })).url,
    "",
  );
  assert.match(editorSource, /issues\.url/);
  assert.match(editorSource, /issues\.topic/);
  assert.match(
    registrySource,
    /validateNtfyChannel\(channel\)[\s\S]*?!issues\.url && !issues\.topic/,
  );
});

test("ntfy editor rejects server addresses that are not an HTTPS root", () => {
  for (const url of [
    "http://ntfy.sh",
    "ftp://ntfy.sh",
    "ntfy.sh",
    "https://",
    "https://user:pw@ntfy.sh",
    "https://ntfy.sh/topic",
    "https://ntfy.sh/?auth=1",
    "https://ntfy.sh/#top",
  ]) {
    assert.match(
      validateNtfyChannel(draft({ url })).url,
      /必须是 HTTPS 根地址/,
      url,
    );
  }
});

test("ntfy editor only accepts topics the backend accepts", () => {
  const message = "ntfy 主题只能包含字母、数字、下划线和连字符，长度不超过 64 个字符";
  for (const chatId of ["topic.dot", "通知主题", "a".repeat(65), "has space", "a/b"]) {
    assert.equal(validateNtfyChannel(draft({ chatId })).topic, message, chatId);
  }
  for (const chatId of ["a".repeat(64), "Codey_notify-1", "  codey  "]) {
    assert.equal(validateNtfyChannel(draft({ chatId })).topic, "", chatId);
  }
  assert.equal(validateNtfyChannel(draft({ chatId: "" })).topic, "请先填写 ntfy 主题");
  assert.match(editorSource, /topicIssueClass/);
});
