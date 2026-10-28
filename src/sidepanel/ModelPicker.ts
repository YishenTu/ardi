import type { ModelInfo, ModelState, ThinkingLevel } from "../chat";
import { el } from "./dom";

const LEVEL_NAMES: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

type MenuItem = { label: string; checked: boolean; pick: () => void };
type MenuSection = { title?: string; items: MenuItem[] };

// The model and thinking-level pills in the composer. Each opens a menu
// above itself; picking sends the change to pi, and the pills update when
// pi reports back.
export class ModelPicker {
  private state: ModelState = { models: [] };
  private anchor: HTMLElement | null = null;
  // Clicking the open pill light-dismisses the menu before the click lands;
  // this keeps that click from reopening it.
  private justClosed: HTMLElement | null = null;

  constructor(
    private readonly modelBtn: HTMLElement,
    private readonly thinkingBtn: HTMLElement,
    private readonly menu: HTMLElement,
    private readonly on: { setModel: (provider: string, id: string) => void; setThinkingLevel: (level: ThinkingLevel) => void },
  ) {
    modelBtn.addEventListener("click", () => this.toggle(modelBtn, () => this.modelSections()));
    thinkingBtn.addEventListener("click", () => this.toggle(thinkingBtn, () => this.thinkingSections()));
    menu.addEventListener("toggle", (e) => {
      if (e.newState === "open") return;
      this.anchor?.setAttribute("aria-expanded", "false");
      this.justClosed = this.anchor;
      this.anchor = null;
      setTimeout(() => (this.justClosed = null), 300);
    });
  }

  render(state: ModelState) {
    this.state = state;
    const model = this.currentModel();
    this.modelBtn.hidden = !state.models.length;
    this.modelBtn.querySelector("span")!.textContent = model?.name ?? "Choose a model";
    const levels = model?.thinkingLevels ?? [];
    this.thinkingBtn.hidden = !levels.some((l) => l !== "off");
    this.thinkingBtn.querySelector("span")!.textContent = LEVEL_NAMES[state.thinkingLevel ?? "off"];
  }

  private currentModel(): ModelInfo | undefined {
    const { current, models } = this.state;
    return models.find((m) => m.provider === current?.provider && m.id === current?.id);
  }

  private modelSections(): MenuSection[] {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of this.state.models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
    const current = this.state.current;
    return [...byProvider].map(([provider, models]) => ({
      title: byProvider.size > 1 ? provider : undefined,
      items: models.map((m) => ({
        label: m.name,
        checked: m.provider === current?.provider && m.id === current?.id,
        pick: () => this.on.setModel(m.provider, m.id),
      })),
    }));
  }

  private thinkingSections(): MenuSection[] {
    return [
      {
        // Highest first.
        items: [...(this.currentModel()?.thinkingLevels ?? [])].reverse().map((level) => ({
          label: LEVEL_NAMES[level],
          checked: level === this.state.thinkingLevel,
          pick: () => this.on.setThinkingLevel(level),
        })),
      },
    ];
  }

  private toggle(anchor: HTMLElement, sections: () => MenuSection[]) {
    const wasOpen = this.anchor === anchor || this.justClosed === anchor;
    if (this.menu.matches(":popover-open")) this.menu.hidePopover();
    if (wasOpen) return;

    this.menu.replaceChildren(
      ...sections().flatMap((section) => [
        ...(section.title ? [el("h2", "", section.title)] : []),
        ...section.items.map((item) => {
          const button = el("button", "", item.label);
          button.setAttribute("role", "menuitemradio");
          button.setAttribute("aria-checked", String(item.checked));
          button.addEventListener("click", () => {
            this.menu.hidePopover();
            if (!item.checked) item.pick();
          });
          return button;
        }),
      ]),
    );

    // Open above the pill, kept inside the panel.
    const rect = anchor.getBoundingClientRect();
    this.menu.style.left = `${Math.max(10, rect.left)}px`;
    this.menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    this.menu.showPopover();
    const overflow = this.menu.getBoundingClientRect().right - (window.innerWidth - 10);
    if (overflow > 0) this.menu.style.left = `${Math.max(10, rect.left - overflow)}px`;

    this.anchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    this.menu.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
  }
}
