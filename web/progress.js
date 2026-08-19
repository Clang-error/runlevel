// 진도 저장. localStorage 만 쓴다 — 서버도 계정도 필요 없다.
//
// 기기 간 동기화는 안 되지만 "이어가기"의 대부분은 이걸로 해결된다.
// 계정 연동은 정말로 기기를 넘나들어야 할 때 붙이면 되고,
// 그때도 이 모듈의 모양(solved 집합 + 마지막 문제)만 서버로 옮기면 된다.

const KEY = "dotslash.progress.v1";

function read() {
    try {
        const raw = localStorage.getItem(KEY);
        const v = raw ? JSON.parse(raw) : null;
        if (v && typeof v === "object" && v.solved) return v;
    } catch {
        // 손상됐거나 저장소를 못 쓰는 상황(사생활 보호 모드 등)
    }
    return { solved: {}, last: null, logs: {} };
}

// 한 문제에 남길 명령 수와 한 줄 길이의 상한.
// 무한히 쌓이면 localStorage 할당량(보통 5MB)을 조용히 넘겨 저장 자체가 실패한다.
const MAX_CMDS = 200;
const MAX_LEN = 300;

function write(state) {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        // 저장 실패해도 연습 자체는 계속돼야 한다
    }
}

export function createProgress({ enabled = true } = {}) {
    // 자체 검증은 모든 문제를 풀어버리므로 진도를 건드리면 안 된다
    let state = enabled ? read() : { solved: {}, last: null, logs: {} };
    state.logs ??= {};      // 이 기능이 생기기 전에 저장된 진도에는 logs 가 없다

    return {
        isSolved: (id) => !!state.solved[id],
        solvedCount: () => Object.keys(state.solved).length,
        last: () => state.last,
        log: (id) => state.logs[id] ?? null,

        markSolved(id) {
            if (state.solved[id]) return false;          // 이미 기록됨
            state.solved[id] = { at: new Date().toISOString() };
            if (enabled) write(state);
            return true;
        },
        setLast(id) {
            state.last = id;
            if (enabled) write(state);
        },

        // 푼 순간의 명령 기록을 남긴다. 다시 풀면 최신 것으로 덮어쓴다 —
        // 두 번째 풀이가 대개 더 깔끔하고, 그게 다시 보고 싶은 쪽이다.
        saveLog(id, cmds) {
            if (!cmds?.length) return;
            state.logs[id] = cmds.slice(-MAX_CMDS).map((c) => c.slice(0, MAX_LEN));
            if (enabled) write(state);
        },

        reset() {
            state = { solved: {}, last: null, logs: {} };
            if (enabled) write(state);
        },

        // 이어서 풀 문제를 고른다.
        // 마지막에 보던 문제가 아직 안 풀렸으면 거기서 이어가고,
        // 풀었으면 그 다음의 안 푼 문제로 넘어간다.
        pick(problems) {
            if (!problems.length) return null;
            const lastIdx = problems.findIndex((p) => p.id === state.last);
            if (lastIdx >= 0 && !state.solved[problems[lastIdx].id]) return problems[lastIdx];
            const from = lastIdx >= 0 ? lastIdx + 1 : 0;
            return problems.slice(from).find((p) => !state.solved[p.id])
                ?? problems.find((p) => !state.solved[p.id])
                ?? problems[lastIdx >= 0 ? lastIdx : 0];
        },
    };
}
