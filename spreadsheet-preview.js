/* spreadsheet-preview.js —— 附件笔记中的 Excel/CSV 表格预览（20261108）
 *
 * 仅用于本地读取：
 *   · 动态加载 vendor/xlsx.full.min.js（SheetJS CE，Apache-2.0）；
 *   · 从媒体 Blob 仓读取 xlsx/xls/csv/ods；
 *   · 只展示文本表格，不执行公式、不保留单元格 HTML；
 *   · 行/列/工作表数量限幅，避免超大文件卡死手机。
 */
import { getImageFile } from './data.js';

const SHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'ods']);
const MAX_SHEETS = 10;
const MAX_ROWS = 200;
const MAX_COLS = 40;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function isSpreadsheetFile(name) {
  const ext = String(name || '').split(/[?#]/)[0].split('.').pop().toLowerCase();
  return SHEET_EXTS.has(ext);
}

/** 纯函数：二维行数据 → 安全 HTML 表格；所有单元格文本转义。 */
export function renderSheetTable(rows, opts = {}) {
  const maxRows = Math.max(1, Number(opts.maxRows) || MAX_ROWS);
  const maxCols = Math.max(1, Number(opts.maxCols) || MAX_COLS);
  const all = Array.isArray(rows) ? rows : [];
  const shown = all.slice(0, maxRows).map((row) => (Array.isArray(row) ? row.slice(0, maxCols) : []));
  if (!shown.length) return '<p class="muted">（空工作表）</p>';
  const width = Math.max(1, ...shown.map((r) => r.length));
  const head = shown[0].concat(Array(Math.max(0, width - shown[0].length)).fill(''));
  const body = shown.slice(1).map((row) => {
    const cells = row.concat(Array(Math.max(0, width - row.length)).fill(''));
    return `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
  }).join('');
  const truncated = all.length > maxRows || all.some((r) => Array.isArray(r) && r.length > maxCols);
  return `<div class="sheet-table-wrap"><table class="sheet-table"><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`
    + (truncated ? `<p class="muted sheet-truncated">仅显示前 ${maxRows} 行 × ${maxCols} 列</p>` : '');
}

let _xlsxPromise = null;
function loadXlsx() {
  if (typeof window !== 'undefined' && window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./vendor/xlsx.full.min.js', import.meta.url).href;
    script.async = true;
    script.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('表格解析组件加载后不可用')));
    script.onerror = () => reject(new Error('表格解析组件加载失败（可离线刷新后重试）'));
    document.head.appendChild(script);
  });
  return _xlsxPromise;
}

async function mediaBlob(src) {
  const local = await getImageFile(src);
  if (local) return local;
  const resp = await fetch(src, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`附件读取失败（HTTP ${resp.status}）`);
  return resp.blob();
}

export async function renderSpreadsheetPreviews(container, note) {
  if (!container || !note) return;
  const media = (Array.isArray(note.media) ? note.media : [])
    .filter((m) => m && m.src && (m.kind === 'file' || isSpreadsheetFile(m.name || m.src)) && isSpreadsheetFile(m.name || m.src));
  if (!media.length) return;
  const section = document.createElement('div');
  section.className = 'note-sec spreadsheet-preview';
  section.innerHTML = '<h4>表格预览</h4>';
  container.appendChild(section);
  let XLSX;
  try { XLSX = await loadXlsx(); }
  catch (e) {
    section.insertAdjacentHTML('beforeend', `<p class="muted">⚠️ ${esc(e.message)}</p>`);
    return;
  }
  for (const item of media) {
    const label = item.name || item.src;
    const details = document.createElement('details');
    details.className = 'sheet-preview';
    details.open = section.querySelectorAll('.sheet-preview').length === 0;
    details.innerHTML = `<summary>${esc(label)}</summary><p class="muted sheet-loading">正在读取…</p>`;
    section.appendChild(details);
    try {
      const blob = await mediaBlob(item.src);
      const data = new Uint8Array(await blob.arrayBuffer());
      const wb = XLSX.read(data, { type: 'array', cellDates: true, sheetRows: MAX_ROWS + 1 });
      const loading = details.querySelector('.sheet-loading');
      if (loading) loading.remove();
      const names = (wb.SheetNames || []).slice(0, MAX_SHEETS);
      names.forEach((name, idx) => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
          header: 1, raw: false, defval: '', blankrows: false,
        });
        const rowDetails = document.createElement('details');
        rowDetails.className = 'sheet-tab';
        rowDetails.open = idx === 0;
        rowDetails.innerHTML = `<summary>${esc(name)}（${Math.max(0, rows.length - 1)} 行）</summary>${renderSheetTable(rows)}`;
        details.appendChild(rowDetails);
      });
      if ((wb.SheetNames || []).length > MAX_SHEETS) {
        details.insertAdjacentHTML('beforeend', `<p class="muted">仅显示前 ${MAX_SHEETS} 个工作表</p>`);
      }
    } catch (e) {
      const loading = details.querySelector('.sheet-loading');
      if (loading) loading.textContent = `⚠️ 表格读取失败：${e.message}`;
    }
  }
}

export default { isSpreadsheetFile, renderSheetTable, renderSpreadsheetPreviews };
