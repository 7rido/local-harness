# local-harness

A small chat harness for a model you run yourself. It serves a web chat page, talks to any OpenAI-compatible
`/v1/chat/completions` server, streams the reply, shows the model's thinking, runs tools under trust levels you set,
keeps every conversation and a full activity log on disk, and warns you when a reply contains specifics nothing backs up.

Plain Node.js, built-in modules only: no `npm install`, no dependencies, no build step.

## Why

A local model is easy to start and hard to trust. This harness is for the part after "it answers": seeing what the model
wrote and what it did, letting it use tools without handing it the keys, and noticing when a reply holds a phone number,
a dose, a source or a sum that nothing in the conversation supports. It keeps everything on your computer.

## Features

- Chat page with live streaming, the model's thinking shown separately, pinned/renamed/archived chats, and per-sentence marks showing what backs each claim.
- Works with any OpenAI-compatible server: llama.cpp server, mlx_lm.server, vLLM, Ollama's `/v1`, LM Studio (see "Tested with").
- Tools with a trust level each (`off`, `ask`, `on`): `current_time`, `search_chats`, `web_search`, `web_fetch`, `run_python`, `remember`.
- Every conversation, every model call and every tool attempt is written to plain files under `./data`, with a readable Markdown log per chat.
- Reply checks that warn the reader (they never block or change a reply): unverified phone numbers and doses, invented sources, arithmetic that does not work out, text posing as tool output.
- Optional notes the model offers and you approve (memory), and a search over your earlier chats.
- Binds `127.0.0.1` by default; every request needs a token.

## Quick start

1. Install nothing. Check that Node.js is new enough:

   ```
   node --version
   ```

   You need Node.js 18.17 or newer. The code uses `AbortSignal.any`, which arrived in Node 18.17 and 20.3, and the built-in `fetch`.
   It was developed and tested on a current Node release only, so prefer 20.3 or newer.

2. Run any OpenAI-compatible model server, for example `llama-server -m model.gguf --port 8080`, `mlx_lm.server --model <model>`,
   or `ollama serve`. Or skip this and use the stand-in below.

3. Copy the example trust file, then start the harness with the address of your model server:

   ```
   cp trust.example.json trust.json
   LH_MODEL_URL=http://127.0.0.1:8080 node src/server.js
   ```

   `LH_MODEL_URL` is the server's base address (the harness adds `/v1/chat/completions`). If you leave it out, `http://127.0.0.1:8080` is used.
   Some servers need a model name in every request (Ollama, LM Studio, vLLM): set `LH_MODEL_NAME` too.

4. Open the link it prints (`http://127.0.0.1:8787/?t=<token>`). The token is kept in `data/token`; the page removes it from the address bar after loading.

To check only that your model server answers: `LH_MODEL_URL=http://127.0.0.1:8080 node src/server.js --check`.

### Try it with no model

`examples/fake-model.js` is a tiny OpenAI-compatible stub. It echoes your message, sends a short made-up "thinking", and can call a tool.

```
node examples/fake-model.js &                     # listens on 127.0.0.1:8080
node src/server.js
```

Then open the printed link and try: `hello`, `what time is it?` (it calls `current_time`), `raw call please` (it writes a raw `<tool_call>` into its text,
as some models do), or `slow please` (it streams slowly so you can watch the live view). Stop it with `kill %1` or Ctrl-C.
Set `FAKE_MODEL_PORT` to use another port (and point `LH_MODEL_URL` at it).

## Configuration

Environment variables (all optional):

| Variable | Default | What it does |
| --- | --- | --- |
| `LH_MODEL_URL` | `http://127.0.0.1:8080` | Base address of the OpenAI-compatible model server. |
| `LH_MODEL_NAME` | none | Sent as `model` in every request when set. Needed by Ollama, LM Studio, vLLM; not by mlx_lm.server or llama.cpp. |
| `LH_PORT` | `8787` | Port of the chat page. |
| `LH_HOST` | `127.0.0.1` | Address to listen on. One private address (VPN or home network) also opens the page there. Public addresses are refused. |
| `LH_ALLOW_ALL_INTERFACES` | unset | Must be `yes` to let `LH_HOST=0.0.0.0` listen everywhere. Do not. |
| `LH_ALLOWED_HOSTS` | unset | Extra `Host` headers accepted, as a comma list of `<private IP>:<port>`, for tunnels and port forwards. |
| `LH_DATA` | `./data` (next to `src/`) | Where everything is written. |
| `LH_TRUST_FILE` | `./trust.json` | The trust file. |
| `LH_SYSTEM_PROMPT` | `<data>/system_prompt.txt` | Optional file with a system prompt. None is sent if the file does not exist. |
| `LH_EMERGENCY_CARD` | `./emergency_card.txt` | Optional file of numbers you have verified yourself (a local emergency number, a clinic). Shown on sensitive replies and counted as a source by the number check. |
| `LH_USER_NAME` | none | A name the search guard must never let into a web search (your OS user name is always guarded). |
| `LH_MAX_TOKENS` | `4096` | `max_tokens` for each reply. |
| `LH_TEMPERATURE` | `0.7` | Sampling temperature. |
| `LH_TOP_P` | `0.95` | Sampling top_p. |
| `LH_TOP_K` | not sent | Sent as `top_k` only when set to a number above 0 (it is not part of the OpenAI API). |
| `LH_MODEL_TIMEOUT_MS` | `1200000` | Longest a single model call may take (20 minutes). |
| `LH_MODEL_STALL_MS` | `240000` | A model server that sends nothing for this long (not even keep-alive lines) ends the call as a failure. |
| `LH_LONG_CONTEXT_TOKENS` | `6000` | Context size at which the page suggests starting a new chat. |
| `LH_PYTHON_IMAGE` | `python:3.12-slim` | Docker image used by `run_python`. |
| `LH_DOCKER` | `docker` | The Docker command used by `run_python`. |
| `LH_SEARCH_URL` | DuckDuckGo's HTML page | Address `web_search` posts to (mainly for tests). |

