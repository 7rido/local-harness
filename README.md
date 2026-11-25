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
- Tools with a trust level each (`off`, `ask`, `on`): `current_time`, `search_chats`, `web_search`, `web_fetch`, `run_python`, `remember`, `ask_someone`.
- Every conversation, every model call and every tool attempt is written to plain files under `./data`, with a readable Markdown log per chat.
- Reply checks that warn the reader (they never block or change a reply): unverified phone numbers and doses, invented sources, arithmetic that does not work out, text posing as tool output.
- Optional notes the model offers and you approve (memory), and a search over your earlier chats.
- Review and habits: mark a reply wrong, press Review, and the model reads recent chats and your marks, names the kind of each mistake and proposes a one-line habit. You keep, edit or drop each one; kept habits are shown to the model at the start of each chat.
- `ask_someone`: the model may put one question to a second voice (a "teacher"), only after you approve the exact question. The answer comes from a person or program through the command line, or from an OpenAI-compatible endpoint you configure.
- Think harder (opt-in, for one coding question): the model writes 8 tries and its own test inputs, each try runs in the sandbox, and the try that agrees with the most others is shown.
- A sealed Python sandbox (Docker) shared by `run_python` and think harder, with a fail-closed rule: if Docker cannot be reached, nothing runs.
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
| `LH_PYTHON_IMAGE` | `python:3.12-slim` | Docker image of the sandbox. |
| `LH_PYTHON_MEMORY` | `512m` | Memory limit of the sandbox container (swap is capped at the same value). |
| `LH_DOCKER` | `docker` | The Docker command, as plain words. May carry a prefix to run the sandbox on another machine, for example `ssh my-server docker`. See "The sandbox". |
| `DOCKER_HOST` | unset | Standard Docker variable, passed through to the docker command (for example `ssh://user@my-server`). |
| `LH_TEACHER_NAME` | `Teacher` | The label of the teacher's turns, on the page and in front of the text the model sees. |
| `LH_TEACHER_URL` | unset | Base address of an OpenAI-compatible server that answers `ask_someone` questions (for example `https://api.example.com/v1`). Unset: questions wait for the command line. With it set, the approved question leaves this computer for that URL. |
| `LH_TEACHER_KEY` | unset | Optional bearer token for that endpoint. |
| `LH_TEACHER_MODEL` | unset | Optional model name sent to that endpoint. |
| `LH_TEACHER_TIMEOUT_MS` | `120000` | How long to wait for the endpoint. |
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
| `review` | `off` `on` | `off` | The review and habits (needs `memory` on too). `ask` counts as `on`. |
| `ask_someone` | `off` `ask` | `off` | The model may ask a second voice one question, after your approval. It always asks: `on` behaves as `ask`. |
| `think_harder` | `off` `on` | `off` | Shows the Think harder button. Needs Docker. |
| `think_harder_repair` | `off` `on` | `off` | Allows the optional repair round of think harder. |
| `search_never_send` | list of words | `[]` | Words (your name, a street, a project) that may never appear in a web search or a page address. |

A missing file, a missing key or an unknown value gives the default above.

### Trust levels

- `off`: the tool is not offered to the model and never runs. If the model calls it anyway, the call is refused and the refusal is logged.
- `ask`: the model may call the tool, but the call waits. The page shows an approval card with the tool call (for `run_python`, the code, which you can edit first). On Approve the tool runs, its result is added to the chat as a "Tool result" turn and the model answers again. On Reject nothing runs.
- `on`: the call runs by itself. Every run is logged and shown as a chip under the reply.

Whatever the level, a reply may use at most 3 tool runs, an identical call is not run twice, and the model is told when it hits a limit.
`remember` always asks, at any level. `search_chats` is read-only, so it never goes through an approval.

### The sandbox (run_python and think harder)

Model-written code is never run on your computer directly. `src/sandbox.js` starts a throwaway Docker container for each run and passes the code on stdin.

In place on every run:

