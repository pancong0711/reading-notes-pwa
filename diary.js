/* diary.js —— 日记模块
 * 数据层：直接使用 IndexedDB 对象仓库 notes（库名 reading-notes，版本 2），
 * 日记条目 type 固定为 "diary"，与读书笔记（type: note 等）共存但互不干扰。
 * 同一天可写多篇：每篇独立 id，不再按日期覆盖（与 CLI 端「同日追加」行为一致）。
 */
(function () {
  'use strict';

  var DB_NAME = 'reading-notes';   // 数据库名，与数据层约定一致
  var DB_VERSION = 4;              // 与 data.js 保持一致（schema 统一：v4 增加 concept_catalog store）
  var STORE = 'notes';             // 对象仓库名
  var TYPE_DIARY = 'diary';        // 日记类型标记

  /* ---------- 最小 IndexedDB 封装 ---------- */
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // 首次创建：主键 id；date 与 type 建索引，便于按日期查询与过滤
          var store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        } else {
          // 仓库已存在（可能由 data.js 先建）：补齐缺失的索引，避免两套封装 schema 冲突
          var st = req.transaction.objectStore(STORE);
          if (!st.indexNames.contains('date')) {
            st.createIndex('date', 'date', { unique: false });
          }
          if (!st.indexNames.contains('type')) {
            st.createIndex('type', 'type', { unique: false });
          }
        }
        // books 仓库（keyPath: name）：与 data.js 保持同一 schema，
        // 无论哪个模块先触发升级都要补齐，避免先建库者缺 store
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'name' });
        }
        // concept_catalog 仓库（PWA 概念管理工作副本）：与 data.js 保持同一 schema
        if (!db.objectStoreNames.contains('concept_catalog')) {
          db.createObjectStore('concept_catalog', { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /* 在事务内执行操作。
   * fn 必须返回一个 IDBRequest（put/getAll/delete 等），
   * 统一以其结果解析 Promise，避免浏览器中 IDBRequest.onsuccess
   * 初始为 null 导致的类型误判。 */
  function withStore(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var req;
        try {
          req = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        // 请求成功事件先于事务 complete 触发，据此解析即可
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  /** 按 id 查询单条（无则返回 null） */
  function findById(id) {
    return withStore('readonly', function (store) {
      return store.get(id);
    }).then(function (row) {
      return row || null;
    });
  }

  /* ---------- 对外 API ---------- */

  /**
   * 保存日记：
   *   - 传 id：更新该篇（保留原 createdAt）
   *   - 不传 id：新建一篇（同一日期可写多篇，不再覆盖）
   */
  function saveDiary(date, content, id) {
    content = (content || '').trim();
    if (!date || !content) return Promise.reject(new Error('日期与内容不能为空'));
    var now = Date.now();
    var finalize = function (existing) {
      var record = {
        id: id || genId(),
        type: TYPE_DIARY,
        date: date,
        content: content,
        createdAt: (existing && existing.createdAt) || now,
        updatedAt: now
      };
      return withStore('readwrite', function (store) {
        return store.put(record);
      });
    };
    if (id) {
      return findById(id).then(function (existing) { return finalize(existing); });
    }
    return Promise.resolve(finalize(null));
  }

  /** 列出全部日记：日期降序（新日期在前），同日按创建时间升序（最早在前） */
  function listDiaries() {
    return withStore('readonly', function (store) {
      return store.getAll();
    }).then(function (rows) {
      return (rows || [])
        .filter(function (r) { return r.type === TYPE_DIARY; })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? 1 : -1;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });
    });
  }

  /** 删除指定 id 的日记 */
  function removeDiary(id) {
    return withStore('readwrite', function (store) {
      return store.delete(id);
    });
  }

  function genId() {
    // 优先使用原生 UUID，否则退化为时间戳+随机数
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* 暴露到 window，供页面逻辑使用 */
  window.DiaryStore = {
    save: saveDiary,
    list: listDiaries,
    remove: removeDiary,
    findById: findById
  };
})();

/* ---------- 页面逻辑 ---------- */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dateInput = $('diary-date');
  var contentInput = $('diary-content');
  var listEl = $('diary-list');
  var countEl = $('diary-count');
  var toastEl = $('toast');
  var editorTitleEl = $('editor-title');
  var toastTimer = null;
  var editingId = null;   // 正在编辑的日记 id（null = 写新篇）

  /* 今天日期，格式 YYYY-MM-DD（本地时区，避免 UTC 偏移） */
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* createdAt 毫秒 → HH:MM（本地时区）；无值返回空串 */
  function fmtTime(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2000);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 渲染日记列表：按日期分组，同日多篇并列展示 */
  function renderList() {
    window.DiaryStore.list().then(function (rows) {
      countEl.textContent = '(' + rows.length + ')';
      if (!rows.length) {
        listEl.innerHTML = '<div class="empty">还没有日记，从今天开始写第一篇吧 ✍️</div>';
        return;
      }
      // 按日期分组（rows 已按日期降序、同日时间升序排列）
      var groups = {};
      rows.forEach(function (r) {
        (groups[r.date] = groups[r.date] || []).push(r);
      });
      var html = Object.keys(groups).map(function (d) {
        var items = groups[d].map(function (r) {
          var time = fmtTime(r.createdAt);
          return (
            '<div class="entry-sub">' +
              '<p class="entry-content">' + escapeHtml(r.content) + '</p>' +
              '<div class="entry-actions">' +
                '<span class="entry-time">' + escapeHtml(time) + '</span>' +
                '<button class="btn-ghost btn-small" data-action="edit" data-id="' + r.id + '">编辑</button>' +
                '<button class="btn-danger btn-small" data-action="delete" data-id="' + r.id + '">删除</button>' +
              '</div>' +
            '</div>'
          );
        }).join('');
        return (
          '<article class="entry">' +
            '<div class="entry-head"><span class="entry-date">' + escapeHtml(d) + '</span></div>' +
            items +
          '</article>'
        );
      }).join('');
      listEl.innerHTML = html;
    }).catch(function (err) {
      showToast('加载失败：' + err.message);
    });
  }

  /* 保存（新建或更新正在编辑的篇目） */
  function handleSave() {
    var date = dateInput.value;
    var content = contentInput.value;
    window.DiaryStore.save(date, content, editingId).then(function () {
      showToast(date + ' 已保存 ✓');
      resetEditor();
      renderList();
    }).catch(function (err) {
      showToast('保存失败：' + err.message);
    });
  }

  /* 重置编辑器为「写新篇」状态 */
  function resetEditor() {
    editingId = null;
    contentInput.value = '';
    dateInput.value = todayStr();
    editorTitleEl.textContent = '写日记';
  }

  /* 列表按钮事件：编辑 / 删除 */
  listEl.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var action = btn.getAttribute('data-action');

    if (action === 'edit') {
      // 编辑：把该条内容回填到表单，保存时更新该篇（不新建）
      window.DiaryStore.findById(id).then(function (row) {
        if (!row) return;
        editingId = row.id;
        dateInput.value = row.date;
        contentInput.value = row.content;
        editorTitleEl.textContent = '编辑日记';
        dateInput.focus();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    } else if (action === 'delete') {
      if (!confirm('确定删除这篇日记吗？此操作不可恢复。')) return;
      window.DiaryStore.remove(id).then(function () {
        showToast('已删除');
        renderList();
      }).catch(function (err) {
        showToast('删除失败：' + err.message);
      });
    }
  });

  $('btn-save').addEventListener('click', handleSave);
  $('btn-reset').addEventListener('click', function () {
    resetEditor();
    dateInput.focus();
  });
  contentInput.addEventListener('keydown', function (e) {
    // Ctrl/Cmd + Enter 快捷保存
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSave();
  });

  /* 初始化：默认今天 + 渲染列表（SW 注册已统一移到 sw-register.js，由各主页面引入） */
  resetEditor();
  renderList();
})();
