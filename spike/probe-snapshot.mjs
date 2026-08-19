// 스냅샷을 복원해서 안이 어떤 상태인지 들여다본다.
// web/vm.js 와 같은 방식으로 붙인다 — 빈 디스크 껍데기 + initial_state.
//
// 실행: node probe-snapshot.mjs

import fs from "node:fs";
import { boot, img, report } from "./harness.mjs";

const RAM_MB = 128;
const SCRATCH_MB = 64;
const DISK_BYTES = 64 * 1024 * 1024;

const state = fs.readFileSync("images/state.bin.zst");

const vm = await boot({
    memory_size: RAM_MB * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    uart1: true,
    bios: img("images/seabios.bin"),
    vga_bios: img("images/vgabios.bin"),
    hda: { buffer: new ArrayBuffer(DISK_BYTES) },
    hdb: { buffer: new ArrayBuffer(SCRATCH_MB * 1024 * 1024) },
    initial_state: { buffer: state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength) },
}, { logPath: "serial-probe.log", bootTimeout: 300000 });

report("루트 위치", await vm.run("findmnt -no SOURCE /"));
report("계정", await vm.run("cat /etc/runlevel/current"));
report("/work 내용", await vm.run("ls -la /work"));
report("/work 항목 수", await vm.run("ls -A /work | wc -l"));
report("/mnt 잔재", await vm.run("ls -A /mnt; cat /proc/mounts | grep -c zerofill || true"));
report("메모리", await vm.run("free -m | head -2"));
process.exit(0);
