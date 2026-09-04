/* markdown-lite.js —— 自实现的受控 Markdown 子集渲染器
 *
 * 背景：需求「PWA 笔记详情与图片可达」需在浏览器端渲染笔记正文（markdown）。
 * 本环境网络不可达（CDN 下载 marked 失败），故实现本模块替代，仍满足
 * 「本地化、无外链」红线。只支持项目笔记实际用到的受控语法子集：
 *
 *   · 标题（#~####）、粗体 **x**、斜体 *x*、删除线 ~~x~~、高亮 ==x==
 *   · 行内代码 `x`、围栏代码块 ```lang ... ```
 *   · 公式节点识别：行内 $x^2$ → span.math.math-inline；块级 $$…$$（同行/跨行）→ span.math.math-block
 *     （内容逐字保留、先转义；实际排版由 mathjax-boot typesetInto 定点处理，未加载时原文可见）
 *   · 无序列表（- * +）、有序列表（1. 等）、引用 >
 *   · 链接 [t](url)、图片 ![alt](src)、简版表格（| 分隔行）+ 分隔行 ---
 *   · 段落、空行分段、（非 raw HTML——原文先转义，绝不执行未声明标签）
 *
 * 安全约定：
 *   1. 先对原文做 HTML 转义（< > & " '）再解析——不启用 raw HTML；
 *   2. 链接 href / 图片 src 仅允许 http(s)://、相对路径（./ ../ /）、
 *      图片另允许 data:image/；javascript: 等一律丢弃转为纯文本。
 *
 * 纯函数、无 DOM 依赖：浏览器（ES module）与 node 测试均可加载。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** href/src 白名单校验：http(s)、协议相对（//）、无冒号相对路径（assets/… ./ ../ /）、图片 data:image */
function safeUrl(url, isImg) {
  const u = String(url).trim();
  if (/^https?:\/\//i.test(u)) return u;                  // http(s)://
  if (/^\/\//.test(u)) return u;                          // 协议相对 //host
  if (isImg && /^data:image\//i.test(u)) return u;        // 本地 base64 缩略图
  if (!/:/.test(u)) return u;                             // 无协议冒号 → 相对路径（assets/… 等）
  return null;                                            // javascript: 等一律拒绝
}

function escAttr(s) {
  return String(s).replace(/["'<>]/g, (c) => ESC[c]);
}

/** 行内解析（调用前文本已转义）：
 * 顺序锁定：① 行内码先取出占位（防 $ / == 被误处理）→ ② $$…$$ / $…$ 公式节点
 * → ③ ==高亮== → ④ 图片/链接 → ⑤ **b** *i* ~~s~~ → ⑥ 还原行内码。
 */
function inline(text) {
  let out = String(text);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 块级公式（同行 $$…$$；独立行由 blocks() 处理）
  out = out.replace(/\$\$([^$]+)\$\$/g, (m, body) => `<span class="math math-block">$$${body}$$</span>`);
  // 行内公式 $…$（前导符不为 $、后置非 $，避免与 $$ 冲突）
  out = out.replace(/(^|[^$])\$([^$\n]+)\$(?!\$)/g, (m, pre, body) => `${pre}<span class="math math-inline">$${body}$</span>`);

  // 高亮 ==…==（内容不含 = 与换行）
  out = out.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');

  // 图片与链接（按顺序先图片）
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, src) => {
    const u = safeUrl(src, true);
    if (!u) return `[${alt}](${src})`;
    return `<img src="${escAttr(u)}" alt="${escapeHtml(alt)}" loading="lazy">`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, t, href) => {
    const u = safeUrl(href, false);
    if (!u) return `[${t}](${href})`;
    return `<a href="${escAttr(u)}" target="_blank" rel="noopener">${t}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  out = out.replace(/\u0000C(\d+)\u0000/g, (m, i) => codes[+i] || m);
  return out;
}

/** 块级解析 */
function blocks(lines) {
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    // 围栏代码块
    const fence = /^```/.exec(t);
    if (fence) {
      const buf = [];
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j].trim())) { buf.push(lines[j]); j++; }
      html.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      i = j + 1;
      continue;
    }

    // 块级公式：$$…$$（同行闭合或 $$ 起跨行到含 $$ 的行；内容已转义、逐字保留）
    if (/^\$\$/.test(t)) {
      if (/\$\$$/.test(t)) {
        const inner = t.replace(/^\$\$/, '').replace(/\$\$$/, '');
        html.push(`<p><span class="math math-block">$$${inner}$$</span></p>`);
        i++;
      } else {
        const buf = [t.replace(/^\$\$/, '')];
        let j = i + 1;
        while (j < lines.length && !/\$\$$/.test(lines[j].trim())) {
          buf.push(lines[j]);
          j++;
        }
        if (j < lines.length) {
          buf.push(lines[j].trim().replace(/\$\$$/, ''));
          const inner = buf.join('\n').trim();
          html.push(`<p><span class="math math-block">$$${inner}$$</span></p>`);
          i = j + 1;
        } else {
          // 未闭合：退化为普通段落（公式原文可见）
          html.push(`<p>${inline(t)}</p>`);
          i++;
        }
      }
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      const lvl = h[1].length;
      html.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`);
      i++;
      continue;
    }

    // 引用块（连续 > 行）
    if (/^&gt;\s?/.test(t)) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^&gt;\s?/, ''));
        i++;
      }
      html.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
      continue;
    }

    // 无序 / 有序列表（连续同类行）
    const ul = /^[-*+]\s+/.exec(t);
    const ol = /^\d+[.)]\s+/.exec(t);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      const buf = [];
      const re = ul ? /^[-*+]\s+(.*)$/ : /^\d+[.)]\s+(.*)$/;
      while (i < lines.length) {
        const m2 = re.exec(lines[i].trim());
        if (!m2) break;
        buf.push(`<li>${inline(m2[1])}</li>`);
        i++;
      }
      html.push(`<${tag}>${buf.join('')}</${tag}>`);
      continue;
    }

    // 表格：当前行含 |，下一行为分隔行（|---|…），再一行含 | 即渲染
    if (t.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1].trim())
        && lines[i + 1].includes('-')) {
      const head = t.split('|').map((s) => s.trim()).filter((s, idx, arr) => !(idx === 0 && s === '') && !(idx === arr.length - 1 && s === ''));
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|')) {
        const cells = lines[j].split('|').map((s) => s.trim());
        rows.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
        j++;
      }
      html.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      i = j;
      continue;
    }

    // 空行
    if (!t) { i++; continue; }

    // 普通段落：收集到空行或块级起点
    const buf = [];
    while (i < lines.length && lines[i].trim() !== ''
        && !/^(#{1,4})\s/.test(lines[i].trim())
        && !/^```/.test(lines[i].trim())
        && !/^&gt;\s?/.test(lines[i].trim())
        && !/^[-*+]\s+/.test(lines[i].trim())
        && !/^\d+[.)]\s+/.test(lines[i].trim())) {
      buf.push(lines[i].trim());
      i++;
    }
    html.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return html.join('\n');
}

/**
 * 渲染 Markdown 子集 → 安全 HTML 字符串。
 * @param {string|*} md 笔记正文
 * @returns {string} HTML（原文先转义；仅受控语法产生标签）
 */
export function renderMarkdown(md) {
  if (md == null) return '';
  const text = escapeHtml(String(md)).replace(/\r\n?/g, '\n');
  return blocks(text.split('\n'));
}

export default { renderMarkdown };