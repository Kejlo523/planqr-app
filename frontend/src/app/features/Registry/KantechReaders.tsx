import { useEffect, useState, type FormEvent } from "react";
import { KantechNavigation } from "./KantechNavigation";
import "./KantechDevTools.css";

type Reader = { id: string; label: string; buildingId: string; roomNumber: string };
type Registry = { readers: Reader[]; devTools: boolean };
const emptyReader: Reader = { id: "", label: "", buildingId: "", roomNumber: "" };
const api = "/api/kantech/readers";

export default function KantechReaders() {
  const [registry, setRegistry] = useState<Registry>();
  const [form, setForm] = useState(emptyReader);
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
    setForm(emptyReader);
  };
  const update = (key: keyof Reader, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setNotice("");
    if (!editing && registry?.readers.some(({ id }) => id === form.id.trim())) {
      setError("To ID już istnieje. Wybierz „Edytuj” przy zapisanym czytniku.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(api, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || "Nie udało się zapisać czytnika.");
      }
      const saved: Reader = await response.json();
      setRegistry((current) => current && ({
        ...current, readers: [...current.readers.filter(({ id }) => id !== saved.id), saved]
          .sort((left, right) => left.id.localeCompare(right.id)),
      }));
      reset();
      setNotice("Zapisano czytnik " + saved.id + ".");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się zapisać czytnika.");
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
      if (!response.ok) throw new Error();
      setRegistry((current) => current && ({
        ...current, readers: current.readers.filter(({ id }) => id !== reader.id),
      }));
      if (editing && form.id === reader.id) reset();
      setNotice("Usunięto czytnik " + reader.id + ".");
    } catch {
      setError("Nie udało się usunąć czytnika.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="kantech-monitor">
      <div className="kantech-monitor__body">
        <KantechNavigation view="readers" devTools={registry?.devTools ?? false} />
        <header className="kantech-monitor__heading"><h1>Czytniki Kantecha</h1></header>
        {error && <p role="alert" className="kantech-monitor__error">{error}</p>}
        {notice && <p className="kantech-monitor__notice" role="status">{notice}</p>}
        {!registry ? error ? (
          <button className="admin-button admin-button--secondary" type="button"
            onClick={() => { setError(""); setReload((current) => current + 1); }}>Ponów</button>
        ) : <p role="status">Ładowanie czytników…</p> : (
          <div className="kantech-dev">
            <section className="kantech-dev__section" aria-labelledby="kantech-reader-list">
              <h2 id="kantech-reader-list">Zapisane czytniki</h2>
              {registry.readers.length ? (
                <ul className="kantech-dev__items">
                  {registry.readers.map((reader) => (
                    <li className="kantech-dev__row" key={reader.id}>
                      <div>
                        <strong>{reader.label}</strong>
                        <div className="kantech-readers__details">
                          <span className="kantech-monitor__mono">{reader.id}</span>
                          {" · "}{reader.roomNumber ? reader.buildingId + " / " + reader.roomNumber : "Bez przypisanej sali"}
                        </div>
                      </div>
                      <div className="kantech-readers__actions">
                        <button type="button" className="admin-button admin-button--ghost admin-button--small"
                          aria-label={"Edytuj czytnik " + reader.id} disabled={busy}
                          onClick={() => { setForm(reader); setEditing(true); setError(""); setNotice(""); }}>Edytuj</button>
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
              <h2 id="kantech-reader-form">{editing ? "Edytuj czytnik" : "Dodaj czytnik"}</h2>
              <form className="kantech-dev__form" onSubmit={(event) => void save(event)}>
                <label>ID czytnika<input type="text" value={form.id} maxLength={64} placeholder="np. 49919"
                  readOnly={editing} required onChange={(event) => update("id", event.target.value)} /></label>
                <label>Nazwa czytnika<input type="text" value={form.label} maxLength={128} required
                  onChange={(event) => update("label", event.target.value)} /></label>
                <div className="kantech-readers__room">
                  <label>Budynek<input type="text" value={form.buildingId} maxLength={128}
                    required={Boolean(form.roomNumber.trim())} onChange={(event) => update("buildingId", event.target.value)} /></label>
                  <label>Sala<input type="text" value={form.roomNumber} maxLength={128}
                    required={Boolean(form.buildingId.trim())} onChange={(event) => update("roomNumber", event.target.value)} /></label>
                </div>
                <p className="kantech-readers__details">Budynek i sala są potrzebne do zapisu obecności.</p>
                <div className="kantech-readers__actions">
                  <button type="submit" className="admin-button admin-button--primary" disabled={busy}>Zapisz czytnik</button>
                  {editing && <button type="button" className="admin-button admin-button--ghost"
                    disabled={busy} onClick={reset}>Anuluj</button>}
                </div>
              </form>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
