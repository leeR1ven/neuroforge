/* Offline UI/config regressions. Uses only synthetic credentials and DOM stubs;
   never reads saved configuration, sends requests, or writes generated pages. */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const adapterSource = fs.readFileSync(new URL('./src/ai_responses.js', import.meta.url), 'utf8');
const { isGPT6Model, buildResponsesRequest } = await import('data:text/javascript;base64,' + Buffer.from(adapterSource).toString('base64'));

const source = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
const template = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, 'missing production function ' + name);
  const lineEnd = source.indexOf('\n', match.index);
  const firstLine = source.slice(match.index, lineEnd).trimEnd();
  if (firstLine.endsWith('}')) return firstLine;
  const end = source.indexOf('\n}', lineEnd);
  assert.ok(end > lineEnd, 'missing function end ' + name);
  return source.slice(match.index, end + 2);
}
function element(tagName = 'div') {
  const handlers = new Map();
  const el = {
    tagName: tagName.toUpperCase(), value: '', textContent: '', disabled: false, title: '', handlers, children: [],
    appendChild(child) { this.children.push(child); if (this.tagName === 'SELECT' && this.children.length === 1) this.value = child.value; return child; },
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); },
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
    fire(type, values = {}) {
      const event = { target: this, preventDefault() {}, stopPropagation() {}, ...values };
      for (const fn of [...(handlers.get(type) || [])]) fn(event);
    },
    focus() { this.focused = true; },
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (value) => { html = value; el.children = []; if (el.tagName === 'SELECT') el.value = ''; } });
  Object.defineProperty(el, 'options', { get: () => el.children });
  return el;
}
function context() {
  const c = {
    URL, Promise, AbortController, setTimeout, clearTimeout, isGPT6Model,
    AI: { base: 'https://old-provider.invalid/v1/chat/completions', model: 'old-model', key: 'FAKE-OLD-KEY',
      visBase: 'https://vision-provider.invalid/v1/chat/completions', visModel: 'old-vision', visKey: 'FAKE-VISION-KEY',
      think: 'default', thinkBad: true, thinkNote: 'old error', temp: 0.8, maxTok: 2000, busy: false,
      streamBad: true, netVia: 'old route', netNote: 'old note' },
    NF_CARD: '', NF_BTN: '', NF_BTN_PRI: '', saves: [], messages: [], closed: 0,
    fetch() { throw new Error('preset/UI must not make a network request'); },
  };
  c.document = element();
  c.fields = new Map(['ai-thinknote', 'ai-temp', 'ai-tempnote'].map((id) => [id, element()]));
  c.document.getElementById = (id) => c.fields.get(id) || null;
  c.document.createElement = (tag) => element(tag);
  c.nfAskBox = (html) => {
    c.dialogHtml = html;
    c.dialog = element();
    c.dialogFields = new Map(['ai-gpt6-key', 'ai-gpt6-error', 'ai-gpt6-cancel', 'ai-gpt6-apply'].map((id) => [id, element()]));
    c.dialog.querySelector = (selector) => c.dialogFields.get(selector.replace(/^#/, ''));
    return c.dialog;
  };
  c.nfAskClose = () => { c.closed++; };
  c.aiSaveCfg = (force) => c.saves.push({ force, state: JSON.stringify(c.AI) });
  c.aiFillCfg = () => c.aiThinkNote();
  c.aiInfo = () => {};
  c.toast = (message) => c.messages.push(message);
  vm.createContext(c);
  const constants = source.match(/^const AI_THINK = \[[\s\S]*?^\];/m);
  assert.ok(constants, 'missing AI_THINK');
  vm.runInContext(constants[0] + '\n' + ['aiEsc', 'aiThinkNorm', 'aiThinkLabel', 'aiThinkNote', 'aiThinkFields',
    'aiIsGpt6Config', 'aiApplyGpt6Preset', 'aiOpenGpt6Preset', 'aiBaseNormalize', 'aiBaseRoot',
    'aiModelsScope', 'aiModelsScopeSame', 'aiModelsOnce', 'aiShellGet', 'aiLocalProbe'].map(functionSource).join('\n'), c);
  return c;
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS | ' + name); }
function noChange(c, before) { assert.equal(JSON.stringify(c.AI), before); assert.equal(c.saves.length, 0); }

await test('DeepSeek defaults remain intact and the preset requires a deliberate click', () => {
  assert.match(source, /key: '', base: 'https:\/\/api\.deepseek\.com\/v1\/chat\/completions', model: 'deepseek-flash'/);
  assert.match(template, /id="ai-openai-gpt6"[^>]*>OpenAI GPT-6<\/button>/);
  assert.match(source, /bind\('ai-openai-gpt6', 'click', \(\) => \{ aiOpenGpt6Preset\(\); \}\)/);
  const c = context();
  assert.equal(c.saves.length, 0);
  assert.equal(c.dialog, undefined);
});
await test('URL normalization preserves Responses, version roots, custom paths and query strings', () => {
  const c = context();
  const pairs = [
    ['', ''],
    ['127.0.0.1:11434', 'http://127.0.0.1:11434/v1/chat/completions'],
    ['http://localhost:1234/v1/', 'http://localhost:1234/v1/chat/completions'],
    ['https://service.invalid/proxy/v2', 'https://service.invalid/proxy/v2/chat/completions'],
    ['https://service.invalid/proxy/v1beta/', 'https://service.invalid/proxy/v1beta/chat/completions'],
    ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses'],
    ['https://service.invalid/v7/responses/?mode=test#section', 'https://service.invalid/v7/responses?mode=test#section'],
    ['https://service.invalid/v3/models', 'https://service.invalid/v3/chat/completions'],
    ['https://service.invalid/deployments/demo/chat/completions?api-version=2026-09-22', 'https://service.invalid/deployments/demo/chat/completions?api-version=2026-09-22'],
    ['https://service.invalid/custom/infer?route=test', 'https://service.invalid/custom/infer?route=test'],
  ];
  for (const [input, expected] of pairs) assert.equal(c.aiBaseNormalize(input), expected, input);
});
await test('model-list roots remove either protocol suffix without duplicating a version', () => {
  const c = context();
  for (const endpoint of ['responses', 'chat/completions', 'models']) {
    assert.equal(c.aiBaseRoot('https://service.invalid/proxy/v3/' + endpoint + '/?route=test#section'), 'https://service.invalid/proxy/v3');
  }
  c.AI.base = 'https://api.openai.com/v1/responses';
  assert.equal(c.aiBaseRoot(), 'https://api.openai.com/v1');
  assert.equal(c.aiBaseRoot('https://service.invalid/custom/infer'), 'https://service.invalid/custom/infer');
});
await test('xhigh is selectable and medium has a provider-neutral label', () => {
  const c = context();
  assert.equal(c.aiThinkNorm(' XHIGH '), 'xhigh');
  assert.equal(c.aiThinkLabel('medium'), '中（medium）');
  assert.equal(vm.runInContext('AI_THINK.map(x => x.k).join(",")', c), 'default,off,low,medium,high,xhigh,max');
});
await test('GPT-6 hints explain off-to-low and disable temperature without changing its saved value', () => {
  const c = context();
  c.AI.model = 'gpt-6-astra'; c.AI.think = 'off';
  c.aiThinkNote();
  assert.match(c.fields.get('ai-thinknote').innerHTML, /按 low 发送/);
  assert.match(c.fields.get('ai-thinknote').innerHTML, /xhigh/);
  assert.equal(c.fields.get('ai-temp').disabled, true);
  assert.match(c.fields.get('ai-tempnote').textContent, /不适用温度/);
  assert.equal(c.AI.temp, 0.8);
  c.AI.model = 'deepseek-flash'; c.AI.thinkBad = false;
  c.aiThinkNote();
  assert.equal(c.fields.get('ai-temp').disabled, false);
  assert.equal(c.AI.temp, 0.8);
  assert.equal(c.saves.length, 0);
});
await test('UI and Responses request handling agree for official and gateway GPT-6 model names', () => {
  const c = context();
  for (const model of ['gpt-6-astra', 'openai/gpt-6-astra', 'gpt6-astra', 'gpt-6', 'GPT-6.1']) {
    c.AI.model = model; c.AI.think = 'off'; c.aiThinkNote();
    assert.equal(c.aiIsGpt6Config(), true, model);
    assert.equal(c.fields.get('ai-temp').disabled, true, model);
    const request = buildResponsesRequest({ model, messages: [], reasoningEffort: c.AI.think });
    assert.equal(request.reasoning.effort, 'low', model);
    assert.equal(Object.hasOwn(request, 'temperature'), false, model);
  }
  for (const model of ['deepseek-flash', 'gpt-60-astra', 'othergpt-6-astra']) assert.equal(c.aiIsGpt6Config(model), false, model);
});
await test('legacy chat thinking still sends the selected xhigh value and leaves provider mapping to its API', () => {
  const c = context(); c.AI.thinkBad = false; c.AI.think = 'xhigh';
  assert.equal(JSON.stringify(c.aiThinkFields()), JSON.stringify({ thinking: { type: 'enabled' }, reasoning_effort: 'xhigh' }));
  c.AI.think = 'default'; assert.equal(c.aiThinkFields(), null);
  c.AI.think = 'off'; assert.equal(JSON.stringify(c.aiThinkFields()), JSON.stringify({ thinking: { type: 'disabled' } }));
});
await test('empty or busy preset application leaves all credentials and settings unchanged', () => {
  const c = context(); let before = JSON.stringify(c.AI);
  assert.equal(c.aiApplyGpt6Preset('  '), false); noChange(c, before);
  c.AI.busy = true; before = JSON.stringify(c.AI);
  assert.equal(c.aiApplyGpt6Preset('FAKE-NEW-OPENAI-KEY'), false); noChange(c, before);
});
await test('explicit application replaces the main credential and all visual overrides in one forced save', () => {
  const c = context();
  assert.equal(c.aiApplyGpt6Preset('  FAKE-NEW-OPENAI-KEY  '), true);
  assert.equal(c.AI.base, 'https://api.openai.com/v1/responses');
  assert.equal(c.AI.model, 'gpt-6-astra'); assert.equal(c.AI.key, 'FAKE-NEW-OPENAI-KEY');
  assert.equal(c.AI.visBase, ''); assert.equal(c.AI.visModel, ''); assert.equal(c.AI.visKey, '');
  assert.equal(c.saves.length, 1); assert.equal(c.saves[0].force, true);
  assert.equal(c.saves[0].state, JSON.stringify(c.AI));
  assert.equal(c.AI.think, 'default'); assert.equal(c.AI.temp, 0.8); assert.equal(c.AI.maxTok, 2000);
});
await test('opening and cancelling a password dialog never prefills or overwrites an existing key', async () => {
  const c = context(); const before = JSON.stringify(c.AI);
  const done = c.aiOpenGpt6Preset(); noChange(c, before);
  assert.equal(c.dialogFields.get('ai-gpt6-key').value, '');
  assert.match(c.dialogHtml, /id="ai-gpt6-key" type="password"/);
  assert.ok(!c.dialogHtml.includes('FAKE-OLD-KEY'));
  c.dialogFields.get('ai-gpt6-key').value = 'FAKE-UNAPPLIED-KEY';
  c.dialogFields.get('ai-gpt6-cancel').fire('click');
  assert.equal(await done, false); noChange(c, before);
  assert.equal(c.dialogFields.get('ai-gpt6-key').value, '');
  assert.equal(c.document.handlers.get('keydown').size, 0);
});
await test('an existing official OpenAI credential is explained without revealing or replacing it', async () => {
  const c = context(); c.AI.base = 'https://api.openai.com/v1/responses'; c.AI.key = 'FAKE-SAVED-OFFICIAL-KEY';
  const before = JSON.stringify(c.AI); const done = c.aiOpenGpt6Preset();
  assert.match(c.dialogHtml, /已保存 OpenAI API Key/);
  assert.match(c.dialogHtml, /此输入框仅用于更换 Key，所以保持空白/);
  assert.match(c.dialogHtml, /点“取消”继续使用原 Key/);
  assert.match(c.dialogHtml, /原有 Key 不会跨服务商复用/);
  assert.ok(!c.dialogHtml.includes(c.AI.key)); assert.equal(c.dialogFields.get('ai-gpt6-key').value, '');
  noChange(c, before);
  c.dialogFields.get('ai-gpt6-apply').fire('click');
  assert.match(c.dialogFields.get('ai-gpt6-error').textContent, /无需更换时请点“取消”继续使用/);
  noChange(c, before); assert.equal(c.closed, 0);
  c.dialogFields.get('ai-gpt6-cancel').fire('click'); assert.equal(await done, false); noChange(c, before);
});
await test('missing credentials and nonofficial origins still explicitly require a new OpenAI key', async () => {
  for (const [base, key] of [
    ['https://api.openai.com/v1/responses', ''],
    ['https://api.openai.com/v1/responses', '  '],
    ['https://api.deepseek.com/v1/chat/completions', 'FAKE-OTHER-PROVIDER-KEY'],
    ['https://api.openai.com.other-provider.invalid/v1/responses', 'FAKE-OTHER-PROVIDER-KEY'],
    ['http://api.openai.com/v1/responses', 'FAKE-OTHER-PROVIDER-KEY'],
    ['https://api.openai.com:8443/v1/responses', 'FAKE-OTHER-PROVIDER-KEY'],
    ['not a valid URL', 'FAKE-OTHER-PROVIDER-KEY'],
  ]) {
    const c = context(); c.AI.base = base; c.AI.key = key; const before = JSON.stringify(c.AI);
    const done = c.aiOpenGpt6Preset();
    assert.ok(!c.dialogHtml.includes('已保存 OpenAI API Key'), base);
    assert.match(c.dialogHtml, /原有 Key 不会跨服务商复用，请填写 <b>OpenAI API Key<\/b>/);
    if (key.trim()) assert.ok(!c.dialogHtml.includes(key));
    assert.equal(c.dialogFields.get('ai-gpt6-key').value, '');
    c.dialogFields.get('ai-gpt6-cancel').fire('click'); assert.equal(await done, false); noChange(c, before);
  }
});
await test('Escape and outside-click cancellations both preserve the complete configuration', async () => {
  for (const mode of ['escape', 'outside']) {
    const c = context(); const before = JSON.stringify(c.AI); const done = c.aiOpenGpt6Preset();
    if (mode === 'escape') c.document.fire('keydown', { key: 'Escape' });
    else c.dialog.fire('mousedown');
    assert.equal(await done, false); noChange(c, before);
    assert.equal(c.document.handlers.get('keydown').size, 0);
    assert.equal(c.dialog.handlers.get('mousedown').size, 0);
  }
});
await test('empty Apply displays an error, then a new key can be explicitly applied once', async () => {
  const c = context(); const before = JSON.stringify(c.AI); const done = c.aiOpenGpt6Preset();
  c.dialogFields.get('ai-gpt6-apply').fire('click'); noChange(c, before);
  assert.equal(c.closed, 0); assert.match(c.dialogFields.get('ai-gpt6-error').textContent, /请填写 OpenAI API Key/);
  c.dialogFields.get('ai-gpt6-key').value = 'FAKE-NEW-OPENAI-KEY';
  c.document.fire('keydown', { key: 'Enter', isComposing: true }); noChange(c, before);
  c.document.fire('keydown', { key: 'Enter' });
  assert.equal(await done, true); assert.equal(c.saves.length, 1); assert.equal(c.closed, 1);
  assert.equal(c.dialogFields.get('ai-gpt6-key').value, '');
  const after = JSON.stringify(c.AI); const next = c.aiOpenGpt6Preset();
  c.dialogFields.get('ai-gpt6-cancel').fire('click');
  assert.equal(await next, false); assert.equal(JSON.stringify(c.AI), after); assert.equal(c.saves.length, 1);
});
await test('a busy session cannot open a preset or switch providers while a dialog is open', async () => {
  const c = context(); c.AI.busy = true; let before = JSON.stringify(c.AI);
  assert.equal(await c.aiOpenGpt6Preset(), false); assert.equal(c.dialog, undefined); noChange(c, before);
  c.AI.busy = false; const done = c.aiOpenGpt6Preset(); c.AI.busy = true; before = JSON.stringify(c.AI);
  c.dialogFields.get('ai-gpt6-key').value = 'FAKE-NEW-OPENAI-KEY'; c.dialogFields.get('ai-gpt6-apply').fire('click');
  noChange(c, before); assert.equal(c.closed, 0); assert.match(c.dialogFields.get('ai-gpt6-error').textContent, /AI 正在回复/);
  c.dialogFields.get('ai-gpt6-cancel').fire('click'); assert.equal(await done, false);
});
await test('official model-list requests use the current credential only for the configured origin', async () => {
  const c = context(); c.AI.base = 'https://api.openai.com/v1/responses'; c.AI.key = 'FAKE-OPENAI-LIST-KEY';
  const calls = [];
  c.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ data: [{ id: 'gpt-6-astra' }] }) }; };
  c.aiShellHttp = () => { throw new Error('successful direct request must not use shell'); };
  const result = await c.aiModelsOnce('https://api.openai.com/v1/models');
  assert.equal(result.ok, true); assert.equal(result.list.join(','), 'gpt-6-astra');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer FAKE-OPENAI-LIST-KEY');
  for (const url of ['https://other-provider.invalid/v1/models', 'https://api.openai.com.other-provider.invalid/v1/models',
    'http://api.openai.com/v1/models', 'https://api.openai.com:8443/v1/models', 'http://127.0.0.1:11434/v1/models']) {
    await c.aiModelsOnce(url);
    assert.equal(Object.hasOwn(calls.at(-1).options.headers, 'Authorization'), false, url);
  }
  c.AI.key = ''; await c.aiModelsOnce('https://api.openai.com/v1/models');
  assert.equal(Object.hasOwn(calls.at(-1).options.headers, 'Authorization'), false);
});
await test('model-list fallback forwards the same authentication headers through the software channel', async () => {
  const c = context(); c.AI.base = 'https://api.openai.com/v1/responses'; c.AI.key = 'FAKE-OPENAI-LIST-KEY';
  let direct, shell;
  c.fetch = async (url, options) => { direct = { url, options }; throw new Error('synthetic CORS failure'); };
  c.aiShellHttp = async (...args) => { shell = args; return { ok: true, json: async () => ({ data: [{ id: 'gpt-6-astra' }] }) }; };
  assert.equal((await c.aiModelsOnce('https://api.openai.com/v1/models')).ok, true);
  assert.equal(shell[0], 'nf_ai_http'); assert.equal(shell[1], direct.url); assert.equal(shell[2], '');
  assert.equal(shell[3], direct.options.headers); assert.equal(shell[3].Authorization, 'Bearer FAKE-OPENAI-LIST-KEY');
  assert.equal(shell[4], 8000); assert.equal(shell[5], 'GET');
  await c.aiModelsOnce('https://other-provider.invalid/v1/models');
  assert.equal(shell[3], direct.options.headers); assert.equal(Object.hasOwn(shell[3], 'Authorization'), false);
});
await test('local port probes and callers without optional headers remain credential-free', async () => {
  const c = context(); c.AI.base = 'https://api.openai.com/v1/responses'; c.AI.key = 'FAKE-OPENAI-LIST-KEY';
  c.AI_LOCAL_PRESETS = [{ id: 'test-local', name: 'Test', port: 11434 }];
  const calls = [];
  c.fetch = async (url, options) => { assert.equal(options.headers, undefined); throw new Error('synthetic CORS failure'); };
  c.aiShellHttp = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ data: [{ id: 'local-model' }] }) }; };
  const hits = await c.aiLocalProbe();
  assert.equal(hits.length, 1); assert.equal(hits[0].models[0], 'local-model');
  assert.equal(calls[0][1], 'http://127.0.0.1:11434/v1/models'); assert.equal(JSON.stringify(calls[0][3]), '{}');
  assert.equal(calls[0][5], 'GET');
  await c.aiShellGet('http://127.0.0.1:1234/v1/models', 4000);
  assert.equal(JSON.stringify(calls[1][3]), '{}');
});

