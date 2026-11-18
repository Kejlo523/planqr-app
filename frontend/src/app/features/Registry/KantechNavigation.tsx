import { Link } from "react-router-dom";

export function KantechNavigation({ view, devTools }: {
  view: "live" | "dev" | "readers";
  devTools: boolean;
}) {
  return (
    <nav className="kantech-monitor__nav" aria-label="Widoki Kantecha">
      <Link to="/adminpanel/kantech" aria-current={view === "live" ? "page" : undefined}>Odczyty na żywo</Link>
      <Link to="?view=readers" aria-current={view === "readers" ? "page" : undefined}>Czytniki</Link>
      {devTools && <Link to="?dev=1" aria-current={view === "dev" ? "page" : undefined}>Testy i przypisania</Link>}
    </nav>
  );
}
