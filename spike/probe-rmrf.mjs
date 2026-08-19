// rm -rf / 이후 채점이 어떻게 되는지 재현한다 (일회성).
//
// 사용자 제보: file-01 에서 시스템을 날리면 "통과" 로 뜬다.
// 조건만 읽어서는 왜 그런지 안 보여서 실제로 눌러본다.
//
// 실행: node probe-rmrf.mjs

import fs from "node:fs";
import { boot, img } from "./harness.mjs";

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
}, { logPath: "serial-probe-rmrf.log", bootTimeout: 300000 });

const CHECKS = [
    ["logs 디렉터리가 생성되었음", "test -d /work/logs"],
    [".log 2개가 logs 안에", `[ "$(ls /work/logs/*.log 2>/dev/null | wc -l)" = 2 ]`],
    ["/work 에 .log 없음", `[ "$(ls /work/*.log 2>/dev/null | wc -l)" = 0 ]`],
];
const GUARD = ["다른 파일 그대로", "test -f /work/readme.txt && test -f /work/data.csv"];

async function grade(label) {
    console.log(`\n=== ${label}`);
    for (const [desc, cmd] of [...CHECKS, GUARD]) {
        const r = await vm.run(cmd, 20000);
        console.log(`  ${r.exit === 0 ? "통과" : "실패"}  exit=${r.exit}${r.timedOut ? " 시간초과" : ""}  ${desc}`);
    }
}

// file-01 setup 그대로
await vm.run("rm -rf /work/* /work/.[!.]* 2>/dev/null; mkdir -p /work; cd /work; touch app.log error.log readme.txt data.csv");
await grade("setup 직후 (전부 실패해야 정상)");

console.log("\n>>> sudo rm -rf --no-preserve-root /  실행");
await vm.run("rm -rf --no-preserve-root / 2>/dev/null; true", 120000);

await grade("시스템 파괴 후");

console.log("\n=== 게스트가 아직 살아 있나");
for (const [label, cmd] of [
    ["ls 존재", "command -v ls || echo 없음"],
    ["wc 존재", "command -v wc || echo 없음"],
    ["/work 내용", "echo /work/*"],
    ["셸은 응답하나", "echo alive"],
]) {
    const r = await vm.run(cmd, 20000);
    console.log(`  ${label}: ${r.out || "(빈 출력)"}  [exit ${r.exit}${r.timedOut ? " 시간초과" : ""}]`);
}
process.exit(0);
