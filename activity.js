/* activity.js —— 从 IndexedDB 聚合真实阅读活动数据，注入 window.__ACTIVITY__。
 *
 * 用法：在 index.html 中、heatmap.js 之前加载（普通 script，非 ES Module，
 * file:// 直开也能运行）：
 *   <script src="activity.js"></script>
 *   <script type="module" src="heatmap.js"></script>
 *
 * 聚合结果：按日期 [{ date: 'YYYY-MM-DD', notes: 当天记录数,
 *                     images: 当天图片数, pages: 页数(有则填) }]
 * 统计全部类型记录（阅读笔记 / 日记 / 日志 / 备忘 / 自定义）。
 * 完成后置 window.__ACTIVITY_READY__ = Promise，heatmap.js 可 await 后再渲染。
 */
(function () {
  'use strict';

  var DB_NAME = 'reading-notes';
  var STORE = 'notes';

  function openDB() {
    return new Promise(function (resolve, reject) {
      // 不带版本号：按当前版本打开，绝不触发 schema 升级（schema 由 data.js/diary.js 负责）
      var req = indexedDB.open(DB_NAME);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getAllRows(db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readonly');
      var req = tx.objectStore(STORE).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /** 按日期聚合：notes = 记录数，images = 图片数，pages = 当日任一条的页码 */
  function aggregate(rows) {
    var map = {};
    rows.forEach(function (r) {
      var d = r.date || '';
      if (!d) return;
      var e = map[d] || (map[d] = { notes: 0, images: 0, pages: '' });
      e.notes += 1;
      if (r.imageData) e.images += 1;
      if (Array.isArray(r.images) && r.images.length) e.images += r.images.length;
      if (!e.pages && r.pages) e.pages = String(r.pages);
    });
    return Object.keys(map).map(function (d) {
      var e = map[d];
      return { date: d, notes: e.notes, images: e.images, pages: e.pages };
    }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }

  function finish(data) {
    window.__ACTIVITY__ = data;   // 空数组也注入 → 热力图显示全灰，而不是伪随机示例
  }

  // 无论成功失败都 resolve，heatmap.js 等到该 Promise 后取 window.__ACTIVITY__
  var ready = openDB()
    .then(getAllRows)
    .then(aggregate)
    .then(finish)
    .catch(function (err) {
      console.warn('[activity] 读取活动数据失败（可能尚无数据）：', err);
      finish([]);
    });
  window.__ACTIVITY_READY__ = ready;
})();
