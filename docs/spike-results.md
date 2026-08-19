# 스파이크 결과 (2026-08-16)

착수 전 검증하기로 한 항목들. 코드는 [`spike/`](../spike/)에 있다.

**검증 방법**: v86은 브라우저 전용이 아니라 **Node에서도 그대로 돈다.**
`npm i v86` 후 `libv86`을 import하면 되고, 시리얼을 통해 게스트를 스크립트로 조종할 수 있다.
덕분에 브라우저 없이 터미널에서 전부 자동 검증했다. 이 하네스는 나중에
채점기 회귀 테스트로 그대로 재사용한다.

## 스파이크 1 — 블록 디바이스 / mount ✅ 통과

**결론: v86은 진짜 블록 디바이스를 제공한다. T2 계획 유효.**

`hda`/`hdb`로 붙인 이미지가 게스트에 실제 ATA 디스크로 잡힌다.

```
ata1.00: ATA-0: v86 ATA HD, 1.00, max MWDMA2
sd 0:0:0:0: [sda] 131072 512-byte logical blocks: (67.1 MB/64.0 MiB)
```

검증한 것:

| 항목 | 결과 |
|---|---|
| `/dev/sda`, `/dev/sdb` 로 인식 | ✅ |
| `fdisk` 로 파티션 생성 → `/proc/partitions`에 `sda1` 등장 | ✅ |
| `mount -t vfat /dev/sdb /data` | ✅ |
| 마운트 후 파일 쓰기/읽기 | ✅ |
| `umount` → 재마운트 후 파일 유지 | ✅ |
| `df -h /data` 정상 출력 | ✅ |
| `mountpoint -q /data` (채점 조건 형태) | ✅ |

조사 단계에서 "공개된 성공 사례를 못 찾았다"고 적었던 부분은 **해소됐다.**

## 스파이크 2 — 시리얼 채점 왕복 ✅ 통과

**결론: `check` 스키마를 설계대로 구현할 수 있다.**

`serial0_send()`로 명령을 보내고 `serial0-output-byte` 리스너로 출력과 exit code를
안정적으로 회수한다. 부팅 후 명령 왕복은 수십 ms 수준이라 "매 명령 실행 직후 자동 채점"이
성능상 문제없다.

구현 요령 — **마커를 문자열 리터럴로 쪼개서 보낸다.**

```js
emulator.serial0_send(`echo "__RUN""__"; ${cmd}; echo "__CHK""__$?"\n`)
```

셸이 입력한 명령줄을 그대로 에코하기 때문에, 마커를 통째로 보내면 에코된 명령줄에서
먼저 매칭돼 오탐이 난다. `"__RUN""__"`로 쪼개면 에코에는 쪼개진 형태로,
실행 결과에는 합쳐진 `__RUN__`으로 나타나서 구분된다.

시작 마커(`__RUN__`)도 반드시 필요하다. 없이 "첫 줄을 버리는" 방식으로 하면
**명령줄이 80칸에서 줄바꿈될 때 명령어 꼬리가 출력에 섞여 들어간다.**
(실제로 이 버그를 먼저 만들었다가 진단 출력이 깨져서 발견했다.)

## 스파이크 3 — 이미지 빌드 ✅ 통과

**Alpine 3.23.5 x86 기반 학습용 이미지 완성. 최초 로딩 34.6MB.**

| 구성 | 크기 |
|---|---|
| v86 엔진 (wasm + js) | 2.3MB |
| vmlinuz-lts | 8.2MB |
| initramfs-lts | 14.1MB |
| rootfs (zstd) | 10.0MB — raw 512MB, 실사용 34MB |
| **최초 로딩 합계** | **34.6MB** |

부팅 7.0초. 패키지 86개. 모바일에서도 감당 가능한 크기다.
스냅샷(`initial_state`)을 쓰면 부팅 과정을 건너뛸 수 있지만, 스냅샷은 RAM을 통째로 담아
오히려 커질 수 있다. 7초면 충분하므로 일단 안 쓴다.

