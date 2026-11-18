import type { ReactNode } from "react";
import { FaArrowLeft } from "react-icons/fa";
import { Link } from "react-router-dom";
import logo from "../../assets/zut_fav.png";
import ThemeToggle from "./ThemeToggle";
import "./WorkspaceHeader.css";

export function PlanQrBrand() {
  return <span className="workspace-brand"><img src={logo} alt="" />PlanQR</span>;
}

export function WorkspaceHeader({ title, back, menu }: {
  title: string;
  back?: { to: string; label: string };
  menu?: ReactNode;
}) {
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
      <ThemeToggle />
    </header>
  );
}
