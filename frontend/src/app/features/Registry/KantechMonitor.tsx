import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { WorkspaceLayout } from "../../layout/WorkspaceLayout";
import { useProtectedSession } from "../../router/ProtectedRoute";
import { canOpenLecturerPlan } from "../../services/authService";
import "./AdminRegistry.css";
import "./KantechMonitor.css";
import KantechDevTools from "./KantechDevTools";
import KantechReaders from "./KantechReaders";
import { KantechNavigation } from "./KantechNavigation";
import {
  kantechTime as time, outcomeLabel, rcpDeviceName, rcpReaderRoles, type KantechDevice, type RcpReaderRole,
} from "./kantechPresentation";
import { useAdminScrollRoot } from "./useAdminScrollRoot";

type CaptureMode = "observe" | "attendance";
type ReaderDetails = { deviceId?: string; readerLabel?: string | null; role?: RcpReaderRole };

interface Snapshot {
  mode: "off" | CaptureMode;
  devTools?: boolean;
  devices: KantechDevice[];
  readerIds: string[];
  events: ({
    key: string;
    readerId: string;
    label: string;
    occurredAt: string | null;
    receivedAt: string;
    outcome: string;
  } & ReaderDetails)[];
}

const initialFilters = { search: "", deviceId: "", readerId: "", from: "", to: "", outcome: "", limit: "25" };
const resultLimits = [10, 25, 50, 100];

export default function KantechMonitor() {
  useAdminScrollRoot();
  const [params] = useSearchParams();
  const mode = params.get("dev");
  const dev = mode === "" || mode === "1" || mode === "true" || params.get("") === "dev";
  const readers = params.get("view") === "readers";
  const session = useProtectedSession();
  return (
    <WorkspaceLayout title="Kantech" login={session?.login} back={{ to: "/adminpanel", label: "Administracja" }}
      navigation={{ ownPlan: canOpenLecturerPlan(session) }}>
      {readers ? <KantechReaders /> : dev ? <KantechDevTools /> : <KantechLiveMonitor />}
    </WorkspaceLayout>
  );
}