- no network (`--network none`), read-only root filesystem, the only writable place a 16 MB memory-backed `/tmp` that disappears with the container;
- memory limit (`LH_PYTHON_MEMORY`, default 512m, swap capped at the same), one CPU, at most 64 processes;
- all Linux capabilities dropped, `no-new-privileges`, runs as the unprivileged user 65534;
- nothing of your computer mounted (no `-v`, no `--mount`), and Python runs with `-E -s -I` (ignores environment variables and user site-packages);
- a time limit (10 seconds for `run_python`; think harder allows more for a whole set of checks), after which the container is removed by name (`docker rm -f`);
- the container has a name and a label (`local-harness.sandbox=1`) so a leftover can be found with `docker ps -a --filter label=local-harness.sandbox=1`;
- the code is limited to 20,000 characters, and the output is read up to 200,000 characters and returned clipped to 4,000 (head and tail kept);
- every argument is checked to be plain words, because with an `ssh` prefix the arguments are joined into a remote shell command.

Fail closed: if the docker command is missing, the daemon cannot be reached, or the other machine does not answer, the result is a failure that says nothing was run. There is no fallback to running the code on your computer or anywhere else. Think harder checks that the sandbox answers before it draws any tries, and otherwise gives a normal reply and says why.

A second machine: set `LH_DOCKER="ssh my-server docker"` (the code and the arguments go over ssh to the docker on `my-server`; keys must work without a prompt), or set the standard `DOCKER_HOST=ssh://user@my-server`. Anything running there runs under those same limits, but your code and its output travel over that connection.

Not in place: the sandbox is only as strong as Docker and its host. It is not a defence against a container-escape bug, it does not limit disk bandwidth or total CPU time beyond the time limit, the image is pulled by Docker on first use (a network request, once), and the first run is slow while it does. Docker Desktop and similar tools run the container in a VM; on a Linux host the container shares your kernel. Nothing here stops a program from burning CPU for its whole time limit. All of these tools are `off` by default.

### ask_someone and the teacher

When the model is unsure it may call `ask_someone` with one question. The call always waits for you: the approval card shows the exact question, and nothing is saved or sent until you approve it. Before the card is made, the same search guard that protects `web_search` (your user name, `search_never_send` words, three-word phrases and numbers from your system prompt and notes) checks the question; a question that trips it is refused and logged by hash only.

After you approve, the answer can come back in two ways, both optional:

