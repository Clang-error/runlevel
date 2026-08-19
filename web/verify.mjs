// 헤드리스 브라우저로 자체 검증을 돌린다.
// 서버 기동 -> Chrome 실행 -> 브라우저가 POST /result 로 결과 전송 -> 요약 출력.
//
// 실행: npm run verify

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULT = path.join(here, "result.json");
// 포트를 고정하면 앞선 실행이 남긴 서버와 충돌한다.
// 그때 새 서버는 조용히 죽고, 페이지가 안 떠서 아무 진행 없이 타임아웃까지 매달린다.
// 빈 포트를 그때그때 잡는다.
const PORT = await new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
});

const CHROME = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
].find((p) => fs.existsSync(p));

if (!CHROME) {
    console.error("헤드리스로 쓸 Chrome/Chromium 을 못 찾았다.");
    console.error(`직접 확인하려면: node serve.mjs  후 http://localhost:8080/?selftest=1`);
    process.exit(1);
}

fs.rmSync(RESULT, { force: true });
const PROGRESS = path.join(here, "progress.log");
fs.rmSync(PROGRESS, { force: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dotslash-chrome-"));

// 인자로 디렉터리를 주면 그걸 검증한다: `node verify.mjs dist`.
// 빌드가 파일 이름을 갈거나 경로를 바꾸면 소스는 멀쩡한데 배포본만 깨질 수 있다.
// 실제로 올리는 것을 그대로 띄워봐야 그게 잡힌다.
const TARGET = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
if (TARGET) console.log(`대상: ${TARGET}`);

// 문제 몇 개만 돌린다: npm run verify -- --only file-01,script-03
//
// 문제 하나를 고쳤을 때 51개를 다 도는 것은 8분을 버리는 일이다.
// 다만 채점기나 정답 입력처럼 모든 문제가 공유하는 경로를 건드렸다면 전수로 돌린다 —
// 거기서 깨지는 것은 한 문제만 봐서는 안 보인다 (실제로 그렇게 script-03 이 깨졌다).
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length);
if (ONLY) console.log(`선택 검사: ${ONLY}`);
const server = spawn("node",
    [path.join(here, "serve.mjs"), String(PORT), ...(TARGET ? [TARGET] : [])],
    { stdio: "ignore" });
const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    // 창 크기를 못 박는다. 기본값(800x600)이면 뷰포트가 756px 이라
    // 폰용 규칙(<=760px)에 걸려서 데스크톱 레이아웃이 검사되지 않는다.
    // 폰 레이아웃은 여기서 못 잡는다 — 기기 모드나 실물로 봐야 한다.
    "--window-size=1280,900",
    `--user-data-dir=${profile}`,
    `http://localhost:${PORT}/?selftest=1${ONLY ? `&only=${encodeURIComponent(ONLY)}` : ""}`,
], { stdio: "ignore" });

const cleanup = async () => {
    chrome.kill();
    server.kill();
    await new Promise((r) => setTimeout(r, 300));   // 크롬이 프로필 파일을 놓을 때까지
    try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        // 임시 디렉터리라 남아도 상관없다
    }
};

console.log("검증 중... (1~2분)");
const deadline = Date.now() + 900000;
// 진행 상황을 받는 대로 흘려준다. 몇 분 걸릴 때 멈춘 건지 도는 건지 알 수 있어야 한다.
let shown = 0;
while (!fs.existsSync(RESULT)) {
    if (Date.now() > deadline) {
        await cleanup();
        console.error("시간 초과. 결과를 못 받았다.");
        process.exit(1);
    }
    if (fs.existsSync(PROGRESS)) {
        const lines = fs.readFileSync(PROGRESS, "utf8").split("\n").filter(Boolean);
        for (const l of lines.slice(shown)) console.log(`  ${l}`);
        shown = lines.length;
    }
    await new Promise((r) => setTimeout(r, 500));
}
await cleanup();

fs.rmSync(PROGRESS, { force: true });
const r = JSON.parse(fs.readFileSync(RESULT, "utf8"));
console.log(`\n부팅 ${r.bootSec}초 · ${r.passed}/${r.total} 통과`);
process.exit(r.passed === r.total ? 0 : 1);
