// 集中启动端路由（v1.18.0）：/launcher 前缀。
//  · GET /launcher/agent/poll —— agent 心跳（index.js EXEMPT 免登录，key 即凭证）：
//    在场登记 + 各服务状态上报（sv 白名单落库）+ 取回本人的未读短消息（uid+notify_key 双凭证，
//    不匹配则 notify_ok:false 且 messages 空、心跳照常——设备在场与消息可读是两件事）。
//  · 其余全部管理员：已上线电脑列表 / 改名 / 删除 / 轮换全局 key / 下载安装包（嵌入下载者的
//    uid+notify_key，装到谁电脑上就弹谁的消息）。
const express = require('express');
const { db, getSetting } = require('../db');
const svc = require('../services/launcherService');

const router = express.Router();
const isAdmin = (req) => !!req.user && req.user.role === 'admin';

// 安装包回连地址：Origin → Referer 根 → external_base_url 设置 → x-forwarded-proto + host
// （照 mcRoutes 同款探测顺序；从哪儿下载就嵌哪儿的地址——内网下载嵌内网、公网下载嵌公网）
function baseUrl(req) {
  const o = String(req.headers.origin || '').trim();
  if (/^https?:\/\//i.test(o)) return o.replace(/\/+$/, '');
  const ref = String(req.headers.referer || '').trim();
  const m = /^https?:\/\/[^\/\s]+/i.exec(ref);
  if (m) return m[0].replace(/\/+$/, '');
  const ext = String(getSetting(db, 'external_base_url', '') || '').trim();
  if (/^https?:\/\//i.test(ext)) return ext.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return (proto + '://' + (req.headers.host || 'localhost')).replace(/\/+$/, '');
}

// agent 心跳（EXEMPT）：20s 一跳，回 {ok, notify_ok, autoplay, messages, last_id, interval}
router.get('/launcher/agent/poll', (req, res) => {
  if (!svc.checkAgentKey(String(req.query.key || ''))) return res.status(403).json({ error: 'key 无效' });
  const id = String(req.query.id || '');
  if (!svc.DEVICE_ID_RE.test(id)) return res.status(400).json({ error: '设备号不合法' });
  const row = svc.ensureAgent(id, req.query, req.ip);
  res.json(svc.pollPayload(row, req.query));
});

// 已上线电脑（管理员）
router.get('/launcher/agents', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可查看' });
  res.json({ agents: svc.listAgents(), online_ms: svc.ONLINE_MS });
});
router.put('/launcher/agents/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可修改' });
  const r = svc.updateAgent(req.params.id, req.body || {});
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, agents: svc.listAgents() });
});
router.delete('/launcher/agents/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可删除' });
  const r = svc.deleteAgent(req.params.id);
  if (!r.ok) return res.status(404).json({ error: '设备不存在' });
  res.json({ ok: true, agents: svc.listAgents() });
});
router.post('/launcher/agent/rotate-key', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可轮换' });
  res.json({ ok: true, key: svc.rotateAgentKey() });
});
// 安装包（管理员）：嵌入全局 key + 下载者的 uid/notify_key（装到谁电脑上就弹谁的消息）
router.get('/launcher/agent/package', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅管理员可下载' });
  const uninstall = req.query.mode === 'uninstall';
  const uid = Number(req.user && req.user.id) || 0;
  const zip = svc.buildPackage(baseUrl(req), svc.getAgentKey(), uid, svc.notifyKeyFor(uid),
    uninstall ? { uninstall: true } : {});
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''"
    + encodeURIComponent(uninstall ? '启动端卸载包.zip' : '启动端安装包.zip'));
  res.send(zip);
});

module.exports = router;
