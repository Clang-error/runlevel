// web/commands.js 에 적은 예시가 이 게스트에서 실제로 되는지 확인한다.
//
// 이 사전은 문제와 달리 손으로 쓴 문서라, 인터넷 치트시트의 기억이 섞여 들어가기 쉽다.
// 그런데 이 게스트는 일반 리눅스와 다르다 — GNU 와 busybox 가 섞여 있고 (ps aux 안 됨),
// 32비트라 아예 없는 것도 있다 (systemd). 초보가 그대로 따라 쳤는데 안 되는 게
// 제일 나쁜 경험이라, 적어둔 예시는 전부 눌러보고 exit 0 이어야 한다.
//
// 예시마다 작업 디렉터리를 새로 차린다. 앞 예시가 지운 파일을 뒤 예시가 찾는 일이 없어야 한다.
//
// 실행: node lint-commands.mjs

import fs from "node:fs";
import path from "node:path";
import { boot, img } from "./harness.mjs";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "web", "commands.js"), "utf8");
const { COMMANDS, CATEGORIES, UNAVAILABLE, PLAYGROUND } = await import(
    "data:text/javascript;base64," + Buffer.from(src).toString("base64")
);

// 정적 점검부터. VM 을 띄우지 않고도 잡히는 것들이다.
const staticErrors = [];
const seen = new Set();
for (const c of COMMANDS) {
    if (seen.has(c.name)) staticErrors.push(`${c.name}: 중복된 항목`);
    seen.add(c.name);
    if (!CATEGORIES.includes(c.cat)) staticErrors.push(`${c.name}: 모르는 분류 "${c.cat}"`);
    if (!c.sum || !c.usage) staticErrors.push(`${c.name}: sum 이나 usage 가 비었다`);
    if (!c.ex?.length) staticErrors.push(`${c.name}: 예시가 없다`);
}
if (!UNAVAILABLE.length) staticErrors.push("UNAVAILABLE 이 비었다");
for (const e of staticErrors) console.log(`  FAIL  ${e}`);

const state = fs.readFileSync("images/state.bin.zst");
const vm = await boot({
    memory_size: 128 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    uart1: true,
    bios: img("images/seabios.bin"),
    vga_bios: img("images/vgabios.bin"),
    hda: { buffer: new ArrayBuffer(64 * 1024 * 1024) },
    hdb: { buffer: new ArrayBuffer(64 * 1024 * 1024) },
    initial_state: { buffer: state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength) },
}, { logPath: "serial-lint-cmd.log", bootTimeout: 300000 });

// 예시가 기대는 파일들. 예시마다 이 상태로 되돌린다.
//
// 사전이 "터미널에서 쳐보기"로 깔아주는 것과 같은 것을 쓴다 (commands.js 의 PLAYGROUND).
// 여기서만 따로 만들면 검증한 상태와 사용자가 받는 상태가 갈라져서,
// 통과한 예시가 화면에서는 안 돌아가는 일이 생긴다.
const SEED = PLAYGROUND.split("\n").join("; ") + "; cd /work";

// 검사할 것은 반드시 자식 셸 안에서 돌린다.
//
// 채점 채널에 그대로 흘려보내면 문법 오류가 채널의 파서를 먼저 때린다.
// 그러면 완료 표식(__CHK__)까지 같이 삼켜져서, 실패한 것이 성공으로 보고된다.
// 실제로 그렇게 "배열은 안 된다"는 참인 주장이 거짓으로 잡혔다.
//
// bash 로 돌린다. 채점 채널은 /bin/sh 지만 사람이 치는 셸은 bash 라,
// 사전이 약속하는 것은 bash 에서 되는 것이어야 한다.
// sh 에서만 따져야 하는 항목은 그 안에서 다시 sh -c 로 감싼다.
const inSh = (code) =>
    `bash -c "$(printf %s '${Buffer.from(code).toString("base64")}' | base64 -d)"`;

let pass = 0, fail = 0, skip = 0;
const failures = [];
for (const c of COMMANDS) {
    if (c.noTest) {
        console.log(`  SKIP  ${c.name} (대화형·파괴적이라 실행하지 않는다)`);
        skip += c.ex.length;
        continue;
    }
    for (const ex of c.ex) {
        const r = await vm.run(`${SEED} && ${inSh(ex)} >/dev/null 2>&1`, 30000);
        if (r.exit === 0 && !r.timedOut) {
            pass++;
        } else {
            fail++;
            // 왜 실패했는지 보려면 출력이 필요하다. 실패한 것만 다시 돌린다.
            const why = await vm.run(`${SEED} && ${inSh(ex)} 2>&1 | head -2`, 30000);
            failures.push(`${c.name}: ${ex}  ->  exit ${r.exit}${r.timedOut ? " (시간초과)" : ""}  ${why.out.trim()}`);
        }
    }
}

await vm.run("rm -rf /work/* /work/.[!.]* 2>/dev/null; true");

// "이건 안 됩니다" 도 주장이다. 예시만 검증하고 이쪽을 놔뒀더니
// 실제로 틀린 것을 실었다 — "bash 문법이 안 된다"고 적었는데 /bin/bash 가 설치돼 있었고
// 기본 셸에서도 [[ ]] 는 됐다. probe 는 전부 실패해야 그 주장이 참이다.
let unPass = 0, unFail = 0, unSkip = 0;
for (const u of UNAVAILABLE) {
    if (!u.probe) { unSkip++; continue; }
    for (const p of u.probe) {
        const r = await vm.run(`${inSh(p)} >/dev/null 2>&1`, 30000);
        if (r.exit !== 0 && !r.timedOut) {
            unPass++;
        } else {
            unFail++;
            failures.push(`"${u.name}" 은(는) 안 된다고 적었는데 되고 있다:  ${p}`);
        }
    }
}

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n명령어 ${COMMANDS.length}개 · 예시 ${pass} 통과 / ${fail} 실패 / ${skip} 건너뜀`);
console.log(`안 되는 것 ${UNAVAILABLE.length}건 · 확인 ${unPass} 통과 / ${unFail} 실패 / ${unSkip}건 probe 없음`);
process.exit(fail || unFail || staticErrors.length ? 1 : 0);
