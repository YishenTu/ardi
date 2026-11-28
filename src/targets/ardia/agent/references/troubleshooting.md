# When ardia browse doesn't do what you expected

A failure ends with its code in brackets, `(stale_ref)`, and when one command fixes it, a `remedy:` line naming that command. The browser section of your instructions says where to run a remedy. These are the cases it doesn't cover.

## Input and elements

- `input_not_delivered`, or an outcome reported unknown (`outcome_unknown`): check the page before retrying, and never repeat a submit blindly. `target_replaced`: the page redrew the element first; find it again.
- `covered by <…>` (`covered`): act on the covering element first (close the dialog or editor), then retry. A click already dismisses cookie banners and scrolls past sticky headers by itself.
- A field that ignores `fill`: `focus @e1`, then `keyboard inserttext "text"` (`keyboard type` for keystrokes). With nothing focused, `keyboard inserttext` fails with `input_not_delivered`.
- `find role` with several matches clicks nothing and lists them with refs: use the one you mean, or add `--nth <n>` (from 0). One that matches nothing names the closest name and its ref when one is close.
- `select` lists two suggestions or none: pick an exact one. When it says no list is linked to the field, click the option with `find role option click --name "…"`.
- `drag` says whether it was an HTML5 drag and drop, one the target didn't accept, or a plain mouse drag. When its answer names no new place, check the list with `read -s <list>`.

## Refs

- A ref points only at the element it was issued for. A ref from a page that navigated or was replaced fails with `vocab_superseded`. One whose element left the same page (a redraw, an Ardia restart) fails with `stale_ref`, and one that now points at an element with another role or name fails with `ref_drifted` (nothing was done).
- Take a new `snapshot -i`, or use the ref the error names when the same element came back (`… is now @e19`), and rerun from that line.
- In a call, a later line whose ref went stale runs again on the new element if that was the only one with its role and name and one still is, and says so first (`↻ @e14→@e352`). Only the selector changes, never typed text.
- Long runs of one role fold into one line in change reports (`+ 48 options in combobox "Start time" (…; e8…e55)`); the refs in it work.

## Tabs, frames and sessions

- `no_session_tab`: the chat has no tab yet. Open one, or pick the user's with `here` or `tab active`.
- `tab_detached`: Ardia took the tab away mid-command (it closed, crashed or went to sleep). Run the command again; a multi-page `read` already retries that page. `tab_crashed`: `reload` or close it.
- `frame_gone`: the frame picked with `frame` is gone; `frame main` or pick another. `attaches_unanswered`: Ardia hasn't answered yet; retry, or end the call with `close`.
- `session_busy`: another command of this chat's is still running; wait for it rather than starting the same work again.
- `not_own_tab`: the command works only on tabs this chat opened (`perf --reload`, `logpoint`). Open the page with open_tab first.
- A current Ardia takes input in background tabs. On an older one that doesn't, the open answer says so and actions fail with the fix: `tab t3 --show` brings it forward. Snapshots, `read`, `get`, `eval`, screenshots, `scroll` and `wait` work in the background either way.

## Refused commands and older Ardia

- From Ardia 0.2.49 the ardia command is a full DevTools client of Ardia: no DevTools method is held back, and any `cdp` method works. Rules about tabs still apply.
- An older Ardia keeps it to a short list of methods. There cookies, `state save` (and `state load` of a file with cookies), `set device|geo|offline|headers|credentials|media|permission`, `network route`, `upload`, `download` and `wait --download`, `highlight`, `clipboard`, `trace`, `profiler`, `record`, `stream enable` and other `cdp` methods fail with `policy_refused` naming the method. Don't retry: ask the user to update Ardia, and until then to attach or download the file themselves. Use `screenshot` instead of `record`, and `storage local|session` or `eval` instead of cookies and `state`.
- `ardia_too_old`: this Ardia's engine lacks a method the command needs; ask the user to update.
- A refusal that says "which this Ardia allows for the ardia command, but not …" also comes from an older Ardia and is about the tab or address, not the command: it gives the reason. Pick another tab or open a web page.
- Not in ardia browse at all: connect, install, upgrade, doctor, dashboard, chat, mcp, profiles, confirm/deny, iOS and launch flags (`--headed`, `--profile`, `--proxy`…), since Ardia is the running browser.

## Sites the ad blocker blocks

A site that Ardia's built-in ad blocker blocks opens as uBlock Origin's "Page blocked" page, which ardia browse can't attach to, and `open` fails with `net::ERR_BLOCKED_BY_CLIENT` or `net::ERR_ABORTED`. When the user wants that site, run `ardia call sites.allowAds -p site=<host>` in bash (a site, not a public suffix like `co.uk`; it covers its subdomains in every profile), then `open` it again. `sites.adBlocker` lists the trusted sites and `sites.blockAds -p site=<host>` takes one out. An Ardia without these methods answers `unknown_method`, and one that can't make the change yet answers `refused`: then ask the user to turn off Block Ads & Trackers in Site Controls for that site.
