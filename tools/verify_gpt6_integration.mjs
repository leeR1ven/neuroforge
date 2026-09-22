/* 离线集成回归：提取 main.js 原函数，导入真实 Responses 适配器；所有 HTTP、UI、工具执行均隔离。
   运行：node tools/verify_gpt6_integration.mjs。不会读取配置/密钥、发网络请求或写工程文件。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../prototype/src/main.js', import.meta.url), 'utf8');
const adapterSource = fs.readFileSync(new URL('../prototype/src/ai_responses.js', import.meta.url), 'utf8');
const adapter = await import('data:text/javascript;base64,' + Buffer.from(adapterSource).toString('base64'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const noop = () => {};

function extract(name) {
  const pattern = new RegExp('^(?:async )?function ' + name + '\\(', 'm');
  const match = pattern.exec(source);
  assert.ok(match, 'missing source function: ' + name);
  const rest = source.slice(match.index);
  const line = rest.split(/\r?\n/, 1)[0];
  // 本文件提取的顶层函数只有两种形式：单行函数或独占一行的右花括号。
  if (line.endsWith('}')) return line;
  const end = /^}/m.exec(rest);
  assert.ok(end, 'missing closing brace: ' + name);
  return rest.slice(0, end.index + 1);
}

function arrayDeclaration(name) {
  const start = source.indexOf('const ' + name + ' = [');
  assert.ok(start >= 0, 'missing source array: ' + name);
  const end = source.indexOf('\n];', start);
  assert.ok(end >= 0);
  return source.slice(start, end + 3);
}

const actualFunctions = [
  'aiSlimOn', 'aiJsonTypeOf', 'aiToolSchemaOne', 'aiToolSchema',
  'aiBusyStatus', 'aiThinkNorm', 'aiThinkFields', 'aiThinkReject', 'aiTempNorm',
  'aiMsgsSysSync', 'aiMsgsSanitize', 'aiMsgsWire', 'aiResponsesMessages', 'aiResponsesResult',
  'aiAutoMaxTok', 'aiChatFetch', 'aiFetchChat', 'aiFetchChatStream', 'aiAsk', 'aiParseCalls',
  'aiJson', 'aiBrief', 'aiShortArgs', 'aiErrText', 'aiErrIsNoVision', 'aiErrIsMsgArray',
  'aiVisInfo', 'aiCanSend', 'aiMsgsHaveImage', 'aiDropAllImages', 'aiDropOldImages', 'aiMsgsFlush',
  'aiMsgText', 'aiMsgStore', 'aiMsgLoad', 'aiMsgsSafeCut', 'aiSessTitle', 'aiSessById',
  'aiSessSig', 'aiSessSnap', 'aiSessDropOldest', 'aiSessTrim', 'aiSessDoc', 'aiSessMs', 'aiNoteKey',
  'aiLogClean', 'aiSessNorm', 'aiSessLabel', 'aiSessUse', 'aiSessImport',
  'aiResponsesConnectionTest', 'aiLocalTest', 'aiCfgJson', 'aiSaveCfg', 'aiAdoptCfg', 'aiSysKv',
];

function harness(overrides = {}) {
  const requests = [], executions = [], notes = [], live = [], queue = [], writes = [];
  const storage = new Map();
  const elements = new Map([['ai-localnote', { innerHTML: '' }]]);
  const AI = Object.assign({
    base: 'https://api.openai.com/v1/chat/completions', model: 'gpt-6-astra',
    key: 'TEST_ONLY_FAKE_CREDENTIAL', visBase: '', visModel: '', visKey: '',
    think: 'high', thinkBad: false, thinkNote: '', temp: 0.2, maxTok: 0, slim: 'off',
    toolMode: 'auto', stream: false, streamBad: false, sysSlim: false, extra: '',
    msgs: [{ role: 'system', content: '测试系统提示词' }], log: [], did: [], pending: [],
    busy: false, stop: false, inTurn: false, turns: 0, maxTurns: 4, lastErr: '',
    sessSwitchTo: '', sid: 'test-session', seq: 1, cfgAt: 10,
    sessions: [{ id: 'test-session', n: 1, title: '', created: 100, mv: 'test-manual', msgs: [], log: [], did: [] }],
  }, overrides);
  const ctx = vm.createContext({
    ...adapter, AI, URL, Response, ReadableStream, TextEncoder, TextDecoder,
    AbortController, DOMException, Uint8Array, setTimeout, clearTimeout,
    AI_THINK: ['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max'].map((k) => ({ k })),
    AI_BUSY_RETRY: 3, AI_BUSY_WAIT: [0, 0, 0], AI_RESULT_MAX: 100000,
    AI_SESS_MSGS: 160, AI_SESS_MAX: 40, AI_SESS_BYTES: 12 * 1048576, AI_LOG_MAX: 400,
    AI_MANUAL_VERSION: 'test-manual', AI_STORE: 'test.ai', AI_BAK: 'test.ai.bak',
    APPEAR: { theme: 'test', vbg: 'test', custom: '' },
    document: { getElementById: (id) => elements.get(id) || null },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    SHELL_INVOKE: null,
    fetch: async (url, options) => {
      // 唯一网络入口：只消费内存队列，绝不委托给 globalThis.fetch。
      const request = { url: String(url), options, body: JSON.parse(options.body) };
      requests.push(request);
      assert.ok(queue.length, 'unexpected mock HTTP request #' + requests.length);
      const next = queue.shift();
      return typeof next === 'function' ? next(request) : next;
    },
    aiExec: async (name, args) => { executions.push({ name, args: clone(args) }); return { ok: true, value: 42 }; },
    aiShellPost: async () => { throw new Error('unexpected shell HTTP fallback'); },
    aiPush: (entry) => { notes.push(entry); AI.log.push(entry); },
    aiLiveFlush: () => live.push({ content: AI.live, think: AI.liveThink }),
    aiLocalNow: () => false, aiIsLocal: () => false,
    aiSystemPrompt: () => '测试系统提示词', aiStateLine: () => '测试状态',
    aiEsc: (s) => String(s).replace(/</g, '&lt;'), aiNetHint: () => '',
    aiSessRnd: () => 'test', aiPid: () => 'test-project', fmt: String,
    /* 第 77 轮加的「同状态两次快照不许盖新时间」用的指纹槽（main.js 里的 const AI_SNAP = { sig: '' }）。
       提取出来的那几个函数会读它，隔离环境里得给它一个同形的对象。 */
    AI_SNAP: { sig: '' },
    aiRender: noop, aiInfo: noop, aiSetUI: noop, aiTrim: noop, aiFillCfg: noop, aiModelListRender: noop,
    aiSysSync: noop, aiSessRender: noop, aiSessPersist: noop, aiSessFlushArchive: noop, toast: noop,
  });
  vm.runInContext(arrayDeclaration('AI_TOOLS') + '\n' +
    'const AI_BY_NAME = Object.fromEntries(AI_TOOLS.map((t) => [t.name, t]));\n' +
    "const AI_SLIM_TOOLS = ['get_state','list_tools','tool_help','run_tool','get_manual','list_api','run_api'];", ctx);
  for (const name of actualFunctions) vm.runInContext(extract(name), ctx, { filename: 'main.js:' + name });
  return { ctx, AI, requests, executions, notes, live, queue, writes, storage, elements };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function reasoning(id = 'rs_test') {
  return { type: 'reasoning', id, summary: [{ type: 'summary_text', text: '先核对网络结构。' }], encrypted_content: 'TEST_OPAQUE_REASONING_' + id };
}
function answer(text = '网络已检查。', id = 'msg_test') {
  return { type: 'message', id, status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] };
}
function call(name = 'get_state', args = {}, id = 'call_test') {
  return { type: 'function_call', id: 'fc_' + id, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' };
}
function result(output = [reasoning(), answer()], changes = {}) {
  return Object.assign({
    id: 'resp_test', object: 'response', status: 'completed', output,
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, output_tokens_details: { reasoning_tokens: 4 } },
  }, changes);
}
function event(type, data) { return 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n'; }
function sseResponse(events, { abort, truncated = false } = {}) {
  const raw = new TextEncoder().encode(events.join(''));
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset < raw.length) {
        // 7 字节一段，刻意拆开 UTF-8 中文字符、SSE 行和 JSON。
        controller.enqueue(raw.slice(offset, offset + 7)); offset += 7; return;
      }
      if (abort) { abort(); controller.error(new DOMException('测试停止', 'AbortError')); }
      else controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'X-Test-Truncated': String(truncated) } });
}
function streamEvents(response, text = '网络已检查。') {
  return [
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } }),
    event('response.output_item.added', { output_index: 0, item: { ...reasoning(), summary: [] } }),
    event('response.reasoning_summary_text.delta', { item_id: 'rs_test', output_index: 0, summary_index: 0, delta: '先核对网络结构。' }),
    event('response.output_item.done', { output_index: 0, item: reasoning() }),
    event('response.output_item.added', { output_index: 1, item: { ...answer(''), status: 'in_progress' } }),
    event('response.output_text.delta', { item_id: 'msg_test', output_index: 1, content_index: 0, delta: text }),
    event('response.output_item.done', { output_index: 1, item: answer(text) }),
    event('response.completed', { response }),
  ];
}

