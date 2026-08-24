/* file-warning.js —— file:// 直开提示
 * PWA 的笔记页/热力图使用 ES Module，file:// 直开会被浏览器 CORS 拦截，
 * 导致页面空白。本脚本在 file:// 下显示提示条，引导用户起本地服务。
 * 普通 script，三个页面均引入。
 */
(function () {
  'use strict';
  if (window.location.protocol !== 'file:') return;

  var bar = document.createElement('div');
  bar.setAttribute('role', 'alert');
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:9999;' +
    'background:#c0392b;color:#fff;font-size:13px;line-height:1.5;' +
    'padding:8px 14px;text-align:center;';
  bar.textContent =
    '⚠️ 当前为 file:// 直开模式，笔记/热力图模块可能无法加载。' +
    '请在终端运行：cd app/pwa && python3 -m http.server 8000，' +
    '然后访问 http://localhost:8000';
  document.body.insertBefore(bar, document.body.firstChild);
})();
