// 디스크 이미지를 다이어트한다. 배포 전송량에 직결된다.
//
// 두 가지를 한다.
//   1) vim 의 문서·번역·튜토리얼 제거. 편집기 기능과 무관한 덩치다.
//   2) 빈 공간 0 채우기. 파일을 지워도 내용은 디스크에 남아 있어서
//      gzip 이 그 쓰레기까지 압축한다. 0 으로 덮으면 압축률이 확 올라간다.
//
// 실행: node slim-image.mjs

import fs from "node:fs";
import zlib from "node:zlib";
import { boot, img, report } from "./harness.mjs";

const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";
const before = fs.statSync("images/dotslash-64.img").size;
const beforeGz = zlib.gzipSync(fs.readFileSync("images/dotslash-64.img"), { level: 9 }).length;

const vm = await boot({
    memory_size: 128 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-min"),
    hda: img("images/dotslash-64.img"),
    cmdline: "console=ttyS0 root=/dev/sda1 rootfstype=ext4 rw init=/sbin/dotslash-init",
}, { logPath: "serial-slim.log", bootTimeout: 300000 });

report("정리 전 용량", await vm.run("df -h / | tail -1; du -sh /usr/share/vim 2>/dev/null"));

// vim 은 뺀다. 런타임까지 17MB 라 전송량의 15% 를 차지하는데,
// busybox vi 가 진짜 vi(모드 전환, hjkl, :wq)라 연습에는 충분하다.
// 잃는 건 문법 강조뿐이고, 실제 서버에서 마주치는 환경에도 이쪽이 더 가깝다.
report("vim 제거", await vm.run([
    "rm -rf /usr/share/vim /usr/bin/vim /usr/bin/vimdiff /usr/bin/xxd",
    "rm -rf /usr/share/doc /usr/share/man /usr/share/licenses 2>/dev/null",
    "rm -rf /var/cache/apk/*",
    "echo done",
].join("; "), 120000));

report("정리 후 용량", await vm.run("df -h / | tail -1"));
report("편집기 확인", await vm.run(
    "for c in vi nano sed; do printf '%-6s %s\\n' $c \"$(command -v $c || echo 없음)\"; done"));
report("vi 편집 동작", await vm.run(
    "printf 'a\\nb\\nc\\n' > /tmp/t.txt && vi -c ':2d' -c ':wq' /tmp/t.txt >/dev/null 2>&1; tr '\\n' ' ' < /tmp/t.txt"));

// 빈 공간을 0 으로 덮는다. 지운 파일의 잔재가 남아 있으면 gzip 이 그걸 다 압축한다.
report("빈 공간 0 채우기", await vm.run(
    "dd if=/dev/zero of=/ZEROFILL bs=1M 2>/dev/null; sync; rm -f /ZEROFILL; sync; df -h / | tail -1", 300000));

const disk = Buffer.from(vm.emulator.v86.cpu.devices.ide.primary.master.buffer.buffer);
fs.writeFileSync("images/dotslash-64.img", disk);
const after = zlib.gzipSync(disk, { level: 9 }).length;

console.log("\n=== 전송량 ===");
console.log(`  raw   ${mb(before)} -> ${mb(disk.length)}`);
console.log(`  gzip  ${mb(beforeGz)} -> ${mb(after)}`);
process.exit(0);
