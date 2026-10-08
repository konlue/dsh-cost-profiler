/**
 * Coverage for the hand-written client half (lib/client.js).
 *
 * The client module is a classic script that registers itself on
 * `window.__ModuleLoader__`, and its platform modules (react,
 * @deepseek-ai/dsh-client-ui-primitives) only exist inside the desktop shell.
 * This harness supplies minimal stand-ins and evaluates the returned element
 * tree by hand, so slot keys, the Markdown/JSON/error dispatch and the crash
 * containment are all covered by plain `node --test`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const body = (...lines) => lines.join("\n");

/** Short enough for the card to open itself. */
const SHORT_REPORT = "Session cost $0.0011 (est) · 1 turn · 800 in · 200 out · 0% cache hit · 1.5s wall";

const REPORT = body(
  "Session cost $0.0047 (est) · 2 turns · 3k in · 800 out · 40% cache hit · 7.4s wall",
  "",
  "**Turns** 2 · **Messages** 2 · **Retries** 0",
  "",
  "| Model route | In (uncached) | Cache hit | Est. cost |",
  "| --- | ---: | ---: | ---: |",
  "| `deepseek/deepseek-flash` | 1k | 2k | $0.0009 |",
);

/** Past the open-by-default limit: `/cost full` on a long session. */
const LONG_REPORT = body(
  REPORT,
  "",
  "**Turns** (last 40 of 40 kept)",
  "",
  ...[...Array(40)].map((_, i) => `| ${i + 1} | 1.2s | 900ms | 300ms | 800 | 200 | 0 | $0.0002 |`),
);

const JSON_REPORT = body('{', '  "totals": {', '    "turns": 2', "  }", "}", "");

let caseSeq = 0;

/** Minimal React stand-in: exactly the API surface lib/client.js may use. */
function stubReact() {
  const Component = class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  };
  const createElement = (type, props, ...children) => {
    const flat = children.filter((child) => child !== null && child !== undefined && child !== false && child !== true);
    return { type, props: { ...(props ?? {}), children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat } };
  };
  return {
    createElement,
    // No-op setter: every assertion here reads the first render, and the
    // controlled-disclosure behaviour is the framework's, not ours.
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    memo: (component) => component,
    Component,
  };
}

/** Evaluate a stubbed element tree, honouring class components and boundaries. */
function renderTree(node, React) {
  if (Array.isArray(node)) return node.map((child) => renderTree(child, React));
  if (node === null || typeof node !== "object") return node;
  const { type, props } = node;
  if (typeof type === "string") return { type, props: { ...props, children: renderTree(props.children, React) } };
  if (typeof type !== "function") return node;
  if (type.prototype instanceof React.Component) {
    const instance = new type(props);
    try {
      return renderTree(instance.render(), React);
    } catch (error) {
      if (typeof type.getDerivedStateFromError !== "function") throw error;
      Object.assign(instance.state, type.getDerivedStateFromError(error));
      if (typeof instance.componentDidCatch === "function") instance.componentDidCatch(error);
      return renderTree(instance.render(), React);
    }
  }
  return renderTree(type(props), React);
}

function findOne(node, type) {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findOne(child, type);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (node.type === type) return node;
  return findOne(node.props.children, type);
}

/** Mirrors SlotCore: an occupied key at the same priority throws. */
function fakeCtx({ occupiedKeys = [] } = {}) {
  const ctx = { registered: [], injected: [], effects: [], live: 0 };
  ctx.slots = {
    inject(name, callback) {
      ctx.injected.push(name);
      ctx.effects.push(callback());
      return () => {};
    },
    register(options, component) {
      if (occupiedKeys.includes(options.key)) {
        throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}"`);
      }
      ctx.registered.push({ options, component });
      ctx.live += 1;
      return () => {
        ctx.live -= 1;
      };
    },
  };
  return ctx;
}