let passed = 0;
async function check(name, test) {
  await test(); passed++; console.log('PASS | ' + name);
}

await check('GPT-6 JSON 请求使用 Responses、原工具 schema、reasoning 和输出上限', async () => {
  const h = harness({ maxTok: 12345 });
  h.queue.push(jsonResponse(result()));
  const message = await h.ctx.aiFetchChat(h.AI.msgs, true, null, new AbortController().signal);
  const request = h.requests[0], body = request.body;
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.Authorization, 'Bearer TEST_ONLY_FAKE_CREDENTIAL');
  assert.equal(body.model, 'gpt-6-astra'); assert.equal(body.stream, false);
  assert.equal(body.max_output_tokens, 12345); assert.equal(body.reasoning.effort, 'high');
  assert.equal(body.store, false); assert.ok(Array.isArray(body.input));
  for (const absent of ['messages', 'max_tokens', 'temperature', 'thinking', 'reasoning_effort']) assert.equal(body[absent], undefined, absent);
  assert.equal(body.tools.length, vm.runInContext('AI_TOOLS.length', h.ctx));
  assert.ok(body.tools.length >= 125, 'full actual tool table is exercised');
  assert.ok(body.tools.every((t) => t.type === 'function' && t.name && !t.function && t.strict === false));
  assert.equal(message.content, '网络已检查。');
  assert.equal(message.responses_context.base, request.url);
  assert.equal(message.responses_output[0].encrypted_content, reasoning().encrypted_content);
  assert.equal(h.AI.usage.total_tokens, 18);
  h.AI.slim = 'on'; h.queue.push(jsonResponse(result()));
  await h.ctx.aiFetchChat(h.AI.msgs, true, null, null);
  assert.equal(h.requests[1].body.tools.length, 7);
});

