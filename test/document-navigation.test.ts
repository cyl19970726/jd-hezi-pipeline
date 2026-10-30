import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  didDocumentSurviveNavigation,
  markDocumentForNavigation,
} from "../src/browser/document-navigation.js";

function realm() {
  const { document } = parseHTML("<html><body></body></html>");
  const window = {};
  Object.assign(globalThis, { document, window });
  return { document, window };
}

test("detects same-document navigation even if the SPA replaces its root element", () => {
  const first = realm();
  markDocumentForNavigation("marker-1");
  assert.equal(
    first.document.documentElement.getAttribute("data-hezi-reload"),
    "marker-1",
  );

  const replacement = first.document.createElement("html");
  replacement.innerHTML = "<body>new SPA root</body>";
  first.document.replaceChild(replacement, first.document.documentElement);

  assert.equal(replacement.hasAttribute("data-hezi-reload"), false);
  assert.equal(didDocumentSurviveNavigation("marker-1"), true);
});

test("a new Window realm proves a full document navigation", () => {
  realm();
  markDocumentForNavigation("marker-2");
  realm();
  assert.equal(didDocumentSurviveNavigation("marker-2"), false);
});

test("does not accept a stale marker from another navigation", () => {
  realm();
  markDocumentForNavigation("old-marker");
  assert.equal(didDocumentSurviveNavigation("new-marker"), false);
});

test("marker helpers remain self-contained for page evaluation", () => {
  realm();
  const mark = new Function(
    "marker",
    `return (${markDocumentForNavigation.toString()})(marker)`,
  );
  const survived = new Function(
    "marker",
    `return (${didDocumentSurviveNavigation.toString()})(marker)`,
  );
  mark("serialized-marker");
  assert.equal(survived("serialized-marker"), true);
});
