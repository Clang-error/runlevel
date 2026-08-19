// 만든 이미지를 부팅 가능하게 고치고 재검증한다.
//
// OpenRC를 쓰지 않는다. apk --root --initdb 로 만든 루트에는 서비스가 하나도
// 등록돼 있지 않아 OpenRC가 의존성 캐싱 후 멈춘다. 서비스 관리는 T3 범위이고
// 연습 샌드박스엔 init 시스템이 필요 없으므로, 필요한 것만 마운트하고 셸을 띄우는
// 전용 init 을 쓴다. 부팅이 빨라지고 동작이 결정적이 된다.

import fs from "node:fs";
import zlib from "node:zlib";
import { boot, img, report } from "./harness.mjs";

const INIT = `#!/bin/sh
mount -t proc     proc /proc      2>/dev/null
mount -t sysfs    sys  /sys       2>/dev/null
mount -t devtmpfs dev  /dev       2>/dev/null
mount -o remount,rw /
mkdir -p /dev/pts && mount -t devpts devpts /dev/pts 2>/dev/null
hostname dotslash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root TERM=linux PS1='\\w \\$ '
cd /root 2>/dev/null || cd /
exec /bin/sh
`;
const b64 = Buffer.from(INIT).toString("base64");
const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";

// --- 1) init=/bin/sh 로 들어가서 전용 init 을 심는다 ---
console.log("이미지 수리 중...");
const fix = await boot({
    memory_size: 256 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-lts"),
    hda: img("images/dotslash-rootfs.img"),
    cmdline: "console=ttyS0 root=/dev/sda1 rootfstype=ext4 rw init=/bin/sh",
}, { logPath: "serial-fix.log", bootTimeout: 300000 });

await fix.run("mount -o remount,rw / ; mount -t proc proc /proc 2>/dev/null; mount -t devtmpfs dev /dev 2>/dev/null");
report("전용 init 설치", await fix.run(
    `echo '${b64}' | base64 -d > /sbin/dotslash-init && chmod +x /sbin/dotslash-init && ls -l /sbin/dotslash-init`));
report("설치된 패키지 수", await fix.run("apk info 2>/dev/null | wc -l"));
report("용량", await fix.run("df -h / | tail -1"));
await fix.run("sync");

const disk = Buffer.from(fix.emulator.v86.cpu.devices.ide.primary.master.buffer.buffer);
fs.writeFileSync("images/dotslash-rootfs.img", disk);
fix.emulator.destroy?.();

// --- 2) 그 이미지로 다시 부팅해서 실제 문제 채점 조건을 돌려본다 ---
console.log("\n재부팅 검증...");
const t0 = process.uptime();
const vm = await boot({
    memory_size: 256 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-lts"),
    hda: img("images/dotslash-rootfs.img"),
    cmdline: "console=ttyS0 root=/dev/sda1 rootfstype=ext4 rw init=/sbin/dotslash-init",
}, { logPath: "serial-verify2.log", bootTimeout: 300000 });
console.log(`부팅 성공 (${(process.uptime() - t0).toFixed(1)}s)`);

report("uname", await vm.run("uname -a"));
report("루트 파일시스템", await vm.run("findmnt -no SOURCE,FSTYPE /"));
report("도구 확인", await vm.run(
    "for c in mkfs.ext4 lsblk findmnt fdisk gawk bash tree file; do printf '%-11s %s\\n' $c \"$(command -v $c || echo MISSING)\"; done"));
report("GNU sort -h", await vm.run("printf '2K\\n1M\\n3K\\n' | sort -h | tr '\\n' ' '"));
report("GNU find -printf", await vm.run("find /etc/hostname -printf '%p %s\\n'"));
report("ps 동작 (/proc 마운트 확인)", await vm.run("ps | head -3"));

console.log("\n--- 실제 문제 채점 조건 실행 ---");
report("[setup] text-03", await vm.run(
    "mkdir -p /work && printf 'INFO  start\\nERROR db timeout\\nINFO  ok\\nERROR conn refused\\n' > /work/app.log"));
report("[풀이] grep ERROR ... > error.txt", await vm.run("grep ERROR /work/app.log > /work/error.txt"));
report("[check 1] error.txt 가 존재한다", await vm.run("test -f /work/error.txt"));
report("[check 2] ERROR 줄만 들어있다", await vm.run("! grep -qv ERROR /work/error.txt"));
report("[check 3] 2줄이다", await vm.run('[ "$(wc -l < /work/error.txt)" = 2 ]'));

// --- 3) 배포 크기 ---
const zst = zlib.zstdCompressSync(disk, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
fs.writeFileSync("images/dotslash-rootfs.img.zst", zst);
const kernel = fs.statSync("images/boot/vmlinuz-lts").size;
const initrd = fs.statSync("images/boot/initramfs-lts").size;
const engine = fs.statSync("node_modules/v86/build/v86.wasm").size
    + fs.statSync("node_modules/v86/build/libv86.js").size;
console.log("\n=== 배포 크기 ===");
console.log(`  v86 엔진 (wasm+js)  ${mb(engine)}`);
console.log(`  vmlinuz-lts         ${mb(kernel)}`);
console.log(`  initramfs-lts       ${mb(initrd)}`);
console.log(`  rootfs raw          ${mb(disk.length)}`);
console.log(`  rootfs zstd         ${mb(zst.length)}`);
console.log(`  -----------------------------------`);
console.log(`  최초 로딩 합계      ${mb(engine + kernel + initrd + zst.length)}`);

process.exit(0);
