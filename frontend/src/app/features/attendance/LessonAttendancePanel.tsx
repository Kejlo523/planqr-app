import { useEffect, useState } from "react";
import { FaDownload, FaFileExport, FaPlus, FaSyncAlt, FaTimes, FaTrash } from "react-icons/fa";
import "../Registry/AdminRegistry.css";
import type {
  AttendanceDraft,
  AttendanceDraftStatus,
} from "./attendanceDrafts";
import { downloadAttendanceXlsx } from "./attendanceExport";
import AttendanceChoices from "./AttendanceChoices";
import "./LessonAttendancePanel.css";

interface LessonAttendancePanelProps {
  lessonId?: string | number | null;
  draft?: AttendanceDraft | null;
  layout?: "panel" | "page";
  isLoading?: boolean;
  error?: string | null;
  readOnly?: boolean;
  onOpenList?: () => void;
  onCloseList?: () => void;
  onSendList?: () => void;
  onRefresh?: () => void;
  onAddRow?: (albumNumber: string, enteredAt: string | null) => void;
  onRemoveRow?: (rowId: string, userId?: number) => void;
  onClosePanel?: () => void;
}

const getDraftStatusLabel = (status: AttendanceDraftStatus) => {
  switch (status) {
    case "open":
      return "Lista otwarta";
    case "closed":
      return "Lista zamknięta";
    case "sent":
      return "Lista wysłana";
    case "idle":
    default:
      return "Gotowa do otwarcia";
  }
};

const formatSentAt = (value?: string | null) => {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
};

const buildCurrentTime = () =>
  new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());

