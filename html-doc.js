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


/** 打印稿 HTML 清洗：浏览器用 DOMParser 白名单清理；node 无 DOM 时降级为安全文本。
 *
 * 安全要点（20261107 审核修复）：
 *   · 先取全量元素快照，再处理——非白名单标签被“展开”后，其子元素仍会被后续遍历清洗，
 *     修复 <foo><script>…</script></foo> 这类嵌套绕过；
 *   · href/src 去掉 ASCII 控制字符后再判断 scheme，避免 java\tscript: 等绕过；
 *   · style 只允许白名单属性，拒绝反斜杠转义、url()、@import、expression 等注入面。
 */
export function sanitizeHtmlForPrint(raw) {
  const src = String(raw == null ? '' : raw);
  if (typeof DOMParser === 'undefined') {
    return `<pre class="note-text">${String(src).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}</pre>`;
  }
  const ALLOWED = new Set(['P','BR','DIV','SPAN','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE','STRONG','B','EM','I','U','S','DEL','MARK','A','IMG','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','HR','FIGURE','FIGCAPTION','SUP','SUB','SMALL']);
  const DROP = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','BASE','META','LINK','TEMPLATE','NOSCRIPT']);
  const ALLOWED_ATTR = new Set(['href','src','alt','title','class','style','colspan','rowspan','width','height','data-width','data-rotate','data-align']);
  const ALLOWED_STYLE_PROPS = new Set([
    'font-family','font-size','font-weight','text-align','text-decoration','line-height',
    'width','max-width','min-width','height','max-height','min-height',
    'transform','transform-origin','margin','margin-top','margin-right','margin-bottom','margin-left',
    'padding','padding-top','padding-right','padding-bottom','padding-left',
    'color','background-color','border','border-color','border-width','border-style','border-radius',
  ]);

  const compactScheme = (value) => String(value || '')
    .replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();

  const safeUrl = (value, isSrc) => {
    const v = String(value || '').trim();
    if (!v) return false;
    const c = compactScheme(v);
    if (c.startsWith('#')) return true;
    if (/^(https?:|mailto:)/.test(c)) return !isSrc || /^https?:/.test(c);
    if (isSrc && /^blob:/.test(c)) return true;
    if (isSrc && /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif)[;,]/.test(c)) return true;
    if (/^[a-z][a-z0-9+.-]*:/.test(c)) return false;   // 其他 scheme 一律拒绝
    return true;                                        // 相对路径 / #锚点 / //host
  };

  const safeStyle = (value) => {
    const v = String(value || '').trim();
    if (!v) return false;
    if (/[\\<>{}]|\/\*|\*\//.test(v) || /url\s*\(|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(v)) return false;
    for (const part of v.split(';')) {
      const text = part.trim();
      if (!text) continue;
      const idx = text.indexOf(':');
      if (idx <= 0) return false;
      const prop = text.slice(0, idx).trim().toLowerCase();
      if (!ALLOWED_STYLE_PROPS.has(prop)) return false;
    }
    return true;
  };

  const doc = new DOMParser().parseFromString(src, 'text/html');
  // 全量快照：即使父元素被展开/删除，后代元素仍会进入本轮清洗。
  const elements = [...doc.body.querySelectorAll('*')];
  for (const el of elements) {
    const tag = String(el.tagName || '').toUpperCase();   // SVG 等命名空间元素 tagName 为小写
    if (DROP.has(tag)) { el.remove(); continue; }
    if (!ALLOWED.has(tag)) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = String(attr.value || '');
      if (name.startsWith('on') || !ALLOWED_ATTR.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' && !safeUrl(val, false))
        || (name === 'src' && !safeUrl(val, true))
        || (name === 'style' && !safeStyle(val))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

export default { safeHtmlDocument, renderHtmlFrame, renderHtmlPreviewInto, sanitizeHtmlForPrint };
