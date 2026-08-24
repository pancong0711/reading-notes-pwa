/**
 * data.js —— 读书笔记 PWA 数据层
 *
 * 基于 IndexedDB 的本地存储：
 *   数据库：reading-notes
 *   对象仓库：notes（主键 id，附 book / date 索引）、books（主键 name）
 *   单条记录：{ id, title, book, author, date, tags, rating, pages,
 *              content, images, readerNote, aiNote, imageData, concepts }
 *     - readerNote：读者注（读者自己的思考）
 *     - aiNote：AI注（与 AI 咨询的内容 / 应读者要求由 AI 补充的说明）
 *     - imageData：新建笔记时拍照/选图的压缩 base64 缩略图
 *     - concepts：概念级标签 [{id, source}]，source ∈ user|ai
 *   书籍元信息（books store，主键 name）：
 *     { name, author, status, rating, tags, summary, cover, started, finished }
 *
 * 对外提供：
 *   importNotePackage(json)  —— 清空重建，导入整包（接受 { notes, books } / { notes } / 裸数组）
 *   exportNotePackage()      —— 导出 { notes: [...], books: [...], exportedAt }
 *   getAllNotes()            —— 读取全部笔记（按 date 降序，无日期排最后）
 *   countNotes()             —— 笔记总数
 *   addNote(note)            —— 新增/更新单条笔记（返回 id）
 *   deleteNote(id)           —— 删除单条笔记
 *   saveBooks(list)          —— 清空 books store 后批量写入（单事务，全量替换）
 *   saveBook(meta)           —— 单本 upsert：合并现有记录后按 name 写入（只覆盖传入字段）
 *   getAllBooksRaw()         —— 读取全部书籍元信息，按 name 排序
 *   getAllBooks()            —— 聚合书架：笔记书名集合 × books meta，返回带统计的数组
 *
 * importNotePackage / exportNotePackage 同时挂到 window，
 * 便于页面与浏览器控制台直接调用。
 */

const DB_NAME = 'reading-notes';
const DB_VERSION = 3;   // v2：增加 type 索引（与 diary.js 统一 schema）；v3：增加 books store（keyPath: name）
const STORE = 'notes';
const BOOKS_STORE = 'books';

let _dbPromise = null;
let _noteSeq = 0;   // 本地新记录 id 递增序号，避免同一毫秒内并发/连续新增时 id 冲突

