// 파일트리 패널.
//
// 초보가 리눅스에서 제일 헤매는 건 명령어 문법이 아니라
// "내가 방금 뭘 바꿨는지 안 보인다"는 점이다. mv 를 친 뒤 파일이 실제로
// 옮겨지는 걸 눈으로 보면 학습 속도가 달라진다.
//
// 게스트를 직접 뒤지지 않고 채점 채널로 find 를 한 번 돌려 목록을 받아온다.
// 채점과 같은 채널이라 사용자 화면에는 아무것도 안 보인다.

const MAX_ENTRIES = 200;
const MAX_DEPTH = 3;

// 한 번의 왕복으로 트리 전체를 받는다.
// GNU findutils 가 깔려 있어서 -printf 를 쓸 수 있다 (busybox find 로는 안 된다).
export async function snapshot(vm, root = "/work") {
    // 깊이(%d)를 먼저 정렬 기준으로 쓴다.
    //
    // 경로순으로 정렬한 뒤 앞에서 200개를 자르면, / 에서는 /bin 아래 파일들이
    // 알파벳 앞이라 정원을 다 먹고 /etc·/home·/work 가 통째로 잘려나갔다.
    // "루트로 갔는데 아무것도 안 보인다"가 그것이었다.
    // 얕은 것부터 남기면 어디에 있든 그 디렉터리의 바로 아래가 먼저 보인다.
    const r = await vm.run(
        `find '${root}' -maxdepth ${MAX_DEPTH} -printf '%y|%m|%s|%T@|%d|%p\\n' 2>/dev/null ` +
        `| sort -t'|' -k5,5n -k6,6 | head -${MAX_ENTRIES + 1}`, 15000);
    if (r.exit !== 0) return new Map();

    const lines = r.out.split("\n").filter((l) => l.trim());
    const out = new Map();
    // 잘렸으면 잘렸다고 알린다. 조용히 자르면 "이게 전부"로 읽힌다.
    out.truncated = lines.length > MAX_ENTRIES;
    for (const line of lines.slice(0, MAX_ENTRIES)) {
        const [type, mode, size, mtime, , ...rest] = line.split("|");
        const path = rest.join("|");
        if (!path || !type) continue;
        out.set(path, { type, mode, size: Number(size), mtime, path });
    }
    return out;
}

// 이전 스냅샷과 비교해 무엇이 달라졌는지 표시를 붙인다.
export function diff(prev, next) {
    const marks = new Map();
    for (const [path, e] of next) {
        const before = prev?.get(path);
        if (!before) marks.set(path, "added");
        else if (before.mtime !== e.mtime || before.size !== e.size) marks.set(path, "changed");
        else if (before.mode !== e.mode) marks.set(path, "changed");
    }
    const removed = [];
    for (const path of prev?.keys() ?? []) if (!next.has(path)) removed.push(path);
    return { marks, removed };
}

// 경로 목록을 중첩 구조로 접어서 그린다.
export function render(el, entries, { root = "/work", marks = new Map(), removed = [] } = {}) {
    el.innerHTML = "";

    const rootLi = document.createElement("div");
    rootLi.className = "t-root";
    rootLi.textContent = root;
    el.appendChild(rootLi);

    // 루트가 "/" 면 뒤에 붙는 구분자가 없다. 그대로 +1 하면 첫 글자가 잘린다.
    const rel = (p) => (root === "/" ? p.slice(1) : p.slice(root.length + 1));
    const list = [...entries.values()]
        .filter((e) => e.path !== root)
        .sort((a, b) => {
            // 디렉터리를 먼저, 그 다음 이름순. 경로 전체로 정렬해야 계층이 유지된다
            const ap = rel(a.path).split("/"), bp = rel(b.path).split("/");
            for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
                if (ap[i] === bp[i]) continue;
                if (ap[i] === undefined) return -1;
                if (bp[i] === undefined) return 1;
                const aDir = i < ap.length - 1, bDir = i < bp.length - 1;
                if (aDir !== bDir) return aDir ? -1 : 1;
                return ap[i].localeCompare(bp[i]);
            }
            return 0;
        });

    if (!list.length && !removed.length) {
        const empty = document.createElement("div");
        empty.className = "t-empty";
        empty.textContent = "(비어 있음)";
        el.appendChild(empty);
        return;
    }

    for (const e of list) {
        const parts = rel(e.path).split("/");
        const row = document.createElement("div");
        row.className = `t-row ${marks.get(e.path) ?? ""}`;
        row.style.paddingLeft = `${parts.length * 12}px`;

        const name = parts[parts.length - 1] + (e.type === "d" ? "/" : "");
        const meta = e.type === "d" ? e.mode : `${e.mode} ${fmtSize(e.size)}`;
        row.innerHTML = `<span class="t-name"></span><span class="t-meta"></span>`;
        row.firstChild.textContent = name;
        row.lastChild.textContent = meta;
        el.appendChild(row);
    }

    for (const path of removed) {
        const row = document.createElement("div");
        row.className = "t-row removed";
        row.style.paddingLeft = `${rel(path).split("/").length * 12}px`;
        row.innerHTML = `<span class="t-name"></span><span class="t-meta">삭제됨</span>`;
        row.firstChild.textContent = rel(path).split("/").pop();
        el.appendChild(row);
    }

    // 잘렸으면 잘렸다고 말한다. /usr 같은 데서는 이게 늘 걸린다.
    if (entries.truncated) {
        const more = document.createElement("div");
        more.className = "t-empty";
        more.textContent = `… 여기까지만 (${MAX_ENTRIES}개)`;
        el.appendChild(more);
    }
}

function fmtSize(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
    return `${(n / 1024 / 1024).toFixed(1)}M`;
}

// 디스크 문제에서는 블록 디바이스 상태가 곧 진척도다
export async function diskSummary(vm) {
    const r = await vm.run(
        "lsblk -no NAME,SIZE,FSTYPE,MOUNTPOINT /dev/sdb 2>/dev/null | sed 's/^/ /'", 15000);
    return r.exit === 0 ? r.out : "";
}
