/* type.js —— 记录列表/筛选页（编辑表单已迁移到独立 editor.html）
 *
 * 20261107 改版：
 *   · 列表页只负责浏览、搜索、筛选、删除与数据管理；
 *   · 新建/编辑统一跳转 editor.html（独立页面，固定保存栏）；
 *   · 保留 ?t=all&tag= / &concept= 过滤落地页与旧 URL 重定向。
 */
import { getAllNotes, deleteNote, getAllProjects, getAllBooks } from './data.js';
import { mountDataActions } from './data-actions.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const key = params.get('t') || 'note';
const currentType = NoteTypes.getType(key) || NoteTypes.getType('note');

let notesCache = [];
let conceptCatalog = [];
let conceptDomainNames = {};
let searchQuery = '';
let typeFilter = '';
let listFilters = {
  project: '', book: '', dateFrom: '', dateTo: '',
  tag: params.get('tag') || '', concept: params.get('concept') || '',
};
let toastTimer = null;

function toast(msg, ms = 2800) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function summary(text, len = 80) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  return t.length > len ? `${t.slice(0, len)}…` : t;
}

function renderHeader() {
  $('main-nav').innerHTML = NoteTypes.renderNav('folders');
  $('type-title').textContent = `${currentType.icon} ${currentType.label}`;
  $('type-hint').textContent = currentType.pseudo
    ? '跨类型浏览与筛选；点「写一篇」进入独立编辑页。'
    : (currentType.hint || '');
  document.title = `${currentType.label} · 读书笔记`;
}

function currentReturnUrl() {
  return `${location.pathname.split('/').pop() || 'type.html'}${location.search}${location.hash}`;
}

function newNoteHref() {
  const t = currentType.pseudo ? 'note' : currentType.key;
  return `editor.html?type=${encodeURIComponent(t)}&ret=${encodeURIComponent(currentReturnUrl())}`;
}

function conceptName(id) {
  const c = conceptCatalog.find((x) => x.id === id);
  return c ? c.name : id;
}

