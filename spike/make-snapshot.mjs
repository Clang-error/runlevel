// 부팅을 끝낸 상태를 스냅샷으로 굳힌다.
//
// v86 은 순수 CPU 에뮬레이션이라 부팅 6초가 기기 성능에 그대로 비례한다.
// 4배 느린 CPU 에서 45초까지 늘어나는 것을 실측했다.
// 스냅샷으로 복원하면 부팅 과정 자체가 사라지고 압축 해제 + 메모리 복사만 남는다.
//
// 스냅샷은 디스크 이름 배정(sda/sdb)까지 그대로 굳힌다.
// 뒤집힌 상태로 뜨면 그게 박제되므로, 저장 전에 반드시 확인한다.
//
// 실행: node make-snapshot.mjs

import fs from "node:fs";
import zlib from "node:zlib";
import { boot, img, report } from "./harness.mjs";

const RAM_MB = 128;
const SCRATCH_MB = 64;
const DISK = "images/dotslash-64.img";
const OUT = "images/state.bin.zst";
const mb = (n) => (n / 1024 / 1024).toFixed(1) + "MB";

// 루트 파일시스템의 UUID 를 ext4 슈퍼블록에서 읽는다 (web/vm.js 와 같은 방식).
function rootUuid(buf) {
    const view = new DataView(buf);
    // MBR 첫 파티션의 시작 LBA
    const start = view.getUint32(0x1be + 8, true);
    const sb = start * 512 + 1024;                 // 슈퍼블록은 파티션 시작 + 1024
    if (view.getUint16(sb + 56, true) !== 0xef53) return null;   // ext 매직
    const b = new Uint8Array(buf, sb + 0x68, 16);
    const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const disk = img(DISK);
const uuid = rootUuid(disk.buffer);
if (!uuid) { console.error("루트 UUID 를 못 읽었다."); process.exit(1); }
console.log(`루트 UUID: ${uuid}\n부팅 중...`);

const t0 = Date.now();
const vm = await boot({
    memory_size: RAM_MB * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    uart1: true,
    bios: img("images/seabios.bin"),
    vga_bios: img("images/vgabios.bin"),
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-min"),
    hda: disk,
    hdb: { buffer: new ArrayBuffer(SCRATCH_MB * 1024 * 1024) },
    cmdline: `console=tty0 console=ttyS0 root=UUID=${uuid} rootfstype=ext4 rw `
           + `scsi_mod.scan=sync init=/sbin/runlevel-init`,
}, { logPath: "serial-snapshot.log", bootTimeout: 300000 });
console.log(`부팅 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// --- 굳히기 전에 상태가 멀쩡한지 확인한다 ---
const rootSrc = await vm.run("findmnt -no SOURCE /");
const scratch = await vm.run(
    'ROOTDISK=$(findmnt -no SOURCE / | sed "s/[0-9]*$//"); '
    + 'for d in /sys/block/sd*; do [ "/dev/${d##*/}" = "$ROOTDISK" ] || { echo "/dev/${d##*/}"; break; }; done');

report("루트 위치", rootSrc);
report("스크래치 디스크", scratch);
report("도구 확인", await vm.run(
    "for c in nmap mkfs.ext4 sudo vi gawk; do printf '%s ' \"$(command -v $c >/dev/null && echo $c || echo !$c)\"; done; echo"));
report("계정", await vm.run("cat /etc/runlevel/current"));

if (rootSrc.out.startsWith(scratch.out.trim())) {
    console.error("\n루트와 스크래치가 같은 디스크로 잡혔다. 스냅샷을 만들지 않는다.");
    process.exit(1);
}

// --- 깨끗한 상태로 정리한 뒤 굳힌다 ---
await vm.run("netlab reset 2>/dev/null; rm -rf /work/* /work/.[!.]* 2>/dev/null; mkdir -p /work; cd /work");
await vm.run("echo root > /etc/runlevel/user; sync");
report("정리 후 /work", await vm.run("ls -A /work | wc -l; echo '(0 이어야 정상)'"));

// --- RAM 을 압축 가능한 상태로 만든다 ---
//
// 부팅하면서 읽은 파일이 페이지 캐시에 사본으로 남는다. 스냅샷은 RAM 과 디스크를
// 둘 다 저장하므로 같은 내용이 두 번 들어가고, 압축해도 두 번 다 남는다.
// 실측: 루트 디스크 단독은 zstd 로 10.4MB 인데 스냅샷 전체는 34.15MB 였다.
//
// 캐시를 반환시키는 것만으로는 안 된다 — 반환된 페이지에는 옛 바이트가 그대로
// 남아 있어서 압축률이 그대로다. 0으로 덮어써야 압축이 먹는다.
// tmpfs 에 0을 쓰면 그 페이지가 곧 캐시 자리를 차지하므로, 지운 뒤엔 0만 남는다.
//
// RAM 전체를 채우면 OOM 킬러가 셸을 죽인다. 128MB 중 70MB 만 쓴다.
await vm.run("sync; echo 3 > /proc/sys/vm/drop_caches", 30000);
await vm.run([
    "mkdir -p /mnt/zerofill",
    "mount -t tmpfs -o size=80m tmpfs /mnt/zerofill",
    "dd if=/dev/zero of=/mnt/zerofill/z bs=1M count=70 2>/dev/null",
    "rm -f /mnt/zerofill/z",
    "umount /mnt/zerofill",
    "rmdir /mnt/zerofill",          // 스냅샷에 흔적을 남기지 않는다
    "sync; echo 3 > /proc/sys/vm/drop_caches",
].join("\n"), 180000);
// OOM 이 셸을 죽이지 않았는지 확인한다. 죽은 상태를 굳히면 복구가 안 된다.
//
// 실측한 실패다. 84MB 를 채웠을 때 두 확인이 모두 타임아웃났는데도 저장이 진행돼서
// "19.5MB 짜리 망가진 스냅샷"이 나왔다. 확인이 실패하면 반드시 여기서 멈춘다.
const aliveUser = await vm.run("cat /etc/runlevel/current");
const aliveMem = await vm.run("free -m | head -2");
report("0 채우기 후 계정", aliveUser);
report("0 채우기 후 메모리", aliveMem);
if (aliveUser.timedOut || aliveMem.timedOut || aliveUser.out.trim() !== "root") {
    console.error("\n0 채우기 뒤 게스트가 응답하지 않는다 (OOM 으로 셸이 죽은 것으로 보인다).");
    console.error("채우는 양을 줄여라. 스냅샷을 만들지 않는다.");
    process.exit(1);
}

// 셸 히스토리를 비우고 굳힌다.
//
// 이 스크립트는 사용자 셸(ttyS0)로 명령을 보낸다. 그게 그대로 얼어붙어서,
// 접속한 사람이 history 를 치면 스냅샷을 만든 과정이 통째로 나왔다.
// 이제 harness 가 명령마다 앞에 공백을 붙여 새로 쌓이지는 않지만,
// 이 시점까지 쌓여 있던 것은 여기서 지워야 없어진다.
await vm.run("history -c 2>/dev/null; true");
report("히스토리 비움", await vm.run("history | wc -l"));

console.log("\n스냅샷 저장 중...");
const raw = Buffer.from(await vm.emulator.save_state());
const zst = zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
fs.writeFileSync(OUT, zst);

console.log(`\n  raw   ${mb(raw.length)}`);
console.log(`  zstd  ${mb(zst.length)}   -> ${OUT}`);
console.log(`\n이제 web 은 커널·initramfs·디스크를 받지 않는다. 스냅샷 하나면 된다.`);
process.exit(0);