await check('GPT-6 SSE 跨 UTF-8/行边界更新正文，完成后保存原始输出', async () => {
  const h = harness({ stream: true });
  h.queue.push(sseResponse(streamEvents(result())));
  await h.ctx.aiAsk('检查这个网络');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].body.stream, true);
  assert.equal(h.AI.lastErr, ''); assert.equal(h.AI.msgs.at(-1).content, '网络已检查。');
  assert.ok(h.live.some((x) => x.content.includes('网络已检查。')));
  assert.equal(h.AI.msgs.at(-1).responses_output.at(-1).phase, 'final_answer');
  assert.equal(h.AI.msgs.at(-1).responses_output[0].encrypted_content, reasoning().encrypted_content);
});

await check('看图请求转换成 input_image 并走所选 Responses 视觉端点', async () => {
  const h = harness({ visBase: 'https://vision.example.invalid/v1/responses', visModel: 'gpt-6-astra', visKey: 'TEST_VISION_KEY' });
  const image = 'data:image/png;base64,TEST_IMAGE_BYTES';
  h.queue.push(jsonResponse(result()));
  await h.ctx.aiAsk('看看布局', image);
  assert.equal(h.AI.lastErr, '');
  assert.equal(h.requests[0].url, 'https://vision.example.invalid/v1/responses');
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer TEST_VISION_KEY');
  const user = h.requests[0].body.input.find((item) => item.role === 'user');
  assert.ok(user.content.some((p) => p.type === 'input_text' && p.text === '看看布局'));
  assert.ok(user.content.some((p) => p.type === 'input_image' && p.image_url === image));
  assert.equal(h.executions.length, 0);
});

