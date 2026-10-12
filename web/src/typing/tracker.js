// 打字时长/正确/错误统计上报：进入模式首次击键开始计时，
// 每 20 秒心跳 + 页面隐藏/退出模式时补报；服务端按「用户+当天」累加。
// v1.13.13 起多带一个 session（本次进入模式的会话 id）：服务端据此把同一场练习的多次心跳
// 归成「打字记录」里的一行流水（带开始时间与打字项目），没有它就会 20 秒一条。
import { api } from '../api';

export function createTracker(mode) {
  const session = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let correct = 0;
  let wrong = 0;
  let seconds = 0;
  let started = false;
  let secTimer = null;
  let beatTimer = null;
  let onHide = null;

  function flush() {
    if (!seconds && !correct && !wrong) return;
    const payload = { mode, session, seconds, correct, wrong };
    seconds = 0; correct = 0; wrong = 0;
    api.post('/typing/progress', payload).catch(() => {});
  }
  function ensure() {
    if (started) return;
    started = true;
    secTimer = setInterval(() => { seconds++; }, 1000);
    beatTimer = setInterval(flush, 20000);
    onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
  }
  return {
    hit(ok) { ensure(); ok ? correct++ : wrong++; },
    flush,
    dispose() {
      flush();
      clearInterval(secTimer);
      clearInterval(beatTimer);
      if (onHide) document.removeEventListener('visibilitychange', onHide);
      started = false;
    },
  };
}
