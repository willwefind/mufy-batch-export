# -*- coding: utf-8 -*-
"""把导出的 zip 存档转成 EPUB —— 每个角色一本书，每段对话一章。

用法：
    python make-epub.py                 # 全部角色
    python make-epub.py 角色名 另一个     # 只转指定角色（模糊匹配）
    python make-epub.py --limit 3       # 只转前 3 个，用来试手感

输出在脚本同目录的 EPUB/ 下。导进微信读书 / Apple Books / 静读天下都能翻。
EPUB 就是一个结构固定的 zip，这里只用 Python 标准库，不引任何外部包。
"""
import io, os, re, sys, json, html, zipfile, uuid, argparse

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '存档')
OUT = os.path.join(HERE, 'EPUB')
FONT = os.path.join(HERE, 'kinghwa.ttf')   # 封面用的中文字体；没有就退系统字，不影响成书

# ────────────────────────── 文本清理（和阅读器同一套判据）──────────────────────────

def tidy(t):
    t = str(t)
    t = re.sub(r'<think>[\s\S]*?</think>', '', t)
    t = re.sub(r'<!--[\s\S]*?-->', '', t)
    t = re.sub(r'<style[\s\S]*?</style>', '', t, flags=re.I)
    t = re.sub(r'<script[\s\S]*?</script>', '', t, flags=re.I)
    t = re.sub(r'<[^>]+>', '', t)
    t = re.sub(r'[ \t]+$', '', t, flags=re.M)
    t = re.sub(r'^[ \t]+', '', t, flags=re.M)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip()


def drop_machinery(t):
    """卡里给模型看的脚手架，读小说时是纯噪音。只删明确是指令的行。"""
    keep = [l for l in t.split('\n')
            if not re.search(r'\[\s*(规则|AI\s*填充)\s*[:：]|待生成|【\s*规则\s*】', l)]
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(keep)).strip()


def content_to_text(c):
    if isinstance(c, str):
        return c
    if not isinstance(c, list):
        return '' if c is None else json.dumps(c, ensure_ascii=False)
    out = []
    for p in c:
        if p is None:
            continue
        if isinstance(p, str):
            out.append(p)
        elif isinstance(p, dict):
            if p.get('type') == 'text' or isinstance(p.get('text'), str):
                out.append(p.get('text') or '')
            elif p.get('url'):
                out.append('［图片］')
    return '\n'.join(out)


def safe(s):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', '_', str(s or '未命名'))
    return re.sub(r'\s+', ' ', s).strip()[:60]


def esc(s):
    return html.escape(str(s), quote=False)


# ────────────────────────── 读 zip 里的 _原始数据.json ──────────────────────────

