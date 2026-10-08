/**
 * Client half of dsh-cost-profiler: renders the /cost report as Markdown.
 *
 * The host half delivers the report as plain text (see ./report.js) and the
 * chat UI would otherwise show it in the generic command/tool card, which is a
 * monospace <pre>. This module claims both render slots for the cost report and
 * renders the same text through the chat Markdown renderer instead.
 *
 * Hand-written classic script: no imports, no exports, no JSX, no build step.
 * `id` must equal the package name — the client module loader keys the factory
 * by it and rejects a bundle that registers under a different id.
 */
window.__ModuleLoader__.load({
  id: "dsh-cost-profiler",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    // Platform seed modules. Missing primitives degrade this card to monospace
    // text; a throwing require() would fail the whole client entry instead.
    let primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      primitives = null;
    }
    // Accepts exotic component types: both primitives used here are memo()
    // wrapped, and memo() returns an object rather than a function.
    const pick = (name) => {
      const value = primitives === null ? null : primitives[name];
      return value === undefined || value === null ? null : value;
    };
    const MarkdownText = pick("MarkdownText");
    const DisclosureRow = pick("DisclosureRow");
    const RowIcon = pick("IconGaugeOutlineRegular") ?? pick("IconApiOutlineRegular");

    const COMMAND_SLOT = "conversation.chat.commandview";
    const TOOL_SLOT = "tool.call.toolview";
    // Slot keys are dispatched verbatim from the command/tool name — no
    // normalization on either side, so these strings must match lib/index.js.
    const COMMAND_KEYS = ["cost", "cost-report"];
    const TOOL_KEY = "cost_report";

    // Reports longer than this start collapsed, so `/cost full` does not push
    // the conversation away while `/cost` stays readable at a glance.
    const OPEN_LINE_LIMIT = 30;

    // MarkdownText has no default labels and dereferences these while rendering
    // a code fence or footnotes. Kept module-level so the identity is stable
    // across renders, and English because this module has no locale seat.
    const LABELS = Object.freeze({
      code: Object.freeze({
        copyLabel: "Copy",
        copiedLabel: "Copied",
        toolbarLabels: Object.freeze({ codeLabel: "Code", wrapLabel: "Wrap", unwrapLabel: "Unwrap" }),
      }),
      footnotes: "Footnotes",
    });

    const PLAIN_STYLE = {
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "monospace",
      fontSize: 12,
      margin: 0,
      maxHeight: 320,
      overflow: "auto",
    };
    const ERROR_STYLE = { ...PLAIN_STYLE, color: "#d64545" };
    const BODY_STYLE = { padding: "2px 0 4px 20px" };
    const LABEL_STYLE = { marginLeft: 6, opacity: 0.75, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
    const ERROR_LABEL_STYLE = { ...LABEL_STYLE, color: "#d64545" };

    /**
     * Inner boundary for the Markdown subtree. A slot entry that throws during
     * render is abdicated and then leaves a bare error cell in its place — the
     * framework does not fall back to the generic card — so Markdown failures
     * must degrade to the raw report here instead of escaping.
     */
    class SafeMarkdown extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error) {
        console.error("dsh-cost-profiler: markdown render failed, showing raw report", error);
      }
      render() {
        if (this.state.failed) return h("pre", { style: PLAIN_STYLE }, this.props.text);
        return h(MarkdownText, { text: this.props.text, streaming: false, labels: LABELS });
      }
    }

    function lineCount(text) {
      return text === "" ? 0 : text.split("\n").length;
    }

    function firstLine(text) {
      const end = text.indexOf("\n");
      return end === -1 ? text : text.slice(0, end);
    }

    function fenced(text, lang) {
      return "```" + lang + "\n" + text.replace(/\s+$/, "") + "\n```";
    }

    /** `/cost json` and `cost_report {detail:"json"}` both end at the same body. */
    function isJsonText(text) {
      const trimmed = text.replace(/^\s+/, "");
      return trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[";
    }

    function isJsonArg(value) {
      return typeof value === "string" && value.trim().toLowerCase() === "json";
    }

    function jsonArgMode(argsRaw) {
      if (typeof argsRaw !== "string" || argsRaw === "") return false;
      try {
        const parsed = JSON.parse(argsRaw);
        return parsed !== null && typeof parsed === "object" && parsed.detail === "json";
      } catch (error) {
        return false;
      }
    }

    /** Flatten a tool result's content parts the way the built-in rows do. */
    function contentText(content) {
      if (!Array.isArray(content)) return "";
      const parts = [];
      for (const part of content) {
        if (part === null || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
        else {
          try {
            parts.push(JSON.stringify(part, null, 2));
          } catch (error) {
            // Skip parts that cannot be serialized rather than losing the report.
          }
        }
      }
      return parts.join("\n");
    }

    function errorText(block) {
      const error = block.error;
      if (error !== null && typeof error === "object") {
        const name = typeof error.name === "string" ? error.name : "";
        const message = typeof error.message === "string" ? error.message : "";
        const code = typeof error.code === "string" ? error.code : "";
        const text = [name, message].filter(Boolean).join(": ") || code;
        if (text !== "") return text;
      }
      return "The cost report failed.";
    }

    function bodyNode(text, json, error) {
      if (!MarkdownText) return h("pre", { style: error ? ERROR_STYLE : PLAIN_STYLE }, text);
      return h(SafeMarkdown, { text: json ? fenced(text, "json") : text });
    }

    function plainCard(title, text, error) {
      return h(
        "div",
        { style: { fontSize: 12 } },
        h("div", { style: { opacity: 0.7 } }, title),
        h("pre", { style: error ? ERROR_STYLE : PLAIN_STYLE }, text),
      );
    }

    /**
     * One report card: a disclosure row whose label is the report's own first
     * line and whose body is the report as Markdown.
     *
     * `open` is derived rather than stored, so a row that starts as "running"
     * and settles into a short report still opens by default; the first click
     * takes over from the derivation.
     */
    function ReportView(props) {
      const title = props.title;
      const text = typeof props.text === "string" ? props.text : "";
      const running = props.running === true;
      const error = props.error === true;
      const json = props.json === true;
      const lines = lineCount(text);
      const expandable = !running && text !== "";
      const defaultOpen = json || lines <= OPEN_LINE_LIMIT;
      const [userOpen, setUserOpen] = React.useState(null);
      const open = expandable && (userOpen === null ? defaultOpen : userOpen);

      const label = running ? "Running…" : json ? `JSON report · ${lines} ${lines === 1 ? "line" : "lines"}` : firstLine(text);

      if (!DisclosureRow) return plainCard(title, running ? "" : text, error);

      return h(
        DisclosureRow,
        {
          icon: RowIcon ? h(RowIcon, { size: 14 }) : undefined,
          title,
          open,
          running,
          expandable,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: () => setUserOpen(!open),
          collapsedContent: label ? h("span", { style: error ? ERROR_LABEL_STYLE : LABEL_STYLE }, label) : undefined,
        },
        expandable ? h("div", { style: BODY_STYLE }, bodyNode(text, json, error)) : null,
      );
    }

    /** `/cost [summary|full|json]` command row. */
    function CostCommandCard({ node }) {
      if (node === null || typeof node !== "object") return null;
      const title = typeof node.name === "string" && node.name !== "" ? node.name : "cost";
      const outcome = node.outcome;
      if (outcome === null || outcome === undefined) return h(ReportView, { title, running: true });
      const text = typeof outcome.text === "string" ? outcome.text : "";
      if (outcome.kind === "error") return h(ReportView, { title, error: true, text: text || "The command failed." });
      return h(ReportView, { title, text, json: isJsonArg(node.args) || isJsonText(text) });
    }

    /** `cost_report` tool row. */
    function CostReportRow(props) {
      const title = typeof props.toolName === "string" && props.toolName !== "" ? props.toolName : "cost_report";
      const block = props.block;
      const settled = props.phase === "result" && block !== null && typeof block === "object" && block.kind === "tool-result";
      if (!settled) return h(ReportView, { title, running: true });
      const text = contentText(block.content);
      const error = block.isError === true;
      if (error && text === "") return h(ReportView, { title, error: true, text: errorText(block) });
      const argsRaw = block.call !== null && typeof block.call === "object" ? block.call.argsRaw : "";
      return h(ReportView, { title, text, error, json: jsonArgMode(argsRaw) || isJsonText(text) });
    }

    function registerEntry(ctx, slotName, key, component) {
      try {
        return ctx.slots.register({ name: slotName, key }, component);
      } catch (error) {
        // An occupied key means the built-in card keeps rendering this command
        // or tool; that is a working fallback, not a failure worth crashing on.
        console.warn(`dsh-cost-profiler: slot entry "${key}" was not registered in ${slotName}`, error);
        return null;
      }
    }

    function registerAll(ctx, slotName, entries) {
      const disposers = [];
      for (const [key, component] of entries) {
        const dispose = registerEntry(ctx, slotName, key, component);
        if (dispose) disposers.push(dispose);
      }
      return disposers;
    }

    function apply(ctx) {
      ctx.slots.inject(COMMAND_SLOT, () =>
        registerAll(ctx, COMMAND_SLOT, COMMAND_KEYS.map((key) => [key, CostCommandCard])),
      );
      ctx.slots.inject(TOOL_SLOT, () => registerAll(ctx, TOOL_SLOT, [[TOOL_KEY, CostReportRow]]));
    }

    return { inject: ["slots"], apply };
  },
});