/** 打开数据库（单例，重复调用复用同一个连接） */
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持 IndexedDB，无法本地存储'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('book', 'book', { unique: false });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      } else {
        // 仓库已存在（可能由 diary.js 先建）：补齐缺失索引，避免两套封装 schema 冲突
        const st = event.target.transaction.objectStore(STORE);
        if (!st.indexNames.contains('book')) {
          st.createIndex('book', 'book', { unique: false });
        }
        if (!st.indexNames.contains('date')) {
          st.createIndex('date', 'date', { unique: false });
        }
        if (!st.indexNames.contains('type')) {
          st.createIndex('type', 'type', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(BOOKS_STORE)) {
        db.createObjectStore(BOOKS_STORE, { keyPath: 'name' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return _dbPromise;
}

/** 规整自由标签：去空白、去重、过滤图片路径/文件名噪音 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const v = t.trim();
    if (!v) continue;
    if (/(^|[\\/])assets[\\/]/i.test(v) || /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(v) || /^img_\w+\.\w+$/i.test(v)) {
      continue;
    }
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** 规整概念标签：兼容字符串列表或 {id, source} 对象列表 */
function normalizeConcepts(concepts) {
  if (!Array.isArray(concepts)) return [];
  const out = [];
  const seen = new Set();
  for (const c of concepts) {
    let id = '';
    let source = 'user';
    if (typeof c === 'string') {
      id = c.trim();
    } else if (c && typeof c === 'object') {
      id = String(c.id || '').trim();
      source = String(c.source || 'user').trim() || 'user';
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, source });
  }
  return out;
}

/** 规整单条笔记：补全缺省字段、统一字段类型、保留 type（默认 note） */
function normalizeNote(raw, index) {
  const id = raw.id != null ? String(raw.id) : `note-${Date.now()}-${++_noteSeq}`;
  return {
    id,
    type: raw.type || 'note',        // 记录类型：note（阅读笔记）/ diary（日记）/ 自定义
    title: raw.title || '未命名笔记',
    book: raw.book || '',
    author: raw.author || '',
    date: raw.date || '',
    tags: normalizeTags(raw.tags),
    rating: raw.rating == null ? null : Number(raw.rating),
    pages: raw.pages || '',
    content: raw.content || '',
    images: Array.isArray(raw.images)
      ? raw.images.filter((i) => typeof i === 'string')
      : [],
    readerNote: raw.readerNote || '',
    aiNote: raw.aiNote || '',
    imageData: raw.imageData || '',
    quotes: Array.isArray(raw.quotes) ? raw.quotes : [],
    characters: raw.characters && typeof raw.characters === 'object' ? raw.characters : {},
    extension: raw.extension || '',
    concepts: normalizeConcepts(raw.concepts),
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},   // 类型特有字段（memo: done/due 等）
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now(),
  };
}

/** 在单次事务里清空并重建仓库（导入即全量替换） */
async function replaceAll(notes) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    for (const note of notes) store.put(note);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 规整单条书籍元信息：补全缺省字段（无 meta 时以空串/0/null 兜底） */
function normalizeBook(raw, index) {
  const name = raw && raw.name != null ? String(raw.name).trim() : '';
  if (!name) return null;   // 无书名的记录丢弃
  return {
    name,
    author: raw.author || '',
    status: raw.status || '',
    rating: raw.rating == null ? 0 : Number(raw.rating),
    tags: normalizeTags(raw.tags),
    summary: raw.summary || '',
    cover: raw.cover || '',
    started: raw.started || null,
    finished: raw.finished || null,
  };
}

/**
 * 清空 books store 后批量写入（单事务，全量替换）。
 * @param {Array} list  书籍元信息数组 [{name, author, status, ...}]
 * @returns {Promise<number>} 写入的书籍数量
 */
export async function saveBooks(list) {
  const books = (Array.isArray(list) ? list : [])
    .map((raw, i) => normalizeBook(raw, i))
    .filter(Boolean);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS_STORE, 'readwrite');
    const store = tx.objectStore(BOOKS_STORE);
    store.clear();
    for (const book of books) store.put(book);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return books.length;
}

