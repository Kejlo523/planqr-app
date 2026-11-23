import { useEffect, useState } from "react";

const stateLabels = { online: "Online", offline: "Offline", disabled: "Wyłączony", unknown: "Brak stanu" };
const refreshInterval = 10_000;
const staleAfter = 120_000;
const checkedAtFormat = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" });

type Snapshot = {
  readers: { id: string; label: string | null; state: keyof typeof stateLabels }[];
  checkedAt: string | null;
};

export function KantechInventory({ editorOpen }: { editorOpen: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const response = await fetch("/api/kantech/readers/inventory", {
          cache: "no-store", credentials: "include", signal: controller.signal,
        });
        if (!response.ok) throw new Error();
        const data: Snapshot = await response.json();
        if (controller.signal.aborted) return;
        setSnapshot(data);
        setUnavailable(false);
      } catch {
        if (controller.signal.aborted) return;
        setUnavailable(true);
      } finally {
        if (!controller.signal.aborted) {
          setNow(Date.now());
          timer = window.setTimeout(() => void refresh(), refreshInterval);
        }
      }
    };
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);

  const checkedAt = snapshot?.checkedAt;
  const stale = Boolean(checkedAt && (unavailable || now - Date.parse(checkedAt) > staleAfter));

  return (
    <aside className="kantech-readers-panel kantech-inventory" aria-labelledby="kantech-inventory-heading">
      <div className="kantech-readers-panel__heading">
        <h2 id="kantech-inventory-heading" tabIndex={-1}>Czytniki w SmartService</h2>
        {editorOpen && <a className="kantech-readers__inventory-link" href="#kantech-reader-form">Wróć do formularza</a>}
      </div>
      {checkedAt && <p className="kantech-inventory__meta">
        Ostatni odczyt <time dateTime={checkedAt}>{checkedAtFormat.format(new Date(checkedAt))}</time>
      </p>}
      {stale && <p className="kantech-inventory__meta" role="status">Dane są nieaktualne.</p>}
      {!checkedAt ? <p className="kantech-inventory__meta" role="status">
        {unavailable ? "Lista jest niedostępna." : snapshot
          ? "SmartService nie przekazał jeszcze listy." : "Pobieranie listy…"}
      </p> : snapshot.readers.length ? (
        <ul className="kantech-inventory__list" aria-labelledby="kantech-inventory-heading" tabIndex={0}>
          {snapshot.readers.map(({ id, label, state }) => (
            <li key={id}>
              <div className="kantech-inventory__reader">
                <strong className="kantech-monitor__mono">{id}</strong>
                {label && <span>{label}</span>}
              </div>
              <span className="kantech-inventory__state" data-state={stale ? "unknown" : state}>
                {stale ? "Brak stanu" : stateLabels[state]}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="kantech-inventory__meta">Brak czytników w ostatnim odczycie.</p>}
    </aside>
  );
}