let savedSession;
await check('native 工具两轮保留 call_id/reasoning，结果回传且会话可导出', async () => {
  const h = harness();
  h.queue.push(jsonResponse(result([reasoning(), call('get_state', { scope: 'test' })])), jsonResponse(result([reasoning('rs_final'), answer('完成。')])));
  await h.ctx.aiAsk('检查网络');
  assert.equal(h.AI.lastErr, ''); assert.equal(h.requests.length, 2);
  assert.deepEqual(h.executions, [{ name: 'get_state', args: { scope: 'test' } }]);
  const input = h.requests[1].body.input;
  const ri = input.findIndex((x) => x.type === 'reasoning');
  const ci = input.findIndex((x) => x.type === 'function_call');
  const oi = input.findIndex((x) => x.type === 'function_call_output');
  assert.ok(ri >= 0 && ri < ci && ci < oi);
  assert.equal(input[ri].encrypted_content, reasoning().encrypted_content);
  assert.equal(input[ci].call_id, 'call_test'); assert.equal(input[oi].call_id, 'call_test');
  assert.deepEqual(JSON.parse(input[oi].output), { ok: true, value: 42 });
  assert.equal(input.filter((x) => x.type === 'function_call').length, 1, 'no duplicate Chat tool conversion');
  savedSession = clone(h.ctx.aiSessDoc());
  assert.ok(savedSession.sessions[0].msgs.some((m) => m.responses_output?.some((x) => x.type === 'reasoning')));
  assert.ok(savedSession.sessions[0].msgs.at(-1).responses_context);
});

await check('SSE native 工具参数分片在 completed 后执行一次，再流式完成第二轮', async () => {
  const h = harness({ stream: true });
  const tool = call('get_state', { scope: 'stream-test' });
  const events = [
    event('response.output_item.done', { output_index: 0, item: reasoning() }),
    event('response.output_item.added', { output_index: 1, item: { ...tool, arguments: '', status: 'in_progress' } }),
    event('response.function_call_arguments.delta', { output_index: 1, item_id: tool.id, delta: '{"scope":' }),
    event('response.function_call_arguments.delta', { output_index: 1, item_id: tool.id, delta: '"stream-test"}' }),
    event('response.function_call_arguments.done', { output_index: 1, item_id: tool.id, arguments: tool.arguments }),
    event('response.output_item.done', { output_index: 1, item: tool }),
    event('response.completed', { response: result([reasoning(), tool]) }),
  ];
  h.queue.push(sseResponse(events), (request) => {
    assert.equal(h.executions.length, 1);
    assert.ok(request.body.input.some((x) => x.type === 'function_call_output' && x.call_id === tool.call_id));
    assert.ok(request.body.input.some((x) => x.type === 'reasoning' && x.encrypted_content));
    return sseResponse(streamEvents(result()));
  });
  await h.ctx.aiAsk('检查网络');
  assert.equal(h.AI.lastErr, ''); assert.equal(h.requests.length, 2);
  assert.deepEqual(h.executions, [{ name: 'get_state', args: { scope: 'stream-test' } }]);
  assert.equal(h.AI.msgs.at(-1).content, '网络已检查。');
});

await check('完整 session 导出/导入后继续：reasoning/phase/工具结果仍回传', async () => {
  const h = harness();
  assert.equal(h.ctx.aiSessImport(clone(savedSession), 'test round trip'), true);
  h.queue.push(jsonResponse(result([answer('继续完成。')])));
  await h.ctx.aiAsk('继续');
  assert.equal(h.AI.lastErr, '');
  const input = h.requests[0].body.input;
  assert.ok(input.some((x) => x.type === 'reasoning' && x.encrypted_content === reasoning().encrypted_content));
  assert.ok(input.some((x) => x.type === 'message' && x.phase === 'final_answer'));
  assert.ok(input.some((x) => x.type === 'function_call_output' && x.call_id === 'call_test'));
});

