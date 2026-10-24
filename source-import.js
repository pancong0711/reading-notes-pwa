/* source-import.js —— 多格式文档导入解析（需求 20261024）
 *
 * 纯函数，无 DOM/IndexedDB 依赖，供 data-actions（PWA 导入）与 node 测试共用。
 * 原则：
 *   · md/html/txt 原文件只作为导入来源，应用编辑只写 JSON/IndexedDB；
 *   · 正文内嵌到统一 Note JSON，contentFormat ∈ markdown|html|text；
 *   · source 只保留来源元数据（文件名/格式/导入时间/可选 hash），不依赖源路径。
 */

export const SOURCE_ACCEPT = '.json,.md,.markdown,.html,.htm,.txt,application/json,text/markdown,text/html,text/plain';

export function detectSourceFormat(filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (name.endsWith('.txt')) return 'text';
  return '';
}

export function isImportableSource(filename) {
  return !!detectSourceFormat(filename);
}

function unquote(v) {
  let s = String(v == null ? '' : v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

function parseList(v) {
  const s = String(v || '').trim();
  if (!s) return [];
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map(unquote).map((x) => x.trim()).filter(Boolean);
  }
  return s.split(/[,，;；、]/).map(unquote).map((x) => x.trim()).filter(Boolean);
}

/** 轻量 YAML frontmatter 解析：覆盖本项目笔记常用标量/数组/行内数组。
 *  未识别内容原样保存在 _raw 中，不丢来源信息。 */
export function parseFrontmatter(text) {
  const src = String(text || '');
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(src);
  if (!m) return { meta: {}, body: src, raw: '' };
  const raw = m[1];
  const body = m[2];
  const meta = {};
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_\-\u4e00-\u9fff]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (!val) {
      const arr = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        arr.push(unquote(lines[j].replace(/^\s*-\s+/, '')));
        j++;
      }
      if (arr.length) { meta[key] = arr; i = j - 1; }
      else meta[key] = '';
    } else if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = parseList(val);
    } else {
      meta[key] = unquote(val);
    }
  }
  return { meta, body, raw };
}

function stripHtmlText(raw) {
  return String(raw || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleFromHtml(raw, filename = '') {
  const patterns = [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i];
  for (const re of patterns) {
    const m = re.exec(String(raw || ''));
    const t = m ? stripHtmlText(m[1]) : '';
    if (t) return t;
  }
  return filename ? filename.replace(/\.[^.]+$/, '') : '未命名笔记';
}

export function titleFromMarkdown(body, filename = '') {
  const m = /^\s*#\s+(.+?)\s*$/m.exec(String(body || ''));
  if (m) return m[1].trim();
  return filename ? filename.replace(/\.[^.]+$/, '').replace(/^\d{8}[-_ ]*/, '') : '未命名笔记';
}

export function dateFromFilename(filename) {
  const m = /(20\d{2})(\d{2})(\d{2})/.exec(String(filename || ''));
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function cleanTags(v) {
  const arr = Array.isArray(v) ? v : parseList(v);
  const seen = new Set();
  return arr.map((x) => String(x || '').trim())
    .filter((x) => x && !/(^|[\\/])assets[\\/]/i.test(x) && !/\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(x))
    .filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

/** 源文本 → 统一 Note 导入记录（不含 IndexedDB id；由 addNote 补）。 */
export function buildImportedNote({ filename, text, project = 'other', type = 'note', now = Date.now() } = {}) {
  const fmt = detectSourceFormat(filename);
  if (!fmt) throw new Error(`暂不支持的文档类型：${filename || '(无文件名)'}`);
  const raw = String(text == null ? '' : text);
  const fm = fmt === 'markdown' ? parseFrontmatter(raw) : { meta: {}, body: raw, raw: '' };
  const meta = fm.meta || {};
  let title = '';
  let content = fm.body;
  if (fmt === 'markdown') {
    title = String(meta.title || '').trim() || titleFromMarkdown(content, filename);
  } else if (fmt === 'html') {
    title = titleFromHtml(raw, filename);
    content = raw;
  } else {
    title = filename ? filename.replace(/\.[^.]+$/, '').replace(/^\d{8}[-_ ]*/, '') : '未命名笔记';
    content = raw;
  }
  const date = String(meta.date || '').trim() || dateFromFilename(filename) || new Date(now).toISOString().slice(0, 10);
  const importedAt = new Date(now).toISOString();
  return {
    type: String(meta.type || type || 'note'),
    title,
    book: String(meta.book || '未归档'),
    author: String(meta.author || ''),
    date,
    tags: cleanTags(meta.tags),
    concepts: Array.isArray(meta.concepts) ? meta.concepts : [],
    pages: String(meta.pages || ''),
    project: String(project || meta.project || 'other'),
    contentFormat: fmt,
    content,
    source: {
      kind: fmt,
      originalName: String(filename || ''),
      importedAt,
      originalPreserved: true,
      editable: true,
      extraFrontmatter: Object.fromEntries(Object.entries(meta).filter(([k]) => ![
        'title', 'book', 'author', 'date', 'tags', 'concepts', 'pages', 'type', 'project',
      ].includes(k))),
    },
    media: [],
    style: {},
    sync: { contentOrigin: 'json', lastImportedAt: importedAt, state: 'clean' },
  };
}

/** 文本 hash：浏览器优先 SHA-256；测试/无 crypto 时退化为 FNV-1a。 */
export async function hashSourceText(text) {
  const s = String(text == null ? '' : text);
  try {
    if (globalThis.crypto && globalThis.crypto.subtle && globalThis.TextEncoder) {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { /* fallback */ }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'fnv1a-' + h.toString(16).padStart(8, '0');
}


/** HTML 中是否存在无法由 PWA 单文件导入解析的相对图片。 */
export function hasRelativeHtmlImages(raw) {
  const html = String(raw || '');
  const re = /<img\b[^>]*?\bsrc=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = String(m[1] || '').trim();
    if (src && !/^(data:|https?:|\/\/|#)/i.test(src)) return true;
  }
  return false;
}

export default { detectSourceFormat, parseFrontmatter, buildImportedNote, hashSourceText, titleFromHtml, titleFromMarkdown, hasRelativeHtmlImages };
