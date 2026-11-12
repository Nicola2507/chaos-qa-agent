import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import OpenAI from "openai";
import type {
  AgentDecision,
  CrashReport,
  InteractiveElement,
  StepRecord,
  TelemetryIncident,
} from "@/types/chaos";

let grokClient: OpenAI | null = null;

/** Lazily construct the xAI client — never at module top-level. */
export function getGrokClient(): OpenAI {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "XAI_API_KEY is not set. Add it to .env.local before running the Chaos QA agent.",
    );
  }

  if (!grokClient) {
    grokClient = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
    });
  }

  return grokClient;
}

const SYSTEM_PROMPT = `You are an autonomous Chaos QA & Bug-Hunter Agent testing a mobile viewport (390x844).

Rules:
1. You are an autonomous Chaos QA & Bug-Hunter Agent testing a mobile viewport (390x844).
2. If a GDPR cookie consent banner, age gate, or newsletter modal is blocking the screen, your FIRST priority is to click the Accept/Close badge on that overlay.
3. Inspect the red numbered [ID] badges in the screenshot and match them to interactiveMap. Prefer Set-of-Mark IDs that exist in interactiveMap. Never invent IDs. Never guess pixel coordinates.
4. Never repeat the exact same action + targetMarkId on the same URL if it already appears in history and caused no state change or triggered a DEAD_CLICK.
5. When filling a single input, use TYPE with realistic edge cases (e.g., Romanian characters/diacritics, phone formats, coupon codes, long unicode strings). Whenever 2 or more form inputs are visible on the screen (e.g., Login username + password, or Checkout First Name, Last Name, Zip/Phone), ALWAYS use action: 'FILL_FORM' with formFields: [{ targetMarkId, inputValue }, ...] and optional submitMarkId so you fill and submit the entire form in a SINGLE step instead of wasting 1 step per field.
6. Call out visual bugs via visualBugDetected only for genuine website CSS/layout defects. Use null when none are visible.
7. CRITICAL RULE FOR visualBugDetected: The red [1], [2], [3] badges and red outlines in the screenshot are YOUR OWN internal Set-of-Mark targeting overlays injected by our test harness. NEVER report red badges covering text, overlapping labels, or clipping links as a visualBugDetected or in your thought. Only report genuine website layout bugs (e.g., broken CSS containers, overlapping modals/cookie banners, horizontal page overflow, or broken images). Set visualBugDetected to null unless there is a real website CSS/layout defect independent of the red badges.
8. Use BUG_BLOCKED when a hard blocker prevents further useful testing. Use DONE only when the mission is clearly complete.
9. Keep thought under 25 words for maximum generation speed.
10. Return valid JSON matching AgentDecision — no markdown fences, no prose outside the JSON object.
11. Check formInputsCount before choosing TYPE or FILL_FORM. If formInputsCount is 0, do not attempt TYPE or FILL_FORM — there are no visible form inputs on this page. If formInputsCount >= 2 and multiple fields are needed, prefer FILL_FORM over repeated TYPE steps.

Required JSON schema:
{
  "thought": "≤25 words: what you see and why this action",
  "action": "CLICK" | "TYPE" | "FILL_FORM" | "SCROLL_DOWN" | "WAIT" | "DONE" | "BUG_BLOCKED",
  "targetMarkId": 12,
  "inputValue": "Text to type if action is TYPE",
  "formFields": [{ "targetMarkId": 3, "inputValue": "alex@example.com" }, { "targetMarkId": 4, "inputValue": "P@ssw0rd!" }],
  "submitMarkId": 5,
  "visualBugDetected": null
}

targetMarkId is required for CLICK and TYPE.
inputValue is required for TYPE.
formFields (2+ entries) is required for FILL_FORM. Include submitMarkId when a submit/login/continue button is visible.`;