def load_pack(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        key = '_原始数据.json'
        if key not in names:
            cand = [n for n in names if n.endswith('.json')]
            if not cand:
                raise ValueError('包里没有 _原始数据.json（可能是旧版导出）')
            key = cand[0]
        return json.loads(z.read(key).decode('utf-8'))


# ────────────────────────── 章节标题（和阅读器同判据）──────────────────────────

def chapter_title(s, i):
    remark = ' / '.join([a.get('remark') for a in (s.get('archives') or []) if a.get('remark')])
    if remark:
        return remark
    for m in (s.get('dialogs') or []):
        if m.get('role') != 'assistant':
            continue
        body = tidy(content_to_text(m.get('content')))
        line = next((x.strip() for x in body.split('\n') if x.strip()), '')
        if line:
            line = re.sub(r'^\s*\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}(?:[/\s]\d{1,2}[:：]\d{2})?\s*[•·・\-—|]*\s*', '', line)
            if line:
                return line[:28]
    return f'第 {i} 段'


# ────────────────────────── 封面 ──────────────────────────

def make_cover(name, subtitle):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None
    W, H = 1200, 1600
    img = Image.new('RGB', (W, H), (247, 245, 241))
    d = ImageDraw.Draw(img)
    try:
        f_big = ImageFont.truetype(FONT, 116)
        f_sm = ImageFont.truetype(FONT, 38)
        f_ft = ImageFont.truetype(FONT, 30)
    except Exception:
        f_big = ImageFont.load_default(); f_sm = f_ft = f_big

    # 竖排书名：中文书名一列一列往下落，长名自动折列
    x, y = W - 200, 210
    col = 0
    for ch in name[:24]:
        d.text((x - col * 140, y), ch, font=f_big, fill=(17, 17, 17))
        y += 132
        if y > H - 520:
            y = 210; col += 1

    d.line([(150, H - 380), (150 + 120, H - 380)], fill=(17, 17, 17), width=3)
    d.text((150, H - 340), subtitle, font=f_sm, fill=(108, 104, 98))
    d.text((150, H - 250), 'mufy 存档', font=f_ft, fill=(150, 146, 140))

    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


# ────────────────────────── 组装 EPUB ──────────────────────────

CSS = """@charset "utf-8";
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
"""

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def para_html(text, cls=''):
    """把纯文本按空行分段，转成 <p>。EPUB 是 XHTML，必须良构。"""
    out = []
    for block in [b for b in text.split('\n') if b.strip()]:
        out.append(f'<p{f" class=\"{cls}\"" if cls else ""}>{esc(block)}</p>')
    return '\n'.join(out)


def chapter_xhtml(title, meta, body_html):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><meta charset="utf-8"/><title>{esc(title)}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>
<h1>{esc(title)}</h1>
{f'<p class="meta">{esc(meta)}</p>' if meta else ''}
{body_html}
</body></html>
"""


def build_epub(pack, dest):
    name = pack.get('name') or '未命名'
    cid = pack.get('characterId') or ''
    # 必须是合法 UUID 格式。早先拿 sha1 十六进制串直接冒充，epubcheck 报 OPF-085。
    # uuid5 既是确定性的（同一个角色永远同一个 id，重导不会变成"另一本书"），格式又合规。
    uid = 'urn:uuid:' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'mufy:' + (cid or name)))

    chapters = []   # (文件名, 标题, xhtml)

    g = drop_machinery(tidy(pack.get('greeting') or ''))
    if g:
        chapters.append(('ch000.xhtml', '开场白',
                         chapter_xhtml('开场白', '角色卡自带，不属于任何一段对话', para_html(g))))

    # 书按时间正序（旧 → 新）。ZIP 里存的是「新在前」，所以这里要倒过来。
    # ⚠️ 必须和油猴脚本那条路保持一致 —— 两边出的书本来是等价的，
    #    只改一边就等于把这个保证悄悄作废了。
    sessions = list(reversed(pack.get('sessions') or []))
    for i, s in enumerate(sessions, 1):
        title = chapter_title(s, i)
        arch = s.get('archives') or []
        when = (arch[0].get('createdAt', '')[:10] if arch else '未存档的最后一段')
        parts = []
        for m in (s.get('dialogs') or []):
            body = drop_machinery(tidy(content_to_text(m.get('content'))))
            if not body:
                continue
            me = m.get('role') == 'user'
            parts.append(f'<div class="{"me" if me else "ta"}">'
                         f'<p class="who">{esc("我" if me else name)}</p>'
                         f'{para_html(body)}</div>')
        if not parts:
            continue
        meta = f'第 {i} / {len(pack.get("sessions") or [])} 段　·　{s.get("messageCount", 0)} 条　·　{when}'
        chapters.append((f'ch{i:03d}.xhtml', title, chapter_xhtml(title, meta, '\n'.join(parts))))

    if not chapters:
        return None

    cover = make_cover(name, f'{len(chapters)} 章')
    manifest, spine, navlis, ncxpts = [], [], [], []

    if cover:
        manifest.append('<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>')
        manifest.append('<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>')
        # 别标 linear="no"：那样封面就成了"非线性内容"，规范要求必须有页面链接到它，
        # 否则 epubcheck 报 OPF-096。封面放进阅读顺序第一页最省事，阅读器也都这么认。
        spine.append('<itemref idref="cover"/>')

    for n, (fn, title, _x) in enumerate(chapters, 1):
        manifest.append(f'<item id="c{n}" href="text/{fn}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="c{n}"/>')
        navlis.append(f'<li><a href="text/{fn}">{esc(title)}</a></li>')
        ncxpts.append(f'<navPoint id="n{n}" playOrder="{n}"><navLabel><text>{esc(title)}</text></navLabel>'
                      f'<content src="text/{fn}"/></navPoint>')

    total = sum(s.get('messageCount', 0) for s in (pack.get('sessions') or []))
    opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">{uid}</dc:identifier>
    <dc:title>{esc(name)}</dc:title>
    <dc:creator>mufy 存档</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:description>{esc(f"{len(chapters)} 章，{total} 条消息。由 mufy-batch-export 导出。")}</dc:description>
    <meta property="dcterms:modified">{pack.get('exportedAt', '2026-01-01T00:00:00Z')[:19]}Z</meta>
    {'<meta name="cover" content="cover-img"/>' if cover else ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    {chr(10).join('    ' + m for m in manifest)}
  </manifest>
  <spine toc="ncx">
    {chr(10).join('    ' + s for s in spine)}
  </spine>
</package>
"""

    nav = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>
{chr(10).join(navlis)}
</ol></nav></body></html>
"""

    ncx = f"""<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh-CN">
  <head><meta name="dtb:uid" content="{uid}"/></head>
  <docTitle><text>{esc(name)}</text></docTitle>
  <navMap>
{chr(10).join(ncxpts)}
  </navMap>
</ncx>
"""

    with zipfile.ZipFile(dest, 'w') as z:
        # ⚠️ mimetype 必须是第一个条目、且不压缩，否则很多阅读器不认
        zi = zipfile.ZipInfo('mimetype')
        zi.compress_type = zipfile.ZIP_STORED
        z.writestr(zi, 'application/epub+zip')

        z.writestr('META-INF/container.xml', CONTAINER, zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/content.opf', opf, zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/nav.xhtml', nav, zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/toc.ncx', ncx, zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/style.css', CSS, zipfile.ZIP_DEFLATED)
        if cover:
            z.writestr('OEBPS/images/cover.png', cover, zipfile.ZIP_DEFLATED)
            z.writestr('OEBPS/text/cover.xhtml',
                       '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n'
                       '<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head>'
                       '<meta charset="utf-8"/><title>封面</title></head><body style="margin:0">'
                       '<img src="../images/cover.png" alt="封面" style="width:100%"/>'
                       '</body></html>', zipfile.ZIP_DEFLATED)
        for fn, _t, x in chapters:
            z.writestr(f'OEBPS/text/{fn}', x, zipfile.ZIP_DEFLATED)

    return len(chapters), total


# ────────────────────────── 主流程 ──────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('names', nargs='*', help='只转这些角色（模糊匹配）')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    zips = sorted(f for f in os.listdir(SRC) if f.endswith('.zip'))
    if a.names:
        zips = [z for z in zips if any(n in z for n in a.names)]
    if a.limit:
        zips = zips[:a.limit]

    ok = fail = skip = 0
    for i, fn in enumerate(zips, 1):
        try:
            pack = load_pack(os.path.join(SRC, fn))
            name = safe(pack.get('name'))
            dest = os.path.join(OUT, f'{name}.epub')
            n = 2
            while os.path.exists(dest):          # 重名角色：补序号，别互相覆盖
                dest = os.path.join(OUT, f'{name} ({n}).epub'); n += 1
            r = build_epub(pack, dest)
            if not r:
                skip += 1
                print(f'  ({i}/{len(zips)}) {name}：没有可成书的内容，跳过')
                continue
            ch, msgs = r
            ok += 1
            print(f'✅ ({i}/{len(zips)}) {os.path.basename(dest)}　{ch} 章 / {msgs} 条　'
                  f'{os.path.getsize(dest)/1024:.0f} KB')
        except Exception as e:
            fail += 1
            print(f'❌ ({i}/{len(zips)}) {fn}：{e}')

    print(f'\n完成：成书 {ok}，跳过 {skip}，失败 {fail}　→　{OUT}')
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
