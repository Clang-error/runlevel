// 풀이 기록 수집 + 문제별 성공률 제공.
//
// runlevel.cc/api/* 로 라우팅된다. 사이트와 같은 오리진이라 CORS 가 필요 없다.
//
//   POST /api/attempt   문제를 떠날 때 결말을 하나 남긴다
//   POST /api/report    사용자가 직접 보내는 신고 (본인이 쓴 글 + 선택한 터미널 기록)
//   GET  /api/stats     문제별 집계. 개별 기록은 절대 내보내지 않는다
//
// 원본 행을 읽는 창구는 없다. 그건 wrangler d1 execute 로만 본다.

const MAX_BODY = 64 * 1024;    // 문제당 4KB 안쪽이 정상. 그 16배까지만 받는다
const MAX_CMDS = 200;
const MAX_CMD_LEN = 300;
const MAX_ID_LEN = 40;
const MAX_MESSAGE = 2000;      // 신고 본문
const MAX_LOG = 20 * 1024;     // 터미널 기록. 클라이언트도 같은 값으로 자른다
const KINDS = new Set(["problem", "command", "free", "home"]);
const OUTCOMES = new Set(["solved", "left", "closed"]);

// 표본이 적으면 성공률이 요동친다. 1명이 실패하면 0%, 1명이 풀면 100% 다.
// 그런 숫자는 정보가 아니라 소음이라 아예 내보내지 않는다.
const MIN_SAMPLE = 5;

const clampInt = (v, max) => {
    const n = Number.isFinite(v) ? Math.trunc(v) : 0;
    return Math.min(Math.max(n, 0), max);
};

// 들어온 것을 그대로 믿지 않는다. 형태가 안 맞으면 조용히 버리는 게 아니라 거절한다.
function parse(body) {
    if (typeof body?.problem_id !== "string") return null;
    const problemId = body.problem_id.slice(0, MAX_ID_LEN);
    // 실제 문제 id 는 전부 "영문-숫자2" 꼴이다 (file-01, grep-04 …).
    // [\w-]+ 로 열어두면 아무 문자열이나 행으로 들어와 통계를 오염시킨다.
    // 숫자 3자리까지 받아 문제가 100개를 넘겨도 서버를 다시 안 고치게 해둔다.
    if (!/^[a-z]+-\d{2,3}$/.test(problemId)) return null;
    if (!OUTCOMES.has(body.outcome)) return null;
    if (!Array.isArray(body.commands)) return null;

    const commands = body.commands
        .filter((c) => typeof c === "string")
        .slice(0, MAX_CMDS)
        .map((c) => c.slice(0, MAX_CMD_LEN));

    return {
        problemId,
        outcome: body.outcome,
        commands: JSON.stringify(commands),
        elapsedMs: clampInt(body.elapsed_ms, 24 * 60 * 60 * 1000),
        hintsUsed: clampInt(body.hints_used, 20),
        sawSolution: body.saw_solution ? 1 : 0,
        goalsPassed: clampInt(body.goals_passed, 100),
        goalsTotal: clampInt(body.goals_total, 100),
    };
}

async function collect(request, env) {
    // content-length 만 보고 자르면 안 된다. 헤더를 빼고 청크로 보내면
    // 그 검사가 통째로 지나가고, 그 뒤로는 몸통을 끝까지 읽게 된다.
    // 실제로 읽은 길이로 다시 자른다.
    const len = Number(request.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) return new Response("Too large", { status: 413 });

    let row;
    try {
        const text = await request.text();
        if (text.length > MAX_BODY) return new Response("Too large", { status: 413 });
        row = parse(JSON.parse(text));
    } catch {
        return new Response("Bad JSON", { status: 400 });
    }
    if (!row) return new Response("Bad shape", { status: 400 });

    try {
        await env.runlevel_stats
            .prepare(
                `INSERT INTO attempts
                    (at, problem_id, outcome, commands, elapsed_ms, hints_used,
                     saw_solution, goals_passed, goals_total)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(new Date().toISOString(), row.problemId, row.outcome, row.commands,
                  row.elapsedMs, row.hintsUsed, row.sawSolution,
                  row.goalsPassed, row.goalsTotal)
            .run();
    } catch {
        // 수집이 실패해도 사용자의 연습은 아무 영향이 없어야 한다.
        return new Response("Insert failed", { status: 500 });
    }
    return new Response(null, { status: 204 });
}

// 사용자가 직접 보내는 신고.
//
// attempts 와 달리 사람이 쓴 글이 들어온다. 그대로 믿지 않는다 —
// 길이를 자르고, 종류는 화이트리스트로 받고, SQL 은 파라미터로 바인딩한다.
// 읽는 창구는 여기 없다. 원본은 wrangler d1 execute 로만 본다.
async function report(request, env) {
    let body;
    try {
        const text = await request.text();
        if (text.length > MAX_BODY) return new Response("Too large", { status: 413 });
        body = JSON.parse(text);
    } catch {
        return new Response("Bad JSON", { status: 400 });
    }

    const kind = KINDS.has(body?.kind) ? body.kind : null;
    const message = typeof body?.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
    if (!kind || !message) return new Response("Bad shape", { status: 400 });

    const target = typeof body?.target === "string" ? body.target.slice(0, MAX_ID_LEN) : "";
    const log = typeof body?.log === "string" ? body.log.slice(-MAX_LOG) : "";

    try {
        await env.runlevel_stats
            .prepare("INSERT INTO reports (at, kind, target, message, log) VALUES (?, ?, ?, ?, ?)")
            .bind(new Date().toISOString(), kind, target, message, log)
            .run();
    } catch {
        return new Response("Insert failed", { status: 500 });
    }
    return new Response(null, { status: 204 });
}

// 문제별 도전 수와 성공 수만 내보낸다. 명령어나 시각 같은 개별 정보는 나가지 않는다.
async function stats(env) {
    const { results } = await env.runlevel_stats
        .prepare(
            `SELECT problem_id,
                    COUNT(*) AS tries,
                    SUM(CASE WHEN outcome = 'solved' THEN 1 ELSE 0 END) AS solved
             FROM attempts GROUP BY problem_id HAVING tries >= ?`)
        .bind(MIN_SAMPLE)
        .all();

    const out = {};
    for (const r of results) out[r.problem_id] = { tries: r.tries, solved: r.solved };

    return new Response(JSON.stringify(out), {
        headers: {
            "content-type": "application/json",
            // 매 방문마다 D1 을 때릴 이유가 없다. 5분 늦게 반영돼도 아무 문제 없는 값이다.
            "cache-control": "public, max-age=300",
        },
    });
}

export default {
    async fetch(request, env) {
        const { pathname } = new URL(request.url);

        if (pathname === "/api/attempt") {
            if (request.method !== "POST") {
                return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
            }
            return collect(request, env);
        }

        if (pathname === "/api/report") {
            if (request.method !== "POST") {
                return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
            }
            return report(request, env);
        }

        if (pathname === "/api/stats") {
            if (request.method !== "GET") {
                return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
            }
            try {
                return await stats(env);
            } catch {
                return new Response("{}", {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
        }

        return new Response("Not found", { status: 404 });
    },
};
