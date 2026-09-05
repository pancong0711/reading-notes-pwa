/* reading-font.js —— 阅读字号档位应用器（需求 20260905-批次三）
 *
 * localStorage 键 reading-font-size ∈ ''(标准) | small | large | xlarge
 * → 写 <html data-fs="…">，styles.css 的 --fs-mul 生效（详情页/图谱面板/编辑器预览同源）。
 * 在 note.html / type.html / graph.html 的 <head> 内同步加载（先于首屏渲染，避免字号跳动）。
 * 档位切换 UI 在 note.html 题头「Aa」popover。
 */
(function () {
  'use strict';
  var KEY = 'reading-font-size';
  var VALID = { small: 1, large: 1, xlarge: 1 };   // '' = 标准（无 data-fs）
  var v = '';
  try { v = localStorage.getItem(KEY) || ''; } catch (e) { /* 隐私模式等：用标准档 */ }
  if (VALID[v]) document.documentElement.setAttribute('data-fs', v);
  else { document.documentElement.removeAttribute('data-fs'); try { localStorage.removeItem(KEY); } catch (e) {} }
})();
