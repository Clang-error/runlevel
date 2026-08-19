// 정적 호스팅에 그대로 올릴 수 있는 dist/ 를 만든다.
//
// 개발 서버가 대신 해주던 두 가지를 파일로 굳힌다.
//   1) problems/index.json  — 개발 서버는 디렉터리를 훑어 만들지만 정적 호스팅은 못 한다
//   2) img/                 — spike/images 에 흩어져 있는 것을 모은다
//
// 그리고 디스크 이미지를 gzip 으로 미리 압축한다. 128MB -> 12MB.
// 브라우저가 DecompressionStream 으로 직접 풀기 때문에 호스트의 압축 설정이 필요 없다.
//
// 실행: npm run build

import crypto from "node:crypto";
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "dist");
const IMAGES = path.join(here, "..", "spike", "images");
const PROBLEMS = path.join(here, "..", "problems");
const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, "img", "boot"), { recursive: true });

// --- 앱 ---
const APP_JS = ["main.js", "vm.js", "problems.js", "progress.js", "tree.js", "settings.js", "commands.js"];
for (const f of ["index.html", ...APP_JS]) {
    fs.copyFileSync(path.join(here, f), path.join(DIST, f));
}
// 링크 미리보기 이미지. index.html 이 절대 주소로 가리키므로 루트에 있어야 한다.
// shots.mjs 가 만든 것을 web/og.png 로 옮겨 두고 여기서 딸려 보낸다.
fs.copyFileSync(path.join(here, "og.png"), path.join(DIST, "og.png"));
fs.copyFileSync(path.join(here, "robots.txt"), path.join(DIST, "robots.txt"));
// 이게 있어야 없는 주소에 진짜 404 가 나간다. 없으면 무엇을 요청하든 앱이 200 으로
// 응답해서, 검색엔진이 존재하지 않는 주소를 끝없이 긁는다.
fs.copyFileSync(path.join(here, "404.html"), path.join(DIST, "404.html"));

