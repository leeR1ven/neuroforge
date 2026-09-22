// OpenAI Responses adapter. No transport credentials or application state live here.
// Protocol: https://developers.openai.com/api/docs/guides/function-calling
// Stateless reasoning: https://developers.openai.com/api/docs/guides/reasoning
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const clone = value => JSON.parse(JSON.stringify(value));

function protocolError(message, code = 'responses_protocol_error', details = {}) {
  const error = new Error(message);
  error.name = 'ResponsesProtocolError';
  Object.assign(error, details, { code, responsesProtocol: true, noToolFallback: true });
  return error;
}

export function isGPT6Model(model) {
  return /(?:^|\/)gpt-?6(?:$|[-.])/i.test(String(model || '').trim());
}

export function usesResponses(base, model) {
  return isGPT6Model(model) || /\/responses\/?(?:[?#]|$)/i.test(String(base || '').trim());
}

export function responsesURL(base) {
  let address = String(base || '').trim() || 'https://api.openai.com/v1';
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(address)) {
    address = (/^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(address) ? 'http://' : 'https://') + address;
  }
  let url;
  try { url = new URL(address); } catch { throw protocolError('Responses API 地址无效。', 'invalid_responses_url'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw protocolError('Responses API 仅支持 HTTP/HTTPS 地址。', 'invalid_responses_url');
  let path = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(path)) path = path.replace(/\/chat\/completions$/i, '/responses');
  else if (!/\/responses$/i.test(path)) path += /\/v\d+(?:beta)?$/i.test(path) ? '/responses' : '/v1/responses';
  url.pathname = path;
  url.hash = '';
  return url.toString();
}

function messageContent(content, role) {
  const output = role === 'assistant';
  if (content == null || content === '') return [];
  if (typeof content === 'string') return [{ type: output ? 'output_text' : 'input_text', text: content }];
  if (!Array.isArray(content)) throw protocolError('Responses 消息内容格式无效。', 'invalid_message_content');
  return content.map(part => {
    if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
      if (typeof part.text !== 'string') throw protocolError('Responses 文本内容必须为字符串。', 'invalid_message_content');
      return { type: output ? 'output_text' : 'input_text', text: part.text };
    }
    if (!output && part?.type === 'image_url') {
      const image = typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url;
      if (!image || typeof image.url !== 'string' || !image.url) throw protocolError('Responses 图片地址无效。', 'invalid_message_content');
      return { type: 'input_image', image_url: image.url, ...(image.detail ? { detail: image.detail } : {}) };
    }
    if (!output && ['input_image', 'input_file'].includes(part?.type)) return clone(part);
    if (output && part?.type === 'refusal' && typeof part.refusal === 'string') return clone(part);
    throw protocolError('Responses 不支持此消息内容类型：' + String(part?.type), 'unsupported_message_content');
  });
}

function functionCall(call) {
  if (!call?.id || !call.function?.name || typeof call.function.arguments !== 'string') {
    throw protocolError('历史工具调用缺少名称、参数或 call_id。', 'invalid_tool_history');
  }
  return { type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments };
}

export function buildResponsesRequest({ model, messages = [], tools = [], stream = false, maxOutputTokens, reasoningEffort } = {}) {
  if (typeof model !== 'string' || !model.trim()) throw protocolError('请填写 Responses 模型名称。', 'invalid_model');
  if (!Array.isArray(messages) || !Array.isArray(tools)) throw protocolError('Responses 消息和工具必须为数组。', 'invalid_request');
  const input = [];
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.responses_output)) {
      // Replay every item, including encrypted reasoning and message phase, exactly once.
      input.push(...clone(message.responses_output));
      continue;
    }
    if (message?.role === 'tool') {
      if (!message.tool_call_id) throw protocolError('工具结果缺少 tool_call_id。', 'invalid_tool_history');
      const output = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output });
      continue;
    }
    const role = message?.role === 'system' ? 'developer' : message?.role;
    if (!['developer', 'user', 'assistant'].includes(role)) throw protocolError('Responses 消息角色无效。', 'invalid_message_role');
    const content = messageContent(message.content, role);
    // Legacy assistant history has no Responses item id/status. Use the documented
    // EasyInputMessage string form rather than an incomplete ResponseOutputMessage.
    if (content.length) input.push({ role, content: role === 'assistant' ? content.map(part => part.text ?? part.refusal ?? '').join('') : content });
    if (role === 'assistant' && message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) throw protocolError('历史工具调用格式无效。', 'invalid_tool_history');
      input.push(...message.tool_calls.map(functionCall));
    }
  }
  const request = { model: model.trim(), input, store: false, include: ['reasoning.encrypted_content'], stream: !!stream };
  if (tools.length) {
    // Preserve the whole tool list. Provider limits must produce a visible API error,
    // never a silently truncated set of application capabilities.
    request.tools = tools.map(tool => {
      const fn = tool?.function || tool;
      if (tool?.type !== 'function' || !fn?.name) throw protocolError('Responses 工具必须为带名称的 function。', 'invalid_tool_schema');
      return { type: 'function', name: fn.name, ...(fn.description != null ? { description: fn.description } : {}),
        parameters: clone(fn.parameters || { type: 'object', properties: {} }), strict: false };
    });
    request.tool_choice = 'auto';
  }
  if (maxOutputTokens != null) {
    const amount = Number(maxOutputTokens);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw protocolError('最大输出 token 数必须为正整数。', 'invalid_max_output_tokens');
    request.max_output_tokens = amount;
  }
  const effort = String(reasoningEffort || '').trim().toLowerCase();
  if (effort && effort !== 'default') {
    const normalized = effort === 'off' ? 'low' : effort;
    if (!EFFORTS.has(normalized)) throw protocolError('GPT-6 思考强度仅支持 low、medium、high、xhigh、max。', 'invalid_reasoning_effort');
    request.reasoning = { effort: normalized };
  }
  return request;
}

