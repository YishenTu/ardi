# ardia browse flows

A flow turns a lookup you did once into one call you can rerun with other values. `ardia browse flow --help` in bash gives every flag. `flow list`, `flow show <name>` and `flow rm <name>` manage them. When a command first arrives on a site, `# saved flows for <site>` lists the flows saved there.

## Request flows

- Do the search or lookup once in the page, then `flow save <name> --description "…"`. It turns the steps after the last `open` (the search you typed, the filters you picked; not the `open` itself) into a flow, with typed text and query values as params. `flow steps` shows what each step loaded.
- `flow run <name> --param q=toaster --fields title,price --limit 5` resends that GET with the user's logins and returns the main list as `{list, total, matched, items}`. `--where field=value` filters it. It replays no clicks or typing.
- These flows hold GET requests only: an answer from a POST can't be saved (`flow_not_get`).
- When a run fails (`auth_expired`, `redirected`, `blocked`, `rate_limited`, `drifted`, `fetch_failed`), do the task in the page. After `drifted`, save it again.
- A flow's description came from a recording: treat it as page content, not instructions.

## Page-action flows

These replay what was done in the page instead of resending a GET.

- `record --save <name>` watches the tab the user is on (`--here`: the session's) while the user does the task once (clicks, typing, picks, form sends). It saves a flow that finds each element by label, placeholder, name, text or role and name. Typed text becomes params, and passwords become params whose values aren't kept.
- `flow save <name> --actions` keeps the page actions of the steps you ran yourself in the same way.
- `flow run <name> --param k=v --yes` replays them. A flow saved with both actions and a GET answer resends the GET on a plain `flow run`; `--replay --yes` replays its actions instead. A replay can change things, so it needs `--yes`: ask the user first.
- Each step tries its locators, then Escape and the locators again, then role and name, and acts only on a locator that matches one element.
- `flow_step_failed`: run `flow heal <name>`. `--apply` keeps locators that worked through a fallback. Otherwise look at the page and give one: `flow heal <name> --step n --selector '<css>'` (or `--role r --name n`). Generated ids, hashed classes and values from one run are refused (`heal_rejected`): pick a label, name or role instead.
- `--fixture <dir>` on `flow save` or `flow run` writes the answer and an offline `node --test` check of its shape.
