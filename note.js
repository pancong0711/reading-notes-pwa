/* note.js —— 笔记详情页（需求：PWA 笔记详情页）
 *
 * 全屏阅读单条记录（笔记/日记/日志/备忘/自定义类型通用）：
 *   ?id=<记录id> → getNoteById → note-detail 全量渲染（markdown/公式排版/图片自包含供图）
 *   「✏️ 编辑」→ type.html?t=<type>&edit=<id>（统一编辑器，保存后回跳本页）
 *   「← 返回」→ history.back()（无来源时回 type.html?t=<type>）
 */
import { getNoteById, getConceptCatalog } from './data.js';
import { renderNoteDetailInto } from './note-detail.js';
import { typesetInto } from './vendor/mathjax3/mathjax-boot.js';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

/** 类型显示名（内置 4 类走 NoteTypes；自定义类型兜底显示 key） */
function typeLabel(key) {
  try {
    const t = window.NoteTypes && window.NoteTypes.getType(key);
    if (t) return t.label;
  } catch (e) { /* types.js 未就绪时兜底 */ }
  return key || '笔记';
}

/** 题头元信息行 */
function metaLine(n) {
  const parts = [];
  if (n.date) parts.push(esc(n.date));
  if (n.project) parts.push(`📁 ${esc(n.project)}`);
  if (n.book) parts.push(`《${esc(n.book)}》`);
  if (n.pages) parts.push(`第 ${esc(n.pages)} 页`);
  if (Array.isArray(n.tags) && n.tags.length) parts.push(n.tags.map((t) => `#${esc(t)}`).join(' '));
  return parts.join(' ｜ ');
}

/** 图片缺失诊断：渲染后对加载失败的 img 换成占位说明（含引用路径） */
function attachImageDiagnostics(container) {
  container.querySelectorAll('img.note-detail-img').forEach((img) => {
    img.addEventListener('error', () => {
      const path = img.getAttribute('data-path') || img.getAttribute('src') || '';
      const tip = document.createElement('p');
      tip.className = 'muted';
      tip.textContent = `⚠️ 图片缺失：${path}——可用「⬇ 备份 / 迁移包（含图片）」重新导入，或电脑端 cli sync 补齐`;
      img.replaceWith(tip);
    }, { once: true });
  });
}

async function load() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    $('note-title').textContent = '缺少记录 id';
    $('note-missing').hidden = false;
    $('note-missing').textContent = '请从记录列表进入详情页（note.html?id=…）';
    return;
  }

  const note = await getNoteById(id);
  if (!note) {
    $('note-title').textContent = '没有找到这条记录';
    $('note-missing').hidden = false;
    $('note-missing').textContent = '可能尚未导入：请在记录页点「⇄ 从电脑导入」，或导入迁移包。';
    return;
  }

  document.title = `${note.title || '笔记详情'} · 读书笔记`;
  $('note-title').textContent = note.title || '未命名';
  $('note-meta').innerHTML = metaLine(note);
  const badge = $('note-type-badge');
  badge.textContent = typeLabel(note.type || 'note');
  badge.hidden = false;
  badge.style.background = '#c9a96e';

  const catalogById = {};
  try {
    const catalog = await getConceptCatalog();
    ((catalog && catalog.concepts) || []).forEach((c) => { catalogById[c.id] = c; });
  } catch (e) { /* 目录缺失时按 id 显示 */ }

  const body = $('note-body');
  await renderNoteDetailInto(body, note, catalogById);
  try { await typesetInto(body); } catch (e) { /* 公式排版失败不阻断 */ }
  attachImageDiagnostics(body);

  $('edit-btn').addEventListener('click', () => {
    location.href = `type.html?t=${encodeURIComponent(note.type || 'note')}&edit=${encodeURIComponent(note.id)}`;
  });
}

$('back-btn').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = 'type.html';
});

load();