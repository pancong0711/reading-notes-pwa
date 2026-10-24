/* media-util.js —— 图片非破坏性版式纯函数（需求 20261024 FMT-10/11/12）
 *
 * 只保存显示属性，不改原图：
 *   { id, src, alt, caption, widthPercent, rotate(0|90|180|270), align(left|center|right) }
 *
 * Markdown 导出使用 Pandoc 风格属性后缀：
 *   ![alt](assets/a.jpg){width=80% rotate=90 align=center}
 */

export const ROTATE_VALUES = [0, 90, 180, 270];
export const ALIGN_VALUES = ['left', 'center', 'right'];

export function clampWidth(v, fallback = 100) {
  const n = Number(String(v == null ? '' : v).replace('%', ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(10, Math.min(100, Math.round(n)));
}

export function normalizeRotate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const r = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  return ROTATE_VALUES.includes(r) ? r : 0;
}

export function normalizeAlign(v) {
  const s = String(v || '').toLowerCase();
  return ALIGN_VALUES.includes(s) ? s : 'center';
}

export function normalizeMediaItem(raw = {}, index = 0) {
  const src = String(raw.src || raw.path || raw.image || '').trim();
  return {
    id: String(raw.id || `img_${index + 1}`),
    kind: 'image',
    src,
    alt: String(raw.alt || ''),
    caption: String(raw.caption || ''),
    widthPercent: clampWidth(raw.widthPercent != null ? raw.widthPercent : raw.width, 100),
    rotate: normalizeRotate(raw.rotate),
    align: normalizeAlign(raw.align),
  };
}

export function normalizeMediaList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((m, i) => normalizeMediaItem(m, i)).filter((m) => m.src || m.id);
}

export function normalizeMediaKey(src) {
  const s = String(src || '').split(/[?#]/)[0].replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

export function mediaForSrc(media, src) {
  if (src && String(src).startsWith('data:')) {
    return (media || []).find((m) => m.id === 'imageData' || m.src === 'imageData' || m.src === src);
  }
  const key = normalizeMediaKey(src);
  return (media || []).find((m) => normalizeMediaKey(m.src) === key || m.id === src) || null;
}

/** 解析 `{width=80% rotate=90 align=center}` → 属性对象。 */
export function parseImageAttrs(attrText) {
  const out = {};
  const s = String(attrText || '').replace(/^\{|\}$/g, '');
  for (const part of s.split(/\s+/)) {
    const m = /^([a-zA-Z][\w-]*)=(.+)$/.exec(part);
    if (!m) continue;
    const k = m[1];
    const v = m[2].replace(/^["']|["']$/g, '');
    if (k === 'width' || k === 'widthPercent') out.widthPercent = clampWidth(v);
    else if (k === 'rotate') out.rotate = normalizeRotate(v);
    else if (k === 'align') out.align = normalizeAlign(v);
    else if (k === 'caption') out.caption = v;
  }
  return out;
}

export function formatImageAttrs(media) {
  if (!media) return '';
  const m = normalizeMediaItem(media);
  const parts = [];
  if (m.widthPercent !== 100) parts.push(`width=${m.widthPercent}%`);
  if (m.rotate) parts.push(`rotate=${m.rotate}`);
  if (m.align !== 'center') parts.push(`align=${m.align}`);
  return parts.length ? `{${parts.join(' ')}}` : '';
}

/** 从 Markdown 正文提取图片及其属性（用于编辑器图片版式面板）。 */
export function mediaFromMarkdown(content) {
  const out = [];
  const seen = new Set();
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)(?:\{([^}]*)\})?/g;
  let m;
  let i = 0;
  while ((m = re.exec(String(content || '')))) {
    const src = m[2];
    const key = normalizeMediaKey(src);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeMediaItem({ id: `md_${i++}`, src, alt: m[1], ...parseImageAttrs(m[3]) }, out.length));
  }
  return out;
}

export function mergeMediaLists(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const raw of normalizeMediaList(list || [])) {
      const key = raw.id === 'imageData' ? 'imageData' : normalizeMediaKey(raw.src);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    }
  }
  return out;
}

/** 把媒体属性写回 Markdown 图片属性后缀（相同 basename 匹配）。 */
export function applyMediaAttrsToMarkdown(content, media) {
  const text = String(content || '');
  return text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)(?:\{[^}]*\})?/g, (whole, alt, src) => {
    const m = mediaForSrc(media, src);
    if (!m) return whole;
    const attrs = formatImageAttrs(m);
    return `![${alt}](${src})${attrs}`;
  });
}

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 图片 HTML 包装：PWA 详情/打印共用；src 由调用方转义。 */
export function renderMediaFigure(src, media, { href = '', className = 'note-media' } = {}) {
  const m = normalizeMediaItem(media || { src });
  const width = m.widthPercent;
  const rotate = m.rotate;
  const align = m.align;
  const imgStyle = [
    `width:${width}%`,
    rotate ? `transform:rotate(${rotate}deg)` : '',
  ].filter(Boolean).join(';');
  const boxStyle = `text-align:${align};${rotate === 90 || rotate === 270 ? 'min-height:20vh;' : ''}`;
  const img = `<img class="note-detail-img note-media-img" src="${escAttr(src)}" data-path="${escAttr(src)}" `
    + `alt="${escAttr(m.alt || '笔记图片')}" loading="lazy" style="${imgStyle}">`;
  const inner = href ? `<a href="${escAttr(href)}" target="_blank" rel="noopener">${img}</a>` : img;
  const cap = m.caption ? `<figcaption class="img-caption">${escAttr(m.caption)}</figcaption>` : '';
  return `<figure class="${escAttr(className)}" data-rotate="${rotate}" data-width="${width}" `
    + `data-align="${align}" style="${boxStyle}">${inner}${cap}</figure>`;
}

export default {
  normalizeMediaItem, normalizeMediaList, parseImageAttrs, formatImageAttrs,
  mediaFromMarkdown, mergeMediaLists, applyMediaAttrsToMarkdown,
  mediaForSrc, renderMediaFigure, clampWidth, normalizeRotate, normalizeAlign,
};
