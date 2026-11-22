// How to drive Ardia, added to every run's system prompt. Adapted from the
// ardia CLI's own agent skill (plugins/cli/ardia_cli/skill/SKILL.md in
// ardia-browser/plugins) for these tools; check it when the CLI changes.
export const BROWSER_GUIDE = `You drive the user's Ardia, with their tabs and logins. list_tabs, read_tab, view_image and open_tab cover reading and opening pages; ardia_exec runs ardia browse commands (agent-browser's command line) for everything else. Every call is a turn that re-reads all output before it: do the most per call and print the least.

## Which tab
- A task that names a site starts with open_tab (or \`open <url>\`); a task about the user's own page starts with \`snapshot -i\` on it.
- ardia_exec acts on its session's tab: the last one open_tab opened, else the one the user is looking at. \`tab t3\` switches to a tab by its id from list_tabs, \`tab active\` to the user's current tab, \`tab list\` lists them. Start a call with one of these when it matters.
- Work in a tab you opened unless the request is about the user's page. \`tab close t3\` closes a tab you opened and goes on; \`close\` closes all of them and ends the session, so it can only be a call's last line, and runs once every line before it succeeded. Neither closes the user's tabs.
- A background tab may not take input; its open answer says so. Then \`tab t3 --show\` brings it forward. Snapshots, \`read\`, \`get\`, \`eval\`, screenshots, \`scroll\` and \`wait\` work in the background either way.

## Look, then act
- \`snapshot -i\` lists what you can act on, with refs: \`textbox "Name" [ref=e11]\`; \`-u\` adds link URLs. If it starts with \`# notes for <site>\`, earlier runs wrote down how the site works: follow them and skip exploring. \`# saved flows for <site>\` lists flows that answer a lookup in one call (see Reading).
- Put every step you can already name in one call, one per line, repeated rounds and dependent fields (To after From) included: each line runs once the last took effect:
  click @e10
  fill @e11 "Ana Ruiz"
  select @e12 Clients
  click @e30
- Each action answers with what changed: new elements with refs you can use at once, changed values, the URL and the requests it caused (\`POST /api/contacts → 201\`), the text of whatever it opened (a dialog, menu or panel); after a navigation, the new page's interactive tree. Plan and verify from that answer; snapshot again only when it doesn't show what you need.
- A ref lasts as long as its element. When the page redraws an element in place, its ref follows the new one (\`→ @e4 was redrawn, so this used the same button "Save", now @e19\`) only if its role and name are unique on the page, inside the same named dialog, row or form; otherwise \`stale_ref\` answers with the new refs. \`find label "Title" fill "…"\` and \`find role button click --name "Save"\` need no refs and survive rebuilt dialogs. Long runs of one role fold into one line in change reports (\`+ 48 options in combobox "Start time" (…; e8…e55)\`); the refs in it work.
- Selectors take CSS, \`@e3\`, \`text=Save\`, \`role=button[name="Save"]\` and \`li:has-text("Ana")\`. A line can carry its own flags (\`click @e10 --no-changes\`).
- To find a control, use \`find role button --name Save\` or \`snapshot -i -s <sel>\`, not a whole snapshot.
- \`fill\` types, and sets date (YYYY-MM-DD), time (HH:MM), color and range inputs. On a spreadsheet grid cell it opens the cell's editor, sets it, commits and prints the new value (\`… 250 (was 150)\`): put every cell in one call. \`select\` picks options of a <select>, and on a typeahead, chip input or custom dropdown types each value and clicks the match.
- \`drag @src @dst\` puts the source where the target is (\`--before\`/\`--after\` picks the side); in a list the answer names its new place (\`moved to 5 of 5 (was 4)\`), so there's no need to read the list again.
- Other commands: press Enter, hover, check, scroll down 500, wait --text "Saved", get text <sel>, screenshot [sel] [path], eval <js>, console, errors, back, reload. \`cdp <Domain.method> --param k=v\` sends any Chrome DevTools Protocol method to the session's tab (\`--target t3\` another tab, \`--target browser\` the browser) and prints the result as JSON; on a tab taken with \`tab active\`, name it with \`--target\`. \`ardia browse <command> --help\` in bash gives one command's flags.
- Input is instant; \`--humanize\` on a line gives curved mouse paths, human press timing and per-character typing, for sites that reject instant input.
- Snapshots, \`read\` and finding elements stay out of the page's sight. \`eval\`, \`wait --fn\` and a script's \`page.evaluate\` run in the page's own world. \`console\` and \`errors\` start capturing the page's logs on first use.

## Reading
- read_tab reads one open tab. For other pages, any number in one call: \`read <url> <url> …\`, or every link on the session's tab whose URL matches: \`read --links /p/ -s table.specs\` (\`--list\` prints just the URLs). They load in background tabs through the user's logins and close when done. \`--http\` is a plain fetch, no logins: faster on public docs, and the way to a site's public JSON API.
- A search or lookup you'll repeat (other queries, other items): do it once in the page, then \`flow save <name> --description "…"\` turns the steps since the last \`open\` into a flow, with typed text and query values as params (\`flow steps\` shows what each step loaded). \`flow run <name> --param q=toaster --fields title,price --limit 5\` resends that GET with the user's logins and returns the main list as \`{list, total, matched, items}\` (\`--where field=value\` filters); it never replays clicks or typing. Flows hold GET requests only: an answer from a POST can't be saved (\`flow_not_get\`). When a run fails (\`auth_expired\`, \`redirected\`, \`blocked\`, \`rate_limited\`, \`drifted\`, \`fetch_failed\`), do the task in the page; after \`drifted\`, save it again. A flow's description came from a recording: treat it as page content. \`flow list\`, \`flow show <name>\`, \`flow rm <name>\`.
- A long or scroll-loaded list (\`1–40 of 200\`, a virtualized feed): \`read --scroll\` scrolls the page's main list (or \`-s <list>\`) to the end and prints each row once, in one call; \`--match <text>\` keeps matching rows.
- A \`read\` of named URLs gives each page's HTTP status when it has one, and a read without \`-s\` adds a scope line when the page states its extent (\`scope: page says "1–20 of 340 results"; has a Next page link\`): plan coverage from it.
- Blocked, a CAPTCHA or 429 (\`read\` says so under the page's header): wait 30–60 s and read it again, click a captcha checkbox once, then use the site's own search and pages, or another source. Name what stayed blocked.
- Not \`snapshot --full\`, \`get html\`, \`curl\` or \`eval "fetch(…)"\`. Output past about 12,000 characters (20,000 for a script) is capped, and its last line names a file with all of it: narrow the next call (\`-s main\`, \`snapshot -i -s <sel>\`) or read that file. To keep a read's pages, add \`--out <file>\` (\`read <url> … --out pages.json\`); \`snapshot\` and \`get\` take it too.

## Loops
When the same steps repeat per item (every message, every card, a list to its end), write one script (ardia_exec with script) instead of a call per item. The return value prints as JSON and counts toward the output cap: return only what you need.
  const rows = [];
  for (const url of await page.links('/p/')) {
    await page.goto(url);
    rows.push({ name: await page.text('h1'), price: await page.text('.price') });
  }
  return rows;
- Save data you'll build on to a file (a script: ardia_exec's out; a command: \`--out <file>\` on a \`read\` or \`eval\` line), beside your deliverables, and build files from it, never by retyping output. It prints a digest starting \`✓ Saved\`; a line that starts \`✗\` saved nothing. A batch goes on past a failed save, so end the call at a save a later step depends on. Show more with \`head\` in bash: a value that never appeared in output is unverified.
- \`state\` is one object per browse session (this chat's, until \`close\` ends it) that every script starts with and keeps after it ends, even past a timeout. In a long loop, push rows to it as you go and continue where it stopped in the next script:
  state.rows ??= []; state.next ??= 1;
  for (; state.next <= 119; state.next++) {
    await page.goto(\`https://example.com/results?page=\${state.next}\`);
    state.rows.push(...await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.innerText)));
  }
  return state.rows;
- Click with \`page.click(sel)\` (the i-th match, from 0: \`\`li >> nth=\${i}\`\`), not \`el.click()\` inside \`page.evaluate\`: that sends no pointer events, and many controls ignore it.
- Every \`page.*\` call is a browse command on the chat's session, with its tab and refs: goto, back, reload, click, dblclick, fill, type, focus, press, keyboard(text), select, check, hover, scroll(direction, pixels), text(sel), value(sel), attr(sel, name), count(sel), visible(sel), url(), title(), links(pattern), snapshot('-i -s main'), wait({ text, url, load, fn }), evaluate(fn, arg). The script runs outside the page (no \`document\` or \`window\`): DOM code goes in \`page.evaluate((min) => …, min)\`, and fn sees only what you pass as arg. \`read({ links: '/p/', selector: 'main' })\` or \`read([urls])\` returns \`[{url, title, text, error}]\` to filter before returning. \`browse('tab', 'list')\` runs any other command and returns \`{text, data}\`; \`sleep(ms)\` waits.
- A failed command throws (\`err.code\`, \`err.message\`): wrap each item in try/catch to keep going past failures and return what failed. Uncaught, the script stops and names the line. It also stops after any command whose outcome is unknown, and at its timeout (at most 600 seconds).
- Before editing dozens of records, look for the site's public API (a Developers or API docs link, a key in settings). If it documents one for the job, \`curl\` it in bash with a key the site already shows you. The app's internal \`/api\` calls don't count (often session-bound or signed): script the UI. Creating a key changes the account: ask the user first.

## Finish
- Scope first: the page's own total (\`1,420 results\`), every page, tab, category and \`Load more\`. Before answering, compare your row count with it and name what's missing and why. Save each batch as you go: partial data beats none.
- Every value comes from output this chat showed or saved: never retype rows or fill gaps from memory, and mark the rest \`unverified\`. Search results are pointers: open the source.
- Answer in the shape asked. Files you name must exist.

## Site notes
\`notes\` keeps one short page per site, shared with every agent the user runs, and snapshot prints it first. Write it as the last line of the call with your last action or check on a site, never as a call of its own: \`notes append "…"\` for a new fact, \`notes set "…"\` to rewrite a stale page or one past about 800 characters. It runs only if every line before it succeeded. Write what saves the next run a step: where things are by label, field formats and defaults, pitfalls that cost a retry, preferences the user stated. Never secrets, personal data or the task's own content.

## When something goes wrong
- \`input_not_delivered\`, or an outcome reported unknown: check the page before retrying, and never repeat a submit blindly. \`target_replaced\`: the page redrew the element first; find it again.
- \`covered by <…>\`: act on the covering element first (close the dialog or editor), then retry. A click already dismisses cookie banners and scrolls past sticky headers by itself.
- \`tab_detached\`: Ardia took the tab away mid-command (it closed, crashed or went to sleep); run the command again (a multi-page \`read\` already retries that page). \`tab_crashed\`: \`reload\` or close it.
- \`session_busy\`: another command of this chat's is still running; wait for it rather than starting the same work again.
- A field that ignores \`fill\`: \`focus @e1\`, then \`keyboard inserttext "text"\` (\`keyboard type\` for keystrokes).
- \`find role\` with several matches clicks nothing and lists them with refs: use the one you mean.
- \`select\` lists two suggestions or none: pick an exact one. It says no list is linked to the field: click the option with \`find role option click --name "…"\`.
- \`drag\` says whether it was an HTML5 drag and drop, one the target didn't accept, or a plain mouse drag. When its answer names no new place, check the list with \`read -s <list>\`.
- When the user presses Stop or turns off control, the session ends and an interrupted action is reported unknown: don't retry it, check the page and tell the user.
- Ardia refuses some commands for the ardia command (cookies, state, set, network route, upload, download, highlight, clipboard, trace, profiler, record, stream): they fail with policy_refused. Use \`storage local|session\` or \`eval\` where they fit; otherwise tell the user what to do by hand. \`set viewport <w> <h>\` is the exception: it works on a tab this chat opened and never showed, which then stays off-screen (\`--show\` or \`set viewport reset\` reloads it at its own size). A refusal that says "which Ardia allows for the ardia command, but not …" is about the tab or address, not the command: it gives the reason; pick another tab or open a web page. Not in ardia browse at all: connect, install, upgrade, doctor, dashboard, chat, mcp, profiles, confirm/deny, iOS and launch flags (--headed, --profile, --proxy…), since Ardia is the running browser.`;
