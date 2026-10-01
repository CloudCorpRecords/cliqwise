export type YtDlpFailure = {
  kind:
    | "bot-blocked"
    | "private"
    | "live"
    | "age-restricted"
    | "drm"
    | "region"
    | "extractor"
    | "runtime-missing"
    | "format-unavailable"
    | "rate-limited"
    | "network"
    | "http-denied"
    | "unavailable"
    | "unknown";
  transient: boolean;
};

/**
 * Only the classification is returned to application code. Raw stderr can
 * contain signed CDN URLs and must remain in the private transient temp file.
 */
export function classifyYtDlpFailure(stderr: string, error: unknown): YtDlpFailure {
  const text = stderr.toLowerCase();
  if (/confirm (?:that )?you(?:'|’)re not a bot|not a bot|captcha|recaptcha|automated queries|unusual traffic/.test(text)) {
    return { kind: "bot-blocked", transient: false };
  }
  if (/private video|members.only|members-only|this video is private|sign in to view/.test(text)) {
    return { kind: "private", transient: false };
  }
  if (/live event|is live|livestream|live stream/.test(text)) {
    return { kind: "live", transient: false };
  }
  if (/age.restricted|confirm your age|age verification/.test(text)) {
    return { kind: "age-restricted", transient: false };
  }
  if (/\bdrm\b|widevine|playready/.test(text)) {
    return { kind: "drm", transient: false };
  }
  if (/not available in your country|geo.?restricted|country.*not available/.test(text)) {
    return { kind: "region", transient: false };
  }
  if (/yt-dlp-ejs|no supported javascript runtime|javascript runtime.*not available|ejs.*not installed/.test(text)) {
    return { kind: "runtime-missing", transient: false };
  }
  if (/nsig extraction failed|signature extraction failed|challenge solving|extractor.*outdated/.test(text)) {
    return { kind: "extractor", transient: false };
  }
  if (/no suitable formats|requested format (?:is )?not available|requested format is not available/.test(text)) {
    return { kind: "format-unavailable", transient: false };
  }
  const status = text.match(/http error (\d{3})/i)?.[1];
  if (status) {
    const code = Number(status);
    if (code === 429) return { kind: "rate-limited", transient: true };
    if (code === 403) return { kind: "http-denied", transient: false };
    if ([408, 425, 500, 502, 503, 504].includes(code)) {
      return { kind: "network", transient: true };
    }
  }
  if (
    /timed out|connection reset|temporary failure|eai_again|network is unreachable|remote end closed|proxy error/.test(text) ||
    (error instanceof Error && /timed out/.test(error.message))
  ) {
    return { kind: "network", transient: true };
  }
  if (/video unavailable|video is unavailable|not available/.test(text)) {
    return { kind: "unavailable", transient: false };
  }
  return { kind: "unknown", transient: false };
}

export function friendlyYtDlpFailure(failure: YtDlpFailure): string {
  switch (failure.kind) {
    case "private":
      return "This YouTube video is private or requires an account; login-only videos are not supported.";
    case "live":
      return "Live YouTube streams are not supported.";
    case "age-restricted":
      return "Age-restricted YouTube videos are not supported.";
    case "drm":
      return "DRM-protected YouTube videos cannot be downloaded.";
    case "region":
      return "This YouTube video is unavailable in this server's region.";
    case "extractor":
      return "yt-dlp could not parse YouTube's current video formats. The installed extractor may be outdated; update yt-dlp through the supported package manager and try again.";
    case "runtime-missing":
      return "YouTube extraction needs the local yt-dlp JavaScript support package and Node.js. Install the official yt-dlp[default] extra; remote component downloads are disabled.";
    case "format-unavailable":
      return "This YouTube video has no available direct HTTPS MP4 video and audio formats. Use a direct public MP4 or upload an authorized file.";
    case "rate-limited":
      return "YouTube rate-limited the secure download. Bounded retries were attempted; try again later.";
    case "network":
      return "The secure YouTube download failed after bounded retries because of a temporary network or provider error. Try again later.";
    case "http-denied":
      return "YouTube denied the media request (HTTP 403). The video may be blocked from server-side download; login or restriction bypass is not supported.";
    case "unavailable":
      return "YouTube reported this video as unavailable to the server-side downloader. It may be blocked from server access or region-restricted; restriction bypass is not supported. Try a different public video or upload an authorized file.";
    case "bot-blocked":
      return "YouTube is temporarily blocking automated access to this video with bot verification. Try again later; sign-in or verification bypass is not supported.";
    default:
      return "The public YouTube video could not be downloaded. Check that it is publicly available without login or regional restrictions.";
  }
}