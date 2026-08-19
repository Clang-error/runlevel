// 페이지가 어떻게 뜨는지 그대로 본다. 콘솔 오류와 실패한 요청을 전부 찍는다.
// 실행: node diag.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const PORT = 8125, CDP = 9225;
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "runlevel-diag-"));
const server = spawn("node", [path.join(here, "serve.mjs"), String(PORT)], { stdio: "ignore" });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
    "--window-size=1280,900", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { chrome.kill(); server.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });

async function target() {
    for (let i = 0; i < 60; i++) {
        try {
            const l = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
            const p = l.find((t) => t.type === "page");
            if (p) return p.webSocketDebuggerUrl;
        } catch { /* 아직 */ }
        await sleep(250);
    }
    throw new Error("크롬 연결 실패");
}
const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pend = new Map();
const errors = [], failed = [];
ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push(`${d.text} ${d.exception?.description ?? ""}`.trim().split("\n").slice(0, 3).join(" | "));
    }
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
        errors.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (m.method === "Network.loadingFailed") failed.push(`${m.params.type} ${m.params.errorText}`);
});
const cdp = (method, params = {}) => {
    const n = ++id; ws.send(JSON.stringify({ id: n, method, params }));
    return new Promise((res, rej) => pend.set(n, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)));
};
const evaluate = async (e) => (await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

await cdp("Runtime.enable");
await cdp("Network.enable");
await cdp("Page.enable");
await cdp("Page.navigate", { url: `http://localhost:${PORT}/` });

for (const wait of [3, 8, 20, 40]) {
    await sleep(wait * 1000 - (wait === 3 ? 0 : 0));
    const st = await evaluate(`JSON.stringify({
        홈: !document.getElementById('home')?.hidden,
        대기화면: !document.getElementById('waiting')?.hidden,
        터미널: !document.getElementById('term')?.hidden,
        상태줄: document.getElementById('status')?.textContent,
        홈상태: document.getElementById('homeStatus')?.textContent,
        문제수: document.querySelectorAll('.pr').length,
    })`);
    console.log(`[${wait}초] ${st}`);
    if (errors.length) break;
}
console.log("\n=== 콘솔 오류 ===\n" + (errors.length ? errors.join("\n") : "(없음)"));
console.log("\n=== 실패한 요청 ===\n" + (failed.length ? failed.join("\n") : "(없음)"));
process.exit(0);
