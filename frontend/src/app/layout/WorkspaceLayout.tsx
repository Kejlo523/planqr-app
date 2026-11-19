import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FaBars, FaChevronLeft, FaChevronRight, FaSignOutAlt, FaTimes, FaUser } from "react-icons/fa";
import { useTheme } from "../../context/ThemeContext";
import AdminPanelSidebar, {
  type AdminNavigationGroup,
  type AdminNavigationKey,
} from "../features/Registry/adminPanel/AdminPanelSidebar";
import { adminViewMeta } from "../features/Registry/adminPanel/helpers";
import type { AdminPanelView } from "../features/Registry/adminPanel/types";
import { logout } from "../services/authService";
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
  onLogout?: () => void | Promise<void>;
  navigation?: AdminNavigation;
  children: ReactNode;
}

function WorkspaceAccount({ login, role, onLogout, signingOut, unavailable = false }: {
  login?: string;
  role: string;
  onLogout: () => void;
  signingOut: boolean;
  unavailable?: boolean;
}) {
  const initial = Array.from(login?.trim() ?? "")[0]?.toLocaleUpperCase("pl");
  return (
    <footer className="workspace-account" aria-label={login ? "Konto " + login : "Konto użytkownika"}>
      <span className="workspace-account__avatar" title={login} aria-hidden="true">
        {initial || <FaUser />}
      </span>
      <div className="workspace-account__identity">
        <strong title={login}>{login || "Konto"}</strong>
        <span>{role}</span>
      </div>
      <button type="button" className="admin-icon-button workspace-account__logout"
        aria-label="Wyloguj" title="Wyloguj" disabled={signingOut}
        tabIndex={unavailable ? -1 : undefined} onClick={onLogout}>
        <FaSignOutAlt aria-hidden="true" />
      </button>
    </footer>
  );
}

export function WorkspaceLayout({ title, login, back, onLogout, navigation, children,
  className, ...layoutProps }: WorkspaceLayoutProps) {
  const { theme } = useTheme();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const sidebarPreference = navigation ? collapseKey : "planqr.lecturer.sidebar.collapsed";
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(sidebarPreference);
    return saved === null ? !navigation : saved === "true";
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
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
    localStorage.setItem(sidebarPreference, String(!collapsed));
    setCollapsed(!collapsed);
  };
  const signOut = async () => {
    setSigningOut(true);
    try {
      if (onLogout) {
        await onLogout();
      } else {
        await logout();
        navigate("/");
      }
    } catch {
      window.alert("Nie udało się wylogować.");
    } finally {
      setSigningOut(false);
    }
  };
  const viewItem = (key: AdminPanelView, label = adminViewMeta[key].label) => {
    const item = { key, label, icon: adminViewMeta[key].icon, active: navigation?.currentView === key };
    return select ? item : { ...item, to: key === "devices" ? adminPath : `${adminPath}?view=${key}` };
  };
  const pairingItem = { key: "pairing" as const, label: "Parowanie kodem QR", icon: "fas fa-qrcode" };
  const groups: AdminNavigationGroup[] = navigation ? [
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
      { key: "kantech", label: "Kantech", icon: "fas fa-id-card", to: "/adminpanel/kantech", active: pathname === "/adminpanel/kantech" },
    ] },
    { label: "Zarządzanie", items: [
      viewItem("schedule", "Ustawienia ekranów"),
      viewItem("priority-gallery", "Komunikaty"),
      viewItem("admins"),
      { key: "audit", label: "Logi", icon: "fas fa-history", to: "/adminpanel/logi", active: pathname === "/adminpanel/logi" },
    ] },
  ] : [
    { label: "Zajęcia", items: [
      { key: "lecturer", label: "Mój plan", icon: "fas fa-calendar-alt", to: "/lecturerPlan", active: inPlan },
    ] },
  ];
  const selectItem = (key: AdminNavigationKey) => {
    if (mobileOpen) closeMenu();
    select?.(key);
  };
  const navigationLabel = navigation ? "Widoki panelu administracyjnego" : "Widoki prowadzącego";
  const accountProps = { login, role: navigation ? "Administrator" : "Prowadzący", signingOut, onLogout: () => void signOut() };

  return (
    <div {...layoutProps} className={["admin-console", "workspace-layout", className].filter(Boolean).join(" ")}
      data-admin-theme={theme} data-sidebar={collapsed ? "collapsed" : "expanded"}>
      <WorkspaceHeader title={title} back={back} menu={
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
      } />
      <aside className="workspace-sidebar" id="workspace-sidebar">
        <AdminPanelSidebar groups={groups} ariaLabel={navigationLabel}
          compact={collapsed} onItemSelect={selectItem} />
        <WorkspaceAccount {...accountProps} />
      </aside>
      <div className="workspace-layout__content">{children}</div>
      <div className="admin-mobile-panel__overlay admin-mobile-panel__overlay--nav workspace-layout__mobile-overlay"
        data-open={mobileOpen} aria-hidden={!mobileOpen} onClick={closeMenu}>
        <aside className="admin-mobile-panel admin-mobile-panel--nav" id="workspace-mobile-sidebar"
          role="dialog" aria-modal={mobileOpen || undefined} aria-labelledby="workspace-mobile-nav-title"
          onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeMenu();
            } else if (event.key === "Tab") {
              const controls = event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)");
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
              ariaLabel={navigationLabel} unavailable={!mobileOpen} onItemSelect={selectItem} onLinkSelect={closeMenu} />
          </div>
          <WorkspaceAccount {...accountProps} unavailable={!mobileOpen} />
        </aside>
      </div>
    </div>
  );
}
