// The order in which the C++ standard library the reference was built with (libstdc++) leaves a sorted range.
//
// Ruckig sorts with std::sort in two places: the roots of a polynomial (include/ruckig/roots.hpp) and the candidate
// durations of a synchronization (include/ruckig/calculator_target.hpp). std::sort does not keep the order of equal
// elements, and equal candidate durations are common (coordinates that move alike, coordinates that do not move), so
// which coordinate ends up limiting follows from the algorithm itself. This file is that algorithm, written from its
// description: an introsort that partitions around the median of three while a range holds more than 16 elements,
// then one insertion sort over the whole range.

const THRESHOLD = 16;

function insertionSort<T>(values: T[], first: number, last: number, less: (a: T, b: T) => boolean): void {
  for (let index = first + 1; index < last; index++) {
    const value = values[index];
    if (less(value, values[first])) {
      // smaller than the first: the whole sorted part moves up by one
      for (let moved = index; moved > first; moved--) {
        values[moved] = values[moved - 1];
      }
      values[first] = value;
    } else {
      let hole = index;
      while (less(value, values[hole - 1])) {
        values[hole] = values[hole - 1];
        hole--;
      }
      values[hole] = value;
    }
  }
}

/** Inserts each of `values[first, last)` into the sorted elements before it, which begin at `begin`. */
function insertionSortBehind<T>(
  values: T[],
  begin: number,
  first: number,
  last: number,
  less: (a: T, b: T) => boolean,
): void {
  for (let index = first; index < last; index++) {
    const value = values[index];
    let hole = index;
    // the C++ does not check the lower end here: after the partitioning nothing below is larger than what follows
    while (hole > begin && less(value, values[hole - 1])) {
      values[hole] = values[hole - 1];
      hole--;
    }
    values[hole] = value;
  }
}

function swap<T>(values: T[], first: number, second: number): void {
  const value = values[first];
  values[first] = values[second];
  values[second] = value;
}

/** Splits `values[first, last)` around the median of its first, middle and last element, and returns the cut. */
function partitionPivot<T>(values: T[], first: number, last: number, less: (a: T, b: T) => boolean): number {
  const middle = first + Math.floor((last - first) / 2);
  const a = first + 1;
  const b = middle;
  const c = last - 1;
  // the median of a, b and c goes to the front
  if (less(values[a], values[b])) {
    if (less(values[b], values[c])) {
      swap(values, first, b);
    } else if (less(values[a], values[c])) {
      swap(values, first, c);
    } else {
      swap(values, first, a);
    }
  } else if (less(values[a], values[c])) {
    swap(values, first, a);
  } else if (less(values[b], values[c])) {
    swap(values, first, c);
  } else {
    swap(values, first, b);
  }

  const pivot = first;
  let low = first + 1;
  let high = last;
  for (;;) {
    while (less(values[low], values[pivot])) {
      low++;
    }
    high--;
    while (less(values[pivot], values[high])) {
      high--;
    }
    if (!(low < high)) {
      return low;
    }
    swap(values, low, high);
    low++;
  }
}

function introsortLoop<T>(
  values: T[],
  first: number,
  last: number,
  depthLimit: number,
  less: (a: T, b: T) => boolean,
): void {
  while (last - first > THRESHOLD) {
    if (depthLimit === 0) {
      // libstdc++ sorts such a range as a heap. No range Ruckig sorts gets here unless its elements are arranged
      // against the partitioning; this sorts it correctly, without claiming the heap's order of equal elements.
      const sorted = values.slice(first, last).sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
      for (let index = 0; index < sorted.length; index++) {
        values[first + index] = sorted[index];
      }
      return;
    }
    depthLimit--;
    const cut = partitionPivot(values, first, last, less);
    introsortLoop(values, cut, last, depthLimit, less);
    last = cut;
  }
}

/**
 * Sorts `values[first, last)` in place by `less` and leaves equal elements in the order libstdc++'s std::sort
 * leaves them in.
 */
export function stdSort<T>(
  values: T[],
  less: (a: T, b: T) => boolean,
  first: number = 0,
  last: number = values.length,
): void {
  if (first === last) {
    return;
  }

  // twice the whole part of the binary logarithm of the length
  introsortLoop(values, first, last, (31 - Math.clz32(last - first)) * 2, less);
  if (last - first > THRESHOLD) {
    insertionSort(values, first, first + THRESHOLD, less);
    insertionSortBehind(values, first, first + THRESHOLD, last, less);
  } else {
    insertionSort(values, first, last, less);
  }
}
