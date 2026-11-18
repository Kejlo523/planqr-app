import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { findZutTeachers, type ZutTeacher } from "../../services/zutScheduleService";
import { kantechTime, outcomeLabel } from "./kantechPresentation";
import "./KantechDevTools.css";

type Card = { alias: string; login: string; name: string; album: string | null; scheduleId: string | null };
type Source = "demo" | "live";
type SimulatedScan = { id: string; alias: string; label: string; readerId: string; occurredAt: string; outcome: string; source: Source };
type Snapshot = {
  cards: Card[];
  readers: { id: string; label: string }[];
  observed: { alias: string; canonicalAlias: string; readerId: string; receivedAt: string }[];
  simulated: SimulatedScan[];
};
type Lesson = { key: string; title: string; room: string; start: string; end: string };
type TeacherSchedule = { current: Lesson[]; upcoming: Lesson[] };
type Assignment = { alias: string; role: "participant" | "lecturer"; target: string; name: string };

const initialAssignment: Assignment = { alias: "", role: "participant", target: "", name: "" };
const presets = [
  { alias: "WISYNC_1", label: "Prowadzący" },
  { alias: "WISYNC_2", label: "Student" },
  { alias: "WISYNC_3", label: "Gość" },
];
const api = "/api/kantech/dev";

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(api + path, {
    method: body === undefined ? "GET" : "POST", credentials: "include", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? "Operacja nie powiodła się.");
  }
  return response.json();
}

function LessonList({ lessons, empty }: { lessons: Lesson[]; empty: string }) {
  if (!lessons.length) return <p>{empty}</p>;
  return <ul className="kantech-dev__items">{lessons.map((lesson) => (
    <li key={lesson.key + lesson.room}>
      <strong>{lesson.title}</strong>
      <span>{kantechTime.format(new Date(lesson.start))} – {kantechTime.format(new Date(lesson.end))}
        {lesson.room && " · " + lesson.room}</span>
    </li>
  ))}</ul>;
}

