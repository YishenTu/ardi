import type { ModelInfo, ModelState, ThinkingLevel } from "../chat";
import { el } from "./dom";

const LEVEL_NAMES: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

// The composer button and the panel it opens (a popover, via
// `popovertarget`) for choosing the model and effort. Picking sends the
// change to pi; the panel stays open and updates when pi reports back.
export class ModelPicker {
  private state: ModelState = { models: [] };

  constructor(
    private readonly toggle: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly tip: HTMLElement,
    private readonly on: { setModel: (provider: string, id: string) => void; setThinkingLevel: (level: ThinkingLevel) => void },
  ) {
    // Open above the composer, lined up with its right edge.
    panel.addEventListener("beforetoggle", (e) => {
      if (e.newState !== "open") return;
      const field = toggle.closest(".field")!.getBoundingClientRect();
      panel.style.right = `${window.innerWidth - field.right}px`;
      panel.style.bottom = `${window.innerHeight - field.top + 6}px`;
    });
    panel.addEventListener("toggle", (e) => {
      if (e.newState === "open") panel.querySelector('.models [aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
    });
  }

  render(state: ModelState) {
    this.state = state;
    const model = this.currentModel();
    const levels = model?.thinkingLevels.some((l) => l !== "off") ? model.thinkingLevels : [];
    this.toggle.hidden = !state.models.length;
    this.tip.textContent = model
      ? [model.name, ...(levels.length ? [LEVEL_NAMES[state.thinkingLevel ?? "off"]] : [])].join(" · ")
      : "Choose a model";

    this.panel.replaceChildren(el("h2", "", "Model"), this.models());
    if (levels.length) this.panel.append(el("div", "options-sep"), el("h2", "", "Effort"), this.effort(levels));
  }

  private currentModel(): ModelInfo | undefined {
    const { current, models } = this.state;
    return models.find((m) => m.provider === current?.provider && m.id === current?.id);
  }

  private models(): HTMLElement {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of this.state.models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
    const current = this.state.current;
    const list = el("div", "models");
    for (const [provider, models] of byProvider) {
      if (byProvider.size > 1) list.append(el("h2", "", provider));
      for (const m of models) {
        const isCurrent = m.provider === current?.provider && m.id === current?.id;
        list.append(this.choice(m.name, isCurrent, () => this.on.setModel(m.provider, m.id)));
      }
    }
    return list;
  }

  // Lowest effort first, left to right.
  private effort(levels: ThinkingLevel[]): HTMLElement {
    const row = el("div", "effort");
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", "Effort");
    for (const level of levels) {
      row.append(this.choice(LEVEL_NAMES[level], level === this.state.thinkingLevel, () => this.on.setThinkingLevel(level)));
    }
    return row;
  }

  private choice(label: string, checked: boolean, pick: () => void): HTMLButtonElement {
    const button = el("button", "", label);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(checked));
    button.addEventListener("click", () => {
      if (!checked) pick();
    });
    return button;
  }
}
