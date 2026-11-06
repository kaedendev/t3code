// Ported from Hex by Christopher Langton (MIT): src/dictation/{spoken_formatting,spoken_symbols,filler_words,text_replacements,processor}.rs.

const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;
const WHITESPACE = /^\p{White_Space}$/u;
const NON_WHITESPACE = /[^\p{White_Space}]/u;
const UPPERCASE = /^\p{Uppercase}$/u;
const LOWERCASE = /^\p{Lowercase}$/u;
const ALPHABETIC = /^\p{Alphabetic}$/u;
// Hex matches these with Rust regex's bare `\p{Han}` etc., which resolve to Script_Extensions.
const UNSPACED_SCRIPT =
  /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}\p{scx=Tibetan}]$/u;

const isAlphanumeric = (c: string | undefined) => c !== undefined && ALPHANUMERIC.test(c);
const isWhitespace = (c: string | undefined) => c !== undefined && WHITESPACE.test(c);
const isSpace = (c: string | undefined) => c !== "\n" && isWhitespace(c);

const ACCENTS: Record<string, string> = { á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u" };

function fold(c: string) {
  const lower = c.toLowerCase();
  const single = Array.from(lower).length === 1 ? lower : c;
  return ACCENTS[single] ?? single;
}

const wordStartAt = (chars: ReadonlyArray<string>, index: number) =>
  index === 0 || !isAlphanumeric(chars[index - 1]);

function wordAt(chars: ReadonlyArray<string>, start: number, word: string) {
  let position = start;
  for (const expected of word) {
    const c = chars[position];
    if (c === undefined || fold(c) !== expected) return undefined;
    position += 1;
  }
  return isAlphanumeric(chars[position]) ? undefined : position;
}

/** Where the words of `phrase` starting at `start` end, separated by at least one space each. */
function phraseAt(chars: ReadonlyArray<string>, start: number, phrase: ReadonlyArray<string>) {
  let position = start;
  for (const [number, word] of phrase.entries()) {
    if (number > 0) {
      const from = position;
      while (isWhitespace(chars[position])) position += 1;
      if (position === from) return undefined;
    }
    for (const expected of word) {
      const c = chars[position];
      if (c === undefined || fold(c) !== expected) return undefined;
      position += 1;
    }
  }
  return isAlphanumeric(chars[position]) ? undefined : position;
}

function trimEnd(out: string[], also: ReadonlyArray<string>, floor = 0) {
  while (out.length > floor) {
    const last = out[out.length - 1]!;
    if (!isSpace(last) && !also.includes(last)) break;
    out.pop();
  }
}

function skip(chars: ReadonlyArray<string>, index: number, also: ReadonlyArray<string>) {
  let next = index;
  while (chars[next] !== undefined && (isSpace(chars[next]) || also.includes(chars[next]!))) {
    next += 1;
  }
  return next;
}

type FormattingCommand =
  | { readonly kind: "break"; readonly text: string }
  | { readonly kind: "openQuote" }
  | { readonly kind: "closeQuote" };

const OPEN_QUOTE: FormattingCommand = { kind: "openQuote" };
const CLOSE_QUOTE: FormattingCommand = { kind: "closeQuote" };
const LINE: FormattingCommand = { kind: "break", text: "\n" };
const PARAGRAPH: FormattingCommand = { kind: "break", text: "\n\n" };

const FORMATTING_COMMANDS: ReadonlyArray<readonly [ReadonlyArray<string>, FormattingCommand]> = [
  [["new", "paragraph"], PARAGRAPH],
  [["new", "line"], LINE],
  [["line", "break"], LINE],
  [["open", "quote"], OPEN_QUOTE],
  [["close", "quote"], CLOSE_QUOTE],
  [["nuevo", "parrafo"], PARAGRAPH],
  [["nueva", "linea"], LINE],
  [["salto", "de", "linea"], LINE],
  [["abrir", "comillas"], OPEN_QUOTE],
  [["abre", "comillas"], OPEN_QUOTE],
  [["cerrar", "comillas"], CLOSE_QUOTE],
  [["cierra", "comillas"], CLOSE_QUOTE],
];

/** Where the first whole-word "unquote" after `from` starts, when words come between. */
function unquoteAfter(chars: ReadonlyArray<string>, from: number) {
  let wordsBetween = false;
  for (let index = from; index < chars.length; index += 1) {
    if (wordStartAt(chars, index) && wordAt(chars, index, "unquote") !== undefined) {
      return wordsBetween ? index : undefined;
    }
    wordsBetween ||= isAlphanumeric(chars[index]);
  }
  return undefined;
}

function emitFormatting(
  out: string[],
  command: FormattingCommand,
  chars: ReadonlyArray<string>,
  end: number,
) {
  switch (command.kind) {
    case "break":
      trimEnd(out, [",", ";"]);
      out.push(command.text);
      return skip(chars, end, [",", ".", ";", ":"]);
    case "openQuote": {
      trimEnd(out, []);
      const last = out.at(-1);
      if (last !== undefined && !["\n", "(", "[", '"'].includes(last)) out.push(" ");
      out.push('"');
      return skip(chars, end, [",", "."]);
    }
    case "closeQuote": {
      trimEnd(out, [","]);
      out.push('"');
      const next = skip(chars, end, []);
      if (isAlphanumeric(chars[next])) out.push(" ");
      return next;
    }
  }
}

/** Spoken "new line", "new paragraph", "open/close quote", "quote … unquote" (and Spanish) become text. */
export function applySpokenFormatting(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  let index = 0;
  let pendingUnquote: number | undefined;
  while (index < chars.length) {
    const wordStart = wordStartAt(chars, index);
    if (pendingUnquote === index) {
      pendingUnquote = undefined;
      index = emitFormatting(out, CLOSE_QUOTE, chars, index + "unquote".length);
      continue;
    }
    if (wordStart) {
      const matched = FORMATTING_COMMANDS.flatMap(([words, command]) => {
        const end = phraseAt(chars, index, words);
        return end === undefined ? [] : [{ command, end }];
      })[0];
      if (matched) {
        index = emitFormatting(out, matched.command, chars, matched.end);
        continue;
      }
      if (pendingUnquote === undefined) {
        const end = wordAt(chars, index, "quote");
        const close = end === undefined ? undefined : unquoteAfter(chars, end);
        if (end !== undefined && close !== undefined) {
          pendingUnquote = close;
          index = emitFormatting(out, OPEN_QUOTE, chars, end);
          continue;
        }
      }
    }
    out.push(chars[index]!);
    index += 1;
  }
  return out.join("");
}

/** Which neighbour a symbol attaches to: the next word, both words, or the previous word. */
type SymbolJoin = "next" | "both" | "previous";

const SYMBOLS: ReadonlyArray<readonly [ReadonlyArray<string>, string, SymbolJoin]> = [
  [["hashtag"], "#", "next"],
  [["hash", "sign"], "#", "next"],
  [["at", "sign"], "@", "next"],
  [["underscore"], "_", "both"],
  [["hyphen"], "-", "both"],
  [["slash"], "/", "both"],
  [["comma"], ",", "previous"],
  [["semicolon"], ";", "previous"],
  [["colon"], ":", "previous"],
  [["arroba"], "@", "next"],
  [["guion", "bajo"], "_", "both"],
  [["guion"], "-", "both"],
  [["punto", "y", "coma"], ";", "previous"],
  [["coma"], ",", "previous"],
  [["dos", "puntos"], ":", "previous"],
];

const SYMBOL_FOLLOWERS_WITHOUT_SPACE = ["\n", ",", ".", ";", ":", "!", "?", ")", "]", '"'];

/** Spoken punctuation and symbol words ("hashtag", "underscore", "comma", "arroba", …) become characters. */
export function applySpokenSymbols(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  // Where the last symbol written ends, so trimming never removes it.
  let floor = 0;
  let index = 0;
  while (index < chars.length) {
    if (wordStartAt(chars, index)) {
      const matched = SYMBOLS.flatMap(([words, symbol, join]) => {
        const end = phraseAt(chars, index, words);
        return end === undefined ? [] : [{ symbol, join, end }];
      })[0];
      if (matched) {
        if (matched.join !== "next") trimEnd(out, [","], floor);
        out.push(matched.symbol);
        floor = out.length;
        index = skip(chars, matched.end, [",", "."]);
        const next = chars[index];
        if (
          matched.join === "previous" &&
          next !== undefined &&
          !SYMBOL_FOLLOWERS_WITHOUT_SPACE.includes(next)
        ) {
          out.push(" ");
        }
        continue;
      }
    }
    out.push(chars[index]!);
    index += 1;
  }
  return out.join("");
}

const FILLERS = ["um", "umm", "uh", "uhh", "erm", "er", "ah"];
const FILLER_CLOSERS = [".", ",", ";", ":", "!", "?", ")", "]", "}", "”", "’", "…"];

const joinsWord = (c: string | undefined) =>
  isAlphanumeric(c) || c === "-" || c === "'" || c === "’";

function fillerAt(chars: ReadonlyArray<string>, start: number) {
  if (start > 0 && joinsWord(chars[start - 1])) return undefined;
  for (const word of FILLERS) {
    const end = start + word.length;
    if (end > chars.length) continue;
    const matches = Array.from(word).every((expected, number) => {
      const c = chars[start + number];
      return c === expected || (number === 0 && c === expected.toUpperCase());
    });
    if (matches && !joinsWord(chars[end])) return end;
  }
  return undefined;
}

function skipSpaces(chars: ReadonlyArray<string>, index: number) {
  let next = index;
  while (isSpace(chars[next])) next += 1;
  return next;
}

/** Where the text continues after a filler, past its own comma or ellipsis. */
function afterFiller(chars: ReadonlyArray<string>, end: number) {
  let index = skipSpaces(chars, end);
  const c = chars[index];
  if (c === "," || c === "…") index += 1;
  else if (c === "." && chars[index + 1] === "." && chars[index + 2] === ".") index += 3;
  return skipSpaces(chars, index);
}

const sentenceStart = (out: ReadonlyArray<string>) => {
  const last = out.at(-1);
  return last === undefined || [".", "!", "?", "\n"].includes(last);
};

function needsSpace(out: ReadonlyArray<string>) {
  const last = out.at(-1);
  if (last === undefined || ["\n", "(", "[", "{", "“", "‘"].includes(last)) return false;
  if (last === '"') {
    const before = out.at(-2);
    return before !== undefined && !isWhitespace(before);
  }
  return true;
}

/** Drops "um", "uh", "er", "ah" and friends with their commas, handing a sentence-start capital on. */
export function removeFillerWords(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  // A filler was just removed: the next text decides the spacing.
  let removed = false;
  let capitalize = false;
  let index = 0;
  while (index < chars.length) {
    const end = fillerAt(chars, index);
    if (end !== undefined) {
      trimEnd(out, []);
      if (!removed) capitalize = UPPERCASE.test(chars[index]!) && sentenceStart(out);
      index = afterFiller(chars, end);
      removed = true;
      continue;
    }
    const c = chars[index]!;
    index += 1;
    if (removed) {
      if (isSpace(c)) continue;
      if (c === "\n") {
        removed = false;
        capitalize = false;
        out.push(c);
        continue;
      }
      if ([".", "!", "?", ","].includes(c) && sentenceStart(out)) continue;
      removed = false;
      const closing = FILLER_CLOSERS.includes(c) || (c === '"' && !isAlphanumeric(chars[index]));
      if (closing) {
        trimEnd(out, [","]);
        capitalize = false;
      } else {
        if (needsSpace(out)) out.push(" ");
        if (capitalize) {
          capitalize = false;
          out.push(c.toUpperCase());
          continue;
        }
      }
    }
    out.push(c);
  }
  if (removed) trimEnd(out, [","]);
  return out.join("");
}

export type VoiceReplacement = { readonly find: string; readonly replace: string };

const HORIZONTAL_WHITESPACE = [" ", "\t"];
const CLAUSE_PUNCTUATION = [".", "!", "?", ",", ";", ":"];
const SENTENCE_ENDINGS = [".", "!", "?", "\n"];

const trimStartChars = (text: string, set: ReadonlyArray<string>) => {
  let index = 0;
  while (index < text.length && set.includes(text[index]!)) index += 1;
  return text.slice(index);
};

const trimEndChars = (text: string, set: ReadonlyArray<string>) => {
  let end = text.length;
  while (end > 0 && set.includes(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
};

function atSentenceStart(output: string) {
  const trimmed = trimEndChars(output, HORIZONTAL_WHITESPACE);
  return trimmed === "" || SENTENCE_ENDINGS.includes(trimmed.at(-1)!);
}

function codePointBefore(text: string, index: number) {
  if (index === 0) return undefined;
  const low = text.charCodeAt(index - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
  return String.fromCodePoint(text.codePointAt(start)!);
}

function codePointAt(text: string, index: number) {
  const code = text.codePointAt(index);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

const wordCharacter = (c: string | undefined) =>
  c !== undefined && !UNSPACED_SCRIPT.test(c) && (isAlphanumeric(c) || c === "_");

function* phraseMatches(matcher: RegExp, text: string) {
  let from = 0;
  while (from <= text.length) {
    matcher.lastIndex = from;
    const matched = matcher.exec(text);
    if (!matched) return;
    const start = matched.index;
    const end = start + matched[0].length;
    if (!wordCharacter(codePointBefore(text, start)) && !wordCharacter(codePointAt(text, end))) {
      from = end;
      yield { start, end };
      continue;
    }
    // A match rejected for touching a word resumes one character later, so an overlapping whole-phrase match is still found.
    from = start + (codePointAt(text, start)?.length ?? 1);
  }
}

/** Whole-phrase, case-insensitive replacements; longest match wins, and outputs never re-trigger rules. An empty replacement deletes the phrase and tidies its punctuation. */
export function applyReplacements(
  text: string,
  replacements: ReadonlyArray<VoiceReplacement>,
): string {
  const rules = replacements.flatMap(({ find, replace }) => {
    const phrase = find.trim();
    if (phrase === "") return [];
    const escaped = phrase.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
    return [{ matcher: new RegExp(escaped, "giu"), output: replace }];
  });
  const candidates = rules.flatMap(({ matcher }, rule) =>
    Array.from(phraseMatches(matcher, text), (match) => ({ ...match, rule })),
  );
  candidates.sort(
    (left, right) =>
      right.end - right.start - (left.end - left.start) ||
      left.start - right.start ||
      left.rule - right.rule,
  );
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (
      selected.some((existing) => candidate.start < existing.end && existing.start < candidate.end)
    ) {
      continue;
    }
    selected.push(candidate);
  }
  if (selected.length === 0) return text;
  selected.sort((left, right) => left.start - right.start);

  let output = "";
  let capitalizeNext = false;
  const pushSegment = (segment: string) => {
    if (!capitalizeNext || segment === "") {
      output += segment;
      if (NON_WHITESPACE.test(segment)) capitalizeNext = false;
      return;
    }
    const offset = segment.search(NON_WHITESPACE);
    if (offset === -1) {
      output += segment;
      return;
    }
    output += segment.slice(0, offset);
    const character = codePointAt(segment, offset)!;
    output +=
      LOWERCASE.test(character) && atSentenceStart(output) ? character.toUpperCase() : character;
    output += segment.slice(offset + character.length);
    capitalizeNext = false;
  };

  let cursor = 0;
  for (const [index, candidate] of selected.entries()) {
    if (cursor < candidate.start) pushSegment(text.slice(cursor, candidate.start));
    const replacement = rules[candidate.rule]!.output;
    if (replacement !== "") {
      pushSegment(replacement);
      cursor = candidate.end;
      continue;
    }
    const nextLimit = selected[index + 1]?.start ?? text.length;
    const between = text.slice(candidate.end, nextLimit);
    if (atSentenceStart(output)) {
      const firstLetter = Array.from(text.slice(candidate.start, candidate.end)).find((c) =>
        ALPHABETIC.test(c),
      );
      if (firstLetter !== undefined && UPPERCASE.test(firstLetter)) capitalizeNext = true;
      const afterSpaces = trimStartChars(
        trimStartChars(between, CLAUSE_PUNCTUATION),
        HORIZONTAL_WHITESPACE,
      );
      cursor = candidate.end + (between.length - afterSpaces.length);
      if ((afterSpaces === "" && nextLimit === text.length) || afterSpaces.startsWith("\n")) {
        output = trimEndChars(output, HORIZONTAL_WHITESPACE);
      }
      continue;
    }
    const remaining = trimStartChars(text.slice(candidate.end), HORIZONTAL_WHITESPACE);
    const skipBetweenSpaces = () =>
      candidate.end + (between.length - trimStartChars(between, HORIZONTAL_WHITESPACE).length);
    if (
      CLAUSE_PUNCTUATION.includes(between.charAt(0)) ||
      remaining === "" ||
      remaining.startsWith("\n")
    ) {
      output = trimEndChars(output, HORIZONTAL_WHITESPACE);
      if (output.endsWith(",")) output = output.slice(0, -1);
      cursor = remaining === "" || remaining.startsWith("\n") ? skipBetweenSpaces() : candidate.end;
    } else if (HORIZONTAL_WHITESPACE.includes(output.slice(-1))) {
      cursor = skipBetweenSpaces();
    } else {
      cursor = candidate.end;
    }
  }
  if (cursor < text.length) pushSegment(text.slice(cursor));
  return output;
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "billion",
];
const NUMBER_JOINERS = ["and", "point", "minus", "negative"];

/** Whether a transcript says nothing but numbers: digits or English number words, with punctuation between. */
export function isNumbersOnly(text: string): boolean {
  let anyNumber = false;
  for (const token of text.split(/[\p{White_Space}-]/u)) {
    const word = token.replace(/^[^\p{Alphabetic}\p{N}]+|[^\p{Alphabetic}\p{N}]+$/gu, "");
    if (word === "") continue;
    const lower = word.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (/^[0-9.,]+$/.test(word) || NUMBER_WORDS.includes(lower)) {
      anyNumber = true;
    } else if (!NUMBER_JOINERS.includes(lower)) {
      return false;
    }
  }
  return anyNumber;
}

export type VoiceCleanupOptions = {
  readonly spokenFormatting: boolean;
  readonly spokenSymbols: boolean;
  readonly fillerWords: boolean;
  readonly replacements: ReadonlyArray<VoiceReplacement>;
};

export function cleanTranscript(text: string, options: VoiceCleanupOptions): string {
  const formatted = options.spokenFormatting ? applySpokenFormatting(text) : text;
  const symbolized = options.spokenSymbols ? applySpokenSymbols(formatted) : formatted;
  const unfilled = options.fillerWords ? removeFillerWords(symbolized) : symbolized;
  return applyReplacements(unfilled, options.replacements);
}