export default function KantechDevTools() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [availability, setAvailability] = useState("Ładowanie trybu testowego…");
  const [assignment, setAssignment] = useState(initialAssignment);
  const [mappingNotice, setMappingNotice] = useState("");
  const [teacher, setTeacher] = useState<ZutTeacher>();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ZutTeacher[]>([]);
  const [plan, setPlan] = useState<TeacherSchedule>();
  const [teacherNotice, setTeacherNotice] = useState("");
  const [teacherBusy, setTeacherBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reader, setReader] = useState("49919");
  const [scanAlias, setScanAlias] = useState("WISYNC_1");
  const [source, setSource] = useState<Source>("demo");
  const [granted, setGranted] = useState(true);
  const [sending, setSending] = useState(false);
  const [scanNotice, setScanNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let retry = true;
    const refresh = async () => {
      try {
        const response = await fetch(api, { credentials: "include", cache: "no-store", signal: controller.signal });
        if ([401, 403, 404].includes(response.status)) {
          retry = false;
          setAvailability(response.status === 404 ? "Tryb testowy jest wyłączony w konfiguracji backendu."
            : "Zaloguj się przez LDAP na konto administratora.");
          setSnapshot(undefined);
          return;
        }
        if (!response.ok) throw new Error();
        setSnapshot(await response.json());
        setAvailability("");
      } catch {
        if (!controller.signal.aborted) setAvailability("Podgląd chwilowo niedostępny. Ponawiam połączenie.");
      } finally {
        if (retry && !controller.signal.aborted) timer = setTimeout(() => void refresh(), 3_000);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  const update = (patch: Partial<Assignment>) => setAssignment((current) => ({ ...current, ...patch }));
  const search = async () => {
    setTeacherBusy(true); setTeacherNotice(""); setMatches([]);
    try {
      const results = await findZutTeachers(query);
      setMatches(results);
      if (!results.length) setTeacherNotice("Brak prowadzących pasujących do nazwiska.");
    } catch (error) { setTeacherNotice((error as Error).message); }
    finally { setTeacherBusy(false); }
  };
  const choose = async (selected: ZutTeacher) => {
    setTeacher(selected); setPlan(undefined); setTeacherBusy(true); setTeacherNotice("");
    try { setPlan(await request("/schedule?teacherId=" + encodeURIComponent(selected.id))); }
    catch (error) { setTeacherNotice((error as Error).message); }
    finally { setTeacherBusy(false); }
  };
  const edit = (card: Card) => {
    setAssignment({ alias: card.alias, role: card.scheduleId ? "lecturer" : "participant", target: card.album ?? card.login, name: card.name });
    setTeacher(undefined);
    setPlan(undefined); setMatches([]); setTeacherNotice(""); setMappingNotice("");
    if (card.scheduleId) void choose({ id: card.scheduleId, name: card.name });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const { alias, role, target, name } = assignment;
    if (role === "lecturer" && !teacher) return;
    setSaving(true); setMappingNotice("");
    try {
      const card = await request<Card>("/cards", role === "lecturer" && teacher
        ? { alias, role, login: target, name: teacher.name, scheduleId: teacher.id }
        : { alias, role, target, name: name.trim() || undefined });
      update({ alias: card.alias });
      setScanAlias(card.alias);
      setSnapshot((current) => current && { ...current, cards: [...current.cards.filter((row) => row.alias !== card.alias), card]
        .sort((a, b) => a.alias.localeCompare(b.alias)) });
      setMappingNotice(card.alias + " → " + (card.album ?? card.name));
    } catch (error) { setMappingNotice((error as Error).message); }
    finally { setSaving(false); }
  };
  const updateSimulation = async (value?: string, origin: Source = source) => {
    if (value !== undefined && (!value.trim() || !reader.trim())) return;
    setSending(true); setScanNotice("");
    try {
      let simulated: SimulatedScan[] = [];
      if (value === undefined) {
        const response = await fetch(api + "/scans", { method: "DELETE", credentials: "include" });
        if (!response.ok) throw new Error("Nie udało się wyczyścić testu.");
      } else {
        simulated = await request("/scans", { alias: value, readerId: reader, source: origin, granted });
      }
      setSnapshot((current) => current && { ...current, simulated });
    } catch (error) { setScanNotice((error as Error).message); }
    finally { setSending(false); }
  };

  return (
    <main className="kantech-monitor">
      <div className="kantech-monitor__body">
        <nav className="kantech-monitor__nav" aria-label="Widoki Kantecha">
          <Link to="/adminpanel/kantech">Odczyty na żywo</Link>
          <Link to="?dev=1" aria-current="page">Testy i przypisania</Link>
        </nav>
        <header className="kantech-monitor__heading"><h1>Testy Kantecha</h1></header>
        {availability && <p role="status">{availability}</p>}
        {snapshot && <div className="kantech-dev">
          <section className="kantech-dev__section" aria-labelledby="karte-mapping">
            <h2 id="karte-mapping">Przypisanie karty</h2>
            <div className="kantech-dev__recent">
              <h3>Odczytane aliasy</h3>
              {snapshot.observed.length ? snapshot.observed.map((item) => (
                <button key={item.readerId + "/" + item.alias} type="button" className="admin-button admin-button--ghost admin-button--small"
                  title={"Czytnik " + item.readerId + " · " + kantechTime.format(new Date(item.receivedAt))}
                  disabled={teacherBusy}
                  onClick={() => {
                    const card = snapshot.cards.find((row) => row.alias === item.canonicalAlias);
                    if (card) edit(card);
                    else {
                      setAssignment({ ...initialAssignment, alias: item.alias });
                      setTeacher(undefined); setPlan(undefined); setMatches([]); setMappingNotice(""); setTeacherNotice("");
                    }
                    setScanAlias(item.alias); setReader(item.readerId);
                  }}>{item.alias}</button>
              )) : <p>Po odbiciu karty jej alias pojawi się tutaj.</p>}
            </div>
            <form className="kantech-dev__form" onSubmit={(event) => void save(event)}>
              <label>Alias z czytnika<input value={assignment.alias} onChange={(event) => update({ alias: event.target.value })}
                placeholder="np. WI_SYNC1" required maxLength={128} /></label>
              <label>Typ przypisania<select value={assignment.role} onChange={(event) => update({ role: event.target.value as Assignment["role"] })}>
                <option value="participant">Uczestnik</option><option value="lecturer">Prowadzący</option>
              </select></label>
              <label>{assignment.role === "lecturer" ? "Login prowadzącego w PlanQR" : "Nazwa, login lub numer albumu"}
                <input value={assignment.target} onChange={(event) => update({ target: event.target.value })}
                  placeholder={assignment.role === "lecturer" ? "Login uczelniany" : "np. klęsk lub 123456"} required maxLength={128} /></label>
              {assignment.role === "participant" ? <label>Etykieta wyświetlana, opcjonalnie
                <input value={assignment.name} onChange={(event) => update({ name: event.target.value })} maxLength={128} /></label>
              : <div className="kantech-dev__form">
                <label>Nazwisko w Planie ZUT<input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={120}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (!teacherBusy && query.trim().length >= 2) void search();
                    }
                  }} /></label>
                <button type="button" className="admin-button admin-button--ghost" disabled={teacherBusy || query.trim().length < 2}
                  onClick={() => void search()}>Szukaj w Planie ZUT</button>
                {matches.length > 0 && <ul className="kantech-dev__items">{matches.map((candidate) => (
                  <li key={candidate.id}><button type="button" className="admin-button admin-button--ghost" disabled={teacherBusy}
                    onClick={() => void choose(candidate)}>{candidate.name}</button></li>
                ))}</ul>}
                {teacher && <div className="kantech-dev__plan">
                  <div className="kantech-dev__row"><strong>Wybrano {teacher.name}</strong>
                    <button type="button" className="admin-button admin-button--ghost admin-button--small" disabled={teacherBusy}
                      onClick={() => void choose(teacher)}>Odśwież plan</button></div>
                  {plan && <>
                    <h3>Teraz</h3><LessonList lessons={plan.current} empty="Prowadzący nie ma teraz zajęć." />
                    <h3>Najbliższe zajęcia</h3><LessonList lessons={plan.upcoming} empty="Brak kolejnych zajęć w pobranym zakresie." />
                  </>}
                </div>}
                {(teacherBusy || teacherNotice) && <p role="status">{teacherBusy ? "Pobieram dane z Planu ZUT…" : teacherNotice}</p>}
              </div>}
              <button className="admin-button admin-button--primary" type="submit"
                disabled={saving || (assignment.role === "lecturer" && !teacher)}>Zapisz przypisanie</button>
              {mappingNotice && <p role="status">{mappingNotice}</p>}
            </form>
            <h3>Zapisane przypisania</h3>
            {snapshot.cards.length ? <ul className="kantech-dev__items">{snapshot.cards.map((card) => (
              <li key={card.alias} className="kantech-dev__row">
                <span><strong>{card.alias}</strong> → {card.album ?? card.name}{card.scheduleId && " · " + card.login}</span>
                <button type="button" className="admin-button admin-button--ghost admin-button--small"
                  onClick={() => edit(card)} disabled={teacherBusy} aria-label={"Edytuj " + card.alias}>Edytuj</button>
              </li>
            ))}</ul> : <p>Brak przypisań kart.</p>}
          </section>
          <section className="kantech-dev__section" aria-labelledby="karte-simulation">
            <h2 id="karte-simulation">Symulacja odbić</h2>
            <p>Symulacja nie zapisuje obecności.</p>
            <form className="kantech-dev__form" onSubmit={(event) => { event.preventDefault(); void updateSimulation(scanAlias); }}>
              <label>Czytnik<input value={reader} onChange={(event) => setReader(event.target.value)} list="kantech-dev-readers" required maxLength={64} /></label>
              <datalist id="kantech-dev-readers">{snapshot.readers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</datalist>
              <label>Alias do symulacji<input value={scanAlias} onChange={(event) => setScanAlias(event.target.value)} required maxLength={128} /></label>
              <label>Źródło zajęć<select value={source} onChange={(event) => setSource(event.target.value as Source)}>
                <option value="demo">Przykładowe zajęcia</option><option value="live">Plan ZUT</option>
              </select></label>
              <label className="kantech-dev__check"><input type="checkbox" checked={granted} onChange={(event) => setGranted(event.target.checked)} /> Odczyt przyjęty</label>
              <button type="submit" className="admin-button admin-button--primary" disabled={sending}>Wywołaj odbicie</button>
            </form>
            <div className="kantech-dev__recent">
              <h3>Gotowe odbicia dla przykładowych zajęć</h3>
              {presets.map((preset) => <button key={preset.alias} type="button" className="admin-button admin-button--ghost admin-button--small"
                disabled={sending} onClick={() => void updateSimulation(preset.alias, "demo")}>{preset.alias} · {preset.label}</button>)}
            </div>
            <div className="kantech-dev__row"><h3>Wynik symulacji</h3>
              <button type="button" className="admin-button admin-button--ghost admin-button--small" disabled={sending || !snapshot.simulated.length}
                onClick={() => void updateSimulation()}>Wyczyść test</button></div>
            {scanNotice && <p role="alert">{scanNotice}</p>}
            {snapshot.simulated.length ? <ol className="kantech-dev__items" aria-label="Wynik symulacji">{snapshot.simulated.map((scan) => (
              <li key={scan.id}><strong>{outcomeLabel[scan.outcome] ?? "Odczytano"} · {scan.label}</strong>
                <span>{scan.alias} · {scan.readerId} · {kantechTime.format(new Date(scan.occurredAt))}
                  {" · "}{scan.source === "demo" ? "Przykładowe zajęcia" : "Plan ZUT"}</span></li>
            ))}</ol> : <p>Wywołaj odbicie, aby zobaczyć wynik.</p>}
          </section>
        </div>}
      </div>
    </main>
  );
}
