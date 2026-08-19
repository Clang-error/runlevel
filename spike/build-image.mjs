// 스파이크 3 - 3단계: 배포용 루트 이미지를 만들고 크기를 잰다.
//
// 라이브 ISO로 부팅 -> /dev/sda 포맷 -> apk --root 로 루트파일시스템 설치 ->
// 디스크를 호스트로 내보내고 압축 크기 측정 -> 그 이미지로 다시 부팅해 검증.
//
// 커널은 이미지에 넣지 않는다. v86에 vmlinuz + initramfs 를 직접 주고
// root=/dev/sda1 로 부팅하므로 부트로더도 필요 없다.

import fs from "node:fs";
import zlib from "node:zlib";
import { boot, img, report } from "./harness.mjs";

const MIRROR = "http://dl-cdn.alpinelinux.org/alpine/v3.23";
const R = `-X ${MIRROR}/main -X ${MIRROR}/community`;
const PKGS = [
    "alpine-base",                       // openrc, busybox, 기본 레이아웃
    "e2fsprogs", "util-linux",           // mkfs.ext4, mount, lsblk, findmnt, fdisk
    "coreutils", "grep", "sed", "gawk", "findutils",  // GNU 텍스트 도구
    "bash", "less", "nano", "file", "tree",
];
const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";

console.log("빌드용 라이브 시스템 부팅...");
const live = await boot({
    memory_size: 512 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-lts"),
    cdrom: img("images/alpine-standard-3.23.5-x86.iso"),
    hda: img("images/target512.img"),
    cmdline: "console=ttyS0 modules=loop,squashfs,sd-mod,usb-storage",
    net_device: { type: "ne2k", relay_url: "fetch" },
}, { logPath: "serial-image.log", login: "root", bootTimeout: 300000 });

await live.run("ip link set eth0 up && udhcpc -i eth0 -n -q", 90000);
await live.run(`printf '%s/main\\n%s/community\\n' ${MIRROR} ${MIRROR} > /etc/apk/repositories`);
await live.run("apk update", 180000);
report("포맷 도구 설치", await live.run("apk add e2fsprogs util-linux 2>&1 | tail -2", 300000));

// grep -P 가 왜 안 됐는지 확인
report("grep 정체", await live.run("apk add grep >/dev/null 2>&1; grep --version | head -1; echo x | grep -P x 2>&1 | head -1"));

report("파티션 + ext4", await live.run(
    'printf "o\\nn\\np\\n1\\n\\n\\nw\\n" | fdisk /dev/sda >/dev/null 2>&1; sync; sleep 1; ' +
    'mkfs.ext4 -F -q /dev/sda1 && mkdir -p /mnt && mount /dev/sda1 /mnt && echo ok', 600000));

console.log("\n루트파일시스템 설치 중 ...");
report("apk --root 설치", await live.run(
    `apk add --root /mnt --initdb --keys-dir /etc/apk/keys ${R} ${PKGS.join(" ")} 2>&1 | tail -3`,
    2400000));

// 부팅에 필요한 최소 설정
report("시스템 설정", await live.run([
    `printf '%s/main\\n%s/community\\n' ${MIRROR} ${MIRROR} > /mnt/etc/apk/repositories`,
    "echo '/dev/sda1 / ext4 rw,relatime 0 1' > /mnt/etc/fstab",
    "echo dotslash > /mnt/etc/hostname",
    // 시리얼 콘솔에 getty 를 띄우고 root 는 비밀번호 없이
    "grep -q ttyS0 /mnt/etc/inittab || echo 'ttyS0::respawn:/sbin/getty -L 0 ttyS0 vt100' >> /mnt/etc/inittab",
    "sed -i 's|^root:[^:]*:|root::|' /mnt/etc/shadow",
    "echo done",
].join(" && ")));

report("설치 용량", await live.run("du -sh /mnt 2>/dev/null | tail -1; df -h /mnt | tail -1"));
await live.run("sync; umount /mnt");

// --- 디스크 내보내기 + 압축 크기 ---
const disk = Buffer.from(live.emulator.v86.cpu.devices.ide.primary.master.buffer.buffer);
fs.writeFileSync("images/dotslash-rootfs.img", disk);
const zst = zlib.zstdCompressSync(disk, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
fs.writeFileSync("images/dotslash-rootfs.img.zst", zst);

const kernel = fs.statSync("images/boot/vmlinuz-lts").size;
const initrd = fs.statSync("images/boot/initramfs-lts").size;
console.log("\n=== 배포 크기 ===");
console.log(`  vmlinuz-lts       ${mb(kernel)}`);
console.log(`  initramfs-lts     ${mb(initrd)}`);
console.log(`  rootfs (raw)      ${mb(disk.length)}`);
console.log(`  rootfs (zstd)     ${mb(zst.length)}`);
console.log(`  v86 엔진          2.4MB`);
console.log(`  --------------------------------`);
console.log(`  합계 (zstd 기준)  ${mb(kernel + initrd + zst.length + 2.4 * 1024 * 1024)}`);

live.emulator.destroy?.();

// --- 만든 이미지로 다시 부팅해서 검증 ---
console.log("\n만든 이미지로 재부팅 검증...");
const target = await boot({
    memory_size: 256 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-lts"),
    hda: img("images/dotslash-rootfs.img"),
    cmdline: "console=ttyS0 root=/dev/sda1 rootfstype=ext4 modules=sd-mod,ata_piix,ext4 rw",
}, { logPath: "serial-verify.log", login: "root", bootTimeout: 300000 });

console.log(`부팅 성공 (${process.uptime().toFixed(1)}s)`);
report("uname", await target.run("uname -a"));
report("루트 파일시스템", await target.run("findmnt -no SOURCE,FSTYPE /"));
report("GNU 도구", await target.run(
    "for c in mkfs.ext4 lsblk findmnt gawk bash tree; do printf '%-12s %s\\n' $c \"$(command -v $c || echo MISSING)\"; done"));
report("GNU sort -h", await target.run("printf '2K\\n1M\\n3K\\n' | sort -h | tr '\\n' ' '"));
report("GNU find -printf", await target.run("find /etc/hostname -printf '%p %s\\n'"));
report("text-03 문제 재현", await target.run(
    "mkdir -p /work && printf 'INFO  start\\nERROR db timeout\\nINFO  ok\\nERROR conn refused\\n' > /work/app.log && " +
    "grep ERROR /work/app.log > /work/error.txt && " +
    "test -f /work/error.txt && ! grep -qv ERROR /work/error.txt && [ \"$(wc -l < /work/error.txt)\" = 2 ] && echo '3개 조건 모두 통과'"));

process.exit(0);
