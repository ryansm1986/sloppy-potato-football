import path from "node:path";
import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";
import type { DesktopSettings, RunnerStatus } from "../shared/contracts.js";
import { getTrayPresentation } from "./tray-model.js";

// A tiny embedded PNG keeps the shell functional if a development asset is missing.
const FALLBACK_ICON =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIUlEQVR42mP8z8Dwn4ECwESJ5lEDRg0YNYChYwYGBoYBAF8HAxV7h8WAAAAAAElFTkSuQmCC";

export interface TrayActions {
  showWindow(): void;
  openSchedules(): void;
  startRunner(): Promise<void>;
  pauseRunner(): Promise<void>;
  resumeRunner(): Promise<void>;
  runNext(): Promise<void>;
  setLaunchAtStartup(enabled: boolean): Promise<void>;
  quit(): void;
}

export class DesktopTray {
  private readonly tray: Tray;
  private status: RunnerStatus = { state: "offline", queuedJobs: 0 };
  private settings: DesktopSettings;

  constructor(settings: DesktopSettings, private readonly actions: TrayActions) {
    this.settings = settings;
    const brandedImage = nativeImage.createFromPath(
      path.join(app.getAppPath(), "dist-desktop", "sloppy-potato-icon.png"),
    );
    const sourceImage = brandedImage.isEmpty()
      ? nativeImage.createFromBuffer(Buffer.from(FALLBACK_ICON, "base64"))
      : brandedImage;
    const image = sourceImage.resize({
      width: 16,
      height: 16,
    });
    this.tray = new Tray(image);
    this.tray.on("double-click", () => actions.showWindow());
    this.rebuild();
  }

  updateStatus(status: RunnerStatus): void {
    this.status = status;
    this.rebuild();
  }

  updateSettings(settings: DesktopSettings): void {
    this.settings = settings;
    this.rebuild();
  }

  destroy(): void {
    this.tray.destroy();
  }

  private rebuild(): void {
    const presentation = getTrayPresentation(this.status);
    const primaryClick = {
      start: this.actions.startRunner,
      pause: this.actions.pauseRunner,
      resume: this.actions.resumeRunner,
    }[presentation.primaryAction];

    const template: MenuItemConstructorOptions[] = [
      { label: "Sloppy Potato Fantasy Football", enabled: false },
      { label: presentation.statusLabel, enabled: false },
      { type: "separator" },
      { label: "Open app", click: () => this.actions.showWindow() },
      {
        label: "Run next research job now",
        enabled: presentation.canRunNext,
        click: () => void this.actions.runNext(),
      },
      { label: presentation.primaryLabel, click: () => void primaryClick() },
      { label: "Research schedules…", click: () => this.actions.openSchedules() },
      { type: "separator" },
      {
        label: "Launch when Windows starts",
        type: "checkbox",
        checked: this.settings.launchAtStartup,
        click: (item) => void this.actions.setLaunchAtStartup(item.checked),
      },
      { type: "separator" },
      { label: "Quit", click: () => this.actions.quit() },
    ];

    this.tray.setToolTip(presentation.tooltip);
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
