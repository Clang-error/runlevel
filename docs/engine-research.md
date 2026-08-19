# 실행 엔진 조사 (2026-08)

브라우저에서 리눅스 명령을 실행하고, JS가 그 결과 상태를 읽어 채점할 수 있는가.

## 결론

**v86 하나로 T1 + T2까지 커버하고, T3만 나중에 서버로 넘긴다.**

가장 중요한 판별 기준은 하나였다 — **진짜 리눅스 커널이 게스트 안에서 도는가.**

- 진짜 커널: v86, qemu-wasm, container2wasm, 서버 VM → mount/mkfs/LVM/iptables 원리적으로 가능
- syscall 에뮬레이션(커널 없음): CheerpX/WebVM, WebContainers, WASI/WASIX
  → **T2/T3는 구조적으로 불가능. 기다려도 안 된다.**

## 왜 v86인가

| 항목 | 내용 |
|---|---|
| 라이선스 | BSD-2-Clause. 상용/공개 호스팅 자유 |
| **COOP/COEP** | **불필요.** SharedArrayBuffer를 안 쓴다 → GitHub Pages 같은 헤더 설정 불가한 호스팅에도 그냥 올라간다. **다른 후보 대비 가장 큰 실무적 장점** |
| 셸 | 게스트가 진짜 리눅스라 bash/ash 그대로. 파이프·리다이렉션·글로빙·`&&`·`$( )` 100% 동작. 파서 직접 짤 필요 없음 |
| 명령어 수 | Buildroot busybox 300~400개. Alpine + apk로 추가 가능 |
| 이미지 크기 | Buildroot 4.9MB / Arch 15MB+ |
| **블록 디바이스** | `hda`, `hdb`, `cdrom` 옵션 존재 → 보조 디스크 부착 가능 → `lsblk`/`fdisk`/`mkfs`/`mount`/`fstab` 진짜로 동작 |
| **스냅샷** | `save_state()` / `restore_state()` / 생성자 `initial_state`. "망가진 상태"를 미리 만들어 정적 파일로 서빙 → **부팅 없이 즉시 복원**, 재시도도 즉시 |
| 멀티호스트 | `inbrowser` 네트워크 백엔드 = BroadcastChannel로 같은 브라우저 안 여러 VM끼리 이더넷 통신. 서버 없이 `ssh host2` 시나리오가 가능하다 |
| 유지보수 | 활발. 23k stars, 5000+ 커밋 |

### JS ↔ 파일시스템 (채점 훅)

1. **9p (virtio-9p)** — `emulator.read_file(path)` / `emulator.create_file(path, data)`
   - 게스트에서 `mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/9p/`
   - ⚠️ `handle9p` 콜백이나 `proxy_url` 방식을 쓰면 **`read_file`/`create_file`이 동작하지 않는다.**
     반드시 기본 in-memory 9p를 쓸 것
2. **시리얼 콘솔** — `emulator.serial0_send("...")` + `add_listener("serial0-output-byte", cb)`
   - **T2 채점은 사실상 이 방식이 정답.** `lsblk`, `findmnt`, `mountpoint` 결과를 문자열로 회수

### v86의 단점

- **32비트 전용.** "64-bit kernels are not supported". Debian 13에서 i386 부팅 지원이 사라졌고
  Ubuntu는 18.04가 마지막 i386. → **최신 systemd/SELinux/firewalld 실습은 시간이 갈수록 불가능해진다.**
  T3를 어차피 서버로 미루므로 당장은 타격이 없지만, T3 클라이언트화의 길은 닫혀 있다고 봐야 한다
- 느리다. FPU가 softfloat, JIT 모듈 생성 수 제한 있음
- 커스텀 커널/이미지를 직접 빌드해야 한다. **기성품이 없다**
- 모바일: 로드는 되지만 Buildroot 4.9MB급 T1 실습까지만 현실적
- `virtio_blk.js`가 없어 디스크는 IDE만. `/dev/vda` 시나리오는 못 만든다

## 탈락한 후보들

| 후보 | 탈락 사유 |
|---|---|
| **CheerpX / WebVM** | 진짜 커널이 없는 syscall 에뮬레이터 → mount/systemctl/iptables 구조적 불가. 게다가 **셀프호스팅 금지**(그들의 CDN 고정), COOP/COEP 필수. T1 전용이면 성능은 최상 |
| **WASI (uutils / browser_wasi_shim)** | 블록 디바이스라는 개념 자체가 없음. `/dev/sda`가 없고 커널이 없다. 그리고 **진짜 셸이 없어 파이프·글로빙·`&&`·`$( )` 파서를 직접 짜야 한다** — 실제 bash와 미묘하게 다르면 학습 서비스로서 신뢰를 잃는다. T1 한정으로는 가장 가볍고 채점이 가장 깔끔 |
| **Wasmer WASIX** | 진짜 bash는 되지만 COOP/COEP 필수, 릴리스 13개월 공백, 단일 벤더 종속. T2/T3 불가 |
| **WebContainers** | 사실상 Node 전용. 셸이 커스텀 `jsh`라 명령어 셋이 왜곡됨(`sleep` 없음 등) → **학습용으로 오답 유발**. 상용 라이선스 필요 + 월 500세션 제한 |
| **JSLinux** | 오픈소스가 아님. 미러링/재배포에 Bellard 허가 필요 → 사용 불가. 기반인 TinyEMU는 MIT |
| **container2wasm** | 진짜 커널은 있으나 Bochs 기반이라 v86보다도 느림. 다중 블록디바이스가 자연스럽지 않음 |
| **qemu-wasm** | 브라우저에서 64비트 게스트가 되는 유일한 경로(v86의 최대 약점을 해결)지만 **experimental**, 미업스트림, 2.3GB 메모리, 모바일 불가. **6~12개월 뒤 재평가할 것** |

