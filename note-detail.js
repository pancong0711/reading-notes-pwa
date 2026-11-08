/* note-detail.js —— PWA 笔记详情共享渲染组件（需求：PWA 笔记详情与图片可达）
 *
 * 生产「展开/面板」用的详情 HTML 片段，列表页（type.js）与图谱页（graph.js）共用，
 * 保证口径一致：
 *   · 正文 content 用 markdown-lite 渲染（受控子集、先转义安全）
 *   · readerNote / aiNote 分段展示（AI注 附标注）
 *   · tags chips、concepts chips（id → 名称映射，含来源标注）——可点击跳记录页按标签/概念过滤（20260905-批次二 F3）
 *   · 正文内媒体按 Markdown 顺序渲染；未进入正文的图片/音频/视频/附件
 *     归入「未插入正文的附件」托盘
 *   · 无内容时占位「（无更多内容）」
 *
 * 纯字符串拼接、无 DOM 依赖：浏览器与 node 测试均可加载。
 */
import { renderMarkdown } from './vendor/markdown-lite.js';
import { typesetInto } from './vendor/mathjax3/mathjax-boot.js';
import { renderHtmlFrame, sanitizeHtmlForPrint } from './html-doc.js';
import { renderMediaFigure, mediaForSrc, normalizeMediaList } from './media-util.js';
import { styleToCss } from './doc-style.js';
import { sourceBadge } from './source-import.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function section(title, html) {
  return `<div class="note-sec"><h4>${esc(title)}</h4>${html}</div>`;
}

function sourceHtml(note) {
  const src = (note && note.source) || {};
  const badge = sourceBadge(note);
  if (!badge && !src.originalName) return '';
  const bits = [];
  if (src.originalName) bits.push(`原件：${esc(src.originalName)}`);
  if (src.importMethod) bits.push(`方式：${esc(src.importMethod)}`);
  if (src.importedAt) bits.push(`导入：${esc(String(src.importedAt).slice(0, 16).replace('T', ' '))}`);
  if (src.importMode === 'attachment') bits.push('原件已复制到本机媒体仓');
  const conv = src.conversion || {};
  if (conv.status === 'failed') bits.push('转换预览失败');
  return `<div class="note-sec note-source"><h4>来源</h4><p>${esc(badge || '📎 外部导入')}${bits.length ? ' · ' + bits.join(' · ') : ''}</p></div>`;
}

function tagsHtml(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  // chips 可点击 → 记录页按标签过滤（需求 20260905-批次二 F3）
  return `<div class="note-sec"><h4>标签</h4><div class="note-tags">${tags.map((t) =>
    `<a class="tag" href="type.html?t=all&tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div></div>`;
}

function conceptsHtml(concepts, catalogById) {
  if (!Array.isArray(concepts) || !concepts.length) return '';
  const chips = concepts.map((c) => {
    const id = typeof c === 'string' ? c : (c && c.id) || '';
    const src = typeof c === 'string' ? 'user' : (c && (c.source || 'user')) || 'user';
    const name = (catalogById && catalogById[id] && catalogById[id].name) || id;
    return `<a class="tag concept" href="type.html?t=all&concept=${encodeURIComponent(id)}">${esc(name)}<em>${esc(src)}</em></a>`;
  }).join('');
  return `<div class="note-sec"><h4>概念</h4><div class="note-tags">${chips}</div></div>`;
}

/** 图片项 → 非破坏性版式包装：媒体属性来自 note.media，原图不变。 */
function imageHtml(src, media) {
  if (!src) return '';
  const s = String(src);
  return renderMediaFigure(s, media || { src: s }, { href: s });
}

function baseName(p) {
  const s = String(p || '').split(/[?#]/)[0].replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

function imagesHtml(note) {
  // 正文已内嵌的媒体不再重复；其余进入「未插入正文的附件」托盘。
  const inlineNames = new Set();
  if (note && typeof note.content === 'string') {
    for (const m of note.content.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      inlineNames.add(baseName(m[1]));
    }
  }
  const media = normalizeMediaList(note.media);
  const seen = new Set();
  const list = [];
  const push = (src, item) => {
    if (!src) return;
    const key = baseName(src);
    if (!key || seen.has(key) || inlineNames.has(key)) return;
    seen.add(key);
    list.push({ src, media: item || mediaForSrc(media, src) || { src } });
  };
  for (const m of media) push(m.src, m);
  for (const src of (Array.isArray(note.images) ? note.images : [])) push(src);
  if (note.imageData) push(note.imageData, mediaForSrc(media, 'imageData') || { src: note.imageData, id: 'imageData', kind: 'image' });
  if (!list.length) return '';
  return section('未插入正文的附件', `<div class="note-images">${list.map((it) => imageHtml(it.src, it.media)).join('')}</div>`);
}

/**
 * 渲染笔记详情 HTML（列表展开 / 图谱面板共用）。
 * @param {object} note  记录（type/title/content/readerNote/aiNote/tags/concepts/pages/images/imageData…）
 * @param {object} [catalogById]  概念 id → {name} 映射（缺省按 id 显示）
 * @returns {string} 详情 HTML 片段
 */
export function renderNoteDetail(note, catalogById, opts = {}) {
  const parts = [];
  if (note.pages) parts.push(`<div class="note-sec"><h4>页码</h4><p>${esc(note.pages)}</p></div>`);
  if (note.meta && note.meta.due) parts.push(`<div class="note-sec"><h4>截止</h4><p>${esc(note.meta.due)}</p></div>`);
  const source = sourceHtml(note);
  if (source) parts.push(source);
  const tags = tagsHtml(note.tags);
  if (tags) parts.push(tags);
  const concepts = conceptsHtml(note.concepts, catalogById);
  if (concepts) parts.push(concepts);
  const docCss = styleToCss(note.style || {});
  if (note.content) {
    const fmt = note.contentFormat || 'markdown';
    if (fmt === 'html') {
      const htmlContent = opts.forPrint
        ? `<div class="note-md note-html-print" style="${esc(docCss)}">${sanitizeHtmlForPrint(note.content)}</div>`
        : `<div class="note-md note-html-body">${renderHtmlFrame(note.content, { style: docCss })}</div>`;
      parts.push(section('内容', htmlContent));
    } else if (fmt === 'text') {
      parts.push(section('内容', `<pre class="note-text" style="${esc(docCss)}">${esc(note.content)}</pre>`));
    } else {
      parts.push(section('内容', `<div class="note-md" style="${esc(docCss)}">${renderMarkdown(note.content)}</div>`));
    }
  }
  if (note.readerNote) parts.push(section('读者注', `<div class="note-md" style="${esc(docCss)}">${renderMarkdown(note.readerNote)}</div>`));
  if (note.aiNote) parts.push(section('AI注', `<div class="note-md" style="${esc(docCss)}">${renderMarkdown(note.aiNote)}</div>`));
  const imgs = imagesHtml(note);
  if (imgs) parts.push(imgs);
  return parts.join('') || '<p class="muted">（无更多内容）</p>';
}

/**
 * 渲染详情并插入容器 + 对容器内公式定点排版（MathJax 未就绪时公式保持原文可见）。
 * @param {HTMLElement} el  容器元素（innerHTML 会被覆盖）
 * @param {object} note  记录
 * @param {object} [catalogById]  概念 id → {name} 映射
 */
export async function renderNoteDetailInto(el, note, catalogById) {
  el.innerHTML = renderNoteDetail(note, catalogById);
  if (el.querySelector) {
    try { await typesetInto(el); } catch { /* 排版失败不影响展示 */ }
  }
}

export default { renderNoteDetail, renderNoteDetailInto, typesetInto };