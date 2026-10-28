import type { ReactNode } from "react";

// 复用各页现有的 section-title 标题样式，让扩展页与其他页面的标题保持一致。
type SettingsPageHeaderProps = {
  id: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: ReactNode;
};

export function SettingsPageHeader({ id, title, description, actions, icon }: SettingsPageHeaderProps) {
  return (
    <div className="section-title">
      <div className="section-heading">
        {icon && (
          <span className="section-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </div>
      {actions && <div className="route-heading-actions">{actions}</div>}
    </div>
  );
}
