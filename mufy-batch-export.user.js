// ==UserScript==
// @name         Mufy 批量导出聊天记录
// @namespace    https://github.com/willwefind/mufy-batch-export
// @version      1.34.0
// @description  一键把某个角色（或多个角色）的所有存档对话批量导出：打包成 ZIP、合并成一份 Markdown，或直接做成 EPUB 电子书；也能把整个「人设面具」库、和你自己创建的角色卡导出来
// @author       Ciel
// @license      MIT
// @homepageURL  https://github.com/willwefind/mufy-batch-export
// @supportURL   https://github.com/willwefind/mufy-batch-export/issues
// @downloadURL  https://raw.githubusercontent.com/willwefind/mufy-batch-export/main/mufy-batch-export.user.js
// @updateURL    https://raw.githubusercontent.com/willwefind/mufy-batch-export/main/mufy-batch-export.user.js
// @match        https://chat.mufy.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 两种用法：
 *   1) 装了 Tampermonkey：把本文件拖进去 / 新建脚本粘贴保存，刷新 mufy 的聊天页面，
 *      左下角会出现「⬇ 批量导出」按钮。
 *   2) 不想装插件：在 mufy 的聊天页面按 F12 打开控制台，把本文件整段粘进去回车，
 *      同样会出现那个按钮（关掉标签页就没了，下次再粘一遍）。
 *
 * 只读你自己的账号数据，不发任何东西出去；导出文件直接走浏览器下载。
 *
 * 🔞 面向成年用户。请勿向未成年人传播本工具或站点地址。
 */

