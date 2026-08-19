// CPU 성능에 따라 부팅 시간이 얼마나 달라지는지 잰다.
//
// v86 은 순수 CPU 에뮬레이션이라 기기 성능에 그대로 비례한다.
// Chrome DevTools Protocol 의 CPU 스로틀링으로 느린 기기를 흉내 내 측정한다.
// 배율 4 는 "이 컴퓨터보다 4배 느린 CPU" 라는 뜻이다.
//
// 실행: node bench-cpu.mjs [배율...]      기본 1 2 4 6

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULT = path.join(here, "result.json");
const PORT = 8080;
const DEBUG_PORT = 9333;
const RATES = process.argv.slice(2).map(Number).filter(Boolean);
const rates = RATES.length ? RATES : [1, 2, 4, 6];

const CHROME = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("Chrome 을 못 찾았다."); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(rate) {
    fs.rmSync(RESULT, { force: true });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dotslash-cpu-"));
    const chrome = spawn(CHROME, [
        "--headless=new", "--disable-gpu", "--no-sandbox",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${DEBUG_PORT}`,
        "about:blank",
    ], { stdio: "ignore" });

    try {
        // 디버깅 포트가 열릴 때까지 기다린다
        let target = null;
        for (let i = 0; i < 60 && !target; i++) {
            await sleep(500);
            try {
                const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
                target = list.find((t) => t.type === "page");
            } catch { /* 아직 안 떴다 */ }
        }
        if (!target) throw new Error("디버깅 포트가 안 열림");

        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0;
        const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

        // 페이지를 열기 전에 스로틀을 걸어야 부팅 전체가 느려진다
        send("Emulation.setCPUThrottlingRate", { rate });
        await sleep(300);
        send("Page.navigate", { url: `http://localhost:${PORT}/?bench=1` });

        const deadline = Date.now() + 300000;
        while (!fs.existsSync(RESULT)) {
            if (Date.now() > deadline) return null;
            await sleep(500);
        }
        ws.close();
        return JSON.parse(fs.readFileSync(RESULT, "utf8"));
    } finally {
        chrome.kill();
        await sleep(500);
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 임시 폴더 */ }
    }
}

console.log("CPU 배율별 로딩 시간 (배율 4 = 이 컴퓨터보다 4배 느린 CPU)\n");
for (const rate of rates) {
    const r = await measure(rate);
    if (!r) { console.log(`  ${String(rate).padStart(2)}배 느림   측정 실패 (5분 초과)`); continue; }
    console.log(`  ${String(rate).padStart(2)}배 느림   전체 ${String(r.totalSec).padStart(5)}s   (부팅 ${r.bootSec}s)`);
}
fs.rmSync(RESULT, { force: true });
