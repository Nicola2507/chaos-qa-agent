export interface InteractiveElement {
  id: number;
  tag: string;
  text: string;
  type?: string;
  selector: string;
  stableSelector: string;
}

export interface TelemetryIncident {
  id: string;
  step: number;
  timestamp: number;
  type:
    | "CONSOLE_ERROR"
    | "PAGE_ERROR"
    | "NETWORK_ERROR"
    | "SLOW_API"
    | "DEAD_CLICK"
    | "LAYOUT_BUG"
    | "VISUAL_BUG";
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  details?: string;
  url: string;
  screenshotUrl?: string;
}

export interface FormFieldInput {
  targetMarkId: number;
  inputValue: string;
  stableSelector?: string;
}

export interface AgentDecision {
  thought: string;
  action:
    | "CLICK"
    | "TYPE"
    | "FILL_FORM"
    | "SCROLL_DOWN"
    | "WAIT"
    | "DONE"
    | "BUG_BLOCKED";
  targetMarkId?: number;
  inputValue?: string;
  formFields?: FormFieldInput[];
  submitMarkId?: number;
  submitStableSelector?: string;
  visualBugDetected?: string | null;
}

export interface StepRecord {
  step: number;
  url: string;
  screenshotUrl: string;
  decision: AgentDecision;
  targetElement?: InteractiveElement;
  incidentsTriggered: TelemetryIncident[];
  hasHorizontalOverflow: boolean;
  brokenImagesCount: number;
  timestamp: number;
}

export interface CrashReport {
  runId: string;
  url: string;
  mission: string;
  startedAt: string;
  completedAt: string;
  status: "COMPLETED" | "BUG_BLOCKED" | "MAX_STEPS_REACHED" | "ERROR";
  steps: StepRecord[];
  incidents: TelemetryIncident[];
  videoUrl?: string;
  aiSummary?: {
    executiveSummary: string;
    rootCauseAnalysis: string;
    suggestedFixes: string[];
  };
  playwrightSpecCode: string;
}