function normalizeDecision(raw: unknown): AgentDecision {
  if (!raw || typeof raw !== "object") {
    throw new Error("Grok returned a non-object decision payload.");
  }

  const obj = raw as Record<string, unknown>;
  const action = obj.action;
  const allowed = new Set([
    "CLICK",
    "TYPE",
    "FILL_FORM",
    "SCROLL_DOWN",
    "WAIT",
    "DONE",
    "BUG_BLOCKED",
  ]);

  if (typeof action !== "string" || !allowed.has(action)) {
    throw new Error(`Invalid action from Grok: ${String(action)}`);
  }

  const thought =
    typeof obj.thought === "string" && obj.thought.trim()
      ? obj.thought.trim()
      : "No thought provided.";

  const parseMarkId = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    ) {
      return Number(value);
    }
    return undefined;
  };

  const targetMarkId = parseMarkId(obj.targetMarkId);
  const submitMarkId = parseMarkId(obj.submitMarkId);

  const inputValue =
    typeof obj.inputValue === "string" ? obj.inputValue : undefined;

  let formFields: AgentDecision["formFields"];
  if (Array.isArray(obj.formFields)) {
    formFields = obj.formFields
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const field = entry as Record<string, unknown>;
        const fieldMarkId = parseMarkId(field.targetMarkId);
        const fieldValue =
          typeof field.inputValue === "string" ? field.inputValue : undefined;
        if (fieldMarkId == null || fieldValue == null) return null;
        const stableSelector =
          typeof field.stableSelector === "string" && field.stableSelector.trim()
            ? field.stableSelector.trim()
            : undefined;
        return {
          targetMarkId: fieldMarkId,
          inputValue: fieldValue,
          ...(stableSelector ? { stableSelector } : {}),
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          targetMarkId: number;
          inputValue: string;
          stableSelector?: string;
        } => Boolean(entry),
      );
  }

  const submitStableSelector =
    typeof obj.submitStableSelector === "string" &&
    obj.submitStableSelector.trim()
      ? obj.submitStableSelector.trim()
      : undefined;

  let visualBugDetected: string | null = null;
  if (typeof obj.visualBugDetected === "string" && obj.visualBugDetected.trim()) {
    visualBugDetected = obj.visualBugDetected.trim();
  } else if (obj.visualBugDetected === null || obj.visualBugDetected === undefined) {
    visualBugDetected = null;
  }

  const decision: AgentDecision = {
    thought,
    action: action as AgentDecision["action"],
    visualBugDetected,
  };

  if (targetMarkId != null) {
    decision.targetMarkId = targetMarkId;
  }
  if (inputValue != null) {
    decision.inputValue = inputValue;
  }
  if (formFields && formFields.length > 0) {
    decision.formFields = formFields;
  }
  if (submitMarkId != null) {
    decision.submitMarkId = submitMarkId;
  }
  if (submitStableSelector) {
    decision.submitStableSelector = submitStableSelector;
  }

  if (
    (decision.action === "CLICK" || decision.action === "TYPE") &&
    decision.targetMarkId == null
  ) {
    throw new Error(
      `Grok chose ${decision.action} without a valid targetMarkId.`,
    );
  }

  if (decision.action === "TYPE" && !decision.inputValue) {
    decision.inputValue = "test";
  }

  if (decision.action === "FILL_FORM") {
    if (!decision.formFields || decision.formFields.length < 2) {
      throw new Error(
        "Grok chose FILL_FORM without at least 2 valid formFields entries.",
      );
    }
  }

  return decision;
}

export async function decideNextAction(params: {
  mission: string;
  currentUrl: string;
  screenshotBase64: string;
  interactiveMap: Record<number, InteractiveElement>;
  history: StepRecord[];
  recentIncidents: TelemetryIncident[];
  formInputsCount?: number;
}): Promise<AgentDecision> {
  const client = getGrokClient();
  const model = process.env.XAI_MODEL || "grok-4.7";
  const imageUrl = params.screenshotBase64.startsWith("data:")
    ? params.screenshotBase64
    : `data:image/jpeg;base64,${params.screenshotBase64}`;

  const mapEntries = Object.entries(params.interactiveMap)
    .sort(([a], [b]) => Number(a) - Number(b))
    .slice(0, 45);
  const interactiveMapTop45: Record<number, InteractiveElement> = {};
  for (const [key, value] of mapEntries) {
    interactiveMapTop45[Number(key)] = value;
  }

  const historyCompact = params.history.slice(-4).map((step) => ({
    step: step.step,
    url: step.url,
    action: step.decision.action,
    targetMarkId: step.decision.targetMarkId,
    thought: step.decision.thought,
    deadClick: step.incidentsTriggered.some((i) => i.type === "DEAD_CLICK"),
    stableSelector: step.targetElement?.stableSelector,
  }));

  const formInputsCount = params.formInputsCount ?? 0;

  const userText = [
    `Mission: ${params.mission}`,
    `Current URL: ${params.currentUrl}`,
    `formInputsCount: ${formInputsCount} (visible input/textarea/select — if 0 skip TYPE/FILL_FORM; if ≥2 fields needed use FILL_FORM)`,
    `Interactive map (top 45 visible IDs → element):`,
    JSON.stringify(interactiveMapTop45, null, 2),
    `Action history (last 4 steps):`,
    JSON.stringify(historyCompact, null, 2),
    `Recent incidents:`,
    JSON.stringify(
      params.recentIncidents.slice(-8).map((i) => ({
        type: i.type,
        severity: i.severity,
        message: i.message,
        step: i.step,
      })),
      null,
      2,
    ),
    `Decide the single next best chaos-QA action. Keep thought under 25 words. Never blame the red SoM badges as visual bugs. Return strict JSON only.`,
  ].join("\n\n");

  const completion = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("Grok returned an empty response for decideNextAction.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Grok returned non-JSON content: ${raw.slice(0, 500)}`);
  }

  return normalizeDecision(parsed);
}

