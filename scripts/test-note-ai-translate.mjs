// 笔记 AI 辅助 —— 「一律译成中文」+ 语种识别（v1.13.15）
//
// 用户报障：「AI 翻译功能——没有能将英文笔记翻译成中文，也没有能识别出笔记上是英文，也没有翻译成中文。」
// 根因：buildAssistPrompt 把翻译提示词写死成「请把下面的内容翻译成英文」——英文笔记点「翻译」等于原样
// 退回，而且从头到尾没有任何语言识别。
//
// 这个用例用一个**假 AI 端点**（本地 http，记下收到的 prompt 并按需回中文）来验：
//   ① 提示词真的是「译成简体中文」而不是「译成英文」；
//   ② detected 如实报出源语言（en/ja/ko/ru…），不是恒空；
//   ③ 正文已是中文时**根本不发请求**（不白烧 token），并给出可执行的提示；
//   ④ 代码块里的英文不参与语言判断；选中片段只发选中那段。
// 起隔离服务器（独立 PORT + DATA_DIR，跑完即删），绝不碰 data/workbench.sqlite。
import http from 'node:http';
import { startServer, login, api, checker, j } from './_noteE2E.mjs';

// ---------- 假 AI 端点：OpenAI 兼容的最小 /chat/completions ----------
const hits = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 不是 JSON 也照记 */ }
    hits.push({ url: req.url, auth: req.headers.authorization || '', body });
    const userMsg = (body.messages || []).find((m) => m.role === 'user')?.content || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '【中文译文】你好，世界。' }, finish_reason: userMsg.includes('TRUNCATE_MARK') ? 'length' : 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      echo_has_user_msg: !!userMsg,
    }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const { B, stop } = await startServer({ tag: 'aitrans', port: 3978 });
const s = checker();
const L = await login(B, 'admin', 'test123456');
const A = api(B, L.H);

const made = [];
const mkNote = async (title, content) => {
  const r = await A.post('/notes', { title, content });
  made.push(r.body.id);
  return r.body.id;
};

const EN = [
  '# Weekly notes',
  '',
  'The deployment pipeline is still flaky on Fridays. We should move the database migration',
  'out of the release script and run it as a separate step, otherwise a failed migration',
  'leaves the service in a half-updated state that nobody notices until Monday morning.',
].join('\n');

const JA = 'これは日本語のメモです。デプロイの手順を見直す必要があります。テストも足りません。';
const KO = '이것은 한국어 메모입니다. 배포 절차를 다시 검토해야 합니다. 테스트도 부족합니다.';
const RU = 'Это заметка на русском языке. Нужно пересмотреть процедуру развёртывания.';
const ZH = '这是一篇中文笔记：部署流程还不太稳，周五发布经常出问题，得把数据库迁移拆出去单独跑。';