function renderList(notes) {
  const listEl = $('record-list');
  listEl.innerHTML = '';
  for (const n of notes) {
    const card = document.createElement('article');
    card.className = 'note-card' + ((n.meta && n.meta.done) ? ' done' : '');
    const typeDef = NoteTypes.getType(n.type || 'note');
    const thumb = n.imageData || (Array.isArray(n.images) && n.images[0])
      ? `<img class="note-thumb" src="${esc(n.imageData || n.images[0])}" alt="照片">`
      : `<div class="note-thumb note-thumb-empty">${esc(typeDef?.icon || '📝')}</div>`;
    const chips = [];
    if (n.book) chips.push(esc(n.book));
    if (n.pages) chips.push(`页 ${esc(n.pages)}`);
    if (n.meta?.due) chips.push(`截止 ${esc(n.meta.due)}`);
    const metaLine = `<div class="note-meta">${esc(typeDef?.label || n.type || '笔记')} · ${esc(n.date || '无日期')}${n.project ? ' · 📁 ' + esc(n.project) : ''}${chips.length ? ' · ' + chips.join(' · ') : ''}</div>`;
    const contentHtml = n.content ? `<p class="note-note content">${esc(summary(n.content))}</p>` : '';
    const readerHtml = n.readerNote ? `<p class="note-note reader"><span>读者注</span>${esc(summary(n.readerNote))}</p>` : '';
    const aiHtml = n.aiNote ? `<p class="note-note ai"><span>AI注</span>${esc(summary(n.aiNote))}</p>` : '';
    const tagHtml = Array.isArray(n.tags) && n.tags.length
      ? `<div class="note-tags">${n.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : '';
    const conceptHtml = Array.isArray(n.concepts) && n.concepts.length
      ? `<div class="note-tags note-concepts">${n.concepts.map((c) => {
        const id = typeof c === 'string' ? c : c?.id;
        return id ? `<span class="tag concept">${esc(conceptName(id))}</span>` : '';
      }).join('')}</div>` : '';
    card.innerHTML = `
      ${thumb}
      <div class="note-body">
        ${metaLine}
        <h3 class="note-title">${esc(n.title || '未命名')}</h3>
        ${contentHtml}${readerHtml}${aiHtml}${tagHtml}${conceptHtml}
      </div>
      <div class="note-actions">
        <button class="btn ghost small" data-act="edit">编辑</button>
        <button class="btn ghost small danger" data-act="del">删除</button>
      </div>`;
    card.dataset.id = n.id;
    card.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        e.stopPropagation();
        if (btn.dataset.act === 'edit') {
          location.href = `editor.html?id=${encodeURIComponent(n.id)}&ret=${encodeURIComponent(currentReturnUrl())}`;
        } else if (btn.dataset.act === 'del') {
          if (confirm(`删除「${n.title || '未命名'}」？`)) {
            await deleteNote(n.id);
            await refresh();
            toast('已删除');
          }
        }
        return;
      }
      location.href = `note.html?id=${encodeURIComponent(n.id)}`;
    });
    listEl.appendChild(card);
  }
  $('empty-state').hidden = notes.length > 0;
}

function matchesQuery(n) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  const fields = [n.title, n.content, n.readerNote, n.aiNote, n.project,
    ...(Array.isArray(n.tags) ? n.tags : []),
    ...(Array.isArray(n.concepts) ? n.concepts.flatMap((c) => {
      const id = typeof c === 'string' ? c : c?.id;
      return id ? [id, conceptName(id)] : [];
    }) : [])];
  return fields.some((f) => String(f ?? '').toLowerCase().includes(q));
}

function visibleNotes() {
  let list = notesCache.filter((n) => !typeFilter || String(n.type || 'note') === typeFilter);
  list = list.filter(matchesQuery);
  const f = listFilters;
  if (f.project) list = list.filter((n) => String(n.project || '') === f.project);
  if (f.book) list = list.filter((n) => String(n.book || '') === f.book);
  if (f.dateFrom) list = list.filter((n) => String(n.date || '') >= f.dateFrom);
  if (f.dateTo) list = list.filter((n) => String(n.date || '') <= f.dateTo);
  if (f.tag) list = list.filter((n) => Array.isArray(n.tags) && n.tags.includes(f.tag));
  if (f.concept) list = list.filter((n) => Array.isArray(n.concepts)
    && n.concepts.some((c) => (typeof c === 'string' ? c : c?.id) === f.concept));
  return list;
}

function applySearch() {
  const list = visibleNotes();
  const q = searchQuery.trim();
  $('record-count').textContent = q
    ? `匹配 ${list.length} / 共 ${notesCache.length} 条`
    : `${notesCache.length} 条`;
  renderList(list);
  const searching = list.length === 0 && q.length > 0;
  $('empty-title').textContent = searching ? '没有匹配的记录' : `还没有${currentType.label}`;
  $('empty-hint').textContent = searching
    ? `未找到包含「${q}」的${currentType.label}，换个关键词试试。`
    : '点击下方按钮进入独立编辑页。';
  $('empty-new-btn').hidden = searching;
}

async function refresh() {
  notesCache = await getAllNotes(currentType.pseudo ? '' : currentType.key);
  applySearch();
}

function readFilters() {
  listFilters = {
    project: $('filter-project').value || '',
    book: $('filter-book').value || '',
    dateFrom: $('filter-from').value || '',
    dateTo: $('filter-to').value || '',
    tag: listFilters.tag || '',
    concept: listFilters.concept || '',
  };
  renderTagFilterChips();
  applySearch();
}

function renderTagFilterChips() {
  let host = $('filter-bar').querySelector('.filter-tag-chips');
  if (!listFilters.tag && !listFilters.concept) { if (host) host.remove(); return; }
  if (!host) {
    host = document.createElement('div');
    host.className = 'filter-tag-chips';
    $('filter-bar').appendChild(host);
  }
  const parts = [];
  if (listFilters.tag) parts.push(`<span class="btn ghost small tag-chip" data-kind="tag">🏷️ #${esc(listFilters.tag)} <button type="button" class="chip-x" data-kind="tag" aria-label="清除标签过滤">×</button></span>`);
  if (listFilters.concept) parts.push(`<span class="btn ghost small tag-chip" data-kind="concept">💡 ${esc(conceptName(listFilters.concept))} <button type="button" class="chip-x" data-kind="concept" aria-label="清除概念过滤">×</button></span>`);
  host.innerHTML = parts.join('');
}

function applyQuickFilter(kind) {
  const today = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  if (kind === 'month') { $('filter-from').value = `${iso.slice(0, 8)}01`; $('filter-to').value = iso; }
  else if (kind === 'year') { $('filter-from').value = `${iso.slice(0, 4)}-01-01`; $('filter-to').value = iso; }
  else { $('filter-from').value = ''; $('filter-to').value = ''; }
  readFilters();
}

async function initFilterBar() {
  const projects = await getAllProjects();
  $('filter-project').innerHTML = '<option value="">全部文件夹</option>' +
    projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  const books = await getAllBooks();
  $('filter-book').innerHTML = '<option value="">全部书名</option>' +
    books.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('');

  if (currentType.key === 'all' && !$('filter-bar').querySelector('.filter-type-chips')) {
    const chips = document.createElement('div');
    chips.className = 'filter-type-chips';
    chips.innerHTML = ['all', 'note', 'diary', 'log', 'memo']
      .map((k) => {
        const t = NoteTypes.getType(k);
        return `<button type="button" class="btn ghost small type-chip${k === 'all' ? ' active' : ''}" data-type-chip="${k}">${t ? t.icon + ' ' + esc(t.label) : k}</button>`;
      }).join('');
    $('filter-bar').appendChild(chips);
    chips.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-type-chip]');
      if (!btn) return;
      const k = btn.getAttribute('data-type-chip');
      typeFilter = k === 'all' ? '' : k;
      chips.querySelectorAll('.type-chip').forEach((b) => b.classList.toggle('active', b === btn));
      applySearch();
    });
  }
}