// 사이트맵은 빌드할 때 만든다. 파일로 두면 lastmod 가 손대는 것을 잊는 순간
// 거짓말이 되는데, 크롤러에게 "안 바뀌었다"고 말하는 셈이라 다시 안 온다.
// 페이지는 하나뿐이다 — 홈도 문제도 전부 같은 주소 위에서 그려진다.
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(DIST, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>https://runlevel.cc/</loc>
        <lastmod>${today}</lastmod>
    </url>
</urlset>
`);
fs.cpSync(path.join(here, "vendor"), path.join(DIST, "vendor"), { recursive: true });

// --- 문제 + 목록 ---
fs.cpSync(PROBLEMS, path.join(DIST, "problems"), { recursive: true });
const index = [];
for (const dir of fs.readdirSync(PROBLEMS)) {
    if (!fs.statSync(path.join(PROBLEMS, dir)).isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(PROBLEMS, dir)).sort()) {
        if (f.endsWith(".yaml")) index.push(`${dir}/${f}`);
    }
}
fs.writeFileSync(path.join(DIST, "problems", "index.json"), JSON.stringify(index));

// --- 부팅에 필요한 것 ---
for (const [src, dst] of [
    ["seabios.bin", "img/seabios.bin"],
    ["vgabios.bin", "img/vgabios.bin"],
    ["boot/vmlinuz-lts", "img/boot/vmlinuz-lts"],
    ["boot/initramfs-min", "img/boot/initramfs-min"],
]) {
    fs.copyFileSync(path.join(IMAGES, src), path.join(DIST, dst));
}

// --- 스냅샷 (기본 경로) ---
fs.copyFileSync(path.join(IMAGES, "state.bin.zst"), path.join(DIST, "img", "state.bin.zst"));

// --- 디스크 이미지는 gzip 으로 (?boot=1 로 실제 부팅을 볼 때만 쓰인다) ---
const rawPath = path.join(IMAGES, "dotslash-64.img");
const gzPath = path.join(DIST, "img", "dotslash-64.img.gz");
await pipeline(
    fs.createReadStream(rawPath),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(gzPath),
);

// --- 캐시가 옛 파일을 주지 못하게 버전을 붙인다 ---
//
// 실측한 문제다. Cloudflare 존이 .js 와 .zst 에 max-age=14400 을 씌운다(존 기본값).
// 그래서 배포 직후에도 옛 main.js 가 4시간 동안 살아남는다 — 새 index.html 과
// 옛 main.js 가 섞이면 앱이 통째로 깨진다. 실제로 한 번 그렇게 됐다.
//
// index.html, .wasm, .json, .yaml 은 캐시되지 않는 것을 확인했다(DYNAMIC).
// 그래서 캐시되는 것들만 ?v= 로 이름을 갈면 된다 — index.html 이 항상 새것이므로
// 새 이름을 가리키고, 그 이름은 캐시에 있을 수가 없다.
//
// 쿼리스트링이 캐시 키에 들어가는 것도 실측으로 확인했다(?cb=... 로 새 내용이 왔다).
// 모듈끼리 이름이 맞는지 먼저 본다.
//
// import 한 이름이 상대편에 없으면 브라우저가 파일을 통째로 거부한다
// ("Importing binding name 'x' is not found"). 화면이 빈 채로 뜨고 콘솔에만 남는다.
//
// 실제로 그렇게 깨진 사이트를 올렸다. 소스를 고치는 중에 배포가 돌아서
// main.js 는 새 함수를 import 하는데 problems.js 는 아직 그걸 안 내보내는
// 조합이 그대로 나갔다. 파일 하나씩은 멀쩡했고 문법 검사도 통과했다 —
// 어긋난 것은 파일 사이였다.
{
    const src = Object.fromEntries(APP_JS.map((f) => [f, fs.readFileSync(path.join(here, f), "utf8")]));
    const bad = [];
    for (const [file, code] of Object.entries(src)) {
        // import { a, b as c } from "./x.js"
        for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/([\w-]+\.js)"/g)) {
            const from = m[2];
            if (!src[from]) { bad.push(`${file} → ${from} (APP_JS 에 없는 파일)`); continue; }
            for (const raw of m[1].split(",")) {
                const name = raw.trim().split(/\s+as\s+/)[0].trim();
                if (!name) continue;
                const has = new RegExp(
                    `export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`).test(src[from]);
                if (!has) bad.push(`${file} 이 ${from} 의 '${name}' 을 import 하는데 그런 export 가 없다`);
            }
        }
    }
    if (bad.length) {
        console.error("모듈 이름이 어긋났다. 배포하면 화면이 안 뜬다:\n  " + bad.join("\n  "));
        process.exit(1);
    }
}

const hash = crypto.createHash("sha256");
for (const f of [...APP_JS, "index.html"]) hash.update(fs.readFileSync(path.join(here, f)));
hash.update(fs.readFileSync(path.join(IMAGES, "state.bin.zst")));
const BUILD = hash.digest("hex").slice(0, 10);

const ver = (p) => `${p}?v=${BUILD}`;
const versioned = [];          // 나중에 실제로 존재하는지 검사할 목록

function rewrite(file, replacers) {
    const p = path.join(DIST, file);
    let text = fs.readFileSync(p, "utf8");
    for (const [find, target] of replacers) {
        if (!text.includes(find)) throw new Error(`${file} 에서 "${find}" 를 못 찾았다 — 버전 붙이기 실패`);
        text = text.replaceAll(find, find.replace(target, ver(target)));
        versioned.push(target);
    }
    fs.writeFileSync(p, text);
}

// index.html 이 가리키는 캐시 대상들 (.wasm 과 .css 는 캐시 안 되지만 css 는 같이 붙여둔다)
rewrite("index.html", [
    ['href="vendor/xterm.css"', "vendor/xterm.css"],
    ['src="vendor/libv86.js"', "vendor/libv86.js"],
    ['src="vendor/xterm.js"', "vendor/xterm.js"],
    ['src="vendor/addon-fit.js"', "vendor/addon-fit.js"],
    ['src="vendor/js-yaml.min.js"', "vendor/js-yaml.min.js"],
    ['src="main.js"', "main.js"],
]);

// 모듈끼리의 import 도 갈아야 한다. main.js 만 새것이고 vm.js 가 옛것이면 똑같이 깨진다.
for (const f of APP_JS) {
    const p = path.join(DIST, f);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(
        /from "\.\/([\w-]+\.js)"/g,
        (_, name) => { versioned.push(name); return `from "./${ver(name)}"`; }));
}

// 스냅샷도 캐시된다. 여기가 어긋나면 앱은 새것인데 게스트는 옛것이 된다.
rewrite("vm.js", [['"img/state.bin.zst"', "img/state.bin.zst"]]);

// 붙인 이름이 실제로 있는지 확인한다. 오타 하나로 앱이 안 뜨는 걸 배포 후에 알면 늦다.
const missing = [...new Set(versioned)].filter((rel) => !fs.existsSync(path.join(DIST, rel)));
if (missing.length) throw new Error(`버전을 붙였는데 파일이 없다: ${missing.join(", ")}`);

// --- 주석을 떼고 압축한다 ---
//
// 소스의 주석은 그대로 두고 배포본에서만 없앤다. 왜 그렇게 짰는지는 남기되
// 개발자도구로 들여다볼 때 설계 의도까지 다 읽히게 둘 이유는 없다.
//
// 정규식으로 "// 부터 줄 끝까지" 를 지우면 안 된다. 문자열 안의 https:// 나
// 정규식 리터럴을 잘라먹어서 코드가 조용히 깨진다. 진짜 파서를 쓴다.
//
// 버전 붙이기(?v=)를 먼저 끝낸 뒤에 압축해야 한다. 압축이 공백을 없애면
// from "./vm.js" 가 from"./vm.js" 가 되어 위쪽 치환이 대상을 못 찾는다.
const js = (code) => esbuild.transformSync(code, { loader: "js", minify: true, legalComments: "none" }).code;
const css = (code) => esbuild.transformSync(code, { loader: "css", minify: true, legalComments: "none" }).code;

for (const f of APP_JS) {
    const p = path.join(DIST, f);
    fs.writeFileSync(p, js(fs.readFileSync(p, "utf8")));
}

{
    const p = path.join(DIST, "index.html");
    let html = fs.readFileSync(p, "utf8");
    html = html.replace(/<style>([\s\S]*?)<\/style>/g, (_, body) => `<style>${css(body)}</style>`);
    // src 가 붙은 <script> 는 내용이 없으므로 인라인만 골라낸다
    html = html.replace(/<script>([\s\S]*?)<\/script>/g, (_, body) => `<script>${js(body)}</script>`);
    html = html.replace(/<!--[\s\S]*?-->/g, "");
    fs.writeFileSync(p, html);
}

// 압축이 코드를 깨뜨리지 않았는지 최소한의 확인. 여기서 안 잡으면 배포 후에 안다.
for (const f of APP_JS) {
    const code = fs.readFileSync(path.join(DIST, f), "utf8");
    if (code.includes("//") && /^\s*\/\//m.test(code)) throw new Error(`${f} 에 주석이 남았다`);
    if (!code.trim()) throw new Error(`${f} 가 비었다 — 압축 실패`);
}

// --- 요약 ---
// 방문자는 두 경로 중 하나만 받는다. 합계를 그냥 더하면 실제보다 부풀려진다.
const size = (rel) => { try { return fs.statSync(path.join(DIST, rel)).size; } catch { return 0; } };
const walk = (d, acc = { n: 0 }) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p2 = path.join(d, e.name);
        e.isDirectory() ? walk(p2, acc) : (acc.n += fs.statSync(p2).size);
    }
    return acc.n;
};

const bootOnly = size("img/boot/vmlinuz-lts") + size("img/boot/initramfs-min")
               + size("img/dotslash-64.img.gz");
const total = walk(DIST);
const app = total - bootOnly - size("img/state.bin.zst");

console.log(`dist/ 생성 완료 — 문제 ${index.length}개`);
console.log(`  기본 (스냅샷 복원)   ${mb(app + size("img/state.bin.zst"))}   <- 방문자가 받는 것`);
console.log(`    앱·엔진           ${mb(app)}`);
console.log(`    스냅샷            ${mb(size("img/state.bin.zst"))}`);
console.log(`  ?boot=1 (실제 부팅)  ${mb(app + bootOnly)}   (디버깅용, 평소엔 안 받는다)`);
console.log(`\n정적 호스팅에 dist/ 를 그대로 올리면 된다. 특별한 헤더 설정은 필요 없다.`);
