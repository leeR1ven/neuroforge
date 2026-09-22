// Offline protocol regression suite. No API key, network, browser, or build needed.
// Run: node tools/verify_gpt6_protocol.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../prototype/src/ai_responses.js', import.meta.url), 'utf8');
const { isGPT6Model, usesResponses, responsesURL, buildResponsesRequest, decodeResponses, readResponsesStream } =
  await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log('PASS ' + name);
}
function protocolError(code) {
  return error => {
    assert.equal(error.responsesProtocol, true);
    assert.equal(error.noToolFallback, true);
    if (code) assert.equal(error.code, code);
    return true;
  };
}
const tool = { type: 'function', function: { name: 'add_node', description: '添加节点',
  parameters: { type: 'object', properties: { label: { type: 'string' }, optional: { type: 'boolean' } }, required: ['label'] } } };
const reason = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '检查节点' }],
  encrypted_content: 'opaque-encrypted-content', content: [{ type: 'reasoning_text', text: 'not a UI summary' }] };
const message = text => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', phase: 'final_answer',
  content: [{ type: 'output_text', text, annotations: [] }] });
const call = (id = 'call_1', args = '{"label":"输入层"}') => ({ type: 'function_call', id: 'fc_' + id,
  call_id: id, name: 'add_node', arguments: args, status: 'completed' });
const response = (output = [message('完成')], extra = {}) => ({ id: 'resp_test', object: 'response', status: 'completed', output,
  usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, output_tokens_details: { reasoning_tokens: 3 } }, ...extra });