/** 读取全部书籍元信息，按 name 排序（本地化比较） */
export async function getAllBooksRaw() {
  const db = await openDB();
  const books = await new Promise((resolve, reject) => {
    const request = db.transaction(BOOKS_STORE, 'readonly').objectStore(BOOKS_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  books.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return books;
}

/**
 * 单本 upsert：先读 books store 中现有记录，合并传入字段后按 name 写入。
 * 只覆盖传入字段 + name，未提交的字段（author/tags/cover/started 等）保持不变。
 * @param {object} meta  { name, status?, rating?, summary?, ... }；name 必填，缺失抛错
 * @returns {Promise<object>} 保存后的完整记录（合并结果）
 */
export async function saveBook(meta) {
  if (!meta || meta.name == null || String(meta.name).trim() === '') {
    throw new Error('saveBook: name 缺失，无法保存书籍信息');
  }
  const name = String(meta.name).trim();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS_STORE, 'readwrite');
    const store = tx.objectStore(BOOKS_STORE);
    let merged = null;
    const req = store.get(name);
    req.onsuccess = () => {
      merged = { ...(req.result || {}), ...meta, name };
      store.put(merged);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(merged);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * 聚合书架：读全部笔记（type 非 diary 的）聚合书名集合，与 books store 的 meta 合并。
 * @returns {Promise<Array<{name, author, status, rating, tags, summary, cover,
 *           started, finished, notes_count, first_date, last_date}>>}
 *           按 notes_count 降序（同 count 按 name）
 */
export async function getAllBooks() {
  const [allNotes, metaList] = await Promise.all([getAllNotes(), getAllBooksRaw()]);
  // 聚合：仅统计 type 非 diary 的笔记，book 字段非空去重
  const byBook = new Map();
  for (const n of allNotes) {
    if ((n.type || 'note') === 'diary') continue;
    const name = typeof n.book === 'string' ? n.book.trim() : '';
    if (!name) continue;
    let agg = byBook.get(name);
    if (!agg) {
      agg = { count: 0, dates: [] };
      byBook.set(name, agg);
    }
    agg.count++;
    if (n.date) agg.dates.push(String(n.date));
  }
  const metaByName = new Map(metaList.map((m) => [m.name, m]));
  const result = [];
  for (const [name, agg] of byBook) {
    const meta = metaByName.get(name) || {};
    const dates = agg.dates.slice().sort();
    result.push({
      name,
      author: meta.author || '',
      status: meta.status || '',
      rating: meta.rating == null ? 0 : Number(meta.rating),
      tags: normalizeTags(meta.tags),
      summary: meta.summary || '',
      cover: meta.cover || '',
      started: meta.started || null,
      finished: meta.finished || null,
      notes_count: agg.count,
      first_date: dates.length ? dates[0] : '',
      last_date: dates.length ? dates[dates.length - 1] : '',
    });
  }
  result.sort((a, b) => b.notes_count - a.notes_count || a.name.localeCompare(b.name));
  return result;
}

/** 汇总全部本地记录的自由标签及出现次数 */
export async function getAllTags() {
  const all = await getAllNotes();
  const counts = new Map();
  for (const n of all) {
    if (!Array.isArray(n.tags)) continue;
    for (const t of n.tags) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * 批量重命名/合并标签：把所有记录中的 oldTag 改为 newTag。
 * @returns {Promise<number>} 被更新的记录数
 */
export async function renameTag(oldTag, newTag) {
  const target = String(newTag || '').trim();
  if (!target) throw new Error('新标签不能为空');
  if (oldTag === target) return 0;
  const all = await getAllNotes();
  let changed = 0;
  for (const n of all) {
    if (!Array.isArray(n.tags) || !n.tags.includes(oldTag)) continue;
    const tags = normalizeTags(n.tags.map((t) => (t === oldTag ? target : t)));
    await addNote({ ...n, tags, updatedAt: Date.now() });
    changed++;
  }
  return changed;
}

/** 批量删除标签：从所有本地记录移除指定标签 */
export async function deleteTag(tag) {
  const all = await getAllNotes();
  let changed = 0;
  for (const n of all) {
    if (!Array.isArray(n.tags) || !n.tags.includes(tag)) continue;
    const tags = normalizeTags(n.tags.filter((t) => t !== tag));
    await addNote({ ...n, tags, updatedAt: Date.now() });
    changed++;
  }
  return changed;
}

/**
 * 导入笔记包：清空重建。
 * @param {object|Array} json  { notes: [...], books: [...] } / { notes: [...] } / 直接传笔记数组
 * @returns {Promise<number>}  导入的笔记数量
 */
export async function importNotePackage(json) {
  const list = Array.isArray(json)
    ? json
    : json && Array.isArray(json.notes)
      ? json.notes
      : [];
  const notes = list.map((raw, i) => normalizeNote(raw, i));
  await replaceAll(notes);
  if (json && !Array.isArray(json) && Array.isArray(json.books)) {
    await saveBooks(json.books);
  }
  return notes.length;
}

/* ── 导入差异对比 / 合并（多终端合并契约 v2）────────────── */

/** id 匹配键（无 id 返回空串） */
function idKey(rec) {
  const id = rec && rec.id != null ? String(rec.id).trim() : '';
  return id ? `id:${id}` : '';
}

/** 回退匹配键：type+book+title+date（旧数据无 id 时用） */
function fbKey(rec) {
  return `fb:${rec.type || 'note'}|${rec.book || ''}|${rec.title || ''}|${rec.date || ''}`;
}

/**
 * 对比导入包与本端数据（id 优先，无 id / id 未命中时回退 type+book+title+date）。
 * @returns {{added:Array, updated:Array, localNewer:Array, unchanged:number, localOnly:number}}
 *   updated = 包内较新（将用包覆盖）；localNewer = 本端较新（合并时保留本端）
 */
export async function diffNotePackage(json) {
  const list = Array.isArray(json)
    ? json
    : json && Array.isArray(json.notes) ? json.notes : [];
  const local = await getAllNotes();
  const localMap = new Map();
  for (const n of local) {
    const ik = idKey(n);
    if (ik) localMap.set(ik, n);
    localMap.set(fbKey(n), n);
  }
  const fallbackTs = json && json.exportedAt ? new Date(json.exportedAt).getTime() : 0;
  const diff = { added: [], updated: [], localNewer: [], unchanged: 0, localOnly: 0 };
  const pkgIdKeys = new Set();
  const pkgFbKeys = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const ik = idKey(item);
    if (ik) pkgIdKeys.add(ik);
    const fk = fbKey(item);
    pkgFbKeys.add(fk);
    let localRec = ik ? localMap.get(ik) : undefined;
    if (!localRec) localRec = localMap.get(fk);   // 无 id 或 id 未命中 → 回退
    const pkgTs = Number(item.updatedAt) || fallbackTs;
    if (!localRec) { diff.added.push(item); continue; }
    const localTs = Number(localRec.updatedAt) || 0;
    if (pkgTs > localTs) diff.updated.push(item);
    else if (pkgTs < localTs) diff.localNewer.push(item);
    else diff.unchanged += 1;
  }
  for (const n of local) {
    const ik = idKey(n);
    const matched = (ik && pkgIdKeys.has(ik)) || pkgFbKeys.has(fbKey(n));
    if (!matched) diff.localOnly += 1;
  }
  return diff;
}

/**
 * 按策略应用导入包。策略：merge=智能合并（新增+包内较新覆盖，本端较新保留）
 * / new=仅新增 / replace=完整替换。books 一律按包覆盖。
 * @returns {Promise<{applied:number, diff:object}>}
 */
export async function mergeNotePackage(json, strategy) {
  const list = Array.isArray(json)
    ? json
    : json && Array.isArray(json.notes) ? json.notes : [];
  const diff = await diffNotePackage(json);
  let applied = 0;
  if (strategy === 'replace') {
    const notes = list.map((raw, i) => normalizeNote(raw, i));
    await replaceAll(notes);
    applied = notes.length;
  } else {
    const items = strategy === 'new'
      ? diff.added
      : diff.added.concat(diff.updated);
    for (const item of items) {
      await addNote(normalizeNote(item, 0));
      applied += 1;
    }
  }
  if (json && !Array.isArray(json) && Array.isArray(json.books)) {
    await saveBooks(json.books);
  }
  return { applied, diff };
}

/**
 * 导出笔记包（含书籍元信息，往返一致）。
 * @returns {Promise<{notes: Array, books: Array, exportedAt: string, schemaVersion: number}>}
 */
export async function exportNotePackage() {
  const [notes, books] = await Promise.all([getAllNotes(), getAllBooksRaw()]);
  return { notes, books, exportedAt: new Date().toISOString(), schemaVersion: 2 };
}

/**
 * 读取全部记录，按 date 降序排列（无日期记录排最后）。
 * @param {string} [type]  按类型过滤：'note' / 'diary' / 自定义；缺省返回全部
 */
export async function getAllNotes(type) {
  const db = await openDB();
  const notes = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  const filtered = type ? notes.filter((n) => (n.type || 'note') === type) : notes;
  filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return filtered;
}

/** 笔记总数 */
export async function countNotes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 新增/更新单条笔记（按 id 覆盖）。
 * 典型用法：{ title, book, date, readerNote, aiNote, imageData }
 * @returns {Promise<string>} 笔记 id
 */
export async function addNote(note) {
  const rec = normalizeNote(note, 0);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return rec.id;
}

/** 删除单条笔记 */
export async function deleteNote(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(String(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* 挂到 window，便于页面与控制台调用 */
window.importNotePackage = importNotePackage;
window.exportNotePackage = exportNotePackage;
window.diffNotePackage = diffNotePackage;
window.mergeNotePackage = mergeNotePackage;
window.saveBooks = saveBooks;
window.saveBook = saveBook;
window.getAllBooks = getAllBooks;
window.getAllBooksRaw = getAllBooksRaw;
window.getAllTags = getAllTags;
window.renameTag = renameTag;
window.deleteTag = deleteTag;
