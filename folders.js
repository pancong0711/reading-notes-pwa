/* folders.js —— 📒 笔记目录页（需求 20260911 ⑤）
 *
 * 文件夹卡片网格（层级由 folder-util 前缀树给出；根级显示顶级文件夹 + other）：
 *   · 卡片：名称 · 直属/含子树条数 · 类型徽标 · 最近更新 · ⋯（重命名/删除）
 *   · 「＋ 新建文件夹」（支持 a/b 路径）；「✏️ 管理」进入卡片管理模式
 *   · 点卡片 → folder.html?p=<路径>
 */
import {
  getAllNotes, getFolders, createFolder, renameFolder, deleteFolder, getConceptCatalog,
} from './data.js';
import { buildTree, folderStats, typeCounts, normalizeProject, OTHERS, filterNotes } from './folder-util.js';
import { mountDataActions } from './data-actions.js';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function typeLabel(key) {
  try {
    const t = window.NoteTypes && window.NoteTypes.getType(key);
    if (t) return `${t.icon} ${t.label}`;
  } catch (e) { /* ignore */ }
  return key;
}

let manageMode = false;
let searchQuery = '';
let allNotes = [];
let editingPath = null;   // 非 null = 重命名模式

/* ── 渲染 ── */

async function render() {
  const [notes, folders] = await Promise.all([getAllNotes(), getFolders()]);
  allNotes = notes;
  // 搜索模式：跨文件夹列出匹配笔记（20260911）
  if (searchQuery.trim()) { renderSearchResults(notes); return; }
  $('search-results').hidden = true;
  $('folder-grid').hidden = false;
  // 全部路径 = 显式文件夹 ∪ 记录 project（含中间层自动补齐）
  const paths = new Set(folders.map((f) => normalizeProject(f.path)));
  notes.forEach((n) => paths.add(normalizeProject(n.project)));
  if (!paths.size) paths.add(OTHERS);

  const tree = buildTree([...paths]);
  const grid = $('folder-grid');
  grid.innerHTML = '';
  $('empty-state').hidden = tree.length > 0;

  for (const node of tree) {
    const stats = folderStats(notes, node.path);
    const counts = typeCounts(notes.filter((n) => normalizeProject(n.project) === node.path || normalizeProject(n.project).startsWith(node.path + '/')));
    const chips = Object.entries(counts)
      .map(([k, v]) => `<span class="tag">${esc(typeLabel(k))} ${v}</span>`).join('');
    const card = document.createElement('article');
    card.className = 'folder-card';
    card.dataset.path = node.path;
    card.innerHTML = `
      <div class="folder-card-head">
        <span class="folder-icon">${node.path === OTHERS ? '📥' : '📁'}</span>
        <h3>${esc(node.name)}</h3>
        ${manageMode ? `<span class="folder-card-actions">
            <button class="btn ghost small" data-act="rename" type="button">重命名</button>
            <button class="btn ghost small danger" data-act="delete" type="button">删除</button>
          </span>` : ''}
      </div>
      <p class="folder-card-meta">${stats.direct} 篇直属 · 含子层 ${stats.total} 篇 · 最近 ${esc(fmtDate(stats.latest))}</p>
      ${node.children.length ? `<p class="folder-card-sub">子文件夹：${node.children.map((c) => esc(c.name)).join('、')}</p>` : ''}
      ${chips ? `<div class="note-tags">${chips}</div>` : ''}`;
    card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) { e.stopPropagation(); return; }
      if (manageMode) return;
      location.href = `folder.html?p=${encodeURIComponent(node.path)}`;
    });
    grid.appendChild(card);
  }

  $('folder-count').textContent = `${tree.length} 个文件夹 · ${notes.length} 篇记录`;
  $('manage-toggle').textContent = manageMode ? '✅ 完成' : '✏️ 管理';

  // 管理模式：重命名/删除
  grid.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const path = btn.closest('.folder-card').dataset.path;
      if (btn.dataset.act === 'rename') {
        if (path === OTHERS) { toast('other 为系统默认文件夹，不能重命名', 3600); return; }
        editingPath = path;
        $('folder-panel-title').textContent = `重命名文件夹：${path}`;
        $('folder-path').value = path;
        $('folder-panel-msg').textContent = '';
        $('folder-panel').hidden = false;
        $('folder-path').focus();
      } else if (btn.dataset.act === 'delete') {
        if (path === OTHERS) { toast('other 为系统默认文件夹，不能删除', 3600); return; }
        const stats = folderStats(notes, path);
        if (!confirm(`删除文件夹「${path}」？\n其中 ${stats.total} 篇记录将移入 other（不会删除任何笔记）`)) return;
        try {
          const { movedToOther } = await deleteFolder(path);
          toast(`已删除文件夹，${movedToOther} 篇记录移入 other`);
          await render();
        } catch (err) { toast(`删除失败：${err.message}`, 4200); }
      }
    });
  });
}

