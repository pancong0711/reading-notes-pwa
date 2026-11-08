/* share.js —— 一键分享 HTML / JSON（20261108）
 *
 * HTML：当前笔记 → 自包含静态 HTML，图片/音频/视频/附件尽量内嵌 data URL；
 * JSON：当前笔记 → 复用 exportNotePackage({notes:[note], includeImages:true})，图片同样内嵌。
 *
 * 分享优先调用 navigator.share({files:[File]}) 打开系统分享面板；
 * 浏览器/系统不支持文件分享时退化为下载文件。
 */
import { collectImageFiles, exportNotePackage } from './data.js';
import { renderNoteDetail } from './note-detail.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function baseName(p) {
  const s = String(p || '').split(/[?#]/)[0].replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

function safeFilename(name, ext) {
  const base = String(name || '笔记').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || '笔记';
  return `${base.slice(0, 60)}.${ext}`;
}

/** 将相对 src/href 替换为迁移包里的 data URL；找不到时保留原值。 */
export function inlineMediaDataUrls(html, imageFiles) {
  const files = imageFiles && typeof imageFiles === 'object' ? imageFiles : {};
  const byBase = new Map();
  for (const [path, data] of Object.entries(files)) byBase.set(baseName(path), data);
  return String(html || '').replace(/\b(src|href)="([^"]+)"/g, (whole, attr, raw) => {
    const url = String(raw || '');
    if (/^(data:|https?:|blob:|#)/i.test(url)) return whole;
    const data = files[url] || files[url.replace(/^\.\//, '')] || byBase.get(baseName(url));
    if (!data) return whole;
    return `${attr}="${esc(data)}"`;
  });
}

const SHARE_CSS = `
  :root { color-scheme: light; }
  body { margin: 0; padding: 28px 18px 60px; background: #faf8f4; color: #2f2a22;
         font-family: "Noto Serif CJK SC", "Source Han Serif SC", "PingFang SC", "Songti SC", serif;
         line-height: 1.9; }
  .share-page { max-width: 760px; margin: 0 auto; background: #fffdf8; border: 1px solid #e6dfd2;
                border-radius: 14px; padding: 24px 22px 34px; box-shadow: 0 8px 28px rgba(30,24,12,.06); }
  .share-title { margin: 0 0 6px; font-size: 26px; line-height: 1.3; }
  .share-meta { color: #786f62; font-size: 13px; margin: 0 0 18px; }
  .note-detail h4 { font-size: 13px; color: #9a742f; margin: 16px 0 5px; }
  .note-detail .note-md { font-size: 16px; }
  .note-detail img, .note-detail video { max-width: 100%; height: auto; border-radius: 8px; }
  .note-detail figure.note-media { display: block; margin: 12px 0 16px; text-align: center; }
  .note-detail .note-media-img { width: auto; max-width: 100%; }
  .note-detail .img-caption { font-size: 12px; color: #888; margin-top: 4px; }
  .note-detail a { color: #8a6d3b; }
  .note-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f6f1e7; padding: 10px; border-radius: 8px; }
  .note-detail blockquote { margin: 0; padding: 4px 12px; border-left: 3px solid #c9a96e; color: #6b6256; }
  .note-detail table { border-collapse: collapse; width: 100%; }
  .note-detail th, .note-detail td { border: 1px solid #ddd; padding: 5px 8px; }
  .note-detail mark { background: #fdf0d5; padding: 0 3px; }
  .note-source p { color: #786f62; font-size: 13px; }
  @media (max-width: 520px) { body { padding: 14px 8px 40px; } .share-page { padding: 18px 14px 28px; border-radius: 10px; } .share-title { font-size: 22px; } }
`;

/** 生成当前笔记的自包含 HTML（媒体文件用 imageFiles data URL 内嵌）。 */
export function buildShareHtml(note, imageFiles, catalogById) {
  const title = String(note && note.title || '未命名笔记');
  const meta = [];
  if (note && note.date) meta.push(esc(note.date));
  if (note && note.project) meta.push(`📁 ${esc(note.project)}`);
  if (note && note.book) meta.push(`《${esc(note.book)}》`);
  const body = inlineMediaDataUrls(renderNoteDetail(note || {}, catalogById || {}, { forPrint: true }), imageFiles);
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(title)}</title><style>${SHARE_CSS}</style></head><body>`
    + '<main class="share-page"><h1 class="share-title">' + esc(title) + '</h1>'
    + (meta.length ? `<p class="share-meta">${meta.join(' ｜ ')}</p>` : '')
    + `<div class="note-detail">${body}</div></main></body></html>`;
}

/** 生成当前笔记的 JSON 分享包（图片内嵌 imageFiles）。 */
export async function buildShareJson(note) {
  return exportNotePackage({ notes: [note], includeImages: true });
}

/** 优先系统分享文件；不支持或失败时下载。
 * 返回 {mode:'shared'|'downloaded'|'cancelled'|'needs-gesture'}。
 * 注意：不把 canShare() 作为硬门槛——部分浏览器能分享但 canShare 返回 false。
 */
export async function shareOrDownloadFile(file, { title = '', text = '' } = {}) {
  if (navigator.share) {
    try {
      await navigator.share({ files: [file], title, text });
      return { mode: 'shared' };
    } catch (e) {
      if (e && e.name === 'AbortError') return { mode: 'cancelled' };
      // Web Share 需要用户手势；异步生成后首次调用可能在此报 NotAllowedError。
      if (e && e.name === 'NotAllowedError') return { mode: 'needs-gesture' };
      // 其他失败（如系统不支持该文件类型）继续走下载兜底。
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name || '笔记分享';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return { mode: 'downloaded' };
}

/** 预先构建 HTML/JSON 文件，避免用户点击分享后才长时间异步生成。 */
export async function prepareShareFiles(note, catalogById) {
  const [{ imageFiles }, jsonPkg] = await Promise.all([
    collectImageFiles([note]),
    buildShareJson(note),
  ]);
  const html = buildShareHtml(note, imageFiles, catalogById);
  const htmlFile = new File([html], safeFilename(note.title, 'html'), { type: 'text/html' });
  const jsonFile = new File([JSON.stringify(jsonPkg, null, 2)], safeFilename(note.title, 'json'), { type: 'application/json' });
  return { htmlFile, jsonFile };
}

/** 使用预生成文件直接触发系统分享（文件已就绪时不会先等待异步读取）。 */
export async function sharePreparedFile(note, prepared, kind) {
  const file = kind === 'json' ? prepared && prepared.jsonFile : prepared && prepared.htmlFile;
  if (!file) throw new Error('分享文件尚未生成');
  return shareOrDownloadFile(file, {
    title: note.title || '读书笔记',
    text: kind === 'json' ? 'JSON 笔记包（媒体已内嵌）' : '自包含 HTML 笔记（媒体已内嵌）',
  });
}

export async function shareNoteAsHtml(note, catalogById) {
  const { imageFiles } = await collectImageFiles([note]);
  const html = buildShareHtml(note, imageFiles, catalogById);
  const file = new File([html], safeFilename(note.title, 'html'), { type: 'text/html;charset=utf-8' });
  return shareOrDownloadFile(file, { title: note.title || '读书笔记', text: '自包含 HTML 笔记（图片已内嵌）' });
}

export async function shareNoteAsJson(note) {
  const pkg = await buildShareJson(note);
  const file = new File([JSON.stringify(pkg, null, 2)], safeFilename(note.title, 'json'), { type: 'application/json' });
  return shareOrDownloadFile(file, { title: note.title || '读书笔记', text: 'JSON 笔记包（图片已内嵌）' });
}

export default { buildShareHtml, buildShareJson, inlineMediaDataUrls, shareOrDownloadFile, prepareShareFiles, sharePreparedFile, shareNoteAsHtml, shareNoteAsJson };
