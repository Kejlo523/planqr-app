import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import plLocale from "@fullcalendar/core/locales/pl";
import type {
  EventApi,
  EventClickArg,
  EventContentArg,
} from "@fullcalendar/core";
import tippy from "tippy.js";
import "tippy.js/dist/tippy.css";
import {
  FaEdit,
  FaPaperPlane,
  FaSyncAlt,
  FaTimes,
  FaTrash,
  FaUndo,
  FaChevronLeft,
  FaChevronRight,
  FaSearch,
} from "react-icons/fa";
import * as leoProfanity from "leo-profanity";
import { WorkspaceLayout } from "./WorkspaceLayout";
import polishBadWords from "../../assets/badWords";
import { useTheme } from "../../context/ThemeContext";
import "../features/Registry/AdminRegistry.css";
import LessonAttendancePanel from "../features/attendance/LessonAttendancePanel";
import {
  applyAttendanceListToDraft,
  createAttendanceDraft,
  resolveAttendanceDoorId,
  type AttendanceDraft,
} from "../features/attendance/attendanceDrafts";
import {
  addAttendanceSessionUser,
  closeAttendanceSession,
  fetchLessonAttendanceList,
  removeAttendanceSessionUser,
  sendAttendanceSession,
} from "../services/attendanceService";
import {
  createMessage,
  deleteMessage,
  fetchMessages,
  updateMessage,
  type MessagePayload,
  type MessageRecord,
} from "../services/messageService";
import {
  canOpenLecturerPlan,
  fetchSession,
  getLecturerDisplayName,
  logout,
  type SessionInfo,
} from "../services/authService";
import { findZutTeachers } from "../services/zutScheduleService";
import "./LecturerCalendar.css";

leoProfanity.loadDictionary("en");
leoProfanity.add(polishBadWords);

const LECTURER_SCROLL_ROOT_CLASS = "lecturer-console-scroll-root";
const AUTO_DAY_VIEW_MIN_WIDTH = 1100;
const TRIPLE_DOCKED_MIN_WIDTH = 1680;
const TRIPLE_DOCKED_MIN_HEIGHT = 860;
const DOUBLE_DOCKED_MIN_WIDTH = 1280;
const DOUBLE_DOCKED_MIN_HEIGHT = 760;
const SHEET_MAX_WIDTH = 720;
const TOAST_DURATION_MS = 4500;
const ADMIN_PREVIEW_MODE = "admin-preview";
const PREVIEW_TEACHER_SEARCH_DEBOUNCE_MS = 250;
const PREVIEW_TEACHER_SEARCH_MIN_LENGTH = 2;

type CalendarView = "timeGridDay" | "timeGridWeek" | "dayGridMonth";
const calendarViews = [
  ["timeGridDay", "Dzień"],
  ["timeGridWeek", "Tydzień"],
  ["dayGridMonth", "Miesiąc"],
] as const satisfies readonly (readonly [CalendarView, string])[];
type LecturerToastTone = "success" | "warning" | "danger" | "neutral";
type WorkspaceMode =
  | "triple-docked"
  | "double-docked"
  | "drawer"
  | "sheet";

interface LessonEvent {
  id: string;
  title: string;
  start?: string;
  attendanceStart?: string;
  end?: string;
  room?: string;
  login?: string;
  group_name?: string;
  worker_title?: string;
  lesson_form?: string;
  color?: string;
  hasNotifications?: boolean;
}

interface LecturerToast {
  id: number;
  message: string;
  tone: LecturerToastTone;
}

const detailDateFormatter = new Intl.DateTimeFormat("pl-PL", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

const timeFormatter = new Intl.DateTimeFormat("pl-PL", {
  hour: "2-digit",
  minute: "2-digit",
});

const weekdayFormatter = new Intl.DateTimeFormat("pl-PL", { weekday: "short" });
const dayFormatter = new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "short" });

const getLessonColor = (value = "") => {
  const form = value.trim().toLowerCase();
  if (/^(wyk|lecture|w\.?$)/.test(form)) return "lecture";
  if (/^(lab|lb$|l$)/.test(form)) return "lab";
  if (/^(ćw|cw|audyt|a$)/.test(form)) return "exercise";
  if (/^(egz|exam|e$)/.test(form)) return "exam";
  if (/^(proj|p$)/.test(form)) return "project";
  if (/^(semin|s$)/.test(form)) return "seminar";
  if (/^(lektor|lek$|le$)/.test(form)) return "language";
  return "regular";
};