export default function LessonAttendancePanel({
  lessonId,
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
  const [albumInput, setAlbumInput] = useState("");
  const [timeInput, setTimeInput] = useState("");

  useEffect(() => {
    setAlbumInput("");
    setTimeInput(buildCurrentTime());
  }, [lessonId]);

  useEffect(() => {
    if (!lessonId || !onRefresh || isLoading || (draft?.status !== "idle" && draft?.status !== "open")) return;
    const timer = window.setTimeout(onRefresh, 3000);
    return () => window.clearTimeout(timer);
  }, [lessonId, draft?.status, isLoading, onRefresh]);

  if (!lessonId || !draft) {
    return (
      <section
        className={`lesson-attendance lesson-attendance--empty lesson-attendance--${layout}`}
      >
        <div className="lesson-attendance__empty">
          <h2>Wybierz zajęcia</h2>
          <p>Panel obecności otwiera się z prawej strony.</p>
        </div>
        {!readOnly && <AttendanceChoices />}
      </section>
    );
  }

  const isOpen = draft.status === "open";
  const canCheckScan = draft.status === "idle";
  const canClose = draft.status === "open" && !draft.exitReaderId;
  const canSend = draft.status === "closed";
  const hasSession = Boolean(draft.sessionId);
  const addDisabled = !isOpen || !hasSession || albumInput.trim().length === 0;
  const canDownload = hasSession;

  return (
    <section className={`lesson-attendance lesson-attendance--${layout}`}>
      <header className="lesson-attendance__header">
        <strong>Lista obecności</strong>

        <div className="lesson-attendance__header-actions">
          <div className="lesson-attendance__status">
            <strong>{getDraftStatusLabel(draft.status)}</strong>
          </div>

          {onRefresh ? (
            <button
              type="button"
              className="admin-icon-button"
              onClick={onRefresh}
              disabled={isLoading}
              aria-label="Odśwież listę obecności"
              title="Odśwież"
            >
              <FaSyncAlt />
            </button>
          ) : null}

          {onClosePanel ? (
            <button
              type="button"
              className="admin-icon-button"
              onClick={onClosePanel}
              aria-label="Zamknij panel obecności"
            >
              <FaTimes />
            </button>
          ) : null}
        </div>
      </header>

      {!readOnly && <AttendanceChoices />}

      {hasSession && (
        <div className="lesson-attendance__feedback">
          {[draft.title, draft.room, draft.group && `Grupa ${draft.group}`].filter(Boolean).join(" · ")}
          {draft.exitReaderId && (
            <div>{draft.doorId === draft.exitReaderId
              ? `Czytnik ${draft.doorId} · wejście i wyjście. Zamknięcie po minucie od otwarcia.`
              : `Czytniki ${draft.doorId} → ${draft.exitReaderId}`}</div>
          )}
        </div>
      )}

      {!readOnly && <div className="lesson-attendance__composer">
        <input
          type="text"
          value={albumInput}
          placeholder="Numer albumu lub karta"
          onChange={(event) => setAlbumInput(event.target.value)}
          disabled={!isOpen || !hasSession}
        />

        <input
          type="time"
          value={timeInput}
          onChange={(event) => setTimeInput(event.target.value)}
          disabled={!isOpen || !hasSession}
        />

        <button
          type="button"
          className="admin-button admin-button--primary admin-button--small"
          disabled={addDisabled}
          onClick={() => {
            if (!onAddRow || addDisabled) {
              return;
            }

            onAddRow(albumInput.trim(), timeInput || null);
            setAlbumInput("");
            setTimeInput(buildCurrentTime());
          }}
        >
          <FaPlus />
          Dodaj
        </button>
      </div>}

      <div className="lesson-attendance__list-shell">
        {error ? (
          <div className="lesson-attendance__feedback lesson-attendance__feedback--error">
            {error}
          </div>
        ) : null}

        {isLoading && !draft.loadedAt ? (
          <div className="lesson-attendance__feedback">Wczytywanie listy obecności...</div>
        ) : draft.rows.length === 0 ? (
          <div className="lesson-attendance__empty-inline">
            {hasSession ? "Brak wpisów." : "Dla tych zajęć nie ma jeszcze sesji obecności."}
          </div>
        ) : (
          <ul className="lesson-attendance__list">
            {draft.rows.map((row) => (
              <li key={row.id} className="lesson-attendance__line">
                <div className="lesson-attendance__line-main">
                  <strong>{row.displayName || row.albumNumber}</strong>
                  {row.displayName && row.username && row.displayName !== row.username ? (
                    <>
                      <span className="lesson-attendance__separator">/</span>
                      <span>{row.username}</span>
                    </>
                  ) : null}
                  <span className="lesson-attendance__separator">—</span>
                  <span>{row.enteredAt || "--:--"}</span>
                  <span className="lesson-attendance__source">
                    {row.source === "scanner"
                      ? `skaner${row.scanCount && row.scanCount > 1 ? ` x${row.scanCount}` : ""}`
                      : "ręczny"}
                  </span>
                </div>

                {!readOnly && <button
                  type="button"
                  className="admin-button admin-button--ghost admin-button--small"
                  disabled={!isOpen}
                  onClick={() => onRemoveRow?.(row.id, row.userId)}
                >
                  <FaTrash />
                  Usuń
                </button>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="lesson-attendance__footer">
        <div className="lesson-attendance__footer-note">
          {draft.sentAt
            ? `Wysłano ${formatSentAt(draft.sentAt)}`
            : draft.loadedAt
              ? `Wczytano ${formatSentAt(draft.loadedAt)}`
              : ""}
          {draft.sessionId ? ` · sesja: ${draft.sessionId}` : ""}
          {draft.totalPresent ? ` · wpisy: ${draft.totalPresent}` : ""}
          {draft.truncated ? " · wynik obcięty" : ""}
        </div>

        <div className="lesson-attendance__footer-actions">
          <button
            type="button"
            className="admin-button admin-button--ghost admin-button--small"
            disabled={!canDownload}
            onClick={() => downloadAttendanceXlsx(draft, lessonId)}
          >
            <FaDownload />
            Pobierz XLSX
          </button>
          {onOpenList && <button
            type="button"
            className="admin-button admin-button--secondary admin-button--small"
            disabled={!canCheckScan || isLoading}
            onClick={onOpenList}
          >
            Sprawdź odbicie
          </button>}
          {!readOnly && !draft.exitReaderId && <button
            type="button"
            className="admin-button admin-button--ghost admin-button--small"
            disabled={!canClose || !hasSession}
            onClick={onCloseList}
          >
            Zamknij listę
          </button>}
          {!readOnly && <button
            type="button"
            className="admin-button admin-button--primary admin-button--small"
            disabled={!canSend || !hasSession}
            onClick={onSendList}
          >
            <FaFileExport />
            Wyślij listę
          </button>}
        </div>
      </footer>
    </section>
  );
}