`trust.json` keys (the file is gitignored; `trust.example.json` is the safe starting point):

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `current_time` | `off` `ask` `on` | `on` | The model may read this computer's clock. |
| `search_chats` | `off` `ask` `on` | `on` | The model may search your earlier chats (read-only). `ask` counts as `on`. |
| `web_search` | `off` `ask` `on` | `off` | DuckDuckGo search. The search words leave your computer. |
| `web_fetch` | `off` `ask` `on` | `off` | Read one public web page. The address leaves your computer. |
| `run_python` | `off` `ask` `on` | `off` | Run Python, only inside a Docker container (see below). |
| `memory` | `off` `on` | `off` | Notes: the model may offer one, saved only on your yes, and saved notes are added to the system prompt. `ask` counts as `on`. |
| `search_never_send` | list of words | `[]` | Words (your name, a street, a project) that may never appear in a web search or a page address. |

A missing file, a missing key or an unknown value gives the default above.

### Trust levels

- `off`: the tool is not offered to the model and never runs. If the model calls it anyway, the call is refused and the refusal is logged.
- `ask`: the model may call the tool, but the call waits. The page shows an approval card with the tool call (for `run_python`, the code, which you can edit first). On Approve the tool runs, its result is added to the chat as a "Tool result" turn and the model answers again. On Reject nothing runs.
- `on`: the call runs by itself. Every run is logged and shown as a chip under the reply.

Whatever the level, a reply may use at most 3 tool runs, an identical call is not run twice, and the model is told when it hits a limit.
`remember` always asks, at any level. `search_chats` is read-only, so it never goes through an approval.

### run_python needs Docker

Model-written code is never run on your computer directly. `run_python` starts a throwaway container (`docker run --rm`) with no network,
a read-only filesystem, 256 MB of memory, one CPU, 64 processes, all capabilities dropped, no mounts and a 10 second limit, and passes the code on stdin.
It needs Docker (or a compatible `docker` command) and the image (`python:3.12-slim` by default; Docker pulls it on first use, which needs a network once).
If Docker is missing, the tool fails with a message and runs nothing. It is `off` in `trust.example.json`; turn it on only if you have Docker and accept that guarantee.

### web_fetch refuses private addresses

`web_fetch` reads public web pages only: http and https, GET, no cookies, nothing saved. It looks the host up inside the connection and refuses localhost,
`.local` names, private ranges, link-local and cloud-metadata addresses, carrier-grade NAT and their IPv6 forms, also after every redirect.
Other limits: usual web ports only, 10 seconds, 1 MB, text and HTML only, the text cut at 6,000 characters. It never tries to get past a bot check.

## What the reply checks do (and do not do)

After each reply the harness runs plain rule checks and records the results with the reply. They only warn the reader, on the page and in the log.
They never block, rewrite or retry a reply, and none of their output is sent to the model.

- Unverified specifics: phone numbers, doses, links and email addresses are marked "unverified". A phone number the model gives is compared with everything it saw while writing the reply (tool results, pages it read, past chats, your emergency card, your own messages); a number found nowhere gets a strong warning, and a found one says where.
- Invented sources: sources the model names ("X confirms", "according to X", "official sources", a bare web address, "from the page") are looked for in the same material. A source found nowhere is flagged. Text that poses as a tool run ("web_search results: ...") with no such tool run in the reply is flagged too.
- Arithmetic: a lone `a op b = c` that does not work out is shown with the right result. Chains, times, ratios and decimal commas are not judged.
- Sensitive topics: replies and questions about medical, crisis or safety matters get a banner and, if you wrote one, your emergency card.
- Marks per sentence: checked (a number came from a tool run), told (a number came from you), prompt (it matches your system prompt), unsure (the model says so), unverified, or not checked.

Honest limits: these are string and number matches, not understanding. They miss anything phrased differently and they flag some honest sentences (they lean toward over-flagging for phone numbers).
"Found" means the digits or the name appear in what the model saw, not that they are true or that the model used them correctly. A page can be wrong. Nothing here is a substitute for checking an official source.

