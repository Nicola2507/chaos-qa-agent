import type { Page } from "playwright";
import type { InteractiveElement } from "@/types/chaos";

export type AnnotatePageResult = {
  interactiveMap: Record<number, InteractiveElement>;
  hasHorizontalOverflow: boolean;
  brokenImagesCount: number;
  formInputsCount: number;
};

type AnnotateEvaluateResult = {
  interactiveMap: Record<string, InteractiveElement>;
  hasHorizontalOverflow: boolean;
  brokenImagesCount: number;
  formInputsCount: number;
};

export async function annotatePage(page: Page): Promise<AnnotatePageResult> {
  const raw = await page.evaluate((): AnnotateEvaluateResult => {
    document.querySelectorAll(".chaos-som-badge").forEach((el) => el.remove());
    document.querySelectorAll("[data-chaos-id]").forEach((el) => {
      el.removeAttribute("data-chaos-id");
      const htmlEl = el as HTMLElement;
      htmlEl.style.boxShadow = "";
      htmlEl.style.outline = "";
      htmlEl.style.outlineOffset = "";
    });

    const selectors = [
      "a",
      "button",
      "input",
      "select",
      "textarea",
      '[role="button"]',
      "[onclick]",
      "label",
      "summary",
    ].join(", ");

    const candidates = Array.from(document.querySelectorAll(selectors));
    const interactiveMap: Record<string, InteractiveElement> = {};
    let nextId = 1;

    const isVisibleInViewport = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        style.opacity === "0"
      ) {
        return false;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width <= 5 || rect.height <= 5) {
        return false;
      }

      const fullyOutside =
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= window.innerHeight ||
        rect.left >= window.innerWidth;

      return !fullyOutside;
    };

    const looksRandomId = (id: string): boolean => {
      if (/^\d+$/.test(id)) return true;
      if (/^[0-9a-f]{8,}$/i.test(id)) return true;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        return true;
      return false;
    };

    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current.nodeType === 1 && parts.length < 5) {
        const tag = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === current!.tagName,
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
        } else {
          parts.unshift(tag);
        }
        current = parent;
        if (tag === "body" || tag === "html") break;
      }
      return parts.join(" > ");
    };

    const computeStableSelector = (el: Element, tag: string, cleanText: string): string => {
      const idAttr = el.id?.trim();
      if (idAttr && !looksRandomId(idAttr)) {
        try {
          return `#${CSS.escape(idAttr)}`;
        } catch {
          return `#${idAttr.replace(/([^a-zA-Z0-9_-])/g, "\\$1")}`;
        }
      }

      const testId = el.getAttribute("data-testid");
      if (testId) {
        return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
      }

      const nameAttr = el.getAttribute("name");
      if (nameAttr) {
        return `${tag}[name="${nameAttr.replace(/"/g, '\\"')}"]`;
      }

      const placeholder = el.getAttribute("placeholder");
      if (placeholder) {
        return `${tag}[placeholder="${placeholder.replace(/"/g, '\\"')}"]`;
      }

      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) {
        return `${tag}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
      }

      if (
        (tag === "button" || tag === "a") &&
        cleanText.length >= 1 &&
        cleanText.length <= 35
      ) {
        return `${tag}:has-text("${cleanText.replace(/"/g, '\\"')}")`;
      }

      const classList = Array.from(el.classList)
        .filter((c) => c && !c.startsWith("chaos-") && c.length < 40)
        .slice(0, 2);
      if (classList.length > 0) {
        return `${tag}.${classList.map((c) => CSS.escape(c)).join(".")}`;
      }

      return cssPath(el);
    };

    for (const el of candidates) {
      if (!isVisibleInViewport(el)) {
        continue;
      }

      const id = nextId++;
      el.setAttribute("data-chaos-id", String(id));

      const rect = el.getBoundingClientRect();
      const htmlEl = el as HTMLElement;
      htmlEl.style.boxShadow = "0 0 0 2px rgba(239,68,68,0.65)";

      const badge = document.createElement("div");
      badge.className = "chaos-som-badge";
      badge.textContent = `[${id}]`;
      badge.setAttribute("data-chaos-badge-for", String(id));
      Object.assign(badge.style, {
        position: "fixed",
        left: `${Math.max(0, rect.left - 4)}px`,
        top: `${Math.max(0, rect.top - 8)}px`,
        background: "#ef4444",
        color: "#fff",
        fontSize: "9px",
        fontWeight: "bold",
        padding: "0px 3px",
        opacity: "0.85",
        borderRadius: "3px",
        zIndex: "2147483647",
        pointerEvents: "none",
        boxShadow: "0 0 0 2px #ef4444",
        fontFamily: "monospace",
        lineHeight: "1.2",
      });
      document.documentElement.appendChild(badge);

      const tag = el.tagName.toLowerCase();
      const typeAttr = el.getAttribute("type") ?? undefined;
      const text = (
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        el.getAttribute("title") ||
        (el as HTMLInputElement).value ||
        el.textContent ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);

      const stableSelector = computeStableSelector(el, tag, text);

      interactiveMap[String(id)] = {
        id,
        tag,
        text,
        ...(typeAttr ? { type: typeAttr } : {}),
        selector: `[data-chaos-id="${id}"]`,
        stableSelector,
      };
    }

    const hasHorizontalOverflow =
      document.documentElement.scrollWidth > window.innerWidth + 4;

    const brokenImagesCount = Array.from(document.images).filter(
      (img) => img.complete && img.naturalWidth === 0,
    ).length;

    const formInputsCount = Array.from(
      document.querySelectorAll("input, textarea, select"),
    ).filter((el) => isVisibleInViewport(el)).length;

    return {
      interactiveMap,
      hasHorizontalOverflow,
      brokenImagesCount,
      formInputsCount,
    };
  });

  const interactiveMap: Record<number, InteractiveElement> = {};
  for (const [key, value] of Object.entries(raw.interactiveMap)) {
    interactiveMap[Number(key)] = value;
  }

  return {
    interactiveMap,
    hasHorizontalOverflow: raw.hasHorizontalOverflow,
    brokenImagesCount: raw.brokenImagesCount,
    formInputsCount: raw.formInputsCount,
  };
}

/** Strip visual badges/outlines but keep data-chaos-id for action targeting. */
export async function cleanupAnnotations(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll(".chaos-som-badge").forEach((el) => el.remove());
    document.querySelectorAll("[data-chaos-id]").forEach((el) => {
      const htmlEl = el as HTMLElement;
      htmlEl.style.boxShadow = "";
      htmlEl.style.outline = "";
      htmlEl.style.outlineOffset = "";
    });
  });
}
