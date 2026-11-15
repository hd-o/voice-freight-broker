export function normalizeSpeech(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const unitWords = [
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
];

export const tensWords = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export function parseSpokenNumber(text: string): number | null {
  let total = 0;
  let group = 0;

  for (const word of text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "and")) {
    const unit = unitWords.indexOf(word);
    const tens = tensWords.indexOf(word);

    if (unit >= 0) {
      group += unit;
    } else if (tens >= 0) {
      group += (tens + 2) * 10;
    } else if (word === "hundred" && group > 0 && group < 100) {
      group *= 100;
    } else if (word === "thousand" && group > 0 && group < 1000) {
      total += group * 1000;
      group = 0;
    } else {
      return null;
    }
  }

  return total + group;
}

export function normalizeReadback(text: string) {
  const ordinals = [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
    "eleventh",
    "twelfth",
    "thirteenth",
    "fourteenth",
    "fifteenth",
    "sixteenth",
    "seventeenth",
    "eighteenth",
    "nineteenth",
  ];
  const numbers = [...unitWords, ...tensWords, "hundred", "thousand", "and"].join("|");
  const speech = normalizeSpeech(text.replace(/(?<=\d),(?=\d)/g, ""))
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(
      /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth)\b/g,
      (word) => String(ordinals.indexOf(word) + 1),
    )
    .replace(/\bthirtieth\b/g, "30")
    .replace(/\btwentieth\b/g, "20")
    .replace(/\bthirty 1\b/g, "31")
    .replace(/\btwenty (\d)\b/g, (_, digit: string) => String(20 + Number(digit)))
    .replace(
      new RegExp(
        `\\b(january|february|march|april|may|june|july|august|september|october|november|december) ((?:(?:${numbers})\\s+)+?)(?=(?:two thousand|twenty twenty|\\d{4})\\b)`,
        "g",
      ),
      (_, month: string, day: string) => `${month} ${parseSpokenNumber(day)} `,
    )
    .replace(/\bpicking up\b/g, "pickup")
    .replace(/\bpickup on\b/g, "pickup")
    .replace(/\btwenty twenty (\w+)\b/g, (_, word: string) => {
      const year = parseSpokenNumber(word);
      return year !== null && year < 10 ? String(2020 + year) : `twenty twenty ${word}`;
    });
  return speech.replace(new RegExp(`\\b(?:${numbers})(?:\\s+(?:${numbers}))*\\b`, "g"), (words) =>
    String(parseSpokenNumber(words) ?? words),
  );
}
