/* print-export.js —— PWA「导出/生成」纯函数模块（打印草稿 HTML / 书稿 markdown / 范围过滤）
 *
 * 无 DOM 依赖（node 无头测试可直接 import）：
 *   - filterNotesByScope(notes, opts)：按范围（全部 / 某书 / 某类型 / 日期区间）过滤
 *   - buildPrintHtml(notes, title, catalogById?)：组装可打印 HTML——
 *       标题 + 统计行 + 每篇用 renderNoteDetail（复用共享详情组件）+ A4 分页样式
 *   - buildMarkdownDraft(notes, title)：组装「下载书稿」markdown（标题/日期/正文/tags）
 *   - scopeLabel(scope, opts)：范围中文描述（打印标题 / 下载文件名用）
 */
import { renderNoteDetail } from './note-detail.js';

/* 内置类型显示名（文件名与打印头用；自定义类型由调用方传入 label） */
const TYPE_LABELS = { note: '阅读笔记', diary: '日记', log: '日志', memo: '备忘' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 范围中文描述：scope ∈ all | book | type | date。
 * @param {string} scope
 * @param {object} [opts]  { label, dateFrom, dateTo }——label 由调用方传入选中的书名/类型显示名
 * @returns {string} 如「全部」「某本书」「日记」「2026-08-01_2026-08-31」
 */
export function scopeLabel(scope, opts = {}) {
  const { label = '', dateFrom = '', dateTo = '' } = opts;
  if (scope === 'book') return label || '某本书';
  if (scope === 'type') return label || '某类型';
  if (scope === 'date') {
    const from = String(dateFrom || '').slice(0, 10);
    const to = String(dateTo || '').slice(0, 10);
    return (from || to) ? `${from || '…'}_${to || '…'}` : '日期区间';
  }
  return '全部';
}

/**
 * 按范围过滤记录（纯函数，不改动入参）。
 * @param {Array<object>} notes  IndexedDB 全量记录（getAllNotes()）
 * @param {object} [opts] { scope, book, type, dateFrom, dateTo }
 *   - book：与记录的 book 字段全等匹配；
 *   - type：与记录 type 字段全等匹配（缺省视为 note）；
 *   - date：date 闭区间比较（YYYY-MM-DD 字符串）；无日期记录剔除
 * @returns {Array<object>} 过滤后的记录
 */
export function filterNotesByScope(notes, opts = {}) {
  const { scope = 'all', book = '', type = '', dateFrom = '', dateTo = '' } = opts;
  let list = Array.isArray(notes) ? notes.slice() : [];
  if (scope === 'book') {
    const target = String(book || '');
    list = list.filter((n) => String(n.book || '') === target);
  } else if (scope === 'type') {
    const target = String(type || '');
    list = list.filter((n) => String(n.type || 'note') === target);
  } else if (scope === 'date') {
    const from = String(dateFrom || '').slice(0, 10);
    const to = String(dateTo || '').slice(0, 10);
    list = list.filter((n) => {
      const d = String(n.date || '');
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }
  return list;
}

/** 统计行：共 N 条 ｜ 日期 X ～ Y ｜（无日期 M 条时注明） */
function buildStats(list) {
  const dated = list.filter((n) => n.date);
  const parts = [`共 ${list.length} 条`];
  if (dated.length) {
    const dates = dated.map((n) => String(n.date)).sort();
    parts.push(`日期 ${dates[0]} ～ ${dates[dates.length - 1]}`);
  }
  if (dated.length !== list.length) {
    parts.push(`${list.length - dated.length} 条无日期`);
  }
  return esc(parts.join(' ｜ '));
}

/** 单篇打印块：标题 + 元信息行 + 共享详情组件输出 */
function buildPrintItem(n, catalogById) {
  const typeName = TYPE_LABELS[n.type] || '';  // 自定义类型不额外显示（详情内已见）
  const meta = [String(n.date || '无日期')];
  if (n.book) meta.push(`《${n.book}》`);
  if (typeName) meta.push(typeName);
  return `<article class="print-note">
  <h2>${esc(n.title || '未命名')}</h2>
  <p class="print-meta">${meta.map((m) => esc(m)).join(' ｜ ')}</p>
  <div class="note-detail">${renderNoteDetail(n, catalogById)}</div>
</article>`;
}

/** 打印/预览用内联样式（A4；每篇尽量不跨页拆分） */
const PRINT_CSS = `
  @page { size: A4; margin: 2cm 1.8cm; }
  body { font-family: "Noto Serif CJK SC", "Source Han Serif SC", "PingFang SC", serif;
         font-size: 11pt; line-height: 1.9; color: #222; }
  .print-title { font-size: 20pt; margin: 0 0 6px; padding-bottom: 8px;
                 border-bottom: 2px solid #c9a96e; }
  .print-stats { font-size: 10pt; color: #666; margin: 10px 0 26px; }
  .print-empty { margin-top: 40px; text-align: center; }
  .print-note { page-break-inside: avoid; margin-bottom: 26px; padding-bottom: 10px;
                border-bottom: 1px dashed #ddd; }
  .print-note h2 { font-size: 14pt; margin: 0 0 4px; color: #1a1a1a;
                   padding-bottom: 4px; border-bottom: 1px solid #eee; }
  .print-meta { font-size: 9pt; color: #888; margin: 0 0 10px; }
  .note-detail h4 { font-size: 10pt; color: #c9a96e; margin: 12px 0 4px; }
  .note-detail img.note-detail-img { max-width: 100%; height: auto; margin: 6px 0; }
  .note-tags .tag { display: inline-block; font-size: 9pt; color: #b8860b;
                    border: 1px solid #e6d9b8; border-radius: 10px; padding: 1px 8px;
                    margin: 0 4px 4px 0; }
  .note-tags .tag em { font-style: normal; color: #aaa; margin-left: 4px; }
  blockquote { border-left: 3px solid #c9a96e; margin: 10px 0 10px 8px; padding-left: 12px; color: #555; }
  pre { background: #f7f5ef; border: 1px solid #eee; padding: 8px 12px; font-size: 10pt;
        white-space: pre-wrap; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; }
  th, td { border: 1px solid #ddd; padding: 5px 8px; text-align: left; }
  img, table, blockquote, pre { page-break-inside: avoid; }
  .math-block { display: block; text-align: center; margin: 12px 0; overflow-x: auto; }
  .math-inline { display: inline-block; vertical-align: middle; }
  mark { background: #fdf0d5; padding: 0 3px; }
  .math-error { color: #b00020; }
  @media print {
    .print-note { border-bottom-color: #ccc; }
    a { color: inherit; text-decoration: none; }
  }
`;

/* 打印稿公式排版脚本（内嵌：加载本地 tex-svg.js 后对 .math 逐条 tex2svgPromise） */
const PRINT_MATH_SCRIPT = `
<script src="vendor/mathjax3/tex-svg.js"></script>
<script>
window.addEventListener('load', function () {
  var els = document.querySelectorAll('.math');
  if (!els.length || !window.MathJax) return;
  var jobs = [];
  [].forEach.call(els, function (el) {
    var s = String(el.textContent || '').trim();
    var d = el.classList.contains('math-block');
    s = d ? s.replace(/^\\$\\$/, '').replace(/\\$\\$$/, '') : s.replace(/^\\$/, '').replace(/\\$$/, '');
    jobs.push(MathJax.tex2svgPromise(s, { display: d }).then(function (n) {
      el.innerHTML = ''; el.appendChild(n);
    }).catch(function () { el.classList.add('math-error'); }));
  });
});
</script>`;

/**
 * 组装可打印 HTML：标题 + 统计行 + 分页样式 + 每篇 renderNoteDetail。
 * @param {Array<object>} notes  已按范围过滤的记录（空数组 → 占位提示页）
 * @param {string} title  文档标题（如「读书笔记 · 日记」）
 * @param {object} [catalogById]  概念 id → {name} 映射（透传 renderNoteDetail）
 * @returns {string} 完整 HTML 字符串（可直接写入新窗口/iframe 后 window.print()）
 */
export function buildPrintHtml(notes, title, catalogById) {
  const list = Array.isArray(notes) ? notes : [];
  const htmlTitle = esc(title || '读书笔记');
  const head = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${htmlTitle}</title>
<style>${PRINT_CSS}</style>
${PRINT_MATH_SCRIPT}
</head>
<body>
<h1 class="print-title">${htmlTitle}</h1>`;

  if (!list.length) {
    return `${head}\n<p class="muted print-empty">范围内没有记录，无法生成打印草稿。</p>\n</body>\n</html>`;
  }

  const items = list.map((n) => buildPrintItem(n, catalogById)).join('\n');
  return `${head}\n<p class="print-stats">${buildStats(list)}</p>\n${items}\n</body>\n</html>`;
}

/**
 * 组装「下载书稿」markdown：标题 + 统计 + 每篇（标题/日期/书/标签/正文/读者注/AI注）。
 * @param {Array<object>} notes  已按范围过滤的记录（空数组 → 占位行）
 * @param {string} title  文档标题
 * @returns {string} markdown 文本
 */
export function buildMarkdownDraft(notes, title) {
  const list = Array.isArray(notes) ? notes : [];
  const lines = [`# ${String(title || '读书笔记')}`, ''];
  if (!list.length) {
    lines.push('（范围内没有记录）');
    return lines.join('\n');
  }
  lines.push(`共 ${list.length} 条`, '');
  for (const n of list) {
    const meta = [];
    if (n.date) meta.push(`日期：${n.date}`);
    if (n.book) meta.push(`书：《${n.book}》`);
    if (Array.isArray(n.tags) && n.tags.length) meta.push(`标签：${n.tags.join('、')}`);
    lines.push(`## ${n.title || '未命名'}`);
    if (meta.length) lines.push(meta.join(' ｜ '));
    lines.push('');
    if (n.content) lines.push(String(n.content).trim(), '');
    if (n.readerNote) lines.push('### 读者注', '', String(n.readerNote).trim(), '');
    if (n.aiNote) lines.push('### AI注', '', String(n.aiNote).trim(), '');
    lines.push('---', '');
  }
  return lines.join('\n');
}

export default { scopeLabel, filterNotesByScope, buildPrintHtml, buildMarkdownDraft };