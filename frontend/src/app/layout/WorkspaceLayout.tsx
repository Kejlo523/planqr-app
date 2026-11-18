import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { FaBars, FaChevronLeft, FaChevronRight, FaTimes } from "react-icons/fa";
import { useTheme } from "../../context/ThemeContext";
import AdminPanelSidebar, {
  type AdminNavigationGroup,
  type AdminNavigationKey,
} from "../features/Registry/adminPanel/AdminPanelSidebar";
import { adminViewMeta } from "../features/Registry/adminPanel/helpers";
import type { AdminPanelView } from "../features/Registry/adminPanel/types";
import { WorkspaceHeader } from "./WorkspaceHeader";
import "./WorkspaceLayout.css";

const adminPath = "/adminpanel";
const collapseKey = "planqr.admin.sidebar.collapsed";

type AdminNavigation = {
  ownPlan: boolean;
  currentView?: AdminPanelView;
  onSelect?: (key: AdminNavigationKey) => void;
};

interface WorkspaceLayoutProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  login?: string;
  back?: { to: string; label: string };
  onLogout?: () => void;
  navigation?: AdminNavigation;
  children: ReactNode;
}

export function WorkspaceLayout({ title, login, back, onLogout, navigation, children,
  className, ...layoutProps }: WorkspaceLayoutProps) {
  const { theme } = useTheme();
  const { pathname, search } = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapseKey) === "true");
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const mobileClose = useRef<HTMLButtonElement>(null);
  const inPlan = pathname === "/lecturerPlan";
  const inPreview = inPlan && new URLSearchParams(search).get("mode") === "admin-preview";
  const select = navigation?.onSelect;

  useEffect(() => {
    if (!mobileOpen) return;
    if (window.matchMedia("(min-width: 721px)").matches) {
      setMobileOpen(false);
      return;
    }
    mobileClose.current?.focus();
    const media = window.matchMedia("(min-width: 721px)");
    const closeOnDesktop = () => { if (media.matches) setMobileOpen(false); };
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, [mobileOpen]);

  const closeMenu = () => {
    setMobileOpen(false);
    mobileTrigger.current?.focus();
  };
  const toggleSidebar = () => {
    localStorage.setItem(collapseKey, String(!collapsed));
    setCollapsed(!collapsed);
  };
  const viewItem = (key: AdminPanelView, label = adminViewMeta[key].label) => {
    const item = { key, label, icon: adminViewMeta[key].icon, active: navigation?.currentView === key };
    return select ? item : { ...item, to: key === "devices" ? adminPath : `${adminPath}?view=${key}` };
  };
  const pairingItem = { key: "pairing" as const, label: "Parowanie kodem QR", icon: "fas fa-qrcode" };
  const groups: AdminNavigationGroup[] = [
    { label: "Tablety", items: [
      viewItem("devices", "Wszystkie tablety"),
      viewItem("pending-tablets", "Oczekujące"),
      select ? pairingItem : { ...pairingItem, to: `${adminPath}?pair=1` },
      viewItem("tablet-preview"),
    ] },
    { label: "Zajęcia i obecność", items: [
      { key: "lecturer-preview", label: "Podgląd planu", icon: "fas fa-calendar-alt", to: "/lecturerPlan?mode=admin-preview", active: inPreview },
      ...(navigation?.ownPlan ? [{
        key: "lecturer", label: "Mój plan", icon: "fas fa-user", to: "/lecturerPlan", active: inPlan && !inPreview,
      }] : []),
      { key: "kantech", label: "Kantech na żywo", icon: "fas fa-id-card", to: "/adminpanel/kantech", active: pathname === "/adminpanel/kantech" },
    ] },
    { label: "Zarządzanie", items: [
      viewItem("schedule", "Ustawienia ekranów"),
      viewItem("priority-gallery", "Komunikaty"),
      viewItem("admins"),
    ] },
  ];
  const selectItem = (key: AdminNavigationKey) => {
    if (mobileOpen) closeMenu();
    select?.(key);
  };

  return (
    <div {...layoutProps} className={["admin-console", "workspace-layout", className].filter(Boolean).join(" ")}
      data-admin-theme={theme} data-sidebar={navigation ? (collapsed ? "collapsed" : "expanded") : undefined}>
      <WorkspaceHeader title={title} login={login} back={back} onLogout={onLogout} menu={navigation && (
        <>
          <button type="button" className="admin-icon-button workspace-layout__desktop-trigger"
            onClick={toggleSidebar} aria-controls="workspace-sidebar" aria-expanded={!collapsed}
            aria-label={collapsed ? "Rozwiń panel boczny" : "Zwiń panel boczny"}
            title={collapsed ? "Rozwiń panel boczny" : "Zwiń panel boczny"}>
            {collapsed ? <FaChevronRight aria-hidden="true" /> : <FaChevronLeft aria-hidden="true" />}
          </button>
          <button ref={mobileTrigger} type="button" className="admin-icon-button admin-console__mobile-trigger"
            onClick={() => setMobileOpen(true)} aria-controls={mobileOpen ? "workspace-mobile-sidebar" : undefined}
            aria-expanded={mobileOpen} aria-label="Otwórz sekcje panelu">
            <FaBars aria-hidden="true" />
          </button>
        </>
      )} />
      {navigation && <AdminPanelSidebar groups={groups} id="workspace-sidebar"
        className="admin-nav--desktop" unavailable={collapsed} onItemSelect={selectItem} />}
      <div className="workspace-layout__content">{children}</div>
      {navigation && (
        <div className="admin-mobile-panel__overlay admin-mobile-panel__overlay--nav workspace-layout__mobile-overlay"
          data-open={mobileOpen} aria-hidden={!mobileOpen} onClick={closeMenu}>
          <aside className="admin-mobile-panel admin-mobile-panel--nav" id="workspace-mobile-sidebar"
            role="dialog" aria-modal={mobileOpen || undefined} aria-labelledby="workspace-mobile-nav-title"
            onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
              if (event.key === "Escape") {
                closeMenu();
              } else if (event.key === "Tab") {
                const controls = event.currentTarget.querySelectorAll<HTMLElement>("a[href], button");
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}>
            <header className="admin-mobile-panel__header">
              <h2 className="admin-mobile-panel__title" id="workspace-mobile-nav-title">Sekcje</h2>
              <button ref={mobileClose} type="button" className="admin-icon-button"
                onClick={closeMenu} tabIndex={mobileOpen ? undefined : -1} aria-label="Zamknij sekcje">
                <FaTimes aria-hidden="true" />
              </button>
            </header>
            <div className="admin-mobile-panel__body">
              <AdminPanelSidebar className="admin-nav--mobile" groups={groups}
                unavailable={!mobileOpen} onItemSelect={selectItem} onLinkSelect={closeMenu} />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