조사 단계에서 "32비트 전용이라 최신 배포판이 사멸 중"이라고 적었는데,
**Alpine은 2026-08 현재도 x86(32비트)를 정식 릴리스한다** (3.23.5까지 확인).
T1/T2 범위에서는 당장 문제가 아니다. systemd를 쓰는 T3에서만 유효한 리스크다.

부팅 방법 — ISO를 cdrom으로 붙이고 커널/initramfs는 따로 준다:

```js
bzimage: img("boot/vmlinuz-lts"),        // ISO에서 bsdtar로 추출
initrd:  img("boot/initramfs-lts"),
cdrom:   img("alpine-standard-3.23.5-x86.iso"),
cmdline: "console=ttyS0 modules=loop,squashfs,sd-mod,usb-storage",
```

ISO의 원래 `syslinux.cfg` APPEND 값에 `console=ttyS0`만 더한 것이다.
initramfs에 `ata_piix`/`sd_mod`/`ext4`/`squashfs`가 들어있어 CD의 modloop을 찾아 올라간다.
Alpine은 getty를 띄우므로 하네스가 `login:` 프롬프트에 `root`를 먼저 보내야 셸이 나온다.

### 검증 통과 — disk-02 문제의 채점 조건 그대로

```
mkfs.ext4 -F -q /dev/sda1                        PASS
mount /dev/sda1 /data                            PASS
[ "$(findmnt -no FSTYPE /data)" = ext4 ]         PASS
mountpoint -q /data                              PASS
쓰기 -> sync -> 읽기                              PASS
umount -> 재마운트 -> 파일 유지                    PASS
```

GNU 도구도 `mkfs.ext4 lsblk findmnt fdisk gawk bash` 전부 설치됐고
`sort -h`, `find -printf`, `ls --time-style`까지 GNU 동작을 확인했다.

### 여기서 막혔던 것들

**① ISO 로컬 저장소에는 패키지가 103개뿐이다.**
`apk add e2fsprogs` 하나는 되지만 coreutils/gawk/findutils/util-linux는 없다.
apk는 원자적이라 하나만 없어도 전부 실패한다. 네트워크가 필요하다.

**② v86 네트워크는 되지만 `type`을 반드시 명시해야 한다.**

```js
net_device: { type: "ne2k", relay_url: "fetch" }   // type 빼면 eth0 자체가 안 생긴다
```

`fetch` 백엔드는 Node에서 그대로 동작한다. DHCP/ARP/DNS를 내부에서 처리하고
게스트의 HTTP 요청을 호스트 `fetch()`로 번역한다. 게스트에서 `udhcpc -i eth0` 한 번이면
`192.168.86.100`을 받고 `dl-cdn.alpinelinux.org` 조회까지 된다. 저장소 26,055개 접근 확인.

**HTTPS는 안 된다.** 불투명한 TLS 스트림이라 프록시가 못 푼다.
반드시 `http://` 저장소를 써야 한다. (Alpine은 http 미러를 지원하므로 문제없음)

**③ ~~`grep -P`는 Alpine에서 안 된다.~~ — 2026-08-19 확인 결과 된다.**

당시 busybox grep(PCRE 없음)을 보고 내린 결론이었는데, 그 뒤 `add-packages.mjs`가
GNU grep을 얹으면서 사정이 바뀌었다. 지금 게스트는 **GNU grep 3.12**이고
`--help`에 `-P, --perl-regexp`가 있으며 `echo 'ab 12' | grep -oP '\d+'` → `12` 로 실측된다.

이 항목을 갱신하지 않은 탓에 CLAUDE.md와 기본명령어 사전에 "안 된다"고 잘못 적었다.
게스트 사실은 문서에 적어두고 잊지 말고, 이미지가 바뀌면 다시 재보아야 한다.

### 게스트가 수정한 디스크를 호스트로 빼내는 법

