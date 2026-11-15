// The functions of the C mathematical library that Ruckig 0.15.3 calls and that no implementation rounds
// correctly: std::cbrt, std::sin, std::cos, std::atan and std::acos, all of them in include/ruckig/roots.hpp.
//
// Everything else the port computes (+, -, *, /, the square root, the remainder) is defined to the last bit by
// IEEE 754, so a JavaScript engine and the C++ give the same numbers. These five differ in their last digit between
// one library and another: between the C library the reference was linked with and a JavaScript engine, and between
// engines. The port reaches them only through this object, so that a test can put another implementation in their
// place and tell an error of the port from a difference of the last digit of a cube root.

export interface Libm {
  cbrt(x: number): number;
  sin(x: number): number;
  cos(x: number): number;
  atan(x: number): number;
  acos(x: number): number;
}

/** The engine's own functions. */
export const ENGINE_LIBM: Readonly<Libm> = Object.freeze({
  cbrt: Math.cbrt,
  sin: Math.sin,
  cos: Math.cos,
  atan: Math.atan,
  acos: Math.acos,
});

/** The functions in use: the engine's own unless a verification replaces them. */
export const libm: Libm = { ...ENGINE_LIBM };

/** Puts `functions` in the place of the engine's (for a verification), and returns a call that restores them. */
export function replaceLibm(functions: Partial<Libm>): () => void {
  const previous = { ...libm };
  Object.assign(libm, functions);

  return () => {
    Object.assign(libm, previous);
  };
}