/* 模型选择：实际生产函数 + 简单 DOM，仅模型响应和磁盘保存用内存替身。 */
function modelsContext() {
  const c = context();
  for (const id of ['ai-model', 'ai-modelnote', 'ai-local-models', 'ai-key', 'ai-base']) c.fields.set(id, element());
  c.fields.set('ai-local-mlist', element('select'));
  c.aiFillThink = () => c.aiThinkNote();
  c.aiSysNote = c.aiKeyNote = c.aiLocalFill = () => {};
  c.aiLocalNote = (text) => { c.localNote = text; };
  c.aiNetHint = () => '';
  c.aiShellHttp = async () => null;
  const start = source.indexOf('const AI_MODELS = ');
  assert.ok(start >= 0, 'missing production model-list state');
  vm.runInContext(source.slice(start, source.indexOf(';', start) + 1) + '\n' + [
    'aiModelsScope', 'aiModelsScopeSame', 'aiModelsSyncScope', 'aiModelListRender',
    'aiLocalFillList', 'aiRefreshModels', 'aiSelectModel', 'aiLocalModels', 'aiFillCfg',
  ].map(functionSource).join('\n'), c);
  c.models = vm.runInContext('AI_MODELS', c);
  c.aiFillCfg();
  return c;
}
const modelOptions = (c) => c.fields.get('ai-local-mlist').options.map((option) => option.value);
function modelResponse(ids, status = 200) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => ({ object: 'list', data: ids.map((id) => ({ id })) }),
    text: async () => JSON.stringify({ error: { message: 'synthetic model-list error', code: 'test_error' } }),
  };
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

