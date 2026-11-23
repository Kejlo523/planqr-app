import { useEffect, useState, type FormEvent } from "react";
import { KantechNavigation } from "./KantechNavigation";
import { KantechInventory } from "./KantechInventory";
import "./KantechDevTools.css";

type Direction = "ENTRY" | "EXIT";
type Reader = {
  id: string; label: string; buildingId: string; roomNumber: string;
  direction: Direction | null; pairedReaderId: string | null; singleReader: boolean;
};
type Registry = { readers: Reader[]; devTools: boolean };
const emptyEndpoint = { id: "", label: "" };
const emptyForm = { entry: emptyEndpoint, exit: emptyEndpoint, buildingId: "", roomNumber: "", singleReader: false };
const api = "/api/kantech/readers";
const directionLabels = { ENTRY: "Wejście", EXIT: "Wyjście" };

export default function KantechReaders() {
  const [registry, setRegistry] = useState<Registry>();
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(api, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (response.status === 401 || response.status === 403) {
          setError("Zaloguj się przez LDAP na konto administratora.");
          return;
        }
        if (!response.ok) throw new Error();
        const data: Registry = await response.json();
        if (!controller.signal.aborted) {
          setRegistry(data);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted) setError("Nie udało się pobrać czytników.");
      }
    };
    void load();
    return () => controller.abort();
  }, [reload]);

  const reset = () => {
    setEditing(false);
    setForm(emptyForm);
  };
  const updateEndpoint = (end: "entry" | "exit", key: "id" | "label", value: string) =>
    setForm((current) => ({ ...current, [end]: { ...current[end], [key]: value } }));

  const editReader = (reader: Reader) => {
    const entry = reader.direction === "EXIT"
      ? registry?.readers.find(({ id }) => id === reader.pairedReaderId) ?? reader
      : reader;
    const exit = entry.direction === "ENTRY" && registry?.readers.find(({ id }) => id === entry.pairedReaderId);
    setForm({
      entry: { id: entry.id, label: entry.label },
      exit: exit ? { id: exit.id, label: exit.label } : emptyEndpoint,
      buildingId: entry.buildingId,
      roomNumber: entry.roomNumber,
      singleReader: entry.singleReader,
    });
    setEditing(true);
    setError("");
    setNotice("");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setNotice("");
    setBusy(true);
    setError("");
    try {
      const response = await fetch(api + "/setup", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry: form.entry, exit: form.singleReader ? null : form.exit,
          buildingId: form.buildingId, roomNumber: form.roomNumber, edit: editing,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || "Nie udało się zapisać konfiguracji.");
      }
      const saved: Reader = await response.json();
      setReload((current) => current + 1);
      reset();
      setNotice(saved.pairedReaderId
        ? "Zapisano parę " + saved.id + " → " + saved.pairedReaderId + "."
        : "Zapisano czytnik " + saved.id + " jako wejście i wyjście.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się zapisać konfiguracji.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (reader: Reader) => {
    if (!window.confirm("Usunąć czytnik " + reader.id + "? Zapisane listy obecności pozostaną w bazie.")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(api + "/" + encodeURIComponent(reader.id), { method: "DELETE", credentials: "include" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || "Nie udało się usunąć czytnika.");
      }
      setReload((current) => current + 1);
      if (editing && (form.entry.id === reader.id || form.exit.id === reader.id)) reset();
      setNotice("Usunięto czytnik " + reader.id + ".");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się usunąć czytnika.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="kantech-monitor">
      <div className="kantech-monitor__body kantech-readers-view">
        <KantechNavigation view="readers" devTools={registry?.devTools ?? false} />
        <header className="kantech-monitor__heading"><h1>Czytniki Kantecha</h1></header>
        {error && <p role="alert" className="kantech-monitor__error">{error}</p>}
        {notice && <p className="kantech-monitor__notice" role="status">{notice}</p>}
        {!registry ? error ? (
          <button className="admin-button admin-button--secondary" type="button"
            onClick={() => { setError(""); setReload((current) => current + 1); }}>Ponów</button>
        ) : <p role="status">Ładowanie czytników…</p> : (
          <div className="kantech-dev kantech-readers-layout">
            <section className="kantech-dev__section" aria-labelledby="kantech-reader-list">
              <h2 id="kantech-reader-list">Zapisane czytniki</h2>
              {registry.readers.some((reader) => reader.direction === "ENTRY" && reader.pairedReaderId) && (
                <ul className="kantech-readers__pairs" aria-label="Pary wejścia i wyjścia">
                  {registry.readers.filter((reader) => reader.direction === "ENTRY" && reader.pairedReaderId).map((entry) => {
                    const exit = registry.readers.find(({ id }) => id === entry.pairedReaderId);
                    return (
                      <li className="kantech-readers__pair" key={entry.id}>
                        <span><strong>Wejście</strong> {entry.label} · {entry.id}</span>
                        <span className="kantech-readers__arrow" aria-hidden="true">→</span>
                        <span><strong>Wyjście</strong> {exit?.label} · {entry.pairedReaderId}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {registry.readers.length ? (
                <ul className="kantech-dev__items">
                  {registry.readers.map((reader) => (
                    <li className="kantech-dev__row" key={reader.id}>
                      <div>
                        <strong>{reader.label}</strong>
                        <div className="kantech-readers__details">
                          <span className="kantech-monitor__mono">{reader.id}</span>
                          {" · "}{reader.singleReader ? "Wejście i wyjście"
                            : reader.direction ? directionLabels[reader.direction] : "Bez kierunku"}
                          {" · "}{reader.roomNumber ? reader.buildingId + " / " + reader.roomNumber : "Bez przypisanej sali"}
                        </div>
                      </div>
                      <div className="kantech-readers__actions">
                        <button type="button" className="admin-button admin-button--ghost admin-button--small"
                          aria-label={"Edytuj czytnik " + reader.id} disabled={busy}
                          onClick={() => editReader(reader)}>Edytuj</button>
                        <button type="button" className="admin-button admin-button--ghost admin-button--small"
                          aria-label={"Usuń czytnik " + reader.id} disabled={busy}
                          onClick={() => void remove(reader)}>Usuń</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p>Brak zapisanych czytników.</p>}
            </section>
            <section className="kantech-dev__section" aria-labelledby="kantech-reader-form">
              <h2 id="kantech-reader-form">{editing ? "Edytuj konfigurację" : "Dodaj czytniki"}</h2>
              <form className="kantech-dev__form" onSubmit={(event) => void save(event)}>
                <label className="kantech-dev__check">
                  <input type="checkbox" checked={form.singleReader}
                    onChange={(event) => {
                      const singleReader = event.target.checked;
                      setForm((current) => ({ ...current, singleReader }));
                    }} />
                  Jeden czytnik obsługuje wejście i wyjście
                </label>
                {form.singleReader && <p className="kantech-readers__details">
                  Prowadzący może zamknąć listę na tym czytniku po minucie od otwarcia.
                </p>}
                <fieldset className="kantech-readers__endpoint">
                  <legend>{form.singleReader ? "Wejście i wyjście" : "Wejście"}</legend>
                  <label>ID wejścia<input value={form.entry.id} maxLength={64} readOnly={editing} required
                    onChange={(event) => updateEndpoint("entry", "id", event.target.value)} /></label>
                  <label>Nazwa wejścia<input value={form.entry.label} maxLength={128} required
                    onChange={(event) => updateEndpoint("entry", "label", event.target.value)} /></label>
                </fieldset>
                {!form.singleReader && <fieldset className="kantech-readers__endpoint">
                  <legend>Wyjście</legend>
                  <label>ID wyjścia<input value={form.exit.id} maxLength={64} required
                    onChange={(event) => updateEndpoint("exit", "id", event.target.value)} /></label>
                  <label>Nazwa wyjścia<input value={form.exit.label} maxLength={128} required
                    onChange={(event) => updateEndpoint("exit", "label", event.target.value)} /></label>
                </fieldset>}
                <div className="kantech-readers__room">
                  <label>Budynek<input type="text" value={form.buildingId} maxLength={128}
                    required={Boolean(form.roomNumber.trim())}
                    onChange={(event) => setForm({ ...form, buildingId: event.target.value })} /></label>
                  <label>Sala<input type="text" value={form.roomNumber} maxLength={128}
                    required={Boolean(form.buildingId.trim())}
                    onChange={(event) => setForm({ ...form, roomNumber: event.target.value })} /></label>
                </div>
                <p className="kantech-readers__details">Do zapisu obecności podaj budynek i salę według Planu ZUT.</p>
                <div className="kantech-readers__actions">
                  <button type="submit" className="admin-button admin-button--primary" disabled={busy}>Zapisz konfigurację</button>
                  {editing && <button type="button" className="admin-button admin-button--ghost"
                    disabled={busy} onClick={reset}>Anuluj</button>}
                </div>
              </form>
            </section>
            <KantechInventory />
          </div>
        )}
      </div>
    </main>
  );
}
