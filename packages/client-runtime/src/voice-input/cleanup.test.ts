import { describe, expect, it } from "vite-plus/test";

import {
  applyReplacements,
  applySpokenFormatting,
  applySpokenSymbols,
  cleanTranscript,
  isNumbersOnly,
  removeFillerWords,
} from "./cleanup.ts";

type Row = [input: string, expected: string];

const unchanged = (texts: ReadonlyArray<string>) => texts.map((text): Row => [text, text]);

describe("applySpokenFormatting", () => {
  it.each<Row>([
    ["Hello. New line. Next", "Hello.\nNext"],
    ["One. New paragraph. Two.", "One.\n\nTwo."],
    ["one, line break, two", "one\ntwo"],
    ["a NEW LINE new line b", "a\n\nb"],
    ["He said open quote hi close quote.", 'He said "hi".'],
    ["He said, Open quote, hello, close quote, and left.", 'He said, "hello", and left.'],
    ["open quote yes close quote then", '"yes" then'],
    ["He said quote hello unquote.", 'He said "hello".'],
    ["Quote, something, unquote, and more", '"something", and more'],
    ["open quote a close quote and quote b unquote", '"a" and "b"'],
    ["Hola. Nuevo párrafo. Adiós.", "Hola.\n\nAdiós."],
    ["Hola. nuevo parrafo. Adiós.", "Hola.\n\nAdiós."],
    ["uno, nueva línea, dos", "uno\ndos"],
    ["uno NUEVA LINEA dos", "uno\ndos"],
    ["uno salto de línea dos", "uno\ndos"],
    ["dijo abre comillas hola cierra comillas", 'dijo "hola"'],
    ["Dijo Abrir Comillas sí Cerrar Comillas y se fue", 'Dijo "sí" y se fue'],
    ["Hola. New paragraph. Adiós.", "Hola.\n\nAdiós."],
    ...unchanged([
      "Can I get a quote for this",
      "quote unquote experts",
      "an unquote alone",
      "quotes and quoted text unquoted",
      "comillas",
      "una línea lineal",
      "dos parrafos nuevos",
      "nuevo parrafos",
      "The newline character",
      "a new liner",
      "renew line items",
      "line breaker",
      "open quotes",
      "Plain text, nothing to do.",
      "",
    ]),
  ])("%j -> %j", (input, expected) => {
    expect(applySpokenFormatting(input)).toBe(expected);
  });
});

describe("applySpokenSymbols", () => {
  it.each<Row>([
    ["hashtag release", "#release"],
    ["my underscore variable", "my_variable"],
    ["done comma thanks", "done, thanks"],
    ["tag it hash sign release", "tag it #release"],
    ["mail me at sign home", "mail me @home"],
    ["well hyphen known", "well-known"],
    ["and slash or", "and/or"],
    ["one semicolon two", "one; two"],
    ["the list colon apples", "the list: apples"],
    ["Done, Comma, thanks.", "Done, thanks."],
    ["the list COLON.", "the list:"],
    ["a comma comma b", "a,, b"],
    ["escríbeme a arroba casa", "escríbeme a @casa"],
    ["mi guion bajo variable", "mi_variable"],
    ["mi Guión Bajo variable", "mi_variable"],
    ["bien guión conocido", "bien-conocido"],
    ["uno punto y coma dos", "uno; dos"],
    ["hola coma gracias", "hola, gracias"],
    ["la lista dos puntos manzanas", "la lista: manzanas"],
    ["hola comma gracias", "hola, gracias"],
    ...unchanged([
      "comas",
      "guiones largos",
      "un punto y aparte",
      "commas",
      "slashed prices",
      "hashtags everywhere",
      "a hash browns sign",
      "the colonel",
      "Plain text, nothing to do.",
      "",
    ]),
  ])("%j -> %j", (input, expected) => {
    expect(applySpokenSymbols(input)).toBe(expected);
  });
});

describe("removeFillerWords", () => {
  it.each<Row>([
    ["So, um, we should go.", "So, we should go."],
    ["I think uh we should go.", "I think we should go."],
    ["I think, um.", "I think."],
    ["Well umm... maybe", "Well maybe"],
    ["It was, er, erm, fine", "It was, fine"],
    ["Done, uh", "Done"],
    ["(um, aside)", "(aside)"],
    ["Um, so I think", "So I think"],
    ["Hello. Uh, we left. Ah. Then", "Hello. We left. Then"],
    ["Uh, um, okay", "Okay"],
    ["First line.\nUm, second", "First line.\nSecond"],
    ["one um\ntwo", "one\ntwo"],
    ...unchanged([
      "The umbrella is ahead of the error.",
      "Uhura said uh-huh.",
      "Take him to the ER.",
      "UM is a university.",
      "drum, Ahab, ermine",
      "Plain text, nothing to do.",
      "",
    ]),
  ])("%j -> %j", (input, expected) => {
    expect(removeFillerWords(input)).toBe(expected);
  });
});