- Queue (default): the question is saved as an open ask in `data/asks.jsonl`. A person or another program lists open questions with `node src/cli.js asks` and answers with `node src/cli.js answer <ask_id> "text"`. The answer is added to the chat as a turn by the author `teacher` (label `LH_TEACHER_NAME`, source `teacher`, never the model's), and the model then replies.
- Endpoint: if `LH_TEACHER_URL` is set, the approved question is sent there as a chat-completions request (with `LH_TEACHER_KEY` as a bearer token and `LH_TEACHER_MODEL` as the model name, if set) and the reply is added the same way. **The question text leaves your computer for that URL**; nothing else is sent (no chat history, no notes). If the endpoint fails, the question stays open for the command line.

The reply checks treat a teacher turn as something the model saw, like your own messages: a number or source found in it counts as found and is shown as "the teacher said it". That says the text was there, not that the teacher was right. Forgetting a chat deletes its asks.

### Review and habits

Mark a reply wrong (the "Mark as a miss" link under a reply, with the right answer typed in), or let the arithmetic check log a miss when a reply has a sum that does not work out. When you press Review (sidebar, Review drawer), the model reads recent chats (since the last review, or the last day) and your misses, and for each mistake proposes the kind of mistake and a one-line habit. Each shows as a card: keep it (you may edit the words) or drop it. Nothing is kept without your yes.

Kept habits (at most 1,500 characters of habit lines) are added as a block after the notes in the system message, only while `review` and `memory` are both on. Misses are kept in `data/misses.jsonl`; review cases in `data/review/cases.json` (the only copy of their text; the run log `data/review/runs.jsonl` holds ids and hashes only). Forgetting a chat deletes its misses and cases; a habit kept from it loses every link to the chat and the page asks whether to delete it too. The review runs against whichever model server is configured; if it is down, the page says so. The model's review replies never enter a chat.

A habit changes how the model behaves, and your yes is the only check on it. If one carries something personal, change its words before keeping it.

### Think harder

An opt-in mode for one coding question (the Think harder button, or `think_harder: true` in the send request; needs `think_harder` on in `trust.json` and Docker). The model draws 8 tries, then writes up to 8 test inputs for the problem (the instruction is `src/think_harder_inputs.md`). Each try is loaded and run on those inputs in the sandbox; a try survives if it loads and no input crashes it, and the biggest group of survivors that behave the same on the inputs wins (ties go to the earlier try; the shortest reply stands for the group). The optional repair round (`think_harder_repair` on, and the "+ repair" button; the instruction is `src/think_harder_repair.md`) gives the closest failing try one chance to fix itself when no try survived. It takes about nine times as long as one reply; the page shows the stage while it runs and a line under the reply says what it did.

It measures agreement, not correctness: a wrong answer that most tries share wins. Name the function (`is_prime(n)`) in your question, because inputs are accepted only if they call a function the question names. If Docker is missing, the reply is a normal one and says why. The reply and its tries are kept in the activity log.

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
data/approvals.jsonl            tool calls, note offers and questions waiting for (or decided by) you
data/asks.jsonl                 approved ask_someone questions, open or answered
data/misses.jsonl               replies marked wrong or caught by the arithmetic check (question and reply text)
data/review/cases.json          review cases and kept habits (the only copy of their text); review/runs.jsonl has ids and hashes
data/memory/notes.json          your saved notes (the only copy of their text), memory/events.jsonl holds ids only
data/searches.jsonl, .md        the web search log (when, words, results, which links the answer named)
data/fetches.jsonl              the page-read log (address, status, size, a hash; never the page text)
data/search-pause.json          written for 30 minutes after DuckDuckGo shows a bot check
data/system_prompt.txt          optional, written by you
```

What leaves your computer: your messages go to the model server you configured (`LH_MODEL_URL`), and nothing else, unless you turn on a tool:
`web_search` sends its search words to DuckDuckGo, `web_fetch` sends a request to the site it reads, `run_python` and think harder may pull their Docker image once (and send the code to another machine if you pointed `LH_DOCKER` or `DOCKER_HOST` at one). With `LH_TEACHER_URL` set, an approved `ask_someone` question is sent to that URL. The review and think harder send nothing beyond the model server you configured.
The model writes those words and addresses itself, so they can contain something from your chat or notes. A search guard checks them first and refuses
any that contain your user name, a word from `search_never_send`, three words in a row from your system prompt or a note, or a number from them.
At `on`, the log of a refused search keeps a hash, not the words. At `ask` the search words are shown to you in the approval card, and stay in the approval record and the activity log until you forget the chat.

"Forget" on a chat deletes its transcript, log, searches, page reads, approvals, asks, misses and review cases. Notes saved from it are kept until you delete them on the Memory page.
Deleting a note deletes its text everywhere, since other files hold only its id.

## Security notes

- The server listens on `127.0.0.1` only. `LH_HOST` can add one private address (VPN, home network); public addresses are refused.
- Every request except the empty page needs the token, as the `x-lh-token` header or `?t=`. Keep the link private.
- A host-header guard answers 403 to any `Host` that is not a loopback name (or the one address you allowed), which blocks DNS-rebinding attacks from web pages you visit.
- There is no login, no user accounts and no encryption (plain HTTP). The token is the only lock. Do not expose the port to the internet, and do not put it behind a public tunnel.
- The page is served with `cache-control: no-store`, and the data folder is not served; there is no way to read files through the API.
- Tools are the real risk surface. Keep `run_python` and think harder off unless you have Docker and have read "The sandbox", and read what `web_fetch`, `web_search` and `ask_someone` can send out. `LH_DOCKER` and `LH_TEACHER_URL` are environment variables, so whoever can set your environment can redirect them.

## Tested with

Developed and tested against `mlx_lm.server` with a Qwen3.5-9B model. That model puts its reasoning in a `reasoning` field of the reply, may use `<think>` tags,
and sometimes writes a raw `<tool_call>` block into its text instead of a proper tool call; the harness handles all three. Servers that name the field
`reasoning_content` are read too, but only by unit tests; no such server has been run against it (the stub in `examples/fake-model.js` sends `reasoning`).

Other servers (llama.cpp, vLLM, Ollama, LM Studio) and other models are untested. They should work if they follow the OpenAI chat-completions streaming format,
but expect rough edges, especially around tool calls and reasoning fields. Reports are welcome.

What was and was not exercised in v0.2:

- Exercised end to end against the stand-in model (`examples/fake-model.js`): chat, tools, marking a miss, a review run, keeping a habit and seeing it in the next reply, `ask_someone` with the command-line queue, and think harder's fallback when Docker is not available.
- Unit-tested with stubs: the sandbox's exact command line, time limit, cleanup call, clipping and fail-closed behaviour (against a stub `docker` command, `test/stubs/docker`); think harder's selection, repair and input parsing (against a stub sandbox that answers from markers); the teacher endpoint (against a local HTTP stub).
- **Not exercised: a real Docker daemon.** The sandbox's `docker run` command line, the check script's Python, the signal-based per-input time limit, and an `ssh` or `DOCKER_HOST` second machine have never been run against real Docker in this project's tests. Think harder's whole value depends on that path, so treat it as untested until you have run it.
- Not exercised: a real model's coding tries (the stand-in writes fixed code), a real teacher endpoint, and the page in several browsers.

## Running the tests

```
node --test test/
```

The tests use a fake model server, a stub `docker` command and temporary data folders, bind to ports 7391 to 7631 on 127.0.0.1, and need no network and no Docker.

## Project layout

```
src/server.js        the HTTP server, the tool loop, streaming, the activity log
src/lib.js           message building, reply splitting, the number / source / arithmetic / tool-claim checks
src/tools.js         the tools and their trust levels
src/sandbox.js       the sealed Python runner (Docker, fails closed)
src/thinkharder.js   think harder: tries, test inputs, selection, repair
src/think_harder_inputs.md, src/think_harder_repair.md   its two instructions (editable)
src/review.js        the review: cases, habits, the run
src/misses.js        the miss log
src/asks.js          approved ask_someone questions
src/teacher.js       the optional teacher endpoint
src/trust.js         reads trust.json
src/approvals.js     approvals waiting for your yes or no
src/memory.js        notes you approve
src/recall.js        search over earlier chats
src/websearch.js     DuckDuckGo search, the search guard, the search log
src/webfetch.js      the page reader that refuses private addresses
src/stream.js        rebuilds a streamed reply
src/bind.js          the listen address and Host-header guard
src/cli.js           list, send and show chats; list and answer open questions
src/public/index.html  the chat page
examples/fake-model.js a stand-in model server
test/                the tests (test/stubs/docker is the stub docker command)
trust.example.json   the safe default trust file
```

## Limitations

- One user, one model server, one reply at a time. No accounts, no multi-user separation.
- Plain HTTP and one token; not for exposing beyond your own machine or private network.
- The model's tool calls are limited to the seven tools here; there is no plugin system.
- `web_search` scrapes DuckDuckGo's HTML page and can stop working when it changes, or pause itself after a bot check.
- Past-chat search is word matching, not semantic search.
- The reply checks are heuristics (see above).
- The page is a single HTML file with no build step and is not tested in many browsers.
- The sandbox's Docker command line has not been run against a live Docker daemon (see "Tested with"). Check it on your machine before relying on it.
- Think harder only handles Python functions and classes called by one-line expressions, measures agreement rather than correctness, and does not check that a reply is valid Python beyond loading it in the sandbox.
- The review depends on the model reading its own chats well; small models propose weak or vague habits, which is why every one needs your yes.

## Licence

MIT. See `LICENSE`.
