// 명령어 사전을 정적 HTML 로 찍어낸다. build.mjs 가 부른다.
//
// 앱은 아무것도 바뀌지 않는다 — commands.js 를 읽기만 하고, 셸 안의 검색은
// 지금처럼 브라우저에서 같은 파일을 불러 돌아간다. 여기서 만드는 것은
// 검색엔진과 링크를 타고 들어오는 사람을 위한 별개의 읽을거리다.
//
// 왜 필요한가: 앱은 주소가 /(하나)뿐이라 명령어 67개가 전부 같은 URL 안에 있다.
// 검색 순위는 URL 단위로 매겨지므로, 그 상태로는 "리눅스 tar 옵션" 같은 검색에
// 걸릴 자리가 아예 없다. 설명은 이미 다 쓰여 있는데 크롤러가 볼 수 없을 뿐이다.

import fs from "node:fs";
import path from "node:path";

const SITE = "https://runlevel.cc";

const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// 주소에 그대로 쓸 수 있는 이름만 페이지를 만든다.
// 사전에는 |, <, > 처럼 셸 기호 항목도 있는데 그건 URL 로 만들 수 없다.
const slugOf = (name) => (/^[a-z0-9][a-z0-9.+-]*$/i.test(name) ? name : null);

const STYLE = `
:root{--bg:#16181d;--panel:#1b1e24;--line:#2b2f38;--fg:#d8dee9;--dim:#6b7280;--accent:#88c0d0;--ok:#a3be8c;--warn:#ebcb8b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 64px}
a{color:var(--accent)}
nav{font-size:12px;color:var(--dim);margin-bottom:26px}
nav a{text-decoration:none}
h1{font-size:26px;margin:0 0 6px;color:var(--accent)}
.bb{display:inline-block;font-size:11px;color:var(--warn);border:1px solid var(--line);border-radius:3px;padding:2px 7px;margin-bottom:12px}
.sum{font-size:15px;margin:0 0 20px}
h2{font-size:11px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase;margin:26px 0 10px}
.usage{display:inline-block;background:var(--panel);border-radius:4px;padding:8px 12px;font-size:13px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0;font-size:13px}
dt{color:var(--ok);white-space:nowrap}
dd{color:var(--dim);margin:0}
pre{background:var(--panel);border-radius:4px;padding:12px 14px;overflow-x:auto;font-size:13px;margin:0}
pre span{color:var(--ok)}
.note{color:var(--warn);opacity:.85;font-size:13px;line-height:1.8}
.try{display:inline-block;margin-top:28px;border:1px solid var(--accent);border-radius:4px;padding:10px 16px;text-decoration:none}
.cats{margin-top:8px}
.cat h3{font-size:13px;color:var(--fg);font-weight:normal;margin:24px 0 8px}
.cat ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:2px}
.cat li a{display:block;padding:5px 8px;border-left:2px solid var(--line);text-decoration:none}
.cat li a:hover{border-left-color:var(--accent);background:var(--panel)}
.cat small{color:var(--dim)}
footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--dim)}
`.trim();

function page({ title, desc, canonical, body }) {
    return `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="runlevel">
<meta property="og:locale" content="ko_KR">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<style>${STYLE}</style>
<div class="wrap">
${body}
<footer>
    이 설명은 <a href="${SITE}/">runlevel</a> 안에서 실제로 돌아가는 리눅스(Alpine, 커널 6.18)를
    기준으로 적었습니다. 예시는 전부 그 환경에서 실행해 확인한 것입니다.
</footer>
</div>
`;
}

function cmdBody(c) {
    const opts = c.opts?.length
        ? `<h2>자주 쓰는 옵션</h2>\n<dl>\n` + c.opts
            .map(([f, d]) => `    <dt>${esc(f)}</dt><dd>${esc(d)}</dd>`).join("\n") + `\n</dl>`
        : "";
    const ex = c.ex?.length
        ? `<h2>예시</h2>\n<pre>` + c.ex.map((e) => `<span>$</span> ${esc(e)}`).join("\n") + `</pre>`
        : "";
    const note = c.note ? `<h2>알아둘 것</h2>\n<p class="note">${esc(c.note)}</p>` : "";
    return `<nav><a href="${SITE}/">runlevel</a> · <a href="./">기본 명령어</a> · ${esc(c.cat)}</nav>
<h1>${esc(c.name)}</h1>
${c.bb ? `<div class="bb">busybox 판 · 옵션이 적습니다</div>` : ""}
<p class="sum">${esc(c.sum)}</p>
<h2>사용법</h2>
<div class="usage">${esc(c.usage)}</div>
${opts}
${ex}
${note}
<a class="try" href="${SITE}/">브라우저에서 직접 쳐보기 →</a>`;
}

function indexBody(cmds, cats) {
    const groups = cats.map((cat) => {
        const list = cmds.filter((c) => c.cat === cat && slugOf(c.name));
        if (!list.length) return "";
        return `<div class="cat">
    <h3>${esc(cat)}</h3>
    <ul>` + list.map((c) =>
            `\n        <li><a href="./${slugOf(c.name)}/">${esc(c.name)} <small>${esc(c.sum.slice(0, 24))}</small></a></li>`
        ).join("") + `
    </ul>
</div>`;
    }).filter(Boolean).join("\n");

    return `<nav><a href="${SITE}/">runlevel</a> · 기본 명령어</nav>
<h1>리눅스 기본 명령어</h1>
<p class="sum">브라우저 안에서 실제로 돌아가는 리눅스를 기준으로 정리했습니다.
설명마다 사용법·자주 쓰는 옵션·직접 실행해 확인한 예시가 붙어 있습니다.</p>
<div class="cats">
${groups}
</div>
<a class="try" href="${SITE}/">브라우저에서 직접 쳐보기 →</a>`;
}

// dist 에 /cmd/ 와 /cmd/<이름>/ 을 만들고, 사이트맵에 넣을 주소 목록을 돌려준다.
export function writeCommandPages(DIST, COMMANDS, CATEGORIES) {
    const root = path.join(DIST, "cmd");
    fs.mkdirSync(root, { recursive: true });

    const urls = [`${SITE}/cmd/`];
    let skipped = [];

    fs.writeFileSync(path.join(root, "index.html"), page({
        title: "리눅스 기본 명령어 — runlevel",
        desc: "브라우저에서 실제로 돌아가는 리눅스를 기준으로 정리한 기본 명령어 설명. 사용법과 자주 쓰는 옵션, 직접 실행해 확인한 예시.",
        canonical: `${SITE}/cmd/`,
        body: indexBody(COMMANDS, CATEGORIES),
    }));

    for (const c of COMMANDS) {
        const slug = slugOf(c.name);
        if (!slug) { skipped.push(c.name); continue; }
        const dir = path.join(root, slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "index.html"), page({
            title: `${c.name} — 리눅스 명령어 사용법과 옵션 | runlevel`,
            desc: `${c.name}: ${c.sum} 사용법 ${c.usage}`.slice(0, 155),
            canonical: `${SITE}/cmd/${slug}/`,
            body: cmdBody(c),
        }));
        urls.push(`${SITE}/cmd/${slug}/`);
    }
    return { urls, skipped };
}
