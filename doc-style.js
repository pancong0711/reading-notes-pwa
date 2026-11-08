/* doc-style.js —— 文档级样式白名单（20261024 FMT-15）
 * 只允许字体/对齐/行距/全文首行缩进四个语义字段，拒绝任意 CSS。
 */
export const FONT_OPTIONS = [
  { value: 'serif', label: '衬线（宋体）', css: '"Noto Serif CJK SC","Source Han Serif SC","Songti SC",serif' },
  { value: 'sans', label: '无衬线（黑体）', css: '"Noto Sans CJK SC","Source Han Sans SC","PingFang SC",sans-serif' },
  { value: 'kai', label: '楷体', css: '"Kaiti SC","STKaiti","KaiTi",serif' },
  { value: 'mono', label: '等宽', css: '"SFMono-Regular","Cascadia Code","Consolas",monospace' },
];
export const ALIGN_OPTIONS = ['left', 'center', 'right', 'justify'];
export const LINE_HEIGHT_OPTIONS = { compact: 1.65, normal: 1.9, loose: 2.2 };
export const INDENT_OPTIONS = ['none', '2em'];

export function normalizeDocStyle(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const font = FONT_OPTIONS.some((f) => f.value === s.font) ? s.font : 'serif';
  const align = ALIGN_OPTIONS.includes(s.align) ? s.align : 'left';
  const lineHeight = Object.prototype.hasOwnProperty.call(LINE_HEIGHT_OPTIONS, s.lineHeight)
    ? s.lineHeight : 'normal';
  const firstLineIndent = INDENT_OPTIONS.includes(s.firstLineIndent) ? s.firstLineIndent : 'none';
  return { font, align, lineHeight, firstLineIndent };
}

export function fontCss(font) {
  return (FONT_OPTIONS.find((f) => f.value === font) || FONT_OPTIONS[0]).css;
}

export function styleToCss(raw) {
  const s = normalizeDocStyle(raw);
  return `font-family:${fontCss(s.font)};text-align:${s.align};line-height:${LINE_HEIGHT_OPTIONS[s.lineHeight]}`
    + (s.firstLineIndent === '2em' ? ';text-indent:2em' : '');
}

export function styleSummary(raw) {
  const s = normalizeDocStyle(raw);
  const f = FONT_OPTIONS.find((x) => x.value === s.font)?.label || s.font;
  return `${f}｜${s.align}｜${s.lineHeight}${s.firstLineIndent === '2em' ? '｜首行缩进' : ''}`;
}

export default { normalizeDocStyle, styleToCss, styleSummary, FONT_OPTIONS, ALIGN_OPTIONS, LINE_HEIGHT_OPTIONS, INDENT_OPTIONS };
