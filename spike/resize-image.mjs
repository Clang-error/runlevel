// 루트 디스크를 실사용에 맞게 줄인다.
//
// v86 은 디스크를 통째로 메모리 버퍼로 들고 있다. 128MB 디스크에 33MB 만 쓰면
// 탭마다 95MB 를 그냥 낭비하는 셈이다. 탭을 여러 개 열거나 저사양 기기에서 부담이 된다.
//
// 마운트된 루트는 줄일 수 없으므로, 새 디스크를 붙여 통째로 옮겨 담는다.
//
// 실행: node resize-image.mjs [크기MB] [원본경로]   기본 64MB, images/dotslash-64.img

import fs from "node:fs";
import zlib from "node:zlib";
import { boot, img, report } from "./harness.mjs";

const SIZE_MB = Number(process.argv[2] ?? 64);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";
const SRC = process.argv[3] ?? "images/dotslash-64.img";   // 줄일 대상

const vm = await boot({
    memory_size: 192 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-min"),
    hda: img(SRC),
    hdb: { buffer: new ArrayBuffer(SIZE_MB * 1024 * 1024) },
    cmdline: "console=ttyS0 root=/dev/sda1 rootfstype=ext4 rw init=/sbin/dotslash-init",
}, { logPath: "serial-resize.log", bootTimeout: 300000 });

report("현재 사용량", await vm.run("df -h / | tail -1"));
report("새 디스크 준비", await vm.run(
    'printf "o\\nn\\np\\n1\\n\\n\\nw\\n" | fdisk /dev/sdb >/dev/null 2>&1; sync; sleep 1; ' +
    "mkfs.ext4 -F -q /dev/sdb1 && mkdir -p /mnt/new && mount /dev/sdb1 /mnt/new && echo ok", 300000));

report("복사", await vm.run(
    "cp -a /bin /etc /lib /root /sbin /usr /var /mnt/new/ && " +
    "mkdir -p /mnt/new/proc /mnt/new/sys /mnt/new/dev /mnt/new/tmp /mnt/new/run /mnt/new/mnt /mnt/new/work && " +
    "chmod 1777 /mnt/new/tmp && sync && echo ok", 600000));

report("옮긴 뒤 용량", await vm.run("df -h /mnt/new | tail -1"));
report("핵심 파일 확인", await vm.run(
    "for f in /sbin/dotslash-init /sbin/mkfs.ext4 /usr/bin/sudo /usr/bin/vi /bin/lsblk; do " +
    "printf '%-24s %s\\n' $f \"$(test -e /mnt/new$f && echo ok || echo 없음)\"; done"));

// 빈 공간을 0 으로 덮어 압축률을 확보한다
await vm.run("dd if=/dev/zero of=/mnt/new/ZERO bs=1M 2>/dev/null; sync; rm -f /mnt/new/ZERO; sync", 300000);
await vm.run("umount /mnt/new; sync");

// hdb 를 크기로 찾아 꺼낸다
const ide = vm.emulator.v86.cpu.devices.ide;
const target = [ide.primary.slave, ide.primary.master, ide.secondary.slave, ide.secondary.master]
    .map((d) => d?.buffer?.buffer)
    .find((b) => b?.byteLength === SIZE_MB * 1024 * 1024);
if (!target) throw new Error(`${SIZE_MB}MB 디스크 버퍼를 못 찾음`);

const out = `images/dotslash-${SIZE_MB}.img`;
fs.writeFileSync(out, Buffer.from(target));
const oldGz = zlib.gzipSync(fs.readFileSync(SRC), { level: 9 }).length;
const newGz = zlib.gzipSync(Buffer.from(target), { level: 9 }).length;

console.log(`\n  raw   ${mb(fs.statSync(SRC).size)} -> ${mb(target.byteLength)}   (탭당 메모리 절약)`);
console.log(`  gzip  ${mb(oldGz)} -> ${mb(newGz)}`);
console.log(`\n${out} 생성. 확인 후 web/vm.js 와 build.mjs 의 경로를 바꿀 것.`);
process.exit(0);
