import { Notification } from "electron";
import type { DesktopSettings, RunnerStatus } from "../shared/contracts.js";

export class RunnerNotifier {
  private previous: RunnerStatus = { state: "offline", queuedJobs: 0 };

  constructor(private readonly getSettings: () => DesktopSettings) {}

  handleStatus(status: RunnerStatus): void {
    const finishedJob = this.previous.currentJob;
    const completed =
      this.previous.state === "running" &&
      Boolean(finishedJob) &&
      (status.state === "idle" || status.state === "paused");
    this.previous = status;

    if (!completed || !this.getSettings().notificationsEnabled || !Notification.isSupported()) return;
    new Notification({
      title: "Research complete",
      body: `${finishedJob!.label} is ready in Sloppy Potato.`,
      silent: false,
    }).show();
  }

  showError(message: string): void {
    if (!this.getSettings().notificationsEnabled || !Notification.isSupported()) return;
    new Notification({ title: "Sloppy Potato needs attention", body: message }).show();
  }
}
