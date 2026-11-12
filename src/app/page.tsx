"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  Loader2,
  Monitor,
  Play,
  Radio,
  ShieldAlert,
  Terminal,
  X,
} from "lucide-react";
import type {
  CrashReport,
  StepRecord,
  TelemetryIncident,
} from "@/types/chaos";

type RunStatus = "idle" | "running" | "complete" | "error";

type StreamEvent = {
  type: string;
  data: unknown;
};

const PRESETS = [
  {
    label: "E-Commerce Guest Checkout",
    url: "https://books.toscrape.com",
    mission:
      "Browse as a guest, open a product, and try to complete add-to-basket / checkout-adjacent flows. Hunt for dead clicks, broken CTAs, and mobile layout bleed.",
  },
  {
    label: "Chaos Form & Diacritics Fuzzer",
    url: "https://books.toscrape.com",
    mission:
      "Find every visible form/input and fuzz with Romanian diacritics (ăâîșț), long unicode, odd phone formats, and coupon-like codes. Report validation and crash failures.",
  },
  {
    label: "Mobile Dead-Click & Layout Auditor",
    url: "https://books.toscrape.com",
    mission:
      "Systematically tap interactive elements on a 390x844 viewport. Detect dead clicks, horizontal overflow, broken images, and overlapping overlays.",
  },
] as const;

function parseSseChunk(
  chunk: string,
  onEvent: (event: StreamEvent) => void,
): string {
  const parts = chunk.split("\n\n");
  const remainder = parts.pop() ?? "";

  for (const part of parts) {
    if (!part.trim()) continue;
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) continue;
    try {
      onEvent(JSON.parse(dataLines.join("\n")) as StreamEvent);
    } catch {
      /* ignore malformed chunks */
    }
  }

  return remainder;
}

function severityClass(severity: TelemetryIncident["severity"]): string {
  if (severity === "HIGH") return "border-red-500/40 bg-red-500/10 text-red-300";
  if (severity === "MEDIUM")
    return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  return "border-zinc-600 bg-zinc-800/60 text-zinc-300";
}

