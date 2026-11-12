import { mkdir, readdir, writeFile } from "fs/promises";
import path from "path";
import { chromium, type Page } from "playwright";
import { decideNextAction, generateExecutiveSummary } from "@/lib/grok";
import { generatePlaywrightSpec } from "@/lib/playwright-exporter";
import type { CrashReport, InteractiveElement, StepRecord } from "@/types/chaos";
import { annotatePage, cleanupAnnotations } from "./som-injector";
import { TelemetryRecorder } from "./telemetry";

export type ChaosEvent = {
  type: string;
  data: unknown;
};

export type RunChaosMissionOptions = {
  url: string;
  mission: string;
  maxSteps?: number;
  headless?: boolean;
  onEvent?: (event: ChaosEvent) => void;
};

async function getDomLength(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.outerHTML.length);
}

/** After navigation, nudge down if the upper half has no interactive targets. */
async function maybeAutoScrollAfterNavigation(page: Page): Promise<void> {
  const shouldNudge = await page.evaluate(() => {
    const midY = window.innerHeight / 2;
    const interactive = Array.from(
      document.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [onclick], label, summary',
      ),
    );
    return !interactive.some((el) => {
      const style = window.getComputedStyle(el);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        style.opacity === "0"
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return (
        rect.width > 5 &&
        rect.height > 5 &&
        rect.top >= 0 &&
        rect.top < midY &&
        rect.left < window.innerWidth &&
        rect.right > 0
      );
    });
  });

  if (shouldNudge) {
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(400);
  }
}

async function findWebmFile(runDir: string): Promise<string | undefined> {
  try {
    const entries = await readdir(runDir);
    return entries.find((name) => name.toLowerCase().endsWith(".webm"));
  } catch {
    return undefined;
  }
}