const request = extra => buildResponsesRequest({ model: 'gpt-6-astra', messages: [{ role: 'user', content: '创建网络' }], ...extra });
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
function sse(text, sizes = [65536], tracker = {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0, index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const size = sizes[index++ % sizes.length];
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
    cancel() { tracker.cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
const completed = value => event({ type: 'response.completed', response: value });

await test('GPT-6 model routing includes snapshots and provider prefixes', () => {
  for (const model of ['gpt-6-astra', 'GPT-6-ASTRA-2026-09-15', 'gpt6', 'openai/gpt-6-astra']) assert.equal(isGPT6Model(model), true);
  for (const model of ['gpt-60', 'gpt-5.5', 'deepseek-chat', 'mygpt-6-astra', '']) assert.equal(isGPT6Model(model), false);
  assert.equal(usesResponses('https://example.com/v1', 'gpt-6-astra'), true);
  assert.equal(usesResponses('https://example.com/v1/responses?x=1', 'custom-model'), true);
  assert.equal(usesResponses('https://example.com/v1/chat/completions', 'deepseek-chat'), false);
});
await test('Responses URLs support roots, versioned proxies and explicit endpoints', () => {
  assert.equal(responsesURL(''), 'https://api.openai.com/v1/responses');
  assert.equal(responsesURL('https://api.openai.com'), 'https://api.openai.com/v1/responses');
  assert.equal(responsesURL('https://proxy.test/api/v1/'), 'https://proxy.test/api/v1/responses');
  assert.equal(responsesURL('https://proxy.test/api/v1/chat/completions?route=a#fragment'), 'https://proxy.test/api/v1/responses?route=a');
  assert.equal(responsesURL('https://proxy.test/custom/responses/'), 'https://proxy.test/custom/responses');
  assert.equal(responsesURL('localhost:1234/v1'), 'http://localhost:1234/v1/responses');
  assert.equal(responsesURL('proxy.test/v1'), 'https://proxy.test/v1/responses');
  assert.throws(() => responsesURL('file:///tmp/responses'), protocolError('invalid_responses_url'));
});
await test('GPT-6 request uses only supported generation keys', () => {
  const built = request({ stream: true, maxOutputTokens: 4096, reasoningEffort: 'high', temperature: 0.3, max_tokens: 100, thinking: { type: 'disabled' } });
  assert.deepEqual(Object.keys(built).sort(), ['include', 'input', 'max_output_tokens', 'model', 'reasoning', 'store', 'stream'].sort());
  assert.equal(built.store, false);
  assert.deepEqual(built.include, ['reasoning.encrypted_content']);
  assert.deepEqual(built.reasoning, { effort: 'high' });
  assert.equal(built.max_output_tokens, 4096);
});
await test('reasoning effort off maps low, default omitted and unsupported values fail visibly', () => {
  assert.deepEqual(request({ reasoningEffort: 'off' }).reasoning, { effort: 'low' });
  for (const effort of ['', 'default', undefined]) assert.equal('reasoning' in request({ reasoningEffort: effort }), false);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(request({ reasoningEffort: effort }).reasoning.effort, effort);
  assert.throws(() => request({ reasoningEffort: 'ultra' }), protocolError('invalid_reasoning_effort'));
});
await test('invalid model and token limits fail before transport', () => {
  assert.throws(() => request({ model: '' }), protocolError('invalid_model'));
  for (const maxOutputTokens of [0, -1, 1.5, 'bad', Infinity]) assert.throws(() => request({ maxOutputTokens }), protocolError('invalid_max_output_tokens'));
});
await test('system, text, images, assistant and tool history convert correctly', () => {
  const built = request({ messages: [
    { role: 'system', content: '系统指令' },
    { role: 'user', content: [{ type: 'text', text: '查看' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } }] },
    { role: 'assistant', content: '正在创建', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add_node', arguments: '{"label":"输入层"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ] });
  assert.deepEqual(built.input, [
    { role: 'developer', content: [{ type: 'input_text', text: '系统指令' }] },
    { role: 'user', content: [{ type: 'input_text', text: '查看' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'high' }] },
    { role: 'assistant', content: '正在创建' },
    { type: 'function_call', call_id: 'call_1', name: 'add_node', arguments: '{"label":"输入层"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
  ]);
});
await test('encrypted reasoning, output phase, order and actual call_id survive two turns', () => {
  const original = response([reason, message('开始'), call()]);
  const decoded = decodeResponses(original);
  assert.equal(decoded.message.tool_calls[0].id, 'call_1');
  assert.notEqual(decoded.message.tool_calls[0].id, original.output[2].id);
  const assistant = { role: 'assistant', ...decoded.message };
  const built = request({ messages: [{ role: 'user', content: '创建' }, assistant, { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }] });
  assert.deepEqual(built.input.slice(1, 4), original.output);
  assert.equal(built.input.length, 5);
  assert.equal(built.input[1].encrypted_content, 'opaque-encrypted-content');
  assert.equal(built.input[2].phase, 'final_answer');
  built.input[1].summary[0].text = 'changed';
  assert.equal(original.output[0].summary[0].text, '检查节点');
  assert.equal(decoded.message.responses_output[0].summary[0].text, '检查节点');
});
await test('function schema is flattened and optional fields stay optional', () => {
  const before = JSON.stringify(tool);
  const built = request({ tools: [tool] });
  assert.deepEqual(built.tools[0], { type: 'function', name: 'add_node', description: '添加节点', parameters: tool.function.parameters, strict: false });
  assert.equal(built.tool_choice, 'auto');
  assert.equal(JSON.stringify(tool), before);
  built.tools[0].parameters.required.push('optional');
  assert.deepEqual(tool.function.parameters.required, ['label']);
});
await test('tool list above 128 is never silently truncated', () => {
  const tools = Array.from({ length: 132 }, (_, i) => ({ ...tool, function: { ...tool.function, name: 'tool_' + i } }));
  assert.equal(request({ tools }).tools.length, 132);
  assert.equal(request({ tools }).tools[131].name, 'tool_131');
  assert.throws(() => request({ tools: [{ type: 'function', function: {} }] }), protocolError('invalid_tool_schema'));
});
await test('unsupported history content and incomplete tool records are not silently dropped', () => {
  assert.throws(() => request({ messages: [{ role: 'user', content: [{ type: 'unknown' }] }] }), protocolError('unsupported_message_content'));
  assert.throws(() => request({ messages: [{ role: 'tool', content: 'ok' }] }), protocolError('invalid_tool_history'));
  assert.throws(() => request({ messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'f' } }] }] }), protocolError('invalid_tool_history'));
});
await test('completed JSON response preserves usage and displays only reasoning summary', () => {
  const result = decodeResponses(response([reason, message('已完成')]));
  assert.equal(result.message.content, '已完成');
  assert.equal(result.message.reasoning_content, '检查节点');
  assert.equal(result.message.tool_calls, null);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.output_tokens_details.reasoning_tokens, 3);
});
await test('completed refusal is displayed', () => {
  const result = decodeResponses(response([{ type: 'message', content: [{ type: 'refusal', refusal: '无法执行' }] }]));
  assert.equal(result.message.content, '无法执行');
});
await test('completed tool response maps function calls and accepts omitted item status', () => {
  const first = call(); delete first.status;
  const result = decodeResponses(response([first, call('call_2', '{}')]));
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.message.tool_calls.length, 2);
  assert.equal(result.message.tool_calls[1].function.arguments, '{}');
});
await test('incomplete global status never exposes executable tools or fallback text', () => {
  assert.throws(() => decodeResponses(response([message('```json\n{"tool":"add_node"}\n```'), call()], {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
  })), error => { protocolError('response_incomplete')(error); assert.equal(error.finishReason, 'length'); assert.equal(error.partialContent.includes('add_node'), true); return true; });
});
await test('failed response carries provider error and prevents tool fallback', () => {
  assert.throws(() => decodeResponses(response([call()], { status: 'failed', error: { code: 'server_error', message: 'Failed remotely' } })), protocolError('server_error'));
});
await test('missing status or output cannot be mistaken for completion', () => {
  assert.throws(() => decodeResponses({ output: [call()] }), protocolError('response_not_completed'));
  assert.throws(() => decodeResponses({ status: 'completed' }), protocolError('invalid_response'));
});
await test('partial output item and invalid JSON tool arguments reject atomically', () => {
  assert.throws(() => decodeResponses(response([{ ...call(), status: 'in_progress' }])), protocolError('incomplete_output_item'));
  for (const args of ['{"label":', '[]', 'null', 'true', '"a"']) {
    assert.throws(() => decodeResponses(response([call('good', '{}'), call('bad', args)])), protocolError('invalid_function_arguments'));
  }
});
await test('missing call_id and duplicate call_id reject tool execution', () => {
  assert.throws(() => decodeResponses(response([{ ...call(), call_id: '' }])), protocolError('invalid_function_call'));
  assert.throws(() => decodeResponses(response([call(), call()])), protocolError('duplicate_function_call'));
});
await test('SSE handles UTF-8 split at every byte and emits Chinese text deltas', async () => {
  const output = message('你好 🌏');
  const deltas = [];
  const stream = event({ type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', content: [] } }) +
    event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你好 ' }) +
    event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '🌏' }) +
    event({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: '你好 🌏' }) +
    event({ type: 'response.output_item.done', output_index: 0, item: output }) + completed(response([output]));
  const result = await readResponsesStream(sse(stream, [1]), (text, reasoning) => deltas.push({ text, reasoning }));
  assert.equal(result.message.content, '你好 🌏');
  assert.equal(deltas.some(delta => delta.text === '你好 '), true);
  assert.equal(deltas.every(delta => !delta.text.includes('�')), true);
});
await test('SSE reasoning summaries and encrypted final items survive replay', async () => {
  const stream = event({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } }) +
    event({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '检查' }) +
    event({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: '检查节点' }) +
    event({ type: 'response.output_item.done', output_index: 0, item: reason }) + completed(response([reason, call()]));
  const deltas = [];
  const result = await readResponsesStream(sse(stream, [7, 19, 2]), (text, reasoning) => deltas.push(reasoning));
  assert.equal(deltas.includes('检查'), true);
  assert.equal(result.message.reasoning_content, '检查节点');
  assert.deepEqual(result.message.responses_output[0], reason);
});
await test('SSE interleaved function argument fragments stay in their output items', async () => {
  let stream = '';
  for (let index = 0; index < 2; index++) stream += event({ type: 'response.output_item.added', output_index: index,
    item: { ...call('call_' + index), status: 'in_progress', arguments: '' } });
  for (const [output_index, delta] of [[1, '{"label":'], [0, '{'], [1, '"隐藏层"}'], [0, '"label":"输入层"}']]) {
    stream += event({ type: 'response.function_call_arguments.delta', output_index, delta });
  }
  const output = [call('call_0'), call('call_1', '{"label":"隐藏层"}')];
  for (let index = 0; index < 2; index++) {
    stream += event({ type: 'response.function_call_arguments.done', output_index: index, arguments: output[index].arguments });
    stream += event({ type: 'response.output_item.done', output_index: index, item: output[index] });
  }
  stream += completed(response(output));
  const result = await readResponsesStream(sse(stream, [3, 31]));
  assert.deepEqual(result.message.tool_calls.map(item => JSON.parse(item.function.arguments).label), ['输入层', '隐藏层']);
});
await test('SSE accepts CRLF, comment lines, named events and multiline data', async () => {
  const payload = JSON.stringify({ response: response() }, null, 2).split('\n').map(line => 'data: ' + line).join('\r\n');
  const stream = ': heartbeat\r\nid: abc\r\nevent: response.completed\r\n' + payload + '\r\n\r\n';
  const result = await readResponsesStream(sse(stream, [1]));
  assert.equal(result.message.content, '完成');
});
await test('SSE accepts final completed event without trailing newline', async () => {
  const result = await readResponsesStream(sse(completed(response()).trimEnd(), [5]));
  assert.equal(result.finishReason, 'stop');
});
await test('SSE accepts CR-only separators', async () => {
  const result = await readResponsesStream(sse(completed(response()).replaceAll('\n', '\r'), [2]));
  assert.equal(result.message.content, '完成');
});
await test('SSE completed full output works without preceding text deltas', async () => {
  const deltas = [];
  const result = await readResponsesStream(sse(completed(response())), text => deltas.push(text));
  assert.equal(deltas.at(-1), '完成');
  assert.deepEqual(result.message.responses_output, response().output);
});
await test('SSE unknown future event is ignored safely', async () => {
  const result = await readResponsesStream(sse(event({ type: 'response.future_event', foo: 1 }) + completed(response())));
  assert.equal(result.message.content, '完成');
});
await test('SSE early EOF after complete-looking tool arguments still rejects', async () => {
  const stream = event({ type: 'response.output_item.done', output_index: 0, item: call() });
  await assert.rejects(readResponsesStream(sse(stream)), protocolError('response_stream_truncated'));
});
await test('SSE DONE alone is not a completed response', async () => {
  await assert.rejects(readResponsesStream(sse('data: [DONE]\n\n')), protocolError('response_stream_truncated'));
});
await test('SSE incomplete response never returns its well-formed partial tool call', async () => {
  const stream = event({ type: 'response.incomplete', response: response([call()], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) });
  await assert.rejects(readResponsesStream(sse(stream)), protocolError('response_incomplete'));
});
await test('SSE failed and error events preserve provider error codes', async () => {
  await assert.rejects(readResponsesStream(sse(event({ type: 'response.failed', response: response([], { status: 'failed', error: { code: 'server_error', message: 'Failed' } }) }))), protocolError('server_error'));
  await assert.rejects(readResponsesStream(sse(event({ type: 'error', code: 'invalid_api_key', message: 'Denied' }))), protocolError('invalid_api_key'));
});
await test('SSE invalid event JSON is a terminal protocol error', async () => {
  await assert.rejects(readResponsesStream(sse('data: {broken}\n\n')), protocolError('invalid_stream_json'));
});
await test('SSE invalid completed arguments never reach tool loop', async () => {
  await assert.rejects(readResponsesStream(sse(completed(response([call('bad', '{')])))), protocolError('invalid_function_arguments'));
});
await test('SSE abort before read rejects without consuming body', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readResponsesStream(sse(completed(response())), null, controller.signal), error => {
    protocolError('aborted')(error); assert.equal(error.name, 'AbortError'); return true;
  });
});
await test('SSE abort while waiting cancels reader and rejects promptly', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const res = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  const pending = readResponsesStream(res, null, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => { protocolError('aborted')(error); assert.equal(error.name, 'AbortError'); return true; });
  assert.equal(cancelled, true);
  assert.equal(res.body.locked, false);
});
await test('SSE completion cancels leftover transport and releases lock', async () => {
  let cancelled = false;
  const res = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(completed(response()))); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
  await readResponsesStream(res);
  assert.equal(cancelled, true);
  assert.equal(res.body.locked, false);
});
await test('JSON transport fallback returns normal completed response', async () => {
  const res = new Response(JSON.stringify(response([call()])), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  const result = await readResponsesStream(res);
  assert.equal(result.finishReason, 'tool_calls');
});
await test('desktop no-stream marker reads JSON even with absent content type', async () => {
  const res = new Response(JSON.stringify(response([call()])));
  res.__nfNoStream = true;
  const result = await readResponsesStream(res);
  assert.equal(result.finishReason, 'tool_calls');
});
await test('HTTP errors preserve status and prohibit blind tool downgrade', async () => {
  await assert.rejects(readResponsesStream(new Response(JSON.stringify({ error: { message: 'Unsupported parameter', code: 'unsupported_parameter' } }), { status: 400 })), error => {
    protocolError('unsupported_parameter')(error); assert.equal(error.status, 400); return true;
  });
});
await test('non-JSON HTTP error body is not reflected into chat', async () => {
  await assert.rejects(readResponsesStream(new Response('<html>private proxy debug</html>', { status: 502 })), error => {
    protocolError('responses_http_error')(error); assert.equal(error.message.includes('private proxy debug'), false); return true;
  });
});
await test('transport read errors prohibit tool fallback', async () => {
  const res = new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')); } }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(readResponsesStream(res), protocolError('response_read_error'));
});

console.log(`GPT-6 Responses protocol: ${passed} passed, 0 failed (offline).`);
