import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { chooseAttendanceLesson, fetchPendingAttendance, type PendingAttendanceScan } from "../../services/attendanceService";

const startTime = new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw",
});

export default function AttendanceChoices() {
  const [scans, setScans] = useState<PendingAttendanceScan[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [link, setLink] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const pending = await fetchPendingAttendance(controller.signal);
        if (!controller.signal.aborted) setScans(pending);
      } catch {
        // Keep the last snapshot until the next refresh.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 5_000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  const choose = async (scan: PendingAttendanceScan, lesson: PendingAttendanceScan["choices"][number]) => {
    setSaving(true);
    setError(false);
    try {
      await chooseAttendanceLesson(scan.id, lesson.key);
      setScans((current) => current.filter(({ id }) => id !== scan.id));
      const query = new URLSearchParams({ room: scan.room, from: lesson.start, to: lesson.end });
      setLink("/attendance/" + encodeURIComponent(lesson.id) + "?" + query.toString());
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  if (!scans.length && !link) return null;
  return (
    <div className="lesson-attendance__choices">
      {link && <Link to={link}>Przejdź do wybranej listy</Link>}
      {error && <p role="alert">Nie udało się przypisać zajęć. Spróbuj ponownie.</p>}
      {scans.map((scan) => (
        <fieldset key={scan.id} disabled={saving}>
          <legend>Wybierz zajęcia dla odbicia w sali {scan.room}</legend>
          {scan.choices.map((lesson) => (
            <button key={lesson.key} type="button" className="admin-button admin-button--secondary admin-button--small"
              onClick={() => void choose(scan, lesson)}>
              {lesson.title} · {startTime.format(new Date(lesson.start))}
            </button>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
