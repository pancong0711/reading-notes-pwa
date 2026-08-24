/* book.js —— 书架页 + 书详情页（ES Module）
 *
 * 两个视图：
 *   1. 书架（#book-list）：调用 getAllBooks() 渲染书卡片（书名/状态徽章/笔记数/作者/评分/读后感摘要）
 *   2. 书详情（#book-detail）：点击卡片进入——顶部书元信息（书名/作者/状态/起止日期/评分/读后感全文/封面），
 *      下方该书笔记列表：getAllNotes() 后 filter(book === 当前书)，按 YYYY-MM 分组
 *
 * URL 定位：?book=<encodeURIComponent(书名)> 直达书详情；返回书架时清除参数。
 * 接口依赖（并行任务 C 提供）：getAllBooks() / getAllNotes()（来自 data.js）
 */
import { getAllBooks, getAllNotes, saveBook } from './data.js';

const $ = (id) => document.getElementById(id);

const els = {
  nav: $('main-nav'),
  bookList: $('book-list'),
  bookDetail: $('book-detail'),
  bookCards: $('book-cards'),
  bookEmpty: $('book-empty'),
  bookCount: $('book-count'),
  backBtn: $('back-btn'),
  cover: $('detail-cover'),
  name: $('detail-name'),
  author: $('detail-author'),
  status: $('detail-status'),
  dates: $('detail-dates'),
  rating: $('detail-rating'),
  summary: $('detail-summary'),
  notes: $('detail-notes'),
  toast: $('toast'),
};

let booksCache = [];   // getAllBooks() 结果缓存
let notesCache = [];   // getAllNotes() 结果缓存
let currentBook = null;   // 当前打开的书详情对象（供编辑表单引用）
let toastTimer = null;

/* ── 工具 ── */
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function summary(text, len = 80) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  return t.length > len ? `${t.slice(0, len)}…` : t;
}

/* 状态徽章：在读/读完/暂停 → 对应配色类；兼容中英文存储值；未知状态原样显示 */
const STATUS_LABELS = { reading: '在读', finished: '读完', paused: '暂停' };
const STATUS_CLASSES = { '在读': 'reading', '读完': 'finished', '暂停': 'paused' };

function statusBadge(status) {
  const s = String(status || '').trim();
  if (!s) return '';
  const label = STATUS_LABELS[s] || s;   // 英文值（reading/…）→ 中文显示
  const cls = STATUS_CLASSES[label] || 'other';
  return `<span class="book-status ${cls}">${esc(label)}</span>`;
}

function ratingText(rating) {
  if (rating == null || rating === '') return '';
  return `★ ${rating}`;
}

/* ── 书架视图 ── */
function renderShelf(books) {
  els.bookCards.innerHTML = '';
  els.bookEmpty.hidden = books.length > 0;
  els.bookCount.textContent = books.length ? `共 ${books.length} 本书` : '';

  for (const b of books) {
    const card = document.createElement('article');
    card.className = 'book-card';
    card.dataset.name = b.name;

    const rating = ratingText(b.rating);
    const summaryHtml = b.summary
      ? `<p class="book-card-summary">${esc(summary(b.summary, 120))}</p>`
      : '';

    card.innerHTML = `
      <div class="book-card-head">
        <h3 class="book-card-name">${esc(b.name || '未命名')}</h3>
        ${statusBadge(b.status)}
      </div>
      <div class="book-card-meta">
        <span class="book-card-author">${esc(b.author || '佚名')}</span>
        ${rating ? `<span class="book-card-rating">${esc(rating)}</span>` : ''}
        <span class="book-card-count">${Number(b.notes_count) || 0} 篇笔记</span>
      </div>
      ${summaryHtml}
    `;
    card.addEventListener('click', () => openBook(b.name));
    els.bookCards.appendChild(card);
  }
}

/* ── 书详情视图 ── */

