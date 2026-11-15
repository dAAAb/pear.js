// The vector and matrix arithmetic of the kinematics: three-vectors, 3x3 rotations and the small dense systems of
// a solver step. A rotation is nine numbers in row-major order.

export type Vector3 = [number, number, number];
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

export function add(first: Readonly<Vector3>, second: Readonly<Vector3>): Vector3 {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

export function subtract(first: Readonly<Vector3>, second: Readonly<Vector3>): Vector3 {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

export function scale(vector: Readonly<Vector3>, factor: number): Vector3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

export function dot(first: Readonly<Vector3>, second: Readonly<Vector3>): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

export function cross(first: Readonly<Vector3>, second: Readonly<Vector3>): Vector3 {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

export function norm(vector: Readonly<Vector3>): number {
  return Math.sqrt(dot(vector, vector));
}

/** Returns the product of two rotations. */
export function multiply(first: Readonly<Matrix3>, second: Readonly<Matrix3>): Matrix3 {
  const product = new Array<number>(9) as Matrix3;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      product[3 * row + column] =
        first[3 * row]! * second[column]! +
        first[3 * row + 1]! * second[3 + column]! +
        first[3 * row + 2]! * second[6 + column]!;
    }
  }
  return product;
}

export function transpose(matrix: Readonly<Matrix3>): Matrix3 {
  return [matrix[0], matrix[3], matrix[6], matrix[1], matrix[4], matrix[7], matrix[2], matrix[5], matrix[8]];
}

/** Returns the matrix applied to the vector. */
export function apply(matrix: Readonly<Matrix3>, vector: Readonly<Vector3>): Vector3 {
  return [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
    matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
    matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
  ];
}

export function column(matrix: Readonly<Matrix3>, index: 0 | 1 | 2): Vector3 {
  return [matrix[index], matrix[3 + index]!, matrix[6 + index]!];
}

export function row(matrix: Readonly<Matrix3>, index: 0 | 1 | 2): Vector3 {
  return [matrix[3 * index]!, matrix[3 * index + 1]!, matrix[3 * index + 2]!];
}

/** Returns the rotation whose columns are the three vectors. */
export function fromColumns(first: Readonly<Vector3>, second: Readonly<Vector3>, third: Readonly<Vector3>): Matrix3 {
  return [first[0], second[0], third[0], first[1], second[1], third[1], first[2], second[2], third[2]];
}

export function trace(matrix: Readonly<Matrix3>): number {
  return matrix[0] + matrix[4] + matrix[8];
}

/** Returns the rotation of a URDF origin's `rpy`: roll about x, then pitch about y, then yaw about z, fixed axes. */
export function rotationFromRpy(rpy: Readonly<Vector3>): Matrix3 {
  const [roll, pitch, yaw] = rpy;
  const [cr, sr] = [Math.cos(roll), Math.sin(roll)];
  const [cp, sp] = [Math.cos(pitch), Math.sin(pitch)];
  const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];

  return [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    -sp,
    cp * sr,
    cp * cr,
  ];
}

/** Returns the rotation by `angle` about z. */
export function rotationAboutZ(angle: number): Matrix3 {
  const [cosine, sine] = [Math.cos(angle), Math.sin(angle)];
  return [cosine, -sine, 0, sine, cosine, 0, 0, 0, 1];
}

const SMALL_ANGLE = Math.pow(Number.EPSILON, 0.25); // below it, angle / sin(angle) is taken as 1
const NEAR_PI = Math.PI - 1e-2; // from it on, the axis is read from the rotation's diagonal

/**
 * Returns the rotation vector of `rotation` (its axis times its angle), computed the way pinocchio's `log3`
 * computes it, which placo's orientation task calls: the solver's steps follow it to the last digits.
 */
export function rotationVector(rotation: Readonly<Matrix3>): Vector3 {
  const rotationTrace = trace(rotation);
  const angle = rotationTrace >= 3 ? 0 : rotationTrace <= -1 ? Math.PI : Math.acos((rotationTrace - 1) / 2);

  if (angle >= NEAR_PI) {
    // sin(angle) vanishes near pi: each component's size comes from the diagonal, its sign from the skew part
    const cosine = -(rotationTrace - 1) / 2;
    const factor = (angle * angle) / (1 + cosine);
    const component = (diagonal: number, upper: number, lower: number): number => {
      const squared = (diagonal + cosine) * factor;
      return (upper > lower ? 1 : -1) * (squared > 0 ? Math.sqrt(squared) : 0);
    };
    return [
      component(rotation[0], rotation[7], rotation[5]),
      component(rotation[4], rotation[2], rotation[6]),
      component(rotation[8], rotation[3], rotation[1]),
    ];
  }

  const factor = (angle > SMALL_ANGLE ? angle / Math.sin(angle) : 1) / 2;
  return [
    factor * (rotation[7] - rotation[5]),
    factor * (rotation[2] - rotation[6]),
    factor * (rotation[3] - rotation[1]),
  ];
}

/**
 * Solves `matrix * x = vector` for a small dense system by Gaussian elimination with partial pivoting; `matrix` is
 * an array of rows. Both arguments are left as they are.
 */
export function solveLinear(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] {
  const size = vector.length;
  const rows = matrix.map((matrixRow, index) => [...matrixRow, vector[index]!]);

  for (let pivot = 0; pivot < size; pivot++) {
    let best = pivot;
    for (let candidate = pivot + 1; candidate < size; candidate++) {
      if (Math.abs(rows[candidate]![pivot]!) > Math.abs(rows[best]![pivot]!)) {
        best = candidate;
      }
    }
    [rows[pivot], rows[best]] = [rows[best]!, rows[pivot]!];
    const pivotRow = rows[pivot]!;
    for (let lower = pivot + 1; lower < size; lower++) {
      const lowerRow = rows[lower]!;
      const factor = lowerRow[pivot]! / pivotRow[pivot]!;
      for (let index = pivot; index <= size; index++) {
        lowerRow[index]! -= factor * pivotRow[index]!;
      }
    }
  }

  const solution = new Array<number>(size).fill(0);
  for (let index = size - 1; index >= 0; index--) {
    const current = rows[index]!;
    let sum = current[size]!;
    for (let other = index + 1; other < size; other++) {
      sum -= current[other]! * solution[other]!;
    }
    solution[index] = sum / current[index]!;
  }
  return solution;
}
