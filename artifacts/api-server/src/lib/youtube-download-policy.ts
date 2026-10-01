// Separate native HTTPS MP4/M4A inputs are merged from local files only; the
// combined HTTPS MP4 is the only fallback. Never add HLS/DASH or generic URLs.
export const YOUTUBE_FORMAT_SELECTOR =
  "bestvideo[protocol=https][ext=mp4]+bestaudio[protocol=https][ext=m4a]/best[protocol=https][ext=mp4]";
export const YOUTUBE_DOWNLOADER = "native";
export const YOUTUBE_MERGE_OUTPUT_FORMAT = "mp4";
export const YOUTUBE_JS_RUNTIME = "node";