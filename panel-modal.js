/* panel-modal.js —— 模态面板辅助（20260911 需求 ④）
 *
 * .type-manage 面板已改为 fixed 模态浮层（styles.css），本模块补交互：
 *   · 点击遮罩（::before 命中面板元素本身）→ 关闭
 *   · Esc → 关闭全部打开的 .type-manage
 *   · **互斥（20260917 需求 ①）**：任一面板变为可见时自动关闭其余面板（开新关旧）——
 *     根除"二级弹窗与一级弹窗同层叠加"问题；MutationObserver 兜底后插入面板。
 * 无依赖；type.html / concepts.html / data-actions.js 引入即可（页面内所有面板自动生效）。
 */
(function () {
  'use strict';

  function panels() {
    return Array.prototype.slice.call(document.querySelectorAll('.type-manage'));
  }

  function closeAll() {
    panels().forEach(function (p) { p.hidden = true; });
  }

  var mo = null;

  function bind() {
    panels().forEach(function (p) {
      if (p.dataset.modalBound) return;
      p.dataset.modalBound = '1';
      // 点击遮罩：::before 属于面板自身，命中 target === 面板 即视为点到遮罩
      p.addEventListener('click', function (e) {
        if (e.target === p) p.hidden = true;
      });
      if (mo) mo.observe(p, { attributes: true, attributeFilter: ['hidden'] });
    });
  }

  // 全局互斥（开新关旧）：任一 .type-manage 由 hidden → 可见，其余一律关闭
  function enforceMutualExclusion() {
    if (typeof MutationObserver === 'undefined') return;   // 无头/旧环境降级：不互斥
    mo = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        var t = m.target;
        if (m.attributeName === 'hidden' && !t.hidden) {
          panels().forEach(function (p) {
            if (p !== t) p.hidden = true;
          });
        }
      });
    });
    panels().forEach(function (p) {
      mo.observe(p, { attributes: true, attributeFilter: ['hidden'] });
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(); enforceMutualExclusion(); });
  } else {
    bind();
    enforceMutualExclusion();
  }
  // 面板可能后插入：暴露给页面手动调用
  window.PanelModal = { bind: bind, closeAll: closeAll, enforceMutualExclusion: enforceMutualExclusion };
})();
