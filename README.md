<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/title-dark.svg"><img src=".github/assets/title-light.svg" alt="Ardi" width="112" height="40"></picture></p>

<p align="center"><strong>Pi, in your Ardia's side panel.</strong></p>

<p align="center">A chat panel for the <a href="https://github.com/mantrakp04/ardia">Ardia</a> browser that runs your local <a href="https://github.com/earendil-works/pi">Pi</a> coding agent.<br>Ask about the page you're on, sort out your tabs, or have Pi click, type and read its way through the web.</p>

<p align="center"><a href="#quick-start">Quick start</a> · <a href="#make-it-yours">Make it yours</a> · <a href="#develop">Develop</a> · <a href="LICENSE">MIT</a></p>

<p align="center"><img src=".github/assets/screenshot.webp" alt="Ardi in Ardia's side panel, introducing the page the user is on"></p>

<br>

## Features

- **Now supports Chrome.** The same Ardi panel, in the Chrome you already use. Works with your existing tabs and signed-in accounts. [Get started →](#chrome-support)
- **Works across your tabs.** It can list, read and open tabs, look at the images on them, and run anything else through `ardia exec`.
- **Mention tabs with @.** Type `@` to pick an open tab; it goes into your message as a chip, and Pi reads it.
- **Keeps working when the panel is closed.** Pi lives in the background, not in the panel.
- **Every chat is a Pi session.** Switch chats and pick up exactly where you left off.
- **Isolated.** It runs with its own prompt, tools and skills, separate from your own Pi setup.

## How it works

```
side panel ⇄ background worker ⇄ native messaging ⇄ bridge (bun) ⇄ pi --mode rpc
```

Extensions can't start local programs, so a small bridge runs Pi and streams its events back. Pi's session files under `~/.pi/agent/sessions` are the record of each chat; the extension only keeps the chat list. One build puts all of it in `dist/ardia/`: the extension, the bridge and Pi's setup. Chrome gets its own copy in `dist/chrome/`.

## Quick start

You need [bun](https://bun.sh) and Pi on macOS or Linux. In Ardia, turn on **Settings → Advanced → Command Line → Let the ardia command control Ardia**.

### Download a release

Download `ardi-ardia-<version>.zip` from [Releases](https://github.com/YishenTu/ardi/releases), extract it, and open a terminal in the extracted folder:

```sh
bun install-host.ts ardia
```

In Ardia, open **Settings → Extensions → Add extensions → Load unpacked extension**, select the folder printed by the installer, and open Ardi from the extensions menu. You can delete the download afterwards. To upgrade, run the installer from the new release and reload the extension.

### Build from source

```sh
git clone https://github.com/YishenTu/ardi.git
cd ardi
bun install
bun run build
bun run host:install ardia
```

In Ardia, open **Settings → Extensions → Add extensions → Load unpacked extension**, pick `dist/ardia/`, and open Ardi from the extensions menu. Keep the repository in place; this installation runs from its built files.

## Chrome support

Ardi now works in Chrome too. It uses the tabs and accounts you're already signed in to, with no separate browser profile or remote-debugging flags.

Download `ardi-chrome-<version>.zip` from [Releases](https://github.com/YishenTu/ardi/releases), extract it, and run `bun install-host.ts chrome` from that folder. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder printed by the installer.

If you built from source instead, run `bun run host:install chrome` and load `dist/chrome/` using the same Chrome steps. Bun and Pi are required for either installation. Chrome shows a debugging banner while Ardi is attached to a tab; it can remain after a response finishes, until you cancel control or restart Ardi. Ardia's persistent userscripts are not available in Chrome.

You can use both versions together. They share your instructions and skills in `~/.ardi/`; chats and panel settings stay separate in each browser.

## Make it yours

| What | Where |
| --- | --- |
| **Prompt** | `src/agent/system-prompt.md` is Pi's entire system prompt. |
| **Tools** | Ardia tools are in `src/agent/extension/ardia.ts`; Chrome tools are in `src/agent/extension/chrome-tools.ts`. |
| **Your instructions** | Write them in `~/.ardi/AGENTS.md`; they apply from your next new chat. |
| **Skills** | Drop them in `~/.ardi/.agents/skills/`; they show up in your next new chat. |
| **Which Pi** | Set the Pi CLI path in Settings (the sliders button); leave it empty to use the Pi `host:install` found. |

Rebuild after editing the prompt or tools, then reload the extension.

## Develop

```sh
bun run dev        # watch Ardia; use bun run dev:chrome for Chrome
bun run build      # typecheck and build both targets
bun run zip        # build and create ardi-ardia.zip and ardi-chrome.zip
bun test           # unit + integration tests, with a fake Pi and a fake Chrome
bun run lint       # oxlint, type-aware
bun run typecheck
```

Contributor and agent guidelines are in [`AGENTS.md`](AGENTS.md). The bridge's Pi runtime is adapted from [Claudian](https://github.com/YishenTu/claudian).

## License

[MIT](LICENSE)
