# Writing `ardia_exec` code

`ardia_exec` runs Python against the user's Ardia with top-level `await`. The value of the last expression is returned: strings as they are, anything else as its repr. Every call is a new process, so nothing carries over between calls: find your tab again by id or URL.

## In scope

- `tab`: the web page the user is looking at when the run starts. On New Tab or another Ardia view, any use of `tab` raises `NoPageTab` (and `bool(tab)` is False).
- `tabs`: every web page tab when the run starts, the user's own included, plus the ones `new_tab` opens.
- `new_tab(url, background=True)`: opens a tab, waits for the page to load and returns it. `background=False` switches the user to it.
- `js(expression, tab=None)`: evaluates JavaScript and returns its value (awaiting promises; raises on a JavaScript error). Pass `tab=t` for your own tab; without it, `js` uses the user's tab, else the last tab you opened.
- `browser` (pydoll `Chrome`), `By`, `Key`, `asyncio` and the rest of pydoll's exports. Full API: the sibling `pydoll.md` file (its absolute path is in the ardia_exec tool description).

## Tab ids

The ids from `list_tabs`, `read_tab` and `open_tab` are `t._target_id`:

```python
t = [t for t in tabs if t._target_id == "294DD1E1F987F72DB22368D4C22BB583"][0]
```

## Recipes

Find, click and type:

```python
t = await new_tab("https://example.com/search")
box = await t.query('input[name="q"]', timeout=10)
await box.type_text("ardia browser\r")
await t.wait_for_url("**?q=*", timeout=15)
results = await t.query("h3", find_all=True)
[await r.text() for r in results[:5]]
```

`query` takes CSS or XPath; `find(tag_name=..., id=..., class_name=..., name=..., text=..., **attributes)` builds the selector for you. Both wait up to `timeout` seconds. When the element isn't there they raise `ElementNotFound` (`timeout=0`, the default) or `WaitElementTimeout` (with a timeout), or return `None` with `raise_exc=False`.

A click that loads a new page:

```python
async with t.expect_navigation():
    await (await t.find(tag_name="a", text="Next")).click()
```

Wait for things:

```python
await (await t.query("#results", timeout=10)).wait_until(is_visible=True, timeout=10)
await t.wait_for_script("document.readyState === 'complete'", timeout=10)
await t.wait_for_network_idle(timeout=15)
```

Extract structured data with JavaScript:

```python
await js("[...document.links].slice(0, 20).map(a => ({text: a.innerText, href: a.href}))", tab=t)
```

Screenshots and PDFs go to a file (keep them in your working folder):

```python
await t.take_screenshot("shot.png")                        # viewport
await t.take_screenshot("full.png", beyond_viewport=True)  # whole page
await (await t.query("main")).take_screenshot("main.png")  # one element
await t.print_to_pdf("page.pdf")
```

Close your tab when you're done: `await t.close()`.

## Gotchas

- Tab and element methods are coroutines: `await t.title()`, `await t.current_url()`, `await el.text()`. `el.get_attribute("href")` is a plain call and `el.tag_name` a plain property.
- An `await` inside a generator expression makes it async, so `next(... await ...)` fails. Use a list comprehension.
- Type with `type_text` (real key events) when a page listens for keys; `insert_text` is faster for plain fields. End typed text with `"\r"` to press Enter in a field; `keyboard.press(Key.ENTER)` sends no character.
- Background tabs are hidden, so pages there may throttle timers and animations. Screenshots still work.
- Only web pages are reachable (http, https, `about:blank`, `data:`, `blob:`): not `file://`, `chrome://`, extension pages or Ardia's own views. Calls that read cookies, storage or saved data, change settings or permissions, intercept requests or touch local files fail with `ardia: <Method> isn't allowed for the ardia command`.
- `browser.stop()` is refused; `ardia_exec` never quits Ardia.
