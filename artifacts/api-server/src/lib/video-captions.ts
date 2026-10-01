export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

interface CaptionTheme {
  fontSize: number;
  normalColor: string;
  activeColor: string;
  stylePrimary: string;
  karaokePrimary: string;
  karaokeSecondary: string;
  outline: number;
  bold: number;
  shadow: number;
  maxLineCharacters: number;
}

const THEMES: Record<string, CaptionTheme> = {
  bold: {
    fontSize: 64,
    normalColor: "&H00FFFFFF&",
    activeColor: "&H0000D7FF&",
    stylePrimary: "&H00FFFFFF",
    karaokePrimary: "&H0000D7FF",
    karaokeSecondary: "&H00FFFFFF",
    outline: 4,
    bold: 1,
    shadow: 2,
    maxLineCharacters: 19,
  },
  minimal: {
    fontSize: 52,
    normalColor: "&H00FFFFFF&",
    activeColor: "&H00FFCF20&",
    stylePrimary: "&H00FFFFFF",
    karaokePrimary: "&H00FFCF20",
    karaokeSecondary: "&H00F5F5F5",
    outline: 1,
    bold: 0,
    shadow: 0,
    maxLineCharacters: 23,
  },
  karaoke: {
    fontSize: 60,
    normalColor: "&H00FFFFFF&",
    activeColor: "&H0000D7FF&",
    stylePrimary: "&H00FFFFFF",
    karaokePrimary: "&H0000D7FF",
    karaokeSecondary: "&H00FFFFFF",
    outline: 3,
    bold: 1,
    shadow: 1,
    maxLineCharacters: 21,
  },
};

const MAX_WORDS_PER_PHRASE = 5;

export function createAssCaptions(
  words: TimedWord[],
  styleName: string,
  clipDuration: number,
): string {
  const style = styleName.toLowerCase();
  const theme = THEMES[style] ?? THEMES.bold!;
  const groups = groupWords(words, theme.maxLineCharacters);
  const events: string[] = [];

  for (const phrase of groups) {
    const phraseStart = Math.max(0, phrase[0]?.start ?? 0);
    const phraseEnd = Math.min(clipDuration, phrase.at(-1)?.end ?? phraseStart);
    if (phraseEnd <= phraseStart) continue;

    if (style === "karaoke") {
      const karaokeText = phrase
        .map((word) => {
          const wordStart = Math.max(phraseStart, word.start);
          const wordEnd = Math.min(phraseEnd, word.end);
          const relativeStartCs = Math.max(
            0,
            Math.round((wordStart - phraseStart) * 100),
          );
          const durationCs = Math.max(1, Math.round((wordEnd - wordStart) * 100));
          return `{\\kt${relativeStartCs}\\kf${durationCs}}${wrapAssWord(word.text, theme.maxLineCharacters)}`;
        })
        .join(" ");
      events.push(
        dialogue(0, phraseStart, phraseEnd, karaokeText),
      );
      continue;
    }

    const baseText = phrase
      .map((word) => wrapAssWord(word.text, theme.maxLineCharacters))
      .join(" ");
    // Keep the full phrase visible through pauses, while a higher-layer event
    // colors and pops only the currently spoken word for its true word interval.
    events.push(dialogue(0, phraseStart, phraseEnd, baseText));
    for (let activeIndex = 0; activeIndex < phrase.length; activeIndex += 1) {
      const word = phrase[activeIndex];
      if (!word) continue;
      const wordStart = Math.max(phraseStart, word.start);
      const wordEnd = Math.min(phraseEnd, word.end);
      if (wordEnd <= wordStart) continue;
      const activeText = phrase
        .map((phraseWord, index) => {
          const display = wrapAssWord(phraseWord.text, theme.maxLineCharacters);
          if (index !== activeIndex) return display;
          return `{\\c${theme.activeColor}\\bord${theme.outline}\\shad${theme.shadow}\\t(0,80,\\bord${theme.outline + 2}\\shad${theme.shadow + 1})}${display}{\\c${theme.normalColor}\\bord${theme.outline}\\shad${theme.shadow}}`;
        })
        .join(" ");
      events.push(dialogue(1, wordStart, wordEnd, activeText));
    }
  }

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 720",
    "PlayResY: 1280",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Clipwise,DejaVu Sans,${theme.fontSize},${style === "karaoke" ? theme.karaokePrimary : theme.stylePrimary},${theme.karaokeSecondary},&HCC000000,&H99000000,${theme.bold},0,0,0,100,100,0,0,1,${theme.outline},${theme.shadow},2,50,50,155,1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...events,
    "",
  ].join("\n");
}

function groupWords(words: TimedWord[], maxLineCharacters: number): TimedWord[][] {
  const groups: TimedWord[][] = [];
  let group: TimedWord[] = [];
  let characters = 0;
  const flush = () => {
    if (group.length) groups.push(group);
    group = [];
    characters = 0;
  };

  for (const word of words) {
    const text = word.text.trim();
    if (!text || !Number.isFinite(word.start) || !Number.isFinite(word.end)) continue;
    if (word.end <= word.start) continue;
    const nextCharacters = characters + (group.length ? 1 : 0) + [...text].length;
    if (
      group.length &&
      (group.length >= MAX_WORDS_PER_PHRASE || nextCharacters > maxLineCharacters)
    ) {
      flush();
    }
    group.push({ ...word, text });
    characters += (group.length > 1 ? 1 : 0) + [...text].length;
    if (/[.!?]$/.test(text)) flush();
  }
  flush();
  return groups;
}

function wrapAssWord(word: string, maxCharacters: number): string {
  const points = [...word];
  if (points.length <= maxCharacters) return escapeAssText(word);
  const lines: string[] = [];
  for (let index = 0; index < points.length; index += maxCharacters) {
    lines.push(escapeAssText(points.slice(index, index + maxCharacters).join("")));
  }
  return lines.join("\\N");
}

function dialogue(layer: number, start: number, end: number, text: string): string {
  return `Dialogue: ${layer},${formatAssTime(start)},${formatAssTime(end)},Clipwise,,0,0,0,,${text}`;
}

export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r?\n/g, " ");
}

function formatAssTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const secs = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}