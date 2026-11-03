export function used(x) {
  return x + 1;
  const hidden = 2;
  return hidden;
}

export function unusedExport(x) {
  return x + 2;
}

function orphan(x) {
  return x + 3;
}

const side = console.log("boot");

export function afterReturn(x) {
  return x;
  const dead = 4;
  return dead;
}
