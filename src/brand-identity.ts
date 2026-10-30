function normalizedBrand(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
}

function parsedBrand(value: string) {
  const raw = value.normalize("NFKC").trim();
  const match =
    raw.match(/^(.+?)\(([A-Za-z][A-Za-z .&'-]{0,40})\)$/u) ??
    raw.match(/^(\p{Script=Han}+)([A-Za-z][A-Za-z .&'-]{0,40})$/u);
  if (
    !match ||
    !/\p{Script=Han}/u.test(match[1]) ||
    /^(?:app|official)$/iu.test(match[2].trim())
  )
    return null;
  return {
    primary: normalizedBrand(match[1]),
    latin: normalizedBrand(match[2]),
  };
}

export function primaryBrand(value: string) {
  return parsedBrand(value)?.primary ?? normalizedBrand(value);
}

export function brandEquivalent(left: string, right: string) {
  if (normalizedBrand(left) === normalizedBrand(right)) return true;
  const leftParsed = parsedBrand(left);
  const rightParsed = parsedBrand(right);
  if (leftParsed && rightParsed)
    return (
      leftParsed.primary === rightParsed.primary &&
      leftParsed.latin === rightParsed.latin
    );
  if (leftParsed) return leftParsed.primary === normalizedBrand(right);
  if (rightParsed) return rightParsed.primary === normalizedBrand(left);
  return false;
}