function visibleOutput(output) {
  const texts = [], summaries = [];
  for (const item of output || []) {
    if (item?.type === 'message') {
      texts.push((item.content || []).map(part => part.type === 'output_text' ? part.text || '' : part.type === 'refusal' ? part.refusal || '' : '').join(''));
    } else if (item?.type === 'reasoning') {
      summaries.push((item.summary || []).map(part => part.text || '').join(''));
    }
  }
  return { content: texts.filter(Boolean).join('\n'), reasoning_content: summaries.filter(Boolean).join('\n') };
}

function responseFailure(data) {
  const visible = visibleOutput(data?.output);
  const detail = data?.error;
  if (data?.status === 'incomplete') {
    const reason = data.incomplete_details?.reason || 'unknown';
    return protocolError('Responses 输出未完成（' + reason + '），未执行任何工具；请增加输出上限后重试。', 'response_incomplete', {
      responseId: data.id, finishReason: reason === 'max_output_tokens' ? 'length' : reason, partialContent: visible.content,
    });
  }
  return protocolError(detail?.message || 'Responses 请求未成功完成（' + String(data?.status || '缺少状态') + '）。', detail?.code || 'response_not_completed', {
    responseId: data?.id, partialContent: visible.content, finishReason: data?.status || 'error',
  });
}

