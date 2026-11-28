# ardia browse scripts

A script (ardia_exec with `script`) is one call that does what would otherwise be a command per item. `ardia browse script --help` in bash lists every call.

## The API

- Every `page.*` call is a browse command on the chat's session, with its tab and refs: goto, back, reload, click, dblclick, fill, type, focus, press, keyboard(text), select, check, hover, scroll(direction, pixels), text(sel), value(sel), attr(sel, name), count(sel), visible(sel), url(), title(), links(pattern), snapshot('-i -s main'), wait({ text, url, load, fn }), evaluate(fn, ...args).
- Actions wait for the page to settle but print no change report; pass `{ receipt: true }` as the last argument when you need one.
- The script runs in a sandbox outside the page (no `document`, `window`, files, modules or network). DOM code goes in `page.evaluate((min, column) => …, min, column)`, and fn sees only the JSON values you pass.
- `page.$$eval(sel, fn, ...args)` hands fn every match (`page.$eval` the first): the quickest way to a whole list. There are no element handles: read with `$$eval`, act with a selector.
- Reads (text, attr, evaluate, $eval, $$eval, read) run together under `Promise.all`; actions run one at a time, in order.
- `page.frames()` lists frames (url, name, main), each with evaluate, $eval and $$eval.
- The global `read({ links: '/p/', selector: 'main' })` or `read([urls])` returns rows `{url, finalUrl, title, status, text}` (with `error` when a page failed) to filter before returning. `page.read()` returns the session tab's text as a string.
- `browse('tab', 'list')` runs any other command and returns `{text, data}`; `sleep(ms)` waits.
- Click with `page.click(sel)` (the i-th match, from 0: ``li >> nth=${i}``), not `el.click()` inside `page.evaluate`: that sends no pointer events, and many controls ignore it.

## Recipes

One filter after another:

```js
const out = {};
for (const tag of ['Books', 'Music']) {
  await page.click(`text=${tag}`);
  out[tag] = await page.$$eval('.item', (es) => es.map((e) => e.innerText));
}
return out;
```

Each linked page:

```js
const rows = [];
for (const url of await page.links('/p/')) {
  await page.goto(url);
  rows.push({ name: await page.text('h1'), price: await page.text('.price') });
}
return rows;
```

## Saving and resuming

- The return value prints as JSON and counts toward the output cap (20,000 characters): return only what you need.
- Save data you'll build on to a file with ardia_exec's `out`, beside your deliverables, and build files from it, never by retyping output. It prints a digest starting `✓ Saved`; a line that starts `✗` saved nothing. Show more with `head` in bash: a value that never appeared in output is unverified.
- `state` is one object per browse session (this chat's, until `close` ends it) that every script starts with and keeps after it ends, even past a timeout. In a long loop, push rows to it as you go and continue where it stopped in the next script:

```js
state.rows ??= []; state.next ??= 1;
for (; state.next <= 119; state.next++) {
  await page.goto(`https://example.com/results?page=${state.next}`);
  state.rows.push(...await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.innerText)));
}
return state.rows;
```

## Failures and limits

- A failed command throws (`err.code`, `err.message`): wrap each item in try/catch to keep going past failures and return what failed. Uncaught, the script stops and names the line.
- It also stops after any command whose outcome is unknown, and at its timeout (ardia_exec's `timeout`, at most 600 seconds). Give a slow multi-page script a long timeout: killed, it prints nothing.

## A site's public API

Before editing dozens of records, look for the site's public API (a Developers or API docs link, a key in settings). If it documents one for the job, `curl` it in bash with a key the site already shows you. The app's internal `/api` calls don't count (often session-bound or signed): script the UI. Creating a key changes the account: ask the user first.