async function loadClient({ markdownThrows = false, withPrimitives = true, occupiedKeys = [] } = {}) {
  const React = stubReact();
  const icon = (props) => React.createElement("icon", props);
  const MarkdownText = (props) => {
    if (markdownThrows) throw new Error("markdown renderer exploded");
    return React.createElement("markdown", { text: props.text, labels: props.labels, streaming: props.streaming });
  };
  // The real one is controlled and renders children only while open.
  const DisclosureRow = (props) =>
    React.createElement(
      "disclosure",
      { title: props.title, open: props.open, running: props.running, expandable: props.expandable, label: props.collapsedContent, icon: props.icon },
      props.open ? props.children : null,
    );

  const require = (specifier) => {
    if (specifier === "react") return React;
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
      if (!withPrimitives) throw new Error(`client-modules: require("${specifier}") missed the module table`);
      return { MarkdownText, DisclosureRow, IconGaugeOutlineRegular: icon, IconApiOutlineRegular: icon };
    }
    throw new Error(`client-modules: require("${specifier}") missed the module table`);
  };

  const registration = {};
  globalThis.window = { __ModuleLoader__: { load: (value) => Object.assign(registration, value) } };
  await import(`../lib/client.js?case=${++caseSeq}`);
  const plugin = registration.factory(require);
  const ctx = fakeCtx({ occupiedKeys });
  plugin.apply(ctx);
  const componentFor = (key) => {
    const entry = ctx.registered.find((registered) => registered.options.key === key);
    if (entry === undefined) throw new Error(`no slot entry registered for "${key}"`);
    return entry.component;
  };
  return {
    id: registration.id,
    plugin,
    ctx,
    componentFor,
    render: (element) => renderTree(element, React),
  };
}

test("registers the report card on both slots under the names the host dispatches", async () => {
  const { plugin, ctx, id } = await loadClient();
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual(plugin.inject, ["slots"]);
  assert.equal(id, "dsh-cost-profiler");

  assert.deepEqual(
    ctx.registered.map((entry) => [entry.options.name, entry.options.key]),
    [
      ["conversation.chat.commandview", "cost"],
      ["conversation.chat.commandview", "cost-report"],
      ["tool.call.toolview", "cost_report"],
    ],
  );
  assert.deepEqual(ctx.injected, ["conversation.chat.commandview", "tool.call.toolview"]);
  // The framework calls every returned effect as a disposer, so a skipped
  // registration must not leave a null behind in the array.
  for (const effect of ctx.effects) {
    for (const dispose of effect) assert.equal(typeof dispose, "function");
  }
});

test("client slot keys stay in sync with the host command and tool names", async () => {
  const host = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  // The client half is a classic script and cannot import these, so string
  // literals on both sides are the contract — this is the only guard against a
  // rename on one side silently downgrading the UI to the generic card.
  assert.ok(host.includes('definition("cost")'));
  assert.ok(host.includes('definition("cost-report")'));
  assert.ok(host.includes('name: "cost_report"'));
});

test("an occupied slot key is skipped instead of taking the whole entry down", async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args[0]);
  try {
    const { ctx } = await loadClient({ occupiedKeys: ["cost"] });
    assert.deepEqual(ctx.registered.map((entry) => entry.options.key), ["cost-report", "cost_report"]);
    for (const effect of ctx.effects) {
      for (const dispose of effect) assert.equal(typeof dispose, "function");
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /slot entry "cost" was not registered/);
});

test("manifest declares the client half the module loader looks for", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const { id } = await loadClient();
  assert.equal(pkg.dsh.client.platform, "web");
  assert.equal(pkg.exports["./client"], "./lib/client.js");
  assert.equal(id, pkg.name);
});

test("a short /cost report opens itself and renders as Markdown", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("cost");
  const tree = render(card({ node: { kind: "command", name: "cost", args: null, outcome: { kind: "success", text: SHORT_REPORT } } }));

  const row = findOne(tree, "disclosure");
  assert.equal(row.props.title, "cost");
  assert.equal(row.props.expandable, true);
  assert.equal(row.props.open, true);
  assert.equal(row.props.label.props.children, SHORT_REPORT);

  const markdown = findOne(tree, "markdown");
  assert.equal(markdown.props.text, SHORT_REPORT);
  assert.equal(markdown.props.streaming, false);
});

test("a long /cost full report starts collapsed behind its headline", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("cost");
  const tree = render(card({ node: { kind: "command", name: "cost", args: "full", outcome: { kind: "success", text: LONG_REPORT } } }));

  const row = findOne(tree, "disclosure");
  assert.equal(row.props.open, false);
  assert.equal(row.props.label.props.children, REPORT.split("\n")[0]);
  assert.equal(findOne(tree, "markdown"), null);
});

test("/cost json renders as a JSON code block rather than collapsed prose", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("cost");
  const tree = render(card({ node: { kind: "command", name: "cost", args: " json ", outcome: { kind: "success", text: JSON_REPORT } } }));

  const row = findOne(tree, "disclosure");
  assert.equal(row.props.open, true);
  assert.match(row.props.label.props.children, /^JSON report · \d+ lines$/);
  assert.match(findOne(tree, "markdown").props.text, /^```json\n\{[\s\S]*\}\n```$/);
});

