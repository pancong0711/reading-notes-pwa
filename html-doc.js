/* html-doc.js —— HTML 笔记的安全阅读/预览容器（需求 20261024）
 *
 * 策略：不把用户 HTML 直接拼入主页面 DOM，而是放进 sandbox iframe：
 *   · sandbox=""：禁止脚本、表单、弹窗、顶层跳转；
 *   · srcdoc 内 CSP：默认禁止所有资源，只允许同源/data/blob 图片与内联样式；
 *   · 因此原始 html 可保留/可编辑，同时不会污染主站 CSS 或执行脚本。
 *
 * 纯字符串函数，浏览器与 node 测试均可加载。
 */

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function safeHtmlDocument(content, bodyStyle = '') {
  const body = String(content == null ? '' : content);
  const bodyAttr = bodyStyle ? ` style="${escAttr(bodyStyle)}"` : '';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="'
    + "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; "
    + "font-src data:; media-src 'self' data: blob:; frame-src 'none'; "
    + "form-action 'none'; base-uri 'none'; script-src 'none'"
    + '">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>html,body{margin:0;padding:0;background:transparent;color:#2f2a22;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;'
    + 'font-size:16px;line-height:1.75;overflow-wrap:anywhere}'
    + 'body{padding:8px 10px 16px}'
    + 'img,video{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}'
    + 'th,td{border:1px solid #ddd;padding:4px 8px}'
    + 'a{color:#9a742f;text-decoration:underline}'
    + 'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f1e7;padding:10px;border-radius:8px}'
    + 'blockquote{margin:0;padding:4px 12px;border-left:3px solid #c9a96e;color:#6b6256}'
    + '</style></head><body' + bodyAttr + '>'
    + body
    + '</body></html>';
}

/** HTML 正文 → sandbox iframe 片段。 */
export function renderHtmlFrame(content, { title = 'HTML 笔记正文', className = 'note-html-frame', style = '' } = {}) {
  const doc = safeHtmlDocument(content, style);
  return `<iframe class="${escAttr(className)}" sandbox="" loading="lazy" title="${escAttr(title)}" srcdoc="${escAttr(doc)}"></iframe>`;
}

/** 编辑器预览：把 iframe 放进现有容器（DOM 环境）。 */
export function renderHtmlPreviewInto(container, content, { style = '' } = {}) {
  if (!container) return;
  container.innerHTML = renderHtmlFrame(content, { title: 'HTML 预览', style });
}


/** 打印稿 HTML 清洗：浏览器用 DOMParser 白名单清理；node 无 DOM 时降级为安全文本。 */
export function sanitizeHtmlForPrint(raw) {
  const src = String(raw == null ? '' : raw);
  if (typeof DOMParser === 'undefined') {
    return `<pre class="note-text">${String(src).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}</pre>`;
  }
  const ALLOWED = new Set(['P','BR','DIV','SPAN','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE','STRONG','B','EM','I','U','S','DEL','MARK','A','IMG','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','HR','FIGURE','FIGCAPTION','SUP','SUB','SMALL']);
  const DROP = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','BASE','META','LINK']);
  const ALLOWED_ATTR = new Set(['href','src','alt','title','class','style','colspan','rowspan','width','height','data-width','data-rotate','data-align']);
  const doc = new DOMParser().parseFromString(src, 'text/html');
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        const tag = child.tagName;
        if (DROP.has(tag)) { child.remove(); continue; }
        if (!ALLOWED.has(tag)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          child.remove();
          continue;
        }
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase();
          const val = String(attr.value || '');
          const lower = val.trim().toLowerCase();
          if (name.startsWith('on') || !ALLOWED_ATTR.has(name)
            || ((name === 'href' || name === 'src') && /^(javascript:|vbscript:|data:text\/html)/i.test(lower))
            || (name === 'style' && /(url\s*\(|@import|expression\s*\(|javascript:)/i.test(lower))) {
            child.removeAttribute(attr.name);
          }
        }
        walk(child);
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export default { safeHtmlDocument, renderHtmlFrame, renderHtmlPreviewInto, sanitizeHtmlForPrint };
