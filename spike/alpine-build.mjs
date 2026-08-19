// 스파이크 3 - 2단계: Alpine에 GNU 도구를 깔고 진짜 mkfs.ext4 -> mount 를 검증한다.
//
// ISO 로컬 저장소에는 패키지가 103개뿐이라 GNU 도구가 없다.
// v86의 fetch 네트워크 백엔드로 dl-cdn에서 받아온다 (Node에서 그대로 동작).
// HTTPS는 불투명한 TLS라 프록시가 못 푼다. 반드시 http:// 저장소를 써야 한다.

import fs from "node:fs";
import { boot, img, report } from "./harness.mjs";

const MIRROR = "http://dl-cdn.alpinelinux.org/alpine/v3.23";
const PKGS = [
    "e2fsprogs",    // mkfs.ext4, tune2fs, e2fsck
    "util-linux",   // mount, lsblk, findmnt, fdisk 제대로 된 버전
    "coreutils",    // GNU ls/cat/sort/wc ...
    "grep", "sed", "gawk", "findutils",
    "bash",
];

console.log("Alpine 부팅 중...");
const { emulator, run } = await boot({
    memory_size: 512 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-lts"),
    cdrom: img("images/alpine-standard-3.23.5-x86.iso"),
    hda: img("images/target512.img"),
    cmdline: "console=ttyS0 modules=loop,squashfs,sd-mod,usb-storage",
    net_device: { type: "ne2k", relay_url: "fetch" },   // type 생략하면 eth0 자체가 안 생긴다
}, { logPath: "serial-build.log", login: "root", bootTimeout: 300000 });
console.log(`셸 확보 (${process.uptime().toFixed(1)}s)`);

// --- 네트워크 ---
report("eth0 올리기", await run("ip link set eth0 up && udhcpc -i eth0 -n -q 2>&1 | tail -3", 90000));
report("IP / 라우트", await run("ip -4 addr show eth0 | grep inet; ip route | head -2"));
report("HTTP 도달 확인", await run(`wget -q -O- ${MIRROR}/main/x86/APKINDEX.tar.gz | wc -c`, 120000));

// --- 패키지 설치 ---
await run(`printf '%s/main\\n%s/community\\n' ${MIRROR} ${MIRROR} > /etc/apk/repositories`);
report("apk update", await run("apk update 2>&1 | tail -3", 180000));
report(`apk add (${PKGS.length}개)`, await run(`apk add ${PKGS.join(" ")} 2>&1 | tail -4`, 600000));

report("도구 경로", await run(
    "for c in mkfs.ext4 lsblk findmnt fdisk gawk bash; do printf '%-12s %s\\n' $c \"$(command -v $c || echo MISSING)\"; done"));
report("GNU grep -P", await run("echo abc123 | grep -oP '\\\\d+'"));
report("GNU sort -h", await run("printf '2K\\n1M\\n3K\\n' | sort -h | tr '\\n' ' '"));
report("GNU find -printf", await run("find /etc/hostname -printf '%p %s\\n'"));
report("GNU ls --time-style", await run("ls --time-style=+%Y /etc/hostname"));

// --- 스파이크 1의 완전판: 진짜 ext4 ---
report("파티션 생성", await run(
    'printf "o\\nn\\np\\n1\\n\\n\\nw\\n" | fdisk /dev/sda 2>&1 | tail -2; sync; sleep 1'));
report("lsblk", await run("lsblk /dev/sda"));
report("mkfs.ext4 /dev/sda1", await run("mkfs.ext4 -F -q /dev/sda1 && echo done", 600000));
report("mount", await run("mkdir -p /data && mount /dev/sda1 /data"));
report("findmnt -no FSTYPE /data  (채점 조건 그대로)", await run(
    '[ "$(findmnt -no FSTYPE /data)" = ext4 ] && findmnt -no FSTYPE /data'));
report("mountpoint -q /data  (채점 조건 그대로)", await run("mountpoint -q /data"));
report("쓰기/읽기", await run("echo 'dotslash ext4' > /data/t.txt && sync && cat /data/t.txt"));
report("umount 후 재마운트", await run("umount /data && mount /dev/sda1 /data && cat /data/t.txt"));
report("fstab 채점 조건", await run(
    "echo '/dev/sda1 /data ext4 defaults 0 2' >> /etc/fstab && grep -qE '\\\\s/data\\\\s' /etc/fstab && echo matched"));

// --- 디스크를 호스트로 내보내기 ---
await run("sync");
const disk = emulator.v86.cpu.devices.ide.primary.master.buffer.buffer;
fs.writeFileSync("images/built-sda.img", Buffer.from(disk));
console.log(`\n디스크 내보내기: images/built-sda.img (${(disk.byteLength / 1024 / 1024).toFixed(0)}MB)`);

process.exit(0);