(function () {
  'use strict';

  if (window.__mufyExporter) { window.__mufyExporter.open(); return; }

  // 面板标题上显示的版本号。
  // 🔴 2026-08-10 栽过一次：只改了上面的 @version，**面板里那个数字是手写的、没跟着改** ——
  //    用户装好了新版，面板却还写着旧版号，于是所有人（包括我）都以为"更新没生效"，
  //    去查缓存、查装了两份、查扩展缓存，全查错了方向。**用户看到的版本号才是他的事实。**
  //    现在只留这一处，并且 make-public.py 会校验它和 @version 一致，不一致直接构建失败。
  const VERSION = '1.34.0';

  // ---------- 基础工具 ----------
  const ORIGIN = location.origin;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const token = () => localStorage.getItem('mufy-token') || '';
  const short = (p) => p.split('?')[0];

  // ---------- 登录态 ----------
  // ⚠️ mufy 的 token 只活 15 分钟。一次完整导出可能跑好几分钟，
  //    所以每次请求前都确认一遍，快到期就提前换新的。

  function jwtExpMs(t) {
    try {
      const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return (p.exp || 0) * 1000;
    } catch (e) {
      return 0;
    }
  }

  async function refreshToken() {
    const res = await fetch(ORIGIN + '/api/users/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    const fail = '续不上登录态了，请刷新一下 mufy 页面（必要时重新登录）再试。';
    if (!res.ok) throw new Error(fail + '（HTTP ' + res.status + '）');
    const j = await res.json();
    const t = j && j.data && j.data.token;
    if (!t) throw new Error(fail);
    localStorage.setItem('mufy-token', t); // 写回去，页面本身也跟着用新的
    return t;
  }

  // 剩余不足 2 分钟就提前换
  async function ensureToken() {
    const t = token();
    const exp = jwtExpMs(t);
    if (!t || !exp || exp - Date.now() < 120000) return await refreshToken();
    return t;
  }

  // 401 → 换 token 重来；5xx / 429 / 断网 → 退避重试（真遇到过 503）
  // 传了 body 就走 POST（面具接口只认 POST，聊天那几个接口都是 GET）
  async function api(path, body) {
    const MAX = 4;
    let last = '';
    for (let i = 0; i < MAX; i++) {
      const t = await ensureToken();
      let res;
      try {
        const init = { headers: { Authorization: 'Bearer ' + t }, credentials: 'include' };
        if (body !== undefined) {
          init.method = 'POST';
          init.headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        res = await fetch(ORIGIN + path, init);
      } catch (e) {
        last = '网络错误 ' + e.message;
        await sleep(900 * (i + 1));
        continue;
      }

      if (res.status === 401) {
        last = 'HTTP 401';
        await refreshToken(); // 换不到就直接抛，让她去刷新页面
        await sleep(300);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        last = 'HTTP ' + res.status;
        await sleep(1200 * (i + 1));
        continue;
      }
      if (res.status === 403) {
        // 403 不是「没登录」（那是 401），是「认得你但这次不让过」。
        // 实际见过的两类：①站点前面的防护（Cloudflare 之类）把请求当成机器人——
        // 连太快、开了加速器/代理、网络环境异常都可能触发；②这个资源你的账号确实没权限。
        throw new Error(
          short(path) + ' → HTTP 403（被拒绝）。常见原因：① 站点的防护把请求当成了机器人' +
          '（关掉加速器/VPN、换个网络、等几分钟再试）；② 这个角色或资源你的账号没有权限看。'
        );
      }
      if (!res.ok) throw new Error(short(path) + ' → HTTP ' + res.status);

      const json = await res.json();
      if (json.code && json.code !== 200) throw new Error(short(path) + ' → ' + (json.reason || json.code));
      return json.data;
    }
    throw new Error(short(path) + ' → 重试 ' + MAX + ' 次仍失败（' + last + '）');
  }

  const qs = (k) => new URLSearchParams(location.search).get(k);

  // 截断但别把 emoji 从中间劈开。JS 的字符串是 UTF-16，emoji 占两个码元（代理对），
  // slice 正好切在中间会留下半个字符，后面 encodeURI 直接抛 "URI malformed"。
  // （实测被这个咬过：207 个角色里有 2 个因此整个导出失败。）
  function cut(s, n) {
    let out = String(s).slice(0, n);
    if (out.length && /[\uD800-\uDBFF]/.test(out[out.length - 1])) out = out.slice(0, -1);
    return out;
  }

  // 目录页里的链接。万一还是撞上落单代理，别让一个文件名毁掉整个角色的导出。
  function linkTarget(name) {
    try {
      return encodeURI(name);
    } catch (e) {
      return encodeURI(String(name).replace(/[\uD800-\uDFFF]/g, ''));
    }
  }

  // Windows 文件名安全化
  function safeName(s) {
    return cut(String(s || '未命名').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim(), 60);
  }

  function stamp(d) {
    const t = d instanceof Date && !isNaN(d) ? d : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}`;
  }

  const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

  // 面板日志的出口。downloadBlob 在很深的地方被调用，拿不到 run() 里的 report，
  // 所以留一个模块级的出口，run() 开跑时把它接上。
  let logSink = null;
  const say = (m) => { if (logSink) logSink(m); };

  // ⚠️ 这里原来是「下载完 8 秒就 URL.revokeObjectURL()」。8 秒定得偏激进——
  //    FileSaver.js 这类库普遍留 40 秒以上，理由是浏览器把 blob 写进磁盘要时间，
  //    URL 提前注销有可能让还没写完的下载失败。
  //    ⚠️ **这是隐患，不是已证实的病因**：有用户反馈「脚本说完成了、下载列表里却没有文件」，
  //    这条是嫌疑之一（另两个嫌疑：浏览器的自动下载策略静默拦截、下载目录失效），
  //    截至改动时还没拿到能定案的现场信息。别把它当成已经查实的根因去引用。
  //
  // 现在不再定时注销：生成过的文件留在面板上可以手动再存一次。
  // 手动点是**用户手势**，浏览器基本不拦；自动触发的下载才会被
  // 「是否允许下载多个文件」那条策略掐掉，而且掐得没有任何提示。
  const RECENT_MAX = 8;
  const RECENT_MAX_BYTES = 64 * 1024 * 1024; // 兜底也不能把她的内存吃光
  const recentFiles = [];

  function rememberFile(name, url, size) {
    recentFiles.push({ name, url, size });
    let total = recentFiles.reduce((n, f) => n + f.size, 0);
    // 至少留一个，其余按「条数」和「总字节」两个上限一起淘汰
    while (recentFiles.length > 1 && (recentFiles.length > RECENT_MAX || total > RECENT_MAX_BYTES)) {
      const old = recentFiles.shift();
      URL.revokeObjectURL(old.url);
      total -= old.size;
    }
    renderRecent();
  }

  function renderRecent() {
    const box = panel && panel.querySelector('#mufyx-recent');
    if (!box) return;
    box.textContent = '';
    if (!recentFiles.length) return;
    const tip = document.createElement('div');
    tip.className = 'rt';
    tip.textContent = `下载列表里没有？点下面这些手动保存（留最近 ${recentFiles.length} 个）：`;
    box.appendChild(tip);
    for (const f of [...recentFiles].reverse()) {
      const a = document.createElement('a');
      a.href = f.url;
      a.download = f.name;
      a.textContent = `⬇ ${f.name}　${mb(f.size)}`;
      box.appendChild(a);
    }
  }

  // ---------- 别让屏幕熄 ----------
  // 手机上导一批角色要跑很久，中途息屏 / 切后台，系统就会把这个标签页回收掉，
  // 导出当场断（有安卓用户反馈「息屏几次之后直接被踢出去，下载好的也没了」）。
  // Wake Lock 能挡住「屏幕自动熄灭」，但**挡不住用户手动锁屏或切走**——
  // 那两种情况下锁会被系统自动释放，所以回到前台时要重新申请。
  let wakeLock = null;

  async function acquireWakeLock(report) {
    if (!navigator.wakeLock) {
      if (report) report('  （这个浏览器不支持「保持屏幕常亮」，导出期间请别让屏幕熄。）');
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      if (report) report('  已请求保持屏幕常亮，导出期间别切到别的 App。');
    } catch (e) {
      // 页面不可见时申请会抛，不是致命问题，别打断导出
      if (report) report(`  （没能保持屏幕常亮：${e.message}。请别让屏幕熄。）`);
    }
  }

  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  // 回到前台就补回来（息屏/切走的时候系统已经把它释放了）
  const onVisibleReacquire = () => {
    if (document.visibilityState === 'visible' && !wakeLock) acquireWakeLock(null);
  };

  let downloadCount = 0; // 这一轮到底真的产出了几个文件

  function downloadBlob(filename, blob) {
    downloadCount += 1;
    const url = URL.createObjectURL(blob);
    // 先把文件名和大小记进日志再点 —— 以后有人反馈「说完成了却没文件」，
    // 一看日志就知道是「压根没生成」还是「生成了但浏览器没收下」。
    say(`  ⬇ ${filename}　${mb(blob.size)}`);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    rememberFile(filename, url, blob.size);
  }

  // 安卓（和 Windows 上一些老编辑器）看 .md 时会**自己猜编码**，猜成 GBK 中文就全是乱码。
  // 猜得准不准跟文件内容有关，所以会出现「同一批导出，有的正常有的乱码」。
  // 加个 UTF-8 BOM 就是明着告诉它别猜。
  // ⚠️ **只给 .md 加**：JSON 带 BOM 会让 `JSON.parse` / Python 的 `json.loads` 直接报错
  //    （`make-epub.py` 和网页阅读器读的就是 `_原始数据.json`），EPUB 里的 XHTML 也不要。
  const BOM = '\uFEFF'; // 写成转义：源码里别放不可见字符，会被编辑器/脚本悄悄吃掉 // 写成转义，别在源码里放不可见字符——会被编辑器/脚本悄悄吃掉
  const wantsBom = (name) => /\.md$/i.test(name || '');
  const withBom = (name, text) =>
    wantsBom(name) && !String(text).startsWith(BOM) ? BOM + text : text;

  const download = (filename, text) =>
    downloadBlob(filename, new Blob([withBom(filename, text)], { type: 'text/plain;charset=utf-8' }));

  // ---------- ZIP（不依赖任何外部库） ----------
  // 压缩用浏览器原生 CompressionStream('deflate-raw')；没有就退回不压缩存储。

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      return null;
    }
  }

  // DOS 时间戳，好让资源管理器里按日期排得出来
  function dosDT(d) {
    const t = d instanceof Date && !isNaN(d) && d.getFullYear() >= 1980 ? d : new Date(1980, 0, 1);
    return {
      date: ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate(),
      time: (t.getHours() << 11) | (t.getMinutes() << 5) | Math.floor(t.getSeconds() / 2),
    };
  }

  // files: [{ name, text | bytes, date, store }]
  //   bytes = 已经是 Uint8Array 的二进制（封面 PNG 走这条）
  //   store = 强制不压缩。EPUB 的 mimetype 必须是第一个条目且不压缩，否则很多阅读器不认。
  async function makeZip(files, onProgress, mime) {
    // 体量太大就先打个招呼。有用户在 Safari 上导一个 352 段存档的角色时遇到：
    // 日志显示导出完毕，**页面却自己刷新了一下**，然后什么文件都没有。
    // 那不是刷新，是标签页被系统回收后重载了——页面一没，blob 跟着没，
    // 连「⬇ 手动保存」都救不回来。所以这话必须在开跑前说，事后说没用。
    const bulk = files.reduce((n, f) => n + (f.text ? f.text.length : 0), 0);
    if (bulk > 8e6) {
      say(`  ⚠️ 这一包很大（约 ${(bulk / 1e6).toFixed(1)}M 字）。手机浏览器可能扛不住。`);
      say('     症状是「显示导出完毕、页面自己刷新了一下、然后没有文件」＝标签页被系统回收了。');
      say('     建议：把面板上的「每包最多多少段对话」填成 20 再导一次（这是最有效的一招）；');
      say('     或者取消勾选「附带 JSON 完整备份」（那份通常占一半以上）；再不行就用电脑导。');
    }

    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const nameBytes = enc.encode(f.name);
      // withBom 只对 .md 生效；.json 和 EPUB 内部的 xhtml/opf/ncx 一律不加
      const raw = f.bytes ? f.bytes : enc.encode(withBom(f.name, f.text));
      // 🔴 编码完立刻把源数据放掉。几百段对话的 Markdown 加上那份完整 JSON 会一直
      //    压在堆里，和压缩产物同时存在 —— 峰值能把标签页顶崩。
      //    有用户在 Safari 上导一个 352 段存档的角色时遇到过：日志显示导出完毕，
      //    **页面却自己刷新了一下**，然后什么文件都没有。那不是刷新，
      //    是系统把这个标签页杀掉后重载了；页面一重载，blob 跟着没，
      //    连 v1.14 那个「手动保存」兜底都救不回来。
      //    调用方在 makeZip 之后不再读 text/bytes（emit / emitMasks / emitCards 都是先建后打包）。
      f.text = null;
      f.bytes = null;
      const crc = crc32(raw);
      const { date, time } = dosDT(f.date);

      let method = 0;
      let body = raw;
      if (!f.store) {
        const packed = await deflateRaw(raw);
        if (packed && packed.length < raw.length) { method = 8; body = packed; }
      }

      const lh = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true); // 文件名按 UTF-8 解，中文名才不会乱码
      dv.setUint16(8, method, true);
      dv.setUint16(10, time, true);
      dv.setUint16(12, date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, body.length, true);
      dv.setUint32(22, raw.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      parts.push(lh, body);
      central.push({ nameBytes, crc, csize: body.length, usize: raw.length, method, date, time, offset });
      offset += lh.length + body.length;

      if (onProgress && i % 5 === 0) onProgress(i + 1, files.length);
    }

    let cdSize = 0;
    const cd = [];
    for (const c of central) {
      const h = new Uint8Array(46 + c.nameBytes.length);
      const dv = new DataView(h.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, c.method, true);
      dv.setUint16(12, c.time, true);
      dv.setUint16(14, c.date, true);
      dv.setUint32(16, c.crc, true);
      dv.setUint32(20, c.csize, true);
      dv.setUint32(24, c.usize, true);
      dv.setUint16(28, c.nameBytes.length, true);
      dv.setUint32(42, c.offset, true);
      h.set(c.nameBytes, 46);
      cd.push(h);
      cdSize += h.length;
    }

    const eocd = new Uint8Array(22);
    const dv = new DataView(eocd.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, central.length, true);
    dv.setUint16(10, central.length, true);
    dv.setUint32(12, cdSize, true);
    dv.setUint32(16, offset, true);

    return new Blob([...parts, ...cd, eocd], { type: mime || 'application/zip' });
  }

  // ---------- 内容处理 ----------
  // content 是 [{type:'text', text:'...'}] 这样的数组
  function contentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
    return content
      .map((part) => {
        if (part == null) return '';
        if (typeof part === 'string') return part;
        if (part.type === 'text' || typeof part.text === 'string') return part.text || '';
        if (part.url) return `![${part.type || 'image'}](${part.url})`;
        return JSON.stringify(part);
      })
      .join('\n');
  }

  // 可选清洗：去掉 <think> 与状态栏 HTML，只留正文
  function tidy(text) {
    return String(text)
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<\/?(div|span|p|br|hr|table|thead|tbody|tr|td|th|ul|ol|li|section|header|footer|img|svg|path|b|i|strong|em|font)\b[^>]*>/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---------- 取数 ----------
  // ⚠️ 开场白在角色卡的 greeting 字段上，**不是 dialogs 里的一行**——
  //    只导 dialogs 会把每个角色的第一幕整段漏掉（实测一个角色的 greeting 有 1400+ 字）。
  //    注意这里拿到的是"当前"的开场白；卡主改过的话，旧 session 当年那版接口不提供。
  async function getCharacter(characterId) {
    try {
      const d = await api('/api/characters/get?id=' + encodeURIComponent(characterId));
      // lastSessionId 也一并带回来：「手动填角色 ID」和「当前角色」这两条路
      // 拿不到角色列表，没有它就会漏掉「聊过但没存档」的那一段。
      return {
        name: (d && d.name) || characterId.slice(0, 8),
        greeting: (d && d.greeting) || '',
        lastSessionId: (d && d.lastSessionId) || '',
      };
    } catch (e) {
      return { name: characterId.slice(0, 8), greeting: '', lastSessionId: '' };
    }
  }

  async function getArchives(characterId) {
    const d = await api('/api/sessions/query_archives?characterId=' + encodeURIComponent(characterId));
    return Array.isArray(d) ? d : (d && d.data) || [];
  }

  // 拉一个 session 的全部消息（自动翻页）
  // 🔴 这里以前是「任一页失败就整个抛出」，调用方接住之后会退回用存档里那一问一答——
  //    于是一段 600 条的长对话，翻到第 5 页时网络抖一下，导出来就只剩 2 条，
  //    而且只在角落留一个 ⚠️。长对话才需要翻页，所以这个坑专挑长记录下手。
  //    现在：抓到多少留多少，并且明确记下「接口说有多少 / 实际拿到多少」。
  async function getDialogs(sessionId, characterId) {
    // 按给定页大小把一段对话整个翻完。返回「抓到多少 / 接口说多少 / 为什么停」。
    const fetchAll = async (size) => {
      const out = [];
      let page = 1, expected = null, stopped = '';
      for (;;) {
        let d;
        try {
          d = await api(
            `/api/dialogs/query?sessionId=${encodeURIComponent(sessionId)}&characterId=${encodeURIComponent(characterId)}` +
              `&pageNum=${page}&pageSize=${size}`
          );
        } catch (e) {
          stopped = `第 ${page} 页取失败：${e.message}`;
          break;                       // ← 别抛，保住已经抓到的
        }
        const rows = (d && d.data) || [];
        out.push(...rows);
        if (expected === null && d && typeof d.total === 'number') expected = d.total;
        if (!rows.length || (expected !== null && out.length >= expected) || (d && d.hasNext === false)) break;
        page += 1;
        if (page > 500) { stopped = '页数超过上限 500'; break; }
        await sleep(120);
      }
      return { out, expected, stopped };
    };

    // 先用大页（500）翻：一万轮对话从 200 次请求降到 40 次，少 5 倍的网络抖动机会。
    let r = await fetchAll(500);

    // 🔴 少拿到了不要一次就认。有用户反馈「接口说共 1458 条、实际拿到 1000 条」，
    //    1000 正好是 2×500 —— 如果服务端是按「页大小 500 只给两页」那样卡的，
    //    换小页再翻一遍就能多捞回来；如果卡的是偏移量本身，那两次结果一样，
    //    我们就照实报，不假装尽力了。合并按 dialogsId 去重，两次都不亏。
    if (r.expected !== null && r.out.length < r.expected) {
      const r2 = await fetchAll(100);
      const seen = new Set(r.out.map((m) => m.dialogsId));
      let added = 0;
      for (const m of r2.out) if (!seen.has(m.dialogsId)) { seen.add(m.dialogsId); r.out.push(m); added += 1; }
      if (added) r.stopped = '';
      if (r2.stopped && !r.stopped && r.out.length < r.expected) r.stopped = r2.stopped;
    }

    // 🔴🔴 v1.33：「拿满了」不等于「拿全了」。
    //    一位用户拿 mufy 官方导出对过账：同一段对话官方那边有 2971 条，
    //    而 dialogs 接口的 total 和我们实际拿到的**都是 1000** —— 也就是说
    //    **total 本身就是被截过的**。两个数一样，脚本就以为自己拿全了，
    //    连一句警告都不会给（这比少拿更危险：它是静默的）。
    //    而上面那个循环恰好停在 out.length >= expected —— 第 3 页从来没被问过。
    //    → 数字可疑时（正好拿满、且是 500 的整数倍）就多问几页；有就接着翻。
    //    普通对话（几十条）永远进不来这个分支，一次多余的请求都不会发。
    let beyond = 0;
    // 「数字可疑」＝正好拿满、而且是 500 的整数倍。普通对话（几十条）永远不成立。
    const suspicious = () =>
      r.expected !== null && r.expected > 0 && r.out.length === r.expected && r.expected % 500 === 0;

    // 从 startPage 开始按 size 一页页往下要，只要还有没见过的就继续。返回多捞到几条。
    const sweep = async (size, startPage) => {
      const seen = new Set(r.out.map((m) => m.dialogsId));
      let page = startPage, added = 0;
      for (;;) {
        let d;
        try {
          d = await api(
            `/api/dialogs/query?sessionId=${encodeURIComponent(sessionId)}&characterId=${encodeURIComponent(characterId)}` +
              `&pageNum=${page}&pageSize=${size}`
          );
        } catch (e) {
          break;                       // 探测失败不算错：这本来就是额外多问的一句
        }
        const rows = (d && d.data) || [];
        const fresh = rows.filter((m) => !seen.has(m.dialogsId));
        for (const m of fresh) { seen.add(m.dialogsId); r.out.push(m); }
        added += fresh.length;
        // 一条新的都没有（含服务端绕回第一页）→ 立刻停，别死循环
        if (!fresh.length || (d && d.hasNext === false)) break;
        page += 1;
        if (page > 500) break;
        await sleep(120);
      }
      return added;
    };

    if (suspicious()) beyond += await sweep(500, r.expected / 500 + 1);
    // 真捞到了 → total 是假的，以实际拿到的为准，否则下面会误报「少拿了」
    if (beyond) r.expected = r.out.length;

    // 🎯 v1.34：最后一发——一次就要 2000 条。
    //    500 和 100 两种页大小都恰好停在 1000（2×500 和 10×100 都是 1000），
    //    上面那轮从第 3 页往后要也一条不给 —— 这些都指向「卡的是偏移量」。
    //    但实测这个接口 pageSize 到 2000 都接受，而「一次请求就要 2000 条」
    //    这个组合从来没试过：如果那边限制的是**翻页深度**而不是偏移量，
    //    一页要满就可能一次拿全。拿不到也只是白问一次。
    //    只在数字可疑、且上面那轮一无所获时才打这一发。
    if (beyond === 0 && suspicious()) {
      beyond += await sweep(2000, 1);
      if (beyond) r.expected = r.out.length;
    }

    const out = r.out, expected = r.expected, stopped = r.stopped;
    out.sort((a, b) => new Date(a.createdTime || 0) - new Date(b.createdTime || 0));

    // 拿到的比接口说的少 —— 这就是「被吞了」，必须说出来，不能静默
    const short = expected !== null && out.length < expected;
    return {
      dialogs: out,
      expected,
      beyond,                          // 接口报的 total 之外还捞回来多少条（v1.33）
      incomplete: !!(stopped || short),
      reason: stopped
        || (short
          ? `接口说共 ${expected} 条，只取到 ${out.length} 条（换小页重试过，还是这么多）` +
            `——已有两位用户各自查实过，是 mufy 那边真的丢了：它迁移过服务器并公告说` +
            `会丢一部分记录，而返回的总数还是丢失之前的数字。也就是说少掉的那些在 mufy 上` +
            `也已经翻不出来了，不是这个脚本没抓到。想自己确认就在 mufy 里把这段往上翻到底数一数。`
          : ''),
    };
  }

  // 角色列表。followedOnly=true → 你关注的（含从没聊过的）；
  //                 false → 有会话记录的，也就是你真聊过的。
  // ⚠️ 这两个集合并不互相包含：实测有 99 个关注了但从没聊过，
  //    也有 20 个聊过却没关注——所以「全部关注」并不等于「全部聊过」。
  async function getCharacterList(followedOnly) {
    const out = [];
    const seen = new Set();
    let page = 1;
    for (;;) {
      const d = await api(
        `/api/characters/query_session?pageNum=${page}&pageSize=50` + (followedOnly ? '&isFollowed=true' : '')
      );
      const rows = (d && d.data) || [];
      for (const c of rows) {
        if (c.characterId && !seen.has(c.characterId)) { seen.add(c.characterId); out.push(c); }
      }
      if (!rows.length || d.hasNext === false) break;
      page += 1;
      if (page > 60) break;
      await sleep(120);
    }
    return out;
  }

  // 从没聊过的角色不可能有存档，跳掉能省一半时间。
  // 判据：没有 lastSessionId（这类的 lastInteracted 是 0001-01-01 的零值）
  function hasChatted(c) {
    return !!c.lastSessionId;
  }

  // ---------- 人设面具 ----------
  // 面具和聊天记录是两套东西：它不挂在任何角色底下，是账号级的一份清单，
  // 所以走自己的接口、自己的导出路径，和上面那套角色/存档/对话完全不相干。
  //
  // ⚠️ /api/masks/query 是 POST，而且字段名是 page（不是聊天那边的 pageNum）；
  //    pageSize 上限 100（填 300 直接 400）。这三点都是实测出来的，别照抄聊天接口的写法。
  const MASK_FIELDS = [
    ['remark', '备注'],
    ['maskName', '名称'],
    ['gender', '性别'],
    ['description', '我的描述'],
    ['favorite', '我的喜好'],
    ['command', '指令'],
  ];

  // 返回 { list, total, truncated }：
  // total 是接口自己报的总数。有用户反馈**未订阅的账号只能导出现有的几个面具，
  // 其余的拿不到**——那是 mufy 那边的可见性限制，不是这里少翻了页。
  // 但「接口说有 N 个、实际只拿到 M 个」这件事必须喊出来：
  // 闷声导出更少的东西，比导不出来更糟（v1.8 那个静默吞数据的坑就是这么来的）。
  async function getMasks(report) {
    const list = [];
    let total = null;
    let page = 1;
    let truncated = false;
    for (;;) {
      const d = await api('/api/masks/query', { page, pageSize: 100 });
      const rows = (d && d.data) || [];
      if (d && typeof d.total === 'number') total = d.total;
      list.push(...rows);
      if (report && total) report(`  已读 ${list.length}/${total}`);
      if (!rows.length || d.hasNext === false) break;
      page += 1;
      if (page > 60) { truncated = true; break; } // 兜底，别让分页出岔子时空转
      await sleep(120);
    }
    return { list, total, truncated };
  }

  // 少拿到了就说清楚，并且这句话要能进文件，不能只活在会滚走的日志里
  function maskShortfallNote(count, total, truncated) {
    if (truncated) return `翻页翻到上限还没结束，只取回 ${count} 个，可能不全。`;
    if (total && count < total) {
      return `接口说这个账号共有 ${total} 个面具，实际只取回 ${count} 个，少了 ${total - count} 个。` +
        `多半是 mufy 对未订阅账号限制了可见数量——导出只能拿到你现在看得见的那些，脚本没有办法绕过。`;
    }
    return '';
  }

  // 面具标题：备注是列表里显示的那一行，最认得出来；备注为空才退到名称
  function maskTitle(m) {
    return String(m.remark || m.maskName || ('面具 ' + m.maskId)).trim() || ('面具 ' + m.maskId);
  }

  // level=1：一个面具一份文件；level=2：合并成一份时整体降一级。
  // ⚠️ 降级只能在这儿按结构做，绝不能事后拿正则去改整篇 —— 面具正文里本来就可能有
  //    以 "## " 开头的行（描述那栏经常是一整篇 markdown），正则会连正文一起改掉。
  //    实测一个 252 个面具的库里有 57 个正文自带标题行 —— 不是理论风险。
  function maskToMarkdown(m, exportedAt, level) {
    const h1 = '#'.repeat(level || 1);
    const h2 = '#'.repeat((level || 1) + 1);
    const head =
      `${h1} ${maskTitle(m)}\n\n` +
      `- 面具 ID：${m.maskId}\n` +
      (m.createdAt ? `- 创建时间：${new Date(m.createdAt).toLocaleString('zh-CN')}\n` : '') +
      `- 导出时间：${new Date(exportedAt).toLocaleString('zh-CN')}\n\n---\n`;
    // 六个字段一律留着，哪怕是空的 —— 空着也是事实，删掉了以后就看不出原来有没有
    const body = MASK_FIELDS
      .map(([k, label]) => {
        const v = String(m[k] == null ? '' : m[k]).trim();
        return `\n${h2} ${label}\n\n${v || '（空）'}\n`;
      })
      .join('');
    return head + body;
  }

  async function emitMasks(masks, opts, ts, report) {
    const exportedAt = new Date().toISOString();
    const base = `mufy_人设面具_${masks.length}个_${ts}`;

    if (!opts.split) {
      const text =
        `# 人设面具 · 共 ${masks.length} 个\n\n` +
        `导出时间：${new Date(exportedAt).toLocaleString('zh-CN')}\n\n` +
        masks.map((m) => '\n---\n\n' + maskToMarkdown(m, exportedAt, 2)).join('');
      download(base + '.md', text);
      if (opts.json) download(base + '.json', JSON.stringify({ exportedAt, count: masks.length, masks }, null, 2));
      report(`✅ 已合并导出 ${masks.length} 个面具`);
      return;
    }

    const used = new Set();
    const files = masks.map((m, i) => {
      const idx = String(i + 1).padStart(3, '0');
      let nm = `${idx}_${safeName(cut(maskTitle(m), 40))}.md`;
      while (used.has(nm)) nm = nm.replace(/\.md$/, '_.md');
      used.add(nm);
      return { name: nm, text: maskToMarkdown(m, exportedAt), date: new Date(m.createdAt || exportedAt) };
    });

    // 目录要用上面刚定好的文件名，所以必须在 unshift 之前算完
    const toc =
      `# 人设面具 · 共 ${masks.length} 个\n\n` +
      `导出时间：${new Date(exportedAt).toLocaleString('zh-CN')}\n\n` +
      `顺序与 mufy 面具库里的一致。\n\n` +
      (opts.maskNote ? `> 🔴 **${opts.maskNote}**\n\n` : '') +
      masks
        .map((m, i) => {
          const nm = String(m.maskName || '').trim();
          const g = String(m.gender || '').trim();
          return `${i + 1}. [${files[i].name}](${linkTarget(files[i].name)})　${nm}${g ? ' · ' + g : ''}`;
        })
        .join('\n') + '\n';

    files.unshift({ name: '00_目录.md', text: toc, date: new Date(exportedAt) });

    if (opts.json) {
      files.push({
        name: '_原始数据.json',
        text: JSON.stringify({ exportedAt, count: masks.length, masks }, null, 2),
        date: new Date(exportedAt),
      });
    }

    report(`打包 ${files.length} 个文件…`);
    const zip = await makeZip(files, (a, b) => report(`  压缩 ${a}/${b}`));
    downloadBlob(base + '.zip', zip);
    report(`✅ ${masks.length} 个面具已打包，ZIP 大小 ${(zip.size / 1048576).toFixed(2)} MB`);
  }

  // ---------- 角色卡（你自己创建的那些） ----------
  // 和面具一样是账号级的东西，但有三个坑，都是实测踩出来的：
  //
  //  1. **作者视角的完整卡片只在 POST /api/characters/metadata（body {id}）里。**
  //     GET /api/characters/get 是读者视角：人设、情节设定、输出设定、样例对话、正则
  //     一概没有，只有 45 个展示用字段。拿错接口会以为卡是空的。
  //  2. **「逆境处理」不在扁平字段里**，藏在 charaPromptJson.single.charaRole.adversityPrompt。
  //     多角色卡走 charaPromptJson.multi（数组）。
  //  3. **图片只有 URL**（cdn.mufy.ai），真要留底得自己去抓。实测那个 CDN 放行跨域。
  //
  // 为什么有这条路（官方明明有「导出引继码」）：那份 XML 把**小剧场**和**全局美化**
  // 整段 AES 加密了（base64 解开是 {salt,iv,ciphertext}），正文其余部分倒是明文、
  // 且与接口逐字一致（拿真实自制卡逐字段 SHA-256 比对过）。可那两块往往是整张卡里最长的部分，
  // 是卡主自己写的东西，在官方文件里自己读不了；图片也只有链接。
  // 我们不碰它的加密——**接口本来就给明文**，直接落地即可。

  const CARD_FIELDS = [
    ['description', '角色介绍'],
    ['charaPrompt', '人设'],
    ['__adversity', '逆境处理'],
    ['greeting', '开场设计'],
    ['codeRenderContent', '小剧场'],
    ['optimizationCode', '全局美化'],
    ['plotSetting', '情节设定'],
    ['outputSetting', '输出设定'],
    ['styleSamples', '样例对话与文风'],
    ['worldLore', '资料库'],
    ['items', '物品栏'],
    ['defaultMaskDescription', '默认认知'],
    ['__chef', '厨子の厨艺分享'],
  ];

  async function getMyCards(report) {
    const me = await api('/api/users/current');
    const uid = me && (me.userId || me.id);
    if (!uid) throw new Error('取不到你的用户 ID，请刷新 mufy 页面再试。');
    const rows = await api('/api/characters/list?creatorId=' + encodeURIComponent(uid));
    const list = Array.isArray(rows) ? rows : (rows && (rows.data || rows.list)) || [];
    if (report) report(`你创建了 ${list.length} 张角色卡。`);

    const out = [];
    for (const c of list) {
      if (!c.characterId) continue;
      report(`【${c.name}】读取完整卡片…`);
      out.push({ characterId: c.characterId, name: c.name, meta: await api('/api/characters/metadata', { id: c.characterId }) });
      await sleep(150);
    }
    return out;
  }

  // charaPromptJson 里的分角色信息。单角色卡在 single.charaRole，多角色卡在 multi[]。
  function cardRoles(meta) {
    const j = meta && meta.charaPromptJson;
    if (!j) return [];
    if (Array.isArray(j.multi) && j.multi.length) return j.multi;
    if (j.single && j.single.charaRole) return [j.single.charaRole];
    return [];
  }

  function cardAdversity(meta) {
    return cardRoles(meta)
      .map((r) => String((r && r.adversityPrompt) || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  // 值可能是字符串，也可能是数组/对象（资料库、物品栏）。对象一律按 JSON 落，别拍扁。
  function cardValue(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v) && !v.length) return '';
    if (typeof v === 'object') {
      const s = JSON.stringify(v, null, 2);
      return s === '{}' || s === '[]' || s === '{\n  "items": []\n}' ? '' : '```json\n' + s + '\n```';
    }
    return String(v);
  }

  function cardToMarkdown(card, exportedAt, level) {
    const m = card.meta || {};
    const h1 = '#'.repeat(level || 1);
    const h2 = '#'.repeat((level || 1) + 1);
    const h3 = '#'.repeat((level || 1) + 2);
    const yn = (b) => (b ? '是' : '否');

    let out =
      `${h1} ${card.name}\n\n` +
      `- 角色 ID：${card.characterId}\n` +
      `- 性别：${m.genderText || m.gender}　年龄：${m.age}\n` +
      `- NSFW：${yn(m.isNsfw)}　OC：${yn(m.isOc)}　AI 生成：${yn(m.isAi)}\n` +
      (m.tags && m.tags.length ? `- 标签：${m.tags.join('、')}\n` : '') +
      `- 导出时间：${new Date(exportedAt).toLocaleString('zh-CN')}\n`;

    // 图片：抓下来了就写文件名，没抓下来照实说，并留下原链接
    for (const im of card.images || []) {
      out += im.file
        ? `- ${im.label}：\`${im.file}\`（已随包保存）\n`
        : `- ${im.label}：**没抓下来**（${im.error}）　原链接：${im.url}\n`;
    }
    out += '\n---\n';

    for (const [k, label] of CARD_FIELDS) {
      const v =
        k === '__adversity' ? cardAdversity(m)
        : k === '__chef' ? [String(m.creatorDescriptionTitle || '').trim(), String(m.creatorDescription || '').trim()].filter(Boolean).join('\n')
        : cardValue(m[k]);
      out += `\n${h2} ${label}\n\n${v || '（空）'}\n`;
    }

    // 正则条目：一条一小节，别挤成一坨 JSON
    const rules = Array.isArray(m.regexRules) ? m.regexRules : [];
    out += `\n${h2} 正则条目（${rules.length} 条）\n`;
    if (!rules.length) out += '\n（空）\n';
    rules.forEach((r, i) => {
      out +=
        `\n${h3} ${i + 1}. ${r.ruleName || '(未命名)'}\n\n` +
        `- 启用：${yn(r.enabled)}　可见：${yn(r.visibility)}　模式：${r.mode}\n` +
        (r.targetSymbol ? `- 作用对象：${r.targetSymbol}\n` : '') +
        `\n**匹配**\n\n\`\`\`\n${r.regPattern || r.regexPattern || ''}\n\`\`\`\n` +
        `\n**替换为**\n\n\`\`\`\n${r.replaceString || ''}\n\`\`\`\n`;
    });

    return out;
  }

  // 图片走 cdn.mufy.ai。抓不到不算致命，记下来继续——但绝不静默跳过。
  async function fetchCardImages(card, report) {
    const m = card.meta || {};
    const want = [['头像', m.avatarUrl], ['封面', m.backgroundUrl]];
    const out = [];
    for (const [label, url] of want) {
      if (!url) continue;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        out.push({ label, url, file: `${label}.${ext}`, bytes: new Uint8Array(await blob.arrayBuffer()) });
      } catch (e) {
        report(`  ⚠️ 【${card.name}】${label}没抓下来：${e.message}`);
        out.push({ label, url, error: e.message });
      }
    }
    return out;
  }

  async function emitCards(cards, opts, ts, report) {
    const exportedAt = new Date().toISOString();
    const base = `mufy_角色卡_${cards.length}张_${ts}`;

    if (!opts.split) {
      // 合并模式不带图片（图是二进制，塞不进一份 md）
      const text =
        `# 我创建的角色卡 · 共 ${cards.length} 张\n\n` +
        `导出时间：${new Date(exportedAt).toLocaleString('zh-CN')}\n\n` +
        `> 这份不含图片。要图请改用「每张卡一个文件夹（打包成 ZIP）」。\n` +
        cards.map((c) => '\n---\n\n' + cardToMarkdown(c, exportedAt, 2)).join('');
      download(base + '.md', text);
      if (opts.json) download(base + '.json', JSON.stringify({ exportedAt, count: cards.length, cards: cards.map((c) => ({ characterId: c.characterId, name: c.name, meta: c.meta })) }, null, 2));
      report(`✅ 已合并导出 ${cards.length} 张角色卡（不含图片）`);
      return;
    }

    const files = [];
    const usedDir = new Set();
    const dirs = [];
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      let dir = `${String(i + 1).padStart(2, '0')}_${safeName(cut(c.name, 40))}`;
      while (usedDir.has(dir)) dir += '_';
      usedDir.add(dir);
      dirs.push(dir);

      report(`【${c.name}】抓图片…`);
      c.images = await fetchCardImages(c, report);

      files.push({ name: `${dir}/卡片.md`, text: cardToMarkdown(c, exportedAt, 1), date: new Date(exportedAt) });
      if (opts.json) {
        files.push({ name: `${dir}/卡片.json`, text: JSON.stringify({ characterId: c.characterId, name: c.name, meta: c.meta }, null, 2), date: new Date(exportedAt) });
      }
      for (const im of c.images) {
        if (im.bytes) files.push({ name: `${dir}/${im.file}`, bytes: im.bytes, date: new Date(exportedAt), store: true });
      }
    }

    const missing = cards.reduce((n, c) => n + (c.images || []).filter((x) => !x.file).length, 0);
    files.unshift({
      name: '00_目录.md',
      text:
        `# 我创建的角色卡 · 共 ${cards.length} 张\n\n` +
        `导出时间：${new Date(exportedAt).toLocaleString('zh-CN')}\n\n` +
        cards.map((c, i) => `${i + 1}. [${dirs[i]}/卡片.md](${linkTarget(dirs[i])}/%E5%8D%A1%E7%89%87.md)　${c.name}`).join('\n') +
        '\n\n> 「小剧场」和「全局美化」在官方的引继码 XML 里是加密的，这里是明文。\n' +
        (missing ? `\n> ⚠️ 有 ${missing} 张图片没抓下来，见各自卡片开头的红字。\n` : ''),
      date: new Date(exportedAt),
    });

    report(`打包 ${files.length} 个文件…`);
    const zip = await makeZip(files, (a, b) => report(`  压缩 ${a}/${b}`));
    downloadBlob(base + '.zip', zip);
    report(`✅ ${cards.length} 张角色卡已打包，ZIP 大小 ${(zip.size / 1048576).toFixed(2)} MB`);
    if (missing) report(`🔴 有 ${missing} 张图片没抓下来（卡片开头有记）。`);
  }

  // 一段对话的内容指纹。用来认出「同一份聊天记录被导了两遍」：
  // 在 mufy 里把某个存档**载入**之后，它同时又成了这个角色的「最后一次聊天」，
  // 于是存档那条路和 lastSessionId 那条路各给一个 sessionId，内容却一模一样
  // （用户报的症状：两段的条数和文件大小分毫不差）。
  // 🔴 不要为了比对去拼一个完整的大字符串 —— 一段一万轮的对话就是几 MB，
  //    几十段一起拼必然把内存顶爆（这脚本已经为 OOM 改过两版了）。
  //    这里逐字滚哈希，不留中间串；条数 + 总字数 + 两个独立哈希一起当键，
  //    要撞上得四项同时撞，实际就是同一份内容。
  function sessionFingerprint(s) {
    let h1 = 0x811c9dc5, h2 = 0x1505, n = 0;
    for (const m of s.dialogs || []) {
      const t = (m.role || '') + '\u0000' + contentToText(m.content);
      n += t.length;
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
        h2 = (Math.imul(h2, 33) + c) >>> 0;
      }
    }
    return `${(s.dialogs || []).length}:${n}:${h1.toString(36)}:${h2.toString(36)}`;
  }

  // 同一份内容的两段里留哪一段：有存档的优先（标题能用存档备注，时间也是真的），
  // 都有或都没有就留先遇到的那个。
  function betterOfDup(a, b) {
    const ar = (a.archives || []).length ? 1 : 0;
    const br = (b.archives || []).length ? 1 : 0;
    return br > ar ? b : a;
  }

  // 一批里最多攥多少字。超过就主动停手，别等浏览器杀进程（见下面 collectCharacter 里的说明）。
  // 4000 万字 ≈ 内存里 80MB 的字符串，而渲染 Markdown 还要再复制一份、打包又要一份，
  // 所以真实占用是这个数的三倍上下——已经贴着桌面浏览器的天花板了。
  // 只在「一批」的范围内计数：填了分批就自然不会撞到，这道闸是给没分批的人兜底的。
  const TOO_BIG_CHARS = 40000000;

  // ---------- 组装一个角色的导出内容 ----------
  // liveSessionId = 角色列表里的 lastSessionId，也就是这个角色"活着的"那段对话。
  // ⚠️ 只走存档列表会漏掉它：你聊过但从没按"保存"的对话，存档接口根本不列。
  //    实测在一个 200+ 角色的账号上，有 102 个角色属于这种情况，
