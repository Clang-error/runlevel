// 진단: v86 fetch 백엔드로 게스트에서 HTTP가 나가는가.
// NIC 타입, DHCP, DNS 세 단계를 나눠서 확인한다.
import { boot, img, report } from "./harness.mjs";

const type = process.argv[2] ?? "ne2k";
console.log(`NIC type=${type} 으로 부팅`);

const { run } = await boot({
    memory_size: 512 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-lts"),
    cdrom: img("images/alpine-standard-3.23.5-x86.iso"),
    cmdline: "console=ttyS0 modules=loop,squashfs,sd-mod,usb-storage",
    net_device: { type, relay_url: "fetch" },
}, { logPath: `serial-net-${type}.log`, login: "root", bootTimeout: 300000 });

report("PCI 네트워크 장치", await run("lspci 2>/dev/null | grep -i -E 'ethernet|network' || grep -i -E '' /sys/bus/pci/devices/*/class 2>/dev/null | head -6"));
report("네트워크 인터페이스", await run("ip link show | grep -E '^[0-9]+:'"));
report("드라이버 로드 시도", await run("modprobe ne2k-pci 2>&1; modprobe virtio_net 2>&1; modprobe 8139cp 2>&1; ip link show | grep -E '^[0-9]+:'"));
report("dmesg 네트워크", await run("dmesg | grep -i -E 'ne2k|virtio_net|eth0' | head -6"));
report("eth0 up + DHCP", await run("ip link set eth0 up && udhcpc -i eth0 -n -q 2>&1 | tail -4", 90000));
report("IP 주소", await run("ip -4 addr show eth0 | grep inet; cat /etc/resolv.conf"));
report("DNS 조회", await run("nslookup dl-cdn.alpinelinux.org 2>&1 | tail -5", 60000));
report("hosts 우회 후 HTTP", await run(
    "echo '1.1.1.1 dl-cdn.alpinelinux.org' >> /etc/hosts && " +
    "wget -q -O- http://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86/APKINDEX.tar.gz 2>&1 | wc -c", 120000));
process.exit(0);