const rule = (find: string, replace: string) => ({ find, replace });

describe("applyReplacements", () => {
  const unicode = [
    rule("cafe au lait", "café au lait"),
    rule("open code", "OpenCode"),
    rule("über", "Über"),
  ];
  const unspaced = [
    rule("issue", "Issue"),
    rule("open code", "OpenCode"),
    rule("严肃", "严肃"),
    rule("이슈", "issue"),
  ];
  const longest = [
    rule("open", "closed"),
    rule("open code", "OpenCode"),
    rule("code then open", "combined"),
    rule("closed", "shut"),
  ];
  const noRecursion = [
    rule("open code", "OpenCode"),
    rule("alpha", "beta release"),
    rule("beta", "gamma"),
  ];
  const overlapping = [rule("I I", "I"), rule("the the", "the")];
  const duplicates = [rule("hex", "first"), rule("HEX", "second")];
  const deletions = [rule("um", ""), rule("uh", ""), rule("thank you", "")];

  it.each([
    [
      unicode,
      "OPEN CODE, open code. café au lait; cafe au lait! ÜBER.",
      "OpenCode, OpenCode. café au lait; café au lait! Über.",
    ],
    [unicode, "reopen code, open codes, übercool", "reopen code, open codes, übercool"],
    [unspaced, "这个issue很重要", "这个Issue很重要"],
    [unspaced, "用open code写", "用OpenCode写"],
    [unspaced, "ใช้issueบ่อย", "ใช้Issueบ่อย"],
    [unspaced, "이슈를 만들었다", "issue를 만들었다"],
    [unspaced, "issue很重要", "Issue很重要"],
    [unspaced, "这个很重要issue", "这个很重要Issue"],
    [unspaced, "issue_id", "issue_id"],
    [unspaced, "issue2", "issue2"],
    [unspaced, "reissues", "reissues"],
    [longest, "open code then open", "closed combined"],
    [noRecursion, "OPEN CODE alpha", "OpenCode beta release"],
    [noRecursion, "beta release", "gamma release"],
    [overlapping, "Hi I I think so.", "Hi I think so."],
    [overlapping, "Breathe the the air.", "Breathe the air."],
    [duplicates, "hex", "first"],
    [deletions, "I um think so.", "I think so."],
    [deletions, "I, um, think so.", "I, think so."],
    [deletions, "I, um, uh, think so.", "I, think so."],
    [deletions, "Um, the build passed.", "The build passed."],
    [deletions, "Um, uh, the build passed.", "The build passed."],
    [deletions, "um, the build passed.", "the build passed."],
    [deletions, "I think so um.", "I think so."],
    [deletions, "I think so, um.", "I think so."],
    [deletions, "I think so, um", "I think so"],
    [deletions, "Thank you.", ""],
    [deletions, "Hello. Thank you.", "Hello."],
    [deletions, "Hello. Thank you. The build passed.", "Hello. The build passed."],
  ])("%#: %j -> %j", (replacements, input, expected) => {
    expect(applyReplacements(input, replacements)).toBe(expected);
  });
});

describe("isNumbersOnly", () => {
  it.each([
    ["One, two, three, four, five, six, seven, eight, nine, ten.", true],
    ["1355", true],
    ["Twenty-one point five.", true],
    ["one hundred and forty two", true],
    ["", false],
    ["And.", false],
    ["Point one, the dataset has 1355 evaluation windows.", false],
    ["Call me at five.", false],
  ])("%j -> %s", (input, expected) => {
    expect(isNumbersOnly(input)).toBe(expected);
  });
});

describe("cleanTranscript", () => {
  it("applies formatting, symbols, fillers, then replacements", () => {
    expect(
      cleanTranscript("Um, open quote my underscore var close quote. New line. open code", {
        spokenFormatting: true,
        spokenSymbols: true,
        fillerWords: true,
        replacements: [rule("open code", "OpenCode")],
      }),
    ).toBe('"my_var".\nOpenCode');
  });
});
