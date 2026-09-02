import { AlertTriangle, Download, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { DesktopUpdateStatus } from "../../../desktop/shared/contracts";

const actionablePhases = new Set<DesktopUpdateStatus["phase"]>([
  "idle",
  "checking",
  "available",
  "downloading",
  "ready",
  "error",
]);

function updateLabel(status: DesktopUpdateStatus, invoking: boolean) {
  const version = status.availableVersion ? ` v${status.availableVersion.replace(/^v/i, "")}` : "";

  if (status.phase === "idle") {
    return invoking ? "Checking for updates…" : "Check for updates";
  }
  if (status.phase === "checking") return "Checking for updates…";
  if (status.phase === "available") {
    return invoking ? "Starting download..." : `Update${version} available`;
  }
  if (status.phase === "downloading") {
    const percent = Math.round(Math.min(100, Math.max(0, status.downloadPercent ?? 0)));
    return `Downloading update - ${percent}%`;
  }
  if (status.phase === "ready") {
    return invoking ? "Restarting to install..." : `Restart to install${version}`;
  }
  return invoking ? "Checking again..." : "Update failed - Retry";
}

function updateDescription(status: DesktopUpdateStatus) {
  if (status.phase === "idle") return "Look for a newer desktop version";
  if (status.phase === "checking") return "Looking for a newer desktop version";
  if (status.phase === "available") return "Download the update";
  if (status.phase === "downloading") return "The update is downloading";
  if (status.phase === "ready") return "Restart Sloppy Potato to finish installing the update";
  return "Check for the update again";
}

function UpdateIcon({ status }: { status: DesktopUpdateStatus }) {
  if (status.phase === "checking" || status.phase === "downloading") return <LoaderCircle aria-hidden="true" className="spin" size={17} />;
  if (status.phase === "idle") return <RefreshCw aria-hidden="true" size={17} />;
  if (status.phase === "ready") return <RotateCcw aria-hidden="true" size={17} />;
  if (status.phase === "error") return <AlertTriangle aria-hidden="true" size={17} />;
  return <Download aria-hidden="true" size={17} />;
}

export default function DesktopUpdateControl() {
  const updates = window.sloppyPotatoDesktop?.updates;
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [invoking, setInvoking] = useState(false);

  useEffect(() => {
    if (!updates) return undefined;

    let mounted = true;
    const unsubscribe = updates.onStatus((nextStatus) => {
      if (mounted) {
        setStatus(nextStatus);
        setInvoking(false);
      }
    });

    void updates.status()
      .then((nextStatus) => {
        if (mounted) setStatus(nextStatus);
      })
      .catch(() => {
        if (mounted) {
          setStatus({
            phase: "error",
            currentVersion: "",
            message: "The desktop app could not read update status.",
          });
        }
      });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [updates]);

  if (!updates || !status || !actionablePhases.has(status.phase)) return null;

  const label = updateLabel(status, invoking);
  const description = updateDescription(status);
  const disabled = invoking || status.phase === "checking" || status.phase === "downloading";

  async function handleClick() {
    const updater = updates;
    if (disabled || !status || !updater) return;
    const currentStatus = status;
    setInvoking(true);

    try {
      const nextStatus = currentStatus.phase === "available"
        ? await updater.download()
        : currentStatus.phase === "ready"
          ? await updater.restart()
          : await updater.check();
      if (nextStatus) setStatus(nextStatus);
    } catch {
      setStatus({
        ...currentStatus,
        phase: "error",
        message: "The update action failed. Try again.",
      });
    } finally {
      setInvoking(false);
    }
  }

  return (
    <button
      aria-label={`${label}. ${description}`}
      className={`desktop-update desktop-update--${status.phase}`}
      disabled={disabled}
      onClick={() => void handleClick()}
      title={`${label}. ${description}.`}
      type="button"
    >
      <span className="desktop-update__icon">
        <UpdateIcon status={status} />
      </span>
      {status.phase !== "idle" && (
        <span className="desktop-update__copy" role="status" aria-live="polite">
          <strong>{label}</strong>
          <small>{description}</small>
        </span>
      )}
      {status.phase === "downloading" && (
        <span
          aria-hidden="true"
          className="desktop-update__progress"
          style={{ "--desktop-update-progress": `${Math.min(100, Math.max(0, status.downloadPercent ?? 0))}%` } as CSSProperties}
        />
      )}
    </button>
  );
}
