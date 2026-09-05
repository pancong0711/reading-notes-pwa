/* sw-register.js —— 全页面统一注册 Service Worker
 * 背景：早期仅 diary.js 注册 SW，日记页改版为 type.html 后注册代码不再执行，
 * 导致旧 SW 永不更新（页面拿缓存壳、export.json 却强制走网络 → 同步 NetworkError）。
 * 本脚本由所有主页面引入：每次访问都会触发浏览器对 sw.js 的更新检查，
 * 新版 SW（缓存版本号变更）安装后 skipWaiting 接管、activate 清理旧缓存，自动自愈。
 * 普通 script，任意页面加载一次即可（SW 作用域为整个站点）。
 */
(function () {
  'use strict';
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function (err) {
      console.warn('Service Worker 注册失败：', err);
    });
  }

  /* 修复轮 R9c：页脚 SW 版本角标——缓存键形如 reading-notes-v27；
   * 取已缓存的最大版本号（更新过渡期可能新旧并存），用户可一眼确认"改了没生效"。
   * 放在 ready 之后（首访无 SW 时 caches 可能为空，静默跳过）。 */
  if ('serviceWorker' in navigator && 'caches' in window) {
    navigator.serviceWorker.ready
      .then(function () { return caches.keys(); })
      .then(function (keys) {
        var versions = (keys || [])
          .map(function (k) { var m = /reading-notes-v(\d+)/.exec(k); return m ? parseInt(m[1], 10) : 0; })
          .filter(function (n) { return n > 0; });
        if (!versions.length) return;
        var footers = document.querySelectorAll('.site-footer .container');
        if (!footers.length) return;
        footers.forEach(function (el) {
          el.innerHTML = el.innerHTML + ' · <span class="sw-version">SW v' + Math.max.apply(null, versions) + '</span>';
        });
      })
      .catch(function () { /* Cache Storage 不可用（隐私模式等）：无角标 */ });
  }
})();