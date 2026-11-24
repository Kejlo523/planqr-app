import { useEffect, useRef, useState, type FormEvent } from "react";
import { KantechNavigation } from "./KantechNavigation";
import { KantechInventory } from "./KantechInventory";
import "./KantechReaders.css";

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

function ReaderName({ reader }: { reader: Reader }) {
  return (
    <span className="kantech-reader-name">
      <strong>{reader.label === "Czytnik " + reader.id ? "Czytnik" : reader.label}</strong>
      <span className="kantech-monitor__mono">{reader.id}</span>
    </span>
  );
}

export default function KantechReaders() {
  const [registry, setRegistry] = useState<Registry>();
  const [form, setForm] = useState(emptyForm);
  const [editor, setEditor] = useState<"add" | "edit" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);

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

  useEffect(() => {
    if (editor) {
      editorHeading.current?.focus();
    } else if (opener.current) {
      const previous = opener.current;
      opener.current = null;
      (previous.isConnected ? previous : addButton.current)?.focus();
    }
  }, [editor]);

  const reset = () => {
    setEditor(null);
    setForm(emptyForm);
  };
  const updateEndpoint = (end: "entry" | "exit", key: "id" | "label", value: string) =>
    setForm((current) => ({ ...current, [end]: { ...current[end], [key]: value } }));

  const openEditor = (trigger: HTMLButtonElement, entry?: Reader, exit?: Reader) => {
    opener.current = trigger;
    setForm({
      entry: entry ? { id: entry.id, label: entry.label } : emptyEndpoint,
      exit: exit ? { id: exit.id, label: exit.label } : emptyEndpoint,
      buildingId: entry?.buildingId ?? "",
      roomNumber: entry?.roomNumber ?? "",
      singleReader: entry?.singleReader ?? false,
    });
    setEditor(entry ? "edit" : "add");
    editorHeading.current?.focus();
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
          buildingId: form.buildingId, roomNumber: form.roomNumber, edit: editor === "edit",
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
      if (editor === "edit" && (form.entry.id === reader.id || form.exit.id === reader.id)) reset();
      setNotice("Usunięto czytnik " + reader.id + ".");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się usunąć czytnika.");
    } finally {
      setBusy(false);
    }
  };

  const readersById = new Map(registry?.readers.map((reader) => [reader.id, reader]));
  const configurations = registry?.readers.flatMap((reader) => {
    const partner = reader.pairedReaderId ? readersById.get(reader.pairedReaderId) : undefined;
    if (reader.direction === "EXIT" && partner?.direction === "ENTRY") return [];
    return [{ reader, exit: reader.direction === "ENTRY" && partner?.direction === "EXIT" ? partner : undefined }];
  }) ?? [];

  const removeButton = (reader: Reader, label = "Usuń") => (
    <button type="button" className="admin-button admin-button--ghost admin-button--small"
      aria-label={"Usuń czytnik " + reader.id} disabled={busy}
      onClick={() => void remove(reader)}>{label}</button>
  );

  return (
    <main className="kantech-monitor">
      <div className="kantech-monitor__body kantech-readers-view">
        <KantechNavigation view="readers" devTools={registry?.devTools ?? false} />
        <header className="kantech-monitor__heading">
          <h1>Czytniki Kantecha</h1>
          {registry && !editor && <button ref={addButton} type="button" className="admin-button admin-button--primary"
            disabled={busy} onClick={(event) => openEditor(event.currentTarget)}>
            <i className="fas fa-plus" aria-hidden="true" /> Dodaj czytniki
          </button>}
        </header>
        {error && !editor && <p role="alert" className="kantech-monitor__error">{error}</p>}
        {notice && <p className="kantech-readers__notice" role="status">{notice}</p>}
        {!registry ? error ? (
          <button className="admin-button admin-button--secondary" type="button"
            onClick={() => { setError(""); setReload((current) => current + 1); }}>Ponów</button>
        ) : <p role="status">Ładowanie czytników…</p> : (
          <div className="kantech-readers-layout">
            <div className="kantech-readers-main">
              {editor && (
                <section className="kantech-readers-panel" aria-labelledby="kantech-reader-form">
                  <div className="kantech-readers-panel__heading">
                    <h2 id="kantech-reader-form" ref={editorHeading} tabIndex={-1}>
                      {editor === "edit" ? "Edytuj konfigurację" : "Dodaj czytniki"}
                    </h2>
                    <a className="kantech-readers__inventory-link" href="#kantech-inventory-heading">Sprawdź ID w SmartService</a>
                  </div>
                  <form className="kantech-dev__form kantech-readers-form" onSubmit={(event) => void save(event)}>
                    {error && <p role="alert" className="kantech-monitor__error">{error}</p>}
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
                    <div className="kantech-readers__endpoints" data-single={form.singleReader}>
                      <fieldset className="kantech-readers__endpoint">
                        <legend>{form.singleReader ? "Wejście i wyjście" : "Wejście"}</legend>
                        <label>ID wejścia<input value={form.entry.id} maxLength={64} readOnly={editor === "edit"} required
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
                    </div>
                    <div className="kantech-readers__room">
                      <label>Budynek<input type="text" value={form.buildingId} maxLength={128} placeholder="np. WI_WI1"
                        onChange={(event) => setForm({ ...form, buildingId: event.target.value })} /></label>
                      <label>Sala<input type="text" value={form.roomNumber} maxLength={128}
                        onChange={(event) => setForm({ ...form, roomNumber: event.target.value })} /></label>
                    </div>
                    <p className="kantech-readers__details">Budynek i sala to opcjonalny opis lokalizacji czytnika.</p>
                    <div className="kantech-readers__actions kantech-readers-form__footer">
                      <button type="button" className="admin-button admin-button--ghost"
                        disabled={busy} onClick={reset}>Anuluj</button>
                      <button type="submit" className="admin-button admin-button--primary" disabled={busy}>Zapisz konfigurację</button>
                    </div>
                  </form>
                </section>
              )}
              <section className="kantech-readers-panel" aria-labelledby="kantech-reader-list">
                <div className="kantech-readers-panel__heading"><h2 id="kantech-reader-list">Zapisane czytniki</h2></div>
                {configurations.length ? <ul className="kantech-reader-list" aria-labelledby="kantech-reader-list">
                  {configurations.map(({ reader, exit }) => (
                    <li className="kantech-reader-row" key={reader.id}>
                      <div className="kantech-reader-row__header">
                        <div className="kantech-reader-row__summary">
                          {!exit && <ReaderName reader={reader} />}
                          <span className="kantech-readers__details">
                            {[reader.buildingId, reader.roomNumber].filter(Boolean).join(" / ") || "Bez opisu lokalizacji"}
                            {!exit && (reader.singleReader ? " · Wejście i wyjście"
                              : reader.direction ? " · " + directionLabels[reader.direction] + " bez pary" : " · Bez kierunku")}
                          </span>
                        </div>
                        <div className="kantech-readers__actions">
                          <button type="button" className="admin-button admin-button--secondary admin-button--small"
                            aria-label={exit ? `Edytuj parę ${reader.id} i ${exit.id}` : "Edytuj czytnik " + reader.id} disabled={busy}
                            onClick={(event) => openEditor(event.currentTarget, reader, exit)}>{exit ? "Edytuj parę" : "Edytuj"}</button>
                          {!exit && removeButton(reader)}
                        </div>
                      </div>
                      {exit && <div className="kantech-reader-flow">
                        <div className="kantech-reader-flow__endpoint">
                          <span className="kantech-reader-flow__direction">Wejście</span>
                          <ReaderName reader={reader} />
                          {removeButton(reader, "Usuń wejście")}
                        </div>
                        <span className="kantech-reader-flow__arrow" aria-hidden="true">→</span>
                        <div className="kantech-reader-flow__endpoint">
                          <span className="kantech-reader-flow__direction">Wyjście</span>
                          <ReaderName reader={exit} />
                          {removeButton(exit, "Usuń wyjście")}
                        </div>
                      </div>}
                    </li>
                  ))}
                </ul> : <p className="kantech-reader-list__empty">Dodaj pierwszy czytnik, aby przypisać go do sali.</p>}
              </section>
            </div>
            <KantechInventory editorOpen={Boolean(editor)} />
          </div>
        )}
      </div>
    </main>
  );
}