공식 API에는 없지만 내부 구조로 접근된다. 게스트에서 `dd`로 써넣은 서명이
호스트에서 그대로 읽히는 것을 확인했다.

```js
const disk = emulator.v86.cpu.devices.ide.primary.master.buffer.buffer;  // ArrayBuffer
fs.writeFileSync("rootfs.img", Buffer.from(disk));
```

문서화된 API가 아니므로 v86 업데이트 때 깨질 수 있다. 빌드 스크립트에서만 쓰고
런타임 채점에는 쓰지 않는다 (런타임은 9p `read_file` + 시리얼).

### 스냅샷은 주의

ISO를 붙인 채로 `save_state()`를 뜨면 **raw 1.78GB / zstd 1.21GB**가 나온다.
ISO(774MB) + 디스크(512MB) + RAM(512MB)이 전부 들어가기 때문이다.
배포용 스냅샷은 반드시 ISO를 떼고 RAM을 줄인 상태에서 떠야 한다.

### init 시스템을 쓰지 않기로 했다

`apk add --root /mnt --initdb` 로 만든 루트에는 OpenRC 서비스가 하나도 등록돼 있지 않아
부팅이 "Caching service dependencies"에서 멈춘다. `setup-disk`가 해주는
`rc-update add` 작업이 빠졌기 때문이다.

서비스 관리는 T3 범위이고 연습 샌드박스에 init 시스템은 필요 없으므로,
OpenRC를 걷어내고 필요한 것만 마운트하는 전용 init 을 쓴다.

```sh
# /sbin/dotslash-init  — cmdline 에 init=/sbin/dotslash-init
mount -t proc proc /proc; mount -t sysfs sys /sys; mount -t devtmpfs dev /dev
mount -o remount,rw /
mkdir -p /dev/pts && mount -t devpts devpts /dev/pts
hostname dotslash
exec /bin/sh
```

부팅이 빨라지고 동작이 결정적이 된다. `ps`도 정상 동작한다(/proc 마운트 확인).

**함정**: Alpine 기본 `/etc/inittab`에는 ttyS0 줄이 **주석 처리된 채로** 들어있다.
`grep -q ttyS0 /etc/inittab || echo ...` 식으로 추가하면 주석에 매칭돼서 조용히 건너뛴다.
(이것 때문에 첫 시도가 로그인 프롬프트 없이 죽었다.)

### 완성된 이미지에서 실제 문제 채점 확인

`problems/t1-text/text-03.yaml` 의 setup → 풀이 → check 3개를 그대로 실행해 전부 통과했다.

```
[setup]   /work/app.log 생성                        PASS
[풀이]    grep ERROR /work/app.log > /work/error.txt PASS
[check 1] test -f /work/error.txt                   PASS
[check 2] ! grep -qv ERROR /work/error.txt          PASS
[check 3] [ "$(wc -l < /work/error.txt)" = 2 ]      PASS
```

## 스파이크 4 — 브라우저 재현 ✅ 통과

Node에서만 검증했던 것을 실제 브라우저(헤드리스 Chrome)에서 그대로 돌렸다.
**10/10 통과, 부팅 7.0초.**

```
PASS  uname                    Linux dotslash 6.18.36-0-lts ... i686
PASS  루트 파일시스템           /dev/sda1 ext4
PASS  GNU 도구 존재
PASS  GNU sort -h              2K 3K 1M
PASS  ps (/proc 마운트)
PASS  [setup] text-03
PASS  [풀이] grep ERROR > error.txt
PASS  [check 1] error.txt 존재
PASS  [check 2] ERROR 줄만
PASS  [check 3] 2줄
```

**COOP/COEP 헤더 없는 평범한 정적 서버에서 그대로 돌았다.**
조사 단계에서 v86의 최대 실무적 장점으로 꼽았던 부분이 실증됐다.
GitHub Pages 같은 헤더 설정 불가한 호스팅에 그대로 올릴 수 있다는 뜻이다.

