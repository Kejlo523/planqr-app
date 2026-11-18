import { Link } from "react-router-dom";
import type { AdminPanelView } from "./types";

export type AdminNavigationKey = AdminPanelView | "pairing";

type NavigationItem = {
  label: string;
  icon: string;
  active?: boolean;
} & ({ key: AdminNavigationKey; to?: undefined } | { key: string; to: string });

export interface AdminNavigationGroup {
  label: string;
  items: NavigationItem[];
}

interface AdminPanelSidebarProps {
  groups: AdminNavigationGroup[];
  onItemSelect: (key: AdminNavigationKey) => void;
  onLinkSelect?: () => void;
  ariaLabel: string;
  compact?: boolean;
  unavailable?: boolean;
  className?: string;
}

const AdminPanelSidebar = ({
  groups,
  onItemSelect,
  onLinkSelect,
  ariaLabel,
  compact = false,
  unavailable = false,
  className,
}: AdminPanelSidebarProps) => (
  <nav
    className={["admin-nav", className].filter(Boolean).join(" ")}
    aria-label={ariaLabel}
    aria-hidden={unavailable || undefined}
  >
    {groups.map(({ label, items }) => (
      <div className="admin-nav__group" key={label}>
        <h2 className="admin-nav__section-title">{label}</h2>
        <ul className="admin-nav__list">
          {items.map((item) => {
            const content = <><i className={item.icon} aria-hidden="true" /><span className="admin-nav__label">{item.label}</span></>;
            return (
              <li key={item.key} className="admin-nav__item">
                {item.to !== undefined ? (
                  <Link to={item.to} className="admin-nav__button"
                    title={compact ? item.label : undefined}
                    aria-current={item.active ? "page" : undefined}
                    tabIndex={unavailable ? -1 : undefined}
                    onClick={onLinkSelect}>{content}</Link>
                ) : (
                  <button
                    type="button"
                    className="admin-nav__button"
                    title={compact ? item.label : undefined}
                    onClick={() => onItemSelect(item.key)}
                    aria-current={item.active ? "page" : undefined}
                    tabIndex={unavailable ? -1 : undefined}
                  >
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    ))}
  </nav>
);

export default AdminPanelSidebar;
