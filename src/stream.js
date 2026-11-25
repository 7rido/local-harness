// Read a streamed chat completion from an OpenAI-compatible server and rebuild the body the same
// request gives with stream: false. The saved records come from the rebuilt body; the page sees
// the text while the model writes it.
//
// Developed against mlx_lm.server: the stream sends the reasoning, the text and the parsed tool
// calls in pieces, then one chunk with finish_reason, then (with include_usage) a usage chunk,
// then [DONE]. The non-stream body has content null when empty, reasoning only when there is
// some, and tool calls without the stream's "index". Servers that name the reasoning field
// `reasoning_content` are read the same way.
'use strict';

const { TextDecoder } = require('node:util');

// res: a fetch Response. onDelta({ reasoning, content }) gets the text so far after each chunk.
// A reply that is not an event stream (an older server, a test stub) is read as plain JSON.
async function readCompletion(res, onDelta = () => {}, onActivity = null) {
  if (!/text\/event-stream/.test(res.headers.get('content-type') || '')) return res.json();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let reasoning = ''; let content = ''; const toolCalls = [];
  let finish = undefined; let usage = null; let model = null; let id = null; let done = false;
  const take = (event) => {
    // One event: its data lines joined; comment lines (": keepalive 10/200") are skipped.
    const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    const c = JSON.parse(data);
    if (c.model != null) model = c.model;
    if (c.id != null && id == null) id = c.id;
    if (c.usage) usage = c.usage;
    const ch = (c.choices || [])[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (d.reasoning) reasoning += d.reasoning;
    else if (d.reasoning_content) reasoning += d.reasoning_content;
    if (d.content) content += d.content;
    for (const tc of d.tool_calls || []) { const { index, ...rest } = tc; toolCalls.push(rest); }
    if (ch.finish_reason != null) finish = ch.finish_reason;
    onDelta({ reasoning, content });
  };
  const reader = res.body.getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (onActivity) onActivity();
    buf += end ? dec.decode() : dec.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 2); }
    if (end) break;
  }
  if (buf.trim()) take(buf);
  // A stream that stopped early (a dropped connection) is a failed call, not a short reply.
  if (!done || finish === undefined) {
    // read() returned end-of-stream with no error: the server closed the connection itself (a reset would have thrown from read()).
    const e = new Error('the model server stream ended before the reply was finished'); e.streamEnd = 'closed cleanly by the server'; throw e;
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { id, model, choices: [{ index: 0, finish_reason: finish, message }], ...(usage ? { usage } : {}) };
}

module.exports = { readCompletion };
