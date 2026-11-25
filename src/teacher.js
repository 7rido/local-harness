// The optional teacher endpoint for ask_someone: an OpenAI-compatible server that answers an approved question.
//
//   LH_TEACHER_URL     base address, for example https://api.example.com/v1 or http://127.0.0.1:9000
//   LH_TEACHER_KEY     optional bearer token
//   LH_TEACHER_MODEL   optional model name sent with the request
//
// What is sent: the question text you approved, and nothing else (no chat history, no notes). With an endpoint set,
// that text leaves this computer for that URL. Nothing is sent unless you approved the question.

'use strict';

const lib = require('./lib');

const url = () => String(process.env.LH_TEACHER_URL || '').trim().replace(/\/+$/, '');
const configured = () => Boolean(url());
const endpoint = () => (/\/v1$/.test(url()) ? `${url()}/chat/completions` : `${url()}/v1/chat/completions`);

// Ask the endpoint once. Resolves { ok, text } or { ok: false, error } (fixed phrases: the server's own words are not kept).
async function ask(question, { fetchImpl = fetch } = {}) {
  if (!configured()) return { ok: false, error: 'no teacher endpoint is set' };
  try {
    const res = await fetchImpl(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.LH_TEACHER_KEY ? { authorization: `Bearer ${process.env.LH_TEACHER_KEY}` } : {}) },
      body: JSON.stringify({ ...(process.env.LH_TEACHER_MODEL ? { model: process.env.LH_TEACHER_MODEL } : {}),
        messages: [{ role: 'user', content: String(question) }], max_tokens: 1500, stream: false }),
      signal: AbortSignal.timeout(Number(process.env.LH_TEACHER_TIMEOUT_MS || 120000)),
    });
    if (!res.ok) return { ok: false, error: `the teacher endpoint answered ${res.status}` };
    let body;
    try { body = await res.json(); } catch { return { ok: false, error: 'the teacher endpoint sent something that was not JSON' }; }
    const text = lib.splitReply((body.choices && body.choices[0]) || {}).text;
    return text ? { ok: true, text } : { ok: false, error: 'the teacher endpoint sent no text' };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'the teacher endpoint did not answer in time' : 'could not reach the teacher endpoint' };
  }
}

module.exports = { configured, endpoint, ask };
