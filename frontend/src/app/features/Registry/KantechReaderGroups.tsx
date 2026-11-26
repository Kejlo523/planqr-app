import { useEffect, useState, type FormEvent } from "react";
import { rcpDeviceName as deviceName, rcpReaderRoles as roles, type RcpReaderRole as Role } from "./kantechPresentation";

type GroupReader = { id: string; label: string | null; role: Role };
type Device = { id: string; name: string; readers: GroupReader[] };
type Group = { id: number; name: string; devices: { id: string; readers: GroupReader[] }[] };
type Snapshot = { groups: Group[]; devices: Device[]; readerStatuses?: Record<string, string>; devTools: boolean };
type Draft = Omit<Group, "id"> & { id?: number };

const api = "/api/kantech/readers/groups";

async function request(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", credentials: "include", ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message || "Nie udało się wykonać operacji na grupach RCP.");
  }
  return response;
}

export function KantechReaderGroups({ onDevToolsChange }: { onDevToolsChange: (enabled: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState<Draft>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await request(api, { signal: controller.signal });
        const data: Snapshot = await response.json();
        if (controller.signal.aborted) return;
        setSnapshot(data);
        setLoadError("");
        onDevToolsChange(data.devTools);
      } catch {
        if (!controller.signal.aborted) setLoadError("Nie udało się odświeżyć grup i stanu czytników.");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 5_000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reload, onDevToolsChange]);

  const available = snapshot?.devices.filter((device) =>
    !draft?.devices.some(({ id }) => id === device.id) &&
    !snapshot.groups.some((group) => group.id !== draft?.id && group.devices.some(({ id }) => id === device.id)),
  ) ?? [];
  const edit = (group?: Group) => {
    setError("");
    setSelected("");
    setDraft(group ? {
      ...group,
      devices: group.devices.map((device) => ({
        ...device,
        readers: [
          ...device.readers,
          ...snapshot?.devices.find(({ id }) => id === device.id)?.readers
            .filter((reader) => !device.readers.some(({ id }) => id === reader.id)) ?? [],
        ],
      })),
    } : { name: "", devices: [] });
  };
  const addDevice = () => {
    const device = available.find(({ id }) => id === selected);
    if (!device || !draft) return;
    setDraft({ ...draft, devices: [...draft.devices, { id: device.id, readers: device.readers }] });
    setSelected("");
  };

  const mutate = async (url: string, options: RequestInit) => {
    setBusy(true);
    setError("");
    try {
      await request(url, options);
      setDraft(undefined);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się zmienić grupy.");
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (draft) void mutate(api, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
  };

  return (
    <section className="kantech-readers-panel" aria-labelledby="kantech-group-heading">
      <div className="kantech-readers-panel__heading">
        <h2 id="kantech-group-heading">Grupy urządzeń RCP</h2>
        {!draft && <button type="button" className="admin-button admin-button--primary admin-button--small"
          disabled={!snapshot || busy} onClick={() => edit()}>Dodaj grupę</button>}
      </div>
      <p className="kantech-readers__details kantech-rcp-help">Urządzenia w jednej grupie obsługują wspólną listę obecności.</p>
      {error && <p role="alert" className="kantech-monitor__error">{error}</p>}
      {loadError && <p role="alert" className="kantech-monitor__error">{loadError}</p>}
      {draft && (
        <form className="kantech-rcp-form" onSubmit={save}>
          <h3>{draft.id ? "Edytuj grupę RCP" : "Nowa grupa RCP"}</h3>
          <label className="kantech-rcp-field">
            Nazwa grupy
            <input required maxLength={128} value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <div className="kantech-rcp-picker">
            <label className="kantech-rcp-field">
              Urządzenie ze SmartService
              <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                <option value="">{available.length ? "Wybierz urządzenie RCP" : "Brak wolnych urządzeń RCP"}</option>
                {available.map(({ id }) => <option key={id} value={id}>{deviceName(id)}</option>)}
              </select>
            </label>
            <button type="button" className="admin-button admin-button--secondary" disabled={!selected || busy}
              onClick={addDevice}>Dodaj urządzenie</button>
            <button type="button" className="admin-button admin-button--ghost" disabled={busy}
              onClick={() => { setError(""); setReload((value) => value + 1); }}>Odśwież spis</button>
          </div>
          {draft.devices.map((device) => (
            <fieldset className="kantech-rcp-device" key={device.id}>
              <legend>{deviceName(device.id)}</legend>
              {device.readers.map((reader) => (
                <label className="kantech-rcp-reader" key={reader.id}>
                  <span><strong>{reader.id}</strong> {reader.label}</span>
                  <select aria-label={`Rola czytnika ${reader.id}`} value={reader.role} onChange={(event) => {
                    const role = event.target.value as Role;
                    setDraft({ ...draft, devices: draft.devices.map((item) => item.id === device.id ? {
                      ...item, readers: item.readers.map((entry) => entry.id === reader.id ? { ...entry, role } : entry),
                    } : item) });
                  }}>
                    {Object.entries(roles).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
                  </select>
                </label>
              ))}
              <button type="button" className="admin-button admin-button--ghost admin-button--small" disabled={busy}
                onClick={() => setDraft({ ...draft, devices: draft.devices.filter(({ id }) => id !== device.id) })}>
                Usuń urządzenie z grupy
              </button>
            </fieldset>
          ))}
          <div className="kantech-readers__actions">
            <button className="admin-button admin-button--primary" type="submit"
              disabled={busy || !draft.name.trim() || !draft.devices.length}>Zapisz grupę</button>
            <button className="admin-button admin-button--ghost" type="button" disabled={busy}
              onClick={() => { setDraft(undefined); setError(""); }}>Anuluj</button>
          </div>
        </form>
      )}
      {!snapshot && !loadError && <p role="status" className="kantech-reader-list__empty">Ładowanie grup…</p>}
      {!snapshot && loadError && <button type="button" className="admin-button admin-button--secondary"
        onClick={() => setReload((value) => value + 1)}>Ponów</button>}
      {snapshot && !snapshot.groups.length && !draft && <p className="kantech-reader-list__empty">Brak zapisanych grup RCP.</p>}
      {!!snapshot?.groups.length && <ul className="kantech-reader-list">
        {snapshot.groups.map((group) => (
          <li className="kantech-reader-row" key={group.id}>
            <div className="kantech-reader-row__header">
              <strong>{group.name}</strong>
              <div className="kantech-readers__actions">
                <button className="admin-button admin-button--secondary admin-button--small" type="button" disabled={busy}
                  onClick={() => edit(group)}>Edytuj grupę</button>
                <button className="admin-button admin-button--ghost admin-button--small" type="button" disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Usunąć grupę „${group.name}”?`)) void mutate(api + "/" + group.id, { method: "DELETE" });
                  }}>Usuń grupę</button>
              </div>
            </div>
            {group.devices.map((device) => <div className="kantech-rcp-summary" key={device.id}>
              <strong>{deviceName(device.id)}</strong>
              <div className="kantech-rcp-summary__readers">
                {device.readers.map((reader) => {
                  const state = loadError ? undefined : snapshot.readerStatuses?.[reader.id];
                  return (
                    <div className="kantech-rcp-summary__reader" key={reader.id}>
                      <span>
                        <span aria-hidden="true">{reader.role === "ENTRY" ? "→" : reader.role === "EXIT" ? "←" : "↔"} </span>
                        {roles[reader.role]} <span className="kantech-monitor__mono">{reader.id}</span>
                      </span>
                      <span className="kantech-rcp-summary__state" data-state={state}>
                        {state === "connected" ? "Połączony" : state === "unavailable" ? "Niedostępny" : "Brak aktualnego statusu"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>)}
          </li>
        ))}
      </ul>}
    </section>
  );
}
