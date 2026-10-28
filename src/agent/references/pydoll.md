# pydoll 3.0 API for `ardia exec`

Every method below is a coroutine (`await` it) unless marked as a property. Checked against pydoll-python 3.0.0.

## Tab

| Call | What it does |
| --- | --- |
| `go_to(url, timeout=300)` | Navigate and wait for the load. Raises `NavigationError`, `PageLoadTimeout`. |
| `refresh(ignore_cache=False)` | Reload and wait for the load. |
| `current_url()`, `title()`, `page_source()` | The URL, the title, the HTML. |
| `find(id=, class_name=, name=, tag_name=, text=, timeout=0, find_all=False, raise_exc=True, **attributes)` | Find by attributes (`data_testid="x"` matches `data-testid`). |
| `query(expression, timeout=0, find_all=False, raise_exc=True)` | CSS or XPath. Not found: `ElementNotFound` with `timeout=0`, `WaitElementTimeout` with a timeout, `None` with `raise_exc=False`. |
| `execute_script(script, return_by_value=None, await_promise=None)` | Raw `Runtime.evaluate`; the value is at `response["result"]["result"]["value"]`. `js()` is shorter. |
| `wait_for_script(script, timeout=30)` | Poll until the expression is truthy; returns it. |
| `wait_for_url(pattern, timeout=30)` | Glob (`*` stops at `/`, `**` doesn't: `"**/checkout/*"`), compiled regex or callable. |
| `wait_for_network_idle(idle_time=0.5, timeout=30)` | No requests in flight for `idle_time` seconds. |
| `async with expect_navigation(url=None, timeout=30):` | Act inside the block; it exits once the new page has loaded. |
| `take_screenshot(path, quality=100, beyond_viewport=False, as_base64=False)` | Format from the extension (png, jpeg, webp). |
| `print_to_pdf(path, landscape=False, print_background=True, scale=1.0)` | PDF of the page. |
| `has_dialog()`, `get_dialog_message()`, `handle_dialog(accept, prompt_text=None)` | JavaScript alerts and prompts. |
| `bring_to_front()` | Show this tab to the user. |
| `close()` | Close the tab. Only for tabs you opened. |
| `keyboard.press(Key.ENTER, modifiers=None)`, `keyboard.hotkey(Key.META, Key.A)`, `keyboard.type_text(text)` | Keys to the focused element. Modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. `press` sends no character: type `"\r"` to submit a form. |
| `scroll.to_bottom()`, `scroll.to_top()`, `scroll.by(ScrollPosition.DOWN, 500)` | Scrolling (`from pydoll.constants import ScrollPosition`). |
| `get_cookies()` | This tab's cookies. Only when the user asks. |

## WebElement (from `find` or `query`)

| Call | What it does |
| --- | --- |
| `text()` | Visible text. |
| `inner_html()` | The element's HTML. |
| `get_attribute(name)` | Attribute value (plain call, not a coroutine). |
| `tag_name`, `id`, `class_name`, `value`, `attributes`, `is_enabled` | Properties from when it was found. |
| `click(x_offset=0, y_offset=0)` | Real mouse click at the element's centre. |
| `click_using_js()` | `element.click()` in the page, for elements under overlays. |
| `type_text(text)` | Clicks the element, then types key by key. |
| `insert_text(text)` | Inserts the text at once. |
| `clear()`, `focus()`, `hover()`, `scroll_into_view()` | |
| `wait_until(is_visible=, is_interactable=, is_hidden=, is_detached=, is_enabled=, timeout=0)` | Wait for every condition set to True. |
| `is_visible()`, `is_interactable()`, `is_editable()` | Checks. |
| `take_screenshot(path, quality=100)` | Screenshot of the element. |
| `find(...)`, `query(...)` | Search inside the element. |
| `get_parent_element()`, `get_children_elements(max_depth=1)`, `get_shadow_root()` | Walk the tree. |
| `set_input_files(paths)` | File inputs. |

## Browser

`browser.get_targets()` lists every target (raw dicts). Don't call `set_download_path`, `set_download_behavior`,
`grant_permissions`, `set_cookies`, `delete_all_cookies` or `create_browser_context` unless the user asks: they change
the user's own browser. `browser.stop()` is refused.

## Exceptions

`ElementNotFound`, `WaitElementTimeout`, `WaitTimeout`, `PageLoadTimeout`, `NavigationError` and
`ScriptEvaluationError` are in scope (they live in `pydoll.exceptions`).
