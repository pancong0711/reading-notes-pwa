/* panel-modal.js —— 模态面板辅助（20260911 需求 ④）
 *
 * .type-manage 面板已改为 fixed 模态浮层（styles.css），本模块补交互：
 *   · 点击遮罩（::before 命中面板元素本身）→ 关闭
 *   · Esc → 关闭全部打开的 .type-manage
 * 无依赖；type.html / concepts.html 引入即可（页面内所有面板自动生效）。
 */
(function () {
  'use strict';

  function panels() {
    return Array.prototype.slice.call(document.querySelectorAll('.type-manage'));
  }

  function closeAll() {
    panels().forEach(function (p) { p.hidden = true; });
  }

  function bind() {
    panels().forEach(function (p) {
      if (p.dataset.modalBound) return;
      p.dataset.modalBound = '1';
      // 点击遮罩：::before 属于面板自身，命中 target === 面板 即视为点到遮罩
      p.addEventListener('click', function (e) {
        if (e.target === p) p.hidden = true;
      });
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
  // 面板可能后插入：暴露给页面手动调用
  window.PanelModal = { bind: bind, closeAll: closeAll };
})();
