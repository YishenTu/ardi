import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerDate(pi: ExtensionAPI) {
  // pi's prompt has no date, so the model would go by its training data and
  // could take recent events for future ones. It's a section of its own, so
  // the prompt changes once a day, not every run.
  pi.on("before_agent_start", (event) => {
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, date: `Today is ${today}.` };
  });

}
