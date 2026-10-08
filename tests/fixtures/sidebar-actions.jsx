import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

// Mirror the native action props and DOM; side effects only record test events.
window.actionEvents = [];
window.bridgeEvents = [];
window.__codeyCodexSignalDispatcher = async () => {};
window.__codexSessionDeleteBridge = async (path, payload) => {
  window.bridgeEvents.push({ path, payload });
  if (path === "/session/export/start") return { status: "ready", transferId: "test", filename: "test.json", size: 2 };
  if (path === "/session/export/chunk") return { status: "ok", offset: 0, nextOffset: 2, data: "e30=", done: true };
  if (path === "/session/delete") return { status: "ok", deleted: true };
  return { status: "ok" };
};
window.showSaveFilePicker = async () => ({ createWritable: async () => ({
  write: async () => {}, close: async () => {}, abort: async () => {},
}) });

function Button({ children, ...props }) {
  return <button className="native-action" data-color="secondary" data-variant="transparent" data-size="3xs" {...props}>
    <span className="native-inner">{children || <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /></svg>}</span>
  </button>;
}

function NativeActions({ archive, getMenuItems, retainArchiveAction, loading, openMenu, pinAction, menuOpen }) {
  return <div className="native-actions">
    {getMenuItems && <div role="presentation">
      <Button aria-label="聊天操作" aria-haspopup="menu" aria-busy={loading} data-state={menuOpen ? "open" : "closed"}
        onClick={(event) => { event.stopPropagation(); openMenu(); }} />
    </div>}
    <span className="contents"><Button aria-label="置顶聊天" onClick={(event) => {
      event.stopPropagation(); pinAction();
    }} /></span>
    {archive && (!getMenuItems || retainArchiveAction) && <span className="contents">
      <Button aria-label="归档聊天" onClick={(event) => { event.stopPropagation(); archive(); }} />
    </span>}
  </div>;
}

function Thread({ mode, id, running, loading = false, available = true }) {
  const [confirming, setConfirming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const archive = () => {
    if (running) setConfirming(true);
    else window.actionEvents.push(`archive:${id}`);
  };
  const openMenu = () => setMenuOpen(true);
  return <>
    <div className="native-row" data-app-action-sidebar-thread-row="" data-app-action-sidebar-thread-id={`local:${id}`}
      data-app-action-sidebar-thread-title={`会话 ${id}`} role="button" tabIndex={0}
      onClick={() => window.actionEvents.push(`navigate:${id}`)}
      onKeyDown={(event) => {
        if (event.currentTarget === event.target && ["Enter", " "].includes(event.key)) {
          event.preventDefault();
          window.actionEvents.push(`navigate:${id}`);
        }
      }}
      onContextMenu={(event) => { event.preventDefault(); openMenu(); }}>
      <span data-thread-title="">会话 {id}</span>
      <NativeActions archive={available ? archive : null} loading={loading}
        getMenuItems={mode === "work" ? () => ["重命名", "复制"] : undefined}
        retainArchiveAction={mode !== "work"} menuOpen={menuOpen} openMenu={openMenu}
        pinAction={() => window.actionEvents.push(`pin:${id}`)} />
    </div>
    {confirming && <div role="dialog" aria-label="原生归档确认">
      <button onClick={() => { window.actionEvents.push(`archive:${id}`); setConfirming(false); }}>确认归档</button>
    </div>}
    {menuOpen && <div role="menu">
      <button role="menuitem" onClick={() => { window.actionEvents.push(`rename:${id}`); setMenuOpen(false); }}>重命名</button>
    </div>}
  </>;
}

const root = createRoot(document.getElementById("root"));
function Shell({ children }) { return children; }
window.renderThread = (props) => flushSync(() => {
  let tree = <Thread {...props} />;
  for (let depth = 0; depth < 304; depth += 1) tree = <Shell>{tree}</Shell>;
  root.render(tree);
});
window.renderThread({ mode: "work", id: "thread-1", running: true });
