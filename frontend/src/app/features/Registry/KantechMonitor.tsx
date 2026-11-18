import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FaArrowLeft } from "react-icons/fa";
import { useTheme } from "../../../context/ThemeContext";
import "./AdminRegistry.css";
import "./KantechMonitor.css";
import KantechDevTools from "./KantechDevTools";
import { kantechTime as time, outcomeLabel } from "./kantechPresentation";

interface Snapshot {
  mode: "off" | "observe" | "attendance";
  devTools?: boolean;
  readers: { id: string; state: "connected" | "unavailable"; checkedAt: string }[];
  events: {
    key: string;
    readerId: string;
    label: string;
    occurredAt: string | null;
    receivedAt: string;
    outcome: string;
  }[];
}

export default function KantechMonitor() {
  const [params] = useSearchParams();
  const mode = params.get("dev");
  const dev = mode === "" || mode === "1" || mode === "true" || params.get("") === "dev";
  return dev ? <KantechDevTools /> : <KantechLiveMonitor />;
}

function KantechLiveMonitor() {
  const { theme } = useTheme();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [reader, setReader] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch("/api/kantech/events", {
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
          setSnapshot(data);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  const events = snapshot?.events.filter((event) => !reader || reader === event.readerId) ?? [];
  return (
    <main className="admin-console kantech-monitor" data-admin-theme={theme}>
      <div className="kantech-monitor__body">
        <Link to="/adminpanel" className="kantech-monitor__back"><FaArrowLeft /> Panel administratora</Link>
        <header className="kantech-monitor__heading">
          <div>
            <h1>Kantech na żywo</h1>
            <p>Zdarzenia odczytane przez czytniki kart.</p>
          </div>
          <div className="kantech-monitor__nav">
            {snapshot?.devTools && <Link to="?dev=1" className="admin-button admin-button--ghost">Tryb testowy</Link>}
            <span className="kantech-monitor__mode">
              {snapshot?.mode === "observe" ? "Tryb obserwacji"
                : snapshot?.mode === "attendance" ? "Zapis obecności"
                  : snapshot ? "Odczyt wyłączony" : forbidden ? "Brak dostępu" : "Łączenie…"}
            </span>
          </div>
        </header>
        {error && <p role="alert" className="kantech-monitor__error">Podgląd chwilowo niedostępny. Ponawiam połączenie.</p>}
        {forbidden && <p role="alert" className="kantech-monitor__error">Zaloguj się przez LDAP na konto administratora.</p>}
        <section className="kantech-monitor__readers" aria-label="Stan czytników">
          {snapshot?.readers.length ? snapshot.readers.map((item) => {
            const stale = Date.now() - Date.parse(item.checkedAt) > 25_000;
            const online = !error && !stale && item.state === "connected";
            return (
              <div className="kantech-monitor__reader" key={item.id} data-online={online}>
                <strong>Czytnik <span className="kantech-monitor__mono">{item.id}</span></strong>
                <span>{online ? "Połączony" : stale || error ? "Brak aktualnego statusu" : "Niedostępny"}</span>
              </div>
            );
          }) : <p>Oczekiwanie na pierwszy sygnał z czytnika.</p>}
        </section>
        <section className="kantech-monitor__feed" aria-labelledby="kantech-feed">
          <div className="kantech-monitor__feed-header">
            <h2>Ostatnie odbicia</h2>
            <label>Czytnik
              <select value={reader} onChange={(event) => setReader(event.target.value)}>
                <option value="">Wszystkie</option>
                {snapshot?.readers.map(({ id }) => <option key={id}>{id}</option>)}
              </select>
            </label>
          </div>
          {events.length ? (
            <div className="kantech-monitor__scroll" tabIndex={0} aria-label="Tabela odbić kart">
              <table>
                <thead><tr><th>Odbicie</th><th>Odebrano</th><th>Czytnik</th><th>Karta</th><th>Wynik</th></tr></thead>
                <tbody>{events.map((event) => (
                  <tr key={event.key}>
                    <td data-label="Odbicie">{event.occurredAt ? time.format(new Date(event.occurredAt)) : "—"}</td>
                    <td data-label="Odebrano">{time.format(new Date(event.receivedAt))}</td>
                    <td data-label="Czytnik">{event.readerId}</td><td data-label="Karta">{event.label}</td>
                    <td data-label="Wynik">{outcomeLabel[event.outcome] ?? "Odebrano"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="kantech-monitor__empty">Brak odbić. Przyłóż kartę do wybranego czytnika.</p>}
        </section>
      </div>
    </main>
  );
}
