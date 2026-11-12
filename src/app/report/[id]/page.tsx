"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Bug,
  CheckCircle2,
  ClipboardCopy,
  Code2,
  Download,
  Film,
  Gauge,
  Loader2,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import type { CrashReport, StepRecord } from "@/types/chaos";

type TabId = "replay" | "handoff";

function metricCard(label: string, value: string | number, tone?: string) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-zinc-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${tone ?? "text-white"}`}>
        {value}
      </p>
    </div>
  );
}

export default function CrashReportPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [report, setReport] = useState<CrashReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>("replay");
  const [selectedStep, setSelectedStep] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/report/${id}`);
        if (!res.ok) {
          throw new Error(
            res.status === 404 ? "Report not found" : `Failed to load report (${res.status})`,
          );
        }
        const data = (await res.json()) as CrashReport;
        if (!cancelled) {
          setReport(data);
          setSelectedStep(0);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load report");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const activeStep: StepRecord | null = useMemo(() => {
    if (!report || report.steps.length === 0) return null;
    return report.steps[Math.min(selectedStep, report.steps.length - 1)] ?? null;
  }, [report, selectedStep]);

  const scores = useMemo(() => {
    if (!report) {
      return { total: 0, dead: 0, network: 0, layoutVisual: 0 };
    }
    const total = report.incidents.length;
    const dead = report.incidents.filter((i) => i.type === "DEAD_CLICK").length;
    const network = report.incidents.filter(
      (i) => i.type === "NETWORK_ERROR",
    ).length;
    const layoutVisual = report.incidents.filter(
      (i) => i.type === "LAYOUT_BUG" || i.type === "VISUAL_BUG",
    ).length;
    return { total, dead, network, layoutVisual };
  }, [report]);

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

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-300">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-red-400" />
        Loading crash report…
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-950 text-zinc-300">
        <p>{error ?? "Report not found"}</p>
        <Link href="/" className="text-sm text-red-300 hover:text-red-200">
          Back to Mission Control
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(239,68,68,0.10),_transparent_40%)]" />

      <main className="relative mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-zinc-800 pb-6">
          <Link
            href="/"
            className="inline-flex w-fit items-center gap-2 text-sm text-zinc-400 transition hover:text-zinc-200"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Mission Control
          </Link>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-red-400">
                Executive Crash Report
              </p>
              <h1 className="text-3xl font-semibold tracking-tight text-white">
                Autonomous QA findings for{" "}
                <span className="text-red-300">
                  {(() => {
                    try {
                      return new URL(report.url).hostname;
                    } catch {
                      return report.url;
                    }
                  })()}
                </span>
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-zinc-400">
                Mission: {report.mission}
              </p>
              <p className="mt-1 font-mono text-xs text-zinc-500">
                {report.runId} · {report.status} · {report.steps.length} steps ·{" "}
                {new Date(report.completedAt || report.startedAt).toLocaleString()}
              </p>
            </div>
          </div>
        </header>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {metricCard("Total Bugs Caught", scores.total, "text-red-300")}
          {metricCard("Dead Clicks", scores.dead, "text-amber-300")}
          {metricCard("Network / 5xx Errors", scores.network, "text-orange-300")}
          {metricCard(
            "Layout / Visual Issues",
            scores.layoutVisual,
            "text-cyan-300",
          )}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-950">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-red-400" />
            Executive AI Diagnosis
          </div>
          <div className="grid gap-6 p-5 lg:grid-cols-2">
            <div>
              <h2 className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                Executive Summary
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-200">
                {report.aiSummary?.executiveSummary ??
                  "No executive summary was generated for this run."}
              </p>
              <h2 className="mt-5 text-xs uppercase tracking-[0.16em] text-zinc-500">
                Root Cause Analysis
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-300">
                {report.aiSummary?.rootCauseAnalysis ?? "—"}
              </p>
            </div>
            <div>
              <h2 className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                Suggested Fixes
              </h2>
              <ul className="mt-2 space-y-2">
                {(report.aiSummary?.suggestedFixes ?? []).length === 0 ? (
                  <li className="text-sm text-zinc-500">No suggested fixes.</li>
                ) : (
                  report.aiSummary!.suggestedFixes.map((fix, index) => (
                    <li
                      key={`${index}-${fix.slice(0, 24)}`}
                      className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-200"
                    >
                      {fix}
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </section>

        <div className="flex gap-2 border-b border-zinc-800">
          <button
            type="button"
            onClick={() => setTab("replay")}
            className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${
              tab === "replay"
                ? "border-red-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <Film className="h-4 w-4" />
            Replay & Timeline
          </button>
          <button
            type="button"
            onClick={() => setTab("handoff")}
            className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${
              tab === "handoff"
                ? "border-red-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <Code2 className="h-4 w-4" />
            Developer Handoff
          </button>
        </div>

        {tab === "replay" ? (
          <section className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
              <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-sm font-medium">
                <Film className="h-4 w-4 text-red-400" />
                Session replay
              </div>
              <div className="bg-black p-3">
                {report.videoUrl ? (
                  <video
                    controls
                    playsInline
                    className="mx-auto max-h-[70vh] w-full rounded-md"
                    src={report.videoUrl}
                  >
                    Your browser does not support video playback.
                  </video>
                ) : (
                  <p className="px-2 py-10 text-center text-sm text-zinc-500">
                    No video was recorded for this run.
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950">
              <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-sm font-medium">
                <Gauge className="h-4 w-4 text-red-400" />
                Step timeline
              </div>
              <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">
                {report.steps.map((step, index) => (
                  <button
                    key={`${step.step}-${step.timestamp}`}
                    type="button"
                    onClick={() => setSelectedStep(index)}
                    className={`w-full rounded-lg border p-3 text-left transition ${
                      selectedStep === index
                        ? "border-red-500/50 bg-zinc-900"
                        : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400">
                      <span className="font-mono text-red-300">
                        step {step.step}
                      </span>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-200">
                        {step.decision.action}
                      </span>
                    </div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={step.screenshotUrl}
                      alt={`Step ${step.step}`}
                      className="mb-2 max-h-40 w-full rounded-md object-contain bg-black"
                    />
                    <p className="text-sm text-zinc-300">{step.decision.thought}</p>
                    {step.incidentsTriggered.length > 0 ? (
                      <div className="mt-2 space-y-1">
                        {step.incidentsTriggered.map((incident) => (
                          <p
                            key={incident.id}
                            className="text-xs text-amber-300"
                          >
                            [{incident.type}] {incident.message}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>

            {activeStep ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 lg:col-span-2">
                <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-sm font-medium">
                  <Bug className="h-4 w-4 text-red-400" />
                  Incident trace — step {activeStep.step}
                </div>
                <div className="grid gap-3 p-4 md:grid-cols-2">
                  {activeStep.incidentsTriggered.length === 0 ? (
                    <p className="text-sm text-zinc-500">
                      No incidents on this step.
                    </p>
                  ) : (
                    activeStep.incidentsTriggered.map((incident) => (
                      <article
                        key={incident.id}
                        className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
                      >
                        <div className="mb-2 flex items-center gap-2 text-xs">
                          <ShieldAlert className="h-3.5 w-3.5 text-red-400" />
                          <span className="font-mono text-red-300">
                            {incident.type}
                          </span>
                          <span className="text-zinc-500">
                            {incident.severity}
                          </span>
                        </div>
                        <p className="text-sm text-zinc-200">{incident.message}</p>
                        {incident.details ? (
                          <p className="mt-2 font-mono text-[11px] text-zinc-500">
                            {incident.details}
                          </p>
                        ) : null}
                      </article>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            <section className="rounded-xl border border-zinc-800 bg-zinc-950 lg:col-span-2">
              <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-sm font-medium">
                <ShieldAlert className="h-4 w-4 text-red-400" />
                Full incident ledger
              </div>
              <div className="grid gap-3 p-4 md:grid-cols-2">
                {report.incidents.length === 0 ? (
                  <p className="text-sm text-zinc-500">No incidents recorded.</p>
                ) : (
                  report.incidents.map((incident) => (
                    <article
                      key={incident.id}
                      className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono text-red-300">
                          {incident.type}
                        </span>
                        <span className="text-zinc-500">{incident.severity}</span>
                        <span className="text-zinc-600">step {incident.step}</span>
                      </div>
                      <p className="text-sm text-zinc-200">{incident.message}</p>
                    </article>
                  ))
                )}
              </div>
            </section>
          </section>
        ) : (
          <section className="rounded-xl border border-zinc-800 bg-zinc-950">
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Code2 className="h-4 w-4 text-red-400" />
                Developer Handoff — Playwright regression
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={copySpec}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900"
                >
                  {copied ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <ClipboardCopy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={downloadSpec}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-400"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download `chaos-regression.spec.ts`
                </button>
              </div>
            </div>
            <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed text-emerald-200">
              <code>{report.playwrightSpecCode}</code>
            </pre>
          </section>
        )}
      </main>
    </div>
  );
}
