/* sw.js —— Service Worker：离线能力
 * 策略：
 *   install 时预缓存核心资源（逐个缓存，个别资源缺失不影响整体安装）
 *   fetch  时 cache-first，未命中则回退网络，成功后将响应写入运行时缓存
 * 升级：修改 CACHE_NAME 版本号即可触发整体换新。
 */
'use strict';

/* 版本号常量：资源有更新时递增，如 'reading-notes-v2' */
var CACHE_NAME = 'reading-notes-v12';

/* 安装时预缓存的核心资源（相对路径，与页面同目录） */
var CORE_ASSETS = [
  './',
  './index.html',
  './book.html',
  './book.js',
  './styles.css',
  './data.js',
  './types.js',
  './type.html',
  './type.js',
  './activity.js',
  './file-warning.js',
  './sw-register.js',
  './heatmap.js',
  './heatmap.css',
  './notes.html',
  './notes.js',
  './diary.html',
  './diary.js',
  './manifest.webmanifest',
  './graph.html',
  './graph.js',
  './graph.css',
  './graph-build.js',   // v12 补上（阶段一遗漏）：本机重算 union 图谱的纯函数模块
  './graph.json',
    './concepts.html',
    './concepts.js',
  './vendor/d3.min.js'
];

/* 仅处理同源 http(s) GET 请求 */
function isCacheable(request) {
  var url = new URL(request.url);
  return request.method === 'GET' &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === self.location.origin;
}

/* install：逐个预缓存，用 allSettled 保证个别文件缺失（如并行任务尚未生成）时不阻塞安装 */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.allSettled(
        CORE_ASSETS.map(function (asset) {
          return cache.add(asset).catch(function (err) {
            console.warn('[SW] 预缓存失败（跳过）:', asset, err);
          });
        })
      );
    }).then(function () {
      // 新 SW 安装完成后立即接管，避免等用户二次刷新
      return self.skipWaiting();
    })
  );
});

/* activate：清理旧版本缓存，并接管已打开的页面 */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* fetch：cache-first，未命中回退网络；网络成功则顺手写入缓存供下次离线使用。
 * 例外：export.json（CLI 同步文件）始终走网络，避免返回旧缓存导致同步不到新数据。 */
self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (!isCacheable(request)) return;

  var url = new URL(request.url);
  if (url.pathname.endsWith('/export.json')) {
    // CLI 同步文件（export.json）始终走网络，避免返回旧缓存
    event.respondWith(fetch(request));
    return;
  }
  if (url.pathname.endsWith('/graph.json')) {
    // 图谱数据：network-first，在线拉最新并写入缓存；离线回退预缓存/上次缓存
    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, clone);
          });
        }
        return response;
      }).catch(function () {
        return caches.match(request);
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;               // 命中缓存，直接返回
      return fetch(request).then(function (response) {
        // 只缓存有效响应（非跨域 / 非错误）
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, clone);
          });
        }
        return response;
      });
    }).catch(function () {
      // 离线且缓存未命中：导航请求回退到日记页作为离线首页提示
      if (request.mode === 'navigate') {
        return caches.match('./diary.html');
      }
      return new Response('离线模式：资源暂不可用', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    })
  );
});