type AiSummary = NonNullable<CrashReport["aiSummary"]>;

function fallbackSummary(
  report: Omit<CrashReport, "aiSummary" | "playwrightSpecCode">,
): AiSummary {
  const high = report.incidents.filter((i) => i.severity === "HIGH").length;
  const types = Array.from(new Set(report.incidents.map((i) => i.type)));

  const suggestedFixes: string[] = [];
  if (types.includes("DEAD_CLICK")) {
    suggestedFixes.push(
      "Audit inert controls: ensure buttons/links mutate DOM, navigate, or fire network requests, and surface disabled/loading states.",
    );
  }
  if (types.includes("LAYOUT_BUG")) {
    suggestedFixes.push(
      "Fix mobile horizontal overflow: constrain wide children with max-width:100% and overflow-x containment on the viewport root.",
    );
  }
  if (types.includes("NETWORK_ERROR")) {
    suggestedFixes.push(
      "Harden failing API calls: handle 4xx/5xx with user-visible errors, retries for transient 5xx, and avoid silent fetch failures.",
    );
  }
  if (types.includes("CONSOLE_ERROR") || types.includes("PAGE_ERROR")) {
    suggestedFixes.push(
      "Trap and fix uncaught client exceptions; add Error Boundaries around critical interactive flows.",
    );
  }
  if (types.includes("VISUAL_BUG")) {
    suggestedFixes.push(
      "Resolve overlapping overlays / cut-off CTAs on 390×844; verify z-index stacking for cookie banners and modals.",
    );
  }
  if (types.includes("SLOW_API")) {
    suggestedFixes.push(
      "Optimize slow endpoints (>3.5s): caching, pagination, or progressive loading skeletons.",
    );
  }
  if (suggestedFixes.length === 0) {
    suggestedFixes.push(
      "Re-run the mission with a longer step budget and assert key happy-path selectors in CI using the exported Playwright spec.",
    );
  }

  return {
    executiveSummary: `Chaos QA completed ${report.steps.length} mobile step(s) against ${report.url} with status ${report.status}. Caught ${report.incidents.length} incident(s) (${high} HIGH). Dominant signals: ${types.length ? types.join(", ") : "none"}.`,
    rootCauseAnalysis:
      report.incidents.length === 0
        ? "No black-box incidents were recorded. Residual risk remains on unexercised branches of the mission flow."
        : `Primary failure modes clustered around ${types.slice(0, 4).join(", ")}. Review step screenshots and the recorded session video for the first HIGH-severity occurrence; dead clicks and network failures typically indicate missing handlers or broken backend contracts under mobile interaction.`,
    suggestedFixes,
  };
}

export async function generateExecutiveSummary(
  report: Omit<CrashReport, "aiSummary" | "playwrightSpecCode">,
): Promise<AiSummary> {
  try {
    const client = getGrokClient();
    const model = process.env.XAI_MODEL || "grok-4.7";

    const completion = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a principal QA engineer writing a cold-outreach crash report for founders/CTOs.
Analyze the Chaos QA run and return strict JSON:
{
  "executiveSummary": "2-4 sentence business-readable summary",
  "rootCauseAnalysis": "technical root-cause narrative",
  "suggestedFixes": ["actionable fix 1", "actionable fix 2"]
}`,
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              url: report.url,
              mission: report.mission,
              status: report.status,
              steps: report.steps.map((s) => ({
                step: s.step,
                url: s.url,
                action: s.decision.action,
                thought: s.decision.thought,
                target: s.targetElement?.stableSelector,
                incidents: s.incidentsTriggered.map((i) => ({
                  type: i.type,
                  severity: i.severity,
                  message: i.message,
                })),
              })),
              incidents: report.incidents.slice(0, 60),
            },
            null,
            2,
          ),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) {
      return fallbackSummary(report);
    }

    const parsed = JSON.parse(raw) as Partial<AiSummary>;
    const executiveSummary =
      typeof parsed.executiveSummary === "string"
        ? parsed.executiveSummary
        : fallbackSummary(report).executiveSummary;
    const rootCauseAnalysis =
      typeof parsed.rootCauseAnalysis === "string"
        ? parsed.rootCauseAnalysis
        : fallbackSummary(report).rootCauseAnalysis;
    const suggestedFixes = Array.isArray(parsed.suggestedFixes)
      ? parsed.suggestedFixes.filter((x): x is string => typeof x === "string")
      : [];

    return {
      executiveSummary,
      rootCauseAnalysis,
      suggestedFixes:
        suggestedFixes.length > 0
          ? suggestedFixes
          : fallbackSummary(report).suggestedFixes,
    };
  } catch {
    return fallbackSummary(report);
  }
}
