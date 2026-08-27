/* note-detail.js —— PWA 笔记详情共享渲染组件（需求：PWA 笔记详情与图片可达）
 *
 * 生产「展开/面板」用的详情 HTML 片段，列表页（type.js）与图谱页（graph.js）共用，
 * 保证口径一致：
 *   · 正文 content 用 markdown-lite 渲染（受控子集、先转义安全）
 *   · readerNote / aiNote 分段展示（AI注 附标注）
 *   · tags chips、concepts chips（id → 名称映射，含来源标注）
 *   · pages、images 渲染：note.images 为 PWA 相对路径（'assets/…'，CLI sync 已复制）
 *     或 note.imageData（base64）；点击开新标签看大图
 *   · 无内容时占位「（无更多内容）」
 *
 * 纯字符串拼接、无 DOM 依赖：浏览器与 node 测试均可加载。
 */
import { renderMarkdown } from './vendor/markdown-lite.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function section(title, html) {
  return `<div class="note-sec"><h4>${esc(title)}</h4>${html}</div>`;
}

function tagsHtml(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return `<div class="note-sec"><h4>标签</h4><div class="note-tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>`;
}

function conceptsHtml(concepts, catalogById) {
  if (!Array.isArray(concepts) || !concepts.length) return '';
  const chips = concepts.map((c) => {
    const id = typeof c === 'string' ? c : (c && c.id) || '';
    const src = typeof c === 'string' ? 'user' : (c && (c.source || 'user')) || 'user';
    const name = (catalogById && catalogById[id] && catalogById[id].name) || id;
    return `<span class="tag concept">${esc(name)}<em>${esc(src)}</em></span>`;
  }).join('');
  return `<div class="note-sec"><h4>概念</h4><div class="note-tags">${chips}</div></div>`;
}

/** 图片项 → <a><img>：路径（CLI 已同步 app/pwa/assets）或 imageData（base64） */
function imageHtml(src) {
  if (!src) return '';
  const s = String(src);
  return `<a href="${esc(s)}" target="_blank" rel="noopener"><img class="note-detail-img" src="${esc(s)}" alt="笔记图片" loading="lazy"></a>`;
}

function imagesHtml(note) {
  const list = (Array.isArray(note.images) ? note.images : [])
    .concat(note.imageData ? [note.imageData] : []);
  if (!list.length) return '';
  return section('原文图片', `<div class="note-images">${list.map(imageHtml).join('')}</div>`);
}

/**
 * 渲染笔记详情 HTML（列表展开 / 图谱面板共用）。
 * @param {object} note  记录（type/title/content/readerNote/aiNote/tags/concepts/pages/images/imageData…）
 * @param {object} [catalogById]  概念 id → {name} 映射（缺省按 id 显示）
 * @returns {string} 详情 HTML 片段
 */
export function renderNoteDetail(note, catalogById) {
  const parts = [];
  if (note.pages) parts.push(`<div class="note-sec"><h4>页码</h4><p>${esc(note.pages)}</p></div>`);
  if (note.meta && note.meta.due) parts.push(`<div class="note-sec"><h4>截止</h4><p>${esc(note.meta.due)}</p></div>`);
  const tags = tagsHtml(note.tags);
  if (tags) parts.push(tags);
  const concepts = conceptsHtml(note.concepts, catalogById);
  if (concepts) parts.push(concepts);
  if (note.content) parts.push(section('内容', `<div class="note-md">${renderMarkdown(note.content)}</div>`));
  if (note.readerNote) parts.push(section('读者注', `<div class="note-md">${renderMarkdown(note.readerNote)}</div>`));
  if (note.aiNote) parts.push(section('AI注', `<div class="note-md">${renderMarkdown(note.aiNote)}</div>`));
  const imgs = imagesHtml(note);
  if (imgs) parts.push(imgs);
  return parts.join('') || '<p class="muted">（无更多内容）</p>';
}

export default { renderNoteDetail };