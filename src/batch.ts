import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFile, writeFile } from "fs/promises";
import path from "path";
import { runChaosMission } from "./agent/loop";
import type { CrashReport, TelemetryIncident } from "./types/chaos";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

const BATCH_MISSION =
  "Act as a mobile customer on an iPhone 14. Dismiss any cookie banner, find a product or form, test inputs or add to cart, and attempt to reach the checkout screen.";

type BatchResult = {
  url: string;
  report?: CrashReport;
  error?: string;
};

function parseTargetLine(raw: string): string | null {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return null;

  const markdownLink = line.match(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
  if (markdownLink?.[1]) return markdownLink[1];

  const bareUrl = line.match(/^(https?:\/\/\S+)/i);
  if (bareUrl?.[1]) return bareUrl[1].replace(/[>,]+$/g, "");

  return null;
}

async function loadTargets(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf8");
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const url = parseTargetLine(line);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
}

function countBySeverity(
  incidents: TelemetryIncident[],
  severity: TelemetryIncident["severity"],
): number {
  return incidents.filter((i) => i.severity === severity).length;
}

function countByType(
  incidents: TelemetryIncident[],
  type: TelemetryIncident["type"],
): number {
  return incidents.filter((i) => i.type === type).length;
}

function leadScore(incidents: TelemetryIncident[]): number {
  // HIGH severity weighted highest for cold-outreach ranking.
  return incidents.reduce((score, incident) => {
    if (incident.severity === "HIGH") return score + 10;
    if (incident.severity === "MEDIUM") return score + 3;
    return score + 1;
  }, 0);
}

function networkOrConsoleCount(incidents: TelemetryIncident[]): number {
  return incidents.filter(
    (i) =>
      i.type === "NETWORK_ERROR" ||
      i.type === "CONSOLE_ERROR" ||
      i.type === "PAGE_ERROR",
  ).length;
}

function topIncidents(incidents: TelemetryIncident[], limit = 5): TelemetryIncident[] {
  const rank = (severity: TelemetryIncident["severity"]) =>
    severity === "HIGH" ? 0 : severity === "MEDIUM" ? 1 : 2;
  return [...incidents]
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.timestamp - b.timestamp)
    .slice(0, limit);
}

function coldOutreachMessage(url: string, incidents: TelemetryIncident[]): string {
  const hostname = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();

  const top = topIncidents(incidents, 1)[0];
  const bugLine = top
    ? `${top.type} (${top.severity}): ${top.message}`
    : "mobile UX defects under iPhone 14 viewport testing";

  return [
    `Hi — I ran an autonomous mobile Chaos QA pass against ${hostname} and caught a concrete production issue: ${bugLine}.`,
    `The agent exercised the guest/customer flow on a 390×844 iPhone viewport and recorded black-box telemetry (network, console, dead clicks, layout).`,
    `Happy to share the annotated replay + auto-generated Playwright regression spec if useful for your engineering team.`,
  ].join(" ");
}

