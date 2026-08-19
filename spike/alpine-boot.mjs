// 스파이크 3 - 1단계: Alpine ISO 커널이 v86에서 시리얼 셸까지 뜨는가.
// ISO를 cdrom으로 붙여야 initramfs가 modloop(squashfs)을 찾아 모듈을 로드한다.

import { boot, img, report } from "./harness.mjs";

const ISO = "images/alpine-standard-3.23.5-x86.iso";

console.log("Alpine 부팅 중 (ISO 774MB 로딩에 시간이 걸린다)...");
const { run } = await boot({
    memory_size: 512 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-lts"),
    cdrom: img(ISO),
    hda: img("images/target512.img"),
    cmdline: "console=ttyS0 modules=loop,squashfs,sd-mod,usb-storage",
}, { logPath: "serial-alpine.log", login: "root", bootTimeout: 300000 });

console.log(`셸 확보 (${process.uptime().toFixed(1)}s)`);

report("uname -a", await run("uname -a"));
report("alpine 버전", await run("cat /etc/alpine-release"));
report("블록 디바이스", await run("cat /proc/partitions"));
report("ATA 인식", await run("dmesg | grep -i -E 'ata[0-9]|sda' | head -8"));
report("apk 동작", await run("apk --version"));
report("로컬 apk 저장소", await run("cat /etc/apk/repositories; ls /media/*/apks 2>/dev/null | head -3"));
report("mkfs.ext4 존재", await run("command -v mkfs.ext4 lsblk findmnt fdisk"));
report("네트워크", await run("ip addr show eth0 2>/dev/null | head -5; ip route 2>/dev/null"));

process.exit(0);
