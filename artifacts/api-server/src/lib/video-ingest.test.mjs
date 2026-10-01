import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import {
  createPinnedLookup,
  downloadPublicVideo,
  isGlobalAddress,
  resolveSafeAddress,
} from "./video-ingest-network.ts";
import {
  isAllowedYoutubeEgressHost,
  parseYoutubeConnectTarget,
  parseSupportedYoutubeUrl,
} from "./youtube-url.ts";
import {
  classifyYtDlpFailure,
  friendlyYtDlpFailure,
} from "./youtube-diagnostics.ts";
import { snapshotVideoUploadStream } from "./video-upload-snapshot.ts";
import {
  YOUTUBE_DOWNLOADER,
  YOUTUBE_FORMAT_SELECTOR,
  YOUTUBE_JS_RUNTIME,
  YOUTUBE_MERGE_OUTPUT_FORMAT,
} from "./youtube-download-policy.ts";

test("pinned lookup returns the all-addresses callback shape required by Node 24", async () => {
  const resolved = { address: "93.184.216.34", family: 4 };
  const lookup = createPinnedLookup(resolved);

  const allResult = await new Promise((resolve, reject) => {
    lookup("video.example", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.deepEqual(allResult, [resolved]);

  const singleResult = await new Promise((resolve, reject) => {
    lookup("video.example", { all: false }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(singleResult, resolved);
});

test("public address validation rejects private, loopback, link-local, mapped and reserved IPs", async () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
  ]) {
    assert.equal(isGlobalAddress(address), false, `${address} must not be public`);
    await assert.rejects(resolveSafeAddress(address), /Private and non-global/);
  }
  assert.equal(isGlobalAddress("93.184.216.34"), true);
  assert.equal(isGlobalAddress("2606:4700:4700::1111"), true);
});

test("DNS resolution rejects private answers even when a hostname also has public addresses", async () => {
  await assert.rejects(
    resolveSafeAddress("cdn.googlevideo.com", async () => [
      { address: "142.250.72.14", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ]),
    /Private and non-global/,
  );
  await assert.rejects(
    resolveSafeAddress("cdn.googlevideo.com", async () => [
      { address: "169.254.169.254", family: 4 },
    ]),
    /Private and non-global/,
  );
});

test("redirect targets are resolved and rejected before a second request can be made", async () => {
  let requests = 0;
  const workDir = await mkdtemp(join(tmpdir(), "clipwise-ingest-test-"));
  try {
    await assert.rejects(
      downloadPublicVideo("https://video.example/start", join(workDir, "video"), {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async () => {
          requests += 1;
          return Object.assign(Readable.from([]), {
            statusCode: 302,
            headers: { location: "http://127.0.0.1/latest/meta-data/" },
            resume() {},
          });
        },
      }),
      /Private and non-global/,
    );
    assert.equal(requests, 1, "the private redirect must never be requested");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("direct public-file downloads preserve data and revalidate public redirects", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "clipwise-ingest-test-"));
  try {
    const destination = join(workDir, "video");
    const lookedUp = [];
    const requestHosts = [];
    await downloadPublicVideo("https://start.example/video", destination, {
      resolve: async (hostname) => {
        lookedUp.push(hostname);
        return [{ address: hostname === "start.example" ? "93.184.216.34" : "1.1.1.1", family: 4 }];
      },
      request: async (url) => {
        requestHosts.push(url.hostname);
        if (url.hostname === "start.example") {
          return Object.assign(Readable.from([]), {
            statusCode: 302,
            headers: { location: "https://cdn.example/video.mp4" },
            resume() {},
          });
        }
        return Object.assign(Readable.from([Buffer.from("mp4-fixture")]), {
          statusCode: 200,
          headers: { "content-length": "11" },
        });
      },
    });
    assert.deepEqual(lookedUp, ["start.example", "cdn.example"]);
    assert.deepEqual(requestHosts, ["start.example", "cdn.example"]);
    assert.equal((await readFile(destination)).toString(), "mp4-fixture");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("owned uploads are copied locally and return a new persisted source snapshot path", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "clipwise-upload-snapshot-test-"));
  const localPath = join(workDir, "source-video");
  const mutableUploadPath = "/objects/uploads/user-owned-upload";
  const privateSnapshotPath = "/objects/clipwise/sources/immutable-random.source";
  let persistedLocalPath;
  try {
    const resultPath = await snapshotVideoUploadStream({
      source: Readable.from([Buffer.from("owned-upload-bytes")]),
      localPath,
      maxBytes: 1024,
      timeoutMs: 1_000,
      persistSnapshot: async (path) => {
        persistedLocalPath = path;
        return privateSnapshotPath;
      },
    });
    assert.equal((await readFile(localPath)).toString(), "owned-upload-bytes");
    assert.equal(persistedLocalPath, localPath);
    assert.equal(resultPath, privateSnapshotPath);
    assert.notEqual(resultPath, mutableUploadPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("YouTube accepts only single public watch, youtu.be, and Shorts URLs", () => {
  const id = "0n5Xs9XleLw";
  assert.equal(
    parseSupportedYoutubeUrl(`https://www.youtube.com/watch?v=${id}`),
    `https://www.youtube.com/watch?v=${id}`,
  );
  assert.equal(
    parseSupportedYoutubeUrl(`https://youtu.be/${id}`),
    `https://www.youtube.com/watch?v=${id}`,
  );
  assert.equal(
    parseSupportedYoutubeUrl(`https://www.youtube.com/shorts/${id}`),
    `https://www.youtube.com/watch?v=${id}`,
  );
  assert.throws(
    () => parseSupportedYoutubeUrl(`https://www.youtube.com/watch?v=${id}&list=PL123`),
    /playlists are not supported/,
  );
  assert.throws(
    () => parseSupportedYoutubeUrl(`https://youtube.com/live/${id}`),
    /identify one public video/,
  );
  assert.throws(
    () => parseSupportedYoutubeUrl(`https://www.youtube.com.evil.example/watch?v=${id}`),
    /Only public YouTube/,
  );
  assert.throws(
    () => parseSupportedYoutubeUrl(`https://www.youtube.com/watch?v=${id}&v=other`),
    /identify one public video/,
  );
});

test("YouTube extractor egress allowlist covers expected provider and CDN hosts only", () => {
  for (const hostname of [
    "youtube.com",
    "www.youtube.com",
    "youtubei.googleapis.com",
    "rr1---sn.googlevideo.com",
    "i.ytimg.com",
  ]) {
    assert.equal(isAllowedYoutubeEgressHost(hostname), true, hostname);
  }
  for (const hostname of [
    "accounts.google.com",
    "google.com",
    "googlevideo.com.attacker.example",
    "youtube.com.attacker.example",
    "127.0.0.1",
  ]) {
    assert.equal(isAllowedYoutubeEgressHost(hostname), false, hostname);
  }
});

test("secure proxy CONNECT accepts only allowlisted hosts on HTTPS port 443", () => {
  assert.deepEqual(parseYoutubeConnectTarget("www.youtube.com:443"), {
    hostname: "www.youtube.com",
    port: 443,
  });
  assert.deepEqual(parseYoutubeConnectTarget("rr1---sn.googlevideo.com:443"), {
    hostname: "rr1---sn.googlevideo.com",
    port: 443,
  });
  for (const target of [
    "youtube.com:80",
    "youtube.com:444",
    "youtube.com",
    "google.com:443",
    "youtube.com.attacker.example:443",
    "127.0.0.1:443",
    "youtube.com:443@127.0.0.1",
  ]) {
    assert.throws(() => parseYoutubeConnectTarget(target), undefined, target);
  }
});

test("YouTube permits direct HTTPS MP4/M4A inputs and combined MP4 with native local merge only", () => {
  assert.equal(
    YOUTUBE_FORMAT_SELECTOR,
    "bestvideo[protocol=https][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][ext=mp4]",
  );
  assert.equal(YOUTUBE_DOWNLOADER, "native");
  assert.equal(YOUTUBE_MERGE_OUTPUT_FORMAT, "mp4");
  assert.equal(YOUTUBE_JS_RUNTIME, "node");
  for (const alternative of YOUTUBE_FORMAT_SELECTOR.split("/")) {
    for (const component of alternative.split("+")) {
      assert.match(component, /\[protocol=https\]/);
      assert.match(component, /\[ext=(?:mp4|m4a)\]/);
    }
  }
  assert.doesNotMatch(YOUTUBE_FORMAT_SELECTOR, /m3u8|dash/i);
});

test("YouTube diagnostics identify bot checks without exposing signed media URLs", () => {
  const stderr =
    "ERROR: Sign in to confirm you're not a bot https://r1.googlevideo.com/videoplayback?sig=SECRET";
  const failure = classifyYtDlpFailure(stderr, new Error("yt-dlp exited with status 1."));
  assert.equal(failure.kind, "bot-blocked");
  assert.equal(failure.transient, false);
  const message = friendlyYtDlpFailure(failure);
  assert.match(message, /bot verification/);
  assert.doesNotMatch(message, /SECRET|googlevideo\.com/);
});

test("YouTube diagnostics classify likely extractor-version failures and bounded transient retries", () => {
  const extractor = classifyYtDlpFailure("nsig extraction failed; see signed url: sig=SECRET", null);
  assert.equal(extractor.kind, "extractor");
  assert.match(friendlyYtDlpFailure(extractor), /installed extractor may be outdated/);
  assert.doesNotMatch(friendlyYtDlpFailure(extractor), /SECRET/);

  const temporary = classifyYtDlpFailure("ERROR: HTTP Error 503: Service Unavailable", null);
  assert.equal(temporary.kind, "network");
  assert.equal(temporary.transient, true);

  const missingRuntime = classifyYtDlpFailure(
    "YouTube JavaScript challenge unavailable: yt-dlp-ejs is not installed",
    null,
  );
  assert.equal(missingRuntime.kind, "runtime-missing");
  assert.match(friendlyYtDlpFailure(missingRuntime), /yt-dlp\[default\]/);
});

test("provider unavailability errors stay actionable without echoing signed CDN URLs", () => {
  const failure = classifyYtDlpFailure(
    "ERROR: [youtube] Video unavailable https://r1.googlevideo.com/videoplayback?sig=SECRET",
    null,
  );
  assert.equal(failure.kind, "unavailable");
  const message = friendlyYtDlpFailure(failure);
  assert.match(message, /server-side downloader/);
  assert.doesNotMatch(message, /SECRET|googlevideo\.com/);
});