async function loadConceptCatalog() {
  try {
    const resp = await fetch('graph.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    conceptCatalog = (data.concepts || []).map((c) => ({ id: String(c.id || ''), name: String(c.name || c.id || '') })).filter((c) => c.id);
    conceptDomainNames = {};
    (data.domains || []).forEach((d) => { conceptDomainNames[String(d.id || '')] = String(d.name || d.id || ''); });
    applySearch();
  } catch (e) { /* 目录缺失时按 id 显示 */ }
}

/* ── 事件 ── */
$('new-btn').addEventListener('click', () => { location.href = newNoteHref(); });
$('empty-new-btn').addEventListener('click', () => { location.href = newNoteHref(); });
$('search-input').addEventListener('input', (e) => { searchQuery = e.target.value; applySearch(); });
$('filter-project').addEventListener('change', readFilters);
$('filter-book').addEventListener('change', readFilters);
$('filter-from').addEventListener('change', readFilters);
$('filter-to').addEventListener('change', readFilters);
$('filter-bar').addEventListener('click', (e) => {
  const quick = e.target.closest('[data-quick]');
  if (quick) { applyQuickFilter(quick.getAttribute('data-quick')); return; }
  const x = e.target.closest('.chip-x');
  if (!x) return;
  const kind = x.dataset.kind;
  if (kind === 'tag') listFilters.tag = '';
  if (kind === 'concept') listFilters.concept = '';
  const url = new URL(location.href);
  url.searchParams.delete(kind === 'tag' ? 'tag' : 'concept');
  history.replaceState(null, '', url);
  renderTagFilterChips();
  applySearch();
});

/* ── 启动 ── */
(function init() {
  // 旧 URL 兼容：旧编辑/新建链接 → 独立编辑页；其他旧列表 URL → 笔记目录
  if (key !== 'all') {
    if (params.get('edit')) {
      const ret = encodeURIComponent(`note.html?id=${encodeURIComponent(params.get('edit'))}`);
      location.replace(`editor.html?id=${encodeURIComponent(params.get('edit'))}&ret=${ret}`);
    } else if (params.get('new')) {
      const project = params.get('project') || 'other';
      const ret = encodeURIComponent('folders.html');
      location.replace(`editor.html?type=${encodeURIComponent(key || 'note')}&project=${encodeURIComponent(project)}&ret=${ret}`);
    } else {
      location.replace('folders.html');
    }
    return;
  }
  renderHeader();
  mountDataActions({ onChange: refresh, getCurrentType: () => currentType });
  initFilterBar();
  renderTagFilterChips();
  refresh();
  loadConceptCatalog();
})();