await test('model picker shows the current manually configured model before any refresh', () => {
  const c = modelsContext();
  assert.match(template, /id="ai-local-mlist"/);
  assert.match(template, /id="ai-modelnote"/);
  assert.equal(c.fields.get('ai-local-mlist').value, 'old-model');
  assert.ok(modelOptions(c).includes('old-model'));
  assert.equal(c.fields.get('ai-model').value, 'old-model');
  assert.equal(c.saves.length, 0);
});

await test('refresh keeps the current model even when absent from the fetched list and does not save a replacement', async () => {
  const c = modelsContext(); const calls = [];
  c.fetch = async (url, options) => { calls.push({ url, options }); return modelResponse(['first-from-server', 'second-from-server']); };
  const result = await c.aiRefreshModels();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://old-provider.invalid/v1/models');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer FAKE-OLD-KEY');
  assert.equal(c.AI.model, 'old-model'); assert.equal(c.saves.length, 0);
  assert.equal(c.fields.get('ai-local-mlist').value, 'old-model');
  assert.ok(modelOptions(c).includes('first-from-server'));
  assert.ok(modelOptions(c).includes('second-from-server'));
  assert.equal(c.fields.get('ai-model').value, 'old-model');
  assert.equal(c.fields.get('ai-local-models').disabled, false);
  assert.ok(!c.fields.get('ai-modelnote').textContent.includes(c.AI.key));
});

