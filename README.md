<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/title-dark.svg">
    <img src=".github/assets/title-light.svg" alt="Ardi" width="112" height="40">
  </picture>
</p>

<p align="center"><strong>Pi, in your Ardia's side panel.</strong></p>

<p align="center">A chat panel for the <a href="https://github.com/mantrakp04/ardia">Ardia</a> browser that runs your local <a href="https://github.com/earendil-works/pi">Pi</a> coding agent.<br>Ask about the page you're on, sort out your tabs, or have Pi click, type and read its way through the web.</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#make-it-yours">Make it yours</a> ·
  <a href="#develop">Develop</a> ·
  <a href="LICENSE">MIT</a>
</p>

<p align="center"><img src=".github/assets/screenshot.webp" alt="Ardi in Ardia's side panel, introducing the page the user is on"></p>

<br>

## Features

- **Works across your tabs.** It can list, read and open tabs, look at the images on them, and run anything else through `ardia exec`.
- **Mention tabs with @.** Type `@` to pick an open tab; it goes into your message as a chip, and Pi reads it.
- **Keeps working when the panel is closed.** Pi lives in the background, not in the panel.
- **Every chat is a Pi session.** Switch chats and pick up exactly where you left off.
- **Shows its work.** Tool calls and thinking fold into a compact "Worked for 12s" summary above the answer.
- **Isolated.** It runs with its own prompt, tools and skills, separate from your own Pi setup.

## How it works

```
side panel ⇄ background worker ⇄ native messaging ⇄ bridge (bun) ⇄ pi --mode rpc
```

Extensions can't start local programs, so a small bridge runs Pi and streams its events back. Pi's session files under `~/.pi/agent/sessions` are the record of each chat; the extension only keeps the chat list. One build puts all of it in `dist/`: the extension, the bridge and Pi's setup.

## Quick start

You need Ardia with Settings › "Let the ardia command control Ardia" turned on, plus [bun](https://bun.sh) and Pi.

```sh
bun install
bun run build
bun run host:install   # registers the bridge with the browser, once
```

Then open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, pick `dist/`, and click the Ardi toolbar icon.

## Make it yours

| What | Where |
| --- | --- |
| **Prompt** | `src/agent/system-prompt.md` is Pi's entire system prompt. |
| **Tools** | Browser tools are in `src/agent/extension/index.ts`, alongside Pi's built-in tools. |
| **Your instructions** | Write them in `~/.ardi/AGENTS.md`; they apply from your next new chat. |
| **Skills** | Drop them in `~/.ardi/.agents/skills/`; they show up in your next new chat. |
| **Which Pi** | Set the Pi CLI path in Settings (the sliders button); leave it empty to use the Pi `host:install` found. |

Rebuild after editing the prompt or tools, then reload the extension.

## Develop

```sh
bun run dev        # rebuild on change, then reload the extension
bun test           # unit + integration tests, with a fake Pi and a fake Chrome
bun run lint       # oxlint, type-aware
bun run typecheck
```

Contributor and agent guidelines are in [`AGENTS.md`](AGENTS.md). The bridge's Pi runtime is adapted from [Claudian](https://github.com/YishenTu/claudian).

## License

[MIT](LICENSE)
