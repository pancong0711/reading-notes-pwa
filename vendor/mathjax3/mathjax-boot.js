/* mathjax-boot.js —— PWA 公式渲染启动与定点排版辅助（B1：MathJax v3 离线 vendor）
 *
 * 用法：
 *   1) 页面 <head> 里在引用本模块前设置 window.MathJax 配置（或在模块内 setGlobalConfig 后
 *      惰性加载 tex-svg.js）；这里提供 ensureMathJaxLoaded() 统一入口：
 *       - 首次调用往 document.head 注入 <script src="vendor/mathjax3/tex-svg.js">
 *       - 返回 Promise，加载完成后 resolve（脚本自带 MathJax.startup，ready 后可 typeset）
 *   2) typesetInto(containerEl)：对容器内新插入的 .math 节点定点排版（幂等；
 *      MathJax 未就绪时静默跳过——公式保持 $…$ 原文可见的降级）。
 *
 * 依赖约定：delimiters 由 markdown-lite 公式识别统一包成单一 DOM 节点
 *   <span class="math math-inline">$…$</span> / <span class="math math-block">$$…$$</span>，
 * 因此 MathJax 仅需在容器内查找 .math 元素并对其中文本逐条 tex2svgPromise。
 * 正文先经 markdown-lite 转义，$ 不会与 HTML 冲突。
 */
const MATHJAX_SRC = 'vendor/mathjax3/tex-svg.js';

let _promise = null;

/** 在加载 tex-svg.js 前注入 MathJax 全局配置（只写一次） */
function setGlobalConfig() {
  if (window.__mathjaxConfigSet) return;
  window.__mathjaxConfigSet = true;
  window.MathJax = Object.assign({
    tex: {
      inlineMath: [['$', '$']],
      displayMath: [['$$', '$$']],
      packages: { '[+]': ['base'] },   // 默认包栈（含 ams）；保持轻量可再加
    },
    svg: { fontCache: 'local' },
    options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'] },
    startup: { typeset: false },       // 不做全页自动排版，由我们按容器定点
  }, window.MathJax || {});
}

/** 惰性加载 tex-svg.js（单例），返回 Promise */
export function ensureMathJaxLoaded() {
  if (_promise) return _promise;
  if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
    _promise = window.MathJax.startup.promise;
    return _promise;
  }
  setGlobalConfig();
  _promise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MATHJAX_SRC;
    s.async = true;
    s.onload = () => {
      // tex-svg.js 单文件组件自带 startup；ready 后 resolve
      Promise.resolve(window.MathJax?.startup?.promise).then(() => resolve()).catch(reject);
    };
    s.onerror = () => { _promise = null; reject(new Error('MathJax 加载失败：' + MATHJAX_SRC)); };
    document.head.appendChild(s);
  });
  return _promise;
}

/** 对容器内 .math 元素逐条排版（幂等；未就绪静默跳过） */
export async function typesetInto(container) {
  if (!window.MathJax || typeof window.MathJax.tex2svgPromise !== 'function') {
    // 尚未就绪：尝试惰性加载；仍失败则返回 false（公式保持原文）
    try { await ensureMathJaxLoaded(); } catch { return false; }
  }
  const nodes = (container && container.querySelectorAll)
    ? container.querySelectorAll('span.math')
    : [];
  let count = 0;
  for (const el of nodes) {
    try {
      // tex2svgPromise 接收不带定界符的 TeX 源码：剥掉行内 $…$ / 块级 $$…$$
      let src = String(el.textContent || '').trim();
      if (el.classList.contains('math-block')) {
        src = src.replace(/^\$\$/, '').replace(/\$\$$/, '');
      } else {
        src = src.replace(/^\$/, '').replace(/\$$/, '');
      }
      const display = el.classList.contains('math-block');
      const node = await window.MathJax.tex2svgPromise(src, { display });
      el.innerHTML = '';
      el.appendChild(node);
      count++;
    } catch (e) {
      // 单条公式渲染失败：保留原文可见（不上抛）
      el.classList.add('math-error');
    }
  }
  return count;
}

export default { ensureMathJaxLoaded, typesetInto };