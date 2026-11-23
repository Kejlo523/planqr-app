import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { PlanQrBrand } from "./WorkspaceHeader";
import { FaArrowRight } from "react-icons/fa";
import ThemeToggle from "./ThemeToggle";
import "./LoginPanel.css";
import { fetchSession, getPreferredRoute } from "../services/authService";

type LoginErrorPayload = {
  code?: string;
  message?: string;
};

const getLoginErrorMessage = (status: number, data: LoginErrorPayload | null) => {
  switch (data?.code) {
    case "INVALID_CREDENTIALS":
      return "Nieprawidłowy login lub hasło.";
    case "LDAP_TIMEOUT":
      return "Serwer LDAP nie odpowiedział na czas. Spróbuj ponownie za chwilę.";
    case "LDAP_UNAVAILABLE":
      return "Serwer LDAP jest obecnie niedostępny. Spróbuj ponownie za chwilę.";
    case "AUTH_ERROR":
      return "Wystąpił błąd podczas logowania. Spróbuj ponownie.";
    default:
      break;
  }

  if (status === 401) {
    return "Nieprawidłowy login lub hasło.";
  }

  if (status === 403) {
    return data?.message || "To konto nie ma dostępu do PlanQR.";
  }

  if (typeof data?.message === "string" && data.message.trim()) {
    return data.message;
  }

  return "Wystąpił błąd podczas logowania. Spróbuj ponownie.";
};

export default function LoginPanel() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const checkLoginStatus = async () => {
      const session = await fetchSession();
      const preferredRoute = getPreferredRoute(session);

      if (preferredRoute) {
        navigate(preferredRoute);
      }
    };

    void checkLoginStatus();
  }, [navigate]);

  useEffect(() => {
    document.documentElement.classList.add("login-scroll-root");
    document.body.classList.add("login-scroll-root");

    return () => {
      document.documentElement.classList.remove("login-scroll-root");
      document.body.classList.remove("login-scroll-root");
    };
  }, []);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    let scrollTimeout = 0;

    const scrollActiveFieldIntoView = () => {
      window.clearTimeout(scrollTimeout);
      scrollTimeout = window.setTimeout(() => {
        const activeElement = document.activeElement;

        if (!(activeElement instanceof HTMLElement)) {
          return;
        }

        if (!formRef.current?.contains(activeElement)) {
          return;
        }

        activeElement.scrollIntoView({
          block: "center",
          inline: "nearest",
        });
      }, 250);
    };

    const viewport = window.visualViewport;

    scrollActiveFieldIntoView();
    viewport?.addEventListener("resize", scrollActiveFieldIntoView);

    return () => {
      window.clearTimeout(scrollTimeout);
      viewport?.removeEventListener("resize", scrollActiveFieldIntoView);
    };
  }, [isEditing]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage("");
    setSubmitting(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: login, password }),
        credentials: "include",
      });

      const data = await response.json().catch(() => null);

      if (response.ok) {
        const preferredRoute = getPreferredRoute(data);
        if (preferredRoute) {
          navigate(preferredRoute);
          return;
        }

        setErrorMessage("Konto nie ma przypisanego panelu PlanQR.");
        return;
      }

      setErrorMessage(getLoginErrorMessage(response.status, data));
    } catch (error) {
      console.error("Error during login:", error);
      setErrorMessage("Wystąpił błąd podczas logowania. Spróbuj ponownie.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-panel">
      <aside className="login-panel__introduction">
        <div className="login-panel__institution">Zachodniopomorski Uniwersytet Technologiczny w Szczecinie</div>
        <p className="login-panel__statement">Plan zajęć.<br />Sale i obecność.</p>
      </aside>
      <section className="login-panel__workspace">
        <header className="login-panel__bar">
          <PlanQrBrand />
          <ThemeToggle />
        </header>
        <form
          ref={formRef}
          className="login-panel__form"
          onSubmit={handleSubmit}
          onFocusCapture={() => setIsEditing(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setIsEditing(false);
          }}
        >
          <h1>Zaloguj się</h1>
          <p>Użyj danych konta uczelnianego ZUT.</p>
          <label className="login-panel__field">
            Login uczelniany
            <input
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={login}
              onChange={(event) => setLogin(event.target.value)}
            />
          </label>
          <label className="login-panel__field">
            Hasło
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {errorMessage && <p className="login-panel__error" role="alert">{errorMessage}</p>}
          <button type="submit" className="login-panel__btn" disabled={isSubmitting}>
            {isSubmitting ? "Logowanie…" : "Zaloguj"} <FaArrowRight aria-hidden="true" />
          </button>
        </form>
      </section>
    </main>
  );
}