export function decodeResponses(data) {
  if (!data || data.error || data.status !== 'completed') throw responseFailure(data);
  if (!Array.isArray(data.output)) throw protocolError('Responses 响应缺少 output 数组。', 'invalid_response');
  const toolCalls = [], callIds = new Set();
  for (const item of data.output) {
    if (item?.status && item.status !== 'completed') throw protocolError('Responses 包含未完成的输出项，未执行任何工具。', 'incomplete_output_item');
    if (item?.type !== 'function_call') continue;
    if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name || typeof item.arguments !== 'string') {
      throw protocolError('Responses 工具调用缺少名称、参数或 call_id。', 'invalid_function_call');
    }
    let args;
    try { args = JSON.parse(item.arguments); } catch { throw protocolError('Responses 工具参数不是完整 JSON，未执行任何工具。', 'invalid_function_arguments'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw protocolError('Responses 工具参数必须为 JSON 对象。', 'invalid_function_arguments');
    if (callIds.has(item.call_id)) throw protocolError('Responses 返回重复的工具 call_id。', 'duplicate_function_call');
    callIds.add(item.call_id);
    toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
  }
  return { message: { ...visibleOutput(data.output), tool_calls: toolCalls.length ? toolCalls : null, responses_output: clone(data.output) },
    usage: data.usage || null, finishReason: toolCalls.length ? 'tool_calls' : 'stop' };
}

function abortError() {
  const error = protocolError('Responses 请求已取消。', 'aborted');
  error.name = 'AbortError';
  return error;
}

export async function readResponsesStream(res, onDelta, signal) {
  let reader;
  let onAbort;
  try {
    if (signal?.aborted) throw abortError();
    if (!res?.ok) {
      let detail = null;
      try { detail = JSON.parse(await res.text()); } catch { /* Keep status without echoing HTML or credentials. */ }
      throw protocolError(detail?.error?.message || 'Responses HTTP 请求失败：' + String(res?.status), detail?.error?.code || 'responses_http_error', { status: res?.status });
    }
    const contentType = res.headers?.get?.('content-type') || '';
    if (res.__nfNoStream || !res.body?.getReader || /application\/json/i.test(contentType)) {
      const result = decodeResponses(JSON.parse(await res.text()));
      if (signal?.aborted) throw abortError();
      onDelta?.(result.message.content, result.message.reasoning_content);
      return result;
    }
    reader = res.body.getReader();
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
    // The handler can fire between reads; attach a sink until the next read races it.
    aborted.catch(() => {});
    onAbort = () => { rejectAbort(abortError()); try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const items = new Map();
    let terminal = null, buffer = '', dataLines = [], eventName = '';
    let lastContent = '', lastReasoning = '';
    const decoder = new TextDecoder();
    const publish = () => {
      const visible = visibleOutput([...items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item));
      if (visible.content !== lastContent || visible.reasoning_content !== lastReasoning) {
        lastContent = visible.content; lastReasoning = visible.reasoning_content;
        onDelta?.(lastContent, lastReasoning);
      }
    };
    const getItem = (event, type) => {
      const index = event.output_index;
      if (!Number.isInteger(index) || index < 0) throw protocolError('Responses 流缺少输出项索引。', 'invalid_stream_event');
      if (!items.has(index)) items.set(index, { type, id: event.item_id, ...(type === 'message' ? { content: [] } : type === 'reasoning' ? { summary: [] } : { arguments: '' }) });
      const item = items.get(index);
      if (item.type !== type) throw protocolError('Responses 流输出项类型不一致。', 'invalid_stream_event');
      return item;
    };
    const handle = event => {
      const type = event.type || eventName;
      if (type === 'error') throw protocolError(event.message || event.error?.message || 'Responses 流返回错误。', event.code || event.error?.code || 'response_stream_error');
      if (['response.failed', 'response.incomplete', 'response.completed', 'response.cancelled'].includes(type)) {
        const response = event.response;
        if (type !== 'response.completed') throw responseFailure(response || { status: type.slice(9) });
        terminal = decodeResponses(response);
        onDelta?.(terminal.message.content, terminal.message.reasoning_content);
        return;
      }
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        if (!Number.isInteger(event.output_index) || event.output_index < 0 || !event.item?.type) throw protocolError('Responses 流输出项无效。', 'invalid_stream_event');
        items.set(event.output_index, clone(event.item));
        publish();
      } else if (type === 'response.output_text.delta' || type === 'response.output_text.done' || type === 'response.refusal.delta' || type === 'response.refusal.done') {
        const item = getItem(event, 'message');
        const index = event.content_index ?? 0;
        if (!Number.isInteger(index) || index < 0) throw protocolError('Responses 流内容索引无效。', 'invalid_stream_event');
        const refusal = type.startsWith('response.refusal.');
        const field = refusal ? 'refusal' : 'text';
        const part = item.content[index] ||= { type: refusal ? 'refusal' : 'output_text', [field]: '' };
        part[field] = type.endsWith('.delta') ? (part[field] || '') + (event.delta || '') : event[field] ?? part[field];
        publish();
      } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_summary_text.done') {
        const item = getItem(event, 'reasoning');
        const index = event.summary_index ?? 0;
        if (!Number.isInteger(index) || index < 0) throw protocolError('Responses 思考摘要索引无效。', 'invalid_stream_event');
        const part = item.summary[index] ||= { type: 'summary_text', text: '' };
        part.text = type.endsWith('.delta') ? (part.text || '') + (event.delta || '') : event.text ?? part.text;
        publish();
      } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        const item = getItem(event, 'function_call');
        item.arguments = type.endsWith('.delta') ? (item.arguments || '') + (event.delta || '') : event.arguments ?? item.arguments;
      }
    };
    const dispatch = () => {
      const data = dataLines.join('\n');
      dataLines = [];
      if (data && data !== '[DONE]') {
        let event;
        try { event = JSON.parse(data); } catch { throw protocolError('Responses SSE 事件包含无效 JSON。', 'invalid_stream_json'); }
        handle(event);
      }
      eventName = '';
    };
    const line = value => {
      if (!value) { dispatch(); return; }
      if (value[0] === ':') return;
      const split = value.indexOf(':');
      const field = split < 0 ? value : value.slice(0, split);
      let content = split < 0 ? '' : value.slice(split + 1);
      if (content[0] === ' ') content = content.slice(1);
      if (field === 'data') dataLines.push(content);
      else if (field === 'event') eventName = content;
    };
    const consume = final => {
      while (!terminal) {
        const match = /[\r\n]/.exec(buffer);
        if (!match) break;
        const at = match.index;
        if (buffer[at] === '\r' && at === buffer.length - 1 && !final) break;
        const skip = buffer[at] === '\r' && buffer[at + 1] === '\n' ? 2 : 1;
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + skip);
      }
      if (final && !terminal) {
        if (buffer) { line(buffer); buffer = ''; }
        if (dataLines.length) dispatch();
      }
    };
    while (!terminal) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (signal?.aborted) throw abortError();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      consume(done);
      if (done && !terminal) throw protocolError('Responses 流在完成事件之前断开，未执行任何工具。', 'response_stream_truncated', { partialContent: lastContent });
    }
    return terminal;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError();
    if (error?.responsesProtocol) throw error;
    throw protocolError(error?.message || 'Responses 响应读取失败。', 'response_read_error');
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (reader) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}
