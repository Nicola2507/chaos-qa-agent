import { randomUUID } from "crypto";
import type { Page, Request, Response, ConsoleMessage } from "playwright";
import type { TelemetryIncident } from "@/types/chaos";

const BENIGN_ABORT_HINTS = [
  "analytics",
  "google-analytics",
  "googletagmanager",
  "doubleclick",
  "facebook.net",
  "hotjar",
  "segment.io",
  "sentry.io",
  "/collect",
  "pixel",
];

function isBenignAborted(url: string, errorText: string): boolean {
  if (!errorText.includes("ERR_ABORTED") && !errorText.includes("net::ERR_ABORTED")) {
    return false;
  }
  const lower = url.toLowerCase();
  return BENIGN_ABORT_HINTS.some((hint) => lower.includes(hint));
}

function isImageLike(url: string, resourceType: string): boolean {
  if (resourceType === "image") return true;
  return /\.(png|jpe?g|gif|webp|svg|ico)(\?|$)/i.test(url);
}

export class TelemetryRecorder {
  private incidents: TelemetryIncident[] = [];
  private currentStep = 0;
  private requestStartedAt = new WeakMap<Request, number>();
  private attached = false;

  constructor(private readonly page: Page) {
    this.attach();
  }

  setStep(step: number): void {
    this.currentStep = step;
  }

  private push(
    partial: Omit<TelemetryIncident, "id" | "step" | "timestamp" | "url"> & {
      url?: string;
      timestamp?: number;
      step?: number;
    },
  ): void {
    this.incidents.push({
      id: randomUUID(),
      step: partial.step ?? this.currentStep,
      timestamp: partial.timestamp ?? Date.now(),
      type: partial.type,
      severity: partial.severity,
      message: partial.message,
      ...(partial.details ? { details: partial.details } : {}),
      url: partial.url ?? this.safeUrl(),
      ...(partial.screenshotUrl ? { screenshotUrl: partial.screenshotUrl } : {}),
    });
  }

  private safeUrl(): string {
    try {
      return this.page.url();
    } catch {
      return "";
    }
  }

  private attach(): void {
    if (this.attached) return;
    this.attached = true;

    this.page.on("pageerror", (error: Error) => {
      this.push({
        type: "PAGE_ERROR",
        severity: "HIGH",
        message: error.message || String(error),
        details: error.stack,
      });
    });

    this.page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      this.push({
        type: "CONSOLE_ERROR",
        severity: "MEDIUM",
        message: msg.text(),
      });
    });

    this.page.on("request", (request: Request) => {
      this.requestStartedAt.set(request, Date.now());
    });

    this.page.on("response", (response: Response) => {
      const request = response.request();
      const resourceType = request.resourceType();
      const tracked =
        resourceType === "fetch" ||
        resourceType === "xhr" ||
        resourceType === "document";

      const startedAt = this.requestStartedAt.get(request);
      const durationMs = startedAt != null ? Date.now() - startedAt : undefined;
      const status = response.status();

      if (tracked && status >= 400) {
        this.push({
          type: "NETWORK_ERROR",
          severity: status >= 500 ? "HIGH" : "MEDIUM",
          message: `HTTP ${status} on ${request.method()} ${response.url()}`,
          details:
            durationMs != null
              ? `resourceType=${resourceType}; durationMs=${durationMs}`
              : `resourceType=${resourceType}`,
          url: response.url(),
        });
      }

      if (tracked && durationMs != null && durationMs > 3500) {
        this.push({
          type: "SLOW_API",
          severity: "LOW",
          message: `Slow ${request.method()} ${response.url()} took ${durationMs}ms`,
          details: `status=${status}`,
          url: response.url(),
        });
      }
    });

    this.page.on("requestfailed", (request: Request) => {
      const failure = request.failure();
      const errorText = failure?.errorText ?? "unknown";
      const url = request.url();
      const resourceType = request.resourceType();

      if (isBenignAborted(url, errorText)) return;
      if (
        (errorText.includes("ERR_ABORTED") ||
          errorText.includes("net::ERR_ABORTED")) &&
        isImageLike(url, resourceType)
      ) {
        return;
      }

      this.push({
        type: "NETWORK_ERROR",
        severity: "MEDIUM",
        message: `${request.method()} ${url} failed: ${errorText}`,
        details: `resourceType=${resourceType}`,
        url,
      });
    });
  }

  addCustomIncident(
    incident: Omit<TelemetryIncident, "id" | "timestamp"> & {
      id?: string;
      timestamp?: number;
    },
  ): void {
    this.incidents.push({
      id: incident.id ?? randomUUID(),
      step: incident.step,
      timestamp: incident.timestamp ?? Date.now(),
      type: incident.type,
      severity: incident.severity,
      message: incident.message,
      ...(incident.details ? { details: incident.details } : {}),
      url: incident.url,
      ...(incident.screenshotUrl
        ? { screenshotUrl: incident.screenshotUrl }
        : {}),
    });
  }

  getStepIncidents(step: number): TelemetryIncident[] {
    return this.incidents.filter((incident) => incident.step === step);
  }

  getAllIncidents(): TelemetryIncident[] {
    return [...this.incidents];
  }
}
