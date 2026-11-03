# Changing Ardia itself

Use these when the user asks Ardia to do something to itself (its tabs, windows, layout, settings, theme), to change a site every time they visit it, or to react to what happens in Ardia, instead of working through a web page. They run in bash; `ardia <command> --help` explains each.

## Ardia's commands

`ardia run` runs one of Ardia's menu items or shortcuts, exactly as the user would: new or private window, reopen closed tab, select tab 3, duplicate, pin, mute, split pane, merge all windows, sidebar side, tabs on top, appearance, zoom, copy URL as Markdown and the rest. `ardia commands` lists them with their variants.

```sh
ardia commands
ardia run newWindow
ardia run selectTab 3
ardia run setAppearance dark
ardia windows --json
```

A command acts on the last focused window, or on `--window ID` with an id from `ardia windows`. `ardia windows` lists every window with its tabs (url, title, active, pinned, group), private windows never included. These ids belong to Ardia, not to CDP: they don't match the tab ids from `list_tabs`, so match tabs across the two by URL.

Inside `ardia_exec` the same is `await run("selectTab", "3")`, `await windows()` and `async for e in events("tab.navigated")`. `run` raises `CommandError` when Ardia refuses.

Ask first, as for anything with consequences, before commands that close or lose things (`closeTab`, `closeAllTabs`, `clearBrowsingData`) or that open settings dialogs.

## Settings and themes

When the user wants a setting changed for good, edit `~/.config/ardia/config.json` with `ardia config` instead of clicking through Settings. Ardia reads the file at launch and whenever it changes; these commands don't need Ardia running.

```sh
ardia config list
ardia config set tabLayout top
ardia config set shortcuts.newTab cmd+shift+n
ardia config unset tabLayout
ardia config check
```

`ardia config init` creates the file when there is none. `list` shows every setting with its allowed values, default and file value. Shortcuts are one per command (`''` unbinds). `unset` leaves Ardia's current value in place. Run `check` after a change.

Themes are colour overrides in `~/.config/ardia/themes/NAME.json`. `ardia theme new NAME` writes every dark and light role with Ardia's values: change only the roles the user asked about. `ardia theme use NAME` (or `none`) picks one, and `ardia theme check` checks it.

Ask before replacing a value or theme the user set themselves. Settings that grant control or send data somewhere (`cliControl`, custom search URLs, page engines) can't go in the file: tell the user where they are in Settings.

## Reacting to events

Ardia's events are `tab.opened`, `tab.closed`, `tab.activated`, `tab.navigated`, `window.opened`, `window.closed`, `window.focused` and `settings.changed`. A hook is a program run for each matching event, with the event's JSON on stdin and `ARDIA_EVENT`, `ARDIA_URL`, `ARDIA_TITLE`, `ARDIA_TAB_ID`, `ARDIA_WINDOW_ID` and `ARDIA_PROFILE` in its environment.

Keep hook programs in `~/.ardi/hooks/`. Try one with `ardia on`, which runs until interrupted (give the bash call a `timeout`), then add it to `~/.config/ardia/hooks.json`:

```sh
ardia on tab.navigated --match 'https://*.youtube.com/*' -- ~/.ardi/hooks/yt-hook
```

```json
{
  "hooks": [
    { "name": "yt-log", "on": ["tab.navigated"], "match": ["https://*.youtube.com/*"], "run": ["~/.ardi/hooks/yt-hook"], "timeout": 30 }
  ]
}
```

`run` is argv, not a shell line; use `["/bin/sh", "-c", "…"]` when you need one, and never paste event values into it. `match` takes userscript match patterns. `ardia hooks list` checks the file and shows whether hooks run at login. `ardia hooks install` makes them run at every login and keeps running after this chat: ask the user first. Their output goes to `~/Library/Logs/Ardia/hooks.log`.

## Userscripts

When the user wants a site to look or behave differently every time they visit it, write a userscript instead of driving the page by hand. `ardia scripts` takes TypeScript or JavaScript with a `==UserScript==` header, so existing `.user.js` files work too.

- Keep scripts in `~/.ardi/scripts/`. Start from `ardia scripts new NAME` (it writes `NAME.user.ts` in the current folder) or from a script the user already has.
- Read the real page before writing selectors, and keep the script small and robust to the site changing.
- Repeat `ardia scripts test FILE` until it passes cleanly on the pages it targets. It runs in a background tab of its own and reports what ran, what logged and what threw.
- Install with `ardia scripts install FILE` only once the user is happy with it. Install copies the built script into Ardia, so after editing the file, install it again. `ardia scripts list` and `ardia scripts uninstall NAME` manage what's installed.
