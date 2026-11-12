import type { StepRecord, TelemetryIncident } from "@/types/chaos";

function escapeSingleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function actionLine(step: StepRecord): string {
  const decision = step.decision;
  const selector = step.targetElement?.stableSelector;

  switch (decision.action) {
    case "CLICK": {
      if (!selector) {
        return `  // CLICK skipped — missing stableSelector for mark ${decision.targetMarkId ?? "?"}`;
      }
      return `  await page.locator('${escapeSingleQuotes(selector)}').first().click();`;
    }
    case "TYPE": {
      if (!selector) {
        return `  // TYPE skipped — missing stableSelector for mark ${decision.targetMarkId ?? "?"}`;
      }
      const value = decision.inputValue ?? "test";
      const fill = `  await page.locator('${escapeSingleQuotes(selector)}').first().fill('${escapeSingleQuotes(value)}');`;
      const isSearch =
        step.targetElement?.type === "search" ||
        /search/i.test(step.targetElement?.text ?? "") ||
        /search/i.test(selector);
      if (isSearch) {
        return `${fill}\n  await page.locator('${escapeSingleQuotes(selector)}').first().press('Enter');`;
      }
      return fill;
    }
    case "FILL_FORM": {
      const fields = decision.formFields ?? [];
      const lines: string[] = [];

      for (const field of fields) {
        const fieldSelector =
          field.stableSelector || `[data-chaos-id="${field.targetMarkId}"]`;
        lines.push(
          `  await page.locator('${escapeSingleQuotes(fieldSelector)}').first().fill('${escapeSingleQuotes(field.inputValue || "test")}');`,
        );
      }

      if (fields.length === 0) {
        lines.push(`  // FILL_FORM skipped — no formFields recorded`);
      }

      if (decision.submitMarkId != null || decision.submitStableSelector) {
        const submitSelector =
          decision.submitStableSelector ||
          `[data-chaos-id="${decision.submitMarkId}"]`;
        lines.push(
          `  await page.locator('${escapeSingleQuotes(submitSelector)}').first().click();`,
        );
      }

      return lines.join("\n");
    }
    case "SCROLL_DOWN":
      return `  await page.mouse.wheel(0, 720);`;
    case "WAIT":
      return `  await page.waitForTimeout(2000);`;
    case "DONE":
      return `  // DONE — mission complete`;
    case "BUG_BLOCKED":
      return `  // BUG_BLOCKED — agent halted on blocker`;
    default:
      return `  // Unhandled action`;
  }
}

function incidentComments(
  step: number,
  incidents: TelemetryIncident[],
): string[] {
  return incidents.map(
    (incident) =>
      `  // [BUG DETECTED ON STEP ${step}]: [${incident.severity}] ${incident.type} — ${incident.message}`,
  );
}

export function generatePlaywrightSpec(report: {
  url: string;
  mission: string;
  steps: StepRecord[];
  incidents: TelemetryIncident[];
}): string {
  const lines: string[] = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `/**`,
    ` * Auto-generated Chaos QA regression spec`,
    ` * Mission: ${report.mission.replace(/\*\//g, "* /")}`,
    ` * Target: ${report.url}`,
    ` */`,
    ``,
    `test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });`,
    ``,
    `test('chaos QA regression — ${escapeSingleQuotes(report.mission).slice(0, 80)}', async ({ page }) => {`,
    `  const pageErrors: Error[] = [];`,
    `  page.on('pageerror', (error) => pageErrors.push(error));`,
    ``,
    `  await page.goto('${escapeSingleQuotes(report.url)}', { waitUntil: 'domcontentloaded' });`,
    ``,
  ];

  for (const step of report.steps) {
    lines.push(
      `  // Step ${step.step}: ${step.decision.thought.replace(/\s+/g, " ").trim()}`,
    );

    if (step.decision.action === "FILL_FORM") {
      const filledSelectors =
        step.decision.formFields
          ?.map((field) => field.stableSelector)
          .filter((value): value is string => Boolean(value)) ?? [];
      if (filledSelectors.length > 0) {
        lines.push(
          `  // filled stableSelectors: ${filledSelectors.join(", ")}`,
        );
      }
      if (step.decision.submitStableSelector) {
        lines.push(
          `  // submitStableSelector: ${step.decision.submitStableSelector}`,
        );
      }
    } else if (step.targetElement?.stableSelector) {
      lines.push(`  // stableSelector: ${step.targetElement.stableSelector}`);
    }

    const stepIncidents =
      step.incidentsTriggered.length > 0
        ? step.incidentsTriggered
        : report.incidents.filter((i) => i.step === step.step);

    if (stepIncidents.length > 0) {
      lines.push(...incidentComments(step.step, stepIncidents));
    }

    lines.push(actionLine(step));
    lines.push(`  await page.waitForTimeout(800);`);
    lines.push(``);
  }

  lines.push(
    `  expect(pageErrors, 'uncaught pageerrors during regression').toEqual([]);`,
  );
  lines.push(`});`);
  lines.push(``);

  return lines.join("\n");
}