function LessonTile({ content }: { content: EventContentArg }) {
  const titleSpace = useRef<HTMLSpanElement>(null);
  const month = content.view.type === "dayGridMonth";
  const room = content.event.extendedProps.room as string | undefined;
  const form = content.event.extendedProps.lesson_form as string | undefined;
  const color = content.event.extendedProps.color;
  const custom = getLessonColor(form) === "regular" && typeof color === "string" && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color);

  useLayoutEffect(() => {
    const space = titleSpace.current;
    const title = space?.firstElementChild;
    if (month || !space || !title) return;

    let active = true;
    const fit = () => {
      if (!active) return;
      const height = space.clientHeight;
      const lineHeight = Number.parseFloat(window.getComputedStyle(title).lineHeight);
      if (!lineHeight) return;
      const lines = Math.floor((height + 0.1) / lineHeight);
      space.style.setProperty("--lesson-title-lines", String(Math.max(1, lines)));
      space.style.visibility = lines > 0 ? "visible" : "hidden";
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(space);
    fit();
    void document.fonts?.ready.then(fit);
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [month, content.event.title]);

  return (
    <div className="lecturer-console__event" style={custom ? { "--lesson-custom": color } as CSSProperties : undefined}>
      <span className="lecturer-console__event-time">{content.timeText}</span>
      <span ref={titleSpace} className="lecturer-console__event-title-space">
        <span className="lecturer-console__event-title">{content.event.title}</span>
      </span>
      {room && <span className="lecturer-console__event-room">Sala {room}</span>}
    </div>
  );
}

const messageTimeFormatter = new Intl.DateTimeFormat("pl-PL", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const normalizePreviewFieldValue = (value: string | null | undefined) =>
  value?.trim().replace(/\s+/g, " ") ?? "";

const buildPreviewTeacherName = (surname: string, givenName: string) =>
  surname && givenName ? `${surname} ${givenName}` : "";

const fetchPreviewTeacherMatches = async (query: string, signal?: AbortSignal) => {
  const normalizedQuery = normalizePreviewFieldValue(query);
  if (!normalizedQuery) return [];
  const teachers = await findZutTeachers(normalizedQuery, signal);
  return [...new Set(teachers.map(({ name }) => normalizePreviewFieldValue(name)).filter(Boolean))];
};

const resolveWorkspaceMode = (
  width: number,
  height: number,
): WorkspaceMode => {
  if (width <= SHEET_MAX_WIDTH) {
    return "sheet";
  }

  if (width >= TRIPLE_DOCKED_MIN_WIDTH && height >= TRIPLE_DOCKED_MIN_HEIGHT) {
    return "triple-docked";
  }

  if (width >= DOUBLE_DOCKED_MIN_WIDTH && height >= DOUBLE_DOCKED_MIN_HEIGHT) {
    return "double-docked";
  }

  return "drawer";
};

const normalizeLessonEvent = (
  event: Record<string, unknown>,
  fallbackTeacher: string,
): LessonEvent => ({
  id: String(
    event.id ??
      event.lessonId ??
      `${String(event.title ?? "zajecia")}-${String(event.start ?? "")}`,
  ),
  title: String(event.title ?? "Zajęcia"),
  start: typeof event.start === "string" ? event.start : undefined,
  attendanceStart: typeof event.attendanceStart === "string" ? event.attendanceStart : undefined,
  end: typeof event.end === "string" ? event.end : undefined,
  room: typeof event.room === "string" ? event.room : "",
  login: typeof event.login === "string" ? event.login : "",
  group_name: typeof event.group_name === "string" ? event.group_name : "",
  worker_title:
    typeof event.worker_title === "string"
      ? event.worker_title
      : fallbackTeacher,
  lesson_form:
    typeof event.lesson_form === "string"
      ? event.lesson_form
      : typeof event.lesson_form_short === "string"
        ? event.lesson_form_short
        : "",
  color: typeof event.color === "string" ? event.color : undefined,
  hasNotifications: Boolean(event.hasNotifications),
});

const mapCalendarEvent = (event: EventApi): LessonEvent => ({
  id: event.id,
  title: event.title,
  start: event.start?.toISOString(),
  attendanceStart: typeof event.extendedProps.attendanceStart === "string" ? event.extendedProps.attendanceStart : undefined,
  end: event.end?.toISOString(),
  room:
    typeof event.extendedProps.room === "string" ? event.extendedProps.room : "",
  login:
    typeof event.extendedProps.login === "string" ? event.extendedProps.login : "",
  group_name:
    typeof event.extendedProps.group_name === "string"
      ? event.extendedProps.group_name
      : "",
  worker_title:
    typeof event.extendedProps.worker_title === "string"
      ? event.extendedProps.worker_title
      : "",
  lesson_form:
    typeof event.extendedProps.lesson_form === "string"
      ? event.extendedProps.lesson_form
      : "",
  color: typeof event.extendedProps.color === "string" ? event.extendedProps.color : undefined,
  hasNotifications: Boolean(event.extendedProps.hasNotifications),
});

const fetchLecturerEvents = async (
  startDate: string,
  endDate: string,
  targetTeacher: string,
) => {
  const response = await fetch(
    `/api/schedule?kind=worker&id=${encodeURIComponent(targetTeacher)}&start=${startDate}&end=${endDate}`,
    { credentials: "include" },
  );

  if (!response.ok) {
    throw new Error("Failed to fetch events");
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((event) =>
      normalizeLessonEvent(event as Record<string, unknown>, targetTeacher),
    )
    .sort((first, second) => {
      const firstTime = first.start ? new Date(first.start).getTime() : 0;
      const secondTime = second.start ? new Date(second.start).getTime() : 0;
      return firstTime - secondTime;
    });
};

const formatLessonTiming = (lesson: LessonEvent | null) => {
  if (!lesson?.start) {
    return "Kliknij zajęcia w planie";
  }

  const start = new Date(lesson.attendanceStart ?? lesson.start);
  const end = lesson.end ? new Date(lesson.end) : null;

  return `${detailDateFormatter.format(start)} · ${timeFormatter.format(start)}-${end ? timeFormatter.format(end) : "--:--"}`;
};

const getLessonState = (lesson: LessonEvent | null) => {
  if (!lesson?.start) {
    return "Brak wyboru";
  }

  const now = Date.now();
  const start = new Date(lesson.start).getTime();
  const end = lesson.end ? new Date(lesson.end).getTime() : start;

  if (start <= now && end >= now) {
    return "Trwają";
  }

  if (start > now) {
    return "Zaplanowane";
  }

  return "Zakończone";
};

const getLessonStateTone = (
  lesson: LessonEvent | null,
): "accent" | "warning" | "neutral" => {
  const state = getLessonState(lesson);

  if (state === "Trwają") {
    return "accent";
  }

  if (state === "Zaplanowane") {
    return "warning";
  }

  return "neutral";
};

const formatMessageTimestamp = (value?: string) => {
  if (!value) {
    return "";
  }

  return messageTimeFormatter.format(new Date(value));
};

const getAttendanceWindow = (lesson: LessonEvent) => {
  const canonicalStart = lesson.attendanceStart ?? lesson.start;
  if (!canonicalStart) {
    return null;
  }

  const start = new Date(canonicalStart);
  const end = lesson.end
    ? new Date(lesson.end)
    : new Date(start.getTime() + 90 * 60 * 1000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  return {
    from: start.toISOString(),
    to: end.toISOString(),
  };
};

const hasMessageBeenEdited = (message: MessageRecord) => {
  if (!message.updatedAt) {
    return false;
  }

  return (
    new Date(message.updatedAt).getTime() - new Date(message.createdAt).getTime() >
    1000
  );
};

const normalizeRoomFromMessage = (room: string | null | undefined) => {
  const normalized = room?.trim().replace(/\s+/g, " ") ?? "";
  return normalized === "Unknown" || normalized === "Nieznana sala"
    ? ""
    : normalized;
};

const getLatestRoomChangeMessage = (messages: MessageRecord[]) =>
  [...messages]
    .filter((message) => message.isRoomChange && message.newRoom)
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    )[0] ?? null;



export default function LecturerCalendar() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { theme } = useTheme();
  const calendarRef = useRef<FullCalendar | null>(null);
  const calendarShellRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDialogElement>(null);
  const dockedPanelRef = useRef<HTMLElement>(null);
  const previewFieldRef = useRef<HTMLInputElement>(null);
  const previewSearchId = useId();
  const messageRequestIdRef = useRef(0);
  const calendarResizeFrameRef = useRef<number | null>(null);
  const toastIdRef = useRef(0);
  const toastTimeoutRef = useRef(new Map<number, number>());

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [isSessionReady, setSessionReady] = useState(false);
  const [actualLogin, setActualLogin] = useState<string | null>(null);
  const [activeTeacher, setActiveTeacher] = useState<string | null>(null);
  const [events, setEvents] = useState<LessonEvent[]>([]);
  const [selectedLesson, setSelectedLesson] = useState<LessonEvent | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [currentDates, setCurrentDates] = useState({ start: "", end: "" });
  const [calendarTitle, setCalendarTitle] = useState("");
  const attendanceRequestRef = useRef<AbortController | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [editingMessageBody, setEditingMessageBody] = useState("");
  const [editingMessageRoom, setEditingMessageRoom] = useState("");
  const [messageMutationId, setMessageMutationId] = useState<number | null>(null);
  const [editedRoom, setEditedRoom] = useState("");
  const [isEditingRoom, setIsEditingRoom] = useState(false);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isSyncingPlan, setIsSyncingPlan] = useState(false);
  const [isAttendancePanelOpen, setIsAttendancePanelOpen] = useState(false);
  const [isAttendanceLoading, setIsAttendanceLoading] = useState(false);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  const [attendanceDrafts, setAttendanceDrafts] = useState<
    Record<string, AttendanceDraft>
  >({});
  const [toasts, setToasts] = useState<LecturerToast[]>([]);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [preferredCalendarView, setPreferredCalendarView] =
    useState<CalendarView | null>(null);
  const effectiveCalendarView = preferredCalendarView ??
    (viewport.width >= AUTO_DAY_VIEW_MIN_WIDTH ? "timeGridWeek" : "timeGridDay");
  const [previewFullNameInput, setPreviewFullNameInput] = useState("");
  const [previewSearchOpen, setPreviewSearchOpen] = useState(false);
  const [highlightedTeacher, setHighlightedTeacher] = useState(-1);
  const previewSuggestionsId = useId();
  const [previewTeacherSuggestions, setPreviewTeacherSuggestions] = useState<
    string[]
  >([]);
  const [isPreviewTeacherSuggestionsOpen, setPreviewTeacherSuggestionsOpen] =
    useState(false);
  const [isPreviewTeacherSearchLoading, setPreviewTeacherSearchLoading] =
    useState(false);
  const hasPreviewSuggestions = isPreviewTeacherSuggestionsOpen && previewTeacherSuggestions.length > 0;
  const activePreviewSuggestion = hasPreviewSuggestions ? previewTeacherSuggestions[highlightedTeacher] : undefined;

  const isAdminPreviewMode =
    searchParams.get("mode") === ADMIN_PREVIEW_MODE;
  const previewTeacherName =
    normalizePreviewFieldValue(searchParams.get("fullName")) ||
    buildPreviewTeacherName(
      normalizePreviewFieldValue(searchParams.get("surname")),
      normalizePreviewFieldValue(searchParams.get("givenName")),
    );
  const hasActiveTeacher = Boolean(activeTeacher);

  const workspaceMode = resolveWorkspaceMode(viewport.width, viewport.height);
  const isTripleDocked = workspaceMode === "triple-docked";
  const isDoubleDocked = workspaceMode === "double-docked";
  const isDockedLayout = isTripleDocked || isDoubleDocked;
  const isSheetLayout = workspaceMode === "sheet";
  const canUseAttendance = Boolean(
    selectedLesson && getAttendanceWindow(selectedLesson),
  );
  const isAttendanceVisible = Boolean(
    selectedLesson && canUseAttendance && isAttendancePanelOpen,
  );
  const showOverlay = !isDockedLayout && Boolean(selectedLesson);
  const showPreviewSearch = !isSheetLayout || !hasActiveTeacher || previewSearchOpen;

  const lessonMeta = selectedLesson
    ? [
        selectedLesson.group_name || "",
        selectedLesson.lesson_form || "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const currentAttendanceDraft = selectedLesson
    ? attendanceDrafts[selectedLesson.id] ?? null
    : null;
  const latestRoomChangeMessage = getLatestRoomChangeMessage(messages);
  const canUndoRoomChange = Boolean(
    latestRoomChangeMessage &&
      (session?.access.isAdmin || latestRoomChangeMessage.login === actualLogin),
  );

  const scheduleCalendarResize = () => {
    if (calendarResizeFrameRef.current !== null) return;
    calendarResizeFrameRef.current = window.requestAnimationFrame(() => {
      calendarResizeFrameRef.current = null;
      calendarRef.current?.getApi().updateSize();
    });
  };

  const dismissToast = (toastId: number) => {
    const timeoutId = toastTimeoutRef.current.get(toastId);

    if (timeoutId) {
      window.clearTimeout(timeoutId);
      toastTimeoutRef.current.delete(toastId);
    }

    setToasts((current) => current.filter((toast) => toast.id !== toastId));
  };

  const pushToast = (message: string, tone: LecturerToastTone) => {
    const nextToastId = toastIdRef.current + 1;
    toastIdRef.current = nextToastId;

    setToasts((current) => [...current, { id: nextToastId, message, tone }]);

    const timeoutId = window.setTimeout(() => {
      dismissToast(nextToastId);
    }, TOAST_DURATION_MS);

    toastTimeoutRef.current.set(nextToastId, timeoutId);
  };

  const loadMessagesForLesson = async (lessonId: string) => {
    const requestId = messageRequestIdRef.current + 1;
    messageRequestIdRef.current = requestId;
    setIsMessagesLoading(true);

    try {
      const nextMessages = await fetchMessages(lessonId);
      if (requestId === messageRequestIdRef.current) {
        setMessages(nextMessages);
      }
    } catch (error) {
      console.error("Error fetching lesson messages:", error);
      if (requestId === messageRequestIdRef.current) {
        setMessages([]);
      }
    } finally {
      if (requestId === messageRequestIdRef.current) {
        setIsMessagesLoading(false);
      }
    }
  };

  useEffect(() => {
    const activeTimeouts = toastTimeoutRef.current;

    return () => {
      if (calendarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(calendarResizeFrameRef.current);
        calendarResizeFrameRef.current = null;
      }

      for (const timeoutId of activeTimeouts.values()) {
        window.clearTimeout(timeoutId);
      }

      activeTimeouts.clear();
    };
  }, []);

  useEffect(() => {
    const shouldLockScroll = isDockedLayout;

    if (shouldLockScroll) {
      document.documentElement.classList.add(LECTURER_SCROLL_ROOT_CLASS);
      document.body.classList.add(LECTURER_SCROLL_ROOT_CLASS);
    } else {
      document.documentElement.classList.remove(LECTURER_SCROLL_ROOT_CLASS);
      document.body.classList.remove(LECTURER_SCROLL_ROOT_CLASS);
    }

    return () => {
      document.documentElement.classList.remove(LECTURER_SCROLL_ROOT_CLASS);
      document.body.classList.remove(LECTURER_SCROLL_ROOT_CLASS);
    };
  }, [isDockedLayout]);

  useEffect(() => {
    const shell = workspaceRef.current;
    if (!shell) return;
    const measure = () => {
      const width = shell.clientWidth;
      const height = window.innerHeight;
      setViewport((current) => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(shell);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [isSessionReady]);

  useEffect(() => {
    const target = calendarShellRef.current;

    if (!target || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(scheduleCalendarResize);
    observer.observe(target);

    return () => observer.disconnect();
  }, [isSessionReady]);

  useEffect(() => {
    const calendarApi = calendarRef.current?.getApi();

    if (!calendarApi) {
      return;
    }

    if (calendarApi.view.type !== effectiveCalendarView) {
      calendarApi.changeView(effectiveCalendarView, selectedLesson?.start);
    }

    scheduleCalendarResize();
  }, [effectiveCalendarView, selectedLesson?.start]);

  useEffect(() => {
    scheduleCalendarResize();
  }, [workspaceMode, selectedLesson?.id, isAttendanceVisible, showPreviewSearch]);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!showOverlay || !overlay) return;
    const previous = document.activeElement;
    overlay.showModal();
    return () => {
      overlay.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [showOverlay]);

  useLayoutEffect(() => {
    const panel = isAttendanceVisible ? "attendance" : "details";
    const container = showOverlay ? overlayRef.current?.querySelector(`.lecturer-console__drawer--${panel}`)
      : isDoubleDocked ? dockedPanelRef.current : null;
    container?.querySelector<HTMLElement>("[data-panel-close]")?.focus({ preventScroll: true });
  }, [showOverlay, isAttendanceVisible, isDoubleDocked, isSheetLayout]);

  useEffect(() => {
    let isMounted = true;

    const loadSession = async () => {
      setSessionReady(false);
      const currentSession = await fetchSession();

      if (!isMounted) {
        return;
      }

      if (!currentSession) {
        navigate("/", { replace: true });
        return;
      }

      if (isAdminPreviewMode) {
        if (!currentSession.access.isAdmin) {
          navigate("/access-denied", {
            replace: true,
            state: { reason: "admin" },
          });
          return;
        }
      } else if (!canOpenLecturerPlan(currentSession)) {
        navigate("/access-denied", {
          replace: true,
          state: { reason: "lecturer" },
        });
        return;
      }

      setSession(currentSession);
      setActualLogin(currentSession.login);
      setSessionReady(true);
    };

    void loadSession();

    return () => {
      isMounted = false;
    };
  }, [isAdminPreviewMode, navigate]);

  useEffect(() => {
    setPreviewFullNameInput(previewTeacherName);
  }, [previewTeacherName]);

  useEffect(() => {
    if (!isAdminPreviewMode) {
      setPreviewTeacherSuggestions([]);
      setPreviewTeacherSuggestionsOpen(false);
      setPreviewTeacherSearchLoading(false);
      return;
    }

    const query = normalizePreviewFieldValue(previewFullNameInput);

    if (query === previewTeacherName) {
      setPreviewTeacherSuggestions([]);
      setPreviewTeacherSuggestionsOpen(false);
      setPreviewTeacherSearchLoading(false);
      return;
    }

    if (query.length < PREVIEW_TEACHER_SEARCH_MIN_LENGTH) {
      setPreviewTeacherSuggestions([]);
      setPreviewTeacherSuggestionsOpen(false);
      setPreviewTeacherSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setPreviewTeacherSearchLoading(true);

      void fetchPreviewTeacherMatches(query, controller.signal)
        .then((matches) => {
          if (!controller.signal.aborted) setPreviewTeacherSuggestions(matches);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }

          console.error("Error fetching lecturer suggestions:", error);
          setPreviewTeacherSuggestions([]);
          setPreviewTeacherSuggestionsOpen(false);
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setPreviewTeacherSearchLoading(false);
          }
        });
    }, PREVIEW_TEACHER_SEARCH_DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [isAdminPreviewMode, previewFullNameInput, previewTeacherName]);

  useEffect(() => {
    if (!session) {
      setActiveTeacher(null);
      return;
    }

    if (isAdminPreviewMode) {
      setActiveTeacher(previewTeacherName);
      return;
    }

    setActiveTeacher(getLecturerDisplayName(session));
  }, [isAdminPreviewMode, previewTeacherName, session]);

  useEffect(() => {
    if (!isSessionReady) {
      return;
    }

    if (isAdminPreviewMode) {
      document.title = activeTeacher
        ? `Podgląd dydaktyka - ${activeTeacher}`
        : "Podgląd dydaktyka";
      return;
    }

    if (activeTeacher) {
      document.title = `Plan prowadzącego - ${activeTeacher}`;
    }
  }, [activeTeacher, isAdminPreviewMode, isSessionReady]);

  useEffect(() => {
    setEvents([]);
    setSelectedLesson(null);
    setMessages([]);
    setIsMessagesLoading(false);
    setIsEditingRoom(false);
    setEditedRoom("");
    setIsAttendancePanelOpen(false);
    setNewMessage("");
    setEditingMessageId(null);
    setEditingMessageBody("");
    setEditingMessageRoom("");
    setMessageMutationId(null);

    if (!activeTeacher) {
      setCalendarTitle(
        isAdminPreviewMode ? "Wybierz dydaktyka do podglądu" : "",
      );
    }
  }, [activeTeacher, isAdminPreviewMode]);

  useEffect(() => {
    let isCancelled = false;

    const syncSchedule = async () => {
      if (!currentDates.start || !currentDates.end || !activeTeacher) {
        return;
      }

      setIsSyncingPlan(true);

      try {
        const fetchedEvents = await fetchLecturerEvents(
          currentDates.start,
          currentDates.end,
          activeTeacher,
        );

        if (!isCancelled) {
          setEvents(fetchedEvents);
        }
      } catch (error) {
        console.error("Error fetching lecturer plan:", error);
      } finally {
        if (!isCancelled) {
          setIsSyncingPlan(false);
        }
      }
    };

    void syncSchedule();

    if (!activeTeacher) {
      return () => {
        isCancelled = true;
      };
    }

    const intervalId = window.setInterval(() => {
      void syncSchedule();
    }, 15 * 60 * 1000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeTeacher, currentDates.end, currentDates.start]);

  useEffect(() => {
    setSelectedLesson((current) => {
      if (!current) {
        return null;
      }

      return events.find((event) => event.id === current.id) ?? current;
    });
  }, [events]);

  useEffect(() => {
    if (!selectedLesson?.id) {
      messageRequestIdRef.current += 1;
      setMessages([]);
      setIsMessagesLoading(false);
      return;
    }

    void loadMessagesForLesson(selectedLesson.id);
  }, [selectedLesson?.id]);

  useEffect(() => {
    if (!selectedLesson || !latestRoomChangeMessage?.newRoom) {
      return;
    }

    const nextRoom = normalizeRoomFromMessage(latestRoomChangeMessage.newRoom);

    if (!nextRoom || selectedLesson.room === nextRoom) {
      return;
    }

    setEvents((current) =>
      current.map((event) =>
        event.id === selectedLesson.id ? { ...event, room: nextRoom } : event,
      ),
    );
    setSelectedLesson((current) =>
      current?.id === selectedLesson.id ? { ...current, room: nextRoom } : current,
    );

    if (!isEditingRoom) {
      setEditedRoom(nextRoom);
    }
  }, [isEditingRoom, latestRoomChangeMessage, selectedLesson]);

  useEffect(() => {
    setIsEditingRoom(false);
    setEditedRoom(selectedLesson?.room || "");
    setIsAttendancePanelOpen(false);
    setIsAttendanceLoading(false);
    setAttendanceError(null);
    setNewMessage("");
    setEditingMessageId(null);
    setEditingMessageBody("");
    setEditingMessageRoom("");
    setMessageMutationId(null);
    return () => attendanceRequestRef.current?.abort();
  }, [selectedLesson?.id]);

  useEffect(() => {
    if (!isEditingRoom) {
      setEditedRoom(selectedLesson?.room || "");
    }
  }, [isEditingRoom, selectedLesson?.room]);

  const handleLogout = async () => {
    try {
      await logout();
      navigate("/");
    } catch (error) {
      console.error("Error during logout:", error);
      window.alert("Nie udało się wylogować.");
    }
  };

  const handleRefreshPlan = async () => {
    if (!currentDates.start || !currentDates.end || !activeTeacher) {
      return;
    }

    setIsSyncingPlan(true);

    try {
      const fetchedEvents = await fetchLecturerEvents(
        currentDates.start,
        currentDates.end,
        activeTeacher,
      );
      setEvents(fetchedEvents);
    } catch (error) {
      console.error("Error refreshing lecturer plan:", error);
      pushToast("Nie udało się odświeżyć planu zajęć.", "danger");
    } finally {
      setIsSyncingPlan(false);
    }
  };

  const clearLessonSelection = () => {
    setSelectedLesson(null);
    setMessages([]);
    setNewMessage("");
    setEditingMessageId(null);
    setEditingMessageBody("");
    setEditingMessageRoom("");
    setIsEditingRoom(false);
    setIsAttendancePanelOpen(false);
  };

  const applyPreviewTeacherName = (fullName: string) => {
    const nextFullName = normalizePreviewFieldValue(fullName);
    const nextSearchParams = new URLSearchParams();

    nextSearchParams.set("mode", ADMIN_PREVIEW_MODE);

    if (nextFullName) {
      nextSearchParams.set("fullName", nextFullName);
    }

    setSearchParams(nextSearchParams);
  };

  const handlePreviewApply = () => {
    setPreviewSearchOpen(false);
    setPreviewTeacherSuggestionsOpen(false);
    applyPreviewTeacherName(previewFullNameInput);
  };

  const handlePreviewTeacherSelect = (teacherName: string) => {
    setPreviewSearchOpen(false);
    setPreviewFullNameInput(teacherName);
    setPreviewTeacherSuggestions([]);
    setPreviewTeacherSuggestionsOpen(false);
    applyPreviewTeacherName(teacherName);
  };

  const handlePreviewClear = () => {
    setPreviewSearchOpen(true);
    setPreviewFullNameInput("");
    setPreviewTeacherSuggestions([]);
    setPreviewTeacherSuggestionsOpen(false);
    setSearchParams({ mode: ADMIN_PREVIEW_MODE });
  };

  const handleEventClick = (info: EventClickArg) => {
    info.el.focus({ preventScroll: true });
    setSelectedLesson(mapCalendarEvent(info.event));
  };

  const handleSendMessage = async () => {
    if (!selectedLesson?.id || !newMessage.trim()) {
      return;
    }

    const messagePayload: MessagePayload = {
      body: leoProfanity.clean(newMessage.trim()),
      lecturer: selectedLesson.worker_title || activeTeacher || "Prowadzący",
      login: actualLogin || "unknown",
      room: selectedLesson.room || "Nieznana sala",
      lessonId: selectedLesson.id,
      group: selectedLesson.group_name || "Nieznana grupa",
      createdAt: new Date(),
    };

    try {
      await createMessage(messagePayload);
      await loadMessagesForLesson(selectedLesson.id);
      setNewMessage("");
      setEvents((current) =>
        current.map((event) =>
          event.id === selectedLesson.id
            ? { ...event, hasNotifications: true }
            : event,
        ),
      );
    } catch (error) {
      console.error("Error sending message:", error);
      pushToast("Nie udało się wysłać powiadomienia.", "danger");
    }
  };

  const applyRoomToSelectedLesson = (nextRoom: string) => {
    if (!selectedLesson) {
      return;
    }

    setEvents((current) =>
      current.map((event) =>
        event.id === selectedLesson.id ? { ...event, room: nextRoom } : event,
      ),
    );
    setSelectedLesson((current) =>
      current?.id === selectedLesson.id ? { ...current, room: nextRoom } : current,
    );
    setEditedRoom(nextRoom);
    setIsEditingRoom(false);
  };

  const getRoomAfterMessageRemoval = (
    deletedMessage: MessageRecord,
    remainingMessages: MessageRecord[],
  ) =>
    normalizeRoomFromMessage(getLatestRoomChangeMessage(remainingMessages)?.newRoom) ||
    normalizeRoomFromMessage(deletedMessage.room);

  const handleDeleteMessage = async (message: MessageRecord) => {
    setMessageMutationId(message.id);

    try {
      await deleteMessage(message.id);
      const remainingMessages = messages.filter(
        (currentMessage) => currentMessage.id !== message.id,
      );
      setMessages(remainingMessages);

      const hasLeft = remainingMessages.length > 0;
      setEvents((current) =>
        current.map((event) =>
          event.id === String(message.lessonId)
            ? { ...event, hasNotifications: hasLeft }
            : event,
        ),
      );

      if (message.isRoomChange) {
        const restoredRoom = getRoomAfterMessageRemoval(message, remainingMessages);
        applyRoomToSelectedLesson(restoredRoom);
        pushToast(
          restoredRoom
            ? `Przywrócono salę ${restoredRoom}.`
            : "Usunięto zmianę sali.",
          "success",
        );
      }

      if (editingMessageId === message.id) {
        setEditingMessageId(null);
        setEditingMessageBody("");
        setEditingMessageRoom("");
      }
    } catch (error) {
      console.error("Error deleting message:", error);
      pushToast("Nie udało się usunąć powiadomienia.", "danger");
    } finally {
      setMessageMutationId(null);
    }
  };

  const handleStartMessageEdit = (message: MessageRecord) => {
    setEditingMessageId(message.id);
    setEditingMessageBody(message.body);
    setEditingMessageRoom(message.newRoom || "");
  };

  const handleCancelMessageEdit = () => {
    setEditingMessageId(null);
    setEditingMessageBody("");
    setEditingMessageRoom("");
  };

  const handleSaveEditedMessage = async (message: MessageRecord) => {
    const isRoomChange = Boolean(message.isRoomChange);
    const nextBody = leoProfanity.clean(editingMessageBody.trim());
    const nextRoom = normalizeRoomFromMessage(editingMessageRoom);

    if ((!isRoomChange && !nextBody) || (isRoomChange && !nextRoom)) {
      return;
    }

    setMessageMutationId(message.id);

    try {
      const updated = await updateMessage(
        message.id,
        isRoomChange ? { newRoom: nextRoom } : { body: nextBody },
      );
      const updatedMessages = messages.map((currentMessage) =>
        currentMessage.id === message.id ? updated : currentMessage,
      );
      setMessages(updatedMessages);

      if (isRoomChange) {
        const effectiveRoom =
          normalizeRoomFromMessage(
            getLatestRoomChangeMessage(updatedMessages)?.newRoom,
          ) || normalizeRoomFromMessage(message.room);
        applyRoomToSelectedLesson(effectiveRoom);
      }

      setEditingMessageId(null);
      setEditingMessageBody("");
      setEditingMessageRoom("");
    } catch (error) {
      console.error("Error updating message:", error);
      pushToast("Nie udało się zapisać zmian w powiadomieniu.", "danger");
    } finally {
      setMessageMutationId(null);
    }
  };

  const handleSaveRoom = async () => {
    if (!selectedLesson) {
      return;
    }

    const previousRoom = selectedLesson.room || "";
    const nextRoom = editedRoom.trim();

    if (!nextRoom || nextRoom === previousRoom) {
      setIsEditingRoom(false);
      return;
    }

    const roomChangePayload: MessagePayload = {
      body: `Zajęcia przeniesione do sali: ${nextRoom}`,
      lecturer: selectedLesson.worker_title || activeTeacher || "Prowadzący",
      login: actualLogin || "unknown",
      room: previousRoom,
      lessonId: selectedLesson.id,
      group: selectedLesson.group_name || "Nieznana grupa",
      createdAt: new Date(),
      isRoomChange: true,
      newRoom: nextRoom,
    };

    try {
      const createdMessage = await createMessage(roomChangePayload);
      setMessages((current) => [...current, createdMessage]);
      applyRoomToSelectedLesson(nextRoom);
      pushToast(`Sala została zmieniona na ${nextRoom}.`, "success");
      setEvents((current) =>
        current.map((event) =>
          event.id === selectedLesson.id
            ? { ...event, hasNotifications: true }
            : event,
        ),
      );
    } catch (error) {
      console.error("Error sending room change message:", error);
      pushToast("Nie udało się zapisać zmiany sali.", "danger");
    }
  };

  const handleUndoRoomChange = async () => {
    if (!selectedLesson || !latestRoomChangeMessage) {
      return;
    }

    const previousRoom = normalizeRoomFromMessage(latestRoomChangeMessage.room);
    const previousRoomLabel = previousRoom || "brak ustawionej sali";

    setMessageMutationId(latestRoomChangeMessage.id);

    try {
      await deleteMessage(latestRoomChangeMessage.id);
      const remainingMessages = messages.filter((message) => message.id !== latestRoomChangeMessage.id);
      setMessages(remainingMessages);
      applyRoomToSelectedLesson(previousRoom);
      pushToast(`Cofnięto zmianę sali: ${previousRoomLabel}.`, "success");

      const hasLeft = remainingMessages.length > 0;
      setEvents((current) =>
        current.map((event) =>
          event.id === selectedLesson.id
            ? { ...event, hasNotifications: hasLeft }
            : event,
        ),
      );
    } catch (error) {
      console.error("Error undoing room change:", error);
      pushToast("Nie udało się cofnąć zmiany sali.", "danger");
    } finally {
      setMessageMutationId(null);
    }
  };

  const ensureAttendanceDraft = () => {
    if (!selectedLesson) {
      return;
    }

    setAttendanceDrafts((current) => {
      if (current[selectedLesson.id]) {
        return current;
      }

      return {
        ...current,
        [selectedLesson.id]: createAttendanceDraft(
          selectedLesson.id,
          selectedLesson.room,
        ),
      };
    });
  };

  const updateAttendanceDraft = (
    updater: (currentDraft: AttendanceDraft) => AttendanceDraft,
  ) => {
    if (!selectedLesson) {
      return;
    }

    setAttendanceDrafts((current) => {
      const baseDraft =
        current[selectedLesson.id] ??
        createAttendanceDraft(selectedLesson.id, selectedLesson.room);

      return {
        ...current,
        [selectedLesson.id]: updater(baseDraft),
      };
    });
  };

  const loadAttendanceForLesson = async (
    lesson: LessonEvent,
    sessionIdOverride?: number | null,
  ) => {
    const doorId = resolveAttendanceDoorId(actualLogin, lesson.room);
    const attendanceWindow = getAttendanceWindow(lesson);
    const sessionId = sessionIdOverride === undefined
      ? attendanceDrafts[lesson.id]?.sessionId
      : sessionIdOverride;

    if (!attendanceWindow) {
      setAttendanceError("Brakuje zakresu czasu dla listy obecności.");
      return;
    }

    setIsAttendanceLoading(true);
    setAttendanceError(null);
    attendanceRequestRef.current?.abort();
    const controller = new AbortController();
    attendanceRequestRef.current = controller;

    try {
      const attendanceList = await fetchLessonAttendanceList({
        lessonId: lesson.id,
        teacher: isAdminPreviewMode ? previewTeacherName : null,
        doorId,
        sessionId,
        from: attendanceWindow.from,
        to: attendanceWindow.to,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      setAttendanceDrafts((current) => {
        const baseDraft = current[lesson.id] ?? createAttendanceDraft(lesson.id, lesson.room);

        return {
          ...current,
          [lesson.id]: attendanceList
            ? applyAttendanceListToDraft(baseDraft, attendanceList)
            : { ...createAttendanceDraft(lesson.id, lesson.room), loadedAt: new Date().toISOString() },
        };
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Error loading attendance list:", error);
      setAttendanceError("Nie udało się pobrać aktywnej sesji obecności.");
    } finally {
      if (attendanceRequestRef.current === controller) {
        attendanceRequestRef.current = null;
        setIsAttendanceLoading(false);
      }
    }
  };

  const handleOpenAttendancePanel = () => {
    if (!selectedLesson || !getAttendanceWindow(selectedLesson)) {
      return;
    }

    ensureAttendanceDraft();
    setIsAttendancePanelOpen(true);
    void loadAttendanceForLesson(selectedLesson, null);
  };

  const handleAttendanceCloseList = async () => {
    if (!selectedLesson || !currentAttendanceDraft?.sessionId) {
      return;
    }

    setIsAttendanceLoading(true);
    setAttendanceError(null);

    try {
      const attendanceList = await closeAttendanceSession(currentAttendanceDraft.sessionId);
      updateAttendanceDraft((current) => applyAttendanceListToDraft(current, attendanceList));
      pushToast("Sesja obecności została zamknięta.", "success");
    } catch (error) {
      console.error("Error closing attendance session:", error);
      setAttendanceError("Nie udało się zamknąć sesji obecności.");
    } finally {
      setIsAttendanceLoading(false);
    }
  };

  const handleAttendanceSendList = async () => {
    if (!selectedLesson || !currentAttendanceDraft?.sessionId) {
      return;
    }

    setIsAttendanceLoading(true);
    setAttendanceError(null);

    try {
      const attendanceList = await sendAttendanceSession(currentAttendanceDraft.sessionId);
      updateAttendanceDraft((current) => applyAttendanceListToDraft(current, attendanceList));
      pushToast("JSON listy obecności jest gotowy w backendzie.", "success");
    } catch (error) {
      console.error("Error sending attendance session:", error);
      setAttendanceError("Nie udało się przygotować JSON listy obecności.");
    } finally {
      setIsAttendanceLoading(false);
    }
  };

  const handleAttendanceAddRow = async (albumNumber: string, enteredAt: string | null) => {
    if (!selectedLesson || !currentAttendanceDraft?.sessionId) {
      return false;
    }

    setIsAttendanceLoading(true);
    setAttendanceError(null);

    try {
      await addAttendanceSessionUser(currentAttendanceDraft.sessionId, {
        username: albumNumber,
        cardHex: albumNumber,
        enteredAt,
      });
      await loadAttendanceForLesson(selectedLesson, currentAttendanceDraft.sessionId);
      return true;
    } catch (error) {
      console.error("Error adding attendance user:", error);
      setAttendanceError("Nie udało się dodać wpisu do sesji obecności.");
      return false;
    } finally {
      setIsAttendanceLoading(false);
    }
  };

  const handleAttendanceRemoveRow = async (rowId: string, userId?: number) => {
    if (!selectedLesson || !currentAttendanceDraft?.sessionId || !userId) {
      updateAttendanceDraft((current) => ({
        ...current,
        rows: current.rows.filter((row) => row.id !== rowId),
      }));
      return;
    }

    setIsAttendanceLoading(true);
    setAttendanceError(null);

    try {
      await removeAttendanceSessionUser(currentAttendanceDraft.sessionId, userId);
      await loadAttendanceForLesson(selectedLesson, currentAttendanceDraft.sessionId);
    } catch (error) {
      console.error("Error removing attendance user:", error);
      setAttendanceError("Nie udało się usunąć wpisu z sesji obecności.");
    } finally {
      setIsAttendanceLoading(false);
    }
  };

  const handleCalendarMove = (direction: "prev" | "next" | "today") => {
    const calendarApi = calendarRef.current?.getApi();

    if (!calendarApi) {
      return;
    }

    if (direction === "prev") {
      calendarApi.prev();
      return;
    }

    if (direction === "next") {
      calendarApi.next();
      return;
    }

    calendarApi.today();
  };

  const calendarEvents = events.map(({ color, ...event }) => ({
    ...event,
    extendedProps: { color },
    classNames: [
      "lecturer-console__calendar-event",
      "lecturer-console__calendar-event--" + getLessonColor(event.lesson_form),
      selectedLesson?.id === event.id
        ? "lecturer-console__calendar-event--selected"
        : "",
      event.hasNotifications
        ? "lecturer-console__calendar-event--has-notifications"
        : "",
    ].filter(Boolean),
  }));

  const lessonInspector = selectedLesson ? (
    <section className="lecturer-console__panel lecturer-console__panel--details">
      <header className="lecturer-console__panel-header">
        <div className="lecturer-console__panel-header-copy">
          <h2>{selectedLesson.title}</h2>
          <p>{formatLessonTiming(selectedLesson)}</p>
          {lessonMeta ? (
            <div className="lecturer-console__panel-meta">{lessonMeta}</div>
          ) : null}
          <span
            className={`lecturer-console__panel-state lecturer-console__panel-state--${getLessonStateTone(
              selectedLesson,
            )}`}
          >
            {getLessonState(selectedLesson)}
          </span>
        </div>

        <div className="lecturer-console__panel-header-actions">
          <button
            type="button"
            className="admin-icon-button"
            data-panel-close
            onClick={clearLessonSelection}
            aria-label="Zamknij panel zajęć"
          >
            <FaTimes aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="lecturer-console__panel-body">
        <div className="lecturer-console__panel-strip">
          {!isEditingRoom ? (
            <>
              <div className="lecturer-console__room-inline">
                {selectedLesson.room ? `Sala ${selectedLesson.room}` : "Sala nieustawiona"}
              </div>

              <div className="lecturer-console__row-actions">
                <button
                  type="button"
                  className="admin-button admin-button--ghost admin-button--small"
                  onClick={() => setIsEditingRoom(true)}
                >
                  <FaEdit />
                  Zmień salę
                </button>

                {canUndoRoomChange ? (
                  <button
                    type="button"
                    className="admin-button admin-button--ghost admin-button--small"
                    disabled={messageMutationId === latestRoomChangeMessage?.id}
                    onClick={() => void handleUndoRoomChange()}
                  >
                    <FaUndo />
                    Cofnij zmianę
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="lecturer-console__room-editor">
              <input
                className="lecturer-console__inline-input"
                type="text"
                aria-label="Nowa sala"
                value={editedRoom}
                onChange={(event) => setEditedRoom(event.target.value)}
                autoFocus
              />

              <div className="lecturer-console__row-actions">
                <button
                  type="button"
                  className="admin-button admin-button--primary admin-button--small"
                  onClick={() => void handleSaveRoom()}
                >
                  Zapisz
                </button>
                <button
                  type="button"
                  className="admin-button admin-button--ghost admin-button--small"
                  onClick={() => {
                    setEditedRoom(selectedLesson.room || "");
                    setIsEditingRoom(false);
                  }}
                >
                  Anuluj
                </button>
              </div>
            </div>
          )}
        </div>

        <section className="lecturer-console__panel-section lecturer-console__panel-section--notifications">
          <div className="lecturer-console__messages">
            {isMessagesLoading && messages.length === 0 ? (
              <div className="lecturer-console__messages-empty">Ładowanie...</div>
            ) : messages.length === 0 ? (
              <div className="lecturer-console__messages-empty">Brak powiadomień.</div>
            ) : (
              messages.map((message) => {
                const canManageMessage = Boolean(
                  session?.access.isAdmin || message.login === actualLogin,
                );
                const isEditing = editingMessageId === message.id;
                const isBusy = messageMutationId === message.id;
                const isRoomChange = Boolean(message.isRoomChange);

                return (
                  <article
                    key={message.id}
                    className={`lecturer-console__message${
                      isRoomChange ? " lecturer-console__message--room-change" : ""
                    }`}
                  >
                    <div className="lecturer-console__message-head">
                      <div className="lecturer-console__message-flags">
                        {isRoomChange ? (
                          <span className="lecturer-console__message-chip">Zmiana sali</span>
                        ) : null}
                        {hasMessageBeenEdited(message) ? (
                          <span className="lecturer-console__message-chip">Edytowano</span>
                        ) : null}
                      </div>
                      <span>{formatMessageTimestamp(message.createdAt)}</span>
                    </div>

                    {isEditing ? (
                      isRoomChange ? (
                        <input
                          className="lecturer-console__inline-input"
                          type="text"
                          value={editingMessageRoom}
                          onChange={(event) => setEditingMessageRoom(event.target.value)}
                          placeholder="Wpisz nową salę"
                        />
                      ) : (
                        <textarea
                          className="lecturer-console__message-editor"
                          rows={3}
                          value={editingMessageBody}
                          onChange={(event) => setEditingMessageBody(event.target.value)}
                        />
                      )
                    ) : (
                      <p className="lecturer-console__message-text">
                        {isRoomChange
                          ? `Zmiana sali: ${message.newRoom || "-"}`
                          : message.body}
                      </p>
                    )}

                    {canManageMessage ? (
                      <div className="lecturer-console__message-actions">
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              className="admin-button admin-button--primary admin-button--small"
                              disabled={
                                isBusy ||
                                (isRoomChange
                                  ? !normalizeRoomFromMessage(editingMessageRoom)
                                  : !editingMessageBody.trim())
                              }
                              onClick={() => void handleSaveEditedMessage(message)}
                            >
                              Zapisz
                            </button>
                            <button
                              type="button"
                              className="admin-button admin-button--ghost admin-button--small"
                              disabled={isBusy}
                              onClick={handleCancelMessageEdit}
                            >
                              Anuluj
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="admin-button admin-button--ghost admin-button--small"
                              disabled={isBusy}
                              onClick={() => handleStartMessageEdit(message)}
                            >
                              <FaEdit />
                              Edytuj
                            </button>
                            <button
                              type="button"
                              className="admin-button admin-button--ghost admin-button--small"
                              disabled={isBusy}
                              onClick={() => void handleDeleteMessage(message)}
                            >
                              <FaTrash />
                              Usuń
                            </button>
                          </>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>

          <div className="lecturer-console__composer">
            <textarea
              className="lecturer-console__composer-input"
              rows={2}
              value={newMessage}
              aria-label="Nowe powiadomienie"
              placeholder="Nowe powiadomienie"
              onChange={(event) => setNewMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void handleSendMessage();
                }
              }}
            />

            <button
              type="button"
              className="admin-button admin-button--primary admin-button--small"
              disabled={!newMessage.trim()}
              onClick={() => void handleSendMessage()}
            >
              <FaPaperPlane />
              Wyślij
            </button>
          </div>
        </section>
      </div>

      <footer className="lecturer-console__panel-footer">
        {!canUseAttendance ? (
          <span className="lecturer-console__muted-copy">
            Brak godziny rozpoczęcia zajęć.
          </span>
        ) : null}

        <button
          type="button"
          className="admin-button admin-button--primary admin-button--small"
          onClick={handleOpenAttendancePanel}
          disabled={!canUseAttendance}
        >
          Panel obecności
        </button>
      </footer>
    </section>
  ) : null;

  const attendancePanel = selectedLesson ? (
    <LessonAttendancePanel
      layout="panel"
      lessonId={selectedLesson.id}
      lessonTitle={isSheetLayout ? selectedLesson.title : undefined}
      readOnly={isAdminPreviewMode}
      isLoading={isAttendanceLoading}
      error={attendanceError}
      draft={
        currentAttendanceDraft ??
        createAttendanceDraft(selectedLesson.id, selectedLesson.room)
      }
      onOpenList={() => {
        void loadAttendanceForLesson(
          selectedLesson,
          currentAttendanceDraft?.status === "open"
            ? currentAttendanceDraft?.sessionId ?? null
            : null,
        );
      }}
      onCloseList={() => void handleAttendanceCloseList()}
      onRefresh={() =>
        void loadAttendanceForLesson(
          selectedLesson,
          currentAttendanceDraft?.sessionId,
        )
      }
      onSendList={() => void handleAttendanceSendList()}
      onAddRow={handleAttendanceAddRow}
      onRemoveRow={(rowId, userId) => void handleAttendanceRemoveRow(rowId, userId)}
      onClosePanel={() => setIsAttendancePanelOpen(false)}
    />
  ) : null;

  if (!isSessionReady) {
    return (
      <div className="admin-console lecturer-console" data-admin-theme={theme}>
        <div className="lecturer-console__loading">Ładowanie...</div>
      </div>
    );
  }

  return (
    <WorkspaceLayout
      className="lecturer-console"
      data-workspace-mode={workspaceMode}
      data-admin-preview={isAdminPreviewMode ? "true" : "false"}
      title={isAdminPreviewMode ? "Podgląd planu" : "Mój plan"}
      login={session?.login}
      back={session?.access.isAdmin ? { to: "/adminpanel", label: "Administracja" } : undefined}
      navigation={session?.access.isAdmin ? { ownPlan: canOpenLecturerPlan(session) } : undefined}
      onLogout={handleLogout}
    >
      <div className="lecturer-console__shell" ref={workspaceRef}>
        <main className="lecturer-console__workspace">
          <div
            className={[
              "lecturer-console__dock",
              `lecturer-console__dock--${workspaceMode}`,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <section
              className="lecturer-console__calendar-shell"
              ref={calendarShellRef}
            >
              <div className="lecturer-console__calendar-tools">
                <header className="lecturer-console__surface-header">
                  <div className="lecturer-console__surface-title">
                    <h1>{isAdminPreviewMode ? "Podgląd planu zajęć" : "Mój plan zajęć"}</h1>
                    {activeTeacher && <span title={activeTeacher}>{activeTeacher}</span>}
                  </div>
                  {isAdminPreviewMode && isSheetLayout && hasActiveTeacher && (
                    <button type="button" className="admin-icon-button lecturer-console__search-toggle"
                      aria-label="Zmień prowadzącego" title="Zmień prowadzącego"
                      aria-controls={previewSearchId} aria-expanded={showPreviewSearch}
                      onClick={() => {
                        setPreviewSearchOpen(!previewSearchOpen);
                        if (!previewSearchOpen) window.requestAnimationFrame(() => previewFieldRef.current?.focus());
                      }}>
                      <FaSearch aria-hidden="true" />
                    </button>
                  )}
                  {isAdminPreviewMode && (
                    <form id={previewSearchId} hidden={!showPreviewSearch} className="lecturer-console__teacher-search" onSubmit={(event) => {
                      event.preventDefault();
                      setPreviewTeacherSuggestionsOpen(false);
                      handlePreviewApply();
                    }}>
                      <div className="admin-autocomplete lecturer-console__preview-autocomplete">
                        <FaSearch className="lecturer-console__search-icon" aria-hidden="true" />
                        <input
                          ref={previewFieldRef}
                          className="lecturer-console__preview-input"
                          type="search"
                          role="combobox"
                          placeholder="Szukaj prowadzącego"
                          aria-label="Szukaj prowadzącego"
                          aria-autocomplete="list"
                          aria-controls={hasPreviewSuggestions ? previewSuggestionsId : undefined}
                          aria-expanded={hasPreviewSuggestions}
                          aria-activedescendant={activePreviewSuggestion ? previewSuggestionsId + "-" + highlightedTeacher : undefined}
                          value={previewFullNameInput}
                          onChange={(event) => {
                            setPreviewFullNameInput(event.target.value);
                            setPreviewTeacherSuggestions([]);
                            setHighlightedTeacher(-1);
                            setPreviewTeacherSuggestionsOpen(true);
                          }}
                          onFocus={() => setPreviewTeacherSuggestionsOpen(true)}
                          onBlur={() => setPreviewTeacherSuggestionsOpen(false)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setPreviewTeacherSuggestionsOpen(false);
                            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && previewTeacherSuggestions.length) {
                              event.preventDefault();
                              const last = previewTeacherSuggestions.length - 1;
                              setPreviewTeacherSuggestionsOpen(true);
                              setHighlightedTeacher((index) => event.key === "ArrowDown"
                                ? (index < last ? index + 1 : 0)
                                : (index > 0 ? index - 1 : last));
                            } else if (event.key === "Enter" && activePreviewSuggestion) {
                              event.preventDefault();
                              setHighlightedTeacher(-1);
                              handlePreviewTeacherSelect(activePreviewSuggestion);
                            }
                          }}
                          autoComplete="off"
                        />
                        {isPreviewTeacherSearchLoading && <span className="admin-autocomplete__loading" role="status" aria-label="Szukam w Planie ZUT">
                          <i className="fas fa-spinner fa-spin" aria-hidden="true" />
                        </span>}
                        {hasPreviewSuggestions && (
                          <div className="admin-autocomplete__list lecturer-console__teacher-suggestions" id={previewSuggestionsId} role="listbox">
                            {previewTeacherSuggestions.map((name, index) => (
                              <button
                                key={name}
                                type="button"
                                tabIndex={-1}
                                role="option"
                                id={previewSuggestionsId + "-" + index}
                                aria-selected={highlightedTeacher === index}
                                className="admin-autocomplete__item"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => handlePreviewTeacherSelect(name)}
                              >
                                {name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button type="submit" className="admin-button admin-button--primary admin-button--small" disabled={!previewFullNameInput.trim()}>
                        Pokaż plan
                      </button>
                      {activeTeacher && (isSheetLayout
                        ? <button type="button" className="admin-icon-button"
                          aria-label="Wyczyść wyszukiwanie" title="Wyczyść wyszukiwanie" onClick={handlePreviewClear}><FaTimes aria-hidden="true" /></button>
                        : <button type="button" className="admin-button admin-button--ghost admin-button--small"
                          onClick={handlePreviewClear}>Wyczyść</button>)}
                    </form>
                  )}
                </header>

                {hasActiveTeacher && <div className="lecturer-console__calendar-toolbar">
                  <div className="lecturer-console__calendar-nav" aria-label="Przejdź do daty">
                    <button type="button" className="admin-icon-button" onClick={() => handleCalendarMove("prev")} aria-label="Poprzedni okres">
                      <FaChevronLeft aria-hidden="true" />
                    </button>
                    {isSheetLayout
                      ? <button type="button" className="lecturer-console__compact-date" title="Przejdź do dzisiaj"
                        aria-label={`${calendarTitle}. Przejdź do dzisiaj`} onClick={() => handleCalendarMove("today")}>
                        {calendarTitle}
                      </button>
                      : <button type="button" className="admin-button admin-button--secondary admin-button--small"
                        onClick={() => handleCalendarMove("today")}>Dzisiaj</button>}
                    <button type="button" className="admin-icon-button" onClick={() => handleCalendarMove("next")} aria-label="Następny okres">
                      <FaChevronRight aria-hidden="true" />
                    </button>
                  </div>
                  {!isSheetLayout && <p className="lecturer-console__calendar-date" aria-live="polite">{calendarTitle}</p>}
                  <div className="lecturer-console__surface-actions">
                    {isSheetLayout ? (
                      <select className="lecturer-console__compact-view" aria-label="Widok kalendarza" value={effectiveCalendarView}
                        onChange={(event) => setPreferredCalendarView(event.target.value as CalendarView)}>
                        {calendarViews.map(([view, label]) => <option key={view} value={view}>{label}</option>)}
                      </select>
                    ) : (
                      <div className="lecturer-console__view-toggle" role="group" aria-label="Widok kalendarza">
                        {calendarViews.map(([view, label]) => (
                          <button
                            key={view}
                            type="button"
                            className="lecturer-console__view-button"
                            aria-pressed={effectiveCalendarView === view}
                            onClick={() => setPreferredCalendarView(view)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                    <button type="button" className="admin-icon-button" onClick={() => void handleRefreshPlan()}
                      aria-label="Odśwież plan" title="Odśwież plan" disabled={isSyncingPlan}>
                      <FaSyncAlt aria-hidden="true" className={isSyncingPlan ? "fa-spin" : undefined} />
                    </button>
                  </div>
                </div>}
              </div>

              <div className="lecturer-console__calendar-frame">
                {!hasActiveTeacher && isAdminPreviewMode ? (
                  <div className="lecturer-console__empty-state">
                    <strong>Wybierz dydaktyka</strong>
                    <p>
                      Wpisz nazwisko i imię w pasku podglądu, aby wczytać plan
                      zajęć.
                    </p>
                  </div>
                ) : (
                  <FullCalendar
                    ref={calendarRef}
                    plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
                    initialView={effectiveCalendarView}
                    headerToolbar={false}
                    events={calendarEvents}
                    locale={plLocale}
                    firstDay={1}
                    height="100%"
                    allDaySlot={false}
                    nowIndicator
                    dayMaxEvents
                    eventMinHeight={24}
                    slotMinTime="07:00:00"
                    slotMaxTime="21:00:00"
                    eventTimeFormat={{
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }}
                    slotLabelFormat={{
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }}
                    dayHeaderContent={({ date, isToday, view }) => (
                      <div className="lecturer-console__day-heading" data-today={isToday}>
                        <span>{weekdayFormatter.format(date)}</span>
                        {view.type !== "dayGridMonth" && (
                          <strong>{dayFormatter.format(date)}</strong>
                        )}
                      </div>
                    )}
                    eventClick={handleEventClick}
                    eventContent={(content) => <LessonTile content={content} />}
                    datesSet={(info) => {
                      setCalendarTitle(info.view.title);
                      setCurrentDates((current) => {
                        if (
                          current.start === info.startStr &&
                          current.end === info.endStr
                        ) {
                          return current;
                        }

                        return { start: info.startStr, end: info.endStr };
                      });
                    }}
                    eventDidMount={(info) => {
                      info.el.tabIndex = 0;
                      info.el.setAttribute("role", "button");
                      info.el.setAttribute("aria-label", [
                        info.event.title,
                        info.event.start && timeFormatter.format(info.event.start),
                        info.event.extendedProps.room && `Sala ${info.event.extendedProps.room}`,
                        info.event.extendedProps.lesson_form,
                      ].filter(Boolean).join(", "));
                      info.el.addEventListener("keydown", (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          info.el.click();
                        }
                      });
                      const isTouch = "ontouchstart" in window;

                      if (!isTouch) {
                        tippy(info.el, {
                          content: `${info.event.title} • Sala ${String(info.event.extendedProps.room || "-")}`,
                          placement: "top",
                          theme: "light-border",
                        });
                      }
                    }}
                  />
                )}
              </div>
            </section>

            {isDockedLayout ? (
              <>
                <aside
                  ref={dockedPanelRef}
                  className={`lecturer-console__panel-shell lecturer-console__panel-shell--details${
                    selectedLesson ? " lecturer-console__panel-shell--open" : ""
                  }`}
                >
                  {isDoubleDocked && isAttendanceVisible ? attendancePanel : lessonInspector}
                </aside>

                {isTripleDocked ? (
                  <aside
                    className={`lecturer-console__panel-shell lecturer-console__panel-shell--attendance${
                      isAttendanceVisible
                        ? " lecturer-console__panel-shell--open"
                        : ""
                    }`}
                  >
                    {isAttendanceVisible ? attendancePanel : null}
                  </aside>
                ) : null}
              </>
            ) : null}
          </div>
        </main>

        {showOverlay && (
          <dialog ref={overlayRef} className="lecturer-console__overlay" data-placement={isSheetLayout ? "bottom" : "right"}
            aria-label={isAttendanceVisible ? "Lista obecności" : "Szczegóły zajęć"}
            onCancel={(event) => {
              event.preventDefault();
              if (isAttendanceVisible) setIsAttendancePanelOpen(false);
              else clearLessonSelection();
            }}
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              if (isAttendanceVisible) setIsAttendancePanelOpen(false);
              else clearLessonSelection();
            }}>
            {(!isSheetLayout || !isAttendanceVisible) && (
              <aside className="lecturer-console__drawer lecturer-console__drawer--details">{lessonInspector}</aside>
            )}
            {isAttendanceVisible && (
              <aside className="lecturer-console__drawer lecturer-console__drawer--attendance">{attendancePanel}</aside>
            )}
          </dialog>
        )}
      </div>

      {toasts.length > 0 ? (
        <div className="admin-toast-stack lecturer-console__toast-stack" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`admin-toast admin-toast--${toast.tone}`}>
              <p className="admin-toast__message">{toast.message}</p>
              <button
                type="button"
                className="admin-toast__close"
                onClick={() => dismissToast(toast.id)}
                aria-label="Zamknij komunikat"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </WorkspaceLayout>
  );
}
