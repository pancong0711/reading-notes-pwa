/* types.js —— 记录类型注册表（普通 script，无依赖，file:// 兼容）
 *
 * 内置 4 类，用户可自定义增删改；自定义类型持久化在 localStorage('note-types')。
 *
 * 统一记录模型（所有类型同一结构，type 字段区分）：
 *   { id, type, title, date, createdAt, updatedAt,
 *     content, readerNote, aiNote, images, imageData, meta }
 *   - type 来自本注册表（key）
 *   - fields 控制该类型编辑表单显示哪些附加字段：
 *       book/pages → 顶层字段（阅读笔记）；done/due → meta（备忘）
 *
 * 页面导航也从注册表动态渲染，不再硬编码「笔记/日记」两个入口。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'note-types';

  /* 内置类型：不可删除，可改显示名/图标（改后存自定义覆盖层） */
  var BUILTIN = [
    { key: 'note',  label: '阅读笔记', icon: '📖', fields: ['book', 'pages'], builtin: true,
      hint: '拍书页 + 读者注 + AI注' },
    { key: 'diary', label: '日记',     icon: '📓', fields: [], builtin: true,
      hint: '同一天可写多篇' },
    { key: 'log',   label: '日志',     icon: '📋', fields: [], builtin: true,
      hint: '流水记录' },
    { key: 'memo',  label: '备忘',     icon: '✅', fields: ['done', 'due'], builtin: true,
      hint: '待办事项，可勾选完成' },
  ];

  /* 附加字段的元信息（编辑表单渲染用） */
  var FIELD_META = {
    book:    { label: '书名',     type: 'text',     placeholder: '如：如何测量万物' },
    pages:   { label: '页码',     type: 'text',     placeholder: '如：1-30' },
    done:    { label: '已完成',   type: 'checkbox' },
    due:     { label: '截止日期', type: 'date' },
  };

  /* ── 自定义类型持久化（仅存自定义，内置不落盘） ── */

  function loadCustom() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return [];
    }
  }

  function saveCustom(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function normalizeCustom(t) {
    return {
      key: String(t.key || '').trim().toLowerCase().replace(/\s+/g, '-'),
      label: String(t.label || '').trim() || '未命名',
      icon: t.icon || '📝',
      fields: Array.isArray(t.fields)
        ? t.fields.filter(function (f) { return FIELD_META[f]; })
        : [],
      builtin: false,
      hint: t.hint || '',
    };
  }

  /* ── 查询 ── */

  /** 全部类型：内置（按定义顺序）+ 自定义（追加在后） */
  function getTypes() {
    return BUILTIN.concat(loadCustom());
  }

  function getType(key) {
    var all = getTypes();
    for (var i = 0; i < all.length; i++) {
      if (all[i].key === key) return all[i];
    }
    return null;
  }

  /* ── 增删改 ── */

  function validKey(key) {
    return /^[a-z0-9-]{1,24}$/.test(key);
  }

  function addType(t) {
    var nt = normalizeCustom(t);
    if (!validKey(nt.key)) {
      throw new Error('类型 key 仅支持小写字母/数字/连字符（≤24 字符）');
    }
    if (getType(nt.key)) throw new Error('类型「' + nt.key + '」已存在');
    var list = loadCustom();
    list.push(nt);
    saveCustom(list);
    return nt;
  }

  /** 修改自定义类型；内置类型不可改（改显示名请用 renameLabel） */
  function updateType(key, patch) {
    var list = loadCustom();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) { idx = i; break; }
    }
    if (idx < 0) throw new Error('自定义类型「' + key + '」不存在');
    var merged = normalizeCustom(Object.assign({}, list[idx], patch));
    if (merged.key !== key && getType(merged.key)) {
      throw new Error('类型「' + merged.key + '」已存在');
    }
    list[idx] = merged;
    saveCustom(list);
    return merged;
  }

  function removeType(key) {
    saveCustom(loadCustom().filter(function (t) { return t.key !== key; }));
  }

  function fieldMeta(key) {
    return FIELD_META[key] || { label: key, type: 'text', placeholder: '' };
  }

  /* ── 导航渲染：所有页面共用（首页 + 每个类型一个入口） ── */
  function renderNav(activeKey) {
    var parts = [
      '<a href="index.html"' + (activeKey === 'index' ? ' class="active"' : '') + '>阅读足迹</a>',
      '<a href="book.html"' + (activeKey === 'book' ? ' class="active"' : '') + '>书架</a>',
      '<a href="graph.html"' + (activeKey === 'graph' ? ' class="active"' : '') + '>知识图谱</a>',
      '<a href="concepts.html"' + (activeKey === 'concepts' ? ' class="active"' : '') + '>概念管理</a>',
    ];
    getTypes().forEach(function (t) {
      parts.push(
        '<a href="type.html?t=' + encodeURIComponent(t.key) + '"' +
          (t.key === activeKey ? ' class="active"' : '') + '>' +
          t.icon + ' ' + t.label + '</a>'
      );
    });
    return parts.join('');
  }

  window.NoteTypes = {
    getTypes: getTypes,
    getType: getType,
    addType: addType,
    updateType: updateType,
    removeType: removeType,
    fieldMeta: fieldMeta,
    renderNav: renderNav,
  };
})();
