import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://clipwise-test:clipwise-test@127.0.0.1:5432/clipwise-test";

const {
  chooseNonOverlapping,
  createNoSpeechCandidate,
  createShortSourceCandidate,
  classifyScribeErrorPayload,
  getClipDurationBounds,
  LOCAL_MEDIA_PROTOCOL_WHITELIST_ARGS,
  scoreShortTranscript,
  selectCandidatesForProcessing,
  selectClipCandidates,
  extractTimedScribeWords,
  formatScribeFailureForUser,
  transcribeScribeChunk,
  transcribeScribeWords,
  withJobAdvisoryLock,
  validateProbe,
  validateCandidate,
} = await import("./video-pipeline.ts");
const { createAssCaptions } = await import("./video-captions.ts");

const sampleScribeWords = [
  { text: "Underneath", start: 0.14, end: 0.7 },
  { text: "the", start: 0.74, end: 0.84 },
  { text: "city", start: 0.92, end: 1.2 },
  { text: "lights,", start: 1.32, end: 1.6 },
  { text: "we", start: 1.68, end: 1.82 },
  { text: "come", start: 1.88, end: 2.1 },
  { text: "alive.", start: 2.16, end: 2.9 },
  { text: "We", start: 3.3, end: 3.44 },
  { text: "are", start: 3.5, end: 3.62 },
  { text: "shining", start: 3.7, end: 4.16 },
  { text: "like", start: 4.22, end: 4.44 },
  { text: "the", start: 4.5, end: 4.56 },
  { text: "sun.", start: 4.72, end: 5.18 },
  { text: "Let", start: 5.8, end: 5.9 },
  { text: "me", start: 5.94, end: 6.04 },
  { text: "hear", start: 6.1, end: 6.28 },
  { text: "you", start: 6.32, end: 6.42 },
  { text: "outside,", start: 6.48, end: 6.94 },
  { text: "Lans.", start: 7, end: 7.48 },
  { text: "Yeah,", start: 7.92, end: 8.18 },
  { text: "we", start: 8.32, end: 8.48 },
  { text: "are", start: 8.58, end: 8.96 },
  { text: "the", start: 9.04, end: 9.18 },
  { text: "free", start: 9.24, end: 9.5 },
];

const sampleTranscript =
  "Underneath the city lights, we come alive. We are shining like the sun. Let me hear you outside, Lans. Yeah, we are the free";

function candidate(
  startSeconds,
  endSeconds,
  viralityScore,
  excerpt = "verbatim transcript",
) {
  return {
    startSeconds,
    endSeconds,
    excerpt,
    title: "Verified moment",
    viralityScore,
    hookScore: 50,
    storyScore: 50,
    payoffScore: 50,
    reason: "Evidence-based assessment",
    hookReason: "The spoken words establish a hook.",
    storyReason: "The spoken words form a coherent thought.",
    payoffReason: "The spoken words complete the thought.",
  };
}

test("short sources receive a duration-aware scoring window", () => {
  assert.deepEqual(getClipDurationBounds(10.005333), {
    minimumSeconds: 5.0026665,
    maximumSeconds: 10.005333,
  });
});

test("short-source AI assessment is one full-source clip with transcript-derived text and timing", async () => {
  const assessment = {
    title: "City Lights",
    viralityScore: 14,
    hookScore: 8,
    storyScore: 11,
    payoffScore: 7,
    reason: "The passage is melodic but has limited narrative development.",
    hookReason: "It begins mid-thought.",
    storyReason: "The lyrics offer little story context.",
    payoffReason: "The excerpt does not reach a clear resolution.",
  };
  let callCount = 0;
  let request;
  const client = {
    chat: {
      completions: {
        async create(options) {
          callCount += 1;
          request = options;
          return {
            choices: [{ message: { content: JSON.stringify({ assessment }) } }],
          };
        },
      },
    },
  };

  const scored = await scoreShortTranscript(client, sampleScribeWords, 10.005333);

  assert.equal(callCount, 1);
  assert.deepEqual(
    [scored.startSeconds, scored.endSeconds, scored.excerpt],
    [0, 10.005333, sampleTranscript],
  );
  assert.equal(scored.viralityScore, assessment.viralityScore);
  assert.equal(scored.hookScore, assessment.hookScore);
  assert.equal(scored.storyScore, assessment.storyScore);
  assert.equal(scored.payoffScore, assessment.payoffScore);
  assert.equal(scored.title, assessment.title);
  assert.equal(scored.reason, assessment.reason);
  assert.match(request.messages[0].content, /ONE clip/);
  assert.match(request.messages[1].content, /Underneath/);
  assert.match(request.messages[1].content, /9\.24-9\.50 free/);
  assert.doesNotMatch(request.messages[0].content, /20–90|up to 3 compelling/);
});