## T3를 서버로 미루는 근거

기존 서비스들이 실제로 하는 방식:

| 서비스 | 실행 방식 |
|---|---|
| **SadServers** (우리와 가장 유사) | 세션마다 AWS EC2 온디맨드 생성, 15~45분 후 파기. 시나리오별 사전 빌드 AMI. 터미널은 Gotty, 채점은 **VM 안의 Go 에이전트가 REST로 노출** |
| Killercoda | KubeVirt 기반 VM. "신뢰할 수 없는 사용자를 다루려면 VM이 필요"라고 명시 |
| cmdchallenge | Go 백엔드 + Docker 컨테이너. 챌린지는 `challenges.yml`에 기대 출력 + 검증 스크립트 |
| OverTheWire | 그냥 SSH로 실서버 |

**T3를 하는 서비스는 예외 없이 전부 서버 사이드 VM이다.** 클라이언트 사이드로
T3를 하는 상용 서비스는 아직 없다.

그리고 컨테이너로는 안 된다:

| 작업 | 필요 권한 | 위험 |
|---|---|---|
| `mount`, `losetup` | `CAP_SYS_ADMIN` | 사실상 호스트 루트와 동급 |
| LVM/mdadm | `CAP_SYS_ADMIN` + device-mapper | 호스트 dm 네임스페이스 오염 |
| `iptables` | `CAP_NET_ADMIN` | 커널 netfilter 취약점 노출 |
| systemd PID 1 | cgroup 위임 | 컨테이너 탈출 표면 확대 |

**`--privileged` Docker를 공개 멀티테넌트로 돌리는 건 호스트 루트를 나눠주는 것이다.**
gVisor도 대안이 못 된다(iptables 부분 지원, 중첩 마운트에 결국 `CAP_SYS_ADMIN` 필요).
→ T3는 Firecracker 같은 microVM이 강제된다. 콜드 부팅 ≤125ms, 스냅샷 복원 수 ms로
성능은 훌륭하지만 **KVM 가능한 베어메탈이 필요**해서 "서버비 0원" 전제가 깨진다.

## 시작 전 반드시 검증할 스파이크

여기서 계획이 깨질 수 있다. 다른 작업보다 먼저 할 것.

1. **v86 + 커스텀 커널에서 `fdisk` → `mkfs.ext4` → `mount` 전 과정이 실제로 도는가.**
   기성 이미지가 없어 직접 확인해야 하며, 조사 과정에서 **공개된 성공 사례를 찾지 못했다.**
2. 스냅샷(`.bin.zst`) 실제 크기. RAM 전체를 담으므로 512MB VM이면 압축 후에도 수십 MB가
   될 수 있고, 그러면 모바일 데이터 사용량 문제가 된다.
3. `restore_state`는 **원본과 동일한 생성자 옵션**으로 만든 인스턴스에만 복원 가능하고,
   9p 상태 복원 후에는 **재마운트가 필요하다.**

## 참고 링크

- [copy/v86](https://github.com/copy/v86) · [filesystem.md](https://github.com/copy/v86/blob/master/docs/filesystem.md) · [networking.md](https://raw.githubusercontent.com/copy/v86/master/docs/networking.md) · [starter.js (API 원본)](https://raw.githubusercontent.com/copy/v86/master/src/browser/starter.js)
- [copy.sh/v86](https://copy.sh/v86/) — 이미지 크기 목록
- [progrium/env86](https://github.com/progrium/env86) — Docker 이미지 → v86 이미지 변환. MIT. 단 1인 프로젝트(66 stars)라 의존은 위험
- [SadServers repo](https://github.com/SadServers/sadservers) · [설계글](https://medium.com/@duran.fernando/sadservers-automating-linux-troubleshooting-testing-3effc5a14d42)
- [jarv/cmdchallenge](https://github.com/jarv/cmdchallenge)
- [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm) — 나중에 재평가
- [CheerpX Licensing](https://cheerpx.io/licensing) · [WebVM 원 발표(syscall emulator 명시)](https://labs.leaningtech.com/blog/webvm-server-less-x86-virtual-machines-in-the-browser)
- [gVisor Compatibility](https://gvisor.dev/docs/user_guide/compatibility/)
