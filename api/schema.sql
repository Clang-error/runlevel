-- 문제 개선용 풀이 기록.
--
-- 신원은 아무것도 담지 않는다. IP, 계정, 세션 식별자 전부 없다.
-- 알고 싶은 것은 "사람들이 어떻게 푸는가"이지 "누가 풀었는가"가 아니다.
-- 담을 게 없으면 유출될 것도 없다.
--
-- 통과한 것만 기록하면 성공률의 분모가 없다. 그래서 문제를 떠날 때마다
-- 결말을 하나씩 남긴다. "실패"를 여기서 정의하지 않는 것이 중요하다 —
-- 정의를 박아넣으면 나중에 기준을 바꿀 때 과거 데이터가 죽는다.
-- 사실만 남기고 실패는 질의할 때 정의한다.

CREATE TABLE IF NOT EXISTS attempts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT    NOT NULL,   -- 서버가 찍는 ISO 시각 (클라이언트 시계를 믿지 않는다)
    problem_id   TEXT    NOT NULL,

    -- solved | left(안 푼 채 다른 문제로) | closed(탭을 닫음)
    outcome      TEXT    NOT NULL,

    commands     TEXT    NOT NULL,   -- JSON 배열. 실제로 친 명령들
    elapsed_ms   INTEGER NOT NULL,   -- 문제를 연 뒤 떠날 때까지
    hints_used   INTEGER NOT NULL,   -- 몇 번째 힌트까지 봤나
    saw_solution INTEGER NOT NULL,   -- 정답을 봤나. 사용자가 스스로 드러낸 포기 신호

    -- 부분 진척. 3개 중 2개까지 간 실패와 0개인 실패는 의미가 정반대다.
    goals_passed INTEGER NOT NULL,
    goals_total  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS attempts_problem ON attempts(problem_id);

-- 사용자가 직접 보내는 신고.
--
-- attempts 는 "어디서 막혔는가"까지만 안다. 사람이 무엇을 이상하다고 느꼈는지는
-- 본인이 말해줘야 알 수 있어서 따로 받는다.
--
-- log 는 터미널에 찍힌 내용이다. 신고자가 켜고 끌 수 있고, 없으면 대부분의 신고를
-- 재현할 수 없다. 여기도 신원은 안 담는다 — 무엇을 쳤고 무엇이 나왔는지만 있다.
CREATE TABLE IF NOT EXISTS reports (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,   -- 서버가 찍는 ISO 시각
    kind    TEXT NOT NULL,   -- problem | command | free | home
    target  TEXT NOT NULL,   -- 문제 id, 명령어 이름, 또는 빈 문자열
    message TEXT NOT NULL,   -- 사용자가 쓴 내용
    log     TEXT NOT NULL    -- 터미널 기록 (안 보냈으면 빈 문자열)
);

CREATE INDEX IF NOT EXISTS reports_at ON reports(at);
