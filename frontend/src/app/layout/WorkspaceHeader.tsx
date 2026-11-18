import { useEffect, useRef, type ReactNode } from "react";
import { FaArrowLeft, FaSignOutAlt } from "react-icons/fa";
import { Link, useNavigate } from "react-router-dom";
import logo from "../../assets/zut_fav.png";
import { logout } from "../services/authService";
import ThemeToggle from "./ThemeToggle";
import "./WorkspaceHeader.css";

export function PlanQrBrand() {
  return <span className="workspace-brand"><img src={logo} alt="" />PlanQR</span>;
}

export function WorkspaceHeader({ title, login, back, menu, onLogout }: {
  title: string;
  login?: string;
  back?: { to: string; label: string };
  menu?: ReactNode;
  onLogout?: () => void;
}) {
  const navigate = useNavigate();
  const settings = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const panel = settings.current;
      if (panel?.open && event.target instanceof Node && !panel.contains(event.target)) panel.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  const signOut = async () => {
    if (settings.current) settings.current.open = false;
    if (onLogout) {
      onLogout();
      return;
    }
    try {
      await logout();
      navigate("/");
    } catch {
      window.alert("Nie udało się wylogować.");
    }
  };

  return (
    <header className="admin-console__appbar workspace-header">
      <div className="workspace-header__location">
        {menu}
        <PlanQrBrand />
        {back && <Link className="workspace-header__back" to={back.to} aria-label={back.label} title={back.label}>
          <FaArrowLeft aria-hidden="true" /> <span>{back.label}</span>
        </Link>}
        <span className="workspace-header__title">{title}</span>
      </div>
      <div className="workspace-header__tools">
        <ThemeToggle />
        <details ref={settings} className="workspace-account" onKeyDown={(event) => {
          if (event.key === "Escape" && settings.current?.open) {
            event.stopPropagation();
            settings.current.open = false;
            settings.current.querySelector("summary")?.focus();
          }
        }}>
          <summary title={login ?? "Konto"}>
            <span>{login ?? "Konto"}</span>
          </summary>
          <div className="workspace-account__menu">
            <button type="button" className="workspace-account__logout" onClick={() => void signOut()}>
              <FaSignOutAlt aria-hidden="true" /> Wyloguj
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
