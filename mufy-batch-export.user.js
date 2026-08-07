// ==UserScript==
// @name         Mufy 批量导出聊天记录
// @namespace    https://github.com/willwefind/mufy-batch-export
// @version      1.17.0
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

  function downloadBlob(filename, blob) {
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
      say('     建议：改用电脑导；或者取消勾选「附带 JSON 完整备份」（那份通常占一半以上）再试。');
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
    const out = [];
    let page = 1, expected = null, stopped = '';
    // 实测接口不限于 100 条一页（试到 2000 都接受），而且 100/200/500 三种页大小
    // 翻完得到的是同样的唯一 ID 集合、0 重复 0 漏掉 —— 偏移量是准的。
    // 调大到 500：一万轮对话（约两万条）从 200 次请求降到 40 次，
    // 暴露在网络抖动下的机会少 5 倍。就算服务端偷偷截短也不怕：
    // 下面的循环是「没收够 total 就继续翻」，不依赖服务端一定给满。
    const size = 500;
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
    out.sort((a, b) => new Date(a.createdTime || 0) - new Date(b.createdTime || 0));

    // 拿到的比接口说的少 —— 这就是「被吞了」，必须说出来，不能静默
    const short = expected !== null && out.length < expected;
    return {
      dialogs: out,
      expected,
      incomplete: !!(stopped || short),
      reason: stopped || (short ? `接口说共 ${expected} 条，只取到 ${out.length} 条` : ''),
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

  // ---------- 组装一个角色的导出内容 ----------
  // liveSessionId = 角色列表里的 lastSessionId，也就是这个角色"活着的"那段对话。
  // ⚠️ 只走存档列表会漏掉它：你聊过但从没按"保存"的对话，存档接口根本不列。
  //    实测在一个 200+ 角色的账号上，有 102 个角色属于这种情况，
//    合计 1356 条消息（最多的一个 112 条）曾被整段漏掉。
  async function collectCharacter(characterId, opts, report, limit, liveSessionId) {
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
    if (limit) list = list.slice(0, limit);
    report(`【${name}】共 ${archives.length} 条存档 → ${list.length} 个对话待抓取`);

    const sessions = [];
    let i = 0;
    for (const item of list) {
      i += 1;
      report(`【${name}】(${i}/${list.length}) 抓取 ${item.sessionId.slice(0, 8)}…`);
      const r = await getDialogs(item.sessionId, characterId);
      let dialogs = r.dialogs;
      let err = r.incomplete ? r.reason : null;
      if (r.incomplete) {
        opts.incompleteCount = (opts.incompleteCount || 0) + 1;
        report(`  ⚠️ 不完整：${r.reason}`);
      }

      // 只有一条都没抓到才退回存档里那一问一答。
      // 千万别在「抓到一部分」时也退回去 —— 那等于把几百条换成 2 条。
      if (!dialogs.length && item.archives.length) {
        const a = item.archives[0];
        dialogs = [
          { role: 'user', content: a.user_content, createdTime: a.createdAt, __fromArchive: true },
          { role: 'assistant', content: a.assistant_content, createdTime: a.createdAt, __fromArchive: true },
        ];
      }

      sessions.push({
        sessionId: item.sessionId,
        isCurrent: !!item.current,
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
      await sleep(150);
    }

    // 一条消息都没有的段（比如从没说过话的角色）不值得单独出一个文件
    const kept = sessions.filter((s) => s.messageCount > 0);

    // 新的排前面
    kept.sort((a, b) => sessionTime(b) - sessionTime(a));

    return { characterId, name, greeting, archiveCount: archives.length, sessions: kept, exportedAt: new Date().toISOString() };
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
    if (s.incomplete) {
      L.push('');
      L.push(`> 🔴 **这一段没导完整。** ${s.error || ''}`);
      L.push('> 多半是抓取途中网络出了问题。重跑一次这个角色通常就好了。');
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
  async function emit(pack, opts, ts, report) {
    // 重名角色真的存在（同一个名字下挂着两个不同的 characterId，实测遇到过好几对）。
    // 不加区分的话两个包会撞名，靠浏览器补 " (1)"，事后根本分不出谁是谁。
    const dup = opts.dupNames && opts.dupNames.has(pack.name);
    const base = `mufy_${safeName(pack.name)}${dup ? '_' + pack.characterId.slice(0, 6) : ''}_${ts}`;

    if (opts.shape === 'epub') {
      // 书名就是文件名，不加 mufy_ 前缀也不加时间戳 —— 导进图书类 App 之后，
      // 书架上显示的就是这一行，让它干干净净的。
      report(`【${pack.name}】做成电子书…`);
      const r = await buildEpub(pack, (n) => drawCover(pack.name, `${n} 章`));
      if (!r) { report(`【${pack.name}】没有可成书的内容，跳过。`); return; }
      downloadBlob(`${safeName(pack.name)}${dup ? '_' + pack.characterId.slice(0, 6) : ''}.epub`, r.blob);
      report(`  ${r.chapters} 章 / ${r.total} 条　${(r.blob.size / 1048576).toFixed(2)} MB`);
      return;
    }

    if (opts.split) {
      const used = new Set();
      // 章节：一段对话一篇。索引严格按 chapters 生成，别把开场白混进来数——
      // 混进来就会整体错位一位，最后一项还会撞上 undefined。
      const chapters = pack.sessions.map((s, i) => {
        const idx = String(i + 1).padStart(2, '0');
        const slug = fileSlug(s);
        let nm = `${idx}_${stamp(sessionTime(s))}${slug ? '_' + slug : ''}.md`;
        while (used.has(nm)) nm = nm.replace(/\.md$/, '_.md');
        used.add(nm);
        return { name: nm, text: toMarkdownOne(pack, s, i + 1, opts), date: sessionTime(s) };
      });

      // 开场白单独成篇，排在最前面——它是角色卡自带的第一幕，不属于任何一段对话
      const files = [];
      const g = pack.greeting ? (opts.tidy ? tidy(pack.greeting) : pack.greeting) : '';
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
          `# ${pack.name} · 共 ${pack.sessions.length} 段对话\n\n` +
          `导出时间：${new Date(pack.exportedAt).toLocaleString('zh-CN')}\n\n` +
          (g.trim() ? `0. [00_开场白.md](00_%E5%BC%80%E5%9C%BA%E7%99%BD.md)　角色卡自带\n` : '') +
          chapters.map((f, i) => `${i + 1}. [${f.name}](${linkTarget(f.name)})　${pack.sessions[i].messageCount} 条`).join('\n') +
          '\n',
        date: new Date(pack.exportedAt),
      });

      if (opts.json) {
        files.push({ name: '_原始数据.json', text: JSON.stringify(pack, null, 2), date: new Date(pack.exportedAt) });
      }

      report(`【${pack.name}】打包 ${files.length} 个文件…`);
      const zip = await makeZip(files, (a, b) => report(`  压缩 ${a}/${b}`));
      downloadBlob(base + '.zip', zip);
    } else {
      download(base + '.md', toMarkdown(pack, opts));
      if (opts.json) download(base + '.json', JSON.stringify(pack, null, 2));
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
      <h3>Mufy 批量导出 <span style="opacity:.5;font-weight:400">v1.17</span></h3>
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
      <label>输出方式
        <select id="mufyx-shape">
          <option value="split">每段对话一个文件（打包成 ZIP）</option>
          <option value="one">全部合并成一份 Markdown</option>
          <option value="epub">每个角色一本电子书（EPUB）</option>
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
      $('mufyx-masktip').style.display = isMask ? 'block' : 'none';
      $('mufyx-cardtip').style.display = isCard ? 'block' : 'none';
      $('mufyx-tidytip').style.display = other ? 'block' : 'none';

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
    };
    const scope = $('mufyx-scope').value;

    goBtn.disabled = true;
    lines.length = 0;

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
        report('全部完成。文件在浏览器的下载目录里。');
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
        report('全部完成。文件在浏览器的下载目录里。');
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

        // 先数一遍重名，撞名的在文件名里补 characterId 前六位
        const counts = new Map();
        for (const c of usable) counts.set(c.name, (counts.get(c.name) || 0) + 1);
        opts.dupNames = new Set([...counts].filter(([, n]) => n > 1).map(([nm]) => nm));
        if (opts.dupNames.size) report(`有 ${opts.dupNames.size} 个重名角色，文件名会补角色 ID 区分。`);

        // name 带上，失败清单里才报得出人名，不然只剩一串 UUID
        ids = usable.filter((c) => c.characterId).map((c) => ({ id: c.characterId, live: c.lastSessionId, name: c.name }));
        if (!ids.length) throw new Error('没有可导出的角色。');
        const unit = shape === 'epub' ? '一本电子书' : shape === 'one' ? '一份 Markdown' : '一个压缩包';
        if (!confirm(`要导出 ${ids.length} 个角色，每个角色${unit}，会跑很久。继续吗？`)) {
          throw new Error('已取消。');
        }
      }

      const ts = stamp();

      // 单个角色失败不许拖垮整批：几百个角色跑到第 180 个才炸，前面 179 个不能白跑。
      // 但登录态断了是例外 —— 那不是"这个角色的问题"，继续跑只会刷几百条同样的错。
      const failed = [];
      let okCount = 0;
      let emptyCount = 0;

      for (const t of ids) {
        try {
          const pack = await collectCharacter(t.id, opts, report, null, t.live);
          if (!pack.sessions.length) {
            report(`【${pack.name}】没有可导出的对话，跳过。`);
            emptyCount += 1;
          } else {
            await emit(pack, opts, ts, report);
            const msgs = pack.sessions.reduce((n, s) => n + s.messageCount, 0);
            report(`✅ 【${pack.name}】已导出 ${pack.sessions.length} 段对话 / ${msgs} 条消息`);
            okCount += 1;
          }
        } catch (e) {
          if (/续不上登录态/.test(e.message)) throw e; // 掉登录，整批停下来才对
          failed.push({ id: t.id, name: t.name || t.id, msg: e.message });
          report(`❌ 【${t.name || t.id}】失败：${e.message}`);
          report('   已跳过，继续下一个。');
        }
        await sleep(400);
      }

      // 不完整必须在结尾再喊一次 —— 中间那行 ⚠️ 早被后面几百行冲走了
      if (opts.incompleteCount) {
        report(`🔴 有 ${opts.incompleteCount} 段没导完整（见各自文件开头的红字）。`);
        report('   多半是网络抖动。把对应角色单独重导一次通常就好了。');
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
      report('全部完成。文件在浏览器的下载目录里。');
    } catch (e) {
      report('❌ ' + e.message);
    } finally {
      goBtn.disabled = false;
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
    // 下面这几个是给自测用的：EPUB 那条路是纯函数（pack 进、书出），
    // 挂出来就能拿真实存档在浏览器/Node 里直接验，不用真的连账号。
    buildEpub, drawCover, stripTags, dropMachinery, chapterTitleEpub, uuid5,
  };
  open();
})();