## Data layout and privacy

Everything is under `./data` (or `LH_DATA`), nothing is sent anywhere by the harness itself:

```
data/token                      the access token (mode 600); delete it to get a new one
data/conversations/<id>.jsonl   one file per chat: user, model and tool messages
data/logs/<id>.jsonl, <id>.md   the activity log: every model call, tool attempt and check, and a readable version
data/chat-meta.json             titles, pins, archive marks
data/approvals.jsonl            tool calls and note offers waiting for (or decided by) you
data/memory/notes.json          your saved notes (the only copy of their text), memory/events.jsonl holds ids only
data/searches.jsonl, .md        the web search log (when, words, results, which links the answer named)
data/fetches.jsonl              the page-read log (address, status, size, a hash; never the page text)
data/search-pause.json          written for 30 minutes after DuckDuckGo shows a bot check
data/system_prompt.txt          optional, written by you
```

What leaves your computer: your messages go to the model server you configured (`LH_MODEL_URL`), and nothing else, unless you turn on a tool:
`web_search` sends its search words to DuckDuckGo, `web_fetch` sends a request to the site it reads, `run_python` may pull its Docker image once.
The model writes those words and addresses itself, so they can contain something from your chat or notes. A search guard checks them first and refuses
any that contain your user name, a word from `search_never_send`, three words in a row from your system prompt or a note, or a number from them.
At `on`, the log of a refused search keeps a hash, not the words. At `ask` the search words are shown to you in the approval card, and stay in the approval record and the activity log until you forget the chat.

"Forget" on a chat deletes its transcript, log, searches, page reads and approvals. Notes saved from it are kept until you delete them on the Memory page.
Deleting a note deletes its text everywhere, since other files hold only its id.

## Security notes

- The server listens on `127.0.0.1` only. `LH_HOST` can add one private address (VPN, home network); public addresses are refused.
- Every request except the empty page needs the token, as the `x-lh-token` header or `?t=`. Keep the link private.
- A host-header guard answers 403 to any `Host` that is not a loopback name (or the one address you allowed), which blocks DNS-rebinding attacks from web pages you visit.
- There is no login, no user accounts and no encryption (plain HTTP). The token is the only lock. Do not expose the port to the internet, and do not put it behind a public tunnel.
- The page is served with `cache-control: no-store`, and the data folder is not served; there is no way to read files through the API.
- Tools are the real risk surface. Keep `run_python` off unless you have Docker, and read what `web_fetch` and `web_search` can send out.

## Tested with

Developed and tested against `mlx_lm.server` with a Qwen3.5-9B model. That model puts its reasoning in a `reasoning` field of the reply, may use `<think>` tags,
and sometimes writes a raw `<tool_call>` block into its text instead of a proper tool call; the harness handles all three. Servers that name the field
`reasoning_content` are read too, but only by unit tests; no such server has been run against it (the stub in `examples/fake-model.js` sends `reasoning`).

Other servers (llama.cpp, vLLM, Ollama, LM Studio) and other models are untested. They should work if they follow the OpenAI chat-completions streaming format,
but expect rough edges, especially around tool calls and reasoning fields. Reports are welcome.

## Running the tests

```
node --test test/
```

The tests use a fake model server and temporary data folders, bind to ports 7391 to 7591 on 127.0.0.1, and need no network and no Docker.

## Project layout

```
src/server.js        the HTTP server, the tool loop, streaming, the activity log
src/lib.js           message building, reply splitting, the number / source / arithmetic / tool-claim checks
src/tools.js         the tools and their trust levels, run_python's Docker sandbox
src/trust.js         reads trust.json
src/approvals.js     approvals waiting for your yes or no
src/memory.js        notes you approve
src/recall.js        search over earlier chats
src/websearch.js     DuckDuckGo search, the search guard, the search log
src/webfetch.js      the page reader that refuses private addresses
src/stream.js        rebuilds a streamed reply
src/bind.js          the listen address and Host-header guard
src/cli.js           list, send and show chats from a terminal
src/public/index.html  the chat page
examples/fake-model.js a stand-in model server
test/                the tests
trust.example.json   the safe default trust file
```

## Limitations

- One user, one model server, one reply at a time. No accounts, no multi-user separation.
- Plain HTTP and one token; not for exposing beyond your own machine or private network.
- The model's tool calls are limited to the six tools here; there is no plugin system.
- `web_search` scrapes DuckDuckGo's HTML page and can stop working when it changes, or pause itself after a bot check.
- Past-chat search is word matching, not semantic search.
- The reply checks are heuristics (see above).
- The page is a single HTML file with no build step and is not tested in many browsers.
- `run_python`'s Docker command line has not been run against a live Docker daemon (only against a missing or stopped one, where it fails and runs nothing). Check it on your machine before relying on it.

## Licence

MIT. See `LICENSE`.