//    合计 1356 条消息（最多的一个 112 条）曾被整段漏掉。
  // offset/limit 是「分批导」用的：**只抓这一批的对话**，打包完就放掉再抓下一批。
  // 光切 ZIP 不够——不切这里的话，一个角色的全部对话还是会先整个进内存
  // （有用户一万轮 / 178 段，光这一步就 out of memory）。
  // lastInteracted 只在角色列表那条记录上有（`characters/get` 的 45 个字段里没有），
  // 所以要从调用方一路带下来。它是「聊过但一条都取不到」这种情况下唯一的旁证：
  // 有互动时间 ＝ 你确实跟这个角色互动过，不是从没点开过。
  async function collectCharacter(characterId, opts, report, limit, liveSessionId, offset, lastInteracted) {
    const { name, greeting, lastSessionId } = await getCharacter(characterId);
    // 🔴 列表那条路会把 lastSessionId 传进来；「手动填 ID」和「当前角色」不会。
    //    不补上的话，一个只有「聊过没保存」内容的角色，用手动 ID 去导会导出 0 段——
    //    而同一个角色走「全部聊过的角色」却是有内容的。README 又恰好教人
    //    「失败了用手动填 ID 补一遍」，不补这里那句话就是错的。
    if (!liveSessionId && lastSessionId) liveSessionId = lastSessionId;
    report(`【${name}】读取存档列表…`);
    const archives = await getArchives(characterId);

    // 按 sourceSessionId 去重；同一 session 多次存档只跑一次
    const bySession = new Map();
    for (const a of archives) {
      const sid = a.sourceSessionId;
      if (!sid) continue;
      if (!bySession.has(sid)) bySession.set(sid, { sessionId: sid, archives: [] });
      bySession.get(sid).archives.push(a);
    }

    // 把当前正在聊的 session 也算进去（它可能还没存档）
    const cur = qs('sessionId');
    if (cur && qs('roleId') === characterId && !bySession.has(cur)) {
      bySession.set(cur, { sessionId: cur, archives: [], current: true });
    }
    // 这个角色最后聊的那段——没存过档就只能从这儿捞
    if (liveSessionId && !bySession.has(liveSessionId)) {
      bySession.set(liveSessionId, { sessionId: liveSessionId, archives: [], current: true });
    }

    let list = [...bySession.values()];
    // 🔴 分批必须切在排序之后，否则「第 1–50 段」是按接口返回的顺序切的，
    //    对人没有意义、批次之间也不稳定。这里用存档时间预排一次（新的在前），
    //    正在聊的那段没有存档时间，当作最新。抓完之后的最终排序用的是同一把尺子，
    //    所以批内顺序与整体一致。
    const preTime = (it) =>
      it.archives && it.archives.length ? new Date(it.archives[0].createdAt).getTime() || 0 : Infinity;
    // 排序方向跟着 opts.oldestFirst 走：分批是在这一步之后切的，
    // 所以把方向定在这里，批次范围、书名里的「第几到第几段」、段号才会全都一致。
    list.sort((a, b) => (opts.oldestFirst ? preTime(a) - preTime(b) : preTime(b) - preTime(a)));
    const totalSessions = list.length;
    const from = offset || 0;
    if (limit) list = list.slice(from, from + limit);
    else if (from) list = list.slice(from);
    report(
      limit || from
        ? `【${name}】共 ${archives.length} 条存档 / ${totalSessions} 段 → 本批抓第 ${from + 1}–${from + list.length} 段`
        : `【${name}】共 ${archives.length} 条存档 → ${list.length} 个对话待抓取`
    );

    const sessions = [];
    let i = 0;
    let acc = 0;              // 这一批已经攥在手里的正文字数
    for (const item of list) {
      i += 1;
      report(`【${name}】(${i}/${list.length}) 抓取 ${item.sessionId.slice(0, 8)}…`);
      const r = await getDialogs(item.sessionId, characterId);
      let dialogs = r.dialogs;
      let err = r.incomplete ? r.reason : null;
      // 接口报的总数是假的、我们又往后多翻出了东西 —— 这件事必须说一声，
      // 不然用户会以为「1000 条」就是全部（这正是 v1.33 要修的那个静默）。
      if (r.beyond) {
        report(`  📈 接口说只有 ${r.dialogs.length - r.beyond} 条，往后又翻出 ${r.beyond} 条，实际共 ${r.dialogs.length} 条。`);
      }
      if (r.incomplete) {
        opts.incompleteCount = (opts.incompleteCount || 0) + 1;
        // 光报个数量没用 —— 用户拿到「有 2 段没导完整」之后只能一个个文件点开找。
        // 把是谁、哪一段、差多少记下来，结尾直接列出来。
        (opts.incompleteList = opts.incompleteList || []).push({
          name,
          when: item.archives && item.archives.length
            ? String(item.archives[0].createdAt || '').slice(0, 10)
            : (dialogs.length ? String(dialogs[dialogs.length - 1].createdTime || '').slice(0, 10) : ''),
          reason: r.reason,
        });
        report(`  ⚠️ 不完整：${r.reason}`);
      }

      // 只有一条都没抓到才退回存档里那一问一答。
      // 千万别在「抓到一部分」时也退回去 —— 那等于把几百条换成 2 条。
      //
      // 🔴 这条退路以前是**完全沉默**的：接口对某个 session 一条对话都不给，
      //    我们就默默写下存档里那一问一答，出来是个 1KB 的文件、里面只有几句话，
      //    而用户以为那就是当年聊的全部（真收到过截图：同一个角色，别的段 2.8MB，
      //    这两段 1KB）。很久以前的存档特别容易这样。
      //    ——「部分成功必须能被看见」，所以现在标出来，并且给出救法：
      //    用户实测在 mufy 里把这个存档「载入」成当前对话后重新导，就能拿到全文。
      let fromArchiveOnly = false;
      if (!dialogs.length && item.archives.length) {
        const a = item.archives[0];
        dialogs = [
          { role: 'user', content: a.user_content, createdTime: a.createdAt, __fromArchive: true },
          { role: 'assistant', content: a.assistant_content, createdTime: a.createdAt, __fromArchive: true },
        ];
        fromArchiveOnly = true;
        opts.stubCount = (opts.stubCount || 0) + 1;
        (opts.stubList = opts.stubList || []).push({
          name,
          when: String(item.archives[0].createdAt || '').slice(0, 10),
          remark: item.archives.map((x) => x.remark).filter(Boolean).join(' / '),
        });
        report(`  🔴 只拿到存档摘要（接口一条对话都没给），这段要去 mufy 里「载入」后重导`);
      }

      sessions.push({
        sessionId: item.sessionId,
        isCurrent: !!item.current,
        fromArchiveOnly,
        archives: item.archives.map((a) => ({
          archiveId: a.archiveId,
          remark: a.remark || '',
          createdAt: a.createdAt,
        })),
        error: err,
        incomplete: !!r.incomplete,
        expectedCount: r.expected,
        messageCount: dialogs.length,
        dialogs,
      });

      // 🔴 在浏览器把整个标签页干掉之前先停手。
      //    有用户一万轮 / 178 段，而且每轮都手工粘了几万字的长期记忆——
      //    抓到第 40 段左右**渲染进程直接被杀**（浏览器自己弹「此页存在问题 / Out of Memory」）。
      //    进程一死，我们的 try/catch、日志、面板全都没了，
      //    「内存不够就填分批」这句话根本没机会说出口。所以必须**主动**停。
      //    判据用「攥在手里的字数」而不是「段数」：段多但每段很小是完全没问题的
      //    （实测 53 段一次导没事），真正撑爆浏览器的是内容体量。
      acc += dialogs.reduce((n, d) => n + (typeof d.content === 'string'
        ? d.content.length
        : (d.content ? JSON.stringify(d.content).length : 0)), 0);
      if (acc > TOO_BIG_CHARS) {
        const 万 = Math.round(acc / 10000);
        throw new Error(
          `这个角色太大了：才抓到第 ${i} 段就已经有约 ${万} 万字堆在内存里，` +
          `再往下多半会把整个标签页撑爆（浏览器直接崩，连日志都留不下）。` +
          (opts.chunk
            ? `你已经填了「每包最多 ${opts.chunk} 段」，请再调小一点（比如 ${Math.max(1, Math.floor(opts.chunk / 2))}）。`
            : `请在面板的「每包最多多少段对话」里填 5 再导一次——` +
              `它会改成一批批地抓、抓完打包就放掉，内存峰值只跟一批有关。`)
        );
      }
      await sleep(150);
    }

    // 一条消息都没有的段（比如从没说过话的角色）不值得单独出一个文件
    let kept = sessions.filter((s) => s.messageCount > 0);

    // 内容完全相同的两段只留一份（见 sessionFingerprint 上面那段说明）。
    // ⚠️ 只在「一字不差」时才合并 —— 载入存档之后又接着聊过的，条数就不一样了，
    //    那是两段真不同的记录，绝不能碰。
    // ⚠️ 分批导时，两段可能落在不同批里，所以指纹表挂在 opts 上跨批复用；
    //    角色一换就清空（同一个角色的几批是连着跑的）。跨批撞上的那段只能在
    //    日志和结尾清单里说，因为先出的那一批文件已经打包发出去了。
    if (opts._fpChar !== characterId) { opts._fpChar = characterId; opts._fpSeen = new Map(); }
    if (kept.length) {
      const groups = new Map();
      for (const s of kept) {
        const fp = sessionFingerprint(s);
        s.__fp = fp;
        if (!groups.has(fp)) groups.set(fp, []);
        groups.get(fp).push(s);
      }
      const survivors = [];
      for (const [fp, group] of groups) {
        const prev = opts._fpSeen.get(fp);
        const keep = group.reduce(betterOfDup);
        const dropped = group.filter((s) => s !== keep);
        if (prev) {
          // 前面的批次已经导过同样的内容了，这一整组都不用再出文件
          for (const s of group) {
            (opts.dupList = opts.dupList || []).push({ name, kept: prev.title, dropped: sessionTitle(s) });
          }
          report(`  🔁 有 ${group.length} 段和前面某一批里的「${prev.title}」内容完全相同，不再重复出文件`);
          continue;
        }
        for (const s of dropped) {
          keep.mergedFrom = keep.mergedFrom || [];
          keep.mergedFrom.push({ sessionId: s.sessionId, title: sessionTitle(s), isCurrent: !!s.isCurrent });
          (opts.dupList = opts.dupList || []).push({ name, kept: sessionTitle(keep), dropped: sessionTitle(s) });
        }
        if (dropped.length) {
          report(`  🔁 「${sessionTitle(keep)}」和另 ${dropped.length} 段内容完全相同，已合并成一份`);
        }
        opts._fpSeen.set(fp, { title: sessionTitle(keep) });
        survivors.push(keep);
      }
      kept = survivors;
    }

    // 默认新的排前面（备份场景：查最近的最方便）；电子书那条路反过来，按时间正序
    kept.sort((a, b) => (opts.oldestFirst ? sessionTime(a) - sessionTime(b) : sessionTime(b) - sessionTime(a)));

    // 🔴 「一段都没留下」有两种，性质完全不同，不许混为一谈：
    //    ① 从没点开过这个角色 —— 那连 session 都不会有，走不到这儿；
    //    ② **你确实互动过，但接口现在一条正文都给不出来**（total 直接是 0、也没有存档）。
    //    ②看起来跟①一模一样，而它其实是「那段记录在 mufy 那边没了」的信号 ——
    //    实测过一个账号上的两个角色：最后互动时间明明白白是四月，接口 total=0、存档 0 条。
    //    ——而这个账号的主人一口咬定「我跟它们聊过」。她是对的：
    //    「一条都取不到」和「从没聊过」在数据上长得一样，但对人来说是两件事。
    //    所以这里把事实记下来，让产物照实说，不替 mufy 打圆场也不冤枉用户的记性。
    const noContent = kept.length === 0 && sessions.length > 0;

    return {
      characterId, name, greeting, archiveCount: archives.length, sessions: kept,
      totalSessions, batchFrom: from, // 分批时给调用方判断还有没有下一批
      noContent, lastInteracted: lastInteracted || null,
      exportedAt: new Date().toISOString(),
    };
  }

  // 一个「一段对话都没有」的角色，日志该怎么说。
  // 🔴 别写成「没聊过」——记得自己聊过的人会立刻知道你在瞎说（真被当场纠正过）。
  //    有互动时间就把它摆出来，让人自己判断是「我确实没聊」还是「记录没了」。
  function emptyWhy(pack) {
    const d = pack && pack.lastInteracted ? String(pack.lastInteracted).slice(0, 10) : '';
    if (pack && pack.noContent) {
      return `接口一条对话都取不到${d ? `（最后互动 ${d}）` : ''}，先把开场白留下了`;
    }
    return '只有开场白，没有对话记录 —— 也给你留了一份';
  }

  // 一段对话的代表时间：存档时间优先，否则用最后一条消息
  function sessionTime(s) {
    if (s.archives && s.archives.length) {
      const t = new Date(s.archives[0].createdAt);
      if (!isNaN(t)) return t;
    }
    if (s.dialogs && s.dialogs.length) {
      const t = new Date(s.dialogs[s.dialogs.length - 1].createdTime || 0);
      if (!isNaN(t)) return t;
    }
    return new Date(0);
  }

  // 一段对话的标题：存档备注优先，否则用时间
  function sessionTitle(s) {
    if (s.archives && s.archives.length) {
      const named = s.archives.map((a) => a.remark).filter(Boolean);
      if (named.length) return named.join(' / ');
    }
    if (s.isCurrent) return '未存档的最后一段';
    return new Date(sessionTime(s)).toLocaleString('zh-CN');
  }

  // 文件名里的那截线索。她大部分存档都没写备注，
  // 这时候再把日期写第二遍没意义（而且冒号会被替成下划线，很难看），
  // 改成截一小段开头正文，肉眼扫文件名就能认出是哪一段。
  function fileSlug(s) {
    if (s.archives && s.archives.length) {
      const named = s.archives.map((a) => a.remark).filter(Boolean);
      if (named.length) return cut(safeName(named.join('_')), 24);
    }
    // 助手的第一行通常是「时间 • 天气 • 地点」的场景抬头，比用户那句 $指令 好认太多。
    // 开头那截剧情内时间对找文件没用，而且斜杠会被替成下划线，砍掉只留景。
    const pick = (role) => {
      const m = (s.dialogs || []).find((d) => d.role === role && tidy(contentToText(d.content)).trim());
      if (!m) return '';
      return tidy(contentToText(m.content)).split('\n').map((x) => x.trim()).find(Boolean) || '';
    };

    let line = pick('assistant').replace(
      /^\s*\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}(?:[/\s]\d{1,2}[:：]\d{2})?\s*[•·・\-—|]*\s*/,
      ''
    );
    if (!line) line = pick('user');
    // 没存档的那段在文件名里标出来，免得和存档段混在一起分不清
    return (s.isCurrent ? '未存档_' : '') + cut(safeName(line.replace(/[•・]/g, '·')), 26);
  }

  // ---------- 渲染 Markdown ----------
  function renderMessages(pack, s, opts) {
    const L = [];
    if (!s.dialogs.length) L.push('_（这个对话取不到内容）_', '');
    for (const m of s.dialogs) {
      const who = m.role === 'user' ? '🩷 我' : m.role === 'assistant' ? `🖤 ${pack.name}` : m.role;
      const t = m.createdTime ? new Date(m.createdTime).toLocaleString('zh-CN') : '';
      let body = contentToText(m.content);
      if (opts.tidy) body = tidy(body);
      if (!body.trim()) continue;
      L.push(`**${who}**　<sub>${t}</sub>`, '', body, '');
    }
    return L;
  }

  // 单段对话 → 独立的一份 .md
  function toMarkdownOne(pack, s, idx, opts) {
    const L = [];
    L.push(`# ${pack.name} · ${sessionTitle(s)}`);
    L.push('');
    L.push(`- 第 ${idx} 段　消息 ${s.messageCount} 条`);
    L.push(`- session \`${s.sessionId}\``);
    if (s.archives.length) L.push(`- 存档时间：${new Date(s.archives[0].createdAt).toLocaleString('zh-CN')}`);
    else L.push('- ⚠️ 这段没有存档，是从「最后一次聊天」里直接捞出来的');
    if (s.mergedFrom && s.mergedFrom.length) {
      L.push(`- 🔁 另有 ${s.mergedFrom.length} 段内容与这一份**一字不差**，已合并（不再单独出文件）：` +
             s.mergedFrom.map((d) => `「${d.title}」\`${d.sessionId}\``).join('、'));
      L.push('  多半是你在 mufy 里**载入过这个存档**，于是它同时又成了「最后一次聊天」，');
      L.push('  一份记录就走了两条路。合并只去掉重复的那份，内容一个字没少。');
    }
    if (s.fromArchiveOnly) {
      L.push('');
      L.push('> 🔴 **这一段只有存档摘要，不是完整对话。**');
      L.push('> 接口对这个 session 一条对话都没返回，下面这一问一答是从存档记录本身抄下来的——');
      L.push('> 存档只存这一对，所以这篇会比当年真聊的那些短得多（常见的只剩 1KB 上下）。');
      L.push('> 很久以前的存档特别容易这样。');
      L.push('>');
      L.push('> **有办法救**：去 mufy 里把这个存档**载入**（让它变成你当前正在聊的那段），');
      L.push('> 然后重新导出这个角色。载入之后接口就给得出全文了——这是用户实测有效的做法。');
      L.push('');
    }
    if (s.incomplete) {
      L.push('');
      L.push(`> 🔴 **这一段没导完整。** ${s.error || ''}`);
      // 「取失败」才是网络问题；「接口说共 N 条只取到 M 条」已经查实是 mufy 那边丢了，
      // 对这种情况说「重跑一次通常就好」是空头支票，重跑多少次都是这么多。
      if (/取失败|页数超过/.test(s.error || '')) {
        L.push('> 多半是抓取途中网络出了问题。重跑一次这个角色通常就好了。');
      }
      L.push('');
    } else if (s.error) {
      L.push(`- ⚠️ ${s.error}`);
    }
    if (opts.tidy) L.push('- 已清理 `<think>` 与状态栏 HTML');
    L.push('', '---', '');
    L.push(...renderMessages(pack, s, opts));
    return L.join('\n');
  }

  // 全部对话 → 合并成一份 .md
  function toMarkdown(pack, opts) {
    const L = [];
    const total = pack.sessions.reduce((n, s) => n + s.messageCount, 0);
    L.push(`# ${pack.name}`);
    L.push('');
    L.push(`- 角色 ID：\`${pack.characterId}\``);
    L.push(`- 存档数：${pack.archiveCount}　对话数：${pack.sessions.length}　消息数：${total}`);
    L.push(`- 导出时间：${new Date(pack.exportedAt).toLocaleString('zh-CN')}`);
    if (opts.tidy) L.push('- 已清理 `<think>` 与状态栏 HTML（完整原文请看 JSON）');
    L.push('', '---', '');
    if (pack.greeting) {
      const g = opts.tidy ? tidy(pack.greeting) : pack.greeting;
      if (g.trim()) L.push('## 开场白', '', '> 角色卡自带，不属于任何一段对话', '', g, '', '---', '');
    }

    pack.sessions.forEach((s, idx) => {
      L.push(`## ${String(idx + 1).padStart(2, '0')}. ${sessionTitle(s)}`);
      L.push('');
      L.push(`> session \`${s.sessionId}\`　消息 ${s.messageCount} 条${s.error ? '　⚠️ ' + s.error : ''}`);
      if (s.mergedFrom && s.mergedFrom.length) {
        L.push('>');
        L.push(`> 🔁 另有 ${s.mergedFrom.length} 段与这一份一字不差，已合并（你在 mufy 里载入过这个存档，` +
               '它同时又是「最后一次聊天」）。');
      }
      if (s.fromArchiveOnly) {
        L.push('>');
        L.push('> 🔴 **这一段只有存档摘要，不是完整对话**：接口一条对话都没返回，下面这一问一答是从' +
               '存档记录本身抄的，比当年真聊的那些短得多。救法——去 mufy 里把这个存档**载入**成' +
               '当前对话，再重新导出这个角色。');
      }
      L.push('');
      L.push(...renderMessages(pack, s, opts));
      L.push('---', '');
    });

    return L.join('\n');
  }

  // ---------- EPUB（电子书） ----------
  // 这一整段是 make-epub.py 的逐行移植：EPUB 说到底就是一个结构固定的 ZIP，
  // 上面已经有 ZIP 了，所以浏览器里能直接出书 —— 不用装 Python，手机上也能导。
  // ⚠️ 改这里的任何一条判据，请连 make-epub.py 一起改，否则两边出的书会不一样。

  // 和 Python 版同一套清洗：EPUB 是 XHTML，标签必须全部拆掉再转义，不能留半个。
  function stripTags(t) {
    return String(t)
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/^[ \t]+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 卡里给模型看的脚手架，读小说时是纯噪音。只删明确是指令的行。
  function dropMachinery(t) {
    const keep = String(t).split('\n').filter(
      (l) => !/\[\s*(规则|AI\s*填充)\s*[:：]|待生成|【\s*规则\s*】/.test(l)
    );
    return keep.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // 书里放不了远端图片（离线就是个叉），和 Python 版一样只留一个占位
  function contentToTextEpub(c) {
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return c == null ? '' : JSON.stringify(c);
    const out = [];
    for (const p of c) {
      if (p == null) continue;
      if (typeof p === 'string') out.push(p);
      else if (p.type === 'text' || typeof p.text === 'string') out.push(p.text || '');
      else if (p.url) out.push('［图片］');
    }
    return out.join('\n');
  }

  // html.escape(quote=False) 的等价物。& 必须第一个换，否则会把后面换出来的 &lt; 再吃一遍。
  const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 按「字符」截断，不是按码元。
  // ⚠️ 上面那个 cut() 是按 UTF-16 码元截的（为了不把 emoji 劈成两半），
  //    但 emoji / 花体字一个字符占两个码元，所以同样写 28，cut() 只截到 14 个字。
  //    真实存档里有 3 个角色的标题因此和 Python 版对不上（'𝑒𝓇 𝒹𝑒𝒶𝒹' 这种）。
  //    展开成数组再切是按码点走的，和 Python 的 s[:n] 同义，也照样不会劈开代理对。
  const cutChars = (s, n) => [...String(s)].slice(0, n).join('');

  // 章节标题：存档备注优先，否则拿助手第一句（砍掉剧情内时间抬头）
  function chapterTitleEpub(s, i) {
    const remark = (s.archives || []).map((a) => a.remark).filter(Boolean).join(' / ');
    if (remark) return remark;
    for (const m of (s.dialogs || [])) {
      if (m.role !== 'assistant') continue;
      const body = stripTags(contentToTextEpub(m.content));
      let line = body.split('\n').map((x) => x.trim()).find(Boolean) || '';
      if (!line) continue;
      line = line.replace(/^\s*\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}(?:[/\s]\d{1,2}[:：]\d{2})?\s*[•·・\-—|]*\s*/, '');
      if (line) return cutChars(line, 28);
    }
    return `第 ${i} 段`;
  }

  // 必须是合法 UUID 格式。早先 Python 版拿 sha1 十六进制串直接冒充，epubcheck 报 OPF-085。
  // uuid5 既确定（同一个角色永远同一个 id，重导不会变成"另一本书"），格式又合规。
  // 这里刻意和 Python 用同一个命名空间和同一句 'mufy:'+id —— 两边出的书 ID 必须一模一样。
  const UUID_NS_URL = [0x6b,0xa7,0xb8,0x11,0x9d,0xad,0x11,0xd1,0x80,0xb4,0x00,0xc0,0x4f,0xd4,0x30,0xc8];

  async function uuid5(name) {
    const nb = new TextEncoder().encode(name);
    const buf = new Uint8Array(UUID_NS_URL.length + nb.length);
    buf.set(UUID_NS_URL, 0);
    buf.set(nb, UUID_NS_URL.length);
    let h;
    try {
      h = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
    } catch (e) {
      // crypto.subtle 只在 https / localhost 下有。退到一个确定性的凑数散列：
      // 格式仍然合规、同一角色仍然稳定，只是和 Python 版对不上号。
      h = new Uint8Array(20);
      let a = 0x811c9dc5;
      for (let i = 0; i < buf.length; i++) { a = (a ^ buf[i]) >>> 0; a = Math.imul(a, 0x01000193) >>> 0; h[i % 20] ^= (a >>> ((i % 4) * 8)) & 0xff; }
    }
    h[6] = (h[6] & 0x0f) | 0x50;   // 版本 5
    h[8] = (h[8] & 0x3f) | 0x80;   // 变体
    const hex = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  }

  const EPUB_CSS = `@charset "utf-8";
body { font-family: serif; line-height: 1.85; margin: 0 6%; text-align: justify;
       -webkit-hyphens: none; hyphens: none; }
h1 { font-size: 1.35em; font-weight: normal; line-height: 1.5; margin: 2.2em 0 .3em;
     text-align: left; }
.meta { font-size: .78em; color: #777; margin: 0 0 2.4em; padding-bottom: .8em;
        border-bottom: 1px solid #ddd; }
.note { font-size: .82em; color: #777; margin: 0 0 2em; }
.who { font-size: .72em; color: #999; letter-spacing: .12em; margin: 1.8em 0 .35em; }
p { margin: 0 0 .85em; text-indent: 0; }
.me { color: #555; font-size: .93em; border-left: 3px solid #ddd;
      padding-left: .9em; margin-left: 0; }
.me .who { color: #a06a20; }
`;

  const EPUB_CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

  function paraHtml(text, cls) {
    return String(text).split('\n').filter((b) => b.trim())
      .map((b) => `<p${cls ? ` class="${cls}"` : ''}>${escXml(b)}</p>`).join('\n');
  }

  function chapterXhtml(title, meta, bodyHtml) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><meta charset="utf-8"/><title>${escXml(title)}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>
<h1>${escXml(title)}</h1>
${meta ? `<p class="meta">${escXml(meta)}</p>` : ''}
${bodyHtml}
</body></html>
`;
  }

  // 封面：竖排书名，和 Python 版同一套版式，只是画笔从 PIL 换成 canvas。
  // 字体用系统 serif（手机上就是自带的宋体/思源宋），所以不用带任何字体文件。
  function drawCover(name, subtitle) {
    return new Promise((resolve) => {
      try {
        const W = 1200, H = 1600;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        if (!g) return resolve(null);
        g.fillStyle = '#f7f5f1'; g.fillRect(0, 0, W, H);
        g.textBaseline = 'top';   // PIL 的 text() 是左上角对齐，canvas 默认是基线

        g.fillStyle = '#111111';
        g.font = '116px serif';
        let x = W - 200, y = 210, col = 0;
        for (const ch of cutChars(name, 24)) {   // 同上：按字符不按码元
          g.fillText(ch, x - col * 140, y);
          y += 132;
          if (y > H - 520) { y = 210; col += 1; }
        }

        g.strokeStyle = '#111111'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(150, H - 380); g.lineTo(270, H - 380); g.stroke();

        g.fillStyle = '#6c6862'; g.font = '38px serif';
        g.fillText(subtitle, 150, H - 340);
        g.fillStyle = '#96928c'; g.font = '30px serif';
        g.fillText('mufy 存档', 150, H - 250);

        cv.toBlob(async (b) => {
          if (!b) return resolve(null);
          try { resolve(new Uint8Array(await b.arrayBuffer())); } catch (e) { resolve(null); }
        }, 'image/png');
      } catch (e) {
        resolve(null);   // 封面画不出来不该拖垮整本书
      }
    });
  }

  // pack → EPUB Blob。没有一章能成书就返回 null。
  // coverFn(章数) → Promise<Uint8Array|null>：封面得等章数点清楚了才画（副标题上写着章数），
  // 所以这里收的是个回调而不是现成的图。传 null 就是不要封面。
  async function buildEpub(pack, coverFn) {
    const name = pack.name || '未命名';
    const cid = pack.characterId || '';
    const uid = 'urn:uuid:' + (await uuid5('mufy:' + (cid || name)));
    const sessions = pack.sessions || [];

    const chapters = [];   // { file, title, xhtml }

    const g = dropMachinery(stripTags(pack.greeting || ''));
    if (g) {
      chapters.push({
        file: 'ch000.xhtml', title: '开场白',
        xhtml: chapterXhtml('开场白', '角色卡自带，不属于任何一段对话', paraHtml(g)),
      });
    }

    sessions.forEach((s, n) => {
      const i = n + 1;
      const title = chapterTitleEpub(s, i);
      const arch = s.archives || [];
      const when = arch.length ? String(arch[0].createdAt || '').slice(0, 10) : '未存档的最后一段';
      const parts = [];
      for (const m of (s.dialogs || [])) {
        const body = dropMachinery(stripTags(contentToTextEpub(m.content)));
        if (!body) continue;
        const me = m.role === 'user';
        parts.push(`<div class="${me ? 'me' : 'ta'}">`
          + `<p class="who">${escXml(me ? '我' : name)}</p>`
          + `${paraHtml(body)}</div>`);
      }
      if (!parts.length) return;
      const meta = `第 ${i} / ${sessions.length} 段　·　${s.messageCount || 0} 条　·　${when}`;
      chapters.push({
        file: `ch${String(i).padStart(3, '0')}.xhtml`, title,
        xhtml: chapterXhtml(title, meta, parts.join('\n')),
      });
    });

    if (!chapters.length) return null;

    const coverBytes = coverFn ? await coverFn(chapters.length) : null;

    const manifest = [], spine = [], navlis = [], ncxpts = [];
    if (coverBytes) {
      manifest.push('<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>');
      manifest.push('<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>');
      // 别标 linear="no"：那样封面就成了"非线性内容"，规范要求必须有页面链接到它，
      // 否则 epubcheck 报 OPF-096。封面放进阅读顺序第一页最省事，阅读器也都这么认。
      spine.push('<itemref idref="cover"/>');
    }
    chapters.forEach((c, k) => {
      const n = k + 1;
      manifest.push(`<item id="c${n}" href="text/${c.file}" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="c${n}"/>`);
      navlis.push(`<li><a href="text/${c.file}">${escXml(c.title)}</a></li>`);
      ncxpts.push(`<navPoint id="n${n}" playOrder="${n}"><navLabel><text>${escXml(c.title)}</text></navLabel>`
        + `<content src="text/${c.file}"/></navPoint>`);
    });

    const total = sessions.reduce((n, s) => n + (s.messageCount || 0), 0);
    const modified = String(pack.exportedAt || '2026-01-01T00:00:00Z').slice(0, 19) + 'Z';

    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${uid}</dc:identifier>
    <dc:title>${escXml(name)}</dc:title>
    <dc:creator>mufy 存档</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:description>${escXml(`${chapters.length} 章，${total} 条消息。由 mufy-batch-export 导出。`)}</dc:description>
    <meta property="dcterms:modified">${modified}</meta>
    ${coverBytes ? '<meta name="cover" content="cover-img"/>' : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${manifest.map((m) => '    ' + m).join('\n')}
  </manifest>
  <spine toc="ncx">
${spine.map((s) => '    ' + s).join('\n')}
  </spine>
</package>
`;

    const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>
${navlis.join('\n')}
</ol></nav></body></html>
`;

    const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh-CN">
  <head><meta name="dtb:uid" content="${uid}"/></head>
  <docTitle><text>${escXml(name)}</text></docTitle>
  <navMap>
${ncxpts.join('\n')}
  </navMap>
</ncx>
`;

    const when = new Date(pack.exportedAt || Date.now());
    const F = (n, text) => ({ name: n, text, date: when });
    const files = [
      // ⚠️ mimetype 必须是第一个条目、且不压缩
      { name: 'mimetype', text: 'application/epub+zip', date: when, store: true },
      F('META-INF/container.xml', EPUB_CONTAINER),
      F('OEBPS/content.opf', opf),
      F('OEBPS/nav.xhtml', nav),
      F('OEBPS/toc.ncx', ncx),
      F('OEBPS/style.css', EPUB_CSS),
    ];
    if (coverBytes) {
      files.push({ name: 'OEBPS/images/cover.png', bytes: coverBytes, date: when });
      files.push(F('OEBPS/text/cover.xhtml',
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n'
        + '<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head>'
        + '<meta charset="utf-8"/><title>封面</title></head><body style="margin:0">'
        + '<img src="../images/cover.png" alt="封面" style="width:100%"/>'
        + '</body></html>'));
    }
    for (const c of chapters) files.push(F(`OEBPS/text/${c.file}`, c.xhtml));

    const blob = await makeZip(files, null, 'application/epub+zip');
    return { blob, chapters: chapters.length, total };
  }

  // ---------- 落盘 ----------
  // ---------- 酒馆对话格式 ----------
  // 一段存档 = 一个 .jsonl 文件，和酒馆「一个角色下多个对话」的语义正好对上。
  // 格式是照真实的酒馆对话文件抄的（不是照文档猜的）：
  //   第 1 行  {"user_name":..., "character_name":..., "chat_metadata":{}}
  //   之后每行 {"name","is_user","is_system","send_date","mes","extra"}
  // 真文件里还有 swipe_id / swipes / swipe_info（swipe 过才有）以及扩展塞的字段，
  // 那些不是必需的，我们不编。
  //
  // ⚠️ **不放开场白**：酒馆的第一条消息来自角色卡的 first_mes，
  //    我们再塞一条进去就会出现两次。
  function sessionToTavern(pack, s, opts) {
    const userName = 'You';
    const head = JSON.stringify({
      user_name: userName,
      character_name: pack.name,
      chat_metadata: {},
    });
    const rows = (s.dialogs || []).map((d) => {
      const isUser = d.role === 'user';
      let text = contentToText(d.content);
      if (opts.tidy) text = tidy(text);
      return JSON.stringify({
        name: isUser ? userName : pack.name,
        is_user: isUser,
        is_system: false,
        send_date: d.createdTime || new Date(pack.exportedAt).toISOString(),
        mes: text,
        extra: {},
      });
    });
    return [head, ...rows].join('\n') + '\n';
  }

  // 🔴 `JSON.stringify(pack, null, 2)` 在超大角色上会抛 `Invalid string length` ——
  //    那不是内存耗尽，是**单个字符串超过了 JS 引擎的上限**（V8 约 5 亿字符），
  //    而缩进本身就能让体积接近翻倍。有用户导某个角色时整轮失败、面板里连下载链接都没有，
  //    报的就是这个。
  // 退让三级：带缩进 → 不带缩进 → 一段一个 JSON。全都失败才放弃，并且照实说。
  function packJsonFiles(pack, report, date) {
    try {
      return [{ name: '_原始数据.json', text: JSON.stringify(pack, null, 2), date }];
    } catch (e) {
      report('  ⚠️ 完整备份太大，去掉缩进再试…');
    }
    try {
      return [{ name: '_原始数据.json', text: JSON.stringify(pack), date }];
    } catch (e) {
      report('  ⚠️ 还是太大，改成一段一个 JSON 文件。');
    }
    const head = { ...pack, sessions: undefined };
    const out = [];
    try {
      out.push({ name: '_原始数据/00_角色.json', text: JSON.stringify(head, null, 2), date });
    } catch (e) { /* 连角色头都写不下就算了，下面每段照样各自尝试 */ }
    let failed = 0;
    pack.sessions.forEach((sess, i) => {
      const nm = `_原始数据/${String(i + 1).padStart(2, '0')}_${sess.sessionId.slice(0, 8)}.json`;
      try { out.push({ name: nm, text: JSON.stringify(sess), date }); }
      catch (e) { failed += 1; }
    });
    if (failed) report(`  🔴 有 ${failed} 段连单独的 JSON 都写不下，这几段只有 Markdown 版本。`);
    return out;
  }

  async function emit(pack, opts, ts, report) {
    // 重名角色真的存在（同一个名字下挂着两个不同的 characterId，实测遇到过好几对）。
    // 不加区分的话两个包会撞名，靠浏览器补 " (1)"，事后根本分不出谁是谁。
    // ⚠️ bt / tag 必须在最前面定义：下面判重和拼文件名都要用。
    //    放到后面会 TDZ —— 真踩过：每个角色都抛 "Cannot access 'bt' before initialization"，
    //    还被逐角色的 try/catch 接住，表面上只看到「这次没有产生任何文件」，很难联想到是这儿。
    const bt = pack.batch; // {from, to, total} —— 不分批时为 undefined
    const tag = bt ? `_第${bt.from}-${bt.to}段` : ''; // 分批时文件名带「第几到第几段」

    // 比对的是规整之后的名字（和上面数重名时用的是同一把尺子）
    const safe = safeName(pack.name);
    const dup = opts.dupNames && opts.dupNames.has(safe);
    // ⚠️ 判重的键必须**带上批次标签**：同一个角色分成几批时，
    //    每批的文件名本来就靠这个标签区分，不带它会把自己的第 2、3 批当成撞名，
    //    白白补上 characterId 和下划线（真踩过，日志里出现过 `_b5241d__`）。
    let stem = `${safe}${dup ? '_' + pack.characterId.slice(0, 6) : ''}`;
    // 兜底：万一预扫没算到（比如列表里的名字和角色卡上的名字不一致），
    // 运行期再挡一道，绝不让两个角色写出同一个文件名。
    if (opts.usedStems) {
      if (opts.usedStems.has(stem + tag)) stem = `${safe}_${pack.characterId.slice(0, 6)}`;
      while (opts.usedStems.has(stem + tag)) stem += '_';
      opts.usedStems.add(stem + tag);
    }
    const base = `mufy_${stem}_${ts}${tag}`;

    if (opts.shape === 'epub') {
      // 书名就是文件名，不加 mufy_ 前缀也不加时间戳 —— 导进图书类 App 之后，
      // 书架上显示的就是这一行，让它干干净净的。
      report(`【${pack.name}】做成电子书…`);
      const r = await buildEpub(pack, (n) => drawCover(pack.name, `${n} 章`));
      if (!r) { report(`【${pack.name}】没有可成书的内容，跳过。`); return false; }
      downloadBlob(`${stem}${tag}.epub`, r.blob);
      report(`  ${r.chapters} 章 / ${r.total} 条　${(r.blob.size / 1048576).toFixed(2)} MB`);
      return true;
    }

    if (opts.shape === 'tavern') {
      const used = new Set();
      const files = pack.sessions
        .filter((s) => (s.dialogs || []).length)
        .map((s, i) => {
          const slug = fileSlug(s);
          let nm = `${String(i + 1).padStart(2, '0')}_${stamp(sessionTime(s))}${slug ? '_' + slug : ''}.jsonl`;
          while (used.has(nm)) nm = nm.replace(/\.jsonl$/, '_.jsonl');
          used.add(nm);
          return { name: nm, text: sessionToTavern(pack, s, opts), date: sessionTime(s) };
        });
      // 酒馆这条路故意不放开场白（首条来自卡自己的 first_mes，塞进去会重复），
      // 所以「只有开场白」的角色在这里是真的没东西可导 —— 照实说，别谎报成功。
      if (!files.length) { report(`【${pack.name}】没有可导出的对话，跳过。`); return false; }

      files.unshift({
        name: '00_导入说明.md',
        text:
          `# ${pack.name} · 导入酒馆\n\n` +
          `这里是 ${files.length} 段对话，一段一个 \`.jsonl\`，都是酒馆的对话格式。\n\n` +
          `## 怎么导\n\n` +
          `1. 先在酒馆里**建好这个角色的卡**（名字建议和这里一致）。\n` +
          `2. 选中那个角色 → 对话列表 → **导入对话**，选一个 \`.jsonl\`。\n` +
          `3. 一段存档一个文件，想导几段就导几段；酒馆本来就支持一个角色挂多个对话。\n\n` +
          `## 三件要先知道的事\n\n` +
          `- **没有放开场白。** 酒馆的第一条消息来自角色卡自己的开场白，\n` +
          `  这里再塞一条就会重复。角色卡的开场白原文在同一次导出的 ZIP 里（\`00_开场白.md\`）。\n` +
          `- **模型只看得到最近的一段。** 导进去几千条，模型也只读得到能塞进上下文的那些，\n` +
          `  更早的对你是存档、对它不是记忆。要让它记住早期设定，用酒馆的总结／作者注释／世界书。\n` +
          `- **角色不会一模一样。** mufy 那边的语气是人设＋小剧场＋输出设定＋正则＋那边的模型\n` +
          `  一起长出来的；换了模型，就算人设一字不差贴过去口吻也会变。\n` +
          `  聊天记录本身是最有效的"定调"手段（模型会照着已有对话模仿），但它是像，不是同一个。\n\n` +
          `> 手机上的 Tavo 等酒馆类前端**角色卡**兼容酒馆的卡片规格；\n` +
          `> 对话能不能直接吃这个格式，请自己试一下，我们没有实测过。\n`,
        date: new Date(pack.exportedAt),
      });

      report(`【${pack.name}】打包 ${files.length} 个文件…`);
      const zip = await makeZip(files, (a, b) => report(`  压缩 ${a}/${b}`));
      downloadBlob(base + '_酒馆.zip', zip);
      return true;
    }

    if (opts.split) {
      const used = new Set();
      // 章节：一段对话一篇。索引严格按 chapters 生成，别把开场白混进来数——
      // 混进来就会整体错位一位，最后一项还会撞上 undefined。
      const chapters = pack.sessions.map((s, i) => {
        // 分批时接着上一批往下编号（用已导出的段数，不用槽位），
        // 这样几批合到一个文件夹里序号是连续的，也和不分批时完全一致
        const seq = (bt ? bt.seqBase : 0) + i + 1;
        const idx = String(seq).padStart(2, '0');
        const slug = fileSlug(s);
        let nm = `${idx}_${stamp(sessionTime(s))}${slug ? '_' + slug : ''}.md`;
        while (used.has(nm)) nm = nm.replace(/\.md$/, '_.md');
        used.add(nm);
        return { name: nm, text: toMarkdownOne(pack, s, seq, opts), date: sessionTime(s) };
      });

      // 开场白单独成篇，排在最前面——它是角色卡自带的第一幕，不属于任何一段对话
      const files = [];
      // 开场白只放进第一批，后面几批不重复塞（它是角色卡自带的，不属于任何一段）
      const g = pack.greeting && (!bt || bt.from === 1) ? (opts.tidy ? tidy(pack.greeting) : pack.greeting) : '';
      if (g.trim()) {
        files.push({
          name: '00_开场白.md',
          text: `# ${pack.name} · 开场白\n\n` +
                `- 角色卡自带的开场白，不属于任何一段对话\n` +
                `- 抓的是导出当时的版本；卡主后来改过的话，早期对话当年看到的未必是这一版\n\n---\n\n${g}\n`,
          date: new Date(pack.exportedAt),
        });
      }
      files.push(...chapters);

      files.push({
        name: '00_目录.md',
        text:
          (bt
            ? `# ${pack.name} · 第 ${bt.from}–${bt.to} 段（全部共 ${bt.total} 段）\n\n` +
              `> 这个角色是分批导出的，这只是其中一包，其余的段在别的包里。\n` +
              `> **段是按时间从新到旧排的**，所以第 1 段是最近那次，最早的记录在最后一包。\n` +
              `> 一段＝一次对话，可能对应好几条存档；聊过但没保存的那段也算一段。\n` +
              `> 每一段的内容都是完整的 —— 分批只切「这一包放几段」，不切段本身。\n` +
              (bt.from === 1 ? '' : `> 开场白在第一包里。\n`) + '\n'
            : `# ${pack.name} · 共 ${pack.sessions.length} 段对话\n\n`) +
          `导出时间：${new Date(pack.exportedAt).toLocaleString('zh-CN')}\n\n` +
          (g.trim() ? `0. [00_开场白.md](00_%E5%BC%80%E5%9C%BA%E7%99%BD.md)　角色卡自带\n` : '') +
          chapters.map((f, i) => {
            const s = pack.sessions[i];
            // 一眼能看出「哪一段有问题」，不用一个个点开。这两条都是用户报过的症状：
            // 1KB 的存档摘要、以及同一份记录被导两遍。
            let mark = '';
            if (s.fromArchiveOnly) mark += '　🔴 只有存档摘要（文件里有救法）';
            if (s.mergedFrom && s.mergedFrom.length) mark += `　🔁 已合并 ${s.mergedFrom.length} 段重复的`;
            return `${(bt ? bt.seqBase : 0) + i + 1}. [${f.name}](${linkTarget(f.name)})　${s.messageCount} 条${mark}`;
          }).join('\n') +
          '\n' +
          // 一条对话都没取到时，包里必须写清楚是怎么回事 —— 否则拿到一个只有开场白的包，
          // 用户只会以为自己没聊过（而他可能记得很清楚：他聊过）。
          (pack.noContent
            ? '\n---\n\n' +
              '## ⚠️ 这个角色的对话，一条都没取到\n\n' +
              (pack.lastInteracted
                ? `mufy 记着你和它的**最后一次互动是 ${String(pack.lastInteracted).slice(0, 10)}**，`
                : 'mufy 里有这个角色的会话记录，') +
              '但现在接口一条正文都给不出来（也没有任何存档）。所以这个包里只有开场白。\n\n' +
              '**这多半意味着那段记录在 mufy 那边已经没有了**（他们迁移服务器时公告过会丢一部分）。' +
              '想确认的话，去 mufy 打开这个角色看一眼：\n\n' +
              '- **里面也是空的** → 那边确实没有了，脚本变不出来\n' +
              '- **里面还看得到聊天内容** → 那就是我们的问题，请把角色名告诉我们\n'
            : '') +
          (pack.sessions.some((s) => s.fromArchiveOnly)
            ? '\n---\n\n' +
              '## 🔴 有几段只拿到了存档摘要\n\n' +
              '上面标了红点的那几段，接口一条对话都没给出来，文件里只有存档记下的那一问一答' +
              '（所以会比当年真聊的那些短得多，常见的只剩 1KB 上下）。很久以前的存档特别容易这样。\n\n' +
              '**救法**：去 mufy 里把那个存档**载入**，让它变成你当前正在聊的那段，' +
              '然后重新导出这个角色 —— 载入之后接口就给得出全文了。（用户实测有效。）\n'
            : ''),
        date: new Date(pack.exportedAt),
      });

      if (opts.json) {
        files.push(...packJsonFiles(pack, report, new Date(pack.exportedAt)));
      }

      report(`【${pack.name}】打包 ${files.length} 个文件…`);
      const zip = await makeZip(files, (a, b) => report(`  压缩 ${a}/${b}`));
      downloadBlob(base + '.zip', zip);
      return true;
    } else {
      download(base + '.md', toMarkdown(pack, opts));
      if (opts.json) download(base + '.json', JSON.stringify(pack, null, 2));
      return true;
    }
  }

  // ---------- 界面 ----------
  const css = `
  /* ⚠️ 别钉在 bottom:16px —— 手机版 mufy 的底部导航就在那儿，会把「首页」键盖住。
     窄屏一律抬到导航条上方；另外按钮自带一个 ✕，随时能收起来。 */
  #mufyx-btn{position:fixed;left:16px;bottom:16px;z-index:2147483646;padding:8px 14px;border-radius:999px;
    background:rgba(30,26,45,.92);color:#e9e4f5;border:1px solid rgba(190,170,255,.35);font:13px/1.4 system-ui,sans-serif;
    cursor:pointer;backdrop-filter:blur(8px);box-shadow:0 4px 18px rgba(0,0,0,.4)}
  #mufyx-btn:hover{border-color:rgba(190,170,255,.8)}
  #mufyx-panel{position:fixed;left:16px;bottom:60px;z-index:2147483647;width:340px;padding:16px;border-radius:14px;
    background:rgba(24,20,38,.97);color:#e9e4f5;border:1px solid rgba(190,170,255,.28);
    font:13px/1.6 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.55)}
  #mufyx-panel h3{margin:0 0 10px;font-size:14px;font-weight:600;letter-spacing:.04em}
  #mufyx-panel label{display:block;margin:8px 0}
  #mufyx-panel select,#mufyx-panel input[type=text]{width:100%;padding:6px 8px;border-radius:8px;margin-top:4px;
    background:rgba(255,255,255,.06);color:#e9e4f5;border:1px solid rgba(190,170,255,.25)}
  #mufyx-panel .row{display:flex;gap:8px;margin-top:12px}
  #mufyx-panel button{flex:1;padding:8px;border-radius:9px;cursor:pointer;font-size:13px;
    background:rgba(150,120,235,.28);color:#efeaff;border:1px solid rgba(190,170,255,.4)}
  #mufyx-panel button:hover{background:rgba(150,120,235,.45)}
  #mufyx-panel button:disabled{opacity:.45;cursor:default}
  #mufyx-recent{margin-top:10px;display:flex;flex-direction:column;gap:3px}
  #mufyx-recent .rt{font-size:11px;color:#9c93bd;margin-bottom:2px}
  #mufyx-recent a{font-size:11.5px;color:#cbbcff;text-decoration:none;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #mufyx-recent a:hover{text-decoration:underline;color:#e6dcff}
  #mufyx-log{margin-top:12px;max-height:150px;overflow:auto;font-size:11.5px;line-height:1.5;
    color:#b8aed6;white-space:pre-wrap;border-top:1px solid rgba(190,170,255,.18);padding-top:8px}
  #mufyx-close{position:absolute;top:10px;right:12px;background:none;border:none;color:#9c93bd;cursor:pointer;
    font-size:15px;padding:0;width:auto;flex:none}
  /* 按钮右上角的收起小叉 */
  #mufyx-hide{position:fixed;z-index:2147483647;width:20px;height:20px;line-height:18px;text-align:center;
    border-radius:50%;background:rgba(20,17,30,.96);color:#c9c2e0;border:1px solid rgba(190,170,255,.45);
    font-size:12px;cursor:pointer;padding:0}
  #mufyx-hide:hover{color:#fff;border-color:rgba(190,170,255,.9)}
  /* 手机 / 窄屏：抬到底部导航上方，别压住 mufy 自己的按键 */
  @media (max-width: 820px){
    #mufyx-btn{bottom:84px;left:12px;padding:7px 12px;font-size:12px}
    #mufyx-panel{left:8px;right:8px;width:auto;bottom:128px;max-height:70vh;overflow-y:auto}
  }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'mufyx-btn';
  btn.textContent = '⬇ 批量导出';
  document.body.appendChild(btn);

  // 收起按钮的 ✕。有人反馈这个悬浮框挡住了 mufy 手机版的首页键，
  // 而当时根本没给关的办法 —— 这是必须有的东西，不是锦上添花。
  const hideBtn = document.createElement('button');
  hideBtn.id = 'mufyx-hide';
  hideBtn.textContent = '✕';
  hideBtn.title = '收起这个按钮（刷新页面就回来；想彻底关掉请在 Tampermonkey 里停用本脚本）';
  document.body.appendChild(hideBtn);

  function placeHide() {
    const r = btn.getBoundingClientRect();
    hideBtn.style.left = (r.right - 8) + 'px';
    hideBtn.style.top = (r.top - 8) + 'px';
  }
  function setHidden(on) {
    btn.style.display = on ? 'none' : '';
    hideBtn.style.display = on ? 'none' : '';
    if (on && panel) { panel.remove(); panel = null; }
    if (!on) placeHide();
  }
  // 只收起当前这次浏览，刷新即恢复。
  // 故意不做「永久隐藏」：那样的人会以为脚本坏了，却找不回来。
  // 真想永久关掉，正解是在 Tampermonkey 里停用本脚本 —— 提示语里写明了。
  hideBtn.onclick = (e) => {
    e.stopPropagation();
    setHidden(true);
    const tip = document.createElement('div');
    tip.textContent = '已收起。刷新页面会回来；想永久关掉请在 Tampermonkey 里停用本脚本。';
    tip.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;'
      + 'background:rgba(20,17,30,.96);color:#e9e4f5;border:1px solid rgba(190,170,255,.4);border-radius:12px;'
      + 'padding:10px 16px;font:13px/1.5 system-ui,sans-serif;max-width:86vw;text-align:center';
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 5200);
  };
  addEventListener('resize', placeHide);
  addEventListener('scroll', placeHide, true);
  setTimeout(placeHide, 0);

  let panel = null;

  function open() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = document.createElement('div');
    panel.id = 'mufyx-panel';
    panel.innerHTML = `
      <button id="mufyx-close" title="关闭">✕</button>
      <h3>Mufy 批量导出 <span style="opacity:.5;font-weight:400">v${VERSION.replace(/\.0$/, '')}</span></h3>
      <label>范围
        <select id="mufyx-scope">
          <option value="current">当前角色（本页）</option>
          <option value="chatted">全部聊过的角色（慢）</option>
          <option value="followed">全部已关注角色（慢，含没聊过的）</option>
          <option value="manual">手动填角色 ID</option>
          <option value="masks">人设面具（全部，不是聊天记录）</option>
          <option value="cards">我创建的角色卡（全部）</option>
        </select>
      </label>
      <div id="mufyx-masktip" style="display:none;font-size:11.5px;color:#a79ecb;margin:2px 0 0">
        导的是「人设面具」库，和聊天记录无关。<br>
        每个面具一份，按 备注／名称／性别／我的描述／我的喜好／指令 分好节。
      </div>
      <div id="mufyx-cardtip" style="display:none;font-size:11.5px;color:#a79ecb;margin:2px 0 0">
        导的是你自己创建的角色卡，一张一个文件夹：人设／小剧场／全局美化／情节设定／
        输出设定／样例对话／正则条目等全字段明文，<b>头像和封面图真下下来</b>。<br>
        官方「引继码」XML 把小剧场和全局美化加密了，这里是明文。
      </div>
      <label id="mufyx-idwrap" style="display:none">角色 ID
        <input type="text" id="mufyx-id" placeholder="地址栏 roleId= 后面那串">
      </label>
      <label id="mufyx-chunkwrap">每包最多多少段对话（留空＝不分包）
        <input type="number" id="mufyx-chunk" min="1" step="1" placeholder="留空＝一个角色一个包">
      </label>
      <div id="mufyx-chunktip" style="display:none;font-size:11.5px;color:#a79ecb;margin:2px 0 0">
        对话特别多的角色（上百段）在手机上、甚至电脑上都可能因为内存不够而失败。
        填个 <b>20</b> 试试：脚本会**一批一批地抓、抓完就放掉**，内存峰值只跟一批有关。<br>
        代价是同一个角色会出好几个包（文件名带「第几到第几段」）。
      </div>
      <label id="mufyx-startwrap" style="display:none">从第几个角色开始（中断后接着跑用）
        <input type="number" id="mufyx-start" min="1" step="1" value="1">
      </label>
      <div id="mufyx-starttip" style="display:none;font-size:11.5px;color:#a79ecb;margin:2px 0 0">
        导到一半被打断（手机上常见）不用从头来：看日志里最后成功的是第几个，
        下次填它的下一个。<br>
        ⚠️ 顺序按「最近聊过」排，<b>中途别去聊天</b>，不然编号会变。
      </div>
      <label>输出方式
        <select id="mufyx-shape">
          <option value="split">每段对话一个文件（打包成 ZIP）</option>
          <option value="one">全部合并成一份 Markdown</option>
          <option value="epub">每个角色一本电子书（EPUB）</option>
          <option value="tavern">酒馆对话（.jsonl，一段存档一个文件）</option>
        </select>
      </label>
      <div id="mufyx-tidytip" style="display:none;font-size:11.5px;color:#a79ecb;margin:2px 0 0">
        这一条导的不是对话，「清理 think」对它没有作用。
      </div>
      <div id="mufyx-epubtip" style="display:none;font-size:11.5px;color:#a79ecb;margin:2px 0 0">
        直接出电子书，不用装 Python。导进微信读书 / 图书 / 静读天下就能当小说翻。<br>
        书里一律是清理过的正文；要留原始数据请另导一次 ZIP。
      </div>
      <label><input type="checkbox" id="mufyx-tidy" checked> 清理 think / 状态栏 HTML</label>
      <label><input type="checkbox" id="mufyx-json" checked> 附带 JSON 完整备份</label>
      <div class="row">
        <button id="mufyx-go">开始导出</button>
      </div>
      <div id="mufyx-recent"></div>
      <div id="mufyx-log">准备就绪。</div>
    `;
    document.body.appendChild(panel);
    renderRecent(); // 面板关掉再打开，之前生成的文件还留着，能继续手动保存

    const $ = (id) => panel.querySelector('#' + id);
    $('mufyx-close').onclick = () => { panel.remove(); panel = null; };
    // 面具那条路和聊天记录不共用参数：EPUB 无从谈起（没有对话可成章），
    // 「清理 think」也无从谈起（面具本来就是纯文本设定）。
    // 这两项不静默忽略，而是当场改掉界面说明白 —— 静默忽略等于骗人。
    const syncUI = () => {
      const scope = $('mufyx-scope').value;
      const isMask = scope === 'masks';
      const isCard = scope === 'cards';
      const other = isMask || isCard; // 这两条都不是聊天记录
      const shapeSel = $('mufyx-shape');
      const epubOpt = shapeSel.querySelector('option[value=epub]');

      $('mufyx-idwrap').style.display = scope === 'manual' ? 'block' : 'none';
      // 「从第 N 个开始」只对成批跑的两个范围有意义（单个角色、面具、角色卡都不需要）
      const batch = scope === 'chatted' || scope === 'followed';
      $('mufyx-startwrap').style.display = batch ? 'block' : 'none';
      $('mufyx-starttip').style.display = batch ? 'block' : 'none';
      // 分批只对聊天记录有意义（面具/角色卡不是按段组织的）
      $('mufyx-chunkwrap').style.display = other ? 'none' : 'block';
      $('mufyx-chunktip').style.display = other ? 'none' : 'block';
      $('mufyx-masktip').style.display = isMask ? 'block' : 'none';
      $('mufyx-cardtip').style.display = isCard ? 'block' : 'none';
      $('mufyx-tidytip').style.display = other ? 'block' : 'none';

      const tavernOpt = shapeSel.querySelector('option[value=tavern]');
      tavernOpt.disabled = other;
      tavernOpt.textContent = other
        ? `酒馆对话（.jsonl · ${isMask ? '面具' : '角色卡'}不适用）`
        : '酒馆对话（.jsonl，一段存档一个文件）';
      if (other && shapeSel.value === 'tavern') shapeSel.value = 'split';

      epubOpt.disabled = other;
      epubOpt.textContent = other
        ? `每个角色一本电子书（EPUB · ${isMask ? '面具' : '角色卡'}不适用）`
        : '每个角色一本电子书（EPUB）';
      if (other && shapeSel.value === 'epub') shapeSel.value = 'split';

      shapeSel.querySelector('option[value=split]').textContent =
        isMask ? '每个面具一个文件（打包成 ZIP）'
        : isCard ? '每张卡一个文件夹（打包成 ZIP，含图片）'
        : '每段对话一个文件（打包成 ZIP）';
      shapeSel.querySelector('option[value=one]').textContent =
        isCard ? '全部合并成一份 Markdown（不含图片）' : '全部合并成一份 Markdown';

      $('mufyx-epubtip').style.display = shapeSel.value === 'epub' ? 'block' : 'none';
    };
    $('mufyx-scope').onchange = syncUI;
    $('mufyx-shape').onchange = syncUI;
    $('mufyx-go').onclick = () => run(panel);
  }

  // 结尾必须按「这一轮到底产出了几个文件」说话。
  // 有用户反馈「面板说导出完成了，但下载列表里什么都没有」——
  // 其中一种情况就是这一轮**压根没产出文件**（比如那个角色的存档都看不到了），
  // 而旧文案不管三七二十一都说「文件在下载目录里」，等于在骗人。
  function reportFinish(report) {
    if (downloadCount === 0) {
      report('⚠️ 这次没有产生任何文件。');
      report('   上面的日志会说明原因：常见是「没有可导出的对话」——');
      report('   没有会员时，过期的历史存档在 mufy 那边就看不到了，接口也不会返回，脚本拿不到。');
      return;
    }
    report(`全部完成，本次产出 ${downloadCount} 个文件，在浏览器的下载目录里。`);
    report('   （下载列表里没有？面板底部有「⬇ 手动保存」可以补存。）');
  }

  async function run(panel) {
    const $ = (id) => panel.querySelector('#' + id);
    const log = $('mufyx-log');
    const goBtn = $('mufyx-go');
    const lines = [];
    const report = (m) => {
      lines.push(m);
      log.textContent = lines.slice(-40).join('\n');
      log.scrollTop = log.scrollHeight;
    };
    logSink = report; // downloadBlob 埋得深，靠这个把「⬇ 文件名 大小」写进同一份日志

    const shape = $('mufyx-shape').value;
    const opts = {
      tidy: $('mufyx-tidy').checked,
      json: $('mufyx-json').checked,
      shape,
      split: shape === 'split',
      chunk: Math.max(0, parseInt($('mufyx-chunk').value, 10) || 0),
      // 🔑 只有电子书按时间正序（旧 → 新）。
      //    书是从第一页开始读的 —— 有用户拿到书翻开第一章，看到的是最近那段，
      //    以为「最前面的聊天记录消失了」，其实它在最后一章。
      //    ZIP 保持「新 → 旧」不变：那是备份，查最近的最方便，
      //    而且 00_目录.md 里本来就写明了排序规则。
      //    ⚠️ 这个开关要在**排序**这一步生效，不能只在渲染时把章节倒过来 ——
      //    否则分批导出时「书内正序、书与书之间倒序」，更乱。
      oldestFirst: shape === 'epub',
    };
    const scope = $('mufyx-scope').value;

    goBtn.disabled = true;
    lines.length = 0;
    downloadCount = 0;

    // 导出期间别让屏幕熄。有安卓用户反馈「导全部角色时息屏几次之后就直接被踢出去了」——
    // 手机息屏/切后台之后系统会回收标签页，导出当场断。
    // Wake Lock 只在页面可见时有效，息屏或切走会自动释放，所以回到前台要重新申请。
    await acquireWakeLock(report);
    document.addEventListener('visibilitychange', onVisibleReacquire);

    try {
      report('确认登录态…');
      await ensureToken();
      report('登录态 OK');

      // 角色卡也是账号级的，走自己的路
      if (scope === 'cards') {
        report('读取你创建的角色卡…');
        const cards = await getMyCards(report);
        if (!cards.length) throw new Error('没找到你创建的角色卡。');
        await emitCards(cards, opts, stamp(), report);
        reportFinish(report);
        return;
      }

      // 面具是账号级的一份清单，不挂角色，走自己的路，走完就结束
      if (scope === 'masks') {
        report('读取人设面具库…');
        const got = await getMasks(report);
        const masks = got.list;
        if (!masks.length) throw new Error('面具库是空的（或者接口没返回内容）。');
        report(`共 ${masks.length} 个面具。`);
        // 少拿到了要当场喊，而且这句话得跟着进文件——只写日志会被后面几百行冲走
        opts.maskNote = maskShortfallNote(masks.length, got.total, got.truncated);
        if (opts.maskNote) report('🔴 ' + opts.maskNote);
        await emitMasks(masks, opts, stamp(), report);
        reportFinish(report);
        return;
      }

      let ids = []; // [{ id, live }]
      if (scope === 'current') {
        const rid = qs('roleId');
        if (!rid) throw new Error('当前页面地址里没有 roleId，请在某个角色的聊天页里用，或改用「手动填角色 ID」。');
        ids = [{ id: rid, live: null }];
      } else if (scope === 'manual') {
        const v = $('mufyx-id').value.trim();
        if (!v) throw new Error('请填角色 ID。');
        ids = [{ id: v, live: null }];
      } else {
        const followedOnly = scope === 'followed';
        report(followedOnly ? '读取已关注角色列表…' : '读取聊过的角色列表…');
        const chars = await getCharacterList(followedOnly);

        // 从没聊过的没有存档，跳掉；但要说清楚跳了多少，不做静默截断
        const usable = chars.filter(hasChatted);
        const skipped = chars.length - usable.length;
        if (skipped) report(`${chars.length} 个里有 ${skipped} 个从没聊过（无存档），跳过。`);

        // 先数一遍撞名的，在文件名里补 characterId 前六位。
        // 🔴 **必须按「最终文件名」数，不能按原始角色名数**：
        //    safeName 会把 / : * ? " < > | 换成 _、把连续空白压成一个、再截到 60 字，
        //    两个不同的角色名完全可能被规整成同一个文件名（「夜色/温柔」和「夜色:温柔」）。
        //    按原名数会认为它们不重复 → 两个包同名 → 浏览器把后到的存成「xxx (1)」，
        //    谁拿到正名取决于下载先后 → 用户看到的就是「文件名是 A 卡、点进去是 B 卡」。
        //    （真有用户这么报过。和面具那次「层级降级判错字符串」是同一类错。）
        const counts = new Map();
        for (const c of usable) { const k = safeName(c.name); counts.set(k, (counts.get(k) || 0) + 1); }
        opts.dupNames = new Set([...counts].filter(([, n]) => n > 1).map(([nm]) => nm));
        if (opts.dupNames.size) report(`有 ${opts.dupNames.size} 个重名角色，文件名会补角色 ID 区分。`);

        // name 带上，失败清单里才报得出人名，不然只剩一串 UUID
        // interacted 带上：万一这个角色一条对话都取不到，产物里要能说出
        // 「你最后一次跟它互动是哪天」——那是区分「没聊过」和「记录没了」的唯一凭据
        ids = usable.filter((c) => c.characterId)
          .map((c) => ({ id: c.characterId, live: c.lastSessionId, name: c.name, interacted: c.lastInteracted }));
        if (!ids.length) throw new Error('没有可导出的角色。');
        const unit = shape === 'epub' ? '一本电子书' : shape === 'one' ? '一份 Markdown'
          : shape === 'tavern' ? '一包酒馆对话' : '一个压缩包';
        if (!confirm(`要导出 ${ids.length} 个角色，每个角色${unit}，会跑很久。继续吗？`)) {
          throw new Error('已取消。');
        }
      }

      const ts = stamp();

      // 「从第 N 个开始」：手机上导几百个角色，中途被系统回收是常事，
      // 不该逼人从头再来一遍。编号就是下面日志里打的那个序号。
      const totalIds = ids.length;
      let startAt = 1;
      if (scope === 'chatted' || scope === 'followed') {
        startAt = Math.max(1, parseInt($('mufyx-start').value, 10) || 1);
        if (startAt > totalIds) {
          throw new Error(`「从第 ${startAt} 个开始」超出范围：这次一共只有 ${totalIds} 个角色。`);
        }
        if (startAt > 1) {
          ids = ids.slice(startAt - 1);
          report(`共 ${totalIds} 个，从第 ${startAt} 个开始 → 本次要导 ${ids.length} 个。`);
          report('   （顺序按「最近聊过」排，中途去聊天会让编号变化。）');
        }
      }

      // 单个角色失败不许拖垮整批：几百个角色跑到第 180 个才炸，前面 179 个不能白跑。
      // 但登录态断了是例外 —— 那不是"这个角色的问题"，继续跑只会刷几百条同样的错。
      opts.usedStems = new Set(); // 运行期文件名占用表，防两个角色写出同名文件
      const failed = [];
      let okCount = 0;
      let emptyCount = 0;
      let seq = startAt - 1; // 打给人看的序号，和「从第 N 个开始」是同一套编号

      for (const t of ids) {
        seq += 1;
        try {
          if (opts.chunk) {
            // 分批：每批只抓这一批的对话，打包完就放掉再抓下一批。
            // 关键是「抓」也要分批 —— 只切 ZIP 的话，全部对话还是会先整个进内存。
            let from = 0, total = null, done = 0, msgs = 0, name = t.name || t.id;
            let lastPack = null;   // 一段都没导成时，可能还剩个开场白要留（见下面）
            for (;;) {
              const pack = await collectCharacter(t.id, opts, report, opts.chunk, t.live, from, t.interacted);
              name = pack.name;
              lastPack = pack;
              if (total === null) total = pack.totalSessions;
              if (pack.sessions.length) {
                // 用槽位范围而不是 pack.sessions.length：空段会被过滤掉，
                // 拿留下来的条数当上界会让下一批的编号对不上（出现过 1-19 接 21-40）。
                // from/to 是「槽位范围」，只用来给文件名贴标签；
                // seqBase 是「已经导出了多少段」，用来给段号连续编号 ——
                // 空段会被过滤掉，用槽位当段号会错位，跟不分批时也对不上。
                pack.batch = { from: from + 1, to: Math.min(from + opts.chunk, total), total, seqBase: done };
                await emit(pack, opts, ts, report);
                done += pack.sessions.length;
                msgs += pack.sessions.reduce((n, s) => n + s.messageCount, 0);
              }
              from += opts.chunk;
              if (from >= total) break;
            }
            if (!done) {
              // 分批这条路同理：没有一段对话，但开场白还在的话，照样给她留一份。
              // 这里的 pack 没有 batch 标签，出来就是个普通的包，不带「第几到第几段」。
              if (lastPack && (lastPack.greeting || '').trim() && await emit(lastPack, opts, ts, report)) {
                report(`✅ [${seq}/${totalIds}] 【${name}】${emptyWhy(lastPack)}`);
                okCount += 1;
              } else {
                report(`【${name}】没有可导出的对话，跳过。`);
                emptyCount += 1;
              }
            }
            else {
              report(`✅ [${seq}/${totalIds}] 【${name}】已导出 ${done} 段对话 / ${msgs} 条消息（分 ${Math.ceil(total / opts.chunk)} 批）`);
              okCount += 1;
            }
          } else {
          const pack = await collectCharacter(t.id, opts, report, null, t.live, 0, t.interacted);
          // 🔴 一段对话都没有，不代表没东西可留：**角色卡自带的开场白也是记录**
          //    （实测有角色的开场白 2900 字，是完整的一幕场景）。
          //    以前这里只看 sessions.length 就跳过，把这类角色整个丢掉了 ——
          //    而更早的版本是会出包的，等于我们把它悄悄弄丢了一次。
          //    ⚠️ 别改成「有开场白就一定出包」：酒馆那条路故意不放开场白
          //    （首条来自卡自己的 first_mes，塞进去会重复），所以那种输出下
          //    只有开场白＝真的没东西可导，emit 里自己会说明并跳过。
          if (!pack.sessions.length && !(pack.greeting || '').trim()) {
            report(`【${pack.name}】没有可导出的对话，跳过。`);
            emptyCount += 1;
          } else {
            // 🔴 成没成要问 emit，别自己假定。酒馆那条路对「只有开场白」的角色
            //    什么都不产出，这里如果照旧报成功就是谎报（本项目栽过三次的那类错）。
            const made = await emit(pack, opts, ts, report);
            const msgs = pack.sessions.reduce((n, s) => n + s.messageCount, 0);
            if (!made) {
              emptyCount += 1;                       // emit 自己已经说明了原因
            } else if (!pack.sessions.length) {
              report(`✅ [${seq}/${totalIds}] 【${pack.name}】${emptyWhy(pack)}`);
              okCount += 1;
            } else {
              report(`✅ [${seq}/${totalIds}] 【${pack.name}】已导出 ${pack.sessions.length} 段对话 / ${msgs} 条消息`);
              okCount += 1;
            }
          }
          }
        } catch (e) {
          if (/续不上登录态/.test(e.message)) throw e; // 掉登录，整批停下来才对
          failed.push({ id: t.id, name: t.name || t.id, msg: e.message });
          report(`❌ [${seq}/${totalIds}] 【${t.name || t.id}】失败：${e.message}`);
          // 「Invalid string length」不是网络问题，是这个角色大到超过了 JS 单个字符串的上限。
          // 甩一句英文报错没用，直接告诉她怎么办。
          if (/Invalid string length|string length|RangeError/i.test(e.message)) {
            report('   ↳ 这个角色太大了（超过 JS 单个字符串的上限），不是网络问题。');
            report('     把面板上「每包最多多少段对话」填 20 再导一次，通常就过了；');
            report('     还不行就填 10，或者先取消勾选「附带 JSON 完整备份」。');
          } else if (/out of memory|Array buffer allocation|allocation failed/i.test(e.message)) {
            report('   ↳ 内存不够。同样：把「每包最多多少段对话」填 20 再试。');
          }
          report('   已跳过，继续下一个。');
        }
        await sleep(400);
      }

      // 不完整必须在结尾再喊一次 —— 中间那行 ⚠️ 早被后面几百行冲走了
      if (opts.incompleteCount) {
        report(`🔴 有 ${opts.incompleteCount} 段没导完整，分别是：`);
        for (const it of opts.incompleteList || []) {
          report(`   · 【${it.name}】${it.when ? it.when + ' 那段' : ''}　${it.reason}`);
        }
        report('   （对应文件的开头也有同样的红字，不用一个个点开找。）');
        // 只有真的是抓取失败才值得重跑；「接口说 N 条只给 M 条」已查实是 mufy 丢了数据，
        // 让人重跑一遍只是白等（收尾话必须由这一轮真发生的事推出来）。
        if ((opts.incompleteList || []).some((it) => /取失败|页数超过/.test(it.reason || ''))) {
          report('   其中「取失败」的那几段多半是网络抖动，单独重导一次通常就好了。');
        }
      }

      // 只拿到存档摘要的那几段（1KB 的小文件），和上面的「没导完整」不是一回事：
      // 那边是抓了一半，这边是接口一条都不给。救法也完全不同，所以分开报。
      if (opts.stubCount) {
        report(`🔴 有 ${opts.stubCount} 段只拿到了存档摘要（文件里只剩一问一答，比真实对话短得多）：`);
        for (const it of opts.stubList || []) {
          report(`   · 【${it.name}】${it.when ? it.when + ' 那段' : ''}${it.remark ? '「' + it.remark + '」' : ''}`);
        }
        report('   救法：去 mufy 里把这几个存档「载入」，让它变成当前正在聊的那段，');
        report('   然后重新导出这个角色 —— 载入之后接口就给得出全文了。（用户实测有效。）');
        report('   （对应文件的开头和 00_目录.md 里也写了同样的话。）');
      }

      // 同一份记录被导两遍的，合并了要说一声 —— 不然用户会以为少了几段。
      if (opts.dupList && opts.dupList.length) {
        report(`🔁 有 ${opts.dupList.length} 段和别的段内容完全相同，已合并，没有重复出文件：`);
        for (const it of opts.dupList) {
          report(`   · 【${it.name}】「${it.dropped}」＝「${it.kept}」`);
        }
        report('   通常是你在 mufy 里载入过某个存档，它同时又成了「最后一次聊天」，');
        report('   一份记录走了两条路。合并只去掉重复的那一份，内容一个字没少。');
      }

      // 结尾的账要算清楚：成功几个、空的几个、失败几个，失败的是谁
      const tally = `成功 ${okCount} 个` + (emptyCount ? `，无对话跳过 ${emptyCount} 个` : '') +
        (failed.length ? `，失败 ${failed.length} 个` : '');
      if (failed.length) {
        report(`🔴 ${tally}。失败的是：`);
        for (const f of failed) report(`   · ${f.name}　${f.id}`);
        report('   可以用「手动填角色 ID」把这几个单独补一遍。');
      } else {
        report(tally + '。');
      }
      if (seq < totalIds) {
        report(`⏸ 只跑到第 ${seq} 个（共 ${totalIds} 个）。下次把「从第几个角色开始」填 ${seq + 1}。`);
      }
      reportFinish(report);
    } catch (e) {
      report('❌ ' + e.message);
    } finally {
      goBtn.disabled = false;
      document.removeEventListener('visibilitychange', onVisibleReacquire);
      releaseWakeLock();
    }
  }

  btn.onclick = open;
  window.__mufyExporter = {
    open, collectCharacter, toMarkdown, toMarkdownOne, emit,
    getArchives, getDialogs, getCharacterList, hasChatted,
    getMasks, maskToMarkdown, emitMasks, maskTitle,
    getMyCards, cardToMarkdown, emitCards, cardRoles, cardAdversity, fetchCardImages,
    ensureToken, refreshToken, api, makeZip,
    downloadBlob, renderRecent, recentFiles, setLogSink: (f) => { logSink = f; },
    contentToText, tidy, sessionToTavern,
    // 下面这几个是给自测用的：EPUB 那条路是纯函数（pack 进、书出），
    // 挂出来就能拿真实存档在浏览器/Node 里直接验，不用真的连账号。
    buildEpub, drawCover, stripTags, dropMachinery, chapterTitleEpub, uuid5,
  };
  open();
})();