/** 按 YYYY-MM 分组渲染该书笔记（getAllNotes 已按 date 降序，组内保持该顺序） */
function renderBookNotes(bookName) {
  els.notes.innerHTML = '';
  const mine = notesCache.filter((n) => n.book === bookName);

  if (!mine.length) {
    els.notes.innerHTML = '<p class="muted">这本书还没有笔记，去「阅读笔记」页写第一篇吧。</p>';
    return;
  }

  const groups = new Map();   // YYYY-MM → [notes]
  for (const n of mine) {
    const key = (n.date || '').slice(0, 7) || '未标注日期';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }

  for (const [month, list] of groups) {
    const section = document.createElement('section');
    section.className = 'book-note-group';

    const head = document.createElement('h2');
    head.className = 'book-note-month';
    head.textContent = month;
    section.appendChild(head);

    for (const n of list) {
      const item = document.createElement('article');
      item.className = 'book-note-item';

      const contentHtml = n.content
        ? `<p class="note-note content">${esc(summary(n.content))}</p>` : '';
      const readerHtml = n.readerNote
        ? `<p class="note-note reader"><span>读者注</span>${esc(summary(n.readerNote))}</p>` : '';

      item.innerHTML = `
        <div class="book-note-meta">${esc(n.date || '无日期')}</div>
        <h3 class="book-note-title">${esc(n.title || '未命名笔记')}</h3>
        ${contentHtml}
        ${readerHtml}
      `;
      section.appendChild(item);
    }
    els.notes.appendChild(section);
  }
}

function renderDetail(book) {
  els.name.textContent = book.name || '未命名';
  els.author.textContent = book.author ? `作者：${book.author}` : '';

  const badge = statusBadge(book.status);
  els.status.innerHTML = badge;

  const dates = [];
  if (book.started) dates.push(`开始 ${book.started}`);
  if (book.finished) dates.push(`读完 ${book.finished}`);
  els.dates.textContent = dates.length ? dates.join(' · ') : '';

  const rating = ratingText(book.rating);
  els.rating.textContent = rating ? `评分：${rating}` : '';

  els.summary.textContent = book.summary || '';

  if (book.cover) {
    els.cover.src = book.cover;
    els.cover.hidden = false;
  } else {
    els.cover.removeAttribute('src');
    els.cover.hidden = true;
  }

  // 编辑按钮仅当书名为非空时显示；切换书时收起表单
  if (editUI) {
    editUI.toggle.hidden = !(book.name || '').trim();
    editUI.form.hidden = true;
    editUI.toggle.textContent = '✎ 编辑';
  }

  renderBookNotes(book.name);
}

/* ── 编辑书信息（✎ 编辑 → 内联表单 → saveBook） ── */

// select 回填兼容中英文存储值；保存时统一写英文值（reading/finished/paused）
const STATUS_SELECT_MAP = {
  reading: 'reading', '在读': 'reading',
  finished: 'finished', '读完': 'finished',
  paused: 'paused', '暂停': 'paused',
};

let editUI = null;   // 动态构建的编辑区元素引用

/** 构建「✎ 编辑」按钮 + 内联表单，挂在书详情信息区（summary 之后） */
function buildEditUI() {
  const zone = document.createElement('div');
  zone.className = 'book-edit-zone';
  zone.innerHTML = `
    <button class="btn ghost book-edit-toggle" type="button">✎ 编辑</button>
    <form class="book-edit-form" hidden>
      <div class="book-edit-field">
        <label for="book-edit-status">状态</label>
        <select id="book-edit-status">
          <option value="">未标记</option>
          <option value="reading">在读</option>
          <option value="finished">读完</option>
          <option value="paused">暂停</option>
        </select>
      </div>
      <div class="book-edit-field">
        <label for="book-edit-rating">评分（0–5）</label>
        <input id="book-edit-rating" type="number" min="0" max="5" step="0.5" placeholder="0–5">
      </div>
      <div class="book-edit-field">
        <label for="book-edit-summary">读后总结</label>
        <textarea id="book-edit-summary" rows="4" placeholder="读完这本书后的收获与感想…"></textarea>
      </div>
      <div class="book-edit-actions">
        <button class="btn" type="submit">保存</button>
        <button class="btn ghost" type="button" id="book-edit-cancel">取消</button>
      </div>
    </form>
  `;

  editUI = {
    zone,
    toggle: zone.querySelector('.book-edit-toggle'),
    form: zone.querySelector('.book-edit-form'),
    status: zone.querySelector('#book-edit-status'),
    rating: zone.querySelector('#book-edit-rating'),
    summary: zone.querySelector('#book-edit-summary'),
  };
  editUI.toggle.addEventListener('click', () => {
    if (editUI.form.hidden) openEditForm(currentBook);
    else closeEditForm();
  });
  zone.querySelector('#book-edit-cancel').addEventListener('click', closeEditForm);
  editUI.form.addEventListener('submit', onEditSubmit);

  els.summary.insertAdjacentElement('afterend', zone);
}

