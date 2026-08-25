/* 知识图谱 v3 —— 概念层主视图
 * 设计：去掉总览层（域降级为标签/图例/着色），直接显示概念层。
 *   - 节点：概念（带标签常显，半径=笔记数归一化，颜色=域色）
 *   - 边：概念↔概念 关联（线粗细 = 归一化关联强度）
 *   - 点击概念 → 详情面板：分支概念（可跳转）+ 笔记题头（可进细节）
 *   - 书过滤 / 搜索 / 域显隐（图例）保留
 */
(() => {
  'use strict';

  var svgEl = document.getElementById('graph-svg');
  var stage = document.getElementById('graph-stage');
  var loadingEl = document.getElementById('graph-loading');
  var emptyEl = document.getElementById('graph-empty');
  var countEl = document.getElementById('graph-count');
  var legendEl = document.getElementById('graph-legend');
  var panelEl = document.getElementById('graph-panel');
  var panelBody = document.getElementById('panel-body');
  var panelClose = document.getElementById('panel-close');
  var searchInput = document.getElementById('search-input');
  var bookFilterEl = document.getElementById('book-filter');
  var sourceBadgeEl = document.getElementById('graph-source-badge');
  var clearLocalBtn = document.getElementById('clear-local-btn');

  var rawData = null;
  var svg, viewport, linkG, nodeG, sim;
  var width = 960, height = 640;

  // 数据来源：'local' = IndexedDB 本机重算结果（graph_local）；'cli' = 静态 graph.json
  var dataSource = 'cli';
  var localBuiltAt = '';       // 本机结果的存档时间（generated_at 缺失时展示用）
  var dataModule = null;       // 动态 import 的 data.js（供「清空本机结果」调用）

  var domainById = {}, colorOf = {};
  var allNodes = [], allLinks = [];
  var books = [];
  var bookFilter = 'all';
  var hiddenDomains = {};
  var searchQuery = '';

  /* ══ 工具 ══ */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function domainColor(id) { return colorOf[id] || '#b8b2a6'; }
  function domainName(id) { return (domainById[id] && domainById[id].name) || id; }

  /* ══ 数据装配：graph.json → 概念节点 + 概念间边 ══ */

  function buildGraph() {
    domainById = {};
    colorOf = {};
    (rawData.domains || []).forEach(function (d) {
      domainById[d.id] = d;
      colorOf[d.id] = d.color || '#b8b2a6';
    });

    // 概念 → 笔记集合（用于按书/搜索过滤后重新计数）
    var conceptNoteMap = {};
    (rawData.concepts || []).forEach(function (c) {
      conceptNoteMap[c.id] = c.notes || [];
    });
    rawData.conceptNoteMap = conceptNoteMap;

    // 概念节点（主视图唯一节点类型）
    allNodes = [];
    (rawData.concepts || []).forEach(function (c) {
      allNodes.push({
        id: 'concept-' + c.id,
        type: 'concept',
        conceptId: c.id,
        domain: c.domain,
        name: c.name,
        note_count: c.note_count || 0,
        related: c.related || [],
        notes: c.notes || [],
        x: undefined, y: undefined,
      });
    });

    // 概念间 related 边（关联强度 = weight；related 边 weight 已由 CLI 计算）
    var nodeById = {};
    allNodes.forEach(function (n) { nodeById[n.id] = n; });
    allLinks = [];
    (rawData.edges || []).forEach(function (e) {
      if (e.type !== 'related') return;         // 主视图只画概念间关联
      var s = nodeById[e.source];
      var t = nodeById[e.target];
      if (!s || !t) return;
      allLinks.push({ source: s, target: t, type: 'related', weight: e.weight || 1 });
    });

    // 书列表
    books = [];
    var seen = {};
    (rawData.notes || []).forEach(function (n) {
      if (n.book && !seen[n.book]) { seen[n.book] = true; books.push(n.book); }
    });
  }

  /* ══ 过滤 / 归一化 ══ */

  function noteVisible(n) {
    if (bookFilter !== 'all' && n.book !== bookFilter) return false;
    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      var hay = (n.title || '') + '\n' + (n.summary || '') + '\n' + (n.tags || []).join(' ');
      if (hay.toLowerCase().indexOf(q) === -1) return false;
    }
    return true;
  }

  // 计算可见集合：概念节点 + related 边；概念 note_count 随过滤实时更新
  function computeVisible() {
    var noteMap = {};                    // note_id -> 可见?
    (rawData.notes || []).forEach(function (n) { noteMap[n.id] = noteVisible(n); });

    var conceptNodes = [];
    var cidToNode = {};
    allNodes.forEach(function (nd) {
      if (hiddenDomains[nd.domain]) return;
      var visibleNotes = (nd.notes || []).filter(function (nid) { return noteMap[nid]; });
      nd.note_count = visibleNotes.length;
      conceptNodes.push(nd);
      cidToNode[nd.id] = nd;
    });

    // related 边：两端概念都可见
    var inSet = {};
    conceptNodes.forEach(function (nd) { inSet[nd.id] = true; });
    var visibleLinks = allLinks.filter(function (l) {
      return inSet[l.source.id] && inSet[l.target.id];
    });

    // 边宽归一化：weight → 1..6（min weight=1 映射到 1，max 映射到 6）
    var wmin = Infinity, wmax = -Infinity;
    visibleLinks.forEach(function (l) {
      if (l.weight < wmin) wmin = l.weight;
      if (l.weight > wmax) wmax = l.weight;
    });
    if (wmax === wmin) wmax = wmin + 1;
    visibleLinks.forEach(function (l) {
      l.lineWidth = 1 + ((l.weight - wmin) / (wmax - wmin)) * 5;
    });

    var totalNotes = (rawData.notes || []).filter(function (n) { return noteMap[n.id]; }).length;
    return {
      nodes: conceptNodes,
      links: visibleLinks,
      counts: {
        notes: totalNotes,
        concepts: conceptNodes.length,
        domains: Object.keys(domainById).filter(function (d) { return !hiddenDomains[d]; }).length,
        edges: visibleLinks.length,
      },
    };
  }

  /* ══ 布局 / 渲染 ══ */

  function resize() {
    var rect = stage.getBoundingClientRect();
    width = Math.max(rect.width, 320);
    height = Math.max(rect.height, 420);
    svgEl.setAttribute('width', width);
    svgEl.setAttribute('height', height);
    if (sim) { sim.force('center', d3.forceCenter(width / 2, height / 2)); sim.alpha(0.35).restart(); }
  }

  function initSvg() {
    svg = d3.select(svgEl);
    viewport = svg.append('g').attr('class', 'graph-viewport');
    linkG = viewport.append('g').attr('class', 'graph-links');
    nodeG = viewport.append('g').attr('class', 'graph-nodes');
    svg.call(d3.zoom()
      .scaleExtent([0.2, 6])
      .on('zoom', function (event) { viewport.attr('transform', event.transform); }));
    svg.on('click', function (event) { if (event.defaultPrevented) return; closePanel(); });
  }

  function startSimulation() {
    sim = d3.forceSimulation()
      .force('link', d3.forceLink().id(function (d) { return d.id; })
        .distance(function (l) {
          // 强关联（大 weight）更近
          return Math.max(70, 220 - l.weight * 22);
        })
        .strength(0.35))
      .force('charge', d3.forceManyBody().strength(function (d) {
        return -260 - d.note_count * 6;   // 概念笔记越多，斥力越大（占位）
      }))
      .force('collide', d3.forceCollide().radius(function (d) {
        return nodeRadius(d) + 26;         // 半径+标签留白
      }).iterations(3))
      .force('x', d3.forceX(function (d) {
        var idx = rawData.domains.findIndex(function (dm) { return dm.id === d.domain; });
        if (idx < 0) return width / 2;
        return width * (idx + 0.5) / Math.max(rawData.domains.length, 1);
      }).strength(0.16))
      .force('y', d3.forceY(height / 2).strength(0.04))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .on('tick', ticked);
  }

  function nodeRadius(d) {
    return 10 + Math.min(Math.sqrt(d.note_count || 0) * 4.5, 22);
  }

  function update() {
    if (!rawData) return;
    var vis = computeVisible();

    // 边 join
    var linkSel = linkG.selectAll('line.graph-link')
      .data(vis.links, function (l) { return l.source.id + '|' + l.target.id; });
    linkSel.exit().remove();
    var linkEnter = linkSel.enter().append('line').attr('class', 'graph-link graph-link-related');
    var linkMerge = linkEnter.merge(linkSel);
    linkMerge
      .attr('stroke-width', function (l) { return l.lineWidth; })
      .attr('opacity', function (l) { return 0.35 + l.lineWidth * 0.1; });

    // 节点 join（概念层，标签常显）
    var nodeSel = nodeG.selectAll('g.graph-node')
      .data(vis.nodes, function (d) { return d.id; });
    nodeSel.exit().remove();
    var nodeEnter = nodeSel.enter().append('g')
      .attr('class', function (d) { return 'graph-node graph-node-concept'; })
      .call(dragBehavior());
    nodeEnter.append('circle').attr('class', 'graph-circle');
    nodeEnter.append('text').attr('class', 'graph-label').attr('text-anchor', 'middle');
    nodeEnter.append('title');
    var nodeMerge = nodeEnter.merge(nodeSel);

    nodeMerge.select('circle')
      .attr('r', function (d) { return nodeRadius(d); })
      .attr('fill', function (d) { return domainColor(d.domain); })
      .attr('fill-opacity', 0.88)
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5);

    nodeMerge.select('text.graph-label')
      .text(function (d) { return d.name; })
      .attr('dy', function (d) { return nodeRadius(d) + 14; })
      .attr('font-size', 12)
      .attr('font-weight', 600)
      .attr('fill', '#4a453c');

    nodeMerge.select('title')
      .text(function (d) { return d.name + '（' + d.note_count + ' 笔记）\n域：' + domainName(d.domain); });

    nodeMerge.on('click', function (event, d) {
      event.stopPropagation();
      if (event.defaultPrevented) return;
      openNode(d);
    });

    sim.nodes(vis.nodes);
    sim.force('link').links(vis.links);
    sim.alpha(0.75).restart();

    countEl.textContent = vis.counts.notes + ' 笔记 · ' + vis.counts.concepts +
      ' 概念 · ' + vis.counts.domains + ' 域 · ' + vis.counts.edges + ' 关联';
  }

  function dragBehavior() {
    return d3.drag()
      .on('start', function (event, d) {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', function (event, d) { d.fx = event.x; d.fy = event.y; })
      .on('end', function (event, d) {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
  }

  function ticked() {
    linkG.selectAll('line.graph-link')
      .attr('x1', function (l) { return l.source.x; })
      .attr('y1', function (l) { return l.source.y; })
      .attr('x2', function (l) { return l.target.x; })
      .attr('y2', function (l) { return l.target.y; });
    nodeG.selectAll('g.graph-node')
      .attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });
  }

  /* ══ 图例（域 = 标签/着色，可点击显隐）══ */

  function renderLegend() {
    var doms = rawData.domains || [];
    if (!doms.length) { legendEl.hidden = true; return; }
    legendEl.hidden = false;
    legendEl.innerHTML = '<div class="graph-legend-title">域（点击显隐）</div>' +
      doms.map(function (d) {
        var hidden = hiddenDomains[d.id];
        return '<button type="button" class="graph-legend-item' + (hidden ? ' off' : '') +
          '" data-domain="' + esc(d.id) + '">' +
          '<span class="dot" style="background:' + esc(d.color || '#b8b2a6') + '"></span>' +
          '<span class="name">' + esc(d.name) + '</span>' +
          '<span class="count">' + (d.note_count || 0) + '</span></button>';
      }).join('');
    legendEl.querySelectorAll('.graph-legend-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var did = btn.getAttribute('data-domain');
        if (hiddenDomains[did]) delete hiddenDomains[did];
        else hiddenDomains[did] = true;
        renderLegend();
        update();
      });
    });
  }

  /* ══ 书过滤按钮 ══ */

  function renderBookFilter() {
    var items = [{ id: 'all', label: '全部' }].concat(
      books.map(function (b) { return { id: b, label: b }; })
    );
    bookFilterEl.innerHTML = items.map(function (it) {
      return '<button type="button" class="book-filter-btn' +
        (bookFilter === it.id ? ' active' : '') + '" data-book="' + esc(it.id) + '">' +
        esc(it.label) + '</button>';
    }).join('');
    bookFilterEl.querySelectorAll('.book-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        bookFilter = btn.getAttribute('data-book');
        renderBookFilter();
        update();
      });
    });
  }

  /* ══ 详情面板：概念（放大视图）／笔记 ══ */

  function openPanel(html) {
    panelBody.innerHTML = html;
    panelEl.hidden = false;
    panelEl.classList.add('open');
  }
  function closePanel() {
    panelEl.classList.remove('open');
    panelEl.hidden = true;
  }
  function openNode(d) {
    if (d.type === 'concept') renderConceptPanel(d);
    else if (d.type === 'note') renderNotePanelFromData(d.note);
  }

  function noteSummary100(note) {
    var s = (note.summary || '').replace(/\s+/g, ' ').trim();
    return s.length > 100 ? s.slice(0, 100) + '…' : s;
  }

  // 概念放大视图：分支概念（related，可跳转）+ 笔记题头（可进细节）
  function renderConceptPanel(cnode) {
    var cdef = (rawData.concepts || []).filter(function (c) { return c.id === cnode.conceptId; })[0] || {};
    var notes = (cdef.notes || [])
      .map(function (nid) { return (rawData.notes || []).filter(function (n) { return n.id === nid; })[0]; })
      .filter(Boolean);

    // 分支概念：related（有边）优先，同域其余概念补充
    var branchIds = cdef.related || [];
    var sameDomain = (rawData.concepts || [])
      .filter(function (c) { return c.domain === cnode.domain && c.id !== cnode.conceptId && branchIds.indexOf(c.id) === -1; })
      .map(function (c) { return c.id; });
    var branchConcepts = branchIds.concat(sameDomain).slice(0, 12);

    var html =
      '<div class="graph-panel-head">' +
        '<span class="graph-panel-kind" style="background:' + esc(domainColor(cnode.domain)) + '">概念</span>' +
        '<h2>' + esc(cnode.name) + '</h2>' +
        '<p class="graph-panel-sub">' + esc(domainName(cnode.domain)) + ' · ' + notes.length + ' 篇笔记</p>' +
      '</div>' +
      (branchConcepts.length
        ? '<div class="graph-panel-section"><h3>分支概念</h3>' +
          '<div class="graph-concept-chips">' +
          branchConcepts.map(function (cid) {
            var c = (rawData.concepts || []).filter(function (x) { return x.id === cid; })[0];
            if (!c) return '';
            var linked = branchIds.indexOf(cid) !== -1;
            return '<button type="button" class="graph-concept-chip' + (linked ? ' linked' : '') +
              '" data-concept="' + esc(cid) + '" style="border-color:' + esc(domainColor(c.domain)) + '">' +
              esc(c.name) + (linked ? ' <span class="tag">关联</span>' : '') + '</button>';
          }).join('') +
          '</div></div>'
        : '') +
      '<div class="graph-panel-section"><h3>笔记</h3>' +
        (notes.length
          ? notes.map(function (n) {
              return '<button type="button" class="graph-note-item" data-note="' + esc(n.id) + '">' +
                '<span class="t">' + esc(n.title) + '</span>' +
                '<span class="m">' + esc(n.book || '') + (n.date ? ' · ' + esc(n.date) : '') + '</span>' +
                '</button>';
            }).join('')
          : '<p class="muted">该概念下暂无笔记。</p>') +
      '</div>';

    openPanel(html);

    // 分支概念点击 → 跳转到该概念
    panelBody.querySelectorAll('.graph-concept-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cn = allNodes.filter(function (nd) { return nd.type === 'concept' && nd.conceptId === btn.getAttribute('data-concept'); })[0];
        if (cn) renderConceptPanel(cn);
      });
    });
    // 笔记题头点击 → 细节
    panelBody.querySelectorAll('.graph-note-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var n = (rawData.notes || []).filter(function (x) { return x.id === btn.getAttribute('data-note'); })[0];
        if (n) renderNotePanelFromData(n);
      });
    });
  }

  function tagChips(tags) {
    if (!tags || !tags.length) return '';
    return '<div class="graph-tags">' + tags.map(function (t) {
      return '<span class="graph-tag">' + esc(t) + '</span>';
    }).join('') + '</div>';
  }

  // 笔记细节：题头 + 摘要 + 金句 + 概念 + 原文图片
  function renderNotePanelFromData(n) {
    var concepts = (n.concepts || []).map(function (cid) {
      return (rawData.concepts || []).filter(function (c) { return c.id === cid; })[0];
    }).filter(Boolean);

    var html =
      '<div class="graph-panel-head">' +
        '<span class="graph-panel-kind graph-panel-kind-note">笔记</span>' +
        '<h2>' + esc(n.title) + '</h2>' +
        '<p class="graph-panel-sub">' +
          esc(n.book || '') +
          (n.pages ? ' · 第 ' + esc(n.pages) + ' 页' : '') +
          (n.date ? ' · ' + esc(n.date) : '') +
        '</p>' +
        tagChips(n.tags) +
      '</div>' +
      (n.summary ? '<div class="graph-panel-section"><h3>摘要</h3><p class="graph-summary">' + esc(n.summary) + '</p></div>' : '') +
      (n.quotes && n.quotes.length
        ? '<div class="graph-panel-section"><h3>金句</h3>' +
          n.quotes.map(function (q) { return '<blockquote class="graph-quote">' + esc(q) + '</blockquote>'; }).join('') +
          '</div>'
        : '') +
      (concepts.length
        ? '<div class="graph-panel-section"><h3>所属概念</h3>' +
          '<div class="graph-concept-chips">' +
          concepts.map(function (c) {
            var srcs = (n.concept_sources && n.concept_sources[c.id]) || [];
            var srcText = srcs.length ? ' <em>' + esc(srcs.join('/')) + '</em>' : '';
            return '<button type="button" class="graph-concept-chip" data-concept="' + esc(c.id) + '">' +
              esc(c.name) + srcText + '</button>';
          }).join('') +
          '</div></div>'
        : '') +
      (n.images && n.images.length
        ? '<div class="graph-panel-section"><h3>原文图片</h3><div class="graph-images">' +
          n.images.map(function (src, i) {
            return '<img loading="lazy" src="' + esc(src) + '" alt="' + esc(n.title) + ' 图' + (i + 1) +
              '" onerror="this.style.display=\'none\'">';
          }).join('') +
          '</div></div>'
        : '');

    openPanel(html);
    panelBody.querySelectorAll('.graph-concept-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cn = allNodes.filter(function (nd) { return nd.type === 'concept' && nd.conceptId === btn.getAttribute('data-concept'); })[0];
        if (cn) renderConceptPanel(cn);
      });
    });
  }

  /* ══ 主流程 ══ */

  function showError(msg) {
    loadingEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.querySelector('h2').textContent = msg;
    legendEl.hidden = true;
  }

  /* 来源徽标：🧠 本机重算 @时间 / 📦 CLI 产物 @generated_at；
   * 「清空本机结果」按钮仅本机来源时显示 */
  function renderSourceMeta() {
    if (!rawData) return;
    if (dataSource === 'local') {
      sourceBadgeEl.textContent = '🧠 本机重算 @' + (rawData.generated_at || localBuiltAt || '');
      clearLocalBtn.hidden = false;
    } else {
      sourceBadgeEl.textContent = '📦 CLI 产物 @' + (rawData.generated_at || '');
      clearLocalBtn.hidden = true;
    }
    sourceBadgeEl.hidden = !sourceBadgeEl.textContent;
  }

  // 读取本机重算结果（IndexedDB graph_local store，见 concepts 页「重新计算图谱」）。
  // IndexedDB 异常或记录不合法 → 返回 null，静默回退 fetch 静态图。
  async function fetchLocalGraphRecord() {
    try {
      dataModule = await import('./data.js');
      const rec = await dataModule.getLocalGraph();
      if (rec && rec.graph && Array.isArray(rec.graph.notes) && Array.isArray(rec.graph.concepts)) {
        return rec;
      }
    } catch (err) {
      console.warn('[graph] 读取本机重算结果失败，回退 CLI 静态产物:', err);
    }
    return null;
  }

  function applyData() {
    loadingEl.hidden = true;
    buildGraph();
    initSvg();
    startSimulation();
    resize();
    renderLegend();
    renderBookFilter();
    update();
    window.addEventListener('resize', resize);
  }

  async function load() {
    if (typeof d3 === 'undefined') {
      showError('D3 库加载失败（请检查 vendor/d3.min.js）');
      return;
    }

    // 本机优先：命中即渲染本机重算结果并标记来源
    const rec = await fetchLocalGraphRecord();
    if (rec) {
      rawData = rec.graph;
      dataSource = 'local';
      localBuiltAt = rec.builtAt || '';
      renderSourceMeta();
      applyData();
      return;
    }

    // 回落：CLI 静态产物（现状逻辑不变）
    dataSource = 'cli';
    fetch('graph.json', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.notes)) throw new Error('graph.json 格式不正确');
        rawData = data;
        renderSourceMeta();
        applyData();
      })
      .catch(function (err) {
        console.warn('[graph] 加载 graph.json 失败:', err);
        showError('还没有图谱数据');
        emptyEl.querySelector('p').innerHTML =
          '可运行 <code>reading-notes graph build</code> 并复制 <code>graph.json</code> 到 app/pwa/；或在「概念管理」页载入概念目录后点「⚙️ 重新计算图谱」本机生成';
      });
  }

  searchInput.addEventListener('input', function () {
    searchQuery = searchInput.value.trim();
    update();
  });
  panelClose.addEventListener('click', closePanel);

  // 清空本机重算结果 → 刷新页面回到 CLI 产物（仅来源=local 时可见）
  clearLocalBtn.addEventListener('click', function () {
    if (!dataModule || typeof dataModule.clearLocalGraph !== 'function') return;
    dataModule.clearLocalGraph().then(function () {
      location.reload();
    }).catch(function (err) {
      console.warn('[graph] 清除本机重算结果失败:', err);
    });
  });

  load();
})();