test("running and failed /cost render without a body", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("cost");

  const running = findOne(render(card({ node: { kind: "command", name: "cost", args: null, outcome: null } })), "disclosure");
  assert.equal(running.props.running, true);
  assert.equal(running.props.expandable, false);
  assert.equal(running.props.label.props.children, "Running…");

  const failed = findOne(
    render(card({ node: { kind: "command", name: "cost", args: "verbose", outcome: { kind: "error", text: "Unknown argument. Usage: /cost [summary|full|json]" } } })),
    "disclosure",
  );
  // Short failures read straight off the row; long ones stay expandable.
  assert.equal(failed.props.expandable, true);
  assert.match(failed.props.label.props.children, /Unknown argument/);
  assert.equal(failed.props.label.props.style.color, "#d64545");
});

test("markdown labels are complete and reference-stable", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("cost");
  const node = { kind: "command", name: "cost", args: null, outcome: { kind: "success", text: SHORT_REPORT } };
  const first = findOne(render(card({ node })), "markdown").props.labels;
  const second = findOne(render(card({ node })), "markdown").props.labels;

  assert.equal(first, second);
  assert.deepEqual(Object.keys(first).sort(), ["code", "footnotes"]);
  assert.deepEqual(Object.keys(first.code).sort(), ["copiedLabel", "copyLabel", "toolbarLabels"]);
  assert.deepEqual(Object.keys(first.code.toolbarLabels).sort(), ["codeLabel", "unwrapLabel", "wrapLabel"]);
  assert.equal(typeof first.footnotes, "string");
});

test("a settled cost_report tool call renders its content as Markdown", async () => {
  const { componentFor, render } = await loadClient();
  const row = componentFor("cost_report");

  const preparing = findOne(
    render(row({ phase: "preparing", toolName: "cost_report", block: { phase: "preparing", callId: "c1" } })),
    "disclosure",
  );
  assert.equal(preparing.props.running, true);
  assert.equal(preparing.props.title, "cost_report");

  const settled = render(
    row({
      phase: "result",
      toolName: "cost_report",
      block: { kind: "tool-result", content: [{ type: "text", text: REPORT }], isError: false, call: { name: "cost_report", argsRaw: '{"detail":"summary"}' } },
    }),
  );
  assert.equal(findOne(settled, "disclosure").props.title, "cost_report");
  assert.equal(findOne(settled, "markdown").props.text, REPORT);

  const json = render(
    row({
      phase: "result",
      toolName: "cost_report",
      block: { kind: "tool-result", content: [{ type: "text", text: JSON_REPORT }], isError: false, call: { name: "cost_report", argsRaw: '{"detail":"json"}' } },
    }),
  );
  assert.match(findOne(json, "markdown").props.text, /^```json\n/);

  // A result that never saw its tool/call event has no arguments to read.
  const orphan = render(
    row({ phase: "result", toolName: "cost_report", block: { kind: "tool-result", content: [{ type: "text", text: REPORT }], isError: false, call: null } }),
  );
  assert.equal(findOne(orphan, "markdown").props.text, REPORT);
});

test("a failed cost_report falls back to its error text", async () => {
  const { componentFor, render } = await loadClient();
  const row = componentFor("cost_report");
  const tree = render(
    row({
      phase: "result",
      toolName: "cost_report",
      block: { kind: "tool-result", content: [], isError: true, error: { name: "CostReportError", message: "boom" }, call: null },
    }),
  );
  assert.match(findOne(tree, "disclosure").props.label.props.children, /CostReportError: boom/);
});

test("a markdown failure degrades to the raw report instead of abdicating the entry", async () => {
  const { componentFor, render } = await loadClient({ markdownThrows: true });
  const card = componentFor("cost");
  // This must not throw: a throwing slot entry is retired and replaced by a
  // bare error cell, which would hide the report entirely.
  const tree = render(card({ node: { kind: "command", name: "cost", args: null, outcome: { kind: "success", text: REPORT } } }));
  const pre = findOne(tree, "pre");
  assert.equal(pre.props.children, REPORT);
  assert.equal(pre.props.style.whiteSpace, "pre-wrap");
});

test("missing ui primitives degrade to monospace text instead of an empty row", async () => {
  const { componentFor, render } = await loadClient({ withPrimitives: false });
  const card = componentFor("cost");
  const tree = render(card({ node: { kind: "command", name: "cost", args: null, outcome: { kind: "success", text: REPORT } } }));
  assert.equal(findOne(tree, "disclosure"), null);
  assert.equal(findOne(tree, "pre").props.children, REPORT);
});
