// ==UserScript==
// @name         Mufy 批量导出聊天记录
// @namespace    https://github.com/willwefind/mufy-batch-export
// @version      1.6.0
// @description  一键把某个角色（或多个角色）的所有存档对话批量导出：合并成一份 Markdown，或每段对话一个文件打包成 ZIP
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
 *   1) 装了 Tampermonkey：把本文件拖进去 / 新建脚本粘贴保存，刷新 chat.mufy.ai，
 *      左下角会出现「⬇ 批量导出」按钮。
 *   2) 不想装插件：在 chat.mufy.ai 页面按 F12 打开控制台，把本文件整段粘进去回车，
 *      同样会出现那个按钮（关掉标签页就没了，下次再粘一遍）。
 *
 * 只读你自己的账号数据，不发任何东西出去；导出文件直接走浏览器下载。
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
  async function api(path) {
    const MAX = 4;
    let last = '';
    for (let i = 0; i < MAX; i++) {
      const t = await ensureToken();
      let res;
      try {
        res = await fetch(ORIGIN + path, {
          headers: { Authorization: 'Bearer ' + t },
          credentials: 'include',
        });
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

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  const download = (filename, text) =>
    downloadBlob(filename, new Blob([text], { type: 'text/plain;charset=utf-8' }));

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

  // files: [{ name, text, date }]
  async function makeZip(files, onProgress) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const nameBytes = enc.encode(f.name);
      const raw = enc.encode(f.text);
      const crc = crc32(raw);
      const { date, time } = dosDT(f.date);

      let method = 0;
      let body = raw;
      const packed = await deflateRaw(raw);
      if (packed && packed.length < raw.length) { method = 8; body = packed; }

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

    return new Blob([...parts, ...cd, eocd], { type: 'application/zip' });
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
  async function getCharacterName(characterId) {
    try {
      const d = await api('/api/characters/get?id=' + encodeURIComponent(characterId));
      return d && d.name ? d.name : characterId.slice(0, 8);
    } catch (e) {
      return characterId.slice(0, 8);
    }
  }

  async function getArchives(characterId) {
    const d = await api('/api/sessions/query_archives?characterId=' + encodeURIComponent(characterId));
    return Array.isArray(d) ? d : (d && d.data) || [];
  }

  // 拉一个 session 的全部消息（自动翻页）
  async function getDialogs(sessionId, characterId) {
    const out = [];
    let page = 1;
    const size = 100;
    for (;;) {
      const d = await api(
        `/api/dialogs/query?sessionId=${encodeURIComponent(sessionId)}&characterId=${encodeURIComponent(characterId)}` +
          `&pageNum=${page}&pageSize=${size}`
      );
      const rows = (d && d.data) || [];
      out.push(...rows);
      const total = d && typeof d.total === 'number' ? d.total : out.length;
      if (!rows.length || out.length >= total || d.hasNext === false) break;
      page += 1;
      if (page > 200) break; // 保险丝
      await sleep(120);
    }
    out.sort((a, b) => new Date(a.createdTime || 0) - new Date(b.createdTime || 0));
    return out;
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

  // ---------- 组装一个角色的导出内容 ----------
  // liveSessionId = 角色列表里的 lastSessionId，也就是这个角色"活着的"那段对话。
  // ⚠️ 只走存档列表会漏掉它：你聊过但从没按"保存"的对话，存档接口根本不列。
  //    实测在一个 200+ 角色的账号上，有 102 个角色属于这种情况，
  //    合计 1356 条消息（最多的一个 112 条）曾被整段漏掉。
  async function collectCharacter(characterId, opts, report, limit, liveSessionId) {
    const name = await getCharacterName(characterId);
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
      let dialogs = [];
      let err = null;
      try {
        dialogs = await getDialogs(item.sessionId, characterId);
      } catch (e) {
        err = e.message;
        report('  ⚠️ ' + e.message);
      }

      // session 已被清空 / 取不到时，退回用存档里存的那一问一答
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
        messageCount: dialogs.length,
        dialogs,
      });
      await sleep(150);
    }

    // 一条消息都没有的段（比如从没说过话的角色）不值得单独出一个文件
    const kept = sessions.filter((s) => s.messageCount > 0);

    // 新的排前面
    kept.sort((a, b) => sessionTime(b) - sessionTime(a));

    return { characterId, name, archiveCount: archives.length, sessions: kept, exportedAt: new Date().toISOString() };
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
    if (s.error) L.push(`- ⚠️ ${s.error}`);
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

  // ---------- 落盘 ----------
  async function emit(pack, opts, ts, report) {
    // 重名角色真的存在（同一个名字下挂着两个不同的 characterId，实测遇到过好几对）。
    // 不加区分的话两个包会撞名，靠浏览器补 " (1)"，事后根本分不出谁是谁。
    const dup = opts.dupNames && opts.dupNames.has(pack.name);
    const base = `mufy_${safeName(pack.name)}${dup ? '_' + pack.characterId.slice(0, 6) : ''}_${ts}`;

    if (opts.split) {
      const used = new Set();
      const files = pack.sessions.map((s, i) => {
        const idx = String(i + 1).padStart(2, '0');
        const slug = fileSlug(s);
        let nm = `${idx}_${stamp(sessionTime(s))}${slug ? '_' + slug : ''}.md`;
        while (used.has(nm)) nm = nm.replace(/\.md$/, '_.md');
        used.add(nm);
        return { name: nm, text: toMarkdownOne(pack, s, i + 1, opts), date: sessionTime(s) };
      });

      files.push({
        name: '00_目录.md',
        text:
          `# ${pack.name} · 共 ${pack.sessions.length} 段对话\n\n` +
          `导出时间：${new Date(pack.exportedAt).toLocaleString('zh-CN')}\n\n` +
          files.map((f, i) => `${i + 1}. [${f.name}](${linkTarget(f.name)})　${pack.sessions[i].messageCount} 条`).join('\n') +
          '\n',
        date: new Date(pack.exportedAt),
      });

      if (opts.json) {
        files.push({ name: '_原始数据.json', text: JSON.stringify(pack, null, 2), date: new Date(pack.exportedAt) });
      }

      report(`【${pack.name}】打包 ${files.length} 个文件…`);
      const zip = await makeZip(files, (a, b) => report(`  压缩 ${a}/${b}`));
      downloadBlob(base + '.zip', zip);
      report(`  ZIP 大小 ${(zip.size / 1048576).toFixed(2)} MB`);
    } else {
      download(base + '.md', toMarkdown(pack, opts));
      if (opts.json) download(base + '.json', JSON.stringify(pack, null, 2));
    }
  }

  // ---------- 界面 ----------
  const css = `
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
  #mufyx-log{margin-top:12px;max-height:150px;overflow:auto;font-size:11.5px;line-height:1.5;
    color:#b8aed6;white-space:pre-wrap;border-top:1px solid rgba(190,170,255,.18);padding-top:8px}
  #mufyx-close{position:absolute;top:10px;right:12px;background:none;border:none;color:#9c93bd;cursor:pointer;
    font-size:15px;padding:0;width:auto;flex:none}
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'mufyx-btn';
  btn.textContent = '⬇ 批量导出';
  document.body.appendChild(btn);

  let panel = null;

  function open() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = document.createElement('div');
    panel.id = 'mufyx-panel';
    panel.innerHTML = `
      <button id="mufyx-close" title="关闭">✕</button>
      <h3>Mufy 批量导出 <span style="opacity:.5;font-weight:400">v1.6</span></h3>
      <label>范围
        <select id="mufyx-scope">
          <option value="current">当前角色（本页）</option>
          <option value="chatted">全部聊过的角色（慢）</option>
          <option value="followed">全部已关注角色（慢，含没聊过的）</option>
          <option value="manual">手动填角色 ID</option>
        </select>
      </label>
      <label id="mufyx-idwrap" style="display:none">角色 ID
        <input type="text" id="mufyx-id" placeholder="地址栏 roleId= 后面那串">
      </label>
      <label>输出方式
        <select id="mufyx-shape">
          <option value="split">每段对话一个文件（打包成 ZIP）</option>
          <option value="one">全部合并成一份 Markdown</option>
        </select>
      </label>
      <label><input type="checkbox" id="mufyx-tidy" checked> 清理 think / 状态栏 HTML</label>
      <label><input type="checkbox" id="mufyx-json" checked> 附带 JSON 完整备份</label>
      <div class="row">
        <button id="mufyx-go">开始导出</button>
      </div>
      <div id="mufyx-log">准备就绪。</div>
    `;
    document.body.appendChild(panel);

    const $ = (id) => panel.querySelector('#' + id);
    $('mufyx-close').onclick = () => { panel.remove(); panel = null; };
    $('mufyx-scope').onchange = (e) => {
      $('mufyx-idwrap').style.display = e.target.value === 'manual' ? 'block' : 'none';
    };
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

    const opts = {
      tidy: $('mufyx-tidy').checked,
      json: $('mufyx-json').checked,
      split: $('mufyx-shape').value === 'split',
    };
    const scope = $('mufyx-scope').value;

    goBtn.disabled = true;
    lines.length = 0;

    try {
      report('确认登录态…');
      await ensureToken();
      report('登录态 OK');

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

        ids = usable.filter((c) => c.characterId).map((c) => ({ id: c.characterId, live: c.lastSessionId }));
        if (!ids.length) throw new Error('没有可导出的角色。');
        if (!confirm(`要导出 ${ids.length} 个角色，每个角色一个压缩包，会跑很久。继续吗？`)) {
          throw new Error('已取消。');
        }
      }

      const ts = stamp();
      for (const t of ids) {
        const pack = await collectCharacter(t.id, opts, report, null, t.live);
        if (!pack.sessions.length) { report(`【${pack.name}】没有可导出的对话，跳过。`); continue; }
        await emit(pack, opts, ts, report);
        const msgs = pack.sessions.reduce((n, s) => n + s.messageCount, 0);
        report(`✅ 【${pack.name}】已导出 ${pack.sessions.length} 段对话 / ${msgs} 条消息`);
        await sleep(400);
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
    ensureToken, refreshToken, api, makeZip,
  };
  open();
})();
