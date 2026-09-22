/* 本地 UI 联调夹具：不连接外网、不使用真实 Key。先构建，再运行本文件。
 * 在 http://127.0.0.1:8876 的 AI 设置中填本机 /v1/responses、gpt-6-astra、
 * Key=test-only-not-a-real-key。发送任意文字，夹具请求添加一个节点再接收执行结果。
 * GET /v1/models 返回假模型清单；test-only-other-key 返回另一份清单，供来源隔离测试。
 * 除这两枚明确的假 Key 外均返回 401，凭证永不回显或记录。
 * 不模拟模型推理质量，仅检查真实界面的协议与工具执行往返。Ctrl+C 结束。 */
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const page = new URL('../prototype/index.html', import.meta.url);
const port = Number(process.env.NF_SMOKE_PORT || 8876);
let requests = 0;
const fakeModelLists = new Map([
  ['test-only-not-a-real-key', ['mock-first-model', 'gpt-6-astra', 'mock-custom-model']],
  ['test-only-other-key', ['mock-other-account-model', 'gpt-6-astra']],
]);
const rejectCredential = (res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'This offline fixture accepts only its documented fake test credentials.', code: 'invalid_api_key' } }));
};
const server = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(page).pipe(res); return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    const fakeKey = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const list = fakeModelLists.get(fakeKey);
    if (!list || req.headers.authorization !== 'Bearer ' + fakeKey) { rejectCredential(res); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ object: 'list', data: list.map((id) => ({ id, object: 'model', owned_by: 'offline-test-fixture' })) }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
  if (req.headers.authorization !== 'Bearer test-only-not-a-real-key') { rejectCredential(res); return; }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, 'gpt-6-astra');
    assert.equal(body.store, false);
    assert.ok(!('temperature' in body) && !('max_tokens' in body) && !('thinking' in body));
    assert.ok(Array.isArray(body.input));
    const feedback = body.input.findLast((x) => x.type === 'function_call_output');
    const ping = body.tool_choice?.name === 'nf_ping';
    const direct = body.tools?.some((t) => t.name === 'add_node');
    const call = { type: 'function_call', id: 'fc_smoke', call_id: 'call_smoke', status: 'completed',
      name: ping ? 'nf_ping' : direct ? 'add_node' : 'run_tool',
      arguments: JSON.stringify(ping ? {text:'收到'} : direct ? {x:90,y:0,z:0} : {name:'add_node',args:{x:90,y:0,z:0}}) };
    const reply = '本地 Responses 联调通过：神经元已添加，工具结果已回传。';
    const output = feedback ? [{type:'message',id:'msg_smoke',role:'assistant',status:'completed',
      content:[{type:'output_text',text:reply,annotations:[]}]}] : [call];
    const response = {object:'response',id:'resp_smoke_'+(++requests),status:'completed',output,
      usage:{input_tokens:10,output_tokens:10,total_tokens:20}};
    console.log(JSON.stringify({request:requests,stream:body.stream,toolResult:!!feedback,
      image:body.input.some((m) => m.content?.some?.((c) => c.type === 'input_image'))}));
    if (body.stream) {
      res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache'});
      const event = (type, data) => res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
      if (feedback) event('response.output_text.delta',{item_id:'msg_smoke',output_index:0,content_index:0,delta:reply});
      else {
        event('response.output_item.added',{output_index:0,item:{...call,status:'in_progress',arguments:''}});
        event('response.function_call_arguments.delta',{item_id:'fc_smoke',output_index:0,delta:call.arguments});
        event('response.output_item.done',{output_index:0,item:call});
      }
      event('response.completed',{response}); res.end();
    } else { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(response)); }
  } catch (e) { console.error(e.message); res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:e.message}})); }
});
server.listen(port,'127.0.0.1',()=>console.log('GPT-6 UI smoke fixture: http://127.0.0.1:'+server.address().port));
