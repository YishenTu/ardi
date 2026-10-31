import { PANEL_PORT, type PanelRequest, type SettingsAnswers, type SettingsRequest } from "../shared";
import * as pi from "./pi-session";
import * as settings from "./settings";
import { setTarget, type BackgroundTarget } from "./target";

// The service worker, started by each target's background entry with its
// browser target.
export function startBackground(target: BackgroundTarget): void {
  setTarget(target);

  // Clicking the toolbar icon opens the side panel.
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return;
    void pi.attachPanel(port);
    void pi.start();
    port.onMessage.addListener((req: PanelRequest) => void handle(req));
  });

  // The settings screen's questions. Answered asynchronously (return true).
  chrome.runtime.onMessage.addListener((req: SettingsRequest, _sender, respond) => {
    void answer(req).then(respond);
    return true;
  });
}

// The panel's requests, over its port.
function handle(req: PanelRequest) {
  switch (req.kind) {
    case "prompt":
      return pi.prompt(req.text);
    case "abort":
      return pi.abort();
    case "restart":
      return pi.restart();
    case "new_session":
      return pi.newSession();
    case "switch_session":
      return pi.switchSession(req.id);
    case "delete_session":
      return pi.deleteSession(req.id);
    case "compact":
      return pi.compact();
    case "set_model":
      return pi.setModel(req.provider, req.modelId);
    case "set_thinking_level":
      return pi.setThinkingLevel(req.level);
  }
}

async function answer(req: SettingsRequest) {
  switch (req.kind) {
    case "get_settings": {
      const saved = await settings.loadSettings();
      return { settings: saved, check: await settings.checkPi(saved.piPath) } satisfies SettingsAnswers["get_settings"];
    }
    case "set_pi_path": {
      const result = await settings.setPiPath(req.piPath);
      if (result.saved && !result.check.error) await pi.restart();
      return result satisfies SettingsAnswers["set_pi_path"];
    }
  }
}