시리얼 왕복 코드는 Node 하네스와 사실상 동일하다(`web/main.js`).
채점기를 브라우저/서버 어느 쪽에 두든 같은 코드를 쓴다.

디스크 이미지는 128MB로 줄였다. 실사용 34MB인데 512MB를 브라우저가
통째로 들고 있을 이유가 없다. zstd 9.8MB.

검증 방법 — 브라우저가 자체 테스트 결과를 `POST /result`로 서버에 보내고,
헤드리스 Chrome을 띄운 뒤 `result.json`이 생길 때까지 기다린다.
`--dump-dom`은 페이지 로드 직후를 찍으므로 비동기 부팅에는 못 쓴다.

```sh
cd web && npm install
node serve.mjs 8099 &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --user-data-dir=/tmp/chrome-prof http://localhost:8099/ &
# result.json 생성 대기
```

브라우저에서 직접 보려면 `node serve.mjs` 후 `http://localhost:8080` 접속.
xterm.js 터미널이 뜨고 직접 타이핑할 수 있다.

## 부팅 화면 — 기본은 감추고, 검증할 때만 보여준다

| 모드 | 부팅 중 화면 |
|---|---|
| 기본 | 대기 화면. 로그를 보여주지 않는다 |
| `?selftest=1` | v86 의 VGA 화면 — SeaBIOS부터 커널 로그까지 그대로 |
| 부팅 실패 시 | 모드와 무관하게 VGA 화면을 띄운다 (어디서 멈췄는지 보여야 한다) |

준비되면 어느 쪽이든 xterm 터미널로 전환한다.

커널 파라미터는 `console=tty0 console=ttyS0` 다.
로그는 **양쪽에 다 나가고**, `/dev/console` 은 마지막에 적은 `ttyS0` 가 되므로
셸은 시리얼에 붙는다. 덕분에 **"보여주는 화면"과 "채점하는 채널"이 분리된다.**
채점 명령을 시리얼로 아무리 주고받아도 VGA 화면에는 안 보인다.

기본 모드에서도 VGA 는 계속 그려지고 있고, DOM 에 붙이지 않을 뿐이다.
그래서 실패했을 때 `hidden` 만 풀면 그때까지의 로그가 그대로 남아 있다.

`quiet loglevel=3` 은 뺐다. 검증할 때 로그가 많이 나오는 편이 낫다.

VGA 화면에 실제로 커널 로그가 렌더링되는 것을 확인했다.

```
[    3.794213] ata1.00: ATA-0: v86 ATA HD, 1.00, max MWDMA2
[    3.881713] sd 0:0:0:0: [sda] 262144 512-byte logical blocks: (134 MB/128 MiB)
[    3.899225] sd 0:0:0:0: [sda] Attached SCSI disk
[    6.228313] EXT4-fs (sda1): mounted filesystem ... with ordered data mode.
[    6.229613] Mounting root: ok.
```

부팅이 실패하면 VGA 화면을 그대로 두므로 어디서 멈췄는지 바로 보인다.

## 스냅샷 방식은 기각

두 가지를 재보고 결정했다.

| | 크기 | 부팅 |
|---|---|---|
| **A. 부팅 + 로그 감추기** ← 채택 | 34.5MB | 7초 |
| B. `initial_state` 스냅샷 | 43.8MB | 없음 |

스냅샷은 RAM을 통째로 담아서 압축해도 41.5MB다. **부팅 방식보다 오히려 크고**,
어차피 부팅 광경을 보여줄 거라 7초가 손해가 아니다.

실제 기다림은 34MB 다운로드 쪽이라, 진행률은 `download-progress` 리스너로 보여준다.

RAM은 128MB로 충분하다 (게스트 기준 90MB 중 11MB 사용).

재검증: **부팅 6.7초, 10/10 통과.**

## 남은 결정

