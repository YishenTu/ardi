# Changing Ardia itself

Use these when the user asks Ardia to do something to itself (its tabs and groups, windows, layout, settings, theme), to change a site every time they visit it, to react to what happens in Ardia, or about what they browsed, instead of working through a web page. They run in bash; `ardia <command> --help` explains each.

## Ardia's commands

`ardia run` runs one of Ardia's menu items or shortcuts, exactly as the user would: new or private window, reopen closed tab, select tab 3, duplicate, pin, mute, split pane, merge all windows, sidebar side, tabs on top, appearance, zoom, copy URL as Markdown and the rest. `ardia commands` lists them with their variants.

```sh
ardia commands
ardia run newWindow
ardia run selectTab 3
ardia run togglePin --window 2 --tab 5
ardia run setAppearance dark
ardia windows --json
ardia events tab.navigated
```

A command acts on the last focused window, or on `--window ID` with an id from `ardia windows`. `ardia windows` lists every window with its tabs (url, title, active, pinned, group), private windows never included. Its `tab-…` ids also work in ardia_exec's `tab tab-…`.

Ask first, as for anything with consequences, before commands that close or lose things (`closeTab`, `closeAllTabs`, `clearBrowsingData`) or that open settings dialogs.

## Tabs and groups

To organize tabs (open, move, nest, pin, rename, set icons and colours, mute, sleep, close), use `ardia tabs` and `ardia groups` instead of `ardia run` or the sidebar. They act on tabs and groups by id without changing the tab a window shows. Read the workspace first:

```sh
ardia tabs --json        # windows › spaces (one per profile) › topApps, pinned, tabs; groups nest with items
ardia tabs --flat --json # one object per tab: id, url, title, pin, group, window, profile, active, asleep
ardia groups --json      # every group: id, name, icon, color, collapsed, pinned, parent, depth, tabs
```

```sh
ardia tabs open https://a.example https://b.example --group Work  # background tabs, in that group
ardia tabs move tab-1 tab-2 --group Work                           # into a group, by name or id
ardia tabs move tab-3 --top                                        # out of every group
ardia tabs move tab-4 --after tab-9                                # next to a tab, in its group
ardia tabs pin tab-5 --row ; ardia tabs sleep tab-6 ; ardia tabs rename tab-7 "Inbox"
ardia groups create tab-1 tab-2 --name Work --icon 🚀 --color blue --unpinned
ardia groups update Work --collapse ; ardia groups move Reading --parent Work ; ardia groups ungroup Imported
```

For a whole layout, send one `ardia apply` with a JSON list on stdin, where `$N` is what operation N made (its group, else its tabs). It checks every operation first, runs them in order and stops at the first that fails, saying which ran. With `--json` it returns the resulting tabs and groups: verify from that.

```sh
ardia apply --json <<'EOF'
[{"op": "group.create", "urls": ["https://a.example", "https://b.example"], "name": "Research", "pinned": false},
 {"op": "group.create", "parent": "$0", "tabs": ["tab-7", "tab-8"], "name": "Papers", "icon": "📚"},
 {"op": "group.update", "group": "$1", "collapsed": true},
 {"op": "tab.move", "tabs": ["tab-9"], "group": null}]
EOF
```

- Group arguments take a name (case-insensitive, in that window) or an id; a name two groups share fails with both ids.
- New groups are pinned, as in the sidebar, unless `"pinned": false` or they have a `parent`. Icons: an emoji from Ardia's picker or `symbol:<SF Symbol>`. Colours: neutral, none, grey, blue, red, yellow, green, pink, purple, cyan, orange.
- URLs: http, https, file, about:blank and ardia://history, bookmarks, downloads, newtab only.
- `groups close` keeps a group in History › Recently Closed Groups; `groups delete` doesn't. Shared-folder groups and private windows are refused. Ask before closing or deleting tabs or groups the user didn't name.

## History and pinned tabs

Read these only when the request is about what the user browsed ("what did I read yesterday", "that article I saw this week") or what they keep pinned.

```sh
ardia history --days 1 --limit 200 --json
ardia history --days 7 --domains --json
ardia pinned --json
```

`history` lists pages newest first (`url`, `title`, `visits` in the window, `total_visits`, `last_visit`, `profile`; `--profile P` for one profile); `--domains` rolls it up per domain, most visited first. Only http(s) pages, never private windows. `pinned` lists pinned tabs and favorites.

## Settings and themes

When the user wants a setting changed for good, edit `~/.config/ardia/config.json` with `ardia config` instead of clicking through Settings. Ardia reads the file at launch and whenever it changes, and never writes it; these commands don't need Ardia running.

```sh
ardia config init
ardia config list
ardia config set tabLayout top
ardia config set shortcuts.newTab cmd+shift+n
ardia config unset tabLayout
ardia config check
```

