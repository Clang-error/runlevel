// 이미지에 패키지를 추가한다.
//
// 완성된 이미지로 직접 부팅하면 네트워크를 못 쓴다. 용량을 아끼려고 커널 모듈
// (/lib/modules)을 안 넣어서 ne2k 드라이버가 없기 때문이다.
// 그래서 이미지를 처음 만들 때처럼 라이브 ISO 로 부팅해 디스크를 마운트하고
// apk --root 로 설치한다.
//
// 실행: node add-packages.mjs sudo vim

import fs from "node:fs";
import { boot, img, report } from "./harness.mjs";

const MIRROR = "http://dl-cdn.alpinelinux.org/alpine/v3.23";
const PKGS = process.argv.slice(2);
if (!PKGS.length) { console.error("설치할 패키지를 지정하세요"); process.exit(1); }

console.log(`설치할 패키지: ${PKGS.join(" ")}\n라이브 시스템 부팅 중...`);
const vm = await boot({
    memory_size: 512 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-lts"),
    cdrom: img("images/alpine-standard-3.23.5-x86.iso"),
    hda: img("images/dotslash-64.img"),
    cmdline: "console=ttyS0 modules=loop,squashfs,sd-mod,usb-storage",
    net_device: { type: "ne2k", relay_url: "fetch" },
}, { logPath: "serial-pkg.log", login: "root", bootTimeout: 300000 });

report("네트워크", await vm.run("ip link set eth0 up && udhcpc -i eth0 -n -q 2>&1 | tail -1", 90000));
await vm.run(`printf '%s/main\\n%s/community\\n' ${MIRROR} ${MIRROR} > /etc/apk/repositories`);
report("apk update", await vm.run("apk update 2>&1 | tail -1", 180000));
report("대상 디스크 마운트", await vm.run("mkdir -p /mnt && mount /dev/sda1 /mnt && df -h /mnt | tail -1"));

console.log("\n설치 중 (에뮬레이트된 네트워크라 오래 걸린다)...");
report(`apk add --root /mnt ${PKGS.join(" ")}`, await vm.run(
    `apk add --root /mnt -X ${MIRROR}/main -X ${MIRROR}/community ${PKGS.join(" ")} 2>&1 | tail -3`,
    1800000));

// sudo 는 호스트 이름을 못 풀면 실행할 때마다 경고를 뱉는다
report("hosts 정리", await vm.run(
    "grep -q dotslash /mnt/etc/hosts || echo '127.0.0.1 dotslash' >> /mnt/etc/hosts; tail -1 /mnt/etc/hosts"));

report("설치 확인", await vm.run(
    "for c in " + PKGS.join(" ") + "; do printf '%-8s %s\\n' $c \"$(ls /mnt/usr/bin/$c /mnt/usr/sbin/$c /mnt/bin/$c 2>/dev/null | head -1 || echo MISSING)\"; done"));
report("용량", await vm.run("df -h /mnt | tail -1"));

// 설치 중에만 쓴 네트워크 저장소는 되돌린다 (실행 시에는 네트워크가 없다)
await vm.run("printf '/media/cdrom/apks\\n' > /mnt/etc/apk/repositories; sync; umount /mnt");

const disk = Buffer.from(vm.emulator.v86.cpu.devices.ide.primary.master.buffer.buffer);
fs.writeFileSync("images/dotslash-64.img", disk);
console.log(`\n이미지 갱신 완료 (${(disk.length / 1024 / 1024).toFixed(0)}MB)`);
process.exit(0);
