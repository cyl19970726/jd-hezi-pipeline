/** Runs in the page; mark only the exact existing specification cell. */
export function markRejectionSpec(expectedBefore: string) {
  const matches = [
    ...document.querySelectorAll(".ant-tabs-tabpane-active tr"),
  ].filter((row) => {
    const cells = row.querySelectorAll("td");
    return (
      cells.length > 1 &&
      (
        (cells[0].querySelector("input") as HTMLInputElement)?.value ||
        cells[0].textContent ||
        ""
      )
        .replace(/\*/g, "")
        .trim() === "规格"
    );
  });
  if (matches.length !== 1) throw Error("修订规格字段不唯一");
  const input = matches[0]
    .querySelectorAll("td")[1]
    .querySelector("input,textarea") as HTMLInputElement | null;
  if (
    !input ||
    input.closest(".ant-select") ||
    input.disabled ||
    input.value !== expectedBefore
  )
    throw Error("修订规格控件或原值已变化");
  document
    .querySelectorAll("[data-hezi-repair-spec]")
    .forEach((e) => e.removeAttribute("data-hezi-repair-spec"));
  input.setAttribute("data-hezi-repair-spec", "true");
  return '[data-hezi-repair-spec="true"]';
}

/** Observation timestamps are not persisted product content. */
export function rejectionContent(
  snapshot: import("../model.js").RemoteSnapshot,
) {
  return {
    fields: snapshot.fields,
    specs: snapshot.specs,
    mainImages: snapshot.mainImages,
    detailImages: snapshot.detailImages,
    logistics: snapshot.logistics
      ? { ...snapshot.logistics, checkedAt: undefined }
      : snapshot.logistics,
  };
}
