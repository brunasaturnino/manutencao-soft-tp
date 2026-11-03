export function priceA(items) {
  let total = 0;
  for (const item of items) {
    total += item.value * item.qty;
  }
  if (total < 0) {
    total = 0;
  }
  return total;
}

export function priceB(lines) {
  let sum = 0;
  for (const line of lines) {
    sum += line.value * line.qty;
  }
  if (sum < 0) {
    sum = 0;
  }
  return sum;
}

export function logA(user) {
  const channel = "mail";
  const body = "Olá " + user;
  const sent = channel + ":" + body;
  console.log(sent);
  return sent.length + 1;
}

export function logB(user) {
  const channel = "mail";
  const body = "Olá " + user;
  const sent = channel + ":" + body;
  console.log(sent);
  return sent.length + 2;
}

export function twinA(n) {
  const base = n * 2;
  const extra = base + 3;
  const total = extra + 1;
  return total;
}

export function twinB(n) {
  const base = n * 2;
  const extra = base + 3;
  const total = extra + 1;
  return total;
}
