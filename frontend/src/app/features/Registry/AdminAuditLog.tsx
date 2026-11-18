import { useEffect, useState, type FormEvent } from "react";
import { WorkspaceLayout } from "../../layout/WorkspaceLayout";
import { useProtectedSession } from "../../router/ProtectedRoute";
import { canOpenLecturerPlan } from "../../services/authService";
import AdminPanelSection from "./adminPanel/AdminPanelSection";
import AdminPanelTable from "./adminPanel/AdminPanelTable";
import { useAdminScrollRoot } from "./useAdminScrollRoot";
import "./AdminRegistry.css";
import "./AdminAuditLog.css";

const areas = {
  AUTH: "Logowanie",
  TABLETS: "Tablety",
  MESSAGES: "Komunikaty",
  ADMIN: "Administracja",
  ATTENDANCE: "Obecność",
  KANTECH: "Konfiguracja Kantecha",
} as const;

type Category = keyof typeof areas;
type AuditEntry = {
  id: number;
  occurredAt: string;
  category: Category;
  actor: string;
  action: string;
  target: string | null;
};
type AuditPage = { entries: AuditEntry[]; nextBefore: number | null; retentionDays: number };
const formatter = new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Warsaw",
});
const pluralRules = new Intl.PluralRules("pl-PL");
const formatCount = (count: number) => {
  const form = pluralRules.select(count);
  return `${count} ${form === "one" ? "wpis" : form === "few" ? "wpisy" : "wpisów"}`;
};
const firstPage = [undefined];

export default function AdminAuditLog() {
  useAdminScrollRoot();
  const session = useProtectedSession();
  const [data, setData] = useState<AuditPage>();
  const [limit, setLimit] = useState(50);
  const [category, setCategory] = useState<Category | "">("");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<Array<number | undefined>>(firstPage);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [daysInput, setDaysInput] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retentionStatus, setRetentionStatus] = useState("");
  const [retentionError, setRetentionError] = useState("");
  const before = pages[pages.length - 1];
  const days = daysInput ?? String(data?.retentionDays ?? "");

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: String(limit) });
    if (category) params.set("category", category);
    if (query) params.set("query", query);
    if (before !== undefined) params.set("before", String(before));
    setLoading(true);
    setLoadError("");

    const load = async () => {
      try {
        const response = await fetch("/api/audit?" + params, {
          cache: "no-store", credentials: "include", signal: controller.signal,
        });
        if (!response.ok) throw new Error(response.status === 403
          ? "Logi są dostępne dla administratora." : "Nie udało się pobrać logów.");
        const next: AuditPage = await response.json();
        if (!controller.signal.aborted) setData(next);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [before, category, limit, query, reload]);

  const refresh = () => {
    setPages(firstPage);
    setReload((value) => value + 1);
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    setPages(firstPage);
    setQuery(searchInput.trim());
  };

  const saveRetention = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setRetentionStatus("");
    setRetentionError("");
    try {
      const response = await fetch("/api/audit/retention", {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: Number(days) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "Nie udało się zapisać okresu przechowywania.");
      setData((current) => current && { ...current, retentionDays: payload.retentionDays });
      setDaysInput(null);
      setRetentionStatus("Zapisano okres przechowywania.");
      refresh();
    } catch (error) {
      setRetentionError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkspaceLayout title="Administracja" login={session?.login}
      navigation={{ ownPlan: canOpenLecturerPlan(session) }}>
      <main className="admin-console__main admin-audit">
        <h1 className="admin-workspace-title">Logi</h1>
        <AdminPanelSection title="Przechowywanie">
          <form className="admin-audit__retention" onSubmit={(event) => void saveRetention(event)}>
            <label className="admin-form-field">
              <span className="admin-form-field__label">Okres przechowywania w dniach</span>
              <input className="admin-form-field__input" type="number" min={1} max={365}
                required value={days} disabled={!data || saving}
                onChange={(event) => setDaysInput(event.target.value)} />
            </label>
            <button type="submit" className="admin-button admin-button--primary"
              disabled={!data || saving || Number(days) === data.retentionDays}>Zapisz okres</button>
            <p>Starsze wpisy są usuwane automatycznie. Skrócenie okresu usuwa je przy zapisie.</p>
            {retentionStatus && <span role="status">{retentionStatus}</span>}
            {retentionError && <span role="alert" className="admin-feedback admin-feedback--danger">{retentionError}</span>}
          </form>
        </AdminPanelSection>
        <AdminPanelSection title="Dziennik systemu" actions={
          <button type="button" className="admin-button admin-button--secondary" disabled={loading} onClick={refresh}>Odśwież</button>
        }>
          <form className="admin-audit__filters" onSubmit={search}>
            <div className="admin-audit__search">
              <label className="admin-form-field">
                <span className="admin-form-field__label">Szukaj w logach</span>
                <input className="admin-form-field__input" type="search" maxLength={100}
                  placeholder="Login, działanie, ID" value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)} />
              </label>
              <button type="submit" className="admin-button admin-button--secondary">Szukaj</button>
            </div>
            <label className="admin-form-field">
              <span className="admin-form-field__label">Obszar</span>
              <select className="admin-form-field__input" value={category} onChange={(event) => {
                setPages(firstPage);
                setCategory(event.target.value as Category | "");
              }}>
                <option value="">Wszystkie</option>
                {Object.entries(areas).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <label className="admin-form-field">
              <span className="admin-form-field__label">Wpisy na stronie</span>
              <select className="admin-form-field__input" value={limit} onChange={(event) => {
                setPages(firstPage);
                setLimit(Number(event.target.value));
              }}>
                {[25, 50, 100, 200].map((size) => <option key={size}>{size}</option>)}
              </select>
            </label>
          </form>
          {loading ? <p className="admin-audit__status" role="status">Ładowanie logów…</p>
            : loadError ? <p className="admin-audit__status" role="alert">{loadError}</p>
              : data?.entries.length ? (
                <AdminPanelTable caption="Dziennik działań w PlanQR" columns={["Data i godzina", "Użytkownik", "Obszar", "Działanie", "Dotyczy"]}>
                  {data.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td><time dateTime={entry.occurredAt}>{formatter.format(new Date(entry.occurredAt))}</time></td>
                      <td>{entry.actor}</td>
                      <td>{areas[entry.category]}</td>
                      <td><strong>{entry.action}</strong></td>
                      <td>{entry.target ?? "—"}</td>
                    </tr>
                  ))}
                </AdminPanelTable>
              ) : <p className="admin-audit__status">{query || category ? "Brak wpisów pasujących do filtrów." : "Brak wpisów."}</p>}
          <footer className="admin-audit__pagination">
            <span>Strona {pages.length}{!loading && !loadError && data ? ` · ${formatCount(data.entries.length)}` : ""}</span>
            <button type="button" className="admin-button admin-button--ghost" disabled={loading || pages.length === 1}
              onClick={() => setPages((current) => current.slice(0, -1))}>Nowsze</button>
            <button type="button" className="admin-button admin-button--ghost" disabled={loading || Boolean(loadError) || !data?.nextBefore}
              onClick={() => setPages((current) => [...current, data?.nextBefore ?? undefined])}>Starsze</button>
          </footer>
        </AdminPanelSection>
      </main>
    </WorkspaceLayout>
  );
}