await check('换 Responses 服务/模型不回送旧加密输出；换 DeepSeek 不泄露适配元数据', async () => {
  const h = harness();
  h.ctx.aiSessImport(clone(savedSession), 'test');
  h.AI.base = 'https://gateway.example.invalid/v1/responses';
  h.queue.push(jsonResponse(result([answer('收到。')])));
  await h.ctx.aiFetchChat(h.AI.msgs, true, null, null);
  assert.ok(!JSON.stringify(h.requests[0].body).includes('TEST_OPAQUE_REASONING'));
  h.AI.base = 'https://api.openai.com/v1/responses'; h.AI.model = 'gpt-6-astra-test-other-model';
  h.queue.push(jsonResponse(result([answer('收到。')])));
  await h.ctx.aiFetchChat(h.AI.msgs, true, null, null);
  assert.ok(!JSON.stringify(h.requests[1].body).includes('TEST_OPAQUE_REASONING'));
  h.AI.base = 'https://api.deepseek.com/chat/completions'; h.AI.model = 'deepseek-flash';
  h.queue.push(jsonResponse({ choices: [{ message: { role: 'assistant', content: '旧协议正常。' }, finish_reason: 'stop' }] }));
  const reply = await h.ctx.aiFetchChat(h.AI.msgs, true, null, null);
  const body = h.requests[2].body;
  assert.equal(reply.content, '旧协议正常。'); assert.ok(Array.isArray(body.messages));
  assert.equal(body.temperature, 0.2); assert.equal(body.max_tokens, 24000);
  assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'high');
  assert.ok(body.tools.every((t) => t.function && !t.name));
  for (const absent of ['input', 'max_output_tokens', 'reasoning', 'store']) assert.equal(body[absent], undefined);
  assert.ok(!JSON.stringify(body).includes('responses_output'));
  assert.ok(!JSON.stringify(body).includes('responses_context'));
  assert.ok(!JSON.stringify(body).includes('TEST_OPAQUE_REASONING'));
});

await check('HTTP 401 保持真实错误，带图/stream/tools 都不能误降级或重试', async () => {
  const h = harness({ stream: true });
  h.queue.push(jsonResponse({ error: { message: 'Unauthorized stream tools image request', code: 'invalid_api_key' } }, 401));
  await h.ctx.aiAsk('检查布局', 'data:image/png;base64,TEST_IMAGE_BYTES');
  assert.equal(h.requests.length, 1); assert.equal(h.executions.length, 0);
  assert.match(h.AI.lastErr, /HTTP 401/); assert.equal(h.AI.streamBad, false);
  assert.equal(h.AI.thinkBad, false); assert.equal(h.ctx.aiMsgsHaveImage(), true);
  assert.ok(!h.notes.some((x) => /已退回|摘掉|改成一次性/.test(x.text)));
});

await check('中途停止 fetch 不重试、不执行工具，UI 状态正常收尾', async () => {
  const h = harness();
  h.queue.push(() => {
    h.AI.stop = true; h.AI.abort.abort();
    throw new DOMException('测试停止', 'AbortError');
  });
  await h.ctx.aiAsk('检查网络');
  assert.equal(h.requests.length, 1); assert.equal(h.executions.length, 0);
  assert.equal(h.AI.lastErr, ''); assert.equal(h.AI.busy, false); assert.equal(h.AI.abort, null);
});

await check('SSE 已收到工具但未完成时停止，不能提前执行', async () => {
  const h = harness({ stream: true });
  const partial = [event('response.output_item.done', { output_index: 0, item: call() })];
  h.queue.push(sseResponse(partial, { abort: () => { h.AI.stop = true; h.AI.abort.abort(); } }));
  await h.ctx.aiAsk('检查网络');
  assert.equal(h.requests.length, 1); assert.equal(h.executions.length, 0);
  assert.equal(h.AI.busy, false); assert.equal(h.AI.lastErr, '');
});

