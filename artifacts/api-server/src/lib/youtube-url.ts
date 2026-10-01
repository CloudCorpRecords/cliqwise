const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);
const YOUTUBE_EGRESS_SUFFIXES = [
  "youtube.com",
  "youtu.be",
  "googlevideo.com",
  "youtubei.googleapis.com",
  "ytimg.com",
];

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function isYoutubeSourceHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.has(normalizeHostname(hostname));
}

export function isAllowedYoutubeEgressHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return YOUTUBE_EGRESS_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

export function parseYoutubeConnectTarget(
  authority: string,
): { hostname: string; port: 443 } {
  if (!authority || /[\r\n/@?#]/.test(authority)) {
    throw new Error("Invalid CONNECT authority.");
  }
  let url: URL;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    throw new Error("Invalid CONNECT authority.");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Invalid CONNECT authority.");
  }
  const port = Number(url.port || 80);
  if (port !== 443) throw new Error("Only HTTPS proxy tunnels are supported.");
  const hostname = normalizeHostname(url.hostname.replace(/^\[|\]$/g, ""));
  if (!isAllowedYoutubeEgressHost(hostname)) {
    throw new Error("The proxy destination is not on the YouTube egress allowlist.");
  }
  return { hostname, port: 443 };
}

export function parseSupportedYoutubeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid public YouTube watch, youtu.be, or Shorts URL.");
  }
  const host = normalizeHostname(url.hostname);
  if (!YOUTUBE_HOSTS.has(host)) {
    throw new Error("Only public YouTube watch, youtu.be, and Shorts URLs are supported.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("YouTube URLs must use credential-free HTTPS on the standard port.");
  }
  if (url.searchParams.has("list")) {
    throw new Error("YouTube playlists are not supported. Submit a single video URL.");
  }

  let videoId: string | undefined;
  if (
    (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") &&
    url.pathname === "/watch"
  ) {
    const values = url.searchParams.getAll("v");
    videoId = values.length === 1 ? values[0] : undefined;
  } else if (
    (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") &&
    /^\/shorts\/[^/]+\/?$/.test(url.pathname)
  ) {
    videoId = url.pathname.split("/")[2];
  } else if (host === "youtu.be" && /^\/[^/]+\/?$/.test(url.pathname)) {
    videoId = url.pathname.split("/")[1];
  }

  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error("The YouTube URL must identify one public video.");
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}