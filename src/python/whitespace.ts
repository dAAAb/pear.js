// Python's notion of whitespace, which PEAR's texts depend on in three places: str.strip() of the environment prompt
// (pear/deploy/station/control/robots/so101/formats.py), str.strip() of what follows an answer's json block
// (pear/deploy/station/agent_loop/action_parser.py) and \s of JSON_BLOCK_PATTERN (pear/agent_loop/protocol.py).
// JavaScript's trim() and \s differ: they take U+FEFF and leave out U+001C to U+001F and U+0085.

/** The characters of Python's str.isspace() and of \s in a str pattern, as the inside of a character class. */
export const PYTHON_WHITESPACE_CLASS =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const EDGE_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE_CLASS}]+|[${PYTHON_WHITESPACE_CLASS}]+$`, "g");
const ONLY_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE_CLASS}]*$`);

/** Python's str.strip(). */
export function pythonStrip(text: string): string {
  return text.replace(EDGE_WHITESPACE, "");
}

/** Whether Python's str.strip() leaves nothing of ``text``. */
export function isPythonBlank(text: string): boolean {
  return ONLY_WHITESPACE.test(text);
}
