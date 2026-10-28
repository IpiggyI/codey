import { useId, useState, type ReactNode } from "react";
import {
  IconBook2,
  IconCpu,
  IconLayoutDashboard,
  IconServer,
  IconSparkles,
  IconUsersGroup,
} from "@tabler/icons-react";

// 新增页面时追加条目并在 App 的 sections 中提供对应内容；分组按首次出现的顺序展示。
const SETTINGS_PAGES = [
  { id: "overview", title: "基础功能", icon: IconLayoutDashboard, group: "核心配置" },
  { id: "models", title: "provider 与模型", icon: IconCpu, group: "核心配置" },
  { id: "prompt", title: "提示词优化", icon: IconSparkles, group: "核心配置" },
  { id: "subagents", title: "子代理优化", icon: IconUsersGroup, group: "核心配置" },
  { id: "mcp", title: "MCP 管理", icon: IconServer, group: "扩展生态" },
  { id: "skills", title: "Skill 管理", icon: IconBook2, group: "扩展生态" },
] as const;

const SETTINGS_GROUPS = [...new Set(SETTINGS_PAGES.map((page) => page.group))];

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]["id"];
type SettingsSection = ReactNode | ((active: boolean) => ReactNode);

type SettingsLayoutProps = {
  hidden?: boolean;
  sections: Record<SettingsPageId, SettingsSection>;
};

export function SettingsLayout({ sections, hidden = false }: SettingsLayoutProps) {
  const [activePage, setActivePage] = useState<SettingsPageId>("overview");
  const [visitedPages, setVisitedPages] = useState<ReadonlySet<SettingsPageId>>(
    () => new Set(["overview"]),
  );
  const id = useId();

  function selectPage(page: SettingsPageId) {
    setVisitedPages((visited) => visited.has(page) ? visited : new Set([...visited, page]));
    setActivePage(page);
  }

  return (
    <div className="settings-layout" hidden={hidden}>
      <nav className="settings-sidebar" aria-label="配置功能菜单">
        <div className="settings-sidebar-menu">
          {SETTINGS_GROUPS.map((group) => (
            <div key={group} className="settings-nav-group">
              <div className="settings-nav-group-title">{group}</div>
              {SETTINGS_PAGES.filter((page) => page.group === group).map((page) => {
                const Icon = page.icon;
                return (
                  <button
                    key={page.id}
                    id={`${id}-menu-${page.id}`}
                    type="button"
                    className="settings-nav-item"
                    aria-current={activePage === page.id ? "page" : undefined}
                    aria-controls={`${id}-page-${page.id}`}
                    onClick={() => selectPage(page.id)}
                  >
                    <Icon size={16} stroke={1.75} aria-hidden="true" />
                    <span>{page.title}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>

      <div className="settings-content" id="codey-settings-content" tabIndex={-1}>
        {/* 首次访问时挂载页面，之后隐藏而不卸载，保留草稿、展开状态和异步加载结果。 */}
        {SETTINGS_PAGES.map((page) => {
          const active = !hidden && activePage === page.id;
          const content = sections[page.id];
          return (
            <section
              key={page.id}
              id={`${id}-page-${page.id}`}
              className="settings-page"
              aria-labelledby={`${id}-menu-${page.id}`}
              hidden={!active}
            >
              {visitedPages.has(page.id) && (
                <div
                  className="settings-page-scroll page-scroll"
                  aria-labelledby={`${id}-menu-${page.id}`}
                  tabIndex={0}
                >
                  <div className="page">
                    {typeof content === "function" ? content(active) : content}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