function KantechLiveMonitor() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [filters, setFilters] = useState(initialFilters);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [loadedQuery, setLoadedQuery] = useState<string>();
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState("");
  const modeRevision = useRef(0);
  const invalidRange = Boolean(filters.from && filters.to && filters.from > filters.to);
  const query = new URLSearchParams(Object.entries(filters).map(([key, value]) =>
    [key, value.trim()]).filter(([, value]) => value)).toString();
  const filtering = Object.entries(filters).some(([key, value]) => key !== "limit" && value);
  const advancedFilterCount = [filters.deviceId, filters.readerId, filters.from, filters.to, filters.outcome]
    .filter(Boolean).length;

  useEffect(() => {
    if (invalidRange) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const revision = modeRevision.current;
      try {
        const response = await fetch("/api/kantech/events?" + query, {
          credentials: "include", cache: "no-store", signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          if (!controller.signal.aborted) setForbidden(true);
          controller.abort();
          return;
        }
        if (!response.ok) throw new Error("Monitor unavailable");
        const data: Snapshot = await response.json();
        if (!controller.signal.aborted) {
          setSnapshot((current) => revision === modeRevision.current || !current
            ? data : { ...data, mode: current.mode });
          setLoadedQuery(query);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2_000);
      }
    };
    timer = setTimeout(() => void refresh(), 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, invalidRange]);

  const updateFilter = (key: keyof typeof initialFilters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const changeMode = async (mode: CaptureMode) => {
    setSavingMode(true);
    setModeError("");
    try {
      const response = await fetch("/api/kantech/events/mode", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || "Nie udało się zmienić trybu Kantecha.");
      }
      const next: { mode: CaptureMode } = await response.json();
      modeRevision.current++;
      setSnapshot((current) => current && { ...current, mode: next.mode });
    } catch (cause) {
      setModeError(cause instanceof Error ? cause.message : "Nie udało się zmienić trybu Kantecha.");
    } finally {
      setSavingMode(false);
    }
  };

  const readerOptions = new Map<string, string>();
  for (const device of snapshot?.devices ?? []) {
    if (filters.deviceId && device.id !== filters.deviceId) continue;
    for (const reader of device.readers) {
      readerOptions.set(reader.id, `${reader.id} · ${rcpReaderRoles[reader.role]}`);
    }
  }
  if (!filters.deviceId) {
    for (const id of snapshot?.readerIds ?? []) {
      if (!readerOptions.has(id)) readerOptions.set(id, id);
    }
  }
  const updating = !invalidRange && !forbidden && !error && loadedQuery !== query;
  const events = !invalidRange && loadedQuery === query ? snapshot?.events ?? [] : [];
  return (
    <main className="kantech-monitor">
      <div className="kantech-monitor__body">
        <KantechNavigation view="live" devTools={snapshot?.devTools ?? false} />
        <header className="kantech-monitor__heading">
          <div>
            <h1>Kantech na żywo</h1>
          </div>
          <div className="kantech-monitor__mode-control">
            <span className="kantech-monitor__mode" role="status">
              {snapshot?.mode === "observe" ? "Tryb obserwacji"
                : snapshot?.mode === "attendance" ? "Zapis obecności"
                  : snapshot ? "Odczyt wyłączony" : forbidden ? "Brak dostępu" : "Łączenie…"}
            </span>
            {snapshot && snapshot.mode !== "off" && !forbidden && (
              <label className="admin-switch" aria-busy={savingMode}>
                <input type="checkbox" role="switch" checked={snapshot.mode === "attendance"}
                  disabled={savingMode || error}
                  onChange={(event) => void changeMode(event.target.checked ? "attendance" : "observe")} />
                <span>Automatyczny zapis obecności</span>
              </label>
            )}
          </div>
        </header>
        {modeError && <p role="alert" className="kantech-monitor__error">{modeError}</p>}
        {error && <p role="alert" className="kantech-monitor__error">Podgląd chwilowo niedostępny. Ponawiam połączenie.</p>}
        {forbidden && <p role="alert" className="kantech-monitor__error">Zaloguj się przez LDAP na konto administratora.</p>}
        <section className="kantech-monitor__feed" aria-labelledby="kantech-feed">
          <div className="kantech-monitor__feed-header">
            <h2 id="kantech-feed">Ostatnie odbicia</h2>
            {!updating && !invalidRange && snapshot && <span>Wyświetlono {events.length}</span>}
          </div>
          <div className="kantech-monitor__filters" aria-label="Filtry odbić" role="group" data-mobile-open={mobileFiltersOpen}>
            <div className="kantech-monitor__filter-quick">
              <label>Szukaj odbić
                <input type="search" placeholder="Karta, RCP lub czytnik" value={filters.search} maxLength={128}
                  onChange={(event) => updateFilter("search", event.target.value)} />
              </label>
              <button type="button" className="admin-button admin-button--secondary kantech-monitor__filter-toggle"
                aria-expanded={mobileFiltersOpen} aria-controls="kantech-extra-filters"
                onClick={() => setMobileFiltersOpen((open) => !open)}>
                Filtry{advancedFilterCount > 0 ? ` (${advancedFilterCount})` : ""}
              </button>
            </div>
            <div id="kantech-extra-filters" className="kantech-monitor__filter-options">
              <label><span id="kantech-filter-device">RCP</span>
                <select aria-labelledby="kantech-filter-device" value={filters.deviceId} onChange={(event) =>
                  setFilters((current) => ({ ...current, deviceId: event.target.value, readerId: "" }))}>
                  <option value="">Wszystkie urządzenia</option>
                  {snapshot?.devices.map(({ id }) => <option key={id} value={id}>{rcpDeviceName(id)}</option>)}
                </select>
              </label>
              <label><span id="kantech-filter-reader">Czytnik</span>
                <select aria-labelledby="kantech-filter-reader" value={filters.readerId} onChange={(event) => updateFilter("readerId", event.target.value)}>
                  <option value="">Wszystkie czytniki</option>
                  {[...readerOptions].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label>Od dnia
                <input type="date" value={filters.from} onChange={(event) => updateFilter("from", event.target.value)} />
              </label>
              <label>Do dnia
                <input type="date" value={filters.to} onChange={(event) => updateFilter("to", event.target.value)} />
              </label>
              <label><span id="kantech-filter-outcome">Wynik</span>
                <select aria-labelledby="kantech-filter-outcome" value={filters.outcome} onChange={(event) => updateFilter("outcome", event.target.value)}>
                  <option value="">Wszystkie wyniki</option>
                  {Object.entries(outcomeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label>Liczba wyników
                <select value={filters.limit} onChange={(event) => updateFilter("limit", event.target.value)}>
                  {resultLimits.map((limit) => <option key={limit} value={limit}>{limit}</option>)}
                </select>
              </label>
              <button type="button" className="admin-button admin-button--ghost" disabled={!filtering}
                onClick={() => setFilters({ ...initialFilters, limit: filters.limit })}>Wyczyść filtry</button>
            </div>
          </div>
          {invalidRange ? <p className="kantech-monitor__empty" role="alert">Data końcowa musi przypadać w dniu początkowym lub później.</p>
            : updating ? <p className="kantech-monitor__empty" role="status">Pobieranie odbić…</p> : events.length ? (
            <div className="kantech-monitor__scroll" tabIndex={0} aria-label="Tabela odbić kart" role="region">
              <table>
                <thead><tr><th>Odbicie</th><th>Odebrano</th><th>RCP</th><th>Czytnik</th><th>Karta</th><th>Wynik</th></tr></thead>
                <tbody>{events.map((event) => (
                  <tr key={event.key}>
                    <td data-label="Odbicie">{event.occurredAt ? time.format(new Date(event.occurredAt)) : "—"}</td>
                    <td data-label="Odebrano">{time.format(new Date(event.receivedAt))}</td>
                    <td data-label="RCP">{event.deviceId ? rcpDeviceName(event.deviceId) : "—"}</td>
                    <td data-label="Czytnik" title={event.readerLabel ?? undefined}>
                      {event.readerId}{event.role && <small>{rcpReaderRoles[event.role]}</small>}
                    </td>
                    <td data-label="Karta" className="kantech-monitor__mono">{event.label}</td>
                    <td data-label="Wynik" data-outcome={event.outcome}>{outcomeLabel[event.outcome] ?? "Odebrano"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="kantech-monitor__empty">{filtering ? "Brak odbić pasujących do filtrów." : "Brak odbić."}</p>}
        </section>
      </div>
    </main>
  );
}