export async function runChaosMission(
  options: RunChaosMissionOptions,
): Promise<CrashReport> {
  const maxSteps = options.maxSteps ?? 8;
  const headless = options.headless ?? true;
  const runId = `run-${Date.now()}`;
  const runDir = path.join(process.cwd(), "public", "runs", runId);
  const startedAt = new Date().toISOString();

  await mkdir(runDir, { recursive: true });

  const steps: StepRecord[] = [];
  const layoutOverflowLoggedForUrl = new Set<string>();
  let status: CrashReport["status"] = "MAX_STEPS_REACHED";
  let videoUrl: string | undefined;
  let fatalError: string | undefined;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    deviceScaleFactor: 3,
    recordVideo: {
      dir: runDir,
      size: { width: 390, height: 844 },
    },
  });

  const page = await context.newPage();
  const telemetry = new TelemetryRecorder(page);

  try {
    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });

    for (let step = 1; step <= maxSteps; step++) {
      telemetry.setStep(step);
      await page.waitForTimeout(1000);

      const annotation = await annotatePage(page);
      const currentUrl = page.url();
      const screenshotUrl = `/runs/${runId}/step-${step}.jpg`;

      if (
        annotation.hasHorizontalOverflow &&
        !layoutOverflowLoggedForUrl.has(currentUrl)
      ) {
        layoutOverflowLoggedForUrl.add(currentUrl);
        telemetry.addCustomIncident({
          step,
          type: "LAYOUT_BUG",
          severity: "MEDIUM",
          message:
            "Mobile horizontal scroll bleed detected (scrollWidth > 390px)",
          details: `url=${currentUrl}`,
          url: currentUrl,
          screenshotUrl,
        });
      }

      const screenshotBuffer = await page.screenshot({
        type: "jpeg",
        quality: 55,
      });
      await writeFile(path.join(runDir, `step-${step}.jpg`), screenshotBuffer);
      const screenshotBase64 = screenshotBuffer.toString("base64");

      await cleanupAnnotations(page);

      options.onEvent?.({
        type: "thinking",
        data: { step, screenshotUrl },
      });

      const decision = await decideNextAction({
        mission: options.mission,
        currentUrl,
        screenshotBase64,
        interactiveMap: annotation.interactiveMap,
        history: steps,
        recentIncidents: telemetry.getAllIncidents().slice(-20),
        formInputsCount: annotation.formInputsCount,
      });

      if (decision.visualBugDetected) {
        telemetry.addCustomIncident({
          step,
          type: "VISUAL_BUG",
          severity: "MEDIUM",
          message: decision.visualBugDetected,
          url: currentUrl,
          screenshotUrl,
        });
      }

      let targetElement: InteractiveElement | undefined;
      if (
        decision.targetMarkId != null &&
        annotation.interactiveMap[decision.targetMarkId]
      ) {
        targetElement = annotation.interactiveMap[decision.targetMarkId];
      }

      if (decision.action === "CLICK" && decision.targetMarkId != null) {
        const markId = decision.targetMarkId;
        const urlBefore = page.url();
        const domLenBefore = await getDomLength(page);

        try {
          await page
            .locator(`[data-chaos-id="${markId}"]`)
            .first()
            .click({ timeout: 5000 });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          telemetry.addCustomIncident({
            step,
            type: "DEAD_CLICK",
            severity: "HIGH",
            message: `Failed to click mark [${markId}]: ${message}`,
            url: page.url(),
            screenshotUrl,
          });
        }

        await page.waitForTimeout(1800);

        const urlAfter = page.url();
        const domLenAfter = await getDomLength(page);

        if (urlBefore !== urlAfter) {
          await maybeAutoScrollAfterNavigation(page);
        } else if (Math.abs(domLenAfter - domLenBefore) < 15) {
          const label = targetElement
            ? `<${targetElement.tag}> "${targetElement.text}" (${targetElement.stableSelector})`
            : `mark [${markId}]`;
          telemetry.addCustomIncident({
            step,
            type: "DEAD_CLICK",
            severity: "HIGH",
            message: `Dead click on ${label} — UI produced zero DOM or route mutation.`,
            url: urlAfter,
            screenshotUrl,
          });
        }
      } else if (decision.action === "TYPE" && decision.targetMarkId != null) {
        const markId = decision.targetMarkId;
        const locator = page.locator(`[data-chaos-id="${markId}"]`).first();
        await locator.click({ timeout: 5000 }).catch(() => undefined);
        await locator.fill(decision.inputValue || "test", { timeout: 5000 });

        const inputType = (
          targetElement?.type ||
          (await locator.getAttribute("type").catch(() => null)) ||
          ""
        ).toLowerCase();
        const nameAttr =
          (await locator.getAttribute("name").catch(() => null)) || "";
        const roleHint = `${targetElement?.text ?? ""} ${targetElement?.stableSelector ?? ""} ${nameAttr}`;
        if (
          inputType === "search" ||
          /search/i.test(roleHint) ||
          /search/i.test(nameAttr)
        ) {
          await locator.press("Enter").catch(() => undefined);
        }
      } else if (
        decision.action === "FILL_FORM" &&
        decision.formFields &&
        decision.formFields.length > 0
      ) {
        decision.formFields = decision.formFields.map((field) => {
          const stableSelector =
            field.stableSelector ||
            annotation.interactiveMap[field.targetMarkId]?.stableSelector;
          return {
            ...field,
            ...(stableSelector ? { stableSelector } : {}),
          };
        });

        for (const field of decision.formFields) {
          const locator = page
            .locator(`[data-chaos-id="${field.targetMarkId}"]`)
            .first();
          await locator.click({ timeout: 5000 }).catch(() => undefined);
          await locator.fill(field.inputValue || "test", { timeout: 5000 });
          await page.waitForTimeout(200);
        }

        if (decision.submitMarkId != null) {
          const submitStable =
            annotation.interactiveMap[decision.submitMarkId]?.stableSelector;
          if (submitStable) {
            decision.submitStableSelector = submitStable;
          }

          try {
            await page
              .locator(`[data-chaos-id="${decision.submitMarkId}"]`)
              .first()
              .click({ timeout: 5000 });
            await page.waitForTimeout(1800);
            const urlAfterSubmit = page.url();
            if (urlAfterSubmit !== currentUrl) {
              await maybeAutoScrollAfterNavigation(page);
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            telemetry.addCustomIncident({
              step,
              type: "DEAD_CLICK",
              severity: "HIGH",
              message: `FILL_FORM submit failed on mark [${decision.submitMarkId}]: ${message}`,
              url: page.url(),
              screenshotUrl,
            });
          }
        }

        const firstFilled =
          annotation.interactiveMap[decision.formFields[0]?.targetMarkId];
        if (!targetElement && firstFilled) {
          targetElement = firstFilled;
        }
      } else if (decision.action === "SCROLL_DOWN") {
        await page.mouse.wheel(0, 720);
        await page.waitForTimeout(800);
      } else if (decision.action === "WAIT") {
        await page.waitForTimeout(2000);
      }

      const incidentsTriggered = telemetry.getStepIncidents(step);
      const stepRecord: StepRecord = {
        step,
        url: page.url(),
        screenshotUrl,
        decision,
        ...(targetElement ? { targetElement } : {}),
        incidentsTriggered,
        hasHorizontalOverflow: annotation.hasHorizontalOverflow,
        brokenImagesCount: annotation.brokenImagesCount,
        timestamp: Date.now(),
      };

      steps.push(stepRecord);
      options.onEvent?.({ type: "step", data: stepRecord });

      if (decision.action === "DONE") {
        status = "COMPLETED";
        break;
      }
      if (decision.action === "BUG_BLOCKED") {
        status = "BUG_BLOCKED";
        break;
      }
    }
  } catch (error) {
    status = "ERROR";
    fatalError = error instanceof Error ? error.message : String(error);
    options.onEvent?.({
      type: "error",
      data: { message: fatalError },
    });
  } finally {
    try {
      await page.close();
    } catch {
      /* ignore */
    }
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }

  const videoFileName = await findWebmFile(runDir);
  if (videoFileName) {
    videoUrl = `/runs/${runId}/${videoFileName}`;
  }

  const incidents = telemetry.getAllIncidents();
  const completedAt = new Date().toISOString();

  const draftReport: Omit<CrashReport, "aiSummary" | "playwrightSpecCode"> = {
    runId,
    url: options.url,
    mission: options.mission,
    startedAt,
    completedAt,
    status,
    steps,
    incidents,
    ...(videoUrl ? { videoUrl } : {}),
  };

  const aiSummary = await generateExecutiveSummary(draftReport);
  const playwrightSpecCode = generatePlaywrightSpec({
    url: options.url,
    mission: options.mission,
    steps,
    incidents,
  });

  const report: CrashReport = {
    ...draftReport,
    aiSummary,
    playwrightSpecCode,
  };

  if (fatalError) {
    report.aiSummary = {
      executiveSummary: `Mission aborted with ERROR: ${fatalError}`,
      rootCauseAnalysis:
        report.aiSummary?.rootCauseAnalysis ??
        "The agent loop threw before completing the planned step budget.",
      suggestedFixes: report.aiSummary?.suggestedFixes ?? [
        "Retry the mission after verifying the target URL is reachable and XAI_API_KEY is valid.",
      ],
    };
  }

  await writeFile(
    path.join(runDir, "report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  options.onEvent?.({ type: "complete", data: report });
  return report;
}
