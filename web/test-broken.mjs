// 게스트를 부순 뒤 앱이 어떻게 되는지 브라우저에서 실제로 확인한다.
//
// 이건 verify 에 넣을 수 없다 — 게스트를 통째로 날리므로 뒤따르는 검사가 전부 죽는다.
// 그래서 따로 돌리는 적대적 테스트로 둔다.
//
// 확인하는 것:
//   1. rm -rf / 직후 그 문제가 "통과" 로 뒤집히지 않는가
//   2. 다음 문제로 넘어갔을 때 "시스템이 망가졌습니다" 안내가 뜨는가
//      (안 뜨면 사용자는 왜 문제가 안 열리는지 모른 채 갇힌다)
//
// 실행: node test-broken.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const PORT = 8124;
const CDP = 9224;

const CHROME = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("크롬을 못 찾았다."); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "runlevel-broken-"));
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], { stdio: "ignore" });
const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--window-size=1280,900", `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => {
    chrome.kill(); server.kill();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 무시 */ }
});

async function target() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
            const page = list.find((t) => t.type === "page");
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* 아직 */ }
        await sleep(250);
    }
    throw new Error("크롬에 못 붙었다");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const cdp = (method, params = {}) => {
    const n = ++id;
    ws.send(JSON.stringify({ id: n, method, params }));
    return new Promise((res, rej) => pending.set(n, (m) =>
        m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
};
const evaluate = async (expr) =>
    (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

async function until(expr, { timeout = 180000, label = expr } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await evaluate(expr)) return true;
        await sleep(300);
    }
    throw new Error(`시간 초과: ${label}`);
}

async function type(text) {
    await evaluate(`document.querySelector("#term .xterm-helper-textarea")?.focus()`);
    for (const ch of text) {
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        await sleep(20);
    }
    await cdp("Input.dispatchKeyEvent", {
        type: "keyDown", key: "Enter", code: "Enter", text: "\r",
        unmodifiedText: "\r", windowsVirtualKeyCode: 13,
    });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
}

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Page.navigate", { url: `http://localhost:${PORT}/` });
await until("!!document.getElementById('levels')?.children.length", { label: "문제 목록" });

console.log("file-01 여는 중...");
await evaluate(`[...document.querySelectorAll('.pr')].find(b => b.children[1].textContent === 'file-01').click()`);
await until("document.getElementById('status').textContent.includes('명령을 입력')", { label: "터미널 준비" });
await sleep(600);

const results = [];
const check = (name, ok, detail = "") =>
    results.push(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);

// 먼저 절반만 부순다. 채점 통로(base64 는 /usr/bin 에 있다)는 살아남으므로
// 채점은 정직하게 실패를 말하고, 앱은 아무 이상도 못 느낀다.
// 이 상태를 그냥 두면 사용자는 명령이 왜 안 듣는지 모른 채 계속 친다.
console.log("/bin 만 지우는 중 (채점 통로는 살아남는 경우)...");
await type("rm -rf /bin");
await sleep(6000);
await type("echo probe");
await sleep(9000);
const halfBroken = await evaluate(`!document.getElementById('broken').hidden`);
const halfStatus = await evaluate(`document.getElementById('status').textContent`);
check("절반만 부숴도 알아챈다", halfBroken, `상태줄: ${JSON.stringify(halfStatus)}`);

console.log("게스트 완전 파괴 중...");
await type("rm -rf --no-preserve-root /");
await sleep(12000);
await type("echo done");
await sleep(4000);

// 1. 부쉈다고 통과로 뒤집히면 안 된다
const solvedShown = await evaluate(`document.getElementById('solved').classList.contains('show')`);
const status1 = await evaluate(`document.getElementById('status').textContent`);
// 어느 목표가 통과로 잡혔는지 봐야 원인이 나온다
const goals = await evaluate(
    `[...document.querySelectorAll('#checks li')].map(li => li.className + ':' + li.lastChild.textContent).join(' | ')`);
const guards = await evaluate(
    `[...document.querySelectorAll('#guards li')].map(li => li.className).join(',')`);
console.log(`  목표: ${goals}`);
console.log(`  전제: ${guards}`);
check("부숴도 통과로 안 뜬다", !solvedShown, `상태줄: ${JSON.stringify(status1)}`);

// 2. 다음 문제로 넘어가면 망가졌다는 안내가 떠야 한다
console.log("다음 문제로 이동...");
await evaluate(`document.getElementById('nextBtn').click()`);
await sleep(25000);

const brokenShown = await evaluate(`!document.getElementById('broken').hidden`);
const status2 = await evaluate(`document.getElementById('status').textContent`);
const hasReload = await evaluate(`!!document.getElementById('brokenReload')`);
check("다음 문제에서 망가짐 안내가 뜬다", brokenShown, `상태줄: ${JSON.stringify(status2)}`);
check("다시 불러오기 버튼이 있다", hasReload);

console.log("\n" + results.join("\n"));
process.exit(results.some((r) => r.startsWith("  FAIL")) ? 1 : 0);
