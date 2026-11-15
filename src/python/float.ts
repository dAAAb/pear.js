// Python's printing of a float (CPython 3.12, Objects/floatobject.c: float.__repr__), which with Python's rounding
// decides every number the model is shown: pear/deploy/station/agent_loop/messages.py rounds each quantity with
// round(value, decimals) + 0.0 and pear/agent_loop/protocol.py prints the state with json.dumps.
//
// The rounding (float.__round__) is pythonRound of ./format.ts, the library's one. This file had a second, made of
// the engine's toFixed with the tie put right; the two gave the same float for every value compared
// (docs/progress/common.md), and the one that is Python's own method was kept.

/**
 * Python's repr() of a float: the shortest digits that read back as the same float, with a decimal point always,
 * and an exponent of at least two digits below 1e-4 and from 1e16 on (JavaScript switches at 1e-6 and 1e21).
 */
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "inf" : "-inf";
  }
  if (value === 0) {
    return Object.is(value, -0) ? "-0.0" : "0.0";
  }

  // Number's own text holds the same shortest digits: "123.45", "0.000012", "1.2e+21", "1e-7"
  const [positional, exponentText] = String(Math.abs(value)).split("e") as [string, string | undefined];
  const [integerPart, fractionPart = ""] = positional.split(".") as [string, string | undefined];
  const allDigits = integerPart + fractionPart;
  const leadingZeros = allDigits.length - allDigits.replace(/^0+/, "").length;
  const digits = allDigits.slice(leadingZeros).replace(/0+$/, "");
  // the value is 0.digits * 10**pointPosition
  const pointPosition = integerPart.length - leadingZeros + (exponentText === undefined ? 0 : Number(exponentText));

  let text: string;
  if (pointPosition <= -4 || pointPosition > 16) {
    const exponent = pointPosition - 1;
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    text = `${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  } else if (pointPosition <= 0) {
    text = `0.${"0".repeat(-pointPosition)}${digits}`;
  } else if (pointPosition >= digits.length) {
    text = `${digits}${"0".repeat(pointPosition - digits.length)}.0`;
  } else {
    text = `${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`;
  }

  return value < 0 ? `-${text}` : text;
}
