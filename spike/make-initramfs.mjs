// Alpine 의 기본 initramfs 를 실행에 필요한 것만 남기고 잘라낸다.
//
// 기본 initramfs 는 커널 모듈 357개에 네트워크 카드 펌웨어까지 들어 있어 14MB 다.
// 부팅할 때마다 전부 압축 해제하는 비용이 에뮬레이터에서는 무시할 수 없다.
// 우리는 IDE 디스크 하나에서 ext4 루트를 올리는 것만 하면 된다.
//
// 어떤 모듈을 남길지는 이름으로 고르면 안 된다. modules.dep 를 읽어
// 의존성 폐포를 계산해야 한다. 이름만 보고 잘랐다가 sd_mod 의 숨은 의존성이
// 빠져서 루트를 못 찾고 복구 셸에 멈추는 일을 겪었다.
//
// 주의: 이미지를 빌드할 때(build-image.mjs, add-packages.mjs)는 라이브 ISO 로 부팅하며
//       네트워크와 squashfs 모듈이 필요하므로 원본 initramfs-lts 를 그대로 써야 한다.
//
// 실행: node make-initramfs.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = "images/boot/initramfs-lts";
const DST = "images/boot/initramfs-min";
const NEEDED = ["ata_piix", "sd_mod", "ext4"];   // 루트를 올리는 데 직접 필요한 것

if (!fs.existsSync(SRC)) {
    console.error(`${SRC} 가 없다. ISO 에서 먼저 추출할 것.`);
    process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "dotslash-ir-"));
const sh = (cmd) => execFileSync("sh", ["-c", cmd], { cwd: work });
sh(`bsdtar -xf '${path.resolve(SRC)}'`);

// --- modules.dep 를 읽어 의존성 폐포를 구한다 ---
const modDir = fs.readdirSync(path.join(work, "usr/lib/modules"))[0];
const base = path.join(work, "usr/lib/modules", modDir);
const depFile = path.join(base, "modules.dep");

const deps = new Map();                       // "kernel/.../foo.ko" -> [의존 경로...]
for (const line of fs.readFileSync(depFile, "utf8").split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    deps.set(line.slice(0, i).trim(),
             line.slice(i + 1).trim().split(/\s+/).filter(Boolean));
}
const nameOf = (p) => path.basename(p).replace(/\.ko(\..*)?$/, "").replace(/-/g, "_");

const keep = new Set();
const visit = (p) => {
    if (keep.has(p)) return;
    keep.add(p);
    for (const d of deps.get(p) ?? []) visit(d);
};
for (const want of NEEDED) {
    const hit = [...deps.keys()].find((p) => nameOf(p) === want);
    if (!hit) { console.error(`모듈을 못 찾음: ${want}`); process.exit(1); }
    visit(hit);
}

// --- 남길 것 빼고 삭제 ---
let removed = 0;
const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.ko(\..*)?$/.test(e.name)) continue;
        if (!keep.has(path.relative(base, full))) { fs.rmSync(full); removed++; }
    }
};
walk(path.join(base, "kernel"));

// 네트워크 카드 펌웨어. 네트워크를 쓰지 않으므로 통째로 뺀다.
fs.rmSync(path.join(work, "usr/lib/firmware"), { recursive: true, force: true });

// Alpine 기본 init(nlplug-findfs)은 그대로 둔다.
//
// 직접 만든 init 으로 갈아끼우면 장치 스캔 2.5초를 아낄 수 있지만, 시도해보니
// 모듈을 한꺼번에 올리면서 디스크 이름 부여에 경쟁이 생겼다.
// 2.5초를 아끼자고 감수할 위험이 아니다.
//
// 다만 그 경쟁은 기본 init 에서도 일어난다. 한 조각만 끼워넣어 막는다. ↓

