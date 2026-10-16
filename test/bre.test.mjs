import assert from "node:assert/strict";
import { breToEre } from "../src/bre.ts";

const CONVERTED = [
  ["", ""],
  ["plain", "plain"],
  ["foo\\|bar", "foo|bar"],
  ["\\(a\\)\\{2\\}", "(a){2}"],
  ["\\(a\\|b\\)\\+", "(a|b)+"],
  ["a\\?b\\{1,\\}", "a?b{1,}"],
  ["\\<word\\>", "\\bword\\b"],
  ["s\\+\\>", "s+\\b"],
  ["\\<\\w\\+", "\\b\\w+"],
  ["f(x)", "f\\(x\\)"],
  ["a{2}", "a\\{2\\}"],
  ["a+b?c|d", "a\\+b\\?c\\|d"],
  ["*a", "\\*a"],
  ["^*a", "^\\*a"],
  ["\\(*a\\)", "(\\*a)"],
  ["x\\|*a", "x|\\*a"],
  ["a*", "a*"],
  ["a^b", "a\\^b"],
  ["a$b", "a\\$b"],
  ["^a$", "^a$"],
  ["\\(^a$\\)", "(^a$)"],
  ["\\.\\*\\[\\]\\\\", "\\.\\*\\[\\]\\\\"],
  ["[a|(]", "[a|(]"],
  ["[]x]", "[]x]"],
  ["[^]x]", "[^]x]"],
  ["[[:alpha:]]\\+", "[[:alpha:]]+"],
  ["\\w\\s\\bx\\B", "\\w\\s\\bx\\B"],
];

const UNCONVERTIBLE = [
  "\\(a\\)\\1",
  "a\\{,2\\}",
  "a\\{2",
  "a\\{3,1\\}",
  "\\{1\\}",
  "\\+a",
  "^\\?",
  "a**",
  "a\\{2\\}\\+",
  "a*\\?",
  "\\<(",
  "\\<a*",
  "\\<a\\?",
  "a?\\>",
  "\\>a",
  "a\\(b",
  "a\\)b",
  "\\(\\)",
  "a\\|",
  "\\|a",
  "foo$\\|bar",
  "[\\w.]",
  "[a&&b]",
  "[[.a.]]",
  "[a",
  "\\d",
  "\\t",
  "\\'",
  "a\\",
  "a\nb",
  "\\<\\<a",
  "\\b*",
];

for (const [input, expected] of CONVERTED) {
  assert.equal(breToEre(input), expected, `breToEre(${JSON.stringify(input)})`);
}
for (const input of UNCONVERTIBLE) {
  assert.equal(breToEre(input), null, `breToEre(${JSON.stringify(input)}) must stay verbatim`);
}
console.log("ALL BRE CONVERSION TESTS PASSED");
