import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { runChaosMission } from "./agent/loop";
import type { StepRecord, TelemetryIncident } from "./types/chaos";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

function severityColor(severity: TelemetryIncident["severity"]): string {
  if (severity === "HIGH") return RED;
  if (severity === "MEDIUM") return YELLOW;
  return DIM;
}

async function main(): Promise<void> {
  const url = process.argv[2] || "https://books.toscrape.com";
  const mission =
    process.argv.slice(3).join(" ").trim() ||
    "Find the first book on the page, open its details, and add it to the basket.";

  if (!process.env.XAI_API_KEY) {
    console.error(
      `${RED}Missing XAI_API_KEY.${RESET} Add it to .env.local before running.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${CYAN} Autonomous Chaos QA Agent — CLI Runner${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════${RESET}`);
  console.log(`${DIM}URL:${RESET}     ${url}`);
  console.log(`${DIM}Mission:${RESET} ${mission}`);
  console.log(`${DIM}Model:${RESET}   ${process.env.XAI_MODEL || "grok-4.7"}`);
  console.log(`${DIM}Mode:${RESET}    headed (headless: false)`);
  console.log(`${CYAN}───────────────────────────────────────────${RESET}\n`);

  const report = await runChaosMission({
    url,
    mission,
    headless: false,
    maxSteps: 8,
    onEvent: (event) => {
      if (event.type === "thinking") {
        const data = event.data as { step: number; screenshotUrl: string };
        console.log(
          `${DIM}… thinking step ${data.step} (${data.screenshotUrl})${RESET}`,
        );
        return;
      }

      if (event.type === "step") {
        const step = event.data as StepRecord;
        console.log(`\n${BOLD}${GREEN}▶ Step ${step.step}${RESET}`);
        console.log(`  ${DIM}URL:${RESET}      ${step.url}`);
        console.log(`  ${DIM}Thought:${RESET}  ${step.decision.thought}`);
        console.log(
          `  ${DIM}Action:${RESET}   ${MAGENTA}${step.decision.action}${RESET}` +
            (step.decision.targetMarkId != null
              ? ` → [#${step.decision.targetMarkId}]`
              : "") +
            (step.decision.inputValue
              ? `  input="${step.decision.inputValue}"`
              : ""),
        );
        if (step.targetElement?.stableSelector) {
          console.log(
            `  ${DIM}Selector:${RESET} ${CYAN}${step.targetElement.stableSelector}${RESET}`,
          );
        }
        if (step.decision.visualBugDetected) {
          console.log(
            `  ${YELLOW}Visual bug:${RESET} ${step.decision.visualBugDetected}`,
          );
        }
        if (step.incidentsTriggered.length > 0) {
          console.log(`  ${RED}${BOLD}Bugs caught:${RESET}`);
          for (const incident of step.incidentsTriggered) {
            console.log(
              `    ${severityColor(incident.severity)}[${incident.severity}] ${incident.type}${RESET} — ${incident.message}`,
            );
          }
        }
        return;
      }

      if (event.type === "error") {
        const data = event.data as { message?: string };
        console.error(`${RED}Error:${RESET} ${data.message ?? "unknown"}`);
      }
    },
  });

  console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${CYAN} Crash Report${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════${RESET}`);
  console.log(`${DIM}Run ID:${RESET}    ${report.runId}`);
  console.log(`${DIM}Status:${RESET}    ${report.status}`);
  console.log(`${DIM}Steps:${RESET}     ${report.steps.length}`);
  console.log(`${DIM}Incidents:${RESET} ${report.incidents.length}`);
  console.log(`${DIM}Video:${RESET}     ${report.videoUrl ?? "(none)"}`);
  console.log(
    `${GREEN}${BOLD}Report:${RESET}    http://localhost:3000/report/${report.runId}`,
  );

  if (report.incidents.length > 0) {
    console.log(`\n${BOLD}All incidents:${RESET}`);
    for (const incident of report.incidents) {
      console.log(
        `  ${severityColor(incident.severity)}[${incident.severity}] ${incident.type}${RESET} — ${incident.message}`,
      );
    }
  }
}

main().catch((error) => {
  console.error("\nChaos mission failed:");
  console.error(error);
  process.exitCode = 1;
});