// --- 디스크 이름(sda/sdb)을 확정하는 조각 ---
//
// sd 드라이버는 PROBE_PREFER_ASYNCHRONOUS 라 비동기로 probe 한다. 그래서 같은
// IDE 채널에 물린 두 디스크(마스터=루트, 슬레이브=스크래치)의 이름 배정 순서가
// 부팅마다 뒤집힌다 — 실측으로 12회 중 2회.
//
// 뒤집히면 root=/dev/sda1 이 빈 스크래치 디스크를 가리켜 마운트에 실패하고
// 복구 셸에 떨어진다(부팅이 끝나지 않는다). 부팅이 됐다 해도 T2 문제가
// "/dev/sdb 를 포맷하라"고 시키는데 그게 루트 디스크다.
//
// 커널 파라미터로는 못 막는다. scsi_mod.scan=sync 도 driver_async_probe 도
// 소용없다 (전자는 스캔만 동기화하고, 후자는 PROBE_PREFER_ASYNCHRONOUS 를 못 이긴다).
//
// 그래서 루트를 물리기 직전에 전부 뗐다가 SCSI 주소 순서대로 다시 붙인다.
// sysfs 의 bind 는 동기라서 붙인 순서가 그대로 이름이 된다.
// 커널이 아직 안 붙인 디스크도 여기서 직접 붙이므로 기다릴 필요가 없다
// (cmdline 의 scsi_mod.scan=sync 덕에 이 시점에 SCSI 장치 목록은 완성돼 있다).
const PIN_DISK_NAMES = `
	# --- dotslash: 디스크 이름(sda/sdb)을 확정한다 ---
	# sd 드라이버가 비동기로 probe 해서 sda/sdb 배정이 부팅마다 뒤집힌다.
	# 전부 뗐다가 SCSI 주소 순서대로 다시 붙인다 — sysfs bind 는 동기라
	# 붙인 순서가 그대로 이름이 된다. 루트를 아직 안 물린 지금이 유일한 시점이다.
	_sd=/sys/bus/scsi/drivers/sd
	if [ -d "$_sd" ]; then
		_disks=$(ls /sys/bus/scsi/devices 2>/dev/null | grep '^[0-9]*:' | sort)
		for _d in $_disks; do echo "$_d" > "$_sd/unbind" 2>/dev/null; done
		for _d in $_disks; do echo "$_d" > "$_sd/bind" 2>/dev/null; done
	fi
	# --- dotslash 끝 ---
`;

// nlplug-findfs 호출이 끝나는 줄 바로 뒤에 끼운다.
// 그 전에는 디스크가 아직 없고, 그 뒤로는 곧바로 루트를 mount 한다.
const initPath = path.join(work, "init");
const initSrc = fs.readFileSync(initPath, "utf8");
const ANCHOR = "\t\t$KOPT_root\n";
if (!initSrc.includes(ANCHOR)) {
    console.error("init 에서 nlplug-findfs 호출을 못 찾았다. Alpine init 구조가 바뀌었다.");
    process.exit(1);
}
const at = initSrc.indexOf(ANCHOR) + ANCHOR.length;
fs.writeFileSync(initPath, initSrc.slice(0, at) + PIN_DISK_NAMES + initSrc.slice(at));

// libcrypto/libssl/libcryptsetup 은 건드리지 않는다.
// 루트를 찾아주는 nlplug-findfs 가 이들에 링크돼 있어서, 지우면 실행 자체가 안 되고
// 루트를 못 찾은 채 복구 셸에 멈춘다 (부팅이 2.6초에 "끝나는" 것처럼 보인다).

sh(`find . -type d -empty -delete 2>/dev/null || true`);
sh(`find . | cpio -o -H newc 2>/dev/null | gzip -9 > '${path.resolve(DST)}'`);
fs.rmSync(work, { recursive: true, force: true });

const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1) + "MB";
console.log(`원본  ${mb(SRC)}`);
console.log(`결과  ${mb(DST)}   남긴 모듈 ${keep.size}개, 뺀 모듈 ${removed}개`);
console.log(`남긴 목록: ${[...keep].map((p) => nameOf(p)).sort().join(" ")}`);
