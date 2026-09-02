import type { RunnerState, RunnerStatus } from "../shared/contracts.js";

export interface TrayPresentation {
  statusLabel: string;
  tooltip: string;
  primaryAction: "start" | "pause" | "resume";
  primaryLabel: string;
  canRunNext: boolean;
}

const stateLabels: Record<RunnerState, string> = {
  offline: "Offline",
  starting: "Starting…",
  idle: "Online · Idle",
  running: "Researching",
  pausing: "Pausing after current job…",
  paused: "Paused",
  stopping: "Stopping…",
  error: "Needs attention",
};

export function getTrayPresentation(status: RunnerStatus): TrayPresentation {
  const stateLabel = stateLabels[status.state];
  const jobSuffix = status.currentJob?.label ? ` · ${status.currentJob.label}` : "";
  if (status.state === "running" || status.state === "pausing") {
    return {
      statusLabel: `${stateLabel}${jobSuffix}`,
      tooltip: `Sloppy Potato · ${stateLabel}`,
      primaryAction: "pause",
      primaryLabel: status.state === "pausing" ? "Pause requested" : "Pause after current job",
      canRunNext: false,
    };
  }
  if (status.state === "paused") {
    return {
      statusLabel: stateLabel,
      tooltip: "Sloppy Potato · Paused",
      primaryAction: "resume",
      primaryLabel: "Resume runner",
      canRunNext: false,
    };
  }
  return {
    statusLabel: `${stateLabel}${jobSuffix}`,
    tooltip: `Sloppy Potato · ${stateLabel}`,
    primaryAction: "start",
    primaryLabel: status.state === "idle" ? "Runner is online" : "Start runner",
    canRunNext: status.state === "idle",
  };
}
