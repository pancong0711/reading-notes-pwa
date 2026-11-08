/* media-util.js —— 多媒体非破坏性版式纯函数（需求 20261024 + 20261107）
 *
 * 支持四类媒体：
 *   image / audio / video / file
 * 只保存显示属性，不改原文件：
 *   { id, kind, src, alt, name, mime, size, caption,
 *     widthPercent, rotate(0|90|180|270), align(left|center|right) }
 *
 * Markdown 导出使用受控属性后缀：
 *   ![alt](assets/a.jpg){width=80% rotate=90 align=center caption=...}
 *   ![录音](assets/a.webm){kind=audio caption=...}
 */

export const ROTATE_VALUES = [0, 90, 180, 270];
export const ALIGN_VALUES = ['left', 'center', 'right'];
export const MEDIA_KINDS = ['image', 'audio', 'video', 'file'];

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/heic': 'heic', 'image/heif': 'heif',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v',
  'application/pdf': 'pdf', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv',
  'application/zip': 'zip', 'application/epub+zip': 'epub',
  'application/rtf': 'rtf', 'text/rtf': 'rtf',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};
const SAFE_EXT = new Set(Object.values(EXT_BY_MIME));
// 可作为附件保存的类型（不含可执行同源脚本/HTML/SVG/XML）
const ALLOWED_ATTACHMENT_EXTS = new Set([
  'jpg','jpeg','png','gif','webp','bmp','avif','heic','heif',
  'mp3','wav','m4a','aac','ogg','oga','opus','webm',
  'mp4','m4v','mov','pdf','doc','docx','ppt','pptx','xls','xlsx',
  'txt','md','csv','zip','epub','rtf','odt','ods','odp',
]);
const UNSAFE_ACTIVE_EXT_RE = /\.(?:svg|html?|xhtml|xml|js|mjs|css|php|asp|aspx|jsp|cgi|sh|bat|cmd|exe|msi|dll|jar)$/i;

function hasUnsafeActiveExt(value) {
  let p = String(value || '').split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  p = p.toLowerCase();
  // 站内受控页面（如 note.html?id=）可作为图片/链接跳转目标；但 /assets/ 下上传的 HTML 必须拒绝。
  if (/\.html?$/.test(p)) return /(^|\/)assets\//.test(p);
  return UNSAFE_ACTIVE_EXT_RE.test(p);
}

export function isHeicFile(file) {
  if (!file) return false;
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  return type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/.test(name);
}

export function isAllowedMediaFile(file) {
  if (!file) return false;
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (type.startsWith('image/') && type !== 'image/svg+xml') return ALLOWED_ATTACHMENT_EXTS.has(ext || 'jpg');
  if (type.startsWith('audio/') || type.startsWith('video/')) return ALLOWED_ATTACHMENT_EXTS.has(ext || (type.startsWith('audio/') ? 'webm' : 'mp4'));
  return ALLOWED_ATTACHMENT_EXTS.has(ext);
}