- 커널 모듈(`loop`, `dm`) 포함 여부. 지금 이미지에는 `linux-lts` 패키지를 안 넣어서
  `/lib/modules`가 없다. initramfs가 부팅 때 올린 `ata_piix`/`sd_mod`/`ext4`는
  이미 커널에 상주하므로 T1/T2 기본 문제는 문제없지만,
  나중에 loop device나 LVM을 하려면 모듈을 넣어야 하고 용량이 는다

<details>
<summary>(구) 최초 계획 — 기성 이미지가 왜 안 되는가</summary>

**여기가 실제 남은 작업이다. 엔진이 아니라 유저랜드 문제.**

테스트에 쓴 copy.sh 기성 이미지들은 학습용으로 못 쓴다.

| 이미지 | 문제 |
|---|---|
| `buildroot-bzimage68.bin` | **커널에 ATA 드라이버가 없다.** v86은 IDE 컨트롤러를 제대로 노출하는데(`pci 0000:00:1e.0: legacy IDE quirk`) 커널이 디스크를 못 잡아 `/proc/partitions`가 비어 있었다. 원인 진단에 시간을 썼는데, v86 문제가 아니라 커널 config 문제였다 |
| `linux4.iso` | ATA는 되지만 **busybox 265개 애플릿에 mkfs가 하나도 없다.** 커널은 ext2/3/4·vfat을 다 지원하는데 포맷할 도구가 없다 |

필요한 이미지 요건:

- 커널: ATA(`CONFIG_ATA_PIIX`) + ext2/3/4 + loop + (나중에 LVM 하려면 device-mapper)
- 유저랜드: `e2fsprogs`(mkfs.ext4), `util-linux`(mount/lsblk/findmnt/fdisk 제대로 된 버전)
- **GNU 도구**: `coreutils grep sed gawk findutils`
  busybox 버전은 `grep -P`, `sort -h`, `find -printf`, gawk가 없다.
  여기서 배운 옵션이 실제 우분투에서 안 먹으면 학습 서비스로서 신뢰를 잃으므로 타협하지 않는다
- 시리얼 콘솔로 셸이 뜰 것 (`console=ttyS0`)

후보는 Alpine x86 + `apk add`. 만든 뒤 스냅샷(`save_state`) 크기를 재서
모바일 데이터 사용량이 감당되는지 확인해야 한다.

</details>

## 부수적으로 알게 된 것

- **npm 패키지 `v86`에는 BIOS가 없다.** `bios`/`vga_bios`를 안 주면 아무것도 부팅되지 않고
  시리얼 출력이 완전히 비어서 원인 파악이 어렵다.
  [레포 `bios/` 폴더](https://github.com/copy/v86/tree/master/bios)에서 `seabios.bin`(128K),
  `vgabios.bin`(36K)을 따로 받아야 한다
- 엔진 크기: `v86.wasm` 2.0MB + `libv86.js` 356KB. 여기에 이미지 크기가 더해진다
- 부팅 시간: `linux4.iso`(7.4MB) 기준 셸 프롬프트까지 **2.2초**. 스냅샷을 쓰면 더 줄어든다
- `boot_order: 0x123` 으로 cdrom → hda 순서 지정

## 재현 방법

```sh
cd spike
npm install
# 이미지 받기
curl --compressed -O --output-dir images https://i.copy.sh/linux4.iso
curl -o images/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
curl -o images/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
dd if=/dev/zero of=images/blank64.img bs=1m count=64
# FAT16 포맷 디스크 (macOS)
dd if=/dev/zero of=images/fat16.img bs=1m count=32
DEV=$(hdiutil attach -nomount -imagekey diskimage-class=CRawDiskImage images/fat16.img | head -1 | awk '{print $1}')
newfs_msdos -F 16 -v DATA "$DEV" && hdiutil detach "$DEV"

node spike.mjs        # 블록 디바이스 + fdisk
node spike-mount.mjs  # mount 전 과정
```
