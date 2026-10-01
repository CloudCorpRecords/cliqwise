import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://clipwise-test:clipwise-test@127.0.0.1:5432/clipwise-test";

const {
  chooseNonOverlapping,
  createNoSpeechCandidate,
  createShortSourceCandidate,
  getClipDurationBounds,
  isVideoPipelineReady,
  LOCAL_MEDIA_PROTOCOL_WHITELIST_ARGS,
  scoreShortTranscript,
  selectCandidatesForProcessing,
  selectClipCandidates,
  scoreTranscript,
  scoreTranscriptSegment,
  withJobAdvisoryLock,
  validateProbe,
  validateCandidate,
} = await import("./video-pipeline.ts");
const { createAssCaptions } = await import("./video-captions.ts");
const { isLocalTranscriptionReady } = await import("./video-transcription-local.ts");

const sampleTimedWords = [
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

  const scored = await scoreShortTranscript(client, sampleTimedWords, 10.005333);

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
  const scored = createShortSourceCandidate(sampleTimedWords, 10.005333, {
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
    selectCandidatesForProcessing(sampleTimedWords, 10.005333, null, [scored], 8),
    [scored],
  );
  assert.throws(
    () => selectCandidatesForProcessing(sampleTimedWords, 10.005333, null, [], 8),
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
    scoreShortTranscript(client, sampleTimedWords, 10.005333),
    /temporarily unavailable/i,
  );
  assert.equal(callCount, 2);
});

test("candidate parsing keeps valid peers, accepts numeric strings, and allows full excerpts over 1000 characters", async () => {
  const words = Array.from({ length: 101 }, (_unused, index) => {
    const start = index * 0.2;
    return {
      text: `authenticword${String(index).padStart(3, "0")}`,
      start,
      end: start + 0.2,
    };
  });
  const excerpt = words.map(({ text }) => text).join(" ");
  assert.ok(excerpt.length > 1_000);
  const validCandidate = {
    startSeconds: "0",
    endSeconds: "20.2",
    excerpt,
    title: "Long but legitimate model title ".repeat(5),
    viralityScore: "75.5",
    hookScore: "70",
    storyScore: "65",
    payoffScore: "80",
    reason: "Evidence-backed overall assessment. ".repeat(80),
    hookReason: "Evidence-backed hook. ".repeat(30),
    storyReason: "Evidence-backed story. ".repeat(30),
    payoffReason: "Evidence-backed payoff. ".repeat(30),
  };
  const invalidPeer = {
    ...validCandidate,
    viralityScore: "not-a-number",
    title: "",
  };
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({ candidates: [invalidPeer, validCandidate] }),
              },
            }],
          };
        },
      },
    },
  };

  const candidates = await scoreTranscriptSegment(
    client,
    words,
    120,
    getClipDurationBounds(120),
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].excerpt, excerpt);
  assert.equal(candidates[0].viralityScore, 75.5);
  assert.equal(candidates[0].title.length, 100);
  assert.equal(candidates[0].reason.length, 1_000);
  assert.equal(candidates[0].hookReason.length, 400);
});

test("invalid candidate diagnostics expose safe field paths and zod codes only", async () => {
  const words = Array.from({ length: 101 }, (_unused, index) => {
    const start = index * 0.2;
    return { text: `spokenword${index}`, start, end: start + 0.2 };
  });
  const invalidCandidate = {
    startSeconds: 0,
    endSeconds: 20.2,
    excerpt: "private transcript text must not appear in diagnostics",
    title: "private model title must not appear in diagnostics",
    viralityScore: 101,
    hookScore: 50,
    storyScore: 50,
    payoffScore: 50,
    reason: "reason",
    hookReason: "hook",
    storyReason: "story",
    payoffReason: "payoff",
  };
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: { content: JSON.stringify({ candidates: [invalidCandidate] }) },
            }],
          };
        },
      },
    },
  };

  await assert.rejects(
    scoreTranscriptSegment(client, words, 120, getClipDurationBounds(120)),
    (error) => {
      assert.match(error.message, /candidates\[0\]\.viralityScore:too_big/);
      assert.doesNotMatch(error.message, /private transcript text|private model title/);
      return true;
    },
  );
});