export function inferMediaKind(src, mime = '') {
  const mt = String(mime || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('video/')) return 'video';
  const ext = String(src || '').split(/[?#]/)[0].split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','bmp','avif','heic','heif','svg'].includes(ext)) return 'image';
  if (['mp3','wav','m4a','aac','ogg','oga','opus','webm'].includes(ext)) return 'audio';
  if (['mp4','m4v','mov','avi','mkv','webm'].includes(ext)) return 'video';
  return 'file';
}

export function mediaExtension(kind, mime = '', originalName = '') {
  const mt = String(mime || '').toLowerCase();
  if (EXT_BY_MIME[mt]) return EXT_BY_MIME[mt];
  const ext = String(originalName || '').split('.').pop().toLowerCase();
  if (SAFE_EXT.has(ext)) return ext;
  if (kind === 'image') return 'jpg';
  if (kind === 'audio') return 'webm';
  if (kind === 'video') return 'mp4';
  return 'dat';
}

export function mediaKindLabel(kind) {
  return ({ image: '图片', audio: '音频', video: '视频', file: '附件' })[kind] || '附件';
}


export function clampWidth(v, fallback = 100) {
  if (v == null || String(v).trim() === '') return fallback;
  const n = Number(String(v).replace('%', '').trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.max(10, Math.min(100, Math.round(n)));
}

/** 媒体 URL 安全收口：拒绝 javascript:/vbscript:/data:text/html 与未知 scheme。
 *  src：http(s)、blob、站内相对路径、raster data:image；
 *  href：http(s)、站内相对路径（不把 data/blob/javascript 变成可点击链接）。 */
function compactUrl(value) {
  return String(value == null ? '' : value).trim().replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
}

export function safeMediaSrc(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const c = compactUrl(s);
  if (/^data:/.test(c)) {
    return /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif)[;,]/.test(c) ? s : '';
  }
  if (/^(https?:|blob:)/.test(c)) return s;
  if (/^[a-z][a-z0-9+.-]*:/.test(c)) return '';
  if (hasUnsafeActiveExt(c)) return '';
  return s;   // 相对路径、协议相对 //、# 锚点等
}

export function safeMediaHref(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const c = compactUrl(s);
  if (/^https?:/.test(c)) return s;
  if (/^[a-z][a-z0-9+.-]*:/.test(c)) return '';
  if (hasUnsafeActiveExt(c)) return '';
  return s;
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
  const kind = MEDIA_KINDS.includes(String(raw.kind || ''))
    ? String(raw.kind) : inferMediaKind(src, raw.mime);
  return {
    id: String(raw.id || `media_${index + 1}`),
    kind,
    src,
    alt: String(raw.alt || ''),
    name: String(raw.name || raw.filename || raw.alt || '').slice(0, 240),
    mime: String(raw.mime || '').toLowerCase().slice(0, 120),
    size: Number.isFinite(Number(raw.size)) ? Math.max(0, Math.round(Number(raw.size))) : 0,
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

/** 解析 `{width=80% rotate=90 align=center caption=%E5%9B%BE%E6%B3%A8}` → 属性对象。
 * caption 使用 encodeURIComponent 写入，避免空格/引号破坏属性串。 */
export function parseImageAttrs(attrText) {
  const out = {};
  const s = String(attrText || '').replace(/^\{|\}$/g, '');
  const re = /([a-zA-Z][\w-]*)=("[^"]*"|'[^']*'|\S+)/g;
  let m;
  while ((m = re.exec(s))) {
    const k = m[1];
    let v = m[2].replace(/^["']|["']$/g, '');
    if (k === 'width' || k === 'widthPercent') out.widthPercent = clampWidth(v);
    else if (k === 'rotate') out.rotate = normalizeRotate(v);
    else if (k === 'align') out.align = normalizeAlign(v);
    else if (k === 'caption') {
      try { out.caption = decodeURIComponent(v); } catch { out.caption = v; }
    }
    else if (k === 'kind' && MEDIA_KINDS.includes(v)) out.kind = v;
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
  if (m.kind !== 'image') parts.push(`kind=${m.kind}`);
  if (m.caption) parts.push(`caption=${encodeURIComponent(String(m.caption))}`);
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

/** 把一组图片插入 Markdown 正文选区，返回新值与光标位置。
 * 每张图片独立成块（前后空行），保证图文混排顺序稳定。 */
export function insertMarkdownImagesAtCursor(content, selStart, selEnd, items) {
  const text = String(content == null ? '' : content);
  const s = Math.max(0, Math.min(Number(selStart) || 0, text.length));
  const e = Math.max(s, Math.min(Number(selEnd) || s, text.length));
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.src);
  if (!list.length) return { value: text, selStart: s, selEnd: e };
  const blocks = list.map((it) => {
    const alt = String(it.alt || it.caption || '');
    const src = String(it.src || '').trim();
    return `![${alt}](${src})${formatImageAttrs(it)}`;
  });
  let insert = blocks.join('\n\n');
  const before = text.slice(0, s);
  const after = text.slice(e);
  if (before && !/\n\s*$/.test(before)) insert = '\n\n' + insert;
  if (after && !/^\s*\n/.test(after)) insert = insert + '\n\n';
  const value = before + insert + after;
  const cur = before.length + insert.length;
  return { value, selStart: cur, selEnd: cur };
}

function escapeRegExp(v) {
  return String(v || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 Markdown 正文删除指定 src 的图片引用（用于图片库二次移除）。 */
export function removeMarkdownImageBySrc(content, src) {
  const text = String(content == null ? '' : content);
  const target = String(src || '').trim();
  if (!target) return text;
  const re = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(target)}(?:\\s+\"[^\"]*\")?\\)(?:\\{[^}]*\\})?\\s*`, 'g');
  return text.replace(re, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** 正文是否已引用某个图片 src。 */
export function markdownHasImageSrc(content, src) {
  const target = String(src || '').trim();
  if (!target) return false;
  const re = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(target)}(?:\\s+\"[^\"]*\")?\\)`);
  return re.test(String(content || ''));
}

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 媒体 HTML 包装：PWA 详情/打印共用。四类媒体统一 figure；所有文本属性转义。 */
export function renderMediaFigure(src, media, { href = '', className = 'note-media' } = {}) {
  const safeSrc = safeMediaSrc(src);
  if (!safeSrc) return '';
  const m = normalizeMediaItem(media || { src: safeSrc });
  const kind = m.kind;
  const width = m.widthPercent;
  const rotate = kind === 'image' ? m.rotate : 0;
  const align = m.align;
  const label = m.name || m.alt || (kind === 'image' ? '笔记图片' : `${mediaKindLabel(kind)}附件`);
  const boxStyle = `text-align:${align};${rotate === 90 || rotate === 270 ? 'min-height:20vh;' : ''}`;
  const cap = m.caption ? `<figcaption class="img-caption">${escAttr(m.caption)}</figcaption>` : '';
  const safeHref = href ? safeMediaHref(href) : '';

  if (kind === 'audio') {
    const audio = `<audio class="note-media-audio" controls preload="metadata" src="${escAttr(safeSrc)}" data-path="${escAttr(safeSrc)}"></audio>`;
    return `<figure class="${escAttr(className)} note-media-${kind}" data-kind="${kind}" data-width="${width}" `
      + `data-align="${align}" style="${boxStyle}"><div class="media-attachment-label">🎙 ${escAttr(label)}</div>${audio}${cap}</figure>`;
  }
  if (kind === 'video') {
    const video = `<video class="note-media-video" controls playsinline preload="metadata" src="${escAttr(safeSrc)}" `
      + `data-path="${escAttr(safeSrc)}" style="width:${width}%;max-width:100%"></video>`;
    return `<figure class="${escAttr(className)} note-media-${kind}" data-kind="${kind}" data-width="${width}" `
      + `data-align="${align}" style="${boxStyle}"><div class="media-attachment-label">🎬 ${escAttr(label)}</div>${video}${cap}</figure>`;
  }
  if (kind === 'file') {
    const link = safeHref || safeMediaHref(safeSrc);
    const inner = link
      ? `<a class="note-attachment" href="${escAttr(link)}" target="_blank" rel="noopener noreferrer" download="${escAttr(label)}">📎 ${escAttr(label)}</a>`
      : `<span class="note-attachment">📎 ${escAttr(label)}</span>`;
    return `<figure class="${escAttr(className)} note-media-${kind}" data-kind="${kind}" data-path="${escAttr(safeSrc)}" `
      + `data-align="${align}" style="${boxStyle}">${inner}${cap}</figure>`;
  }

  const imgStyle = [
    `width:${width}%`,
    rotate ? `transform:rotate(${rotate}deg)` : '',
  ].filter(Boolean).join(';');
  const img = `<img class="note-detail-img note-media-img" src="${escAttr(safeSrc)}" data-path="${escAttr(safeSrc)}" `
    + `alt="${escAttr(m.alt || '笔记图片')}" loading="lazy" style="${imgStyle}">`;
  const inner = safeHref ? `<a href="${escAttr(safeHref)}" target="_blank" rel="noopener noreferrer">${img}</a>` : img;
  return `<figure class="${escAttr(className)} note-media-image" data-kind="image" data-rotate="${rotate}" data-width="${width}" `
    + `data-align="${align}" style="${boxStyle}">${inner}${cap}</figure>`;
}

export default {
  normalizeMediaItem, normalizeMediaList, parseImageAttrs, formatImageAttrs,
  mediaFromMarkdown, mergeMediaLists, applyMediaAttrsToMarkdown,
  mediaForSrc, renderMediaFigure, clampWidth, normalizeRotate, normalizeAlign,
  inferMediaKind, mediaExtension, mediaKindLabel, MEDIA_KINDS,
  isAllowedMediaFile, isHeicFile, ALLOWED_ATTACHMENT_EXTS,
  insertMarkdownImagesAtCursor, removeMarkdownImageBySrc, markdownHasImageSrc,
  safeMediaSrc, safeMediaHref,
};
