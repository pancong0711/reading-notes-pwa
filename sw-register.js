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
})();