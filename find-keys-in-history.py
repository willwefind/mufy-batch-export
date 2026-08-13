# -*- coding: utf-8 -*-
"""从浏览器历史里挖出 mufy 聊天页的 roleId / sessionId，直接输出成可以粘进面板的样子。

为什么需要它：
  Chrome 的历史记录页面**会把同一天、同一个标题的条目折叠成一行**，
  而 mufy 所有页面的标题都是站名（`Mufy-mumu`），于是几百条聊天页
  在界面上只显示成「每天一条」。2026-08-14 实测：
  界面上搜 roleId 只有 8 条，而历史库里实际有 791 条。
  —— 数据一直都在，是界面没显示。这个脚本直接读库，不跟界面较劲。

  （所以「搜一个具体的 roleId」是能搜到的，只是没法靠界面把全部列出来。）

用法：
    python 本文件名.py                 # 扫所有能找到的浏览器配置
    python 本文件名.py xxxxxxxx        # 只要某个角色的（填 roleId 或它的前几位）

只读你自己机器上的历史文件，不联网、不改动任何东西。
⚠️ 浏览器开着时历史库是锁住的，所以脚本会先拷贝一份到临时目录，用完就删。
"""
import io, os, re, sys, glob, json, shutil, sqlite3, tempfile, collections

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
# 🔴 只取「不是开关」的那个参数当角色 ID —— 直接拿 argv[1] 会把 --no-pause 当成 ID 去搜
_args = [a for a in sys.argv[1:] if not a.startswith('-')]
WANT = _args[0].strip().lower() if _args else ''

# 常见的 Chromium 系浏览器，Windows / Mac / Linux 三套路径都试一遍，找不到的自动跳过。
LOCAL = os.environ.get('LOCALAPPDATA', '')
HOME = os.path.expanduser('~')
MACAPP = os.path.join(HOME, 'Library', 'Application Support')
CANDIDATES = [
    # Windows
    ('Chrome',      os.path.join(LOCAL, 'Google', 'Chrome', 'User Data')),
    ('Edge',        os.path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')),
    ('Brave',       os.path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')),
    ('360极速',      os.path.join(LOCAL, '360ChromeX', 'Chrome', 'User Data')),
    ('QQ浏览器',     os.path.join(LOCAL, 'Tencent', 'QQBrowser', 'User Data')),
    # Mac
    ('Chrome(Mac)', os.path.join(MACAPP, 'Google', 'Chrome')),
    ('Edge(Mac)',   os.path.join(MACAPP, 'Microsoft Edge')),
    ('Brave(Mac)',  os.path.join(MACAPP, 'BraveSoftware', 'Brave-Browser')),
    # Linux
    ('Chrome(Linux)', os.path.join(HOME, '.config', 'google-chrome')),
    ('Edge(Linux)',   os.path.join(HOME, '.config', 'microsoft-edge')),
]

# 双击运行时窗口会一闪而过，什么都来不及看 —— 跑完停一下。
def pause_at_exit():
    if '--no-pause' in sys.argv:
        return
    try:
        input('\n（看完按回车关闭这个窗口）')
    except Exception:
        pass

pairs = collections.OrderedDict()   # (roleId, sessionId) -> 访问次数
seen_urls = 0
scanned = []

for label, base in CANDIDATES:
    if not base or not os.path.isdir(base):
        continue
    for db in sorted(glob.glob(os.path.join(base, '*', 'History'))):
        prof = os.path.basename(os.path.dirname(db))
        tmp = os.path.join(tempfile.gettempdir(), '_hist_%s_%s.db' % (label, prof))
        try:
            shutil.copy2(db, tmp)          # 浏览器开着会锁库，必须拷出来读
            con = sqlite3.connect(tmp)
            rows = con.execute(
                "SELECT url, visit_count FROM urls WHERE url LIKE '%mufy%'").fetchall()
            con.close()
        except Exception as e:
            print('  跳过 %s / %s：%s' % (label, prof, e))
            continue
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        scanned.append('%s/%s(%d)' % (label, prof, len(rows)))
        for url, vc in rows:
            seen_urls += 1
            r = re.search(r'roleId=([0-9a-fA-F-]{36})', url)
            s = re.search(r'sessionId=([0-9a-fA-F-]{36})', url)
            if not r:
                continue
            key = (r.group(1), s.group(1) if s else None)
            pairs[key] = pairs.get(key, 0) + (vc or 0)

if not scanned:
    print('❌ 没找到任何浏览器的历史文件。')
    print('   可能是：① 你用的浏览器不在支持列表里（支持 Chrome / Edge / Brave / 360极速 / QQ浏览器）；')
    print('           ② 你平时用的是手机——手机上的历史读不到，只能在手机浏览器里手动搜（见教程）。')
    pause_at_exit(); sys.exit(1)

print('扫过：' + '、'.join(scanned))
print('mufy 相关网址 %d 条 → 带 roleId 的去重后 %d 组' % (seen_urls, len(pairs)))

by_char = collections.OrderedDict()
for (rid, sid), _ in pairs.items():
    by_char.setdefault(rid, [])
    if sid and sid not in by_char[rid]:
        by_char[rid].append(sid)

if WANT:
    by_char = collections.OrderedDict(
        (k, v) for k, v in by_char.items() if k.lower().startswith(WANT))
    if not by_char:
        print('\n❌ 历史里没有以「%s」开头的 roleId。' % WANT)
        print('   意思是：你这个浏览器的历史里，没有和这个角色的聊天记录。')
        print('   换个浏览器再跑一次试试（很多人在 Chrome 和 Edge 上都聊过）；')
        print('   历史一般只留 90 天，清过历史的话就真的没有了。')
        pause_at_exit(); sys.exit(2)

multi = sum(1 for v in by_char.values() if len(v) > 1)
print('涉及 %d 个角色（其中 %d 个有不止一段对话），共 %d 段。\n'
      % (len(by_char), multi, sum(len(v) for v in by_char.values())))

lines = []
for rid, sids in by_char.items():
    for sid in sids:
        lines.append('roleId=%s&sessionId=%s' % (rid, sid))
    if not sids:
        lines.append('# 只有 roleId、没抓到 sessionId：%s' % rid)

out = os.path.join(HERE, '_历史里的钥匙.txt')
io.open(out, 'w', encoding='utf-8').write(
    '# 从浏览器历史里挖出来的 mufy 聊天页钥匙。\n'
    '# 直接全选粘进导出面板的「救回卡已消失的角色」——\n'
    '# 脚本会自己把「还在你列表里」的角色挑掉，只救真正消失的，所以多粘不吃亏。\n'
    '# 🔴 sessionId 是你自己那段对话的编号，**别公开发出去**。\n\n'
    + '\n'.join(lines) + '\n')
print('✅ 写好了：%s（%d 行）' % (out, len(lines)))
print()
print('下一步：用记事本打开它 → 全选（Ctrl+A）→ 复制（Ctrl+C）')
print('        → 到 mufy 页面打开导出面板 → 范围选「救回卡已消失的角色」')
print('        → 粘进那个框 → 点「开始导出」。')
print('        还在你列表里的角色，脚本会自动挑掉，所以多粘不吃亏。')
pause_at_exit()