try {
  // ---------- 准备：把 AI 配置指向假端点 ----------
  let r = await A.post('/ai/config', { model: 'stub-model', base_url: STUB, api_key: 'stub-key' });
  s.ck('配好 AI（指向假端点）', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  // ---------- ① 英文笔记 → 译成中文 ----------
  const enId = await mkNote('E2E 英文笔记', EN);
  hits.length = 0;
  r = await A.post(`/notes/${enId}/ai-assist`, { action: 'translate' });
  s.ck('英文笔记 translate → 200', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  s.ck('识别为英文（detected=en）', r.body.detected === 'en', `detected=${r.body.detected}`);
  s.ck('拿到中文译文（假端点回了什么就是什么）', r.body.result === '【中文译文】你好，世界。', JSON.stringify(r.body.result));
  s.ck('假端点确实收到了一次请求', hits.length === 1, `hits=${hits.length}`);
  const p1 = hits[0]?.body?.messages?.find((m) => m.role === 'user')?.content || '';
  s.ck('提示词要求「译成简体中文」', /翻译成\*\*简体中文\*\*/.test(p1), p1.slice(0, 80));
  s.ck('提示词里没有「翻译成英文」', !/翻译成英文/.test(p1), p1.slice(0, 80));
  s.ck('原文完整带上了（没被截掉）', p1.includes('The deployment pipeline is still flaky on Fridays'), p1.slice(-120));
  s.ck('请求打到了 /chat/completions 且带 key', hits[0]?.url === '/chat/completions' && hits[0]?.auth === 'Bearer stub-key',
    `${hits[0]?.url} ${hits[0]?.auth}`);
  s.ck('translate 用低温（0.3）', hits[0]?.body?.temperature === 0.3, String(hits[0]?.body?.temperature));

  // ---------- ② 日 / 韩 / 俄 都能被认出来（不能一律当「外文」） ----------
  for (const [name, text, want] of [['日文', JA, 'ja'], ['韩文', KO, 'ko'], ['俄文', RU, 'ru']]) {
    const id = await mkNote(`E2E ${name}笔记`, text);
    const rr = await A.post(`/notes/${id}/ai-assist`, { action: 'translate' });
    s.ck(`${name}笔记识别为 ${want}`, rr.status === 200 && rr.body.detected === want,
      `${rr.status} detected=${rr.body.detected}`);
  }

  // ---------- ③ 已经是中文：不发请求，如实提示 ----------
  const zhId = await mkNote('E2E 中文笔记', ZH);
  hits.length = 0;
  r = await A.post(`/notes/${zhId}/ai-assist`, { action: 'translate' });
  s.ck('中文笔记 translate → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  s.ck('说明「已经是中文，不需要翻译」', /已经是中文/.test(r.body.error || ''), r.body.error);
  s.ck('提示里告诉用户「选中外文段落再点译成中文」', /选中/.test(r.body.error || '') && /译成中文/.test(r.body.error || ''), r.body.error);
  s.ck('detected 报中文', r.body.detected === 'zh', `detected=${r.body.detected}`);
  s.ck('中文笔记一次 AI 请求都没发（没白烧 token）', hits.length === 0, `hits=${hits.length}`);

  // 预览阶段也要拦（等 AI 跑完再说等于白花钱）
  r = await A.post(`/notes/${zhId}/ai-assist/preview`, { action: 'translate' });
  s.ck('中文笔记 preview 也拦 → 400', r.status === 400 && r.body.detected === 'zh', `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

  // ---------- ④ 代码块里的英文不参与语言判断 ----------
  const zhWithCode = await mkNote('E2E 中文笔记带大段代码',
    ['部署脚本改一版，把迁移拆出来单独跑：', '', '```js', EN, EN, EN, '```', '', '这样失败了也不会卡在半更新状态。'].join('\n'));
  r = await A.post(`/notes/${zhWithCode}/ai-assist/preview`, { action: 'translate' });
  s.ck('中文正文 + 大段英文代码块 → 仍判为中文', r.status === 400 && r.body.detected === 'zh',
    `${r.status} detected=${r.body.detected}`);

  // 反过来：英文正文带一段中文注释，仍应判为英文
  const enWithCn = await mkNote('E2E 英文笔记带中文注释', [EN, '', '```js', '// 这里是中文注释，不影响判断', 'const x = 1;', '```'].join('\n'));
  r = await A.post(`/notes/${enWithCn}/ai-assist/preview`, { action: 'translate' });
  s.ck('英文正文 + 中文注释 → 仍判为英文', r.status === 200 && r.body.detected === 'en',
    `${r.status} detected=${r.body.detected}`);

  // ---------- ⑤ 选中片段优先（中文笔记里选中一段英文） ----------
  hits.length = 0;
  r = await A.post(`/notes/${zhId}/ai-assist`, { action: 'translate', selection: EN });
  s.ck('中文笔记 + 选中英文段落 → 200', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  s.ck('识别的是选中那段的语言（en）', r.body.detected === 'en', `detected=${r.body.detected}`);
  const p5 = hits[0]?.body?.messages?.find((m) => m.role === 'user')?.content || '';
  s.ck('只发了选中那段，没把整篇中文带上', p5.includes('deployment pipeline') && !p5.includes('部署流程还不太稳'), p5.slice(0, 100));

  // ---------- ⑥ 别的动作不受影响（summarize 不该被语言判据误拦） ----------
  hits.length = 0;
  r = await A.post(`/notes/${zhId}/ai-assist`, { action: 'summarize' });
  s.ck('中文笔记 summarize 照常 200（没被「已是中文」误拦）', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  r = await A.post(`/notes/${enId}/ai-assist`, { action: 'continue' });
  s.ck('英文笔记 continue 照常 200', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

  // ---------- ⑥b 长文翻译别被 1500 token 掐断，掐断了要如实说 ----------
  hits.length = 0;
  r = await A.post(`/notes/${enId}/ai-assist`, { action: 'translate' });
  s.ck('translate 的 max_tokens 放宽到 4000（不再是 1500）', hits[0]?.body?.max_tokens === 4000, String(hits[0]?.body?.max_tokens));
  s.ck('正常结尾时 truncated=false', r.body.truncated === false, String(r.body.truncated));

  const longNote = await mkNote('E2E 会被截断的英文', EN + ' TRUNCATE_MARK');
  r = await A.post(`/notes/${longNote}/ai-assist`, { action: 'translate' });
  s.ck('finish_reason=length 时 truncated=true（前端会提示没译完）', r.status === 200 && r.body.truncated === true,
    `${r.status} truncated=${r.body.truncated}`);
  hits.length = 0;
  r = await A.post(`/notes/${zhId}/ai-assist`, { action: 'summarize' });
  s.ck('summarize 仍是 1500（没跟着放宽）', hits[0]?.body?.max_tokens === 1500, String(hits[0]?.body?.max_tokens));

  // ---------- ⑦ 太短的正文别硬猜 ----------
  const tiny = await mkNote('E2E 极短', 'ok');
  r = await A.post(`/notes/${tiny}/ai-assist/preview`, { action: 'translate' });
  s.ck('「ok」这种太短的正文判 unknown（放行交给模型）', r.status === 200 && r.body.detected === 'unknown',
    `${r.status} detected=${r.body.detected}`);

  // ---------- ⑧ 走脱敏会话那条路：预览给的 detected 要能带回来 ----------
  r = await A.post(`/notes/${enId}/ai-assist/preview`, { action: 'translate' });
  s.ck('英文笔记 preview → 200 且带 detected=en', r.status === 200 && r.body.detected === 'en',
    `${r.status} detected=${r.body.detected}`);
  const sid = r.body.session_id;
  if (sid) {
    const rr = await A.post(`/notes/${enId}/ai-assist`, { action: 'translate', session_id: sid });
    s.ck('带 session_id 发送 → 200', rr.status === 200, `${rr.status} ${JSON.stringify(rr.body).slice(0, 120)}`);
  } else {
    s.ck('（脱敏总开关关着，跳过会话路径）', true, '');
  }
} finally {
  stop();
  stub.close();
}
s.done();