function buildLeadsMarkdown(results: BatchResult[]): string {
  const ranked = [...results].sort((a, b) => {
    const aInc = a.report?.incidents ?? [];
    const bInc = b.report?.incidents ?? [];
    return leadScore(bInc) - leadScore(aInc);
  });

  const lines: string[] = [
    `# Chaos QA // Batch Lead-Gen Report`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `Mission: ${BATCH_MISSION}`,
    ``,
    `## Executive Summary Table`,
    ``,
    `| Rank | Target URL | Status | Total Bugs | High Severity | Dead Clicks | Network/Console Errors | Local Report Link |`,
    `| ---: | --- | --- | ---: | ---: | ---: | ---: | --- |`,
  ];

  ranked.forEach((result, index) => {
    const rank = index + 1;
    const report = result.report;
    if (!report) {
      lines.push(
        `| ${rank} | ${result.url} | ERROR | 0 | 0 | 0 | 0 | — (${result.error ?? "run failed"}) |`,
      );
      return;
    }

    const incidents = report.incidents;
    lines.push(
      `| ${rank} | ${report.url} | ${report.status} | ${incidents.length} | ${countBySeverity(incidents, "HIGH")} | ${countByType(incidents, "DEAD_CLICK")} | ${networkOrConsoleCount(incidents)} | [Open Report](http://localhost:3000/report/${report.runId}) |`,
    );
  });

  lines.push(``);
  lines.push(`## Cold-Outreach Breakdown per Website`);
  lines.push(``);

  const withBugs = ranked.filter(
    (result) => (result.report?.incidents.length ?? 0) >= 1,
  );

  if (withBugs.length === 0) {
    lines.push(`_No sites produced catchable bugs in this batch._`);
    lines.push(``);
  }

  for (const result of withBugs) {
    const report = result.report!;
    const incidents = report.incidents;
    lines.push(`### ${report.url}`);
    lines.push(``);
    lines.push(`- **Run ID:** \`${report.runId}\``);
    lines.push(`- **Status:** ${report.status}`);
    lines.push(`- **Lead score:** ${leadScore(incidents)} (HIGH×10 + MEDIUM×3 + LOW×1)`);
    lines.push(
      `- **Report:** [http://localhost:3000/report/${report.runId}](http://localhost:3000/report/${report.runId})`,
    );
    lines.push(``);
    lines.push(`**Top caught incidents**`);
    lines.push(``);
    for (const incident of topIncidents(incidents, 5)) {
      lines.push(
        `- \`[${incident.severity}] ${incident.type}\` — ${incident.message}${incident.url ? ` (\`${incident.url}\`)` : ""}`,
      );
    }
    lines.push(``);
    lines.push(`**Ready-to-copy cold outreach**`);
    lines.push(``);
    lines.push(`> ${coldOutreachMessage(report.url, incidents)}`);
    lines.push(``);
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!process.env.XAI_API_KEY) {
    console.error(
      `${RED}Missing XAI_API_KEY.${RESET} Add it to .env.local before running batch mode.`,
    );
    process.exitCode = 1;
    return;
  }

  const targetsArg = process.argv[2];
  const targetsPath = path.resolve(
    process.cwd(),
    targetsArg || "targets.txt",
  );

  let urls: string[];
  try {
    urls = await loadTargets(targetsPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${RED}Failed to read targets file:${RESET} ${targetsPath}`);
    console.error(message);
    process.exitCode = 1;
    return;
  }

  if (urls.length === 0) {
    console.error(
      `${YELLOW}No URLs found in ${targetsPath}.${RESET} Add http(s) targets (one per line).`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${CYAN} Chaos QA // Batch Lead-Gen Scanner${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════${RESET}`);
  console.log(`${DIM}Targets file:${RESET} ${targetsPath}`);
  console.log(`${DIM}Targets:${RESET}      ${urls.length}`);
  console.log(`${DIM}Max steps:${RESET}    6`);
  console.log(`${DIM}Headless:${RESET}     true`);
  console.log(`${CYAN}───────────────────────────────────────────${RESET}\n`);

  const results: BatchResult[] = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const label = `[${i + 1}/${urls.length}]`;
    console.log(`${BOLD}${GREEN}${label} Auditing ${url}${RESET}`);

    try {
      const report = await runChaosMission({
        url,
        mission: BATCH_MISSION,
        maxSteps: 6,
        headless: true,
        onEvent: (event) => {
          if (event.type === "step") {
            const step = event.data as {
              step?: number;
              decision?: { action?: string; thought?: string };
            };
            console.log(
              `  ${DIM}step ${step.step ?? "?"} → ${step.decision?.action ?? "?"}${RESET} ${step.decision?.thought ?? ""}`,
            );
          }
        },
      });

      results.push({ url, report });
      console.log(
        `  ${GREEN}✓ done${RESET} — status=${report.status}, bugs=${report.incidents.length}, report=http://localhost:3000/report/${report.runId}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ url, error: message });
      console.error(`  ${RED}✗ failed${RESET} — ${message}\n`);
    }
  }

  const leadsPath = path.join(process.cwd(), "LEADS.md");
  const markdown = buildLeadsMarkdown(results);
  await writeFile(leadsPath, markdown, "utf8");

  const ranked = [...results].sort(
    (a, b) =>
      leadScore(b.report?.incidents ?? []) - leadScore(a.report?.incidents ?? []),
  );

  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${CYAN} Batch complete${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════${RESET}`);
  console.log(`${DIM}LEADS.md:${RESET} ${leadsPath}`);
  console.log(`${DIM}Ranked leads:${RESET}`);
  ranked.forEach((result, index) => {
    const bugs = result.report?.incidents.length ?? 0;
    const high = countBySeverity(result.report?.incidents ?? [], "HIGH");
    console.log(
      `  ${index + 1}. ${result.url} — bugs=${bugs}, high=${high}${result.error ? ` (${RED}error${RESET})` : ""}`,
    );
  });
}

main().catch((error) => {
  console.error("\nBatch scanner failed:");
  console.error(error);
  process.exitCode = 1;
});