test("short sources bypass selective candidate filtering and do not silently empty-fallback", () => {
  const scored = createShortSourceCandidate(sampleScribeWords, 10.005333, {
    title: "City Lights",
    viralityScore: 14,
    hookScore: 8,
    storyScore: 11,
    payoffScore: 7,
    reason: "The passage has limited narrative development.",
    hookReason: "It begins mid-thought.",
    storyReason: "It offers little story context.",
    payoffReason: "It has no clear resolution.",
  });
  assert.deepEqual(
    selectCandidatesForProcessing(sampleScribeWords, 10.005333, null, [scored], 8),
    [scored],
  );
  assert.throws(
    () => selectCandidatesForProcessing(sampleScribeWords, 10.005333, null, [], 8),
    /did not return an assessment/i,
  );
  assert.throws(
    () =>
      createShortSourceCandidate([], 10.005333, {
        title: "Invented",
        viralityScore: 0,
        hookScore: 0,
        storyScore: 0,
        payoffScore: 0,
        reason: "No speech.",
        hookReason: "No speech.",
        storyReason: "No speech.",
        payoffReason: "No speech.",
      }),
    /actual timed transcript words/i,
  );
});

test("short-source scoring retries at most once", async () => {
  let callCount = 0;
  const client = {
    chat: {
      completions: {
        async create() {
          callCount += 1;
          throw new Error("temporary scoring error");
        },
      },
    },
  };

  await assert.rejects(
    scoreShortTranscript(client, sampleScribeWords, 10.005333),
    /temporarily unavailable/i,
  );
  assert.equal(callCount, 2);
});

test("local media input protocol allowlist permits files and pipes only", () => {
  assert.deepEqual(LOCAL_MEDIA_PROTOCOL_WHITELIST_ARGS, [
    "-protocol_whitelist",
    "file,pipe",
  ]);
});

test("Scribe request timeout aborts a hung proxy fetch", async () => {
  let wasAborted = false;
  const proxyFetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          wasAborted = true;
          reject(init.signal.reason);
        },
        { once: true },
      );
    });

  await assert.rejects(
    transcribeScribeChunk(Buffer.from("audio"), proxyFetch, 15),
    /Scribe transcription exceeded its request deadline/i,
  );
  assert.equal(wasAborted, true);
});

test("Scribe request deadline includes a stalled response body", async () => {
  let wasAborted = false;
  const proxyFetch = async (_url, init) => ({
    ok: true,
    status: 200,
    json() {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            wasAborted = true;
            reject(init.signal.reason);
          },
          { once: true },
        );
      });
    },
  });

  await assert.rejects(
    transcribeScribeChunk(Buffer.from("audio"), proxyFetch, 15),
    /Scribe transcription exceeded its request deadline/i,
  );
  assert.equal(wasAborted, true);
});

