import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { FaTimes } from "react-icons/fa";
import QrScanner from "qr-scanner";
import {
  extractPairingDeviceId,
  formatPairingDeviceId,
  formatPairingDeviceInput,
  sanitizePairingDeviceId,
} from "./helpers";

interface PairingResult {
  ok: boolean;
  message?: string;
}

interface AdminPairingScannerProps {
  onClose: () => void;
  onPair: (deviceId: string) => Promise<PairingResult>;
}

type PairingMode = "scan" | "manual";

const getScannerErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError") {
      return "Brak zgody na aparat. Użyj pola Kod albo nadaj uprawnienie kamerze.";
    }

    if (error.name === "NotFoundError") {
      return "Nie znaleziono aparatu. Użyj pola Kod.";
    }

    if (error.name === "NotReadableError") {
      return "Aparat jest zajęty przez inną aplikację.";
    }

    if (error.message) {
      return error.message;
    }
  }

  return "Nie udało się uruchomić aparatu.";
};

const AdminPairingScanner = ({
  onClose,
  onPair,
}: AdminPairingScannerProps) => {
  const inputId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const onPairRef = useRef(onPair);
  const modeRef = useRef<PairingMode>("scan");
  const busyRef = useRef(false);
  const resumeTimeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  const [mode, setMode] = useState<PairingMode>("scan");
  const [manualCode, setManualCode] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [cameraRequested, setCameraRequested] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  onPairRef.current = onPair;
  modeRef.current = mode;

  const clearResumeTimeout = () => {
    if (resumeTimeoutRef.current !== null) {
      window.clearTimeout(resumeTimeoutRef.current);
      resumeTimeoutRef.current = null;
    }
  };

  const pauseScanner = async () => {
    clearResumeTimeout();

    if (!scannerRef.current) {
      return;
    }

    try {
      await scannerRef.current.pause();
    } catch {
      // Ignore pause errors during quick mode switches.
    }
  };

  const startScanner = async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;

    try {
      setCameraRequested(true);
      setCameraError(null);
      setIsStarting(true);
      await scanner.start();

      if (!mountedRef.current || scanner !== scannerRef.current || modeRef.current !== "scan") return;

      setIsStarting(false);
      setStatusMessage(null);
    } catch (error) {
      if (!mountedRef.current || scanner !== scannerRef.current || modeRef.current !== "scan") return;

      setIsStarting(false);
      setStatusMessage(null);
      setCameraError(getScannerErrorMessage(error));
    }
  };

  const scheduleScannerResume = () => {
    clearResumeTimeout();

    resumeTimeoutRef.current = window.setTimeout(() => {
      if (!mountedRef.current || busyRef.current || modeRef.current !== "scan") {
        return;
      }

      void startScanner();
    }, 900);
  };

  const submitDeviceValue = async (rawValue: string) => {
    if (busyRef.current) {
      return;
    }

    const deviceId = extractPairingDeviceId(rawValue);
    if (!deviceId) {
      setFeedback("Nie rozpoznano kodu PlanQR.");
      setStatusMessage("Spróbuj ponownie.");
      void pauseScanner();
      scheduleScannerResume();
      return;
    }

    busyRef.current = true;
    setIsProcessing(true);
    setFeedback(null);
    setStatusMessage(`Szukam tabletu ${formatPairingDeviceId(deviceId)}...`);
    await pauseScanner();
    if (!mountedRef.current) return;

    const result = await onPairRef.current(deviceId);

    if (!mountedRef.current) {
      return;
    }

    if (!result.ok) {
      busyRef.current = false;
      setIsProcessing(false);
      setFeedback(result.message || "Nie udało się odnaleźć tabletu.");
      setStatusMessage("Spróbuj ponownie.");

      if (modeRef.current === "scan") {
        scheduleScannerResume();
      }

      return;
    }
  };

  const handleManualSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitDeviceValue(sanitizePairingDeviceId(manualCode));
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      dialog?.close();
    };
  }, []);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return;
    }

    const scanner = new QrScanner(
      videoElement,
      (result) => {
        void submitDeviceValue(result.data);
      },
      {
        preferredCamera: "environment",
        maxScansPerSecond: 12,
        returnDetailedScanResult: true,
        onDecodeError: (error) => {
          if (
            error === QrScanner.NO_QR_CODE_FOUND ||
            (error instanceof Error && error.message === QrScanner.NO_QR_CODE_FOUND)
          ) {
            return;
          }

          console.debug("[AdminPairingScanner] QR decode error:", error);
        },
      },
    );

    scannerRef.current = scanner;

    return () => {
      clearResumeTimeout();
      scanner.destroy();
      scannerRef.current = null;
      busyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
      <dialog
        ref={dialogRef}
        className="admin-pairing-scanner"
        onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}
        onCancel={(event) => { event.preventDefault(); onClose(); }}
        aria-labelledby="admin-pairing-scanner-title"
      >
        <header className="admin-pairing-scanner__header">
          <div>
            <h2 id="admin-pairing-scanner-title" className="admin-pairing-scanner__title">
              Tryb parowania
            </h2>
          </div>
          <button
            type="button"
            className="admin-button admin-button--ghost admin-button--small"
            onClick={onClose}
            aria-label="Wyjdź z trybu parowania"
          >
            <FaTimes aria-hidden="true" /> Zamknij
          </button>
        </header>

        <div className="admin-pairing-scanner__body">
          <div className="admin-pairing-scanner__camera" hidden={mode === "manual"}>
            <video
              ref={videoRef}
              className="admin-pairing-scanner__video"
              muted
              playsInline
            />
            <div className="admin-pairing-scanner__frame" aria-hidden="true" />

            {isStarting && mode === "scan" ? (
              <div className="admin-pairing-scanner__camera-state">
                <div className="loading-spinner" />
                <p>Uruchamianie aparatu...</p>
              </div>
            ) : null}

            {(!cameraRequested || cameraError) && !isStarting && mode === "scan" ? (
              <div className="admin-pairing-scanner__camera-state">
                {cameraError && <p role="status">{cameraError}</p>}
                <button type="button" className="admin-button admin-button--primary" onClick={() => void startScanner()}>
                  {cameraError ? "Spróbuj ponownie" : "Włącz aparat"}
                </button>
              </div>
            ) : null}
          </div>

          {statusMessage || feedback || mode === "manual" ? (
            <div className="admin-pairing-scanner__panel">
              {statusMessage ? (
                <p className="admin-pairing-scanner__status" aria-live="polite">
                  {statusMessage}
                </p>
              ) : null}

              {feedback ? (
                <p className="admin-feedback admin-feedback--warning admin-pairing-scanner__feedback">
                  {feedback}
                </p>
              ) : null}

              {mode === "manual" ? (
                <form className="admin-pairing-scanner__manual" onSubmit={handleManualSubmit}>
                  <label className="admin-form-field" htmlFor={inputId}>
                    <span className="admin-form-field__label">Kod tabletu</span>
                    <input
                      id={inputId}
                      className="admin-form-field__input"
                      inputMode="numeric"
                      placeholder="np. 123 456"
                      value={manualCode}
                      onChange={(event) => {
                        setManualCode(formatPairingDeviceInput(event.target.value));
                        setFeedback(null);
                        setStatusMessage(null);
                      }}
                      autoFocus
                    />
                  </label>
                  <button
                    type="submit"
                    className="admin-button admin-button--primary"
                    disabled={isProcessing || !sanitizePairingDeviceId(manualCode)}
                  >
                    {isProcessing ? "Szukam..." : "Dalej"}
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="admin-pairing-scanner__footer">
          <button
            type="button"
            className="admin-button admin-button--ghost"
            onClick={onClose}
          >
            Wyjdź
          </button>
          <button
            type="button"
            className="admin-button admin-button--secondary"
            onClick={() => {
              setFeedback(null);
              setStatusMessage(null);
              setIsStarting(false);
              setCameraRequested(false);
              setCameraError(null);
              void pauseScanner();
              setMode((current) => (current === "scan" ? "manual" : "scan"));
            }}
            disabled={isProcessing}
          >
            {mode === "scan" ? "Kod" : "Aparat"}
          </button>
        </footer>
      </dialog>
  );
};

export default AdminPairingScanner;