/* ── 搜索（跨文件夹）── */

function renderSearchResults(notes) {
  const list = filterNotes(notes, { q: searchQuery })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  $('folder-grid').hidden = true;
  $('search-results').hidden = false;
  $('search-count').textContent = `（${list.length} 篇）`;
  const wrap = $('search-list');
  wrap.innerHTML = '';
  for (const n of list) {
    const card = document.createElement('article');
    card.className = 'note-card';
    card.innerHTML = `
      <div class="note-thumb note-thumb-empty">${esc((window.NoteTypes && NoteTypes.getType(n.type || 'note') || {}).icon || '📝')}</div>
      <div class="note-body">
        <div class="note-meta">${esc(n.date || '无日期')} · 📁 ${esc(normalizeProject(n.project))}</div>
        <h3 class="note-title">${esc(n.title || '未命名')}</h3>
        <p class="note-note">${esc(String(n.content || n.readerNote || n.aiNote || '').replace(/\s+/g, ' ').slice(0, 90))}</p>
      </div>`;
    card.addEventListener('click', () => { location.href = `note.html?id=${encodeURIComponent(n.id)}`; });
    wrap.appendChild(card);
  }
}

/* ── 面板（新建 / 重命名）── */

function openNewFolder() {
  editingPath = null;
  $('folder-panel-title').textContent = '新建文件夹';
  $('folder-path').value = '';
  $('folder-panel-msg').textContent = '';
  $('folder-panel').hidden = false;
  $('folder-path').focus();
}

async function saveFolder() {
  const raw = $('folder-path').value;
  const msg = $('folder-panel-msg');
  try {
    if (editingPath) {
      const changed = await renameFolder(editingPath, raw);
      toast(changed ? `已重命名，${changed} 篇记录已改归属` : '已重命名');
    } else {
      const rec = await createFolder(raw);
      toast(`已创建文件夹：${rec.path}`);
    }
    $('folder-panel').hidden = true;
    editingPath = null;
    await render();
  } catch (e) {
    msg.textContent = `⚠️ ${e.message}`;
  }
}

/* ── 事件 ── */

$('new-folder-btn').addEventListener('click', openNewFolder);
$('search-input').addEventListener('input', (e) => { searchQuery = e.target.value; render(); });
$('new-note-btn').addEventListener('click', () => {
  // 目录页直接新建（默认阅读笔记，project 默认 other，可在编辑器内改）
  location.href = 'type.html?t=note&new=1&ret=';
});
// 数据管理入口（⚙️ 数据）：导入/备份/导出生成/类型/标签——共享模块（20260911 回归修复）
mountDataActions({ onChange: render, getCurrentType: () => null });
$('manage-toggle').addEventListener('click', () => { manageMode = !manageMode; render(); });
$('folder-save').addEventListener('click', saveFolder);
$('folder-cancel').addEventListener('click', () => { $('folder-panel').hidden = true; editingPath = null; });
$('folder-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveFolder(); });

render();