test("a malformed scoring segment does not discard valid candidates from peer segments", async () => {
  const words = Array.from({ length: 240 }, (_unused, index) => {
    const start = index * 0.3;
    const text = `transcriptword${String(index).padStart(4, "0")}`.repeat(5);
    return { text, start, end: start + 0.22 };
  });
  let callCount = 0;
  const client = {
    chat: {
      completions: {
        async create({ messages }) {
          callCount += 1;
          const userMessage = messages.find(({ role }) => role === "user").content;
          const transcript = userMessage.split("Timestamped transcript:\n")[1];
          const lines = transcript.split("\n");
          const parsedWords = lines.map((line) => {
            const match = line.match(/^([\d.]+)-([\d.]+) (.*)$/);
            assert.ok(match);
            return { start: Number(match[1]), end: Number(match[2]), text: match[3] };
          });
          if (parsedWords[0].start === 0) {
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    candidates: [{
                      startSeconds: "invalid",
                      endSeconds: 20,
                      excerpt: "malformed candidate",
                    }],
                  }),
                },
              }],
            };
          }
          const first = parsedWords[0];
          const last = parsedWords.at(-1);
          const candidate = {
            startSeconds: first.start,
            endSeconds: last.end,
            excerpt: parsedWords.map(({ text }) => text).join(" "),
            title: "Verified segment",
            viralityScore: 75,
            hookScore: 70,
            storyScore: 65,
            payoffScore: 80,
            reason: "The transcript supports this assessment.",
            hookReason: "The segment begins with a hook.",
            storyReason: "The segment tells a coherent story.",
            payoffReason: "The segment has a clear payoff.",
          };
          return {
            choices: [{
              message: { content: JSON.stringify({ candidates: [candidate] }) },
            }],
          };
        },
      },
    },
  };

  const candidates = await scoreTranscript(words, 120, client);

  assert.ok(callCount >= 3);
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(({ startSeconds }) => startSeconds > 0));
});

test("local media input protocol allowlist permits files and pipes only", () => {
  assert.deepEqual(LOCAL_MEDIA_PROTOCOL_WHITELIST_ARGS, [
    "-protocol_whitelist",
    "file,pipe",
  ]);
});

test("video readiness requires configured local scoring and storage prerequisites", () => {
  const previous = {
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseUrl: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    storage: process.env.PRIVATE_OBJECT_DIR,
  };
  try {
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    delete process.env.PRIVATE_OBJECT_DIR;
    assert.equal(isVideoPipelineReady(), false);
  } finally {
    if (previous.apiKey === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    else process.env.AI_INTEGRATIONS_OPENAI_API_KEY = previous.apiKey;
    if (previous.baseUrl === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    else process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = previous.baseUrl;
    if (previous.storage === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = previous.storage;
  }
});

test("video readiness reflects local model files without issuing provider requests", () => {
  const previous = {
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseUrl: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    storage: process.env.PRIVATE_OBJECT_DIR,
  };
  try {
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-key";
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://localhost.invalid/v1";
    process.env.PRIVATE_OBJECT_DIR = "/tmp/clipwise-test-objects";
    assert.equal(isVideoPipelineReady(), isLocalTranscriptionReady());
  } finally {
    if (previous.apiKey === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    else process.env.AI_INTEGRATIONS_OPENAI_API_KEY = previous.apiKey;
    if (previous.baseUrl === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    else process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = previous.baseUrl;
    if (previous.storage === undefined) delete process.env.PRIVATE_OBJECT_DIR;
    else process.env.PRIVATE_OBJECT_DIR = previous.storage;
  }
});

test("a timed 10-second transcript can validate as a playable clip", () => {
  const duration = 10.005333;
  const bounds = getClipDurationBounds(duration);
  const accepted = validateCandidate(
    candidate(0.14, 9.5, 75, sampleTranscript),
    sampleTimedWords,
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
    sampleTimedWords.slice(0, 7),
    0,
    10.005333,
    10.005333,
    bounds,
  );

  assert.equal(accepted, null);
});

test("candidate validation rejects invented ranges, invalid scores, and missing evidence", () => {
  const duration = 10.005333;
  const bounds = getClipDurationBounds(duration);
  const validCandidate = candidate(0.14, 9.5, 75, sampleTranscript);
  const validate = (value) =>
    validateCandidate(value, sampleTimedWords, 0, duration, duration, bounds);

  assert.equal(validate({ ...validCandidate, startSeconds: -1 }), null);
  assert.equal(validate({ ...validCandidate, endSeconds: duration + 1 }), null);
  assert.equal(validate({ ...validCandidate, viralityScore: 101 }), null);
  assert.equal(validate({ ...validCandidate, title: "  " }), null);
  assert.equal(validate({ ...validCandidate, hookReason: "" }), null);
  assert.ok(validate(validCandidate));
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

test("a successful empty transcript yields one unscored source clip, capped at 90 seconds", () => {
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