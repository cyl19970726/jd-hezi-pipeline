/** Order by source-to-upload mapping, never by the editor's insertion cursor. */
export function setDetailOrder({
  urls,
  before,
}: {
  urls: string[];
  before?: string[];
}) {
  const editor = (window as any).tinymce?.activeEditor;
  if (!editor) throw Error("TinyMCE unavailable");
  const current = [...editor.getBody().querySelectorAll("img")].map(
    (e: any) => e.src,
  );
  if (before && JSON.stringify(current) !== JSON.stringify(before))
    throw Error("Editor changed since observation");
  if (
    urls.some((u) => !u.startsWith("https://")) ||
    JSON.stringify([...current].sort()) !== JSON.stringify([...urls].sort())
  )
    throw Error("Image set differs");
  const host = document.createElement("div");
  for (const url of urls) {
    const p = document.createElement("p"),
      img = document.createElement("img");
    img.src = url;
    img.style.maxWidth = "100%";
    img.style.height = "auto";
    p.append(img);
    host.append(p);
  }
  editor.setContent(host.innerHTML);
  editor.fire("change");
  editor.save();
  return { images: urls.length };
}
