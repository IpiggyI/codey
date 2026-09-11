import ReactDOM from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import mantineStyles from "@mantine/core/styles.css?inline";
// react-aria 用同一份模块实例读取该开关，必须从 react-stately 内部路径导入才能生效。
import { enableShadowDOM } from "react-stately/private/flags/flags";
import { App } from "./App";
import coreStyles from "./styles.css?inline";
import operationsStyles from "./styles.operations.css?inline";
import modelStyles from "./styles.models.css?inline";
import featureStyles from "./styles.features.css?inline";
import diagnosticStyles from "./styles.diagnostics.css?inline";
import responsiveStyles from "./styles.responsive.css?inline";
import { codeyApiPath } from "./api";
import { SETTINGS_OVERLAY_Z_INDEX_CSS } from "./overlay.constants";
import { SETTINGS_OPENED_EVENT } from "./useRuntimeStatus";
import { codeyMantineTheme } from "./mantine";
import { shadowStyleSheet } from "./shadowStyles";
import tailwindStyles from "./tailwind.css?inline";
import { UiProvider } from "./UiProvider";

type OverlayController = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
};

declare global {
  interface Window {
    __codexSessionDeleteBridge?: (
      path: string,
      payload: unknown,
    ) => Promise<unknown>;
    __codeySettingsOverlay?: OverlayController;
  }
}

function getOverlayMountTarget() {
  return document.body ?? document.documentElement;
}

window.__codeyInvokeApi = async (command, args) => {
  if (typeof window.__codexSessionDeleteBridge !== "function") {
    throw new Error("Codey bridge 尚未就绪");
  }
  return window.__codexSessionDeleteBridge(codeyApiPath(command), args);
};

if (!window.__codeySettingsOverlay) {
  const host = document.createElement("div");
  host.id = "codey-settings-overlay-host";
  host.style.display = "none";
  host.style.setProperty("inset", "0", "important");
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty(
    "--codey-settings-overlay-z-index",
    SETTINGS_OVERLAY_Z_INDEX_CSS,
  );
  host.style.setProperty(
    "z-index",
    SETTINGS_OVERLAY_Z_INDEX_CSS,
    "important",
  );
  host.style.setProperty("background", "transparent", "important");
  host.setAttribute("data-mantine-color-scheme", "light");
  host.setAttribute("aria-hidden", "true");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.adoptedStyleSheets = [
    shadowStyleSheet(
      tailwindStyles,
      mantineStyles,
      coreStyles,
      operationsStyles,
      modelStyles,
      featureStyles,
      diagnosticStyles,
      responsiveStyles,
    ),
  ];
  // HeroUI 的主题变量声明在 :root / [data-theme] 上，ShadowRoot 内没有 :root，
  // 因此在两个挂载容器上显式声明主题；react-aria 也需要开启 Shadow DOM 感知。
  enableShadowDOM();
  const rootElement = document.createElement("div");
  rootElement.id = "codey-overlay-root";
  rootElement.dataset.theme = "light";
  rootElement.style.inset = "0";
  rootElement.style.pointerEvents = "none";
  rootElement.style.position = "fixed";
  rootElement.style.width = "100%";
  rootElement.setAttribute("data-mantine-color-scheme", "light");
  const modalContainer = document.createElement("div");
  modalContainer.id = "codey-overlay-modal-container";
  modalContainer.dataset.theme = "light";
  modalContainer.style.inset = "0";
  modalContainer.style.position = "fixed";
  modalContainer.style.width = "100%";
  modalContainer.setAttribute("data-mantine-color-scheme", "light");
  shadow.append(rootElement, modalContainer);
  getOverlayMountTarget().appendChild(host);

  let hideTimer: number | undefined;
  let visible = false;

  const hide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
    host.style.display = "none";
    host.setAttribute("aria-hidden", "true");
  };
  const reactRoot = ReactDOM.createRoot(rootElement);
  const render = (visible: boolean) => {
    reactRoot.render(
      <UiProvider container={modalContainer}>
        <MantineProvider
          cssVariablesSelector=":host"
          forceColorScheme="light"
          getRootElement={() => host}
          theme={codeyMantineTheme}
        >
          <App
            embedded
            modalContainer={modalContainer}
            modalVisible={visible}
            onAfterClose={hide}
            onClose={close}
          />
        </MantineProvider>
      </UiProvider>,
    );
  };
  const close = () => {
    if (!visible) return;
    visible = false;
    render(false);
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 250);
  };
  const open = () => {
    if (visible) return;
    visible = true;
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
    getOverlayMountTarget().appendChild(host);
    host.style.display = "block";
    host.setAttribute("aria-hidden", "false");
    render(true);
    window.dispatchEvent(new CustomEvent(SETTINGS_OPENED_EVENT));
  };
  const isOpen = () => visible;

  render(false);
  window.__codeySettingsOverlay = {
    open,
    close,
    isOpen,
    toggle: () => (visible ? close() : open()),
  };
}
