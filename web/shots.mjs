// 홍보용 스크린샷을 찍는다. 데스크톱과 폰 두 크기로.
//
// 폰 레이아웃은 자동 검증이 못 잡는다 (verify 는 창을 1280 으로 못 박아 데스크톱만 본다).
// 여기서 나온 폰 이미지가 그걸 눈으로 확인하는 유일한 수단이다.
//
// 브라우저를 CDP 로 직접 몬다. --screenshot 한 방으로는 안 되기 때문이다 —
// 문제를 고르고 명령을 치는 과정이 있어야 "진짜로 돈다"가 화면에 담긴다.
// (그리고 v86 이 계속 도는 페이지라 --virtual-time-budget 은 영영 끝나지 않는다.)
//
// 실행: node shots.mjs [출력디렉터리]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const OUT = path.resolve(process.argv[2] ?? path.join(here, "shots"));
const PORT = 8123;
const CDP = 9223;

const CHROME = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("크롬을 못 찾았다."); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "runlevel-shots-"));
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], { stdio: "ignore" });
const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 크롬이 아직 프로필을 쥐고 있으면 지우기가 실패한다. 임시 디렉터리라 남아도 상관없다.
const cleanup = () => {
    chrome.kill();
    server.kill();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* 무시 */ }
};
process.on("exit", cleanup);

// --- CDP 연결 -------------------------------------------------------------
async function pageTarget() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
            const page = list.find((t) => t.type === "page");
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* 아직 안 떴다 */ }
        await sleep(250);
    }
    throw new Error("크롬 디버깅 포트에 붙지 못했다");
}

const ws = new WebSocket(await pageTarget());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function cdp(method, params = {}) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, (m) =>
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
}

const evaluate = async (expr) =>
    (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
        .result?.value;

// 조건이 참이 될 때까지 기다린다. 스냅샷을 받고 부팅하는 데 시간이 걸린다.
async function until(expr, { timeout = 120000, label = expr } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await evaluate(expr)) return;
        await sleep(300);
    }
    throw new Error(`시간 초과: ${label}`);
}

// 사람이 치는 것과 같은 길로 넣는다. xterm 은 키 이벤트를 듣는다.
async function type(text) {
    await evaluate(`document.querySelector("#term .xterm-helper-textarea")?.focus()`);
    for (const ch of text) {
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        await sleep(25);
    }
}
async function enter() {
    await cdp("Input.dispatchKeyEvent", {
        type: "keyDown", key: "Enter", code: "Enter", text: "\r",
        unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
}

async function viewport(width, height, mobile) {
    await cdp("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 2, mobile,   // 2배로 찍어야 글자가 또렷하다
    });
}

async function shot(name) {
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`  ${name}.png  (${kb}KB)`);
}

async function open(url = `http://localhost:${PORT}/`) {
    await cdp("Page.navigate", { url });
    await until("!!document.getElementById('levels')?.children.length",
        { label: "문제 목록이 그려질 때까지" });
}

await cdp("Page.enable");
await cdp("Runtime.enable");

// ── 데스크톱 ────────────────────────────────────────────────────────────
console.log("\n데스크톱 1440x900");
await viewport(1440, 900, false);
await open();
await shot("01-home");

await evaluate(`document.querySelector('[data-pane="paneCmds"]').click()`);
await sleep(400);
await shot("02-commands");

await evaluate(`document.getElementById('cmdSearch').value='권한';
                document.getElementById('cmdSearch').dispatchEvent(new Event('input'))`);
await sleep(400);
await shot("03-commands-search");

// 문제를 실제로 연다. 부팅이 끝나야 열리므로 여기서 기다린다.
await evaluate(`document.querySelector('[data-pane="paneProblems"]').click()`);
await until("window.__ready === true || !document.getElementById('home').hidden", { label: "홈" });
await evaluate(`[...document.querySelectorAll('.pr')]
                 .find(b => b.children[1].textContent === 'file-01')?.click()`);
await until("document.getElementById('home').hidden", { timeout: 180000, label: "문제 열림" });
await until("document.getElementById('status').textContent.includes('명령을 입력')",
    { timeout: 180000, label: "터미널 준비" });
await sleep(800);

// 진짜 커널이라는 증거 한 방. 한 줄만 찍으면 화면이 텅 비어 보여서 몇 개 더 친다.
for (const cmd of ["uname -a", "cat /etc/os-release | head -3", "free -m", "ls -l /work"]) {
    await type(cmd);
    await enter();
    await sleep(1000);
}
await shot("04-uname");

// 파일트리를 켜고 실제로 풀어 목표가 초록으로 바뀌는 장면
await evaluate(`document.getElementById('filesBtn').click()`);
await sleep(600);
await type("mkdir logs");
await enter();
await sleep(1500);
await type("mv *.log logs/");
await enter();
await sleep(2500);
await shot("05-solved");

// ── 링크 미리보기(OG 카드) ──────────────────────────────────────────────
//
// 디시·X·디스코드·카톡이 링크를 펼칠 때 읽어가는 이미지다. 표준 비율이 1.91:1 이라
// 위의 1440x900 짜리를 잘라 쓰면 위아래가 뭉텅 잘린다. 그 비율로 직접 찍는다.
// 장면은 방금 푼 화면 그대로 — 목표가 초록으로 바뀐 것이 설명이 제일 덜 필요하다.
console.log("\n링크 미리보기 1200x630");
await viewport(1200, 630, false);
await sleep(1500);              // 폭이 바뀌면 터미널이 다시 맞춰진다
await shot("og");

// ── 폰 ──────────────────────────────────────────────────────────────────
console.log("\n폰 390x844");
await viewport(390, 844, true);
await open();
await shot("10-m-home");

await evaluate(`[...document.querySelectorAll('.pr')]
                 .find(b => b.children[1].textContent === 'file-01')?.click()`);
await until("document.getElementById('home').hidden", { timeout: 180000, label: "문제 열림(폰)" });
await until("document.getElementById('status').textContent.includes('명령을 입력')",
    { timeout: 180000, label: "터미널 준비(폰)" });
await sleep(800);
await shot("11-m-problem");

// 문제 창을 접으면 터미널이 전체 폭을 쓴다 — 폰 레이아웃의 핵심
await evaluate(`document.getElementById('sideBtn').click()`);
await sleep(800);
await type("ls -l");
await enter();
await sleep(1200);
await shot("12-m-terminal");

console.log(`\n${OUT} 에 저장했다.`);
process.exit(0);
