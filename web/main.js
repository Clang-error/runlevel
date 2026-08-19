// runlevel — 브라우저에서 진짜 리눅스를 돌려 명령어를 연습한다.
//
// 부팅 중 화면은 모드에 따라 다르다.
//   기본        — 대기 화면만 두고, 준비되면 터미널로 전환한다.
//   ?selftest=1 — v86 의 VGA 화면을 띄워 BIOS 부터 커널 로그까지 보여준 뒤 자체 검증을 돌린다.
//
// 채점은 ttyS1(별도 채널)에서 돌아가므로 사용자 화면에 절대 나타나지 않는다.
// 자세한 구조는 vm.js 참고.

import { createVM } from "./vm.js";
import { loadIndex, applySetup, applyPlayground, grade, isSolved, brokeGuard } from "./problems.js";
import { createProgress } from "./progress.js";
import { snapshot, diff, render, diskSummary } from "./tree.js";
import * as settings from "./settings.js";
import { COMMANDS, CATEGORIES, UNAVAILABLE, PLAYGROUND, EMPTY_WORK } from "./commands.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 부팅이 끝났나. 홈은 이걸 보고 "준비 중" 과 "고르세요" 를 가른다.
// 여기 위에 둬야 한다 — createVM 을 기다리는 동안 setStatus 가 먼저 불린다.
let bootDone = false;
// 준비되기 전에 눌러둔 것. 문제·명령어·자유 터미널 세 가지가 들어오므로
// 무엇인지 따지지 않고 "이름 + 실행할 것" 으로만 들고 있는다.
let queued = null;
// 준비가 끝나기 전에는 홈에도 같은 말을 띄운다. 홈을 보는 동안 스냅샷을 받고 있어서,
// 아무 표시가 없으면 눌러도 안 열리는 이유를 알 수 없다.
// 준비가 끝난 뒤의 문구("file-01 — 2/4")는 문제 창에만 둔다.
const setStatus = (s) => {
    $("status").textContent = s;
    if (!bootDone) $("homeStatus").textContent = queued ? `${s} · 끝나면 ${queued.label} 시작` : s;
};
const setBar = (w) => {
    $("bar").style.width = w;
    $("homeBar").style.width = w;
};
// 새로고침 전에 보던 자리. 여기서 미리 읽어야 홈을 띄울지 말지를 정할 수 있다.
//
// sessionStorage 를 쓴다. 탭을 닫으면 같이 사라지므로 "예전에 여기 있었다" 가
// 다음에 들어올 때까지 따라다니지 않는다 — 그건 홈의 "이어서" 가 할 일이다.
const VIEW_KEY = "runlevel.resumeView";
const resumeView = (() => {
    try {
        const raw = sessionStorage.getItem(VIEW_KEY);
        sessionStorage.removeItem(VIEW_KEY);      // 한 번만 쓴다
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
})();

const SELFTEST = new URLSearchParams(location.search).has("selftest");
// 부팅 시간만 재고 끝내는 모드. 브라우저별 성능 비교에 쓴다.
const BENCH = new URLSearchParams(location.search).has("bench");

if (SELFTEST) { $("screen").hidden = false; $("waiting").hidden = true; }
// 홈부터 띄운다. 문제 목록은 아직 비어 있지만 머리말과 진행률은 바로 보여줄 수 있고,
// 그동안 뒤에서 스냅샷을 받는다. 자체 검증과 부팅 측정은 터미널로 바로 간다.
// 되살리러 온 것이면 홈을 건너뛴다. 안 그러면 부팅 2초 동안 홈이 보였다가
// 문제로 튀어서, 화면을 옮길 생각이 없던 사람에게 깜빡임으로만 남는다.
if (!SELFTEST && !BENCH && !resumeView) $("home").hidden = false;

// 자체 검증은 모든 문제를 풀어버리므로 진도를 기록하지 않는다
const progress = createProgress({ enabled: !SELFTEST });

// 화면 취향은 진도와 성격이 달라 따로 둔다. 저장에 실패해도 그냥 넘어간다.
// 기본값은 접힌 상태다 — 처음 들어오면 터미널이 넓은 편이 낫고,
// 파일트리는 필요할 때 펴는 쪽이 방해가 적다.
const mkPref = (key, dflt) => ({
    get: () => {
        try { const v = localStorage.getItem(key); return v === null ? dflt : v === "on"; }
        catch { return dflt; }
    },
    set: (v) => { try { localStorage.setItem(key, v ? "on" : "off"); } catch { /* 무시 */ } },
});
const pref = mkPref("dotslash.pref.files", false);      // 파일 패널
const sidePref = mkPref("dotslash.pref.side", true);    // 문제 창
const cmdsPref = mkPref("dotslash.pref.cmds", false);   // 명령어 사전 패널

// 저장된 설정을 터미널이 만들어지기 전에 읽어 화면 테마부터 반영한다
let cfg = settings.load();
settings.apply(cfg);

const term = new Terminal({
    fontSize: cfg.fontSize,
    convertEol: true,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

// Cmd 조합은 xterm 이 손대기 전에 브라우저에 돌려준다.
//
// 한글 입력 상태에서만 Cmd+T · Cmd+W 가 안 먹는다는 신고가 있었다.
// xterm 의 조합 처리(CompositionHelper.keydown)는 Shift·Ctrl·Alt(16·17·18)만
// 예외로 빼주고 Meta 는 그 목록에 없다. 그래서 조합 중에 Cmd 조합이 들어오면
// 그 키로 composition 을 정리하면서 이벤트를 자기가 삼킨다.
// 영어일 때는 _isComposing 이 false 라 이 분기를 안 타서 멀쩡했다.
//
// false 를 돌려주면 _keyDown 이 맨 앞에서 그대로 빠져나가 브라우저가 처리한다.
// Ctrl 은 넘기지 않는다 — Ctrl-C·Ctrl-D·Ctrl-W 는 셸에 가야 하는 키다.
term.attachCustomKeyEventHandler((e) => !e.metaKey);

let attached = false;
const vm = await createVM({
    screenContainer: $("screen"),
    onUserOutput: (bytes) => attached && term.write(bytes),   // xterm 이 UTF-8 을 직접 해석한다
    // clear() 는 커서가 있는 줄을 남긴다 ("프롬프트 줄을 맨 위로" 동작).
    // 그래서 전환 전 프롬프트(/work #)가 살아남고 새 프롬프트(/work $)가 아래에 찍혀
    // 프롬프트가 두 줄이 된다. reset() 은 현재 줄까지 지운다.
    onClear: () => attached && term.reset(),

    // 디스크 이미지(가장 큰 파일)를 직접 받는 동안의 진행률.
    // 개발 서버는 gzip 을 스트리밍해서 content-length 가 없다.
    // 총량을 모른다고 아무것도 안 보여주면 멈춘 것처럼 보이므로,
    // 그럴 때는 받은 용량만이라도 계속 보여준다.
    onDiskProgress: (got, total) => {
        if (attached) return;
        const mb = (n) => (n / 1024 / 1024).toFixed(1);
        if (total) {
            const pct = Math.round((got / total) * 100);
            setStatus(`시스템 이미지 받는 중 · ${pct}%`);
            setBar(`${pct * 0.8}%`);          // 나머지 20% 는 부팅 몫
        } else {
            setStatus(`시스템 이미지 받는 중 · ${mb(got)}MB`);
        }
    },

    // 커널·initramfs 등 v86 이 직접 받는 파일들
    onProgress: (e) => {
        if (attached || !e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        setStatus(`부팅 파일 받는 중 ${e.file_index + 1}/${e.file_count} · ${pct}%`);
    },
});

// ---------- 문제 상태 ----------
let problems = [];
let current = null;
let hintsShown = 0;
let grading = false;
let solved = false;
let treeSnap = null;      // 직전 파일 상태. 무엇이 바뀌었는지 비교하는 기준
let treeRoot = null;      // 그 스냅샷을 찍은 디렉터리
let typed = [];           // 이번 문제에서 친 명령들. 풀면 진도에 저장된다
// 문제를 연 시각이 아니라 "첫 명령을 친 시각"이다.
// 여는 순간부터 재면 setup 이 도는 몇 초와 문제를 읽는 시간, 그리고 탭을 열어둔 채
// 자리를 뜬 시간이 전부 들어간다. 그렇게 나온 평균은 난이도가 아니라 딴짓의 길이다.
// (실제로 어떤 문제는 19분으로 잡혔다.) 손을 대기 시작한 시점부터 잰다.
let startedAt = 0;
let sawSolution = false;  // 정답을 봤나 — 사용자가 스스로 드러낸 포기 신호
let lastGrade = null;     // 마지막 채점 결과. 떠날 때 어디까지 갔는지 남기려고 들고 있는다
let reported = false;     // 이번 방문의 결말을 이미 보냈나 (한 방문에 한 건)
let selectGen = 0;        // 문제 전환 세대. 낡은 전환이 화면을 되돌리는 걸 막는다

// 터미널 화면은 세 가지로 쓴다. 껍데기(왼쪽 패널 + 터미널 + 위쪽 이동 버튼)는 같고
// 왼쪽에 무엇이 들어가는지와 채점 여부만 다르다.
//   problem — 문제. 목표가 있고 명령마다 채점한다
//   command — 사전. 설명만 있고 채점하지 않는다. 같은 분류 안에서 ‹ › 로 넘긴다
//   free    — 아무것도 없이 셸만
let mode = "problem";
let currentCmd = null;    // command 모드에서 보고 있는 명령어

// 문제를 떠날 때 결말을 하나 남긴다. 어느 문제에서 사람들이 막히는지 알아내
// 문제를 고치는 데 쓴다. 신원은 아무것도 담지 않는다 (api/schema.sql 참고).
//
// 통과한 것만 보내면 성공률의 분모가 없다. 그래서 못 풀고 떠난 것도 보낸다.
// 다만 화면에는 아무것도 안 띄운다 — "틀렸다"고 알리면 정답 보기를 피하게 되고,
// 그러면 막혔다는 신호 자체가 사라진다.
//
// 보낼 내용을 만드는 것과 실제로 보내는 것을 나눠둔다. 자체 검증이 payload 모양만
// 따로 검사할 수 있어야 한다 — 서버가 거절해도 사용자 화면에는 표시가 안 나기 때문이다.
function statsPayload(p, outcome) {
    return {
        problem_id: p.id,
        outcome,
        commands: typed,
        // 아무것도 안 친 방문은 0 이다. 시간이 아니라 "안 했다"는 뜻이라 평균에서 빠져야 한다
        elapsed_ms: startedAt ? Date.now() - startedAt : 0,
        hints_used: hintsShown,
        saw_solution: sawSolution,
        // 3개 중 2개까지 간 실패와 0개인 실패는 의미가 정반대다
        goals_passed: lastGrade?.goals.filter((r) => r.ok).length ?? 0,
        goals_total: lastGrade?.goals.length ?? (p.check?.length ?? 0),
    };
}

function sendStats(p, outcome) {
    if (!p || reported || !cfg.sendStats || SELFTEST) return;
    // 열자마자 지나간 것은 기록하지 않는다. 목록을 훑는 동안 51건이 쌓인다.
    if (outcome !== "solved" && !typed.length) return;
    reported = true;

    const body = JSON.stringify(statsPayload(p, outcome));
    // 탭을 닫는 순간에는 fetch 가 취소될 수 있다. sendBeacon 은 그 상황을 위해 있다.
    if (outcome === "closed" && navigator.sendBeacon) {
        navigator.sendBeacon("/api/attempt", new Blob([body], { type: "application/json" }));
        return;
    }
    fetch("/api/attempt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
    })
        // 실패해도 사용자의 연습은 그대로 이어져야 한다. 다만 조용히 삼키지는 않는다 —
        // 예전에 pages.dev 주소로 들어온 사람들의 기록이 405 로 전부 버려졌는데
        // 아무 흔적이 없어서 한참 뒤에야 알았다. 콘솔에는 반드시 남긴다.
        .then((r) => { if (!r.ok) console.warn(`기록 전송 실패: HTTP ${r.status} (${location.host})`); })
        .catch((e) => console.warn("기록 전송 실패:", e.message));
}

// 탭을 닫을 때. unload 는 요즘 브라우저에서 안 불리는 경우가 있어 pagehide 를 쓴다.
//
// visibilitychange 도 같이 걸었었는데, 그게 기록을 망가뜨렸다.
// 다른 탭으로 넘어간 것은 결말이 아니다 — 문법을 찾아보러 잠깐 옮기는 일이 흔하다.
// 그 순간 "이탈" 이 한 건 올라가고 reported 플래그까지 서 버려서,
// 돌아와 문제를 풀어도 성공이 영영 안 올라갔다.
// (grep-04 가 실제로 그랬다. 통과했는데 남은 건 0/4 이탈 하나에 명령 2줄뿐이었다.)
//
// 대신 백그라운드에서 탭이 버려지면 마지막 문제의 결말은 못 받는다.
// 성공은 푸는 즉시 보내므로 잃지 않는다. 잃는 건 "마지막 문제를 못 풀고 떠났다"
// 하나뿐이고, 그건 애초에 "아직 붙잡고 있다" 와 구분되지도 않는다.
addEventListener("pagehide", () => { if (!solved) sendStats(current, "closed"); });

// --- 다른 사람들의 결과 ---
//
// 개별 기록이 아니라 문제별 집계만 받는다. 표본이 적은 문제는 서버가 아예 안 준다 —
// 1명이 실패하면 0% 가 되는 숫자는 정보가 아니라 소음이다.
let peerStats = {};
async function loadPeerStats() {
    try {
        const r = await fetch("/api/stats");
        if (r.ok) peerStats = await r.json();
    } catch {
        // 수집 서버가 없는 환경(로컬 개발, 미리보기 배포)에서는 그냥 안 보여준다
    }
}

function renderPeerStat(id) {
    const s = peerStats[id];
    $("pstat").textContent = s
        ? `${s.tries}명이 도전 · ${Math.round((s.solved / s.tries) * 100)}% 성공`
        : "아직 통계가 쌓이지 않은 문제입니다";
}

// 엔터를 치면 자동 채점이 예약된다. 그게 채점 채널을 쓰는 동안 다른 코드가
// 같은 채널로 명령을 보내면 두 출력이 섞여서 둘 다 못 쓰게 된다.
// 자체 검증이 사용자처럼 타이핑할 때 이걸 기다린다.
let pendingGrade = Promise.resolve();

// 프롬프트가 붙은 줄에서 명령어만 떼어낸다.
//
// 키 입력을 모으지 않고 터미널 버퍼를 읽는다. 방향키로 이전 명령을 불러오거나
// 탭 완성·백스페이스를 쓰면 눌린 키와 실제 명령이 달라지는데,
// 화면에 그려진 줄에는 편집이 끝난 최종 결과가 이미 들어 있다.
//
// 프롬프트 형식은 "/work # " (root) 와 "/work $ " (student) 두 가지다.
// 이 모양이 아니면 셸 앞이 아니라는 뜻이므로(vi 편집 중, 연속 입력 중) 기록하지 않는다.
function recordTyped() {
    const buf = term.buffer.active;
    const text = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
    const cmd = text.match(/^(?:~|\/\S*) [#$] (.+)$/)?.[1].trim();
    if (!cmd) return;
    if (!typed.length) startedAt = Date.now();   // 첫 명령이 시계의 출발점이다
    typed.push(cmd);
}

// 파일트리를 다시 그린다. 채점과 같은 채널을 쓰므로 화면에는 안 보인다.
// markChanges=false 면 강조 없이 현재 상태만 그린다 (문제를 막 열었을 때).
async function refreshTree({ markChanges = true } = {}) {
    // 문제가 열려 있을 때만 그리면 안 된다. 자유 터미널·사전 모드에서는
    // current 가 null 이라 여기서 바로 돌아갔고, 그래서 트리가 영영 안 채워졌다.
    // 트리가 비추는 건 "지금 셸이 있는 디렉터리"지 "지금 문제"가 아니다.
    if (!attached && !SELFTEST) return;
    // 사용자가 지금 있는 디렉터리를 비춘다.
    // cd 로 옮겨 다니는 것 자체가 연습인데 늘 /work 만 보여주면
    // 방금 무엇을 했는지가 트리에 안 나타난다.
    const root = (await vm.userCwd()) || current?.setup?.cwd || "/work";
    const next = await snapshot(vm, root);
    // 디렉터리가 바뀌었으면 비교할 기준이 없다. 전부 "새로 생긴 것"으로 칠하면 안 된다.
    const comparable = markChanges && treeSnap && treeRoot === root;
    const d = comparable ? diff(treeSnap, next) : { marks: new Map(), removed: [] };
    render($("tree"), next, { root, ...d });
    treeSnap = next;
    treeRoot = root;

    // 디스크 문제에서는 블록 디바이스 상태가 곧 진척도다
    if (current?.setup?.disks) {
        const txt = await diskSummary(vm);
        $("disk").hidden = !txt;
        $("disk").textContent = txt;
    } else {
        $("disk").hidden = true;
    }
}

// ---------- 홈 ----------
//
// 레벨을 고르는 곳이자 진도를 한눈에 보는 곳이다.
// 문제 창의 목록(<select>)은 51개를 한 줄씩 쌓아둔 것이라 뭐가 뭔지 안 보였다.
// 여기서는 레벨 -> 카테고리 -> 문제 세 단으로 나눠 놓고,
// 문제 창에는 같은 레벨 안에서 앞뒤로 가는 버튼만 남긴다.
const LEVEL_NAMES = { 1: "기본기", 2: "익숙해지기", 3: "응용", 4: "심화", 5: "도전" };

// 문제 요약. 따로 title 필드를 두지 않고 prompt 를 한 줄로 눌러 쓴다.
// 목록용 제목을 따로 쓰면 문제 본문과 어긋나기 시작한다.
const summary = (p) => (p.prompt ?? "").trim().replace(/\s+/g, " ");

const levelsOf = (list) => [...new Set(list.map((p) => p.level))].sort((a, b) => a - b);

// 검색어를 맞춰본다.
//
// 띄어쓰기는 지운다 — "파일조작" 으로 찾는 사람과 "파일 조작" 으로 찾는 사람이
// 같은 것을 원하는데, 분류 이름에는 공백이 있다.
// "쉘" 은 "셸" 로 바꾼다. 표기는 셸이 맞지만 치는 쪽은 쉘이 더 흔하다.
const norm = (s) => s.toLowerCase().replace(/\s+/g, "").replace(/쉘/g, "셸");
// id 에 번호가 들어 있어서 "01" 로도, "grep" 으로도 걸린다.
const probHaystack = (p) => norm(`${p.id} ${p.category} Lv${p.level} ${summary(p)}`);

let probQuery = "";

// 같은 레벨 안에서의 순서. 문제 창의 이전/다음이 이 순서를 따른다.
const inLevel = (lv) => problems.filter((p) => p.level === lv);

function renderHome() {
    const box = $("levels");
    box.innerHTML = "";
    const q = norm(probQuery);
    let shown = 0;

    // 레벨은 오름차순이다 (levelsOf 가 정렬한다). 문제도 loadIndex 에서
    // level -> id 로 정렬해 두었으므로 여기서 다시 정렬할 것이 없다.
    for (const lv of levelsOf(problems)) {
        const all = inLevel(lv);
        const mine = q ? all.filter((p) => probHaystack(p).includes(q)) : all;
        if (!mine.length) continue;
        shown += mine.length;
        const done = all.filter((p) => progress.isSolved(p.id)).length;

        const sec = document.createElement("section");
        sec.className = "lv";
        const head = document.createElement("div");
        head.className = "lv-head";
        // 검색 중에는 진도(8/15) 대신 몇 개가 걸렸는지를 보여준다.
        // 걸러낸 개수를 진도처럼 쓰면 "1/1 통과" 같은 거짓말이 된다.
        const count = q ? `${mine.length}개` : `${done}/${all.length}`;
        head.innerHTML = `<b>Lv.${lv}</b><span class="lv-name"></span>`
            + `<span class="lv-rule"></span><span class="lv-count">${count}</span>`;
        head.querySelector(".lv-name").textContent = LEVEL_NAMES[lv] ?? "";
        sec.appendChild(head);

        // 카테고리는 문제 순서를 그대로 따라간다. 먼저 나온 카테고리가 먼저 온다.
        const byCat = new Map();
        for (const p of mine) {
            if (!byCat.has(p.category)) byCat.set(p.category, []);
            byCat.get(p.category).push(p);
        }
        for (const [cat, list] of byCat) {
            const h = document.createElement("p");
            h.className = "cat";
            h.textContent = cat;
            sec.appendChild(h);
            for (const p of list) sec.appendChild(problemRow(p));
        }
        box.appendChild(sec);
    }
    $("probNone").hidden = shown > 0 || !problems.length;

    const done = problems.filter((p) => progress.isSolved(p.id)).length;
    $("homeScore").textContent = problems.length ? `${done}/${problems.length} 통과` : "";

    // 부팅이 끝나면 같은 막대가 진도를 가리킨다.
    // 그 전까지는 스냅샷 받는 진행률이라 건드리지 않는다 (setBar 가 쓴다).
    if (bootDone && problems.length) {
        $("homeBar").style.width = `${(done / problems.length) * 100}%`;
    }

    // 지난번에 보던 자리로 돌아가는 길. 예전에는 들어오자마자 그 문제가 열렸는데,
    // 홈이 생겼으니 열어주지 않고 길만 남긴다.
    // 한 번도 온 적 없으면 아무것도 안 띄운다 — 첫 방문에 "이어서" 는 거짓말이다.
    // 여닫는 것은 버튼 하나지 줄 전체가 아니다. 이 줄에는 "터미널만 열기" 도 같이 있어서,
    // 줄째로 숨기면 처음 온 사람은 자유 터미널로 들어갈 길이 아예 사라진다.
    // 예전에 줄을 토글하면서 버튼에 박힌 hidden 을 안 벗겨 "이어서" 가 영영 안 보였는데,
    // 그때 버튼의 hidden 을 지워버린 것이 두 번째 실수였다. 그러면 renderHome 이 돌기 전
    // (문제 목록을 못 받으면 계속) 글자 없는 빈 버튼이 남는다.
    // 마크업에서는 숨긴 채 두고, 보여줄지는 여기서만 정한다.
    const last = progress.last() ? progress.pick(problems) : null;
    $("homeResume").hidden = !last;
    if (last) {
        $("homeResume").textContent = `이어서: ${last.id}`;
        $("homeResume").onclick = () => openProblem(last);
    }
}

// ---------- 기본명령어 ----------
//
// man 페이지가 없어서, 막히면 볼 곳이 아예 없었다 (수집 기록에 `man grep` 을 치고
// 나간 흔적이 남아 있다). 그 자리를 메우는 탭이다.
//
// 여기 적힌 것이 실제로 되는지는 spike/lint-commands.mjs 가 게스트에서 눌러본다.
// 사전을 손으로 쓰면 인터넷 치트시트의 기억이 섞여 드는데, 이 게스트는
// GNU 와 busybox 가 섞여 있어서 (ps aux 안 됨) 그게 그대로 거짓말이 된다.

// 검색 대상. 이름만 훑으면 "정렬" 로 sort 를 못 찾는다.
const cmdHaystack = (c) =>
    [c.name, c.sum, c.cat, c.usage, c.note ?? "", ...c.opts.flat()].join(" ").toLowerCase();

function renderCommands(q = "") {
    const query = q.trim().toLowerCase();
    const hit = COMMANDS.filter((c) => !query || cmdHaystack(c).includes(query));

    const box = $("cmdList");
    const nav = $("cmdNav");
    box.innerHTML = "";
    nav.innerHTML = "";

    // 목차 항목 하나. 누르면 그 분류로 스크롤한다.
    // 아이디를 붙여 찾지 않고 만든 요소를 그대로 붙잡아 둔다 — 검색으로 다시 그릴 때마다
    // 아이디를 매기면 그게 또 하나의 관리 대상이 된다.
    const navItem = (label, count, target, cls = "") => {
        const b = document.createElement("button");
        b.className = `nav-item ${cls}`;
        b.innerHTML = `<span></span><span></span>`;
        b.children[0].textContent = label;
        b.children[1].textContent = count ?? "";
        b.onclick = () => target.scrollIntoView({ behavior: "smooth", block: "start" });
        nav.appendChild(b);
    };

    for (const cat of CATEGORIES) {
        const list = hit.filter((c) => c.cat === cat);
        if (!list.length) continue;

        // 레벨 목록과 같은 머리말을 쓴다. 두 탭이 한 물건으로 보여야 한다.
        const head = document.createElement("div");
        head.className = "lv-head";
        head.innerHTML = `<b></b><span class="lv-rule"></span><span class="lv-count">${list.length}</span>`;
        head.querySelector("b").textContent = cat;
        box.appendChild(head);
        for (const c of list) box.appendChild(commandCard(c));
        navItem(cat, list.length, head);
    }

    // 안 되는 것도 같이 걸러준다. "man" 을 검색한 사람이 닿아야 할 곳이 여기다.
    const un = UNAVAILABLE.filter(
        (u) => !query || `${u.name} ${u.why}`.toLowerCase().includes(query));
    const ubox = $("cmdUnavail");
    ubox.innerHTML = "";
    ubox.className = un.length ? "unavail" : "";
    if (un.length) {
        const head = document.createElement("div");
        head.className = "lv-head";
        head.innerHTML = `<b>이 환경에서 안 되는 것</b><span class="lv-rule"></span>`;
        ubox.appendChild(head);
        navItem("안 되는 것", un.length, head, "un");
        for (const u of un) {
            const d = document.createElement("div");
            d.className = "un-item";
            d.innerHTML = "<b></b><p></p>";
            d.children[0].textContent = u.name;
            d.children[1].textContent = u.why;
            ubox.appendChild(d);
        }
    }
    $("cmdNone").hidden = !!(hit.length || un.length);
}

function commandCard(c, inPanel = false) {
    const el = document.createElement("div");
    el.className = "cmd";

    const head = document.createElement("div");
    head.className = "cmd-head";
    head.innerHTML = `<span class="cmd-name"></span>`
        + (c.bb ? `<span class="cmd-bb">busybox 판 · 옵션이 적습니다</span>` : "");
    head.firstChild.textContent = c.name;
    // 홈 목록에서만 붙인다. 왼쪽 패널로 들어가면 이미 그 명령어를 보고 있는 중이다.
    if (!inPanel) {
        const try_ = document.createElement("button");
        try_.className = "cmd-try";
        try_.textContent = "터미널에서 쳐보기";
        try_.onclick = () => openCommand(c);
        head.appendChild(try_);
    }
    el.appendChild(head);

    const add = (cls, text, tag = "div") => {
        const d = document.createElement(tag);
        d.className = cls;
        d.textContent = text;
        el.appendChild(d);
        return d;
    };
    add("cmd-sum", c.sum);
    add("cmd-usage", c.usage);

    if (c.opts.length) {
        const dl = document.createElement("dl");
        dl.className = "cmd-opts";
        for (const [flag, desc] of c.opts) {
            const dt = document.createElement("dt");
            dt.textContent = flag;
            const dd = document.createElement("dd");
            dd.textContent = desc;
            dl.append(dt, dd);
        }
        el.appendChild(dl);
    }

    const ex = document.createElement("div");
    ex.className = "cmd-ex";
    for (const line of c.ex) {
        const row = document.createElement("div");
        row.innerHTML = `<span>$</span> `;
        row.append(line);
        ex.appendChild(row);
    }
    el.appendChild(ex);

    if (c.note) add("cmd-note", c.note, "p");
    return el;
}

// ---------- 사전·자유 터미널 모드 ----------
//
// 문제 화면을 그대로 재사용한다. 왼쪽 패널만 갈아끼우고 채점을 안 돌린다.
// 사전에서 명령을 읽고 나면 시험해볼 곳이 없었는데 (문제를 열면 그 문제의
// setup 이 깔리고 목표가 뜨고 채점이 돈다), 그 고리를 잇는 것이 목적이다.

const cmdsInCat = (cat) => COMMANDS.filter((c) => c.cat === cat);

// 왼쪽 패널을 무엇으로 채울지 한 곳에서 정한다.
// 세 군데에 흩어놓으면 모드를 하나 더 늘릴 때마다 어긋난다.
function applyMode(m) {
    mode = m;
    $("problem").hidden = m !== "problem";
    $("cmdView").hidden = m !== "command";
    $("freeView").hidden = m !== "free";
    $("pstat").hidden = m !== "problem";      // 남들 성공률은 문제에만 있는 값이다
}

// /work 에 예시가 기대는 파일을 깔아준다.
// 사전 예시를 그대로 복사해 쳐도 돌아가야 한다 — 린터가 검증하는 상태와 같은 것이다.
// 사전 모드는 예시가 기대는 파일을 깔아준다 (예시를 눌러 바로 해볼 수 있게).
// 자유 터미널은 빈 /work 로 둔다 — 아무것도 없는 데서 시작하고 싶은 사람을 위한 모드다.
async function seedPlayground(withFiles) {
    const r = await applyPlayground(vm, withFiles ? PLAYGROUND : EMPTY_WORK);
    if (r.exit !== 0 || r.timedOut) {
        // 문제 쪽과 같은 이유다. 여기서도 조용히 실패하면 빈 터미널만 남는다.
        if (await guestBroken()) { showBroken(true); setStatus("시스템이 망가졌습니다 — 다시 불러오세요"); return false; }
    }
    showBroken(false);
    return true;
}

async function openCommand(c) {
    if (!bootDone) { queued = { label: c.name, run: () => openCommand(c) }; setStatus($("status").textContent); return; }
    enterView();
    await selectCommand(c);
}

async function selectCommand(c) {
    if (current && !solved) sendStats(current, "left");
    current = null;
    currentCmd = c;
    solved = false;
    applyMode("command");

    $("cmdViewBody").innerHTML = "";
    const card = commandCard(c, true);
    // 예시를 누르면 터미널에 그대로 쳐진다. 읽고 나서 바로 해볼 수 있게.
    for (const row of card.querySelectorAll(".cmd-ex div")) {
        const line = row.lastChild.textContent;
        row.onclick = () => { vm.sendUser(`${line}\n`); focusTerm(); };
        row.title = "터미널에 쳐보기";
    }
    $("cmdViewBody").appendChild(card);
    renderPicker();
    setStatus("터미널 준비 중...");
    if (attached) $("busy").hidden = false;

    const gen = ++selectGen;
    await seedPlayground(true);
    if (gen !== selectGen) return;
    $("busy").hidden = true;
    setStatus(`${c.name} — 예시를 눌러보세요`);
    if (!SELFTEST) await refreshTree({ markChanges: false });
    focusTerm();
}

async function openFree() {
    if (!bootDone) { queued = { label: "자유 터미널", run: () => openFree() }; setStatus($("status").textContent); return; }
    enterView();
    if (current && !solved) sendStats(current, "left");
    current = null;
    currentCmd = null;
    solved = false;
    applyMode("free");
    renderPicker();
    setStatus("터미널 준비 중...");
    if (attached) $("busy").hidden = false;
    const gen = ++selectGen;
    await seedPlayground(false);
    if (gen !== selectGen) return;
    $("busy").hidden = true;
    setStatus("자유 터미널");
    if (!SELFTEST) await refreshTree({ markChanges: false });
    focusTerm();
}

$("homeFree").onclick = () => openFree();
$("freeReset").onclick = () => seedPlayground(false).then(() => refreshTree({ markChanges: false }));
$("freeFiles").onclick = () => setFilesVisible($("wrap").classList.contains("no-files"));

$("cmdSearch").oninput = (e) => renderCommands(e.target.value);
$("probSearch").oninput = (e) => { probQuery = e.target.value; renderHome(); };

const PANES = ["paneProblems", "paneCmds", "paneHow"];
function selectTab(pane) {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t.dataset.pane === pane);
    for (const p of PANES) $(p).hidden = p !== pane;
}
for (const tab of document.querySelectorAll(".tab")) {
    tab.onclick = () => selectTab(tab.dataset.pane);
}
// 사전은 문제 목록과 달리 받아올 것이 없다. 바로 그려둔다.
renderCommands();

function problemRow(p) {
    const b = document.createElement("button");
    b.className = progress.isSolved(p.id) ? "pr done" : "pr";
    b.innerHTML = `<span class="pr-mark"></span><span class="pr-id"></span><span class="pr-sum"></span>`;
    b.children[0].textContent = progress.isSolved(p.id) ? "✓" : "·";
    b.children[1].textContent = p.id;
    b.children[2].textContent = summary(p);
    b.onclick = () => openProblem(p);
    return b;
}

// 위치 표시와 이전/다음 버튼.
//
// 문제면 같은 레벨 안에서, 사전이면 같은 분류 안에서 움직인다.
// 두 모드가 같은 껍데기를 쓰므로 여기서 갈라준다.
function renderPicker() {
    let list = [], cur = null, label = "";
    if (mode === "command" && currentCmd) {
        list = cmdsInCat(currentCmd.cat);
        cur = currentCmd;
        label = currentCmd.cat;
    } else if (current) {
        list = inLevel(current.level);
        cur = current;
        label = `Lv.${current.level}`;
    }
    const i = list.indexOf(cur);
    $("pos").textContent = cur ? `${label} · ${i + 1}/${list.length}` : "자유 터미널";
    $("prevBtn").disabled = i <= 0;
    $("nextBtn").disabled = i < 0 || i >= list.length - 1;
}

// 진도가 바뀔 때마다 홈의 표식과 문제 창의 위치를 다시 그린다
function renderList() {
    renderHome();
    renderPicker();
}

function renderProblem(p) {
    $("problem").hidden = false;
    $("meta").textContent = `${p.category} · Lv.${p.level} · ${p.id}`;
    // 권한 상태를 문제마다 알려준다.
    //
    // 안 알려주면 sudo 가 되는지 안 되는지를 쳐봐야만 알 수 있고,
    // root 로 시작하는 문제에서는 whoami 결과가 뜬금없어 보인다.
    // YAML 에서 바로 뽑는다 — 문제 본문에 손으로 적으면 설정과 글이 언젠가 어긋난다.
    const priv = (p.setup?.user ?? "student") === "root" ? "관리자(root)로 시작"
        : p.setup?.sudo ? "sudo 사용 가능"
        : "";
    $("priv").textContent = priv;
    $("priv").hidden = !priv;
    $("prompt").textContent = (p.prompt ?? "").trim();
    $("given").hidden = !p.given;
    if (p.given) $("given").textContent = p.given.trimEnd();

    const fill = (el, list, mark) => {
        el.innerHTML = "";
        for (const c of list ?? []) {
            const li = document.createElement("li");
            li.className = "no";
            li.innerHTML = `<span class="mark">${mark}</span><span></span>`;
            li.lastChild.textContent = c.desc;
            el.appendChild(li);
        }
    };
    fill($("checks"), p.check, "·");
    fill($("guards"), p.guard, "✓");   // 유지 조건은 처음부터 성립한 상태다
    $("guardBox").hidden = !(p.guard?.length);
    $("hints").innerHTML = "";
    $("solved").classList.remove("show");
    $("already").hidden = !progress.isSolved(p.id);
    $("hintBtn").disabled = !(p.hints?.length);
    $("solutionBtn").disabled = !p.solution;
    syncHintButtons();
    renderLog(p.id);
    hintsShown = 0;
    solved = false;
}

// 전에 이 문제를 풀 때 쳤던 명령을 접어둔 채로 보여준다.
// 답을 보여주는 것과는 다르다 — 내가 실제로 한 삽질이 그대로 남아 있어서,
// 다시 풀 때 "저번엔 여기서 막혔지"가 보인다.
function renderLog(id) {
    const cmds = progress.log(id);
    $("logBox").hidden = !cmds?.length;
    $("logList").hidden = true;
    $("logBtn").textContent = `지난 풀이 보기 (${cmds?.length ?? 0}줄)`;
    if (!cmds?.length) return;
    $("logList").innerHTML = "";
    for (const c of cmds) {
        const li = document.createElement("li");
        li.textContent = c;
        $("logList").appendChild(li);
    }
}

function renderChecks(results) {
    const paint = (el, list, { okMark, failMark, failClass }) => {
        [...el.children].forEach((li, i) => {
            const r = list[i];
            if (!r) return;
            li.className = r.ok ? "ok" : r.timedOut ? "err" : failClass;
            li.firstChild.textContent = r.ok ? okMark : r.timedOut ? "!" : failMark;
        });
    };
    // 아직 못 이룬 목표는 "틀린 것"이 아니라 "남은 것"이다. 조용한 회색으로 둔다.
    paint($("checks"), results.goals, { okMark: "✓", failMark: "·", failClass: "no" });
    // 유지 조건은 반대다. 깨졌다는 건 뭔가 잘못 건드렸다는 뜻이라 눈에 띄어야 한다.
    paint($("guards"), results.guards, { okMark: "✓", failMark: "✗", failClass: "err" });
}

// 게스트를 되살릴 수 없는 상태인가.
//
// rm -rf / 를 하면 셸 자신은 살아남는다 (이미 열린 inode 라 파일이 지워져도 계속 돈다).
// 그래서 채점 채널은 멀쩡히 응답하는데 mkdir·touch 가 전부 사라져서
// setup 이 영영 실패한다. 초기화를 눌러도 같은 실패가 반복되므로,
// 사용자는 무엇이 잘못됐는지도 모른 채 갇힌다.
//
// 셸이 살아 있다고 게스트가 멀쩡한 게 아니라는 게 핵심이다.
//
// 찾아보기(command -v)로는 안 된다. 셸이 경로를 기억하고 있어서 파일이 지워져도
// 찾았다고 답하고, 애초에 채점 통로가 base64 를 잃으면 무엇을 물어도 0 이 돌아온다.
// 그래서 실제로 실행해보고, 통로 자체가 죽었는지(noRun)도 같이 본다.
async function guestBroken() {
    const r = await vm.run("mkdir -p /tmp/.hc && rmdir /tmp/.hc", 8000);
    return r.noRun || r.timedOut || r.exit !== 0;
}

// 게스트가 망가진 것을 "무언가 실패했을 때"만 알아채면 늦다.
//
// rm -rf /bin 처럼 절반만 부수면 채점 통로(base64 는 /usr/bin 에 있다)는 살아남아서
// 채점은 정직하게 0/3 을 말한다. 앱 입장에서는 아무 이상이 없고, 사용자는
// 명령이 왜 안 듣는지 모른 채 계속 친다. 초기화를 눌러야 그제서야 드러났다.
//
// 그래서 채점할 때마다 게스트 상태도 같이 확인한다. 다만 매번은 아니다 —
// 몇 초에 한 번으로 묶어서, 정상적으로 푸는 동안의 왕복 비용을 붙들어둔다.
let lastHealthAt = 0;
async function healthDue() {
    if (Date.now() - lastHealthAt < 8000) return false;
    lastHealthAt = Date.now();
    return guestBroken();
}

function showBroken(on) {
    $("broken").hidden = !on;
}

// 새로고침은 게스트를 되살리는 유일한 길인데, 그냥 새로고침하면 홈으로 돌아가버린다.
// 보던 자리를 한 줄 적어두고 다음 부팅에서 되짚는다 (읽는 쪽은 위의 resumeView).
function saveView() {
    const view = mode === "command" && currentCmd ? { mode, id: currentCmd.name }
        : mode === "free" ? { mode }
        : current ? { mode: "problem", id: current.id }
        : null;
    try {
        if (view) sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch { /* 무시 */ }
}

$("brokenReload").onclick = () => { saveView(); location.reload(); };

async function selectProblem(p) {
    // 못 푼 채 넘어가는 것도 기록해야 성공률의 분모가 생긴다.
    // 같은 문제를 다시 여는 것(초기화)도 한 번의 도전으로 친다.
    if (current && !solved) sendStats(current, "left");

    current = p;
    currentCmd = null;
    applyMode("problem");     // 사전이나 자유 터미널에서 넘어왔을 수 있다
    typed = [];               // 기록은 문제 단위다. 초기화를 눌러도 여기로 다시 온다
    sawSolution = false;
    lastGrade = null;
    reported = false;
    startedAt = 0;
    progress.setLast(p.id);
    renderProblem(p);
    renderPeerStat(p.id);
    renderList();
    setStatus("터미널 준비 중...");
    if (attached) $("busy").hidden = false;

    // 준비 중에 다른 문제로 넘어가면 이 호출은 낡은 것이 된다.
    // 그대로 두면 뒤늦게 깨어나서 이미 준비가 끝난 화면 위에 "터미널 준비 중"을
    // 다시 씌우거나, 남의 문제 상태를 건드린다. 자기 차례가 지났으면 조용히 물러난다.
    const gen = ++selectGen;
    const stale = () => gen !== selectGen;

    let setupError = null;
    try {
        await applySetup(vm, p);
    } catch (e) {
        setupError = e.message;
    }
    if (stale()) return;
    $("busy").hidden = true;
    if (setupError) {
        // 여기서 그냥 돌아가면 화면이 정리 안 된 채로 남는다
        vm.setMuted(false);
        await vm.clearScreen();
        if (stale()) return;
        // 되살릴 수 있는 실패인지 갈라준다. 게스트가 통째로 망가졌으면
        // "초기화를 눌러보세요" 는 거짓말이다 — 눌러도 같은 실패만 반복된다.
        if (await guestBroken()) {
            if (stale()) return;
            showBroken(true);
            setStatus("시스템이 망가졌습니다 — 다시 불러오세요");
        } else {
            setStatus(`터미널 준비 실패: ${setupError} — 문제 되돌리기를 눌러보세요`);
        }
        return;
    }
    showBroken(false);
    treeSnap = null;
    treeRoot = null;
    if (!SELFTEST) await refreshTree({ markChanges: false });
    if (stale()) return;
    setStatus(`${p.id} — 명령을 입력하세요`);
    focusTerm();
}

async function gradeNow() {
    if (!current || grading || solved) return;
    grading = true;
    try {
        const results = await grade(vm, current);
        renderChecks(results);
        lastGrade = results;        // 떠날 때 어디까지 갔는지 남기려면 마지막 결과가 필요하다
        const passed = results.goals.filter((r) => r.ok).length;
        if (isSolved(results)) {
            solved = true;
            $("solved").classList.add("show");
            $("already").hidden = true;
            if (progress.markSolved(current.id)) renderList();
            progress.saveLog(current.id, typed);
            sendStats(current, "solved");
            setStatus(`${current.id} — 통과`);
            showBroken(false);
        } else {
            // 채점 조건이 아예 실행되지 못했으면 그건 채점 결과가 아니라 고장이다.
            // 이건 공짜로 안다 — 이미 받은 결과에 표시돼 있다.
            const cantRun = [...results.goals, ...results.guards].some((r) => r.noRun || r.timedOut);
            if (cantRun || await healthDue()) {
                showBroken(true);
                setStatus("시스템이 망가졌습니다 — 다시 불러오세요");
                return;
            }
            showBroken(false);
            setStatus(brokeGuard(results)
                ? `${current.id} — 유지 조건이 깨졌습니다`
                : `${current.id} — ${passed}/${results.goals.length}`);
        }
    } finally {
        grading = false;
    }
}

// ---------- 버튼 ----------
$("logBtn").onclick = () => {
    const list = $("logList");
    list.hidden = !list.hidden;
    $("logBtn").textContent = `지난 풀이 ${list.hidden ? "보기" : "접기"} (${list.children.length}줄)`;
};

$("hintBtn").onclick = () => {
    const hints = current?.hints ?? [];
    if (hintsShown >= hints.length) return;
    const d = document.createElement("div");
    d.textContent = `힌트 ${hintsShown + 1}. ${hints[hintsShown]}`;
    $("hints").appendChild(d);
    if (++hintsShown >= hints.length) $("hintBtn").disabled = true;
};
$("solutionBtn").onclick = () => {
    if (!current?.solution) return;
    const d = document.createElement("div");
    d.textContent = `정답:\n${current.solution.trim()}`;
    d.style.whiteSpace = "pre-wrap";
    $("hints").appendChild(d);
    $("solutionBtn").disabled = true;
    sawSolution = true;
};
// 파일트리 접기/펴기. 터미널을 넓게 쓰고 싶을 때가 있다.
function setFilesVisible(on) {
    $("wrap").classList.toggle("no-files", !on);
    // 같은 일을 하는 버튼이 두 곳에 있다 (문제 화면, 자유 터미널).
    // 한쪽만 갱신했더니 자유 터미널 버튼이 "파일 보기" 에 붙박여 있었다.
    for (const id of ["filesBtn", "freeFiles"]) {
        $(id).textContent = on ? "파일 숨기기" : "파일 보기";
        $(id).classList.toggle("on", on);
    }
    pref.set(on);
    // 터미널 폭이 바뀌었으니 다시 맞추고 게스트에도 알린다 (안 그러면 vi 가 어긋난다).
    // 시작할 때는 아직 터미널이 안 열려 있으므로 건너뛴다.
    if (attached) {
        fit.fit();
        vm.setTermSize(term.cols, term.rows);
    }
}
$("filesBtn").onclick = () => setFilesVisible($("wrap").classList.contains("no-files"));

// 문제를 풀다 막혔을 때 홈으로 나가지 않고 왼쪽 패널에서 바로 찾아본다.
// 홈의 기본명령어 탭과 같은 카드를 쓰되 목차(cmdNav)는 안 만든다 —
// 패널이 좁아서 분류를 오가는 것보다 검색이 빠르다.
function renderCmdFind(q = "") {
    const query = q.trim().toLowerCase();
    const hit = COMMANDS.filter((c) => !query || cmdHaystack(c).includes(query));
    const box = $("cmdFindList");
    box.innerHTML = "";
    // inPanel=true — "터미널에서 쳐보기" 버튼을 빼야 한다.
    // 그게 문제 풀이를 자유 터미널로 갈아치워서 풀던 문제가 날아간다.
    for (const c of hit) box.appendChild(commandCard(c, true));
    $("cmdFindNone").hidden = !!hit.length;
}

// 파일트리와 같은 곁 패널이라 여닫는 방식도 같다.
// 터미널이 쓰는 폭이 달라지므로 게스트에 새 크기를 알려야 한다 —
// 안 알리면 vi 나 top 같은 화면이 옛 폭으로 그려져 어긋난다.
function setCmdsVisible(on) {
    $("wrap").classList.toggle("no-cmds", !on);
    $("cmdFindBtn").textContent = on ? "명령어 닫기" : "명령어 찾기";
    $("cmdFindBtn").classList.toggle("on", on);
    cmdsPref.set(on);
    if (on && !$("cmdFindList").children.length) renderCmdFind($("cmdFindQ").value);
    if (attached) {
        fit.fit();
        vm.setTermSize(term.cols, term.rows);
    }
    if (on) $("cmdFindQ").focus();
}
$("cmdFindBtn").onclick = () => setCmdsVisible($("wrap").classList.contains("no-cmds"));
$("cmdFindQ").oninput = (e) => renderCmdFind(e.target.value);

// 문제 창 접기. 터미널만 크게 쓰고 싶을 때가 있다.
// 접으면 사이드바가 통째로 사라지므로, 다시 열 손잡이를 터미널 위에 띄운다.
function setSideVisible(on) {
    $("wrap").classList.toggle("no-side", !on);
    $("sideOpen").hidden = on;
    sidePref.set(on);
    if (attached) {
        fit.fit();
        vm.setTermSize(term.cols, term.rows);
    }
}
$("sideBtn").onclick = () => setSideVisible(false);
$("sideOpen").onclick = () => setSideVisible(true);

// 폰에서는 문제 창이 터미널을 통째로 덮는다. 화살표 하나만 있으면
// 그걸 눌렀을 때 무엇이 나오는지 알 수가 없어서, 좁을 때만 글자를 붙인다.
const narrow = matchMedia("(max-width: 760px)");
function syncPanelLabels() {
    const n = narrow.matches;
    $("sideBtn").textContent = n ? "터미널 ⟩" : "⟨";
    $("sideOpen").textContent = n ? "⟨ 문제" : "⟩";
}
narrow.addEventListener("change", syncPanelLabels);
syncPanelLabels();

// 문제 창 폭 조절.
//
// 폭은 CSS 변수 하나로만 다룬다. 그리드 열 정의를 JS 에서 새로 쓰면
// 접기 상태(no-side/no-files)와 좁은 화면 규칙이 정한 열 수를 덮어써서
// 터미널이 다음 줄로 밀린다.
//
// 최대폭은 창 크기에 따라 정한다. 좁은 화면에서 저장해 둔 넓은 폭을 그대로
// 되살리면 터미널이 남는 폭 없이 찌그러진다.
const SIDE_MIN = 240;
const sideMax = () => Math.max(SIDE_MIN, innerWidth - 360);
const widthKey = "dotslash.pref.sideWidth";
let savedWidth = 0;
try { savedWidth = Number(localStorage.getItem(widthKey)) || 0; } catch { /* 무시 */ }

function setSideWidth(px, save = true) {
    const w = Math.round(Math.min(Math.max(px, SIDE_MIN), sideMax()));
    $("wrap").style.setProperty("--side-w", `${w}px`);
    if (save) {
        savedWidth = w;
        try { localStorage.setItem(widthKey, String(w)); } catch { /* 무시 */ }
    }
    return w;
}
if (savedWidth) setSideWidth(savedWidth, false);

{
    const grip = $("sideGrip");
    let startX = 0, startW = 0;

    grip.onpointerdown = (e) => {
        startX = e.clientX;
        startW = $("side").offsetWidth;
        grip.setPointerCapture(e.pointerId);
        grip.classList.add("dragging");
        e.preventDefault();          // 드래그 중 텍스트가 선택되는 것을 막는다
    };
    grip.onpointermove = (e) => {
        if (!grip.hasPointerCapture(e.pointerId)) return;
        setSideWidth(startW + e.clientX - startX);
        // 폭만 따라 움직이고 터미널 재계산은 손을 뗄 때 한 번만 한다.
        // 게스트에 크기를 알리는 것은 왕복이라 매 프레임 보낼 것이 못 된다.
    };
    const end = (e) => {
        if (!grip.hasPointerCapture(e.pointerId)) return;
        grip.releasePointerCapture(e.pointerId);
        grip.classList.remove("dragging");
        if (attached) { fit.fit(); vm.setTermSize(term.cols, term.rows); }
    };
    grip.onpointerup = end;
    grip.onpointercancel = end;

    // 너무 끌어당겼을 때 되돌릴 방법. 변수를 지우면 CSS 기본값으로 돌아간다.
    grip.ondblclick = () => {
        $("wrap").style.removeProperty("--side-w");
        savedWidth = 0;
        try { localStorage.removeItem(widthKey); } catch { /* 무시 */ }
        if (attached) { fit.fit(); vm.setTermSize(term.cols, term.rows); }
    };
}

$("resetBtn").onclick = () => current && selectProblem(current);
$("wipeBtn").onclick = () => {
    if (!confirm("풀었던 기록을 모두 지웁니다. 계속할까요?")) return;
    progress.reset();
    renderList();
    $("already").hidden = true;
    closeModal();      // 설정 안에 있으므로 닫아줘야 지워진 목록이 보인다
};

// 터미널은 문제 화면에서만 키를 받아야 한다.
//
// 홈이 떠 있는데 터미널이 포커스를 쥐고 있으면 xterm 이 키를 먹어서
// Ctrl-W 같은 브라우저 단축키가 안 듣는다. 홈에서는 터미널이 없는 셈이어야 한다.
// (터미널 안에서 Ctrl-W 가 안 나가는 것은 정상이다. 그건 셸의 키다.)
const focusTerm = () => { if (attached && $("home").hidden) term.focus(); };

// 홈과 문제 화면을 오간다. 홈은 터미널 위에 덮는 것이라 VM 은 계속 살아 있다.
function showHome(on) {
    $("home").hidden = !on;
    if (on) {
        renderHome();
        // 덮기만 하면 포커스가 터미널에 그대로 남는다. 명시적으로 떼어놔야 한다.
        if (attached) term.blur();
    } else {
        focusTerm();
    }
}

// 뒤로가기(Cmd+[ · 마우스 옆 버튼)가 사이트를 통째로 벗어나던 문제.
//
// 홈은 별도 페이지가 아니라 터미널 위에 덮는 화면이라, 문제를 열어도 브라우저
// 히스토리에는 아무 흔적이 안 남았다. 그래서 뒤로가기를 누르면 홈이 아니라
// 여기 오기 전에 보던 남의 사이트로 나가버렸다.
//
// 홈을 바닥 상태로 깔고 그 위에 "문제를 보는 중" 한 겹만 쌓는다.
// 문제끼리 오갈 때는 안 쌓는다 — 안 그러면 뒤로가기가 지나온 문제를 하나씩
// 거슬러 올라가고, 홈에 닿으려면 열 번을 눌러야 한다.
if (!history.state?.rl) history.replaceState({ rl: "home" }, "");

const inView = () => history.state?.rl === "view";

function enterView() {
    if (!inView()) history.pushState({ rl: "view" }, "");
    showHome(false);
}

function backToHome() {
    // 쌓아둔 겹이 있으면 그걸 걷어낸다. 히스토리에 죽은 항목을 남기지 않으려는 것이고,
    // 실제 화면 전환은 아래 popstate 가 맡는다.
    if (inView()) history.back();
    else showHome(true);
}

// 뒤로/앞으로 어느 쪽이든 상태만 보고 화면을 맞춘다.
addEventListener("popstate", () => showHome(!inView()));

// 문제를 연다. 아직 부팅이 안 끝났으면 붙잡아 뒀다가 준비되는 대로 연다 —
// 홈을 보는 동안 스냅샷을 미리 받으므로 대개는 이미 끝나 있다.
function openProblem(p) {
    if (!bootDone) {
        queued = { label: p.id, run: () => openProblem(p) };
        setStatus($("status").textContent);   // 기다리는 중이라는 표시를 홈에 붙인다
        return;
    }
    enterView();
    selectProblem(p);
}

// 한 묶음 안에서만 움직인다 (문제는 레벨, 사전은 분류). 건너뛰려면 홈으로 간다.
const step = (d) => {
    if (mode === "command" && currentCmd) {
        const list = cmdsInCat(currentCmd.cat);
        const next = list[list.indexOf(currentCmd) + d];
        if (next) selectCommand(next);
        return;
    }
    if (!current) return;
    const mine = inLevel(current.level);
    const next = mine[mine.indexOf(current) + d];
    if (next) openProblem(next);
};
$("prevBtn").onclick = () => step(-1);
$("nextBtn").onclick = () => step(1);
// 어느 모드에서 왔는지에 맞는 탭으로 돌려보낸다
$("homeBtn").onclick = () => {
    backToHome();
    if (mode === "command") selectTab("paneCmds");
};

// ---------- 환경설정 ----------
// 글자 크기가 바뀌면 열·행 수가 달라지므로 게스트에도 알려야 vi 가 안 깨진다.
const applyCfg = () => settings.apply(cfg, {
    term,
    onTermResize: () => {
        if (!attached) return;
        fit.fit();
        vm.setTermSize(term.cols, term.rows);
    },
});

// 힌트·정답 버튼은 설정에 따라 아예 감춘다.
// disabled 로 두면 "누를 수 있는데 안 눌리는" 상태라 오히려 신경이 쓰인다.
function syncHintButtons() {
    $("hintBtn").hidden = !cfg.showHints;
    $("solutionBtn").hidden = !cfg.showSolution;
}

function syncSettingsUI() {
    $("setSize").value = cfg.fontSize;
    $("setSizeVal").textContent = `${cfg.fontSize}px`;
    $("setColor").value = cfg.termColor;
    $("setTheme").value = cfg.appTheme;
    $("setHints").value = cfg.showHints ? "on" : "off";
    $("setSolution").value = cfg.showSolution ? "on" : "off";
    $("setStats").value = cfg.sendStats ? "on" : "off";
    syncHintButtons();
}

$("setColor").innerHTML = Object.entries(settings.TERM_COLORS)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");

const changeCfg = (patch) => {
    cfg = { ...cfg, ...patch };
    settings.save(cfg);
    applyCfg();
    syncSettingsUI();
};
$("setSize").oninput = (e) => changeCfg({ fontSize: Number(e.target.value) });
$("setColor").onchange = (e) => changeCfg({ termColor: e.target.value });
$("setTheme").onchange = (e) => changeCfg({ appTheme: e.target.value });
$("setHints").onchange = (e) => changeCfg({ showHints: e.target.value === "on" });
$("setSolution").onchange = (e) => changeCfg({ showSolution: e.target.value === "on" });
$("setStats").onchange = (e) => changeCfg({ sendStats: e.target.value === "on" });
$("setReset").onclick = () => changeCfg({ ...settings.DEFAULTS });
// 설정 팝업. 목록에서 섹션을 고르면 그 섹션만 보여주고, 뒤로가기로 목록에 돌아온다.
const VIEWS = {
    term: ["mTerm", "터미널 설정"], disp: ["mDisp", "화면 설정"],
    learn: ["mLearn", "힌트, 정답, 로그전송"], prog: ["mProg", "진도 초기화"], about: ["mAbout", "개선제안"],
};

function showView(name) {
    const isMenu = !name;
    $("mMenu").hidden = !isMenu;
    for (const [id] of Object.values(VIEWS)) $(id).hidden = true;
    if (!isMenu) $(VIEWS[name][0]).hidden = false;
    $("mTitle").textContent = isMenu ? "설정" : VIEWS[name][1];
    $("mBack").hidden = isMenu;
}
function openModal() { $("modal").hidden = false; showView(null); }
function closeModal() { $("modal").hidden = true; focusTerm(); }

// ---------- 문제 신고 ----------
//
// 수집 기록은 "어디서 막혔는지"까지만 알려준다. 사람이 무엇을 이상하다고 느꼈는지는
// 본인이 말해줘야 안다. 그래서 신고를 따로 둔다.
//
// 터미널 기록을 같이 보낼지는 본인이 고른다. 없으면 대부분의 신고를 재현할 수 없고,
// 있으면 무엇을 쳤고 무엇이 나왔는지가 그대로 보인다. 기본은 켜두되 무엇이 가는지 적어둔다.
const LOG_MAX = 20000;   // 뒤에서 20KB. 세션이 길면 통째로는 너무 크다

// 신고 시점에 무엇을 보고 있었는지. 문제일 수도, 사전일 수도, 자유 터미널일 수도 있다.
function reportTarget() {
    if (mode === "command" && currentCmd) return { kind: "command", id: currentCmd.name };
    if (mode === "free") return { kind: "free", id: "" };
    if (current) return { kind: "problem", id: current.id };
    return { kind: "home", id: "" };
}

function openReport() {
    const t = reportTarget();
    $("rWhere").textContent = t.kind === "problem" ? `문제 ${t.id}`
        : t.kind === "command" ? `명령어 ${t.id}`
        : t.kind === "free" ? "자유 터미널"
        : "홈";
    const log = vm.userSerial().slice(-LOG_MAX);
    $("rLogNote").textContent = attached
        ? `터미널에 찍힌 내용 ${(log.length / 1024).toFixed(1)}KB 가 함께 갑니다. 계정·위치 같은 신원 정보는 보내지 않습니다.`
        : "아직 터미널을 연 적이 없어 보낼 기록이 없습니다.";
    $("rLog").disabled = !attached;
    $("rResult").hidden = true;
    $("rSend").disabled = false;
    $("report").hidden = false;
    $("rText").focus();
}

function closeReport() {
    $("report").hidden = true;
    focusTerm();
}

$("reportBtn").onclick = openReport;
$("rClose").onclick = closeReport;
$("rCancel").onclick = closeReport;

$("rSend").onclick = async () => {
    const text = $("rText").value.trim();
    if (!text) { $("rText").focus(); return; }
    $("rSend").disabled = true;
    const t = reportTarget();
    const body = JSON.stringify({
        kind: t.kind,
        target: t.id,
        message: text,
        log: $("rLog").checked && attached ? vm.userSerial().slice(-LOG_MAX) : "",
    });
    const show = (msg) => { $("rResult").textContent = msg; $("rResult").hidden = false; };
    try {
        const r = await fetch("/api/report", {
            method: "POST", headers: { "content-type": "application/json" }, body,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        show("보냈습니다. 고맙습니다.");
        $("rText").value = "";
        setTimeout(closeReport, 1200);
    } catch (e) {
        // 실패를 조용히 삼키면 보낸 줄 알고 끝난다
        show(`보내지 못했습니다 (${e.message}). 잠시 뒤 다시 시도해 주세요.`);
        $("rSend").disabled = false;
    }
};

addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("report").hidden) closeReport();
});

$("gearBtn").onclick = openModal;
$("homeGear").onclick = openModal;
$("mClose").onclick = closeModal;
$("mBack").onclick = () => showView(null);
for (const b of document.querySelectorAll(".menu-item")) b.onclick = () => showView(b.dataset.view);
// 배경을 누르거나 Esc 로도 닫힌다
$("modal").onclick = (e) => { if (e.target === $("modal")) closeModal(); };
addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").hidden) closeModal(); });
syncSettingsUI();

// ---------- 터미널 전환 ----------
function switchToTerminal() {
    $("screen").hidden = true;
    $("waiting").hidden = true;
    $("term").hidden = false;
    term.open($("term"));
    // 부팅 전에 보낸 확인용 명령들이 셸의 입력 버퍼에 쌓였다가
    // 셸이 뜨는 순간 한꺼번에 에코된다. 그 찌꺼기부터 지우고 시작한다.
    term.clear();
    fit.fit();

    // 창 크기가 바뀌면 게스트에도 알려준다. 안 그러면 vi 같은 전체화면 프로그램이
    // 80x24 로 가정하고 그려서 화면이 어긋난다.
    let sizeTimer = null;
    const syncSize = () => {
        clearTimeout(sizeTimer);
        sizeTimer = setTimeout(() => vm.setTermSize(term.cols, term.rows), 200);
    };
    addEventListener("resize", () => {
        // 창이 좁아지면 저장된 폭이 최대치를 넘을 수 있다. 저장은 안 한다 —
        // 창을 잠깐 줄였다고 원래 취향까지 지워버리면 곤란하다.
        if (savedWidth) setSideWidth(savedWidth, false);
        fit.fit();
        syncSize();
    });
    syncSize();

    term.onData((d) => {
        // 엔터 직전의 화면을 먼저 읽는다. 보내고 나면 프롬프트가 지나가버린다.
        if (d.includes("\r")) recordTyped();
        vm.sendUser(d);
        // 엔터를 치면 출력이 잦아든 뒤 자동 채점한다.
        // 제출 버튼을 두지 않으므로 한 줄로 푸는 사람과 여러 명령으로
        // 나눠 푸는 사람이 둘 다 자연스럽게 커버된다.
        if (d.includes("\r")) {
            pendingGrade = vm.waitQuiet(400).then(async () => {
                await refreshTree();
                // 사전·자유 터미널에는 채점이 없다. 그래도 게스트가 망가진 것은 알려야 한다 —
                // 안 그러면 명령이 왜 안 듣는지 모른 채 계속 치게 된다.
                if (mode === "problem") await gradeNow();
                else if (await healthDue()) {
                    showBroken(true);
                    setStatus("시스템이 망가졌습니다 — 다시 불러오세요");
                }
            });
        }
    });
    attached = true;
    applyCfg();          // 터미널이 생긴 뒤에야 글자 색·크기를 적용할 수 있다
    // 홈이 떠 있으면 포커스를 가져가지 않는다. 가져가면 브라우저 단축키가 막힌다.
    focusTerm();
}

// ---------- 자체 검증 ----------
const results = [];
function record(label, ok, out = "") {
    results.push({ label, ok, out });
    // 한 줄씩 바로 보낸다. 끝날 때 몰아서 보내면 진행 중인지 멈춘 건지 알 수 없다.
    fetch("/progress", { method: "POST", body: `${ok ? "PASS" : "FAIL"}  ${label}${out ? `  ${out}` : ""}` })
        .catch(() => { });
    const line = document.createElement("div");
    line.className = ok ? "pass" : "fail";
    line.textContent = `${ok ? "PASS" : "FAIL"}  ${label}` + (out ? `\n      ${out}` : "");
    $("selftest").appendChild(line);
}

async function selftest() {
    const env = await vm.run("uname -sm; whoami");
    record("게스트 응답", env.exit === 0, env.out.replace(/\n/g, " · "));
    record("문제 로딩", problems.length > 0, `${problems.length}개`);

    // 모든 문제를 전수 검사한다. 문제마다
    //   setup 적용 -> 채점(실패해야 함) -> 정답 입력 -> 채점(통과해야 함)
    // 이 순서로 돌린다. 채점기와 문제 세트를 동시에 검증하는 회귀 테스트다.
    //
    // ?only=a,b 로 몇 개만 돌릴 수 있다. 문제 하나를 고쳤을 때 51개를 다 도는 것은
    // 8분을 버리는 일이다. 다만 채점기나 정답 입력 경로처럼 모든 문제가 공유하는
    // 곳을 건드렸다면 전수로 돌려야 한다 — 거기서 깨지는 것은 한 문제만 봐서는 안 보인다.
    const only = (new URLSearchParams(location.search).get("only") ?? "")
        .split(",").map((x) => x.trim()).filter(Boolean);
    if (only.length) console.log(`선택 검사: ${only.join(", ")}`);
    for (const p of only.length ? problems.filter((x) => only.includes(x.id)) : problems) {
        if (p.type === "quiz" || !p.solution) continue;
        setStatus(`검증 중... ${p.id}`);

        let err = null;
        try {
            await selectProblem(p);
        } catch (e) {
            err = e.message;
        }
        if (err) { record(`${p.id}`, false, `setup 실패: ${err}`); continue; }

        // 목표는 풀기 전에 전부 실패해야 하고, 전제는 전부 성립해야 한다.
        // 이 규칙이 있어야 "처음부터 ✓ 인 조건"이 섞여드는 걸 막는다.
        const before = await grade(vm, p);
        const early = before.goals.filter((r) => r.ok).map((r) => r.desc);
        const badGuard = before.guards.filter((r) => !r.ok).map((r) => r.desc);
        if (early.length) {
            record(`${p.id}`, false, `setup 직후 이미 통과하는 목표: ${early.join(" / ")} (guard 로 옮길 것)`);
            continue;
        }
        if (badGuard.length) {
            record(`${p.id}`, false, `setup 직후 깨진 전제: ${badGuard.join(" / ")}`);
            continue;
        }

        // 정답을 사용자 채널로 실제 타이핑해서 푼다.
        //
        // 한 줄씩 보내고, 그 줄이 끝난 것을 확인하고 다음 줄을 보낸다.
        //
        // 예전에는 여러 줄을 한꺼번에 밀어넣었는데, 그러면 앞 명령이 도는 동안
        // 뒷줄이 tty 버퍼에 쌓인다. sudo 나 nmap 처럼 stdin 을 건드리는 명령이
        // 그 줄을 먹어버려서 완료 신호가 영영 안 온다.
        // (문제를 root 에서 sudo 로 바꾸자 disk-01·disk-03·perm-05 가 실제로 그렇게 멈췄다.)
        //
        // 사람도 한 줄 치고 결과를 보고 다음 줄을 친다. 그쪽이 실제 사용과도 가깝다.
        const lines = p.solution.trim().split("\n");
        const from = vm.userSerial().length;
        for (let i = 0; i < lines.length; i++) {
            const last = i === lines.length - 1;
            const before = vm.userSerial().length;
            vm.sendUser(last ? `${lines[i]}; echo "__IDLE""__"\n` : `${lines[i]}\n`);
            // 다음 줄을 밀어넣기 전에 앞줄이 잦아들기를 기다린다.
            //
            // 표식은 마지막 줄에만 붙인다 — 줄마다 붙이면 heredoc 본문 안으로 들어가서
            // 그냥 텍스트가 된다 (script-03 의 cat <<'SH' 가 그렇게 멈췄다).
            //
            // 잦아들기 전에 "출력이 오기 시작한 것"을 먼저 확인해야 한다.
            // waitQuiet 만 부르면 아직 아무 출력도 안 온 상태를 이미 조용한 것으로 보고
            // 즉시 통과해서, 결국 줄이 그대로 쏟아진다 (script-04 가 그래서 멈췄다).
            // vm.js 의 clearScreen 이 같은 이유로 같은 순서를 쓴다.
            if (!last) {
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline && vm.userSerial().length === before) await sleep(30);
                await vm.waitQuiet(250, 30000);
            }
        }
        if (!(await vm.waitFor(() => vm.userSerial(), /__IDLE__/, { timeout: 120000, from }))) {
            record(`${p.id}`, false, "정답 실행이 끝나지 않음 (타임아웃)");
            continue;
        }
        const after = await grade(vm, p);
        renderChecks(after);
        const failed = [
            ...after.goals.filter((r) => !r.ok).map((r) => r.desc),
            ...after.guards.filter((r) => !r.ok).map((r) => `전제 깨짐: ${r.desc}`),
        ];
        record(`${p.id}`, isSolved(after),
            failed.length ? `실패: ${failed.join(" / ")}`
                : `목표 ${after.goals.length} + 전제 ${after.guards.length}`);
    }

    // 아직 못 이룬 목표를 "틀림(빨강)"으로 칠하면 안 된다.
    // 명령 한 번 칠 때마다 화면이 빨개져서 뭔가 잘못한 것처럼 보인다.
    {
        const p = problems.find((x) => x.check?.length && x.solution);
        await selectProblem(p);
        renderChecks(await grade(vm, p));
        const cls = [...$("checks").children].map((li) => li.className);
        record("미달성 목표는 회색", cls.every((c) => c === "no"), cls.join(" "));
    }

    // 문제를 여러 번 오가도 전환 찌꺼기가 화면에 남지 않아야 한다.
    // 화면 갱신을 너무 일찍 다시 켜면 늦게 도착한 ^C, exit, cd 명령줄이 그대로 찍힌다.
    {
        const rootP = problems.find((x) => (x.setup?.user ?? "student") === "root");
        const stuP = problems.find((x) => x.setup?.user === "student");
        let leaked = [];
        let lastScreen = "";
        if (rootP && stuP) {
            for (let i = 0; i < 3; i++) {
                await selectProblem(i % 2 ? rootP : stuP);
                // 전환 직후 화면(터미널 버퍼)에 찌꺼기가 있는지 본다
                const buf = term.buffer.active;
                let text = "";
                for (let y = 0; y < buf.length; y++) text += buf.getLine(y)?.translateToString(true) + "\n";
                lastScreen = text.split("\n").filter((l) => l.trim()).join(" | ").slice(0, 120);
                for (const junk of ["^C", "exit", "can't access tty", "2>/dev/null"]) {
                    if (text.includes(junk) && !leaked.includes(junk)) leaked.push(junk);
                }
                // 프롬프트는 하나만, 그리고 현재 계정에 맞는 것이어야 한다.
                // 전환 전 프롬프트가 살아남으면 root(#) 와 student($) 가 같이 보인다.
                const prompts = text.split("\n").map((l) => l.trim())
                    .filter((l) => /[#$]$/.test(l) && l.length < 30);
                const want = (i % 2 ? rootP : stuP).setup?.user === "student" ? "$" : "#";
                if (prompts.length !== 1 && !leaked.includes(`프롬프트 ${prompts.length}개`))
                    leaked.push(`프롬프트 ${prompts.length}개`);
                else if (prompts.length === 1 && !prompts[0].endsWith(want)
                    && !leaked.includes("프롬프트 계정 불일치"))
                    leaked.push(`프롬프트 계정 불일치(${prompts[0]} != ...${want})`);
            }
        }
        record("문제 전환 찌꺼기 없음", leaked.length === 0,
            leaked.join(" / ") || `화면: ${JSON.stringify(lastScreen)}`);
    }

    // 사용자가 중첩 셸이나 전체화면 프로그램에 들어가 있어도 계정 전환이 되어야 한다.
    // exit 한 번으로는 안 죽는 상황이라 강제 정리가 필요하다.
    {
        const rootP = problems.find((x) => (x.setup?.user ?? "student") === "root");
        const stuP = problems.find((x) => x.setup?.user === "student");
        if (rootP && stuP) {
            await selectProblem(rootP);
            vm.sendUser("sh\n");            // 중첩 셸로 들어간다
            await vm.waitUserEcho(15000);
            let err = null;
            try { await selectProblem(stuP); } catch (e) { err = e.message; }
            record("중첩 셸에서도 계정 전환", !err && (await vm.currentUser()) === "student",
                err ?? await vm.currentUser());
        }
    }

    // 한글이 터미널을 오가도 깨지지 않아야 한다.
    // 시리얼은 바이트 단위라 한 바이트씩 문자로 바꾸면 멀티바이트가 망가진다.
    {
        const p0 = problems[0];
        await selectProblem(p0);
        const w = await vm.run("printf '한글 테스트\\n' > /work/ko.txt; cat /work/ko.txt");
        record("채점 채널 한글 왕복", w.out === "한글 테스트", JSON.stringify(w.out));

        const from = vm.userSerial().length;
        vm.sendUser("cat /work/ko.txt\n");
        await vm.waitUserEcho(15000);
        const seen = vm.userSerial().slice(from);
        record("사용자 터미널 한글 표시", seen.includes("한글 테스트"));
        await vm.run("rm -f /work/ko.txt");
    }

    // 문제를 바꾸면 사용자 셸이 지정된 디렉터리로 돌아와야 한다.
    // 다른 데서 작업하다 넘어가면 엉뚱한 곳에서 문제를 풀게 된다.
    {
        const p0 = problems[0];
        await selectProblem(p0);
        vm.sendUser("cd /etc\n");
        await vm.waitUserEcho(15000);
        const p1 = problems[1] ?? p0;
        await selectProblem(p1);
        const from = vm.userSerial().length;
        vm.sendUser('echo "__PWD""__$(pwd)"\n');
        await vm.waitUserEcho(15000);
        const m = vm.userSerial().slice(from).match(/__PWD__(\S+)/);
        // 돌아갈 곳이 늘 /work 인 것은 아니다. 문제가 setup.cwd 로 다른 곳을
        // 지정할 수 있다 (basic-02 는 /work/a/b/c 에서 시작한다).
        // 상수로 박아두면 그런 문제를 추가하는 순간 멀쩡한 동작이 실패로 잡힌다.
        const want = p1.setup?.cwd ?? "/work";
        record("문제 전환 후 작업 위치 복귀", m?.[1] === want,
            `${m?.[1] ?? "(확인 실패)"} (기대 ${want})`);
    }

    // vi 를 열어둔 채 다음 문제로 넘어가도 프롬프트가 돌아와야 한다.
    // 안 그러면 화면에 vi 잔해가 남고 입력이 전부 vi 로 들어간다.
    {
        vm.sendUser("vi /etc/hosts\n");
        await sleep(2500);                       // vi 가 화면을 다 그릴 때까지
        await selectProblem(problems[0]);
        const from = vm.userSerial().length;
        vm.sendUser('echo "__ALIVE""__$(pwd)"\n');
        const ok = await vm.waitUserEcho(15000);
        const m = vm.userSerial().slice(from).match(/__ALIVE__(\S+)/);
        record("vi 를 열어둔 채 문제를 바꿔도 셸이 살아 있다", ok && m?.[1] === "/work",
            m?.[1] ?? "(응답 없음)");
    }

    // 풀이 기록은 키 입력이 아니라 화면에 그려진 줄에서 뽑는다.
    // 위 문제 루프는 vm.sendUser 로 터미널을 건너뛰기 때문에 이 경로를 전혀 안 지난다.
    // term.input 으로 실제 타이핑과 같은 길을 태워야 의미가 있다.
    {
        await selectProblem(problems[0]);          // typed 가 비워진다
        const cmd = "echo 기록테스트";
        for (const ch of cmd) term.input(ch);      // 게스트가 한 글자씩 에코한다
        await vm.waitQuiet(600);                   // 그 에코가 화면에 그려질 때까지
        term.input("\r");
        await vm.waitUserEcho(15000);
        record("풀이 기록이 친 명령 그대로 남는다", typed.at(-1) === cmd,
            `${typed.length}줄 · 마지막 ${JSON.stringify(typed.at(-1) ?? null)}`);

        // 수집 payload 가 서버(api/src/index.js) 검사를 통과하는 모양인지 본다.
        // 서버가 400 을 돌려줘도 화면에는 아무 표시가 없으므로 여기서 잡아야 한다.
        const pl = statsPayload(problems[0], "solved");
        const bad = [];
        if (!/^[\w-]+$/.test(pl.problem_id)) bad.push(`problem_id 형식(${pl.problem_id})`);
        if (!["solved", "left", "closed"].includes(pl.outcome)) bad.push(`outcome=${pl.outcome}`);
        if (!Array.isArray(pl.commands) || pl.commands.some((c) => typeof c !== "string"))
            bad.push("commands 가 문자열 배열이 아님");
        for (const k of ["elapsed_ms", "hints_used", "goals_passed", "goals_total"]) {
            if (!Number.isFinite(pl[k]) || pl[k] < 0) bad.push(`${k}=${pl[k]}`);
        }
        if (typeof pl.saw_solution !== "boolean") bad.push("saw_solution 이 boolean 아님");
        if (pl.elapsed_ms <= 0) bad.push("elapsed_ms 가 0 — 첫 명령 시각이 안 잡혔다");
        if (pl.goals_total <= 0) bad.push("goals_total 이 0 — 목표 개수가 안 잡혔다");
        record("수집 payload 가 서버 형식에 맞는다", bad.length === 0,
            bad.join(" / ") || `${pl.problem_id} · 명령 ${pl.commands.length}개 · ${pl.elapsed_ms}ms`);

        await pendingGrade;      // 엔터가 예약한 채점이 끝나야 채점 채널이 빈다
    }

    // 파일트리는 사용자가 있는 디렉터리를 따라가야 한다 (/work 고정이 아니다).
    {
        vm.sendUser("cd /etc\n");
        await vm.waitUserEcho(15000);
        const moved = await vm.userCwd();
        await refreshTree({ markChanges: false });
        const shown = $("tree").querySelector(".t-root")?.textContent;
        record("파일트리가 현재 디렉터리를 따라간다", moved === "/etc" && shown === "/etc",
            `셸 ${moved} · 트리 ${shown}`);
        vm.sendUser("cd /work\n");
        await vm.waitUserEcho(15000);
    }

    // 파일 패널을 열어도 터미널이 같은 줄에 남아야 한다.
    // 그리드 열 수와 보이는 항목 수가 어긋나면 터미널이 다음 줄로 밀린다.
    // (CSS 규칙 순서가 꼬여 좁은 창에서 실제로 그랬다)
    // 문제 창·파일 패널을 어떤 조합으로 접고 펴도 레이아웃이 안 깨져야 한다.
    // 지켜야 하는 것은 하나다 — 터미널이 다음 줄로 밀리지 않는다.
    //
    // 예전에는 grid-template-columns 의 열 수와 보이는 패널 수가 같은지 셌다.
    // 그건 그리드일 때만 뜻이 있는 대용품이었고, 어긋나면 터미널이 밀린다는
    // 진짜 조건은 offsetTop 으로 바로 볼 수 있다. 지금은 플렉스라 셀 열도 없다.
    // 패널이 셋이 되어 조합은 여덟 가지다.
    {
        const origFiles = pref.get(), origSide = sidePref.get(), origCmds = cmdsPref.get();
        const bad = [];
        for (const side of [true, false]) {
            for (const files of [true, false]) {
                for (const cmds of [true, false]) {
                    setSideVisible(side);
                    setFilesVisible(files);
                    setCmdsVisible(cmds);
                    const m = $("main");
                    // 밀리면 offsetTop 이 0 이 아니다. 폭이 0 이면 칸은 맞는데 터미널이 안 보인다.
                    if (m.offsetTop !== 0 || m.offsetWidth < 100) {
                        bad.push(`문제창${side ? "O" : "X"}·파일${files ? "O" : "X"}`
                            + `·명령어${cmds ? "O" : "X"}: top=${m.offsetTop} w=${m.offsetWidth}`);
                    }
                }
            }
        }
        record("접기 조합마다 레이아웃 유지", bad.length === 0, bad.join(" / "));
        setSideVisible(origSide);
        setFilesVisible(origFiles);
        setCmdsVisible(origCmds);
    }

    // 문제 창 폭 조절. 최소·최대를 넘겨도 레이아웃이 성립해야 한다.
    {
        const origSide = sidePref.get();
        setSideVisible(true);          // 접혀 있으면 폭이 0 이라 잴 것이 없다
        const orig = $("side").offsetWidth;
        // 창 크기를 모르므로 허용 범위 한가운데를 고른다.
        // 고정값(420)을 쓰면 좁은 창에서 상한에 걸려 검사가 헛돈다 (실제로 그랬다).
        const target = Math.round((SIDE_MIN + sideMax()) / 2);
        setSideWidth(target, false);
        const wide = $("side").offsetWidth;
        setSideWidth(10, false);
        const floor = $("side").offsetWidth;
        setSideWidth(99999, false);
        const ceil = $("side").offsetWidth;
        const roomLeft = $("main").offsetWidth > 0 && $("main").offsetTop === 0;
        setSideWidth(orig, false);
        setSideVisible(origSide);
        record("문제 창 폭 조절",
            Math.abs(wide - target) <= 1 && floor === SIDE_MIN && ceil === sideMax() && roomLeft,
            `요청${target}→${wide} / 하한→${floor} / 상한→${ceil}(기대 ${sideMax()})`);
    }

    // 기본명령어 탭. 검색이 이름 밖(설명·옵션)도 훑어야 쓸모가 있고,
    // 없는 명령어를 찾은 사람은 "안 되는 것" 목록에 닿아야 한다.
    {
        const cards = () => $("cmdList").querySelectorAll(".cmd").length;
        renderCommands("");
        const all = cards();
        renderCommands("정렬");                 // 이름에 없는 낱말
        const bySum = cards() > 0;
        renderCommands("man");                  // 없는 명령어
        const un = $("cmdUnavail").querySelectorAll(".un-item").length > 0;
        renderCommands("존재하지않는낱말");
        const none = cards() === 0 && !$("cmdNone").hidden;
        renderCommands("");
        record("명령어 사전 검색", all === COMMANDS.length && bySum && un && none,
            `전체 ${all}/${COMMANDS.length} · 설명검색 ${bySum} · 안되는것 ${un} · 빈결과 ${none}`);

        // 목차는 지금 화면에 있는 덩어리와 개수가 맞아야 한다.
        // 검색으로 사라진 분류가 목차에 남으면 눌러도 아무 데도 안 간다.
        const navCount = () => $("cmdNav").children.length;
        const headCount = () =>
            $("cmdList").querySelectorAll(".lv-head").length
            + $("cmdUnavail").querySelectorAll(".lv-head").length;
        const full = navCount() === headCount();
        renderCommands("정렬");
        const filtered = navCount() === headCount() && navCount() > 0;
        renderCommands("");
        record("명령어 목차", full && filtered, `전체 ${navCount()}칸 · 검색 후에도 일치 ${filtered}`);
    }

    // 문제 화면 안의 명령어 찾기. 홈으로 나가지 않고 풀던 자리에서 찾는 것이 요점이라,
    // 카드에 "터미널에서 쳐보기" 가 섞이면 안 된다 — 그걸 누르면 자유 터미널로
    // 갈아타면서 풀던 문제가 통째로 날아간다.
    {
        const cards = () => $("cmdFindList").querySelectorAll(".cmd").length;
        const origCmds = cmdsPref.get();
        setCmdsVisible(true);
        const opened = !$("wrap").classList.contains("no-cmds") && cards() === COMMANDS.length;
        const noTry = $("cmdFindList").querySelectorAll(".cmd-try").length === 0;
        renderCmdFind("정렬");                  // 이름에 없는 낱말
        const bySum = cards() > 0;
        renderCmdFind("존재하지않는낱말");
        const none = cards() === 0 && !$("cmdFindNone").hidden;
        renderCmdFind("");
        setCmdsVisible(false);
        const closed = $("wrap").classList.contains("no-cmds")
            && $("cmdFindBtn").textContent === "명령어 찾기";
        setCmdsVisible(origCmds);
        record("문제 화면에서 명령어 찾기", opened && noTry && bySum && none && closed,
            `열림 ${opened} · 쳐보기없음 ${noTry} · 설명검색 ${bySum} · 빈결과 ${none} · 닫힘 ${closed}`);
    }

    // 홈이 문제를 하나도 빠뜨리면 안 된다. 레벨을 건너뛰는 통로가 홈뿐이라,
    // 여기서 빠진 문제는 영영 열 수가 없다.
    {
        const rows = [...$("levels").querySelectorAll(".pr")];
        const ids = rows.map((b) => b.children[1].textContent);
        const missing = problems.map((p) => p.id).filter((id) => !ids.includes(id));
        record("홈에 모든 문제가 있다", rows.length === problems.length && missing.length === 0,
            `${rows.length}/${problems.length}${missing.length ? ` · 빠짐: ${missing.join(",")}` : ""}`);
    }

    // 문제 검색. 번호("01")로도, 분류로도 걸려야 한다.
    // 분류 이름에는 공백이 있는데 치는 사람은 붙여 쓰므로 그것도 맞아야 한다.
    {
        const count = () => $("levels").querySelectorAll(".pr").length;
        const search = (q) => { probQuery = q; renderHome(); return count(); };
        const byNum = search("01");
        const byCat = search("grep");
        const noSpace = search("파일조작");           // 실제 분류는 "파일 조작"
        const spaced = search("파일 조작");
        const alias = search("쉘스크립트");            // 실제 분류는 "셸 스크립트"
        const none = search("존재하지않는낱말");
        const noneShown = !$("probNone").hidden;      // 지워지기 전에 잡아둔다
        const back = search("");
        record("문제 검색",
            byNum > 0 && byCat > 0 && noSpace > 0 && noSpace === spaced && alias > 0
            && none === 0 && noneShown && back === problems.length,
            `01→${byNum} grep→${byCat} 파일조작→${noSpace}(공백판 ${spaced})`
            + ` 쉘스크립트→${alias} 없음→${none}(안내 ${noneShown}) 복귀→${back}`);
    }

    // 홈에서는 터미널이 키를 먹으면 안 된다.
    //
    // 포커스가 터미널에 남아 있으면 xterm 이 키를 가로채서 Ctrl-W 같은
    // 브라우저 단축키가 통째로 막힌다. 홈에는 터미널이 없는 셈이어야 한다.
    // (시작하자마자 switchToTerminal 이 조건 없이 focus 를 불러서 실제로 그랬다.)
    {
        const inTerm = () => $("term").contains(document.activeElement);
        showHome(true);
        const homeClean = !inTerm();
        showHome(false);
        const termFocused = inTerm();
        record("홈에서는 터미널이 포커스를 안 잡는다", homeClean && termFocused,
            `홈 ${homeClean ? "안 잡음" : "잡음"} · 문제화면 ${termFocused ? "잡음" : "안 잡음"}`);
    }

    // 이전/다음은 레벨 안에서만 움직인다. 경계에서 안 막히면 옆 레벨로 새어나간다.
    {
        const mine = problems.filter((p) => p.level === problems[0].level);
        await selectProblem(mine[0]);
        const headOk = $("prevBtn").disabled;
        await selectProblem(mine[mine.length - 1]);
        const tailOk = $("nextBtn").disabled;
        record("이전/다음이 레벨 밖으로 안 나감", headOk && tailOk,
            `Lv.${mine[0].level} ${mine.length}문제 · 처음 prev=${headOk} 끝 next=${tailOk}`);
    }

    // 사전 모드. 문제 화면 껍데기를 재사용하므로 왼쪽 패널이 정확히 하나만 떠야 한다.
    // 셋 다 뜨거나 하나도 안 뜨면 화면이 통째로 망가진다.
    {
        const visible = () => [$("problem"), $("cmdView"), $("freeView")]
            .filter((el) => !el.hidden).map((el) => el.id).join(",") || "(없음)";
        const only = (id) => visible() === id;

        const c = COMMANDS.find((x) => cmdsInCat(x.cat).length > 1);
        await selectCommand(c);
        const shown = only("cmdView");
        const named = $("cmdViewBody").querySelector(".cmd-name")?.textContent === c.name;
        // 예시가 기대는 파일이 실제로 깔렸는지. 안 깔리면 예시를 눌러도 다 실패한다.
        const seeded = (await vm.run("test -f /work/sample.txt && test -d /work/sub")).exit === 0;

        const list = cmdsInCat(c.cat);
        const atHead = $("prevBtn").disabled;
        await selectCommand(list[list.length - 1]);
        const atTail = $("nextBtn").disabled;

        await openFree();
        const freeShown = only("freeView");
        const freeSaw = visible();

        await selectProblem(problems[0]);
        const backToProblem = only("problem");

        record("사전·자유 터미널 모드",
            shown && named && seeded && atHead && atTail && freeShown && backToProblem,
            `사전${shown} 이름${named} 연습파일${seeded} 처음prev${atHead} 끝next${atTail}`
            + ` 자유${freeShown}(보인것: ${freeSaw}) 문제복귀${backToProblem}`);
    }

    // 파일트리 접기/펴기
    {
        record("기본은 접힌 상태", !pref.get() && $("wrap").classList.contains("no-files"));
        setFilesVisible(false);
        const hidden = $("wrap").classList.contains("no-files");
        setFilesVisible(true);
        const shown = !$("wrap").classList.contains("no-files");
        record("파일트리 토글", hidden && shown);
    }

    // 파일트리가 실제 파일을 잡아내고, 변경분을 구분하는지
    {
        const p = problems.find((x) => (x.setup?.cwd ?? "/work") === "/work" && x.setup?.files);
        if (p) {
            await selectProblem(p);
            const before = await snapshot(vm, "/work");
            record("파일트리 수집", before.size > 0, `${before.size}개 항목`);

            await vm.run("touch /work/__tree_probe");
            const after = await snapshot(vm, "/work");
            const d = diff(before, after);
            record("추가된 파일 감지", d.marks.get("/work/__tree_probe") === "added");

            await vm.run("rm -f /work/__tree_probe");
            record("삭제된 파일 감지", diff(after, await snapshot(vm, "/work")).removed
                .includes("/work/__tree_probe"));
        }
    }

    // 채점 명령이 사용자 화면에 새는지
    record("채점 채널 격리", !vm.userSerial().includes("__CHK__"));

    // 앱이 사용자 셸로 보낸 명령이 history 에 남으면 안 된다.
    //
    // 화면에 안 보인다고 안 남는 게 아니다. 준비 확인·작업 위치 복귀·계정 전환이
    // 전부 이 셸로 들어가고, 스냅샷을 만들 때도 이 셸을 쓴다.
    // 실제로 history 를 치면 __RUN__ 표식과 base64 덩어리가 쏟아졌다.
    // 채점 채널로는 확인할 수 없다 — 그건 다른 셸이라 히스토리도 따로다.
    {
        const from = vm.userSerial().length;
        vm.sendUser(` history | grep -c '__CHK\\|_OK__'; echo "__HIST""__"\n`);
        const ok = await vm.waitFor(() => vm.userSerial(), /__HIST__/, { timeout: 15000, from });
        const out = vm.userSerial().slice(from).replace(/\r/g, "");
        const n = out.match(/^\s*(\d+)\s*$/m)?.[1];
        record("셸 히스토리에 내부 명령이 안 남는다", ok && n === "0",
            ok ? `내부 명령 ${n ?? "?"}줄` : "응답 없음");
    }

    // 커널 메시지가 사용자 터미널로 안 새는지 (문제점.md case 14).
    // 탭을 뒤로 보내야 재현되는 증상이라 결과가 아니라 설정을 확인한다.
    {
        const lvl = (await vm.run("cat /proc/sys/kernel/printk")).out.split(/\s+/)[0];
        const wd = (await vm.run("cat /proc/sys/kernel/watchdog")).out.trim();
        record("커널 콘솔 로그 잠재움", lvl === "1" && wd === "0", `loglevel=${lvl} watchdog=${wd}`);
    }

    // 초기화하면 다시 미통과여야 한다
    const p0 = problems.find((x) => x.solution);
    if (p0) {
        await applySetup(vm, p0);
        record("초기화 후 미통과", (await grade(vm, p0)).goals.some((r) => !r.ok));
    }

    return results.filter((r) => r.ok).length;
}

// ---------- 시작 ----------
(async () => {
    const t0 = Date.now();
    setStatus("부팅 중...");
    setBar("85%");

    // 부팅이 어디까지 갔는지 커널 로그 마지막 줄을 곁들여 보여준다.
    // 7초를 아무 표시 없이 기다리면 멈춘 것처럼 보인다.
    const ticker = setInterval(() => {
        if (attached) return;
        const line = vm.lastLine();
        $("boot").textContent = line;
    }, 250);

    // 문제 목록은 부팅과 아무 상관이 없다. YAML 몇 개를 받는 것뿐이라 1초면 끝난다.
    // 예전에는 이것을 부팅과 함께 기다렸다가 한꺼번에 그려서, 목록이 뜨는 데
    // 부팅 시간이 통째로 얹혔다. 받는 대로 바로 그린다 — 홈을 훑는 동안 뒤에서 부팅한다.
    const listing = loadIndex().catch(() => []).then((list) => {
        problems = list;
        $("picker").hidden = problems.length === 0;
        renderList();
        return list;
    });

    // 다른 사람들의 결과는 부팅과 나란히 받는다. 실패해도 진행을 막지 않는다.
    const [ready] = await Promise.all([vm.waitReady(), listing, loadPeerStats()]);
    clearInterval(ticker);
    $("boot").textContent = "";
    const sec = ((Date.now() - t0) / 1000).toFixed(1);

    if (!ready) {
        // 부팅이 실패했을 때 v86 의 VGA 화면만 띄우면 사용자에게는
        // "까만 창에 알 수 없는 글자" 로만 보인다. 실제로 그렇게 보고를 받았다.
        // 무엇이 잘못됐고 무엇을 하면 되는지 글로 말해준다.
        //
        // 흔한 원인은 스냅샷을 새로 올린 직후의 캐시 불일치다. 그때는 새로고침 한 번이면
        // 낫는다. 진단이 필요할 때를 위해 VGA 화면은 접어서 남겨둔다.
        setStatus(`부팅 실패 (${sec}초) — 다시 불러오세요`);
        $("bar").style.background = "#bf616a";
        $("waiting").hidden = true;
        showBroken(true);
        $("broken").querySelector("b").textContent = "부팅하지 못했습니다";
        $("broken").querySelector("p").textContent =
            "시스템 이미지를 불러오지 못했습니다. 받다 만 파일이 캐시에 남았을 때 주로 생깁니다."
            + " 다시 불러오면 대개 해결됩니다. 그래도 안 되면 브라우저 캐시를 비우고 열어보세요.";
        // 홈을 숨긴 채 왔더라도 여기서는 다시 보여준다. 갈 곳이 없으면 갇힌다.
        $("home").hidden = false;
        return;
    }
    // 게스트가 준비됐다는 뜻이다. 여기서 세운다 — 아래 정상 경로에서만 세웠더니
    // 자체 검증은 그 줄에 닿기 전에 끝나서 계속 false 였고, openFree/openCommand 가
    // "아직 부팅 중"으로 보고 그냥 돌아갔다 (검증에서 자유 터미널이 안 열렸다).
    bootDone = true;
    setBar("100%");

    if (BENCH) {
        setStatus(`부팅 ${sec}초`);
        document.title = `BOOT ${sec}s`;
        // performance.now() 는 페이지 진입 시점 기준이라 전체 체감 시간을 그대로 준다.
        // t0 는 디스크를 다 받은 뒤에 잡히므로 부팅만 잰다.
        const totalSec = +(performance.now() / 1000).toFixed(1);
        fetch("/result", {
            method: "POST", body: JSON.stringify({
                bench: true,
                totalSec,                                        // 페이지 열고 프롬프트까지
                diskSec: +(vm.diskMs / 1000).toFixed(1),         // 디스크 받고 풀기
                bootSec: Number(sec),                            // 게스트 부팅
                ua: navigator.userAgent,
            })
        });
        switchToTerminal();
        return;
    }

    // 목록은 위에서 이미 그렸다 (부팅을 기다리지 않는다)
    setFilesVisible(pref.get());
    setSideVisible(sidePref.get());
    setCmdsVisible(cmdsPref.get());

    const screenText = $("screen").querySelector("div").textContent.trimEnd();

    if (SELFTEST) {
        // 터미널을 먼저 붙인다. 안 붙이면 화면 관련 검사가 빈 버퍼를 보고
        // 아무것도 못 잡은 채 통과해버린다 (실제로 그랬다).
        switchToTerminal();
        setStatus(`준비 완료 (${sec}초) · 자체 검증 중...`);
        const passed = await selftest();
        setStatus(`부팅 ${sec}초 · 검증 ${passed}/${results.length} 통과`);
        document.title = `SELFTEST ${passed}/${results.length}`;
        fetch("/result", {
            method: "POST",
            body: JSON.stringify({
                booted: true, bootSec: Number(sec), passed, total: results.length,
                bootScreenTail: screenText.split("\n").slice(-8).join("\n"),
                results,
            }, null, 2),
        });
        return;
    }

    // 탭이 안 보이면 VM 을 멈춘다.
    // v86 은 순수 CPU 에뮬레이션이라, 열어둔 탭마다 게스트가 계속 돌면서
    // 지금 보고 있는 탭까지 같이 느려진다. (탭 3개 띄워놓고 직접 겪었다)
    if (!SELFTEST && !BENCH) {
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                vm.emulator.stop();
            } else {
                vm.emulator.run();
                focusTerm();
            }
        });
    }

    switchToTerminal();
    setStatus(`준비 완료 (${sec}초)`);
    // 준비 상태를 계속 띄워둘 이유가 없다. 자리를 비우고 막대를 진도로 넘긴다.
    $("homeStatus").textContent = "";
    renderHome();

    // 망가져서 다시 불러온 것이면 보던 자리로 되돌린다.
    // 그 새로고침은 사용자가 화면을 옮기려고 누른 게 아니라 되살리려고 누른 것이다.
    const view = resumeView;
    const back = view?.mode === "free" ? () => openFree()
        : view?.mode === "command" ? (() => {
            const c = COMMANDS.find((x) => x.name === view.id);
            return c && (() => openCommand(c));
        })()
        : view?.mode === "problem" ? (() => {
            const p = problems.find((x) => x.id === view.id);
            return p && (() => openProblem(p));
        })()
        : null;

    // 기다리는 동안 눌러둔 것이 있으면 그걸 먼저 연다 (방금 누른 쪽이 최신 의도다).
    // 둘 다 없으면 홈에 남는다 — 예전처럼 마지막 문제를 바로 열지 않는다.
    if (queued) queued.run();
    else if (back) back();
})();
