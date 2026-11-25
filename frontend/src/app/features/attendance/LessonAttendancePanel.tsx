import { useEffect, useRef, useState, type FormEvent } from "react";
import { FaDownload, FaFileExport, FaPlus, FaSyncAlt, FaTimes, FaTrash } from "react-icons/fa";
import "../Registry/AdminRegistry.css";
import { attendanceStatusLabel, type AttendanceDraft } from "./attendanceDrafts";
import { downloadAttendanceXlsx } from "./attendanceExport";
import AttendanceChoices from "./AttendanceChoices";
import "./LessonAttendancePanel.css";

interface LessonAttendancePanelProps {
  lessonId?: string | number | null;
  lessonTitle?: string;
  draft?: AttendanceDraft | null;
  layout?: "panel" | "page";
  isLoading?: boolean;
  error?: string | null;
  readOnly?: boolean;
  onOpenList?: () => void;
  onCloseList?: () => void;
  onSendList?: () => void;
  onRefresh?: () => void;
  onAddRow?: (albumNumber: string, enteredAt: string | null) => Promise<boolean>;
  onRemoveRow?: (rowId: string, userId?: number) => void;
  onClosePanel?: () => void;
}

const timeFormat = new Intl.DateTimeFormat("pl-PL", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const activityFormat = new Intl.DateTimeFormat("pl-PL", {
  hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit",
});

export default function LessonAttendancePanel({
  lessonId,
  lessonTitle,
  draft,
  layout = "panel",
  isLoading = false,
  error = null,
  readOnly = false,
  onOpenList,
  onCloseList,
  onSendList,
  onRefresh,
  onAddRow,
  onRemoveRow,
  onClosePanel,
}: LessonAttendancePanelProps) {
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState(false);
  const [albumInput, setAlbumInput] = useState("");
  const [timeInput, setTimeInput] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const albumField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAdding(false);
    setAddError(false);
    setAlbumInput("");
    setTimeInput("");
  }, [lessonId, draft?.sessionId, draft?.status]);

  useEffect(() => {
    if (adding) albumField.current?.focus();
  }, [adding]);

  useEffect(() => {
    if (!lessonId || !onRefresh || isLoading || (draft?.status !== "idle" && draft?.status !== "open")) return;
    const timer = window.setTimeout(onRefresh, 3000);
    return () => window.clearTimeout(timer);
  }, [lessonId, draft?.status, isLoading, onRefresh]);

  if (!lessonId || !draft) {
    return (
      <section className={`lesson-attendance lesson-attendance--${layout}`}>
        <div className="lesson-attendance__body"><p className="lesson-attendance__empty">Wybierz zajęcia, aby zobaczyć listę obecności.</p></div>
        {!readOnly && <AttendanceChoices />}
      </section>
    );
  }

  const hasSession = Boolean(draft.sessionId);
  const hasList = hasSession || draft.simulated;
  const canEdit = hasSession && !readOnly && draft.status === "open";
  const canAdd = Boolean(canEdit && onAddRow);
  const canClose = canEdit && !draft.readerGroup && !draft.exitReaderId && Boolean(onCloseList);
  const canSend = hasSession && !readOnly && draft.status === "closed" && Boolean(onSendList);
  const canCheckScan = draft.status === "idle" && Boolean(onOpenList);
  const lessonSummary = layout === "page" ? [draft.title, draft.room, draft.group && `Grupa ${draft.group}`].filter(Boolean).join(" · ") : "";
  const closeForm = () => {
    setAdding(false);
    setAddError(false);
    setAlbumInput("");
    window.requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const album = albumInput.trim();
    if (!canAdd || !onAddRow || !album || isLoading || saving) return;
    setSaving(true);
    setAddError(false);
    try {
      if (await onAddRow(album, timeInput || null)) closeForm();
      else setAddError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`lesson-attendance lesson-attendance--${layout}`}>
      <header className="lesson-attendance__header">
        <div className="lesson-attendance__heading">
          <h2>Lista obecności</h2>
          {lessonTitle && <p className="lesson-attendance__lesson">{lessonTitle}</p>}
          <div className="lesson-attendance__summary">
            <span className="lesson-attendance__status" data-status={draft.status}>{attendanceStatusLabel[draft.status]}</span>
            {draft.simulated && <span className="lesson-attendance__status">Symulacja Kantecha</span>}
            {hasList && <span>Wpisy · {draft.rows.length}</span>}
          </div>
        </div>
        <div className="lesson-attendance__header-actions">
          {onRefresh && <button type="button" className="admin-icon-button" onClick={onRefresh}
            disabled={isLoading} aria-label="Odśwież listę obecności" title="Odśwież">
            <FaSyncAlt aria-hidden="true" />
          </button>}
          {onClosePanel && <button type="button" className="admin-icon-button" data-panel-close onClick={onClosePanel}
            aria-label="Zamknij panel obecności" title="Zamknij">
            <FaTimes aria-hidden="true" />
          </button>}
        </div>
      </header>

      <div className="lesson-attendance__body" aria-busy={isLoading && !draft.loadedAt}>
        {!readOnly && <AttendanceChoices />}
        {lessonSummary && <p className="lesson-attendance__context">{lessonSummary}</p>}
        {canEdit && draft.readerGroup && <p className="lesson-attendance__context">Zamknięcie listy po odbiciu na wyjściu z grupy.</p>}
        {canEdit && !draft.readerGroup && draft.exitReaderId && (
          <p className="lesson-attendance__context">{draft.doorId === draft.exitReaderId
            ? `Czytnik ${draft.doorId} · zamknięcie po minucie od otwarcia.`
            : `Czytniki ${draft.doorId} → ${draft.exitReaderId}`}</p>
        )}
        {canAdd && (
          <div className="lesson-attendance__add">
            <button ref={addButton} type="button" className="admin-button admin-button--secondary admin-button--small"
              aria-expanded={adding} hidden={adding} onClick={() => {
                setTimeInput(timeFormat.format(new Date()));
                setAdding(true);
              }}>
              <FaPlus aria-hidden="true" /> Dodaj osobę
            </button>
            {adding && (
              <form className="lesson-attendance__composer" onSubmit={(event) => void submit(event)}>
                <div className="lesson-attendance__fields">
                  <label>Numer albumu lub karta
                    <input ref={albumField} type="text" value={albumInput} autoComplete="off" required maxLength={100}
                      onChange={(event) => setAlbumInput(event.target.value)} disabled={saving} />
                  </label>
                  <label>Godzina
                    <input type="time" value={timeInput} onChange={(event) => setTimeInput(event.target.value)} disabled={saving} />
                  </label>
                </div>
                <div className="lesson-attendance__composer-actions">
                  <button type="button" className="admin-button admin-button--ghost admin-button--small" disabled={saving}
                    onClick={closeForm}>Anuluj</button>
                  <button type="submit" className="admin-button admin-button--primary admin-button--small"
                    disabled={isLoading || saving || !albumInput.trim()}>{saving ? "Dodawanie…" : "Dodaj do listy"}</button>
                </div>
                {addError && <p className="lesson-attendance__feedback" role="alert">
                  Nie udało się dodać osoby. Sprawdź dane i spróbuj ponownie.
                </p>}
              </form>
            )}
          </div>
        )}

        {error && !addError && <p className="lesson-attendance__feedback" role="alert">{error}</p>}
        {isLoading && !draft.loadedAt ? (
          <p className="lesson-attendance__empty" role="status">Wczytywanie listy obecności…</p>
        ) : draft.rows.length === 0 ? (
          <p className="lesson-attendance__empty">
            {hasList ? "Brak wpisów." : "Dla tych zajęć nie ma jeszcze sesji obecności."}
          </p>
        ) : (
          <ul className="lesson-attendance__list">
            {draft.rows.map((row) => {
              const account = row.username || row.albumNumber;
              const name = [row.givenName, row.surname].filter(Boolean).join(" ") || row.displayName;
              const identity = account || name;
              return (
                <li key={row.id} className="lesson-attendance__line">
                  <div className="lesson-attendance__person">
                    <strong>{identity}</strong>
                    {name && name !== identity && <span>{name}</span>}
                  </div>
                  <div className="lesson-attendance__entry">
                    <time>{row.enteredAt || "—"}</time>
                    <span>{row.source === "scanner"
                      ? `Skan${row.scanCount && row.scanCount > 1 ? ` ×${row.scanCount}` : ""}` : "Ręcznie"}</span>
                  </div>
                  {canEdit && onRemoveRow && (
                    <button type="button" className="admin-icon-button" onClick={() => onRemoveRow(row.id, row.userId)}
                      disabled={isLoading} aria-label={`Usuń wpis ${identity}`} title="Usuń wpis">
                      <FaTrash aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {(hasList || canCheckScan) && (
        <footer className="lesson-attendance__footer">
          {(draft.sentAt || draft.truncated) && <span className="lesson-attendance__context">
            {draft.sentAt && `Wysłano ${activityFormat.format(new Date(draft.sentAt))}`}
            {draft.truncated && `${draft.sentAt ? " · " : ""}Pokazano część wpisów`}
          </span>}
          <div className="lesson-attendance__footer-actions">
            {hasList && <button type="button" className="admin-button admin-button--ghost admin-button--small"
              onClick={() => downloadAttendanceXlsx(draft, lessonId)}>
              <FaDownload aria-hidden="true" /> Pobierz XLSX
            </button>}
            {canCheckScan && <button type="button" className="admin-button admin-button--secondary admin-button--small"
              disabled={isLoading} onClick={onOpenList}>Sprawdź odbicie</button>}
            {canClose && <button type="button" className="admin-button admin-button--secondary admin-button--small"
              disabled={isLoading} onClick={onCloseList}>Zamknij listę</button>}
            {canSend && <button type="button" className="admin-button admin-button--primary admin-button--small"
              disabled={isLoading} onClick={onSendList}><FaFileExport aria-hidden="true" /> Wyślij listę</button>}
          </div>
        </footer>
      )}
    </section>
  );
}
