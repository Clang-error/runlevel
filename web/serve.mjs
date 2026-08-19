// 개발용 정적 서버.
//   /img/*  -> ../spike/images/*  (커널, 디스크 이미지. 복사하지 않고 그대로 서빙)
//   POST /result -> 브라우저 자체 테스트 결과를 받아 result.json 에 기록
//
// 실행: node serve.mjs [포트]

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const IMAGES = path.join(here, "..", "spike", "images");
const PROBLEMS = path.join(here, "..", "problems");
const PORT = Number(process.argv[2] ?? 8080);
// 두 번째 인자로 디렉터리를 주면 그걸 그대로 서비스한다 (`npm run preview`, dist 검증용).
//
// 소스를 서비스할 때만 img/ 와 problems/ 를 프로젝트 밖에서 끌어오고 목록을 즉석에서 만든다.
// dist 에는 그것들이 이미 파일로 들어 있으므로 그대로 내보내야 한다 —
// 안 그러면 빌드가 만든 것(버전 붙은 이름 등)이 아니라 소스를 검증하게 된다.
const ROOT = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : here;
const BUILT = ROOT !== here;
const gzCache = new Map();   // 압축 결과 캐시 (원본 mtime 으로 무효화)

// problems/ 를 훑어 목록을 만든다. 정적 배포할 때는 이 결과를 파일로 떨궈두면 된다.
function problemIndex() {
    const out = [];
    for (const dir of fs.readdirSync(PROBLEMS)) {
        const full = path.join(PROBLEMS, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const f of fs.readdirSync(full).sort()) {
            if (f.endsWith(".yaml")) out.push(`${dir}/${f}`);
        }
    }
    return out;
}

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".yaml": "text/yaml; charset=utf-8",
};

http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    // 검증 진행 상황. 결과를 끝에 한 번만 받으면 몇 분 동안 멈춘 것처럼 보인다.
    if (req.method === "POST" && url.pathname === "/progress") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            fs.appendFileSync(path.join(here, "progress.log"), body + "\n");
            res.writeHead(204).end();
        });
        return;
    }

    if (req.method === "POST" && url.pathname === "/result") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            fs.writeFileSync(path.join(here, "result.json"), body);
            console.log("결과 수신:", body.slice(0, 200));
            res.writeHead(204).end();
        });
        return;
    }

    if (!BUILT && url.pathname === "/problems/index.json") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(problemIndex()));
    }

    // .gz 요청이 오면 그 자리에서 압축해 배포와 같은 경로로 동작시킨다.
    //
    // 압축 결과를 메모리에 캐싱해 content-length 를 붙인다. 스트리밍으로 흘려보내면
    // 총량을 모르는 응답이 되어 브라우저가 진행률을 못 그리고, 13MB 받는 동안
    // 화면이 멈춘 것처럼 보인다. 원본이 바뀌면 다시 압축한다.
    if (!BUILT && url.pathname.startsWith("/img/") && url.pathname.endsWith(".gz")) {
        const src = path.join(IMAGES, url.pathname.slice(5, -3));
        if (!fs.existsSync(src)) return res.writeHead(404).end("not found");
        const mtime = fs.statSync(src).mtimeMs;
        let hit = gzCache.get(src);
        if (!hit || hit.mtime !== mtime) {
            hit = { mtime, body: zlib.gzipSync(fs.readFileSync(src), { level: 6 }) };
            gzCache.set(src, hit);
        }
        // 큰 이미지에는 ETag 를 붙인다. no-store 로 두면 새로고침마다 27MB 를
        // 다시 받아서, 실제 배포(CDN 캐시)와 전혀 다른 체감이 된다.
        const etag = `"${mtime}-${hit.body.length}"`;
        if (req.headers["if-none-match"] === etag) return res.writeHead(304).end();
        res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": hit.body.length,
            "cache-control": "no-cache",     // 캐시하되 매번 유효성만 확인
            etag,
        });
        return res.end(hit.body);
    }

    let file;
    if (BUILT) {
        file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
    } else if (url.pathname.startsWith("/img/")) {
        file = path.join(IMAGES, url.pathname.slice(5));
    } else if (url.pathname.startsWith("/problems/")) {
        file = path.join(PROBLEMS, url.pathname.slice(10));
    } else {
        file = path.join(here, url.pathname === "/" ? "index.html" : url.pathname);
    }

    fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end("not found");
        // 앱 코드는 항상 최신을 받아야 편집 결과가 바로 보인다.
        // 반면 커널·이미지는 잘 안 바뀌므로 ETag 로 재사용시킨다.
        const isAsset = url.pathname.startsWith("/img/");
        const headers = {
            "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        };
        if (isAsset) {
            const st = fs.statSync(file);
            const etag = `"${st.mtimeMs}-${st.size}"`;
            if (req.headers["if-none-match"] === etag) return res.writeHead(304).end();
            headers.etag = etag;
            headers["cache-control"] = "no-cache";
        } else {
            headers["cache-control"] = "no-store";
        }
        res.writeHead(200, headers);
        res.end(data);
    });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