`init` creates the folder, `config.json` and the schemas when there are none. `list` shows every setting with its allowed values, default and file value. Shortcuts are one per command (`''` unbinds). `unset` leaves Ardia's current value in place. Run `check` after a change. To land on a new tab at launch while keeping the session: `ardia config set launchActions '["newTab"]'`.

Themes are colour overrides in `~/.config/ardia/themes/NAME.json`. `ardia theme new NAME` writes every dark and light role with Ardia's values: change only the roles the user asked about. `ardia theme use NAME` (or `none`) picks one, and `ardia theme check` checks it.

Ask before replacing a value or theme the user set themselves. Settings that grant control or send data somewhere (`cliControl`, custom search URLs, page engines) can't go in the file: tell the user where they are in Settings.

## Hooks

A hook reacts to the browser (a tab opening, a page loading, media starting, a tab going idle, the Mac waking) or runs on a schedule. Hooks live in `~/.config/ardia/hooks.json`; keep the programs they run in `~/.ardi/hooks/`.

```json
{
  "hooks": [
    { "name": "yt-log", "on": ["tab.navigated"], "match": ["https://*.youtube.com/*"], "run": ["~/.ardi/hooks/yt-hook"], "timeout": 30, "fullUrls": true },
    { "name": "park", "on": "tab.idle", "idle": "2h", "command": "togglePin" },
    { "name": "standup", "at": "09:55", "days": ["mon", "tue", "wed", "thu", "fri"], "run": ["~/.ardi/hooks/standup"] },
    { "name": "old-reddit", "on": "tab.opening", "rewrite": [{ "match": "https://www.reddit.com/*", "to": "https://old.reddit.com{path}{query}" }] },
    { "name": "no-camera", "on": "permission.requested", "kinds": ["camera"], "permission": "deny" }
  ]
}
```

- A hook has one trigger (`on` an event, `at` a time with optional `days`/`timezone`, `every`, or `omnibox`) and one action: `run` (argv), `command` (an Ardia command id, with `arg`, run in the event's window and tab, no process), or a decide answer.
- A `run` program gets the event's JSON on stdin and `ARDIA_EVENT`, `ARDIA_URL`, `ARDIA_TITLE`, `ARDIA_TAB_ID`, `ARDIA_WINDOW_ID` and `ARDIA_PROFILE` in its environment. Those values come from pages: a program that prints them to a terminal must escape control characters. `ardia events --help` lists every event. URLs arrive without their query and fragment unless the hook says `"fullUrls": true`. Notification and presence events (`user.idle`, `app.activated`, `system.sleep`…) come only when named, never through `"*"`. `match` takes userscript match patterns.
- `run` is argv, not a shell line; use `["/bin/sh", "-c", "…"]` when you need one, and never paste event values into it.
- Decide hooks answer before Ardia acts: `tab.opening` (`rewrite`, `cancel`), `link.opening` from other apps (`route`, `drop`, `from`), `download.deciding` (`folder` under `~/Downloads`), `permission.requested` (`permission`: deny or ask). As rules, Ardia applies them itself; with `run`, the program's stdout JSON is the answer, within 250 ms for openings. Anything late or invalid means Ardia's default.
- Rules that rewrite to another site, route links, pick a folder outside Downloads, run a decide program or read the address bar (`omnibox`) stay off until the user approves them in Settings › Advanced › Automation. Tell the user that after writing one.

Try an event hook with `ardia on`, which runs until interrupted (give the bash call a `timeout`): `ardia on tab.navigated --match 'https://*.youtube.com/*' -- ~/.ardi/hooks/yt-hook`. `ardia hooks list` checks the file and shows whether hooks run at login. `ardia hooks install` makes them run at every login and keeps running after this chat: ask the user first. Their output goes to `~/Library/Logs/Ardia/hooks.log`.

## Userscripts

When the user wants a site to look or behave differently every time they visit it, write a userscript instead of driving the page by hand. `ardia scripts` takes TypeScript or JavaScript with a Violentmonkey `==UserScript==` header, so existing `.user.js` files work too.

- Keep scripts in `~/.ardi/scripts/`. Start from `ardia scripts new NAME` (it writes `NAME.user.ts` in the current folder) or from a script the user already has.
- Read the real page (read_tab, or `snapshot` and `get html <sel>` in ardia_exec) before writing selectors, and keep the script small and robust to the site changing.
- Repeat `ardia scripts test FILE` until it passes cleanly on the pages it targets. It runs in a background tab of its own and reports what ran, what logged and what threw.
- Install with `ardia scripts install FILE` only once the user is happy with it. Install copies the built script into Ardia, so after editing the file, install it again. `ardia scripts list` and `ardia scripts uninstall NAME` manage what's installed.