export default function HomePage() {
  const [url, setUrl] = useState<string>(PRESETS[0].url);
  const [mission, setMission] = useState<string>(PRESETS[0].mission);
  const [maxSteps, setMaxSteps] = useState(8);
  const [headless, setHeadless] = useState(true);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("Ready to hunt.");
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [incidents, setIncidents] = useState<TelemetryIncident[]>([]);
  const [report, setReport] = useState<CrashReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState(0);
  const [thinkingShot, setThinkingShot] = useState<string | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const activeStep = useMemo(() => {
    if (steps.length === 0) return null;
    const index = Math.min(Math.max(selectedStep, 0), steps.length - 1);
    return steps[index] ?? null;
  }, [steps, selectedStep]);

  useEffect(() => {
    if (steps.length > 0) {
      setSelectedStep(steps.length - 1);
    }
  }, [steps.length]);

  const liveIncidents = useMemo(() => {
    if (report) return report.incidents;
    return incidents;
  }, [incidents, report]);

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    if (status === "running") return;
    setUrl(preset.url);
    setMission(preset.mission);
  };

  const startHunt = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus("running");
    setStatusMessage("Connecting to agent…");
    setSteps([]);
    setIncidents([]);
    setReport(null);
    setError(null);
    setThinkingShot(null);
    setSelectedStep(0);
    setSpecOpen(false);

    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, mission, maxSteps, headless }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          (payload && typeof payload.error === "string"
            ? payload.error
            : `Request failed (${response.status})`) as string,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseChunk(buffer, (event) => {
          if (event.type === "status" && event.data && typeof event.data === "object") {
            const msg = (event.data as { message?: string }).message;
            if (msg) setStatusMessage(msg);
            return;
          }

          if (event.type === "thinking" && event.data && typeof event.data === "object") {
            const data = event.data as { step?: number; screenshotUrl?: string };
            if (data.screenshotUrl) setThinkingShot(data.screenshotUrl);
            if (data.step != null) {
              setStatusMessage(`Step ${data.step}: Grok is reasoning…`);
            }
            return;
          }

          if (event.type === "step" && event.data && typeof event.data === "object") {
            const step = event.data as StepRecord;
            setSteps((prev) => [...prev, step]);
            setThinkingShot(step.screenshotUrl);
            setStatusMessage(
              `Step ${step.step}: ${step.decision.action}${
                step.decision.targetMarkId != null
                  ? ` [#${step.decision.targetMarkId}]`
                  : ""
              }`,
            );
            if (step.incidentsTriggered.length > 0) {
              setIncidents((prev) => [...prev, ...step.incidentsTriggered]);
            }
            return;
          }

          if (event.type === "complete" && event.data && typeof event.data === "object") {
            const complete = event.data as CrashReport;
            setReport(complete);
            setIncidents(complete.incidents);
            setSteps(complete.steps);
            setStatus("complete");
            setStatusMessage(`Mission finished — ${complete.status}`);
            return;
          }

          if (event.type === "error" && event.data && typeof event.data === "object") {
            const message =
              typeof (event.data as { message?: unknown }).message === "string"
                ? (event.data as { message: string }).message
                : "Mission failed";
            setError(message);
            setStatus("error");
            setStatusMessage(message);
          }
        });
      }

      setStatus((current) => (current === "running" ? "complete" : current));
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Mission failed";
      setError(message);
      setStatus("error");
      setStatusMessage(message);
    }
  }, [url, mission, maxSteps, headless]);

  const viewportSrc =
    status === "complete" && report?.videoUrl
      ? report.videoUrl
      : activeStep?.screenshotUrl || thinkingShot;

  const copySpec = async () => {
    if (!report?.playwrightSpecCode) return;
    await navigator.clipboard.writeText(report.playwrightSpecCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadSpec = () => {
    if (!report?.playwrightSpecCode) return;
    const blob = new Blob([report.playwrightSpecCode], {
      type: "text/typescript;charset=utf-8",
    });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = "chaos-regression.spec.ts";
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(239,68,68,0.12),_transparent_45%),radial-gradient(ellipse_at_bottom_right,_rgba(39,39,42,0.55),_transparent_40%)]" />

      <main className="relative mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
        <header className="flex flex-col gap-4 border-b border-zinc-800 pb-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="mb-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.22em] text-red-400">
              <Radio className="h-3.5 w-3.5 shrink-0" />
              <span>Mission Control</span>
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              CHAOS QA // Autonomous Bug-Hunter Agent
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
                status === "running"
                  ? "border-red-500/40 bg-red-500/10 text-red-300"
                  : status === "error"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : status === "complete"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                      : "border-zinc-700 bg-zinc-900 text-zinc-400"
              }`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
              <span className="font-semibold tracking-wide">
                {status.toUpperCase()}
              </span>
              <span className="text-zinc-500">•</span>
              <span className="font-normal text-zinc-300">{statusMessage}</span>
            </span>
          </div>
        </header>

        <section className="flex flex-wrap gap-3">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={status === "running"}
              onClick={() => applyPreset(preset)}
              className="rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-red-500/50 hover:text-white disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
        </section>

        <section className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-950/80 p-4 lg:grid-cols-[1.2fr_1.6fr_auto]">
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-zinc-400">Target URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={status === "running"}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none ring-red-500/40 focus:ring-2 disabled:opacity-60"
              placeholder="https://your-app.com"
            />
          </label>

          <label className="flex flex-col gap-2 text-sm lg:row-span-2">
            <span className="text-zinc-400">Mission</span>
            <textarea
              value={mission}
              onChange={(e) => setMission(e.target.value)}
              disabled={status === "running"}
              rows={4}
              className="min-h-[108px] resize-y rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none ring-red-500/40 focus:ring-2 disabled:opacity-60"
            />
          </label>

          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-2 text-sm">
              <span className="text-zinc-400">Max Steps</span>
              <select
                value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
                disabled={status === "running"}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none ring-red-500/40 focus:ring-2 disabled:opacity-60"
              >
                <option value={5}>5</option>
                <option value={8}>8</option>
                <option value={10}>10</option>
                <option value={15}>15</option>
              </select>
            </label>

            <label className="flex items-start gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={!headless}
                onChange={(e) => setHeadless(!e.target.checked)}
                disabled={status === "running"}
                className="mt-0.5"
              />
              <span className="inline-flex items-center gap-1.5">
                <Monitor className="h-3.5 w-3.5 shrink-0" />
                <span>Show Live Browser Window on Desktop (`headless: false`)</span>
              </span>
            </label>

            <button
              type="button"
              onClick={startHunt}
              disabled={status === "running" || !url.trim() || !mission.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-red-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "running" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              <span>{status === "running" ? "Hunting…" : "Launch Chaos Agent"}</span>
            </button>
          </div>
        </section>

        {error ? (
          <div className="inline-flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <section className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
          {/* Phone Frame — Left */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 lg:col-span-4">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3 text-sm">
              <span className="font-medium text-zinc-200">
                Live iPhone 14 Viewport
              </span>
              <span className="font-mono text-xs text-zinc-500">390×844</span>
            </div>

            <div className="flex justify-center px-4 py-5">
              <div className="mx-auto flex h-[660px] w-[320px] items-center justify-center overflow-hidden rounded-[32px] border-4 border-zinc-800 bg-black shadow-2xl">
                {status === "complete" && report?.videoUrl ? (
                  <video
                    key={report.videoUrl}
                    controls
                    playsInline
                    className="h-full w-full object-contain"
                    src={report.videoUrl}
                  />
                ) : viewportSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={viewportSrc}
                    alt={
                      activeStep
                        ? `Step ${activeStep.step} Set-of-Mark screenshot`
                        : "Live Set-of-Mark screenshot"
                    }
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="px-6 text-center text-sm text-zinc-500">
                    Annotated screenshots stream here once the hunt starts.
                  </div>
                )}
              </div>
            </div>

            {steps.length > 0 ? (
              <div className="border-t border-zinc-800 px-4 py-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-zinc-500">
                  <span>Step Scrubber</span>
                  <span className="font-mono">
                    ({activeStep ? activeStep.step : 0} / {steps.length})
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(steps.length - 1, 0)}
                  value={selectedStep}
                  onChange={(e) => setSelectedStep(Number(e.target.value))}
                  className="w-full accent-red-500"
                />
              </div>
            ) : null}
          </div>

          {/* Grok Reasoning — Center */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 lg:col-span-4">
            <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-200">
              <Terminal className="h-4 w-4 shrink-0 text-red-400" />
              <span>Grok Reasoning & Step Stream</span>
            </div>
            <div className="max-h-[720px] space-y-3 overflow-y-auto p-4">
              {steps.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  Waiting for the first agent step…
                </p>
              ) : (
                [...steps].reverse().map((step) => (
                  <article
                    key={`${step.step}-${step.timestamp}`}
                    className={`rounded-lg border p-3 ${
                      activeStep?.step === step.step
                        ? "border-red-500/40 bg-zinc-900/80"
                        : "border-zinc-800/80 bg-zinc-900/40"
                    }`}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
                      <span className="rounded-full border border-zinc-700 px-3 py-1.5 font-mono text-red-300">
                        step {step.step}
                      </span>
                      <span className="rounded-full bg-zinc-800 px-3 py-1.5 font-mono text-zinc-200">
                        {step.decision.action}
                        {step.decision.targetMarkId != null
                          ? ` #${step.decision.targetMarkId}`
                          : ""}
                      </span>
                      {step.targetElement?.stableSelector ? (
                        <span className="max-w-full truncate rounded-full border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-[11px] text-cyan-300">
                          {step.targetElement.stableSelector}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm leading-relaxed text-zinc-200">
                      {step.decision.thought}
                    </p>
                    {step.decision.visualBugDetected ? (
                      <p className="mt-2 text-xs text-amber-300">
                        Visual bug: {step.decision.visualBugDetected}
                      </p>
                    ) : null}
                    {step.incidentsTriggered.length > 0 ? (
                      <p className="mt-2 text-xs text-red-300">
                        {step.incidentsTriggered.length} incident(s) on this step
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-emerald-400/80">
                        No new bugs this step
                      </p>
                    )}
                  </article>
                ))
              )}
            </div>
          </div>

          {/* Incident Feed — Right */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 lg:col-span-4">
            <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-200">
              <Bug className="h-4 w-4 shrink-0 text-red-400" />
              <span>Black-Box Incident Feed</span>
              <span className="ml-auto rounded-full border border-zinc-700 px-3 py-1.5 font-mono text-xs text-zinc-500">
                {liveIncidents.length}
              </span>
            </div>
            <div className="max-h-[720px] space-y-2 overflow-y-auto p-4">
              {liveIncidents.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  Dead clicks, network errors, console crashes, layout bleed, and
                  visual bugs appear here in real time.
                </p>
              ) : (
                [...liveIncidents].reverse().map((incident) => (
                  <div
                    key={incident.id}
                    className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-3 text-xs">
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-red-400" />
                      <span className="font-mono text-red-300">
                        {incident.type}
                      </span>
                      <span
                        className={`rounded-full border px-3 py-1.5 ${severityClass(incident.severity)}`}
                      >
                        {incident.severity}
                      </span>
                      <span className="rounded-full border border-zinc-700 px-3 py-1.5 text-zinc-500">
                        step {incident.step}
                      </span>
                    </div>
                    <p className="break-words text-sm text-zinc-300">
                      {incident.message}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {status === "complete" && report ? (
          <section className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/90 p-4">
            <Link
              href={`/report/${report.runId}`}
              className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-red-500/60 hover:bg-zinc-800"
            >
              <Eye className="h-4 w-4 shrink-0" />
              <span>
                Open Shareable Client Crash Report (`/report/{report.runId}`)
              </span>
            </Link>
            <button
              type="button"
              onClick={() => setSpecOpen(true)}
              className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-cyan-500/60 hover:bg-zinc-800"
            >
              <Download className="h-4 w-4 shrink-0" />
              <span>View / Download `.spec.ts` Playwright Test</span>
            </button>
            <span className="inline-flex items-center gap-2 text-xs text-zinc-500">
              <span>{report.incidents.length} bugs</span>
              <span>•</span>
              <span>{report.steps.length} steps</span>
              <span>•</span>
              <span>{report.status}</span>
            </span>
          </section>
        ) : null}
      </main>

      {specOpen && report ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
              <h2 className="text-sm font-medium text-zinc-100">
                chaos-regression.spec.ts
              </h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={copySpec}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900"
                >
                  {copied ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </button>
                <button
                  type="button"
                  onClick={downloadSpec}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Download</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSpecOpen(false)}
                  className="rounded-md border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <pre className="overflow-auto p-4 font-mono text-xs leading-relaxed text-emerald-200">
              <code>{report.playwrightSpecCode}</code>
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
