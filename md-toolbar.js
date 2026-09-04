/* md-toolbar.js —— 富文本工具栏纯函数（A1：markdown 语法插入 + 编辑/预览）
 *
 * 无 DOM 依赖（node 无头测试可直接 import）：
 *   - BUTTONS：工具栏按钮定义（label/title/语法配置）
 *   - wrapSelection(value, selStart, selEnd, cfg)：按配置改写 textarea 文本并返回新光标位
 *   - renderPreview(md)：markdown-lite（含公式节点与高亮）渲染，供「预览」双态切换
 *
 * 语法配置三型：
 *   inline      选区包裹型（粗体/斜体/高亮/行内码/删除线/行内公式）——选区非空包住选区，空选区插占位
 *   linePrefix  行首前缀型（标题/引用/无序/有序列表）——在光标所在行行首插入前缀
 *   template    模板插入型（代码块/表格/块级公式）——在光标处插入多行模板
 */
import { renderMarkdown } from './vendor/markdown-lite.js';

export const BUTTONS = [
  { key: 'bold', label: 'B', title: '粗体', inline: ['**', '**'] },
  { key: 'italic', label: 'I', title: '斜体', inline: ['*', '*'] },
  { key: 'highlight', label: '亮', title: '高亮', inline: ['==', '=='] },
  { key: 'code', label: '<>', title: '行内代码', inline: ['`', '`'] },
  { key: 'strike', label: 'S', title: '删除线', inline: ['~~', '~~'] },
  { key: 'math', label: 'ƒ', title: '行内公式 $…$（TeX）', inline: ['$', '$'] },
  { key: 'math-block', label: 'ƒƒ', title: '块级公式 $$…$$', template: '$$\n\\frac{a}{b}\n$$', placeholder: false },
  { key: 'h2', label: 'H', title: '标题（## ）', linePrefix: '## ' },
  { key: 'quote', label: '❝', title: '引用（> ）', linePrefix: '> ' },
  { key: 'ul', label: '•', title: '无序列表（- ）', linePrefix: '- ' },
  { key: 'ol', label: '1.', title: '有序列表（1. ）', linePrefix: '1. ' },
  { key: 'codeblock', label: '```', title: '代码块', template: '```\n// 代码\n```' },
  { key: 'table', label: '表', title: '两列表格', template: '| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |' },
];

/** 取光标所在行行首偏移（不含换行） */
function lineStart(value, pos) {
  const nl = value.lastIndexOf('\n', pos - 1);
  return nl + 1;
}

/**
 * 按配置改写文本。
 * @param {string} value   textarea 当前值
 * @param {number} selStart
 * @param {number} selEnd
 * @param {object} cfg  { inline?:[before,after], linePrefix?:string, template?:string }
 * @returns {{value:string, selStart:number, selEnd:number}}
 */
export function wrapSelection(value, selStart, selEnd, cfg) {
  const v = String(value);
  const s = Math.max(0, Math.min(selStart, v.length));
  const e = Math.max(s, Math.min(selEnd, v.length));

  // 模板插入型：光标处插入
  if (cfg.template) {
    const seg = cfg.template;
    const next = v.slice(0, s) + seg + v.slice(e);
    const cur = s + seg.length;
    return { value: next, selStart: cur, selEnd: cur };
  }

  // 行首前缀型：光标所在行行首插入
  if (cfg.linePrefix) {
    const ls = lineStart(v, s);
    const prefix = cfg.linePrefix;
    // 若该行已有同前缀则不重复
    const line = v.slice(ls, v.indexOf('\n', ls) === -1 ? v.length : v.indexOf('\n', ls));
    if (line.startsWith(prefix.trimStart() + ' ') || line.trim().startsWith(prefix.trim())) {
      return { value: v, selStart: s, selEnd: e };
    }
    const next = v.slice(0, ls) + prefix + v.slice(ls);
    return { value: next, selStart: s + prefix.length, selEnd: e + prefix.length };
  }

  // 选区包裹型
  const [before, after] = cfg.inline || ['', ''];
  const selected = v.slice(s, e);
  if (selected) {
    const next = v.slice(0, s) + before + selected + after + v.slice(e);
    return { value: next, selStart: s + before.length, selEnd: e + before.length };
  }
  const placeholder = cfg.placeholder || '内容';
  const next = v.slice(0, s) + before + placeholder + after + v.slice(e);
  const cur = s + before.length;
  return { value: next, selStart: cur, selEnd: cur + placeholder.length };
}

/** 预览：markdown-lite 渲染（调用方对返回 HTML 容器再调 typesetInto 排版公式） */
export function renderPreview(md) {
  return renderMarkdown(md);
}

export default { BUTTONS, wrapSelection, renderPreview };