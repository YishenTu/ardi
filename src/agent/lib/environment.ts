import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OS: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

// Ardi replaces pi's prompt, which has no OS or shell, so the model would
// guess bash syntax on Windows, where its shell tool is PowerShell.
function environmentSection(platform: NodeJS.Platform): string {
  const os = OS[platform] ?? platform;
  return platform === "win32"
    ? `This computer runs ${os}. Run commands with the powershell tool, in PowerShell syntax; there is no bash.`
    : `This computer runs ${os}. Run commands with the bash tool.`;
}

export function registerEnvironment(pi: ExtensionAPI) {
  const environment = environmentSection(process.platform);
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, environment };
  });
}