test("Scribe retries transient provider status once and accepts real timed words", async () => {
  let callCount = 0;
  const proxyFetch = async () => {
    callCount += 1;
    if (callCount === 1) return new Response("", { status: 503 });
    return new Response(
      JSON.stringify({
        words: [
          { text: "spoken", start: 0.25, end: 0.7, type: "word" },
          { text: " ", start: null, end: null, type: "spacing" },
          { text: "laughing", start: null, end: null, type: "audio_event" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const failures = [];

  const words = await transcribeScribeWords(
    Buffer.from("audio"),
    proxyFetch,
    1_000,
    (failure) => failures.push({
      category: failure.scribeCategory,
      status: failure.status,
    }),
  );

  assert.equal(callCount, 2);
  assert.deepEqual(failures, [{ category: "http_status", status: 503 }]);
  assert.deepEqual(words, [{ text: "spoken", start: 0.25, end: 0.7 }]);
});

test("Scribe access errors retain only safe status/category diagnostics and are not retried", async () => {
  let callCount = 0;
  const failures = [];
  const proxyFetch = async () => {
    callCount += 1;
    return new Response(
      JSON.stringify({
        detail: {
          status: "invalid_api_key",
          message: "provider raw text must not be exposed",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  };
  let finalFailure;

  await assert.rejects(
    transcribeScribeWords(Buffer.from("audio"), proxyFetch, 1_000, (failure) => {
      failures.push({
        category: failure.scribeCategory,
        status: failure.status,
        diagnosticCategory: failure.diagnosticCategory,
      });
    }),
    (error) => {
      finalFailure = error;
      return error.scribeCategory === "http_status" && error.status === 401;
    },
  );
  assert.equal(callCount, 1);
  assert.deepEqual(failures, [{
    category: "http_status",
    status: 401,
    diagnosticCategory: "provider_invalid_api_key",
  }]);
  const safeMessage = formatScribeFailureForUser(finalFailure);
  assert.match(safeMessage, /invalid_api_key/i);
  assert.doesNotMatch(safeMessage, /provider raw text must not be exposed/i);
});

test("safe Scribe error classification distinguishes provider and proxy auth failures", () => {
  assert.equal(
    classifyScribeErrorPayload(
      { detail: { status: "missing_permissions", message: "omitted" } },
      401,
    ),
    "provider_missing_permissions",
  );
  assert.equal(
    classifyScribeErrorPayload(
      { error: { code: "quota_exceeded", message: "omitted" } },
      401,
    ),
    "provider_quota",
  );
  assert.equal(
    classifyScribeErrorPayload(
      { error: "Replit identity token is invalid" },
      401,
    ),
    "proxy_identity_unauthorized",
  );
  assert.equal(classifyScribeErrorPayload({ error: "unauthorized" }, 401), "unauthorized_unknown");
  assert.equal(
    classifyScribeErrorPayload(
      { detail: { status: "free_tier_disabled", message: "restricted" } },
      401,
    ),
    "provider_free_tier_disabled",
  );
  assert.equal(
    classifyScribeErrorPayload(
      { detail: { status: "free_tier_contention", message: "restricted" } },
      401,
    ),
    "provider_activity_restriction",
  );
  assert.equal(
    classifyScribeErrorPayload(
      { detail: { status: "insufficient_credits", message: "omitted" } },
      401,
    ),
    "provider_insufficient_credits",
  );
});

test("quota_exceeded wording does not claim overall usage is exhausted or direct a purchase", () => {
  const message = formatScribeFailureForUser({
    scribeCategory: "http_status",
    status: 401,
    diagnosticCategory: "provider_quota",
    providerCode: "quota_exceeded",
    retryable: false,
  });
  assert.match(message, /Scribe-specific or free-tier limits/i);
  assert.match(message, /does not prove the overall account quota is exhausted/i);
  assert.match(message, /before changing plans or buying credits/i);
});

test("a safe free-tier error code produces a restriction message, not a quota claim", async () => {
  const proxyFetch = async () =>
    new Response(
      JSON.stringify({
        detail: {
          status: "free_tier_disabled",
          message: "private provider wording is intentionally omitted",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  let failure;

  await assert.rejects(
    transcribeScribeWords(Buffer.from("audio"), proxyFetch, 1_000),
    (error) => {
      failure = error;
      return error.providerCode === "free_tier_disabled";
    },
  );
  const safeMessage = formatScribeFailureForUser(failure);
  assert.match(safeMessage, /free-tier account/i);
  assert.match(safeMessage, /not a usage-quota diagnosis/i);
  assert.doesNotMatch(safeMessage, /private provider wording/i);
});

test("Scribe ignores untimed non-word events but retries malformed speech timestamps", () => {
  assert.deepEqual(
    extractTimedScribeWords({
      words: [
        { text: " ", type: "spacing", start: null, end: null },
        { text: "laughing", type: "audio_event" },
      ],
    }),
    [],
  );
  assert.throws(
    () =>
      extractTimedScribeWords({
        words: [{ text: "spoken", type: "word", start: null, end: null }],
      }),
    /valid timestamps/i,
  );
});

test("an authentic 10-second Scribe transcript can validate as a playable clip", () => {
  const duration = 10.005333;
  const bounds = getClipDurationBounds(duration);
  const accepted = validateCandidate(
    candidate(0.14, 9.5, 75, sampleTranscript),
    sampleScribeWords,
    0,
    duration,
    duration,
    bounds,
  );

  assert.ok(accepted);
  assert.equal(accepted.startSeconds, 0.14);
  assert.equal(accepted.endSeconds, 9.5);
  assert.equal(accepted.excerpt, sampleTranscript);
});

test("short speech excerpts below the meaningful duration bound are rejected", () => {
  const bounds = getClipDurationBounds(10.005333);
  const accepted = validateCandidate(
    candidate(
      0.14,
      2.9,
      75,
      "Underneath the city lights, we come alive.",
    ),
    sampleScribeWords.slice(0, 7),
    0,
    10.005333,
    10.005333,
    bounds,
  );

  assert.equal(accepted, null);
});

test("sources long enough for ordinary clips retain the 20–90 second limits", () => {
  assert.deepEqual(getClipDurationBounds(120), {
    minimumSeconds: 20,
    maximumSeconds: 90,
  });
});

test("requested clip count is a maximum and overlapping moments are not duplicated", () => {
  const selected = chooseNonOverlapping(
    [
      candidate(0, 8, 95),
      candidate(2, 7, 90),
      candidate(9, 15, 80),
    ],
    8,
  );

  assert.deepEqual(
    selected.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]),
    [
      [0, 8],
      [9, 15],
    ],
  );
});

test("a successful empty Scribe result yields one unscored source clip, capped at 90 seconds", () => {
  const shortFallback = selectClipCandidates([], 10.005333, "Source title", [], 8);
  assert.equal(shortFallback.length, 1);
  assert.deepEqual(
    {
      startSeconds: shortFallback[0].startSeconds,
      endSeconds: shortFallback[0].endSeconds,
      title: shortFallback[0].title,
      excerpt: shortFallback[0].excerpt,
      viralityScore: shortFallback[0].viralityScore,
      hookScore: shortFallback[0].hookScore,
      storyScore: shortFallback[0].storyScore,
      payoffScore: shortFallback[0].payoffScore,
      reason: shortFallback[0].reason,
      hookReason: shortFallback[0].hookReason,
      storyReason: shortFallback[0].storyReason,
      payoffReason: shortFallback[0].payoffReason,
    },
    {
      startSeconds: 0,
      endSeconds: 10.005333,
      title: "Source title",
      excerpt: "",
      viralityScore: null,
      hookScore: null,
      storyScore: null,
      payoffScore: null,
      reason: null,
      hookReason: null,
      storyReason: null,
      payoffReason: null,
    },
  );
  assert.equal(createNoSpeechCandidate(120, null).endSeconds, 90);
});

test("transcribed speech with no actual scored moments does not receive an unscored fallback", () => {
  assert.deepEqual(
    selectClipCandidates(
      [{ text: "real", start: 0, end: 1 }],
      10,
      "Source title",
      [],
      4,
    ),
    [],
  );
});

test("no-speech captions are an empty ASS event list, not invented text", () => {
  const ass = createAssCaptions([], "bold", 10.005333);
  assert.match(ass, /\[Events\]/);
  assert.doesNotMatch(ass, /^Dialogue:/m);
});

test("sources without an audio stream remain rejected", () => {
  assert.throws(
    () =>
      validateProbe({
        duration: 10,
        hasVideo: true,
        hasAudio: false,
        width: 1280,
        height: 720,
      }),
    /does not contain an audio track/i,
  );
});

test("preparation and recovery leases release the per-job advisory lock after work", async () => {
  const events = [];
  const client = {
    async query(sql, values) {
      events.push(sql.includes("pg_try_advisory_lock") ? "lock" : "unlock");
      assert.deepEqual(values, ["queued-job"]);
      return {
        rows: [{ locked: true }],
        rowCount: 1,
      };
    },
    release() {},
  };

  const lease = await withJobAdvisoryLock(client, "queued-job", async () => {
    events.push("work");
    return "complete";
  });

  assert.deepEqual(lease, { acquired: true, result: "complete" });
  assert.deepEqual(events, ["lock", "work", "unlock"]);
});

test("recovery skips a live preparation when its advisory lease is held", async () => {
  let operationRan = false;
  let queryCount = 0;
  const client = {
    async query(sql, values) {
      queryCount += 1;
      assert.match(sql, /pg_try_advisory_lock/);
      assert.deepEqual(values, ["live-preparation"]);
      return { rows: [{ locked: false }], rowCount: 1 };
    },
    release() {},
  };

  const lease = await withJobAdvisoryLock(client, "live-preparation", async () => {
    operationRan = true;
  });

  assert.deepEqual(lease, { acquired: false });
  assert.equal(operationRan, false);
  assert.equal(queryCount, 1);
});

test("an exception during preparation still releases its advisory lease", async () => {
  const events = [];
  const client = {
    async query(sql) {
      events.push(sql.includes("pg_try_advisory_lock") ? "lock" : "unlock");
      return { rows: [{ locked: true }], rowCount: 1 };
    },
    release() {},
  };

  await assert.rejects(
    withJobAdvisoryLock(client, "failed-preparation", async () => {
      events.push("work");
      throw new Error("probe failed");
    }),
    /probe failed/,
  );
  assert.deepEqual(events, ["lock", "work", "unlock"]);
});

test("an invalid source duration is not converted into a fabricated clip window", () => {
  assert.throws(() => getClipDurationBounds(0), /invalid duration/i);
  assert.throws(() => getClipDurationBounds(Number.NaN), /invalid duration/i);
});