await test('explicit selection and manual entry save the chosen model and synchronize both controls', () => {
  const c = modelsContext();
  c.aiLocalFillList(['listed-model', 'another-model']);
  c.aiSelectModel('listed-model');
  assert.equal(c.AI.model, 'listed-model'); assert.equal(c.saves.length, 1);
  assert.equal(JSON.parse(c.saves[0].state).model, 'listed-model');
  assert.equal(c.fields.get('ai-model').value, 'listed-model');
  assert.equal(c.fields.get('ai-local-mlist').value, 'listed-model');
  c.aiSelectModel('  manually-entered-model  ');
  assert.equal(c.AI.model, 'manually-entered-model'); assert.equal(c.saves.length, 2);
  assert.equal(c.fields.get('ai-model').value, 'manually-entered-model');
  assert.equal(c.fields.get('ai-local-mlist').value, 'manually-entered-model');
  assert.ok(modelOptions(c).includes('listed-model'), 'manual entry must keep fetched candidates');
  c.aiSelectModel('   ');
  assert.equal(c.AI.model, 'manually-entered-model'); assert.equal(c.saves.length, 2);
  assert.match(source, /bind\('ai-local-mlist', 'change', [\s\S]*?aiSelectModel\(/);
  assert.match(source, /bind\('ai-model', 'change', [\s\S]*?aiSelectModel\(/);
});

await test('changing endpoint or credential invalidates candidates but retains the selected model', () => {
  for (const field of ['base', 'key']) {
    const c = modelsContext(); c.aiLocalFillList(['old-source-only']);
    assert.ok(modelOptions(c).includes('old-source-only'));
    c.AI[field] = field === 'base' ? 'https://new-provider.invalid/v1/responses' : 'FAKE-NEW-KEY';
    c.aiFillCfg();
    assert.ok(!modelOptions(c).includes('old-source-only'), field);
    assert.equal(c.fields.get('ai-local-mlist').value, 'old-model');
    assert.equal(c.AI.model, 'old-model'); assert.equal(c.saves.length, 0);
  }
});

await test('two refreshes completing out of order keep only the newest candidates', async () => {
  const c = modelsContext(), first = deferred(), second = deferred(); let count = 0;
  c.fetch = async () => (++count === 1 ? first.promise : second.promise);
  const older = c.aiRefreshModels(); const newer = c.aiRefreshModels();
  second.resolve(modelResponse(['newest-candidate']));
  assert.equal((await newer).ok, true);
  first.resolve(modelResponse(['obsolete-candidate']));
  const oldResult = await older;
  assert.equal(oldResult.stale, true);
  assert.ok(modelOptions(c).includes('newest-candidate'));
  assert.ok(!modelOptions(c).includes('obsolete-candidate'));
  assert.equal(c.AI.model, 'old-model'); assert.equal(c.saves.length, 0);
  assert.equal(c.fields.get('ai-local-models').disabled, false);
});

await test('responses from an old endpoint or key cannot repopulate or overwrite the new source', async () => {
  for (const field of ['base', 'key']) {
    for (const status of [200, 401]) {
      const c = modelsContext(), old = deferred(); let count = 0;
      c.fetch = async () => (++count === 1 ? old.promise : modelResponse(['current-source-candidate']));
      const pending = c.aiRefreshModels();
      c.AI[field] = field === 'base' ? 'https://new-provider.invalid/v1/responses' : 'FAKE-NEW-KEY';
      c.aiFillCfg();
      assert.equal((await c.aiRefreshModels()).ok, true);
      const note = c.fields.get('ai-modelnote').textContent;
      old.resolve(modelResponse(['wrong-source-candidate'], status));
      assert.equal((await pending).stale, true);
      assert.ok(modelOptions(c).includes('current-source-candidate'));
      assert.ok(!modelOptions(c).includes('wrong-source-candidate'));
      assert.equal(c.fields.get('ai-modelnote').textContent, note);
      assert.equal(c.AI.model, 'old-model'); assert.equal(c.saves.length, 0);
    }
  }
});

await test('empty model lists and HTTP errors preserve the configured model; errors keep the last usable list', async () => {
  const c = modelsContext();
  c.aiLocalFillList(['previous-valid-candidate']);
  c.fetch = async () => modelResponse([], 401);
  const failed = await c.aiRefreshModels();
  assert.equal(failed.ok, false); assert.match(failed.err, /401/);
  assert.ok(modelOptions(c).includes('previous-valid-candidate'));
  assert.equal(c.AI.model, 'old-model'); assert.equal(c.saves.length, 0);
  assert.equal(c.fields.get('ai-local-models').disabled, false);
  c.fetch = async () => modelResponse([]);
  assert.equal((await c.aiRefreshModels()).ok, true);
  assert.equal(c.AI.model, 'old-model'); assert.equal(c.saves.length, 0);
  assert.equal(c.fields.get('ai-local-mlist').value, 'old-model');
});

await test('changing the model while a refresh is pending preserves that latest manual choice', async () => {
  const c = modelsContext(), response = deferred();
  c.fetch = async () => response.promise;
  const pending = c.aiRefreshModels();
  c.aiSelectModel('chosen-during-refresh');
  response.resolve(modelResponse(['server-first-model']));
  assert.equal((await pending).ok, true);
  assert.equal(c.AI.model, 'chosen-during-refresh'); assert.equal(c.saves.length, 1);
  assert.equal(c.fields.get('ai-local-mlist').value, 'chosen-during-refresh');
  assert.equal(c.fields.get('ai-model').value, 'chosen-during-refresh');
});

await test('model URL fallback stops after the source changes and never borrows the new credential', async () => {
  const c = modelsContext(), response = deferred(), calls = [];
  c.AI.base = 'https://old-provider.invalid'; c.aiFillCfg();
  c.fetch = async (url, options) => { calls.push({ url, authorization: options.headers.Authorization }); return response.promise; };
  const pending = c.aiRefreshModels();
  c.AI.base = 'https://new-provider.invalid/v1/responses'; c.AI.key = 'FAKE-NEW-KEY'; c.aiFillCfg();
  response.resolve(modelResponse([], 404));
  assert.equal((await pending).stale, true);
  assert.equal(calls.length, 1, 'do not try old-origin /v1/models after the configuration changes');
  assert.equal(calls[0].authorization, 'Bearer FAKE-OLD-KEY');
  assert.equal(c.AI.key, 'FAKE-NEW-KEY'); assert.equal(c.saves.length, 0);
});
console.log('AI settings regression checks passed: ' + passed);