await check('Responses incomplete 或 SSE 提前断流不执行已出现的工具', async () => {
  for (const stream of [false, true]) {
    const h = harness({ stream });
    h.queue.push(stream
      ? sseResponse([
        event('response.output_item.done', { output_index: 0, item: answer('部分可见回答') }),
        event('response.output_item.done', { output_index: 1, item: call() }),
      ], { truncated: true })
      : jsonResponse(result([answer('部分可见回答'), call()], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })));
    await h.ctx.aiAsk('检查网络');
    assert.equal(h.requests.length, 1); assert.equal(h.executions.length, 0);
    assert.ok(h.AI.lastErr, 'incomplete response must produce a visible error');
    assert.ok(h.notes.some((x) => x.role === 'assistant' && x.text === '部分可见回答'));
  }
});

await check('桌面非流式回退仍以 Responses JSON 解码', async () => {
  const h = harness({ stream: true });
  let shellRequests = 0;
  h.ctx.aiShellPost = async (url, body, headers) => {
    shellRequests++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(body.model, 'gpt-6-astra'); assert.ok(Array.isArray(body.input));
    assert.equal(headers.Authorization, 'Bearer TEST_ONLY_FAKE_CREDENTIAL');
    return { ok: true, status: 200, __nfNoStream: true, text: async () => JSON.stringify(result()) };
  };
  h.queue.push(() => { throw new TypeError('mock browser transport unavailable'); });
  await h.ctx.aiAsk('检查网络');
  assert.equal(h.AI.lastErr, ''); assert.equal(h.AI.msgs.at(-1).content, '网络已检查。');
  assert.equal(shellRequests, 1);
});

await check('界面连接测试使用 forced nf_ping 的 Responses 请求且不执行工程工具', async () => {
  const h = harness();
  h.queue.push(jsonResponse(result([call('nf_ping', { text: '收到' })])));
  assert.equal(await h.ctx.aiLocalTest(), true);
  assert.equal(h.requests.length, 1); assert.equal(h.executions.length, 0);
  assert.equal(h.requests[0].url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(h.requests[0].body.tool_choice, { type: 'function', name: 'nf_ping' });
  assert.equal(h.requests[0].body.tools.length, 1);
  assert.match(h.elements.get('ai-localnote').innerHTML, /通过/);
});

await check('旧配置异步回包不能覆盖新服务商 Key，同毫秒保存时间戳仍递增', async () => {
  const h = harness({ base: 'https://old.example.invalid/v1/chat/completions', model: 'old-model', key: 'TEST_OLD_KEY' });
  const pending = [];
  h.ctx.SHELL_INVOKE = (command, args) => {
    assert.equal(command, 'nf_cfg_write'); h.writes.push(clone(args));
    return new Promise((resolve) => pending.push(resolve));
  };
  const old = JSON.parse(h.ctx.aiSaveCfg(true));
  h.AI.base = 'https://api.openai.com/v1/responses'; h.AI.model = 'gpt-6-astra'; h.AI.key = 'TEST_NEW_KEY';
  const fresh = JSON.parse(h.ctx.aiSaveCfg(true));
  assert.ok(fresh.at > old.at);
  pending[0]([['final', JSON.stringify({ ...old, key: 'TEST_LATE_OLD_KEY' })]]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.AI.key, 'TEST_NEW_KEY');
  const wrongBase = { ...fresh, base: old.base, key: 'TEST_WRONG_ORIGIN_KEY' };
  assert.equal(h.ctx.aiAdoptCfg([['final', JSON.stringify(wrongBase)]]), false);
  assert.equal(h.AI.key, 'TEST_NEW_KEY');
  pending[1]([['final', JSON.stringify(fresh)]]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(JSON.parse(h.storage.get('test.ai')).key, 'TEST_NEW_KEY');
});

console.log('\n' + passed + ' integration groups passed; all HTTP mocked, no real keys or project writes.');
