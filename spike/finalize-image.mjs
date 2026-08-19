// 이미지를 "깨끗하게 언마운트된" 상태로 만들어 내보낸다.
//
// 이미지를 만들 때 루트를 마운트한 채로 버퍼를 떠내면 파일시스템이 더럽다고 표시된다.
// 그러면 사용자가 접속할 때마다 커널이 저널을 복구한다.
//
//   EXT4-fs (sda1): orphan cleanup on readonly fs
//   EXT4-fs (sda1): recovery complete
//
// 루트는 실행 중에 언마운트할 수 없지만, 읽기 전용으로 remount 하면
// 저널이 비워지고 깨끗한 상태로 기록된다.
//
// 이미지를 바꾸는 스크립트(add-packages, slim-image, update-init)를 돌린 뒤
// 마지막에 한 번 실행할 것.
//
// 실행: node finalize-image.mjs

import fs from "node:fs";
import { boot, img, report } from "./harness.mjs";

const vm = await boot({
    memory_size: 128 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-min"),
    hda: img("images/dotslash-64.img"),
    cmdline: "console=ttyS0 root=/dev/sda1 rootfstype=ext4 rw init=/sbin/dotslash-init",
}, { logPath: "serial-final.log", bootTimeout: 300000 });

report("정리 전 파일시스템 상태", await vm.run("tune2fs -l /dev/sda1 2>/dev/null | grep -E 'Filesystem state|Mount count'"));

// 읽기 전용으로 되돌리면 저널이 비워지고 clean 으로 기록된다
report("읽기 전용으로 remount", await vm.run("sync; mount -o remount,ro / && echo ok", 60000));
report("정리 후 파일시스템 상태", await vm.run("tune2fs -l /dev/sda1 2>/dev/null | grep -E 'Filesystem state'"));

const disk = Buffer.from(vm.emulator.v86.cpu.devices.ide.primary.master.buffer.buffer);
fs.writeFileSync("images/dotslash-64.img", disk);
console.log(`\n이미지 저장 완료 (${(disk.length / 1024 / 1024).toFixed(0)}MB)`);
process.exit(0);