/** 打开表单：用当前书的现有值回填（状态中英文值均可） */
function openEditForm(book) {
  if (!book) return;
  editUI.status.value = STATUS_SELECT_MAP[String(book.status || '').trim()] || '';
  editUI.rating.value = book.rating == null || book.rating === '' ? '' : book.rating;
  editUI.summary.value = book.summary || '';
  editUI.form.hidden = false;
  editUI.toggle.textContent = '收起';
  editUI.summary.focus();
}

function closeEditForm() {
  if (!editUI) return;
  editUI.form.hidden = true;
  editUI.toggle.textContent = '✎ 编辑';
}

/** 保存：只提交表单三个字段 + name，saveBook 内部与现有记录合并，不覆盖其它字段 */
async function onEditSubmit(event) {
  event.preventDefault();
  const status = editUI.status.value;                     // '' | reading | finished | paused
  const ratingRaw = String(editUI.rating.value).trim();
  try {
    const saved = await saveBook({
      name: currentBook.name,
      status,
      rating: ratingRaw === '' ? 0 : Number(ratingRaw),
      summary: editUI.summary.value.trim(),
    });
    // 合并进缓存并重新渲染：书架卡片 + 书详情（statusBadge/summary 立即更新）
    booksCache = booksCache.map((b) => (b.name === currentBook.name ? { ...b, ...saved } : b));
    currentBook = booksCache.find((b) => b.name === currentBook.name);
    renderShelf(booksCache);
    renderDetail(currentBook);
    closeEditForm();
    toast('已保存，导出 JSON 后可用 CLI import-json 回流');
  } catch (err) {
    toast(`保存失败：${err.message}`, 4200);
  }
}

/* ── 视图切换与 URL 定位 ── */
function showShelf() {
  els.bookDetail.hidden = true;
  els.bookList.hidden = false;
  // 返回书架时清除 ?book 参数
  const url = new URL(location.href);
  if (url.searchParams.has('book')) {
    url.searchParams.delete('book');
    history.replaceState(null, '', url.pathname + url.search);
  }
  window.scrollTo(0, 0);
}

function showDetail() {
  els.bookList.hidden = true;
  els.bookDetail.hidden = false;
  window.scrollTo(0, 0);
}

function openBook(name) {
  const book = booksCache.find((b) => b.name === name);
  if (!book) {
    toast(`未找到书籍「${name}」`, 3600);
    showShelf();
    return;
  }
  currentBook = book;
  renderDetail(book);
  // 同步 URL，便于刷新后直达 / 分享定位
  const url = new URL(location.href);
  url.searchParams.set('book', name);
  history.replaceState(null, '', url.pathname + url.search);
  showDetail();
}

/* ── 初始化 ── */
async function init() {
  els.nav.innerHTML = NoteTypes.renderNav('book');
  els.backBtn.addEventListener('click', showShelf);
  buildEditUI();   // 书详情信息区挂「✎ 编辑」按钮 + 内联表单

  try {
    const [books, notes] = await Promise.all([getAllBooks(), getAllNotes()]);
    booksCache = books;
    notesCache = notes;
  } catch (err) {
    toast(`数据加载失败：${err.message}`, 4200);
    return;
  }

  renderShelf(booksCache);

  // URL 直达：?book=<书名>
  const target = new URL(location.href).searchParams.get('book');
  if (target) openBook(target);
}

init();
