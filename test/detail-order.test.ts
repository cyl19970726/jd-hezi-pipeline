import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { setDetailOrder } from "../src/browser/detail-order.js";
test("prepending editor is normalized to source order without uploading again", () => {
  const { document } = parseHTML(
    '<div id="editor"><img src="https://x/3"><img src="https://x/2"><img src="https://x/1"></div>',
  );
  const body = document.querySelector("#editor")!;
  let saves = 0;
  Object.assign(globalThis, {
    document,
    window: {
      tinymce: {
        activeEditor: {
          getBody: () => body,
          setContent: (html: string) => (body.innerHTML = html),
          fire: () => {},
          save: () => saves++,
        },
      },
    },
  });
  setDetailOrder({ urls: ["https://x/1", "https://x/2", "https://x/3"] });
  assert.deepEqual(
    [...body.querySelectorAll("img")].map((x) => x.src),
    ["https://x/1", "https://x/2", "https://x/3"],
  );
  assert.equal(saves, 1);
  assert.throws(() => setDetailOrder({ urls: ["https://x/other"] }));
  assert.equal(saves, 1);

  body.innerHTML =
    '<img src="https://x/2"><img src="https://x/1"><img src="https://x/1">';
  setDetailOrder({ urls: ["https://x/1", "https://x/1", "https://x/2"] });
  assert.deepEqual(
    [...body.querySelectorAll("img")].map((x) => x.src),
    ["https://x/1", "https://x/1", "https://x/2"],
  );
  assert.equal(saves, 2);